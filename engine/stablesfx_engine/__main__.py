"""Entry points: ``python -m stablesfx_engine serve|ensure|stop|mcp|openapi``."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path


def _redirect_output() -> None:
    # Must run before importing anything heavy: under pythonw sys.stdout/stderr are None,
    # and upstream prints at import time.
    from . import paths

    paths.logs_dir().mkdir(parents=True, exist_ok=True)
    log = paths.logs_dir() / "engine.log"
    try:
        if log.exists() and log.stat().st_size > 5 * 1024 * 1024:
            log.replace(log.with_suffix(".log.1"))
    except OSError:
        pass
    fh = open(log, "a", encoding="utf-8", buffering=1, errors="replace")
    sys.stdout = fh
    sys.stderr = fh


def src_hash() -> str:
    h = hashlib.sha1()
    pkg = Path(__file__).resolve().parent
    for p in sorted(pkg.glob("*.py")):
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


def serve(fake: bool, console: bool) -> int:
    if not console:
        _redirect_output()
    os.environ.setdefault("PYTHONWARNINGS", "ignore")
    import warnings

    warnings.filterwarnings("ignore")
    from .instance import InstanceLock, clear_info, write_info

    lock = InstanceLock()
    if not lock.acquire():
        print("another engine is already running; exiting", flush=True)
        return 0

    import secrets
    import socket
    import threading
    import uuid

    import uvicorn

    from .core import Engine
    from .server import create_app, idle_monitor

    engine = Engine(fake=fake, src_hash=src_hash())
    token = secrets.token_urlsafe(24)
    nonce = uuid.uuid4().hex
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", int(os.environ.get("STABLESFX_PORT", "0"))))
    port = sock.getsockname()[1]

    server: uvicorn.Server | None = None

    def stop() -> None:
        # Stop advertising first so clients spawn/find a fresh engine instead of this dying one,
        # then exit gracefully, or hard if a lingering connection stalls the shutdown.
        clear_info(nonce)
        if server is not None:
            server.should_exit = True
        threading.Timer(6.0, lambda: os._exit(0)).start()

    app = create_app(engine, token, on_shutdown=stop)

    async def announce() -> None:
        write_info({
            "port": port, "token": token, "pid": os.getpid(), "nonce": nonce,
            "srcHash": engine.src_hash, "fake": fake, "python": sys.executable,
            "engineDir": str(Path(__file__).resolve().parent.parent),
        })
        engine.log(f"listening on 127.0.0.1:{port} (pid {os.getpid()}, fake={fake})")

    app.router.on_startup.append(announce)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False, ws_max_size=1 << 20, timeout_graceful_shutdown=3))
    threading.Thread(target=idle_monitor, args=(engine, app, stop), daemon=True, name="idle").start()
    try:
        server.run(sockets=[sock])
    finally:
        clear_info(nonce)
        engine.log("engine stopped")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stablesfx_engine")
    sub = parser.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the engine (normally started via 'ensure')")
    s.add_argument("--fake", action="store_true", help="synthetic audio, no model (tests/UI dev)")
    s.add_argument("--console", action="store_true", help="log to the console instead of the log file")
    e = sub.add_parser("ensure", help="start the engine if needed and print its connection info")
    e.add_argument("--fake", action="store_true")
    e.add_argument("--timeout", type=float, default=60)
    sub.add_parser("stop", help="stop the running engine")
    sub.add_parser("mcp", help="run the MCP server on stdio")
    sub.add_parser("openapi", help="print the OpenAPI schema")
    args = parser.parse_args(argv)

    fake_env = os.environ.get("STABLESFX_FAKE") == "1"
    if args.cmd == "serve":
        return serve(args.fake or fake_env, args.console)
    if args.cmd == "ensure":
        from .instance import ensure

        try:
            print(json.dumps(ensure(args.timeout, fake=args.fake or fake_env)))
            return 0
        except TimeoutError as err:
            print(str(err), file=sys.stderr)
            return 1
    if args.cmd == "stop":
        from .instance import stop

        print(json.dumps({"stopped": stop()}))
        return 0
    if args.cmd == "mcp":
        from .mcp_server import run

        run()
        return 0
    if args.cmd == "openapi":
        from .server import create_app

        class _Stub:  # create_app only needs attributes at request time
            pass

        app = create_app(_Stub(), "x")  # type: ignore[arg-type]
        print(json.dumps(app.openapi(), indent=2))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
