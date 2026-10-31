"""One engine per user: an exclusive lock file held for the engine's lifetime, an
``engine.json`` discovery file, and ``ensure()`` which pings or spawns the engine.

Nothing here imports torch, so ``ensure`` (used by Electron and the MCP server) is fast.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import paths
from .config import atomic_write_json

DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000


class InstanceLock:
    """Exclusive, process-lifetime lock (released by Windows if the process dies)."""

    def __init__(self, path: Path | None = None):
        self.path = path or paths.engine_lock()
        self._fh = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+b")
        try:
            if sys.platform == "win32":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True


def read_info() -> dict[str, Any] | None:
    try:
        return json.loads(paths.engine_json().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_info(info: dict[str, Any]) -> None:
    atomic_write_json(paths.engine_json(), info)


def clear_info(nonce: str) -> None:
    info = read_info()
    if info and info.get("nonce") == nonce:
        try:
            paths.engine_json().unlink()
        except OSError:
            pass


def ping(info: dict[str, Any] | None, timeout: float = 2.0) -> dict[str, Any] | None:
    if not info:
        return None
    import httpx

    try:
        r = httpx.get(
            f"http://127.0.0.1:{info['port']}/status",
            headers={"Authorization": f"Bearer {info['token']}"}, timeout=timeout,
        )
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, KeyError, ValueError):
        return None


def engine_source_dir() -> Path:
    return Path(__file__).resolve().parent.parent


def spawn(fake: bool = False) -> subprocess.Popen:
    """Start ``pythonw -m stablesfx_engine serve`` fully detached (no console window)."""
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    interpreter = str(pythonw if pythonw.exists() else exe)
    env = dict(os.environ)
    src = str(engine_source_dir())
    env["PYTHONPATH"] = src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    env["PYTHONUNBUFFERED"] = "1"
    if fake:
        env["STABLESFX_FAKE"] = "1"
    args = [interpreter, "-m", "stablesfx_engine", "serve"]
    common = dict(
        cwd=src, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, close_fds=True,
    )
    if sys.platform != "win32":
        return subprocess.Popen(args, start_new_session=True, **common)
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    try:
        # Break away from the caller's job object so the engine outlives e.g. a Claude session.
        return subprocess.Popen(args, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, **common)
    except OSError:
        return subprocess.Popen(args, creationflags=flags, **common)


def ensure(timeout: float = 60.0, fake: bool = False) -> dict[str, Any]:
    """Return engine.json for a live engine, starting one if needed."""
    info = read_info()
    if ping(info):
        return info  # type: ignore[return-value]
    proc = spawn(fake=fake)
    spawned_at = time.time()
    deadline = spawned_at + timeout
    while time.time() < deadline:
        time.sleep(0.25)
        info = read_info()
        if ping(info, timeout=1.0):
            return info  # type: ignore[return-value]
        if proc.poll() is not None and time.time() - spawned_at > 1.0:
            # Our engine exited, normally because a previous one still held the lock while
            # shutting down. Try again until it is gone.
            proc = spawn(fake=fake)
            spawned_at = time.time()
    log = paths.logs_dir() / "engine.log"
    tail = ""
    try:
        tail = "\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-15:])
    except OSError:
        pass
    raise TimeoutError(f"engine did not start within {timeout:.0f}s. Last log lines:\n{tail}")


def stop(timeout: float = 10.0) -> bool:
    info = read_info()
    if not ping(info):
        return False
    import httpx

    try:
        httpx.post(f"http://127.0.0.1:{info['port']}/shutdown", headers={"Authorization": f"Bearer {info['token']}"}, timeout=3)
    except httpx.HTTPError:
        pass
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not ping(info, timeout=0.5):
            return True
        time.sleep(0.25)
    if sys.platform == "win32" and info.get("pid"):
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(info["pid"])], capture_output=True, creationflags=CREATE_NO_WINDOW)
    return True
