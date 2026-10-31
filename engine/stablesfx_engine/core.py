"""Engine state: config, library/history, presets, model manager, job queue, events."""

from __future__ import annotations

import asyncio
import collections
import json
import logging
import os
import queue
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

import numpy as np

from . import __version__, audio_io, dsp, generate, paths
from .config import ConfigStore
from .library import History, Library, resolve_source, safe_folder, safe_name, slugify
from .models import Cancelled, ModelManager
from .presets import PresetStore
from .schema import (
    EngineStatus, ExportRequest, ExportResult, JobInfo, JobRequest, ProcessRequest, SfxItem,
)

log = logging.getLogger("stablesfx")


class EventBus:
    """Fan-out of events from any thread to asyncio subscribers (WebSocket clients)."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.subscribers: set[asyncio.Queue] = set()
        self._lock = threading.Lock()

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        with self._lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        with self._lock:
            self.subscribers.discard(q)

    def emit(self, type_: str, data: dict[str, Any]) -> None:
        msg = json.dumps({"type": type_, "data": data}, default=str)
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            subs = list(self.subscribers)
        for q in subs:
            loop.call_soon_threadsafe(_put_nowait, q, msg)


def _put_nowait(q: asyncio.Queue, msg: str) -> None:
    try:
        q.put_nowait(msg)
    except asyncio.QueueFull:
        pass


class Engine:
    def __init__(self, fake: bool = False, src_hash: str = "") -> None:
        paths.ensure_dirs()
        self.fake = fake
        self.src_hash = src_hash
        self.started = time.time()
        self.bus = EventBus()
        self.config = ConfigStore()
        self.library = Library(self.config.library_path)
        self.library.ensure_layout()
        self.history = History(paths.history_dir())
        self.presets = PresetStore()
        self.models = ModelManager(fake, self.bus.emit, self.log)
        self.jobs: "collections.OrderedDict[str, JobInfo]" = collections.OrderedDict()
        self._cancel: dict[str, threading.Event] = {}
        self._queue: "queue.Queue[str]" = queue.Queue()
        self._busy = False
        self.last_activity = time.time()
        self.device_info: dict[str, Any] = {}
        self.ready = False
        self.init_error: str | None = None
        self.log_lines: collections.deque[str] = collections.deque(maxlen=500)
        threading.Thread(target=self._worker, name="job-worker", daemon=True).start()
        threading.Thread(target=self._init_runtime, name="init", daemon=True).start()

    # ------------------------------------------------------------------ misc
    def log(self, line: str) -> None:
        line = line.rstrip()
        if not line:
            return
        stamped = f"{time.strftime('%H:%M:%S')} {line}"
        self.log_lines.append(stamped)
        print(stamped, flush=True)
        self.bus.emit("log", {"line": stamped})

    def touch(self) -> None:
        self.last_activity = time.time()

    def _init_runtime(self) -> None:
        """Import torch off the request path so /status answers immediately on startup."""
        try:
            if self.fake:
                self.device_info = {"device": "cpu", "device_name": "Fake backend", "torch": None, "cuda": None}
            else:
                import torch

                info: dict[str, Any] = {"torch": torch.__version__, "cuda": torch.version.cuda}
                if torch.cuda.is_available():
                    props = torch.cuda.get_device_properties(0)
                    info.update(device="cuda", device_name=props.name, vram_total_gb=round(props.total_memory / 2**30, 1))
                else:
                    info.update(device="cpu", device_name="CPU")
                self.device_info = info
            self.ready = True
            self.log(f"engine ready ({self.device_info.get('device_name')})")
        except Exception as e:  # noqa: BLE001
            self.init_error = f"{type(e).__name__}: {e}"
            self.log("runtime init failed: " + self.init_error)
        self.bus.emit("status", self.status().model_dump())

    def status(self, clients: int = 0) -> EngineStatus:
        used = None
        if self.device_info.get("device") == "cuda":
            try:
                import torch

                free, total = torch.cuda.mem_get_info()
                used = round((total - free) / 2**30, 2)
            except Exception:
                pass
        from .models import flash_attn_available

        return EngineStatus(
            version=__version__, src_hash=self.src_hash, pid=os.getpid(), ready=self.ready,
            device=self.device_info.get("device"), device_name=self.device_info.get("device_name"),
            vram_total_gb=self.device_info.get("vram_total_gb"), vram_used_gb=used,
            torch=self.device_info.get("torch"), cuda=self.device_info.get("cuda"),
            flash_attn=(not self.fake) and flash_attn_available(), loaded_model=self.models.loaded,
            loaded_precision=self.models.backend.precision if self.models.backend else None,
            busy=self._busy or any(d.get("running") for d in self.models.downloads.values()),
            queue=self._queue.qsize(), clients=clients,
            library_path=str(self.library.root), history_path=str(self.history.root),
            fake=self.fake, error=self.init_error,
        )

    def set_library_path(self, path: str) -> None:
        self.config.update({"library_path": path})
        self.library = Library(Path(path))
        self.library.ensure_layout()
        self.bus.emit("library", {"change": "root", "path": path})

    # ------------------------------------------------------------------ items
    def store_for(self, item_id: str):
        return self.history if item_id.startswith("hist:") else self.library

    def get_item(self, item_id: str) -> SfxItem:
        return self.store_for(item_id).get(item_id)

    def load_source(self, ref: str, target_sr: int | None = None) -> generate.Source:
        path, sidecar, item = resolve_source(ref, self.library, self.history)
        audio, sr = audio_io.load(path)
        if target_sr:
            audio, sr = generate.prepare_source(audio, sr, target_sr)
        return generate.Source(audio=audio, sr=sr, sidecar=sidecar, uid=item.uid if item else sidecar.get("uid"), path=str(path))

    def _save_take(self, req: JobRequest, take: generate.Take, extra: dict[str, Any]) -> SfxItem:
        stem = req.name or slugify(take.meta.get("prompt") or "sfx")
        sidecar = {**take.meta, **extra, "tags": list(req.tags)}
        if req.target == "library":
            item = self.library.save_audio(take.audio, take.sr, safe_folder(req.folder or "Inbox"), stem, sidecar)
            self.bus.emit("library", {"change": "added", "ids": [item.id], "folder": item.folder})
        else:
            item = self.history.save_audio(take.audio, take.sr, self.history.day_folder(), stem, sidecar)
            self.bus.emit("history", {"change": "added", "ids": [item.id]})
        return item

    # ------------------------------------------------------------------ jobs
    def submit(self, req: JobRequest) -> JobInfo:
        self.touch()
        job = JobInfo(
            id=uuid.uuid4().hex[:12], mode=req.mode, state="queued", origin=req.origin,
            created=time.time(), variations=req.variations, request=req,
        )
        self.jobs[job.id] = job
        while len(self.jobs) > 200:
            self.jobs.popitem(last=False)
        self._cancel[job.id] = threading.Event()
        self._queue.put(job.id)
        self.bus.emit("job", job.model_dump(mode="json"))
        return job

    def cancel(self, job_id: str) -> JobInfo:
        job = self.jobs[job_id]
        if job.state in ("done", "error", "cancelled"):
            return job
        self._cancel[job_id].set()
        if job.state == "queued":
            job.state = "cancelled"
            job.finished = time.time()
            self.bus.emit("job", job.model_dump(mode="json"))
        return job

    def wait(self, job_id: str, timeout: float) -> JobInfo:
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.jobs[job_id]
            if job.state in ("done", "error", "cancelled"):
                return job
            time.sleep(0.1)
        return self.jobs[job_id]

    def _worker(self) -> None:
        while True:
            job_id = self._queue.get()
            job = self.jobs.get(job_id)
            if job is None or job.state == "cancelled":
                continue
            self._busy = True
            try:
                self._run_job(job)
            finally:
                self._busy = False
                self.touch()
                self._cancel.pop(job_id, None)

    def _run_job(self, job: JobInfo) -> None:
        req = job.request
        cancel = self._cancel[job.id]
        last_emit = [0.0]

        def emit(force: bool = False) -> None:
            now = time.time()
            if force or now - last_emit[0] > 0.1:
                last_emit[0] = now
                self.bus.emit("job", job.model_dump(mode="json"))

        def on_variation(i: int, steps: int) -> None:
            job.variation, job.step, job.steps = i, 0, steps
            job.state = "encoding"
            emit(True)

        def on_step(i: int) -> None:
            if cancel.is_set():
                raise Cancelled()
            job.state = "sampling" if i < job.steps - 1 else "decoding"
            job.step = i + 1
            job.progress = (job.variation + job.step / max(job.steps, 1)) / job.variations
            emit()

        job.started = time.time()
        try:
            job.state = "loading"
            emit(True)
            cfg = self.config.config
            p = req.params
            backend = self.models.acquire(p.model, cfg.device, cfg.precision, p.loras)
            if cancel.is_set():
                raise Cancelled()
            source = self.load_source(req.source, backend.sample_rate) if req.source else None
            t0 = time.time()
            takes = generate.run(req, backend, source, on_variation, on_step)
            gen_time = (time.time() - t0) / max(len(takes), 1)
            job.state = "saving"
            emit(True)
            for take in takes:
                item = self._save_take(req, take, {"generation_time": round(gen_time, 3)})
                job.results.append(item)
                job.seeds.append(take.seed)
            job.state = "done"
            job.progress = 1.0
            self.models.last_used = time.time()
        except Cancelled:
            job.state = "cancelled"
        except Exception as e:  # noqa: BLE001
            job.state = "error"
            job.error = f"{type(e).__name__}: {e}"
            self.log(f"job {job.id} failed: {job.error}\n{traceback.format_exc()}")
        finally:
            job.finished = time.time()
            emit(True)

    # ------------------------------------------------------------------ processing / export
    def process(self, req: ProcessRequest) -> SfxItem:
        self.touch()
        path, sidecar, item = resolve_source(req.source, self.library, self.history)
        audio, sr = audio_io.load(path)
        audio, sr = dsp.apply_all(audio, sr, list(req.ops))
        ops = [op.model_dump() for op in req.ops]
        if req.target == "replace" and item is not None:
            store = self.store_for(item.id)
            # Keep a copy of the pre-edit file in History so the edit is undoable.
            backup = self.history.copy_in(path, self.history.day_folder(), path.stem + "_before")
            audio_io.write(path, audio, sr, path.suffix.lstrip(".").lower() if path.suffix.lower() in (".wav", ".flac", ".mp3") else "wav")
            updated = store.update_sidecar(item.id, {
                "ops": (sidecar.get("ops") or []) + ops,
                "stats": audio_io.analyze(audio, sr).model_dump(),
                "peaks": audio_io.peaks(audio),
                "backup_uid": backup.uid,
            })
            self.bus.emit("library" if store is self.library else "history", {"change": "updated", "ids": [updated.id]})
            return updated
        meta = {k: v for k, v in sidecar.items() if k not in ("uid", "created", "stats", "peaks", "schema")}
        meta["ops"] = (sidecar.get("ops") or []) + ops
        meta["parent_uid"] = item.uid if item else sidecar.get("uid")
        stem = req.name or path.stem
        if req.target == "library":
            new = self.library.save_audio(audio, sr, safe_folder(req.folder or (item.folder if item and item.kind == "library" else "Inbox")), stem, meta)
            self.bus.emit("library", {"change": "added", "ids": [new.id]})
        else:
            new = self.history.save_audio(audio, sr, self.history.day_folder(), stem, meta)
            self.bus.emit("history", {"change": "added", "ids": [new.id]})
        return new

    def export(self, req: ExportRequest) -> ExportResult:
        self.touch()
        dest = Path(req.dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        files, warnings = [], []
        for index, ref in enumerate(req.sources, start=1):
            path, sidecar, item = resolve_source(ref, self.library, self.history)
            audio, sr = audio_io.load(path)
            if req.normalize:
                audio = dsp.normalize(audio, sr, req.normalize.mode, req.normalize.target)
            if req.channels == 1 and audio.shape[0] > 1:
                audio = audio.mean(axis=0, keepdims=True)
            elif req.channels == 2 and audio.shape[0] == 1:
                audio = np.repeat(audio, 2, axis=0)
            target_sr = req.sample_rate or sr
            if req.format == "mp3" and target_sr not in (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000):
                target_sr = 44100
            audio = dsp.resample(audio, sr, target_sr)
            is_loop = sidecar.get("mode") == "loop" or any(o.get("op") == "loop_crossfade" for o in sidecar.get("ops") or [])
            if req.format == "mp3" and is_loop:
                warnings.append(f"{path.name}: MP3 adds encoder padding, so the loop will click; use WAV or FLAC for loops")
            stem = req.name_template.format(
                name=path.stem, index=f"{index:02d}", seed=sidecar.get("seed", ""), folder=(item.folder if item else ""),
            )
            out = dest / f"{safe_name(stem) if stem.strip() else 'sfx'}.{req.format}"
            if out.exists() and not req.overwrite:
                k = 2
                while (dest / f"{out.stem}_{k}.{req.format}").exists():
                    k += 1
                out = dest / f"{out.stem}_{k}.{req.format}"
            audio_io.write(out, audio, target_sr, req.format, req.bit_depth, req.mp3_bitrate, title=path.stem, comment=sidecar.get("prompt"))
            files.append(str(out))
        return ExportResult(files=files, warnings=warnings)

