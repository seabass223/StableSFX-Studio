"""API tests against the fake backend (no torch, no GPU)."""

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token"


@pytest.fixture()
def client(home):
    from stablesfx_engine.core import Engine
    from stablesfx_engine.server import create_app

    engine = Engine(fake=True)
    app = create_app(engine, TOKEN)
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as c:
        c.engine = engine
        yield c


def run_job(client, body, timeout=20):
    job = client.post("/jobs", json=body).json()
    job = client.get(f"/jobs/{job['id']}/wait", params={"timeout": timeout}).json()
    assert job["state"] == "done", job.get("error")
    return job


def test_auth_required(home):
    from stablesfx_engine.core import Engine
    from stablesfx_engine.server import create_app

    c = TestClient(create_app(Engine(fake=True), TOKEN))
    assert c.get("/status").status_code == 401
    assert c.get("/status", params={"token": TOKEN}).status_code == 200


def test_text_variations_go_to_history_with_seeds(client):
    job = run_job(client, {"params": {"prompt": "laser zap", "duration": 1.0, "seed": 100}, "variations": 3})
    assert job["seeds"] == [100, 101, 102]
    assert all(r["kind"] == "history" for r in job["results"])
    r = job["results"][0]
    assert r["params"]["steps"] == 8 and r["params"]["sampler"] == "pingpong"
    assert r["stats"]["duration"] == pytest.approx(1.0, abs=0.01)
    assert len(client.get("/history/items").json()) == 3


def test_keep_process_export(client, tmp_path):
    take = run_job(client, {"params": {"prompt": "door slam", "duration": 1.5}})["results"][0]
    kept = client.post("/library/keep", json={"id": take["id"], "folder": "Doors", "tags": ["door"]}).json()
    assert kept["id"].startswith("lib:Doors/") and kept["tags"] == ["door"] and kept["prompt"] == "door slam"
    edited = client.post("/process", json={"source": kept["id"], "ops": [{"op": "fade_out", "ms": 200}, {"op": "normalize", "target": -3}]}).json()
    assert edited["kind"] == "history" and edited["parent_uid"] == kept["uid"] and len(edited["ops"]) == 2
    for fmt in ("wav", "flac", "mp3"):
        res = client.post("/export", json={"sources": [kept["id"]], "dest_dir": str(tmp_path / "out"), "format": fmt, "channels": 1, "sample_rate": 48000}).json()
        assert Path(res["files"][0]).suffix == f".{fmt}"
        import soundfile as sf

        info = sf.info(res["files"][0])
        assert info.samplerate == 48000 and info.channels == 1


def test_modes_on_a_source(client):
    src = run_job(client, {"params": {"prompt": "engine hum", "duration": 3.0}})["results"][0]
    a2a = run_job(client, {"mode": "audio2audio", "source": src["id"], "strength": 0.3, "variations": 2})
    assert a2a["results"][0]["prompt"] == "engine hum"  # inherited from the source
    assert a2a["results"][0]["source_uid"] == src["uid"]
    inp = run_job(client, {"mode": "inpaint", "source": src["id"], "regions": [[1.0, 1.5]]})
    regions = inp["results"][0]["params"] and inp["request"]["regions"]
    assert regions
    ext = run_job(client, {"mode": "extend", "source": src["id"], "extend_seconds": 2.0})
    assert ext["results"][0]["stats"]["duration"] == pytest.approx(5.0, abs=0.01)
    loop = run_job(client, {"mode": "loop", "source": src["id"], "loop_seam_seconds": 0.5})
    assert loop["results"][0]["stats"]["duration"] == pytest.approx(3.0, abs=0.01)


def test_mcp_style_library_target_and_post_ops(client):
    job = run_job(client, {
        "params": {"prompt": "coin pickup", "duration": 1.0}, "target": "library", "folder": "Claude/Pickups",
        "name": "coin", "post": [{"op": "trim_silence"}, {"op": "normalize", "target": -1}], "origin": "mcp",
    })
    item = job["results"][0]
    assert item["id"] == "lib:Claude/Pickups/coin_001.wav"
    assert item["stats"]["peak_db"] == pytest.approx(-1.0, abs=0.1)
    assert client.get("/resolve", params={"ref": "Claude/Pickups/coin_001.wav"}).json()["id"] == item["id"]


def test_cancel(client, monkeypatch):
    monkeypatch.setenv("STABLESFX_FAKE_STEP_DELAY", "0.2")
    client.engine.models.unload()
    job = client.post("/jobs", json={"params": {"prompt": "long", "duration": 2.0}, "variations": 4}).json()
    time.sleep(0.5)
    client.post(f"/jobs/{job['id']}/cancel")
    job = client.get(f"/jobs/{job['id']}/wait", params={"timeout": 10}).json()
    assert job["state"] == "cancelled"


def test_presets_roundtrip(client):
    presets = client.get("/presets").json()
    assert any(p["builtin"] and p["category"] == "Weapons" for p in presets)
    saved = client.put("/presets", json={"id": "", "name": "Mine", "category": "Custom", "params": {"prompt": "x"}}).json()
    assert saved["id"].startswith("user:")
    client.delete(f"/presets/{saved['id']}")
    assert not any(p["id"] == saved["id"] for p in client.get("/presets").json())


def test_lora_must_be_safetensors(client):
    job = client.post("/jobs", json={"params": {"prompt": "x", "duration": 0.5, "loras": [{"path": "C:/x.ckpt"}]}}).json()
    job = client.get(f"/jobs/{job['id']}/wait", params={"timeout": 10}).json()
    assert job["state"] == "error" and "safetensors" in job["error"]
