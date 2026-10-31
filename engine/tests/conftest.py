import json
import os

import numpy as np
import pytest


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """Isolated ~/.stablesfx and library for each test."""
    h = tmp_path / "home"
    lib = tmp_path / "Library"
    h.mkdir()
    (h / "config.json").write_text(json.dumps({"library_path": str(lib)}), encoding="utf-8")
    monkeypatch.setenv("STABLESFX_HOME", str(h))
    monkeypatch.setenv("STABLESFX_FAKE_STEP_DELAY", "0.001")
    return h


@pytest.fixture()
def tone():
    sr = 44100
    t = np.arange(int(sr * 1.0)) / sr
    mono = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    return np.stack([mono, mono]), sr
