"""End-to-end check of the real engine (GPU) over HTTP. Starts/attaches via `ensure`.

usage: engine/.venv/Scripts/python scripts/engine-check.py [export_dir]
Checks every generation mode, short/fractional durations (upstream diverges on fractional
seconds_total; the engine conditions on whole seconds), fp16-free audio-to-audio, and export.
"""

import math
import os
import sys
import tempfile
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))
from stablesfx_engine import instance  # noqa: E402

info = instance.ensure(timeout=90)
c = httpx.Client(base_url=f"http://127.0.0.1:{info['port']}", headers={"Authorization": f"Bearer {info['token']}"}, timeout=600)
while not c.get("/status").json()["ready"]:
    time.sleep(0.5)
st = c.get("/status").json()
print(f"engine: {st['device_name']} torch {st['torch']} cuda {st['cuda']} pid {st['pid']}")
failures = []


def run(body: dict, label: str, max_rms_db: float = -3.0) -> list[dict]:
    t0 = time.time()
    job = c.post("/jobs", json={**body, "tags": ["engine-check"]}).json()
    job = c.get(f"/jobs/{job['id']}/wait", params={"timeout": 580}).json()
    if job["state"] != "done":
        failures.append(f"{label}: {job['state']} {job.get('error')}")
        print(f"FAIL {label}: {job.get('error')}")
        return []
    for r in job["results"]:
        s = r["stats"]
        ok = math.isfinite(s["rms_db"]) and s["rms_db"] < max_rms_db and s["peak_db"] > -60
        if not ok:
            failures.append(f"{label}: suspicious audio {s}")
        print(f"{'ok  ' if ok else 'BAD '} {label}: {r['name']} {s['duration']:.2f}s rms {s['rms_db']} dB peak {s['peak_db']} dB ({time.time() - t0:.1f}s)")
    return job["results"]


door = run({"params": {"prompt": "heavy wooden door slam, short room reverb, close mic", "duration": 2.0}, "variations": 2}, "text 2s x2")
for d in (0.3, 0.8, 1.2, 1.7):
    run({"params": {"prompt": "retro arcade coin pickup, bright metallic ding", "duration": d, "seed": 1}}, f"text {d}s")
src = door[0]["id"] if door else None
coin = run({"params": {"prompt": "retro arcade coin pickup", "duration": 0.8, "seed": 3}}, "coin 0.8s")
if coin:
    run({"mode": "audio2audio", "source": coin[0]["id"], "strength": 0.25, "variations": 2}, "clone 0.8s @0.25")
if src:
    run({"mode": "audio2audio", "source": src, "strength": 0.6, "params": {"prompt": "heavy metal door slam"}}, "modify")
    run({"mode": "inpaint", "source": src, "regions": [[0.8, 1.4]]}, "inpaint")
    run({"mode": "extend", "source": src, "extend_seconds": 1.5}, "extend")
amb = run({"params": {"prompt": "night forest ambience, crickets, light wind, no music", "duration": 6.0}}, "ambience 6s")
if amb:
    run({"mode": "loop", "source": amb[0]["id"], "loop_seam_seconds": 1.0}, "ai loop")
run({"params": {"prompt": "laser zap", "duration": 1.0, "sampler": "rk4", "seed": 42}}, "rk4")
if src:
    out = c.post("/export", json={"sources": [src], "dest_dir": sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(), "format": "mp3", "mp3_bitrate": 192}).json()
    print("export:", out["files"])
# clean up the takes this script made
for it in c.get("/history/items", params={"limit": 500}).json():
    if "engine-check" in it["tags"]:
        c.delete(f"/items/{it['id']}")
print("FAILURES:\n  " + "\n  ".join(failures) if failures else "ALL OK")
sys.exit(1 if failures else 0)
