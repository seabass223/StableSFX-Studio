"""Folder-based SFX library + hidden History.

Each audio file has a ``<stem>.sfx.json`` sidecar next to it (the only index; no DB).
Item ids are path-based: ``lib:<relative posix path>`` or ``hist:<relative posix path>``.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np

from . import audio_io
from .config import atomic_write_json
from .schema import FolderNode, SfxItem

SIDECAR_SUFFIX = ".sfx.json"
SIDECAR_SCHEMA = "stablesfx.sidecar/1"
DEFAULT_FOLDERS = ("Inbox", "Imported", "Claude")
_SLUG_RE = re.compile(r"[^a-z0-9]+")
_PREFIX_RE = re.compile(r"^\s*TrackType:\s*\w+\s*,\s*", re.I)
_STOPWORDS = {"a", "an", "the", "of", "with", "and", "in", "on", "at", "to", "for", "no", "very", "some"}


def slugify(text: str, max_words: int = 4) -> str:
    text = _PREFIX_RE.sub("", text or "").lower()
    words = [w for w in _SLUG_RE.split(text) if w and w not in _STOPWORDS]
    return "_".join(words[:max_words]) or "sfx"


def safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    return name[:120] or "sfx"


def safe_folder(folder: str | None) -> str:
    """Normalise a user-supplied relative folder; refuses to escape the root."""
    parts = [safe_name(p) for p in re.split(r"[\\/]+", folder or "") if p and p not in (".", "..")]
    return "/".join(parts)


def sidecar_for(audio_path: Path) -> Path:
    return audio_path.with_name(audio_path.stem + SIDECAR_SUFFIX)


def retry_io(fn: Callable[[], Any], attempts: int = 8, delay: float = 0.15) -> Any:
    """Windows: files briefly held open by a player/scanner raise WinError 32; retry."""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay * (i + 1))


class Store:
    """One rooted tree of audio files + sidecars (used for both the Library and History)."""

    def __init__(self, root: Path, kind: str):
        # Resolved, so ids stay relative when the root sits behind a junction (e.g. ~\.stablesfx on A:).
        self.root = Path(root).resolve()
        self.kind = kind  # "library" | "history"
        self.prefix = "lib:" if kind == "library" else "hist:"
        self._lock = threading.RLock()

    # ------------------------------------------------------------------ ids & paths
    def id_for(self, path: Path) -> str:
        return self.prefix + path.relative_to(self.root).as_posix()

    def path_for(self, item_id: str) -> Path:
        if not item_id.startswith(self.prefix):
            raise KeyError(item_id)
        rel = item_id[len(self.prefix):]
        path = (self.root / rel).resolve()
        if self.root.resolve() not in path.parents:
            raise KeyError(item_id)
        return path

    def unique_path(self, folder: str, stem: str, ext: str) -> Path:
        directory = self.root / folder if folder else self.root
        directory.mkdir(parents=True, exist_ok=True)
        stem = safe_name(stem)
        if re.search(r"_\d{3}$", stem) is None:
            stem = f"{stem}_001"
        base = stem[:-4]
        n = int(stem[-3:])
        while True:
            candidate = directory / f"{base}_{n:03d}.{ext}"
            if not candidate.exists() and not sidecar_for(candidate).exists():
                return candidate
            n += 1

    # ------------------------------------------------------------------ read
    def read_sidecar(self, audio_path: Path) -> dict[str, Any]:
        try:
            return json.loads(sidecar_for(audio_path).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def item(self, path: Path, sidecar: dict[str, Any] | None = None) -> SfxItem:
        sc = sidecar if sidecar is not None else self.read_sidecar(path)
        if not sc.get("stats") or not sc.get("peaks") or not sc.get("uid"):
            sc = self._backfill_sidecar(path, sc)
        st = path.stat()
        rel_folder = path.parent.relative_to(self.root).as_posix()
        return SfxItem(
            id=self.id_for(path),
            uid=sc.get("uid") or "",
            kind=self.kind,  # type: ignore[arg-type]
            path=str(path),
            folder="" if rel_folder == "." else rel_folder,
            name=path.stem,
            ext=path.suffix.lstrip(".").lower(),
            size=st.st_size,
            created=sc.get("created") or datetime.fromtimestamp(st.st_ctime).isoformat(timespec="seconds"),
            modified=st.st_mtime,
            prompt=sc.get("prompt"),
            model=sc.get("model"),
            mode=sc.get("mode"),
            seed=sc.get("seed"),
            params=sc.get("params"),
            source_uid=(sc.get("source") or {}).get("uid"),
            parent_uid=sc.get("parent_uid"),
            ops=sc.get("ops") or [],
            tags=sc.get("tags") or [],
            starred=bool(sc.get("starred")),
            origin=sc.get("origin"),
            generation_time=sc.get("generation_time"),
            stats=sc.get("stats"),
            peaks=sc.get("peaks") or [],
        )

    def _backfill_sidecar(self, path: Path, sc: dict[str, Any]) -> dict[str, Any]:
        """Files dropped in by hand get a sidecar with stats/peaks on first sight."""
        try:
            audio, sr = audio_io.load(path)
        except Exception:
            return sc
        sc = dict(sc)
        sc.setdefault("schema", SIDECAR_SCHEMA)
        sc.setdefault("uid", uuid.uuid4().hex)
        sc.setdefault("created", datetime.fromtimestamp(path.stat().st_ctime).isoformat(timespec="seconds"))
        sc.setdefault("tags", [])
        sc["stats"] = audio_io.analyze(audio, sr).model_dump()
        sc["peaks"] = audio_io.peaks(audio)
        try:
            atomic_write_json(sidecar_for(path), sc)
        except OSError:
            pass
        return sc

    def get(self, item_id: str) -> SfxItem:
        path = self.path_for(item_id)
        if not path.is_file():
            raise KeyError(item_id)
        return self.item(path)

    def iter_audio(self, folder: str | None = None, recursive: bool = True) -> Iterable[Path]:
        base = self.root / safe_folder(folder) if folder else self.root
        if not base.is_dir():
            return []
        pattern = base.rglob("*") if recursive else base.glob("*")
        return (
            p for p in pattern
            if p.is_file() and p.suffix.lower() in audio_io.AUDIO_EXTS and not p.name.startswith(".")
            and not any(part.startswith(".") for part in p.relative_to(self.root).parts[:-1])
        )

    def list(
        self, folder: str | None = None, query: str | None = None, tags: list[str] | None = None,
        recursive: bool = True, sort: str = "modified", limit: int | None = None,
    ) -> list[SfxItem]:
        items = []
        q = (query or "").lower().strip()
        for path in self.iter_audio(folder, recursive):
            it = self.item(path)
            if tags and not set(t.lower() for t in tags) <= set(t.lower() for t in it.tags):
                continue
            if q:
                hay = " ".join([it.name, it.folder, it.prompt or "", " ".join(it.tags), it.model or ""]).lower()
                if not all(tok in hay for tok in q.split()):
                    continue
            items.append(it)
        key = {
            "name": lambda i: i.name.lower(),
            "duration": lambda i: i.stats.duration if i.stats else 0,
            "created": lambda i: i.created,
        }.get(sort)
        items.sort(key=key or (lambda i: i.modified), reverse=key is None or sort == "created")
        return items[:limit] if limit else items

    def tree(self) -> FolderNode:
        def build(directory: Path) -> FolderNode:
            children = [
                build(d) for d in sorted(directory.iterdir(), key=lambda p: p.name.lower())
                if d.is_dir() and not d.name.startswith(".")
            ]
            count = sum(1 for p in directory.iterdir() if p.is_file() and p.suffix.lower() in audio_io.AUDIO_EXTS)
            rel = directory.relative_to(self.root).as_posix()
            return FolderNode(
                name=directory.name if rel != "." else "Library", path="" if rel == "." else rel,
                count=count + sum(c.count for c in children), children=children,
            )

        self.root.mkdir(parents=True, exist_ok=True)
        return build(self.root)

    # ------------------------------------------------------------------ write
    def save_audio(
        self, audio: np.ndarray, sr: int, folder: str, stem: str, sidecar: dict[str, Any],
        fmt: str = "wav", bit_depth: int = 24, mp3_bitrate: int = 320,
    ) -> SfxItem:
        if not (fmt == "wav" and bit_depth == 32):
            audio = np.clip(audio, -1.0, 1.0)  # what the integer/MP3 file will hold; keeps stats honest
        with self._lock:
            path = self.unique_path(safe_folder(folder), stem, fmt)
            prompt = sidecar.get("prompt")
            audio_io.write(path, audio, sr, fmt, bit_depth, mp3_bitrate, title=path.stem, comment=prompt)
            sc = {
                "schema": SIDECAR_SCHEMA,
                "uid": uuid.uuid4().hex,
                "created": datetime.now().isoformat(timespec="seconds"),
                "tags": [],
                **sidecar,
                "stats": audio_io.analyze(audio, sr).model_dump(),
                "peaks": audio_io.peaks(audio),
            }
            atomic_write_json(sidecar_for(path), sc)
            return self.item(path, sc)

    def update_sidecar(self, item_id: str, patch: dict[str, Any]) -> SfxItem:
        path = self.path_for(item_id)
        with self._lock:
            sc = self.read_sidecar(path) or self._backfill_sidecar(path, {})
            sc.update(patch)
            atomic_write_json(sidecar_for(path), sc)
            return self.item(path, sc)

    def move(self, item_id: str, folder: str | None = None, name: str | None = None) -> SfxItem:
        src = self.path_for(item_id)
        with self._lock:
            new_folder = safe_folder(folder) if folder is not None else src.parent.relative_to(self.root).as_posix()
            new_folder = "" if new_folder == "." else new_folder
            directory = self.root / new_folder if new_folder else self.root
            directory.mkdir(parents=True, exist_ok=True)
            stem = safe_name(name) if name else src.stem
            dst = directory / f"{stem}{src.suffix}"
            if dst == src:
                return self.item(src)
            if dst.exists() or sidecar_for(dst).exists():
                dst = self.unique_path(new_folder, stem, src.suffix.lstrip("."))
            retry_io(lambda: shutil.move(str(src), str(dst)))
            if sidecar_for(src).exists():
                retry_io(lambda: shutil.move(str(sidecar_for(src)), str(sidecar_for(dst))))
            return self.item(dst)

    def copy_in(self, src: Path, folder: str, stem: str | None = None, sidecar_patch: dict | None = None) -> SfxItem:
        """Copy an audio file (and its sidecar, if it has one) into this store."""
        with self._lock:
            ext = src.suffix.lstrip(".").lower()
            dst = self.unique_path(safe_folder(folder), stem or src.stem, ext)
            retry_io(lambda: shutil.copy2(str(src), str(dst)))
            sc = {}
            if sidecar_for(src).exists():
                try:
                    sc = json.loads(sidecar_for(src).read_text(encoding="utf-8"))
                except ValueError:
                    sc = {}
            if sidecar_patch:
                sc.update(sidecar_patch)
            sc.setdefault("uid", uuid.uuid4().hex)
            if sc:
                atomic_write_json(sidecar_for(dst), sc)
            return self.item(dst)

    def delete(self, item_id: str, to_trash: bool = True) -> None:
        path = self.path_for(item_id)
        targets = [p for p in (path, sidecar_for(path)) if p.exists()]
        for p in targets:
            if to_trash:
                from send2trash import send2trash

                retry_io(lambda p=p: send2trash(str(p)))
            else:
                retry_io(lambda p=p: p.unlink())

    def make_folder(self, folder: str) -> str:
        rel = safe_folder(folder)
        if not rel:
            raise ValueError("folder name required")
        (self.root / rel).mkdir(parents=True, exist_ok=True)
        return rel

    def rename_folder(self, folder: str, new_folder: str) -> str:
        src = self.root / safe_folder(folder)
        dst_rel = safe_folder(new_folder)
        dst = self.root / dst_rel
        if not src.is_dir() or not dst_rel:
            raise KeyError(folder)
        if dst.exists():
            raise FileExistsError(new_folder)
        dst.parent.mkdir(parents=True, exist_ok=True)
        retry_io(lambda: shutil.move(str(src), str(dst)))
        return dst_rel

    def delete_folder(self, folder: str) -> None:
        path = self.root / safe_folder(folder)
        if not safe_folder(folder) or not path.is_dir():
            raise KeyError(folder)
        from send2trash import send2trash

        retry_io(lambda: send2trash(str(path)))

    def find_uid(self, uid: str) -> SfxItem | None:
        for path in self.iter_audio():
            sc = self.read_sidecar(path)
            if sc.get("uid") == uid:
                return self.item(path, sc)
        return None


class History(Store):
    def __init__(self, root: Path):
        super().__init__(root, "history")

    def day_folder(self) -> str:
        return datetime.now().strftime("%Y-%m-%d")

    def prune(self, retention_days: float, max_gb: float, keep_ids: set[str] | None = None) -> int:
        """Delete (permanently) takes older than retention, then oldest-first above the size cap."""
        keep_ids = keep_ids or set()
        cutoff = time.time() - retention_days * 86400
        files = sorted(self.iter_audio(), key=lambda p: p.stat().st_mtime)
        removed = 0
        total = sum(p.stat().st_size for p in files)
        for p in files:
            too_old = p.stat().st_mtime < cutoff
            too_big = total > max_gb * 1024**3
            if not (too_old or too_big) or self.id_for(p) in keep_ids:
                continue
            size = p.stat().st_size
            try:
                self.delete(self.id_for(p), to_trash=False)
                total -= size
                removed += 1
            except OSError:
                pass
        for d in sorted((d for d in self.root.glob("*") if d.is_dir()), reverse=True):
            try:
                d.rmdir()  # only succeeds when empty
            except OSError:
                pass
        return removed


class Library(Store):
    def __init__(self, root: Path):
        super().__init__(root, "library")

    def ensure_layout(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for f in DEFAULT_FOLDERS:
            (self.root / f).mkdir(exist_ok=True)


def resolve_source(ref: str, library: Library, history: History) -> tuple[Path, dict[str, Any], SfxItem | None]:
    """Resolve an item id, a library-relative path, or an absolute path to (path, sidecar, item)."""
    if ref.startswith("lib:"):
        item = library.get(ref)
        return Path(item.path), library.read_sidecar(Path(item.path)), item
    if ref.startswith("hist:"):
        item = history.get(ref)
        return Path(item.path), history.read_sidecar(Path(item.path)), item
    path = Path(ref)
    if not path.is_absolute():
        path = library.root / ref
    if not path.is_file():
        raise KeyError(ref)
    for store in (library, history):
        try:
            path.resolve().relative_to(store.root.resolve())
            item = store.item(path.resolve())
            return path, store.read_sidecar(path), item
        except ValueError:
            continue
    sc = {}
    if sidecar_for(path).exists():
        try:
            sc = json.loads(sidecar_for(path).read_text(encoding="utf-8"))
        except ValueError:
            pass
    return path, sc, None
