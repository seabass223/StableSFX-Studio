"""Filesystem layout shared by the engine, the MCP server and the Electron app.

Everything lives under ``%USERPROFILE%\\.stablesfx`` rather than AppData: processes
launched from MSIX-packaged hosts (e.g. the Claude desktop app) get their AppData
writes silently redirected, which would split state between launch contexts.
"""

from __future__ import annotations

import ctypes
import os
import sys
import uuid
from pathlib import Path


def home() -> Path:
    override = os.environ.get("STABLESFX_HOME")
    return Path(override) if override else Path.home() / ".stablesfx"


def run_dir() -> Path:
    return home() / "run"


def logs_dir() -> Path:
    return home() / "logs"


def history_dir() -> Path:
    return home() / "history"


def engine_json() -> Path:
    return run_dir() / "engine.json"


def engine_lock() -> Path:
    return run_dir() / "engine.lock"


def config_json() -> Path:
    return home() / "config.json"


def presets_json() -> Path:
    return home() / "presets.json"


def ensure_dirs() -> None:
    for d in (home(), run_dir(), logs_dir(), history_dir()):
        d.mkdir(parents=True, exist_ok=True)


class _GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_ubyte * 8),
    ]


def documents_dir() -> Path:
    """The user's real Documents folder (follows OneDrive/known-folder redirection)."""
    if sys.platform == "win32":
        try:
            guid = uuid.UUID("{FDD39AD0-238F-46AF-ADB4-6C85480369C7}")  # FOLDERID_Documents
            g = _GUID(guid.fields[0], guid.fields[1], guid.fields[2], (ctypes.c_ubyte * 8)(*guid.bytes[8:]))
            out = ctypes.c_wchar_p()
            shell32 = ctypes.windll.shell32
            if shell32.SHGetKnownFolderPath(ctypes.byref(g), 0, None, ctypes.byref(out)) == 0:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                if path:
                    return Path(path)
        except Exception:
            pass
    return Path.home() / "Documents"


def default_library_dir() -> Path:
    return documents_dir() / "StableSFX Library"
