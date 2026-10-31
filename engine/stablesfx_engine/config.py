"""Engine-owned config (``~/.stablesfx/config.json``). Only the engine writes it;
clients read/write through the API so there is never more than one writer."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import paths
from .schema import EngineConfig


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, indent=2, ensure_ascii=False))


class ConfigStore:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.config_json()
        self._lock = threading.Lock()
        self._config = self._load()

    def _load(self) -> EngineConfig:
        try:
            cfg = EngineConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = EngineConfig()
        if not cfg.library_path:
            cfg.library_path = str(paths.default_library_dir())
        return cfg

    @property
    def config(self) -> EngineConfig:
        return self._config

    def update(self, patch: dict[str, Any]) -> EngineConfig:
        with self._lock:
            merged = self._config.model_dump()
            for key, value in patch.items():
                if isinstance(value, dict) and isinstance(merged.get(key), dict):
                    merged[key].update(value)
                else:
                    merged[key] = value
            self._config = EngineConfig.model_validate(merged)
            atomic_write_json(self.path, self._config.model_dump())
            return self._config

    def save(self) -> None:
        with self._lock:
            atomic_write_json(self.path, self._config.model_dump())

    @property
    def library_path(self) -> Path:
        return Path(self._config.library_path)
