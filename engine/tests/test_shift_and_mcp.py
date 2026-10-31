import asyncio

import pytest


def test_strength_schedule_is_monotonic():
    torch = pytest.importorskip("torch")
    from stable_audio_3.inference.distribution_shift import DistributionShift, LogSNRShift
    from stable_audio_3.inference.sampling import build_schedule

    from stablesfx_engine.shift import StrengthAwareShift

    for inner in (LogSNRShift(rate=0, anchor_logsnr=-6.2, logsnr_end=2.0), DistributionShift(min_length=256, max_length=4096)):
        for s in (0.1, 0.3, 0.5, 0.9, 1.0):
            sched = build_schedule(8, sigma_max=s, dist_shift=StrengthAwareShift(inner, s),
                                   effective_seq_len=torch.tensor([100, 120]), fallback_seq_len=100)
            assert sched.ndim == 1, "rk4 needs a 1-D schedule"
            assert sched[0].item() == pytest.approx(s)
            assert torch.all(sched[:-1] >= sched[1:]), f"non-monotonic at s={s}: {sched.tolist()}"


def test_snap_regions():
    from stablesfx_engine.models import snap_regions

    hop = 4096 / 44100
    out = snap_regions([(0.5, 0.52), (0.51, 0.7), (2.0, 1.9)], 44100, 3.0)
    assert len(out) == 2
    for s, e in out:
        assert round(s / hop, 6).is_integer() or s == 0
        assert e - s >= hop - 1e-9


def test_mcp_tools_registered():
    from stablesfx_engine.mcp_server import server

    tools = asyncio.run(server.list_tools())
    names = {t.name for t in tools}
    assert {"generate_sfx", "modify_sfx", "inpaint_sfx", "extend_sfx", "make_loop", "process_sfx", "export_sfx",
            "list_library", "get_sfx", "organize_sfx", "delete_sfx", "list_presets", "engine_status", "wait_job"} <= names
