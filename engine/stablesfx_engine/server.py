"""FastAPI app: the HTTP + WebSocket API the Electron app and the MCP server use."""

from __future__ import annotations

import asyncio
import hmac
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from . import audio_io
from .core import Engine
from .library import resolve_source
from .models import GatedModelError, delete_cache
from .schema import (
    EngineConfig, EngineStatus, ExportRequest, ExportResult, FolderNode, FolderRequest, ImportRequest,
    ItemPatch, JobInfo, JobRequest, KeepRequest, ModelInfo, Preset, ProcessRequest, SfxItem,
)


def create_app(engine: Engine, token: str, on_shutdown=None) -> FastAPI:
    app = FastAPI(title="StableSFX Engine", version="1")
    clients: set[WebSocket] = set()

    def authorized(request_token: str | None) -> bool:
        return bool(request_token) and hmac.compare_digest(request_token, token)

    @app.middleware("http")
    async def auth(request: Request, call_next):
        header = request.headers.get("authorization", "")
        supplied = header[7:] if header.lower().startswith("bearer ") else request.query_params.get("token")
        if not authorized(supplied):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        engine.touch()
        return await call_next(request)

    @app.exception_handler(KeyError)
    async def not_found(_: Request, exc: KeyError):
        return JSONResponse({"detail": f"not found: {exc.args[0] if exc.args else ''}"}, status_code=404)

    @app.exception_handler(ValueError)
    async def bad_request(_: Request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.exception_handler(GatedModelError)
    async def gated(_: Request, exc: GatedModelError):
        return JSONResponse({"detail": str(exc), "gated": exc.model}, status_code=403)

    async def _bind_loop() -> None:
        engine.bus.loop = asyncio.get_running_loop()

    app.router.on_startup.append(_bind_loop)

    # ---------------------------------------------------------------- status / config
    @app.get("/status", response_model=EngineStatus)
    def status() -> EngineStatus:
        return engine.status(len(clients))

    @app.get("/config", response_model=EngineConfig)
    def get_config() -> EngineConfig:
        return engine.config.config

    @app.patch("/config", response_model=EngineConfig)
    def patch_config(patch: dict[str, Any] = Body(...)) -> EngineConfig:
        lib = patch.pop("library_path", None)
        cfg = engine.config.update(patch) if patch else engine.config.config
        if lib and lib != cfg.library_path:
            engine.set_library_path(lib)
            cfg = engine.config.config
        engine.bus.emit("config", cfg.model_dump())
        return cfg

    @app.get("/logs")
    def logs() -> list[str]:
        return list(engine.log_lines)

    @app.post("/shutdown")
    def shutdown() -> dict[str, bool]:
        if on_shutdown:
            threading.Timer(0.2, on_shutdown).start()
        return {"ok": True}

    # ---------------------------------------------------------------- models
    @app.get("/models", response_model=list[ModelInfo])
    def models() -> list[ModelInfo]:
        return engine.models.catalog()

    @app.post("/models/{model}/download")
    def download(model: str) -> dict[str, bool]:
        engine.models.start_download(model)
        return {"ok": True}

    @app.delete("/models/{model}/cache")
    def delete_model_cache(model: str) -> dict[str, int]:
        if engine.models.loaded == model:
            engine.models.unload()
        return {"freed": delete_cache(model)}

    @app.post("/models/unload")
    def unload() -> dict[str, bool]:
        engine.models.unload()
        return {"ok": True}

    # ---------------------------------------------------------------- jobs
    @app.post("/jobs", response_model=JobInfo)
    def submit(req: JobRequest) -> JobInfo:
        if req.source and req.source.startswith(("lib:", "hist:")):
            engine.get_item(req.source)  # 404 now rather than a failed job later
        return engine.submit(req)

    @app.get("/jobs", response_model=list[JobInfo])
    def jobs(limit: int = 30) -> list[JobInfo]:
        return list(engine.jobs.values())[-limit:][::-1]

    @app.get("/jobs/{job_id}", response_model=JobInfo)
    def job(job_id: str) -> JobInfo:
        return engine.jobs[job_id]

    @app.get("/jobs/{job_id}/wait", response_model=JobInfo)
    def wait(job_id: str, timeout: float = Query(60, le=600)) -> JobInfo:
        return engine.wait(job_id, timeout)

    @app.post("/jobs/{job_id}/cancel", response_model=JobInfo)
    def cancel(job_id: str) -> JobInfo:
        return engine.cancel(job_id)

    # ---------------------------------------------------------------- library & history
    @app.get("/library/tree", response_model=FolderNode)
    def tree() -> FolderNode:
        return engine.library.tree()

    @app.get("/library/items", response_model=list[SfxItem])
    def library_items(
        folder: str | None = None, q: str | None = None, tags: str | None = None,
        sort: str = "modified", recursive: bool = True, limit: int | None = None,
    ) -> list[SfxItem]:
        tag_list = [t for t in (tags or "").split(",") if t]
        return engine.library.list(folder, q, tag_list, recursive, sort, limit)

    @app.get("/history/items", response_model=list[SfxItem])
    def history_items(q: str | None = None, limit: int | None = 300) -> list[SfxItem]:
        return engine.history.list(None, q, None, True, "modified", limit)

    @app.post("/history/prune")
    def prune() -> dict[str, int]:
        cfg = engine.config.config
        removed = engine.history.prune(cfg.history_retention_days, cfg.history_max_gb)
        engine.bus.emit("history", {"change": "pruned"})
        return {"removed": removed}

    @app.get("/resolve", response_model=SfxItem)
    def resolve(ref: str) -> SfxItem:
        """Any reference (item id, library-relative path, absolute path) -> item."""
        path, sidecar, item = resolve_source(ref, engine.library, engine.history)
        if item is not None:
            return item
        audio, sr = audio_io.load(path)
        st = path.stat()
        return SfxItem(
            id=str(path), uid=sidecar.get("uid", ""), kind="external", path=str(path), folder=str(path.parent),
            name=path.stem, ext=path.suffix.lstrip(".").lower(), size=st.st_size,
            created=sidecar.get("created", ""), modified=st.st_mtime, prompt=sidecar.get("prompt"),
            model=sidecar.get("model"), seed=sidecar.get("seed"), params=sidecar.get("params"),
            tags=sidecar.get("tags") or [], stats=audio_io.analyze(audio, sr), peaks=audio_io.peaks(audio),
        )

    @app.get("/items/{item_id:path}", response_model=SfxItem)
    def item(item_id: str) -> SfxItem:
        return engine.get_item(item_id)

    @app.patch("/items/{item_id:path}", response_model=SfxItem)
    def patch_item(item_id: str, patch: ItemPatch) -> SfxItem:
        store = engine.store_for(item_id)
        updates = {k: v for k, v in patch.model_dump().items() if v is not None and k in ("tags", "starred", "prompt")}
        current = store.update_sidecar(item_id, updates) if updates else store.get(item_id)
        if patch.name is not None or patch.folder is not None:
            current = store.move(current.id, patch.folder, patch.name)
        engine.bus.emit("library" if store is engine.library else "history", {"change": "updated", "ids": [item_id, current.id]})
        return current

    @app.delete("/items/{item_id:path}")
    def delete_item(item_id: str) -> dict[str, bool]:
        store = engine.store_for(item_id)
        store.delete(item_id, to_trash=store is engine.library)
        engine.bus.emit("library" if store is engine.library else "history", {"change": "removed", "ids": [item_id]})
        return {"ok": True}

    @app.post("/library/keep", response_model=SfxItem)
    def keep(req: KeepRequest) -> SfxItem:
        src = engine.get_item(req.id)
        if req.id.startswith("lib:"):
            new = engine.library.move(req.id, req.folder, req.name)
        else:
            new = engine.library.copy_in(Path(src.path), req.folder, req.name or src.name)
            if req.move:
                engine.history.delete(req.id, to_trash=False)
        if req.tags:
            new = engine.library.update_sidecar(new.id, {"tags": sorted(set(new.tags) | set(req.tags))})
        engine.bus.emit("library", {"change": "added", "ids": [new.id], "folder": new.folder})
        return new

    @app.post("/library/import", response_model=list[SfxItem])
    def import_files(req: ImportRequest) -> list[SfxItem]:
        out = []
        for p in req.paths:
            path = Path(p)
            if path.is_file():
                out.append(engine.library.copy_in(path, req.folder, sidecar_patch={"origin": "import"}))
        engine.bus.emit("library", {"change": "added", "ids": [i.id for i in out]})
        return out

    @app.post("/library/folders")
    def create_folder(req: FolderRequest) -> dict[str, str]:
        rel = engine.library.make_folder(req.path)
        engine.bus.emit("library", {"change": "folders"})
        return {"path": rel}

    @app.patch("/library/folders")
    def rename_folder(req: FolderRequest) -> dict[str, str]:
        if not req.new_path:
            raise ValueError("new_path required")
        rel = engine.library.rename_folder(req.path, req.new_path)
        engine.bus.emit("library", {"change": "folders"})
        return {"path": rel}

    @app.delete("/library/folders")
    def delete_folder(path: str) -> dict[str, bool]:
        engine.library.delete_folder(path)
        engine.bus.emit("library", {"change": "folders"})
        return {"ok": True}

    @app.get("/audio/{item_id:path}")
    def audio(item_id: str) -> FileResponse:
        it = engine.get_item(item_id)
        media = {"wav": "audio/wav", "flac": "audio/flac", "mp3": "audio/mpeg", "ogg": "audio/ogg"}.get(it.ext, "application/octet-stream")
        return FileResponse(it.path, media_type=media, headers={"Cache-Control": "no-cache"})

    # ---------------------------------------------------------------- processing / export / presets
    @app.post("/process", response_model=SfxItem)
    def process(req: ProcessRequest) -> SfxItem:
        return engine.process(req)

    @app.post("/export", response_model=ExportResult)
    def export(req: ExportRequest) -> ExportResult:
        return engine.export(req)

    @app.get("/presets", response_model=list[Preset])
    def presets() -> list[Preset]:
        return engine.presets.all()

    @app.put("/presets", response_model=Preset)
    def save_preset(preset: Preset) -> Preset:
        saved = engine.presets.save(preset)
        engine.bus.emit("presets", {"change": "saved", "id": saved.id})
        return saved

    @app.delete("/presets/{preset_id:path}")
    def delete_preset(preset_id: str) -> dict[str, bool]:
        engine.presets.delete(preset_id)
        engine.bus.emit("presets", {"change": "deleted", "id": preset_id})
        return {"ok": True}

    # ---------------------------------------------------------------- events
    @app.websocket("/events")
    async def events(ws: WebSocket) -> None:
        if not authorized(ws.query_params.get("token")):
            await ws.close(code=4401)
            return
        await ws.accept()
        clients.add(ws)
        q = engine.bus.subscribe()
        try:
            await ws.send_json({"type": "status", "data": engine.status(len(clients)).model_dump()})
            while True:
                msg = await q.get()
                await ws.send_text(msg)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            engine.bus.unsubscribe(q)
            clients.discard(ws)
            engine.touch()

    app.state.clients = clients
    return app


def idle_monitor(engine: Engine, app: FastAPI, stop) -> None:
    """Unload the model after idle; exit the engine when nobody has used it for a while."""
    last_prune = 0.0
    while True:
        time.sleep(5)
        cfg = engine.config.config
        now = time.time()
        downloading = any(d.get("running") for d in engine.models.downloads.values())
        busy = engine._busy or engine._queue.qsize() > 0 or downloading
        if engine.models.loaded and not busy and now - engine.models.last_used > cfg.model_idle_unload_minutes * 60:
            engine.models.unload()
        if now - last_prune > 6 * 3600:
            last_prune = now
            try:
                engine.history.prune(cfg.history_retention_days, cfg.history_max_gb)
            except Exception as e:  # noqa: BLE001
                engine.log(f"history prune failed: {e}")
        no_clients = len(app.state.clients) == 0
        if no_clients and not busy and now - engine.last_activity > cfg.engine_idle_exit_minutes * 60:
            engine.log("idle timeout: exiting")
            stop()
            return
