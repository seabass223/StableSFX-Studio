import pytest
import os
import time

import numpy as np

from stablesfx_engine.library import History, Library, resolve_source, safe_folder, slugify


def test_slugify_strips_prefix_and_stopwords():
    assert slugify("TrackType: SFX, A heavy wooden door slam in the hall") == "heavy_wooden_door_slam"
    assert slugify("") == "sfx"


def test_safe_folder_cannot_escape():
    assert safe_folder("../../etc") == "etc"
    assert safe_folder("Weapons\\Lasers/") == "Weapons/Lasers"


def test_save_list_move_and_backfill(tmp_path, tone):
    audio, sr = tone
    lib = Library(tmp_path / "lib")
    lib.ensure_layout()
    a = lib.save_audio(audio, sr, "Inbox", "laser_zap", {"prompt": "laser zap", "seed": 3})
    b = lib.save_audio(audio, sr, "Inbox", "laser_zap", {"prompt": "laser zap", "seed": 4})
    assert a.name == "laser_zap_001" and b.name == "laser_zap_002"
    assert a.stats.duration == 1.0 and a.peaks and a.uid
    assert {i.id for i in lib.list(query="zap")} == {a.id, b.id}
    moved = lib.move(a.id, "Weapons/Lasers", "pew")
    assert moved.folder == "Weapons/Lasers" and moved.prompt == "laser zap"
    tree = lib.tree()
    assert any(c.name == "Weapons" for c in tree.children)
    # a file dropped in by hand gets a sidecar on first sight
    from stablesfx_engine import audio_io

    audio_io.write(lib.root / "Inbox" / "manual.wav", audio, sr)
    manual = next(i for i in lib.list() if i.name == "manual")
    assert manual.stats and (lib.root / "Inbox" / "manual.sfx.json").exists()


def test_history_prune_by_age(tmp_path, tone):
    audio, sr = tone
    hist = History(tmp_path / "hist")
    old = hist.save_audio(audio, sr, "2020-01-01", "old", {})
    new = hist.save_audio(audio, sr, hist.day_folder(), "new", {})
    past = time.time() - 30 * 86400
    os.utime(old.path, (past, past))
    assert hist.prune(retention_days=14, max_gb=10) == 1
    assert [i.id for i in hist.list()] == [new.id]


def test_resolve_source_variants(tmp_path, tone):
    audio, sr = tone
    lib = Library(tmp_path / "lib")
    hist = History(tmp_path / "hist")
    item = lib.save_audio(audio, sr, "Inbox", "boom", {"prompt": "boom"})
    for ref in (item.id, "Inbox/boom_001.wav", item.path):
        path, sidecar, found = resolve_source(ref, lib, hist)
        assert found and found.id == item.id and sidecar["prompt"] == "boom"


def test_store_behind_junction(tmp_path, tone):
    # ~\.stablesfx is often a junction to another drive: item ids must stay relative to the store.
    _winapi = pytest.importorskip("_winapi")
    audio, sr = tone
    real = tmp_path / "real"
    (real / "history").mkdir(parents=True)
    _winapi.CreateJunction(str(real), str(tmp_path / "link"))
    hist = History(tmp_path / "link" / "history")
    item = hist.save_audio(audio, sr, hist.day_folder(), "zap", {"prompt": "zap"})
    assert hist.get(item.id).id == item.id
    assert hist.path_for(item.id).exists()
