import numpy as np
import pytest

from stablesfx_engine import audio_io, dsp
from stablesfx_engine.schema import FadeOp, NormalizeOp, PitchOp, StretchOp, TrimOp, TrimSilenceOp


def test_fade_in_out_shapes(tone):
    audio, sr = tone
    out, _ = dsp.apply(audio, sr, FadeOp(op="fade_in", ms=100))
    assert out[0, 0] == 0
    assert np.allclose(out[:, int(0.2 * sr):], audio[:, int(0.2 * sr):])
    out, _ = dsp.apply(audio, sr, FadeOp(op="fade_out", ms=100, curve="scurve"))
    assert abs(out[0, -1]) < 1e-6


@pytest.mark.parametrize("target", [-1.0, -6.0])
def test_normalize_peak(tone, target):
    audio, sr = tone
    out, _ = dsp.apply(audio, sr, NormalizeOp(mode="peak", target=target))
    assert audio_io.db(float(np.abs(out).max())) == pytest.approx(target, abs=0.05)


def test_normalize_never_clips(tone):
    audio, sr = tone
    out, _ = dsp.apply(audio, sr, NormalizeOp(mode="lufs", target=0.0))
    assert np.abs(out).max() <= 10 ** (-0.3 / 20) + 1e-6


def test_trim_and_trim_silence(tone):
    audio, sr = tone
    padded = np.concatenate([np.zeros((2, sr // 2), np.float32), audio, np.zeros((2, sr // 2), np.float32)], axis=1)
    out, _ = dsp.apply(padded, sr, TrimSilenceOp(pad_ms=0))
    assert out.shape[1] == pytest.approx(audio.shape[1], abs=sr * 0.01)
    out, _ = dsp.apply(audio, sr, TrimOp(start=0.25, end=0.75))
    assert out.shape[1] == sr // 2


def test_loop_crossfade_is_seamless():
    sr = 44100
    rng = np.random.default_rng(0)
    # A slowly varying signal: the loop seam must not jump more than neighbouring samples do.
    sig = np.cumsum(rng.standard_normal(sr * 2)).astype(np.float32)
    sig = (sig / np.abs(sig).max() * 0.8)[None].repeat(2, 0)
    out = dsp.loop_crossfade(sig, sr, 250)
    assert out.shape[1] == sig.shape[1] - int(0.25 * sr)
    seam_jump = abs(out[0, -1] - out[0, 0])
    typical = np.abs(np.diff(out[0])).max()
    assert seam_jump <= typical * 1.5


def test_pitch_varispeed_and_stretch_lengths(tone):
    audio, sr = tone
    up, _ = dsp.apply(audio, sr, PitchOp(semitones=12))
    assert up.shape[1] == pytest.approx(audio.shape[1] / 2, rel=0.01)
    kept, _ = dsp.apply(audio, sr, PitchOp(semitones=5, preserve_length=True))
    assert kept.shape[1] == pytest.approx(audio.shape[1], rel=0.02)
    long, _ = dsp.apply(audio, sr, StretchOp(factor=1.5))
    assert long.shape[1] == pytest.approx(audio.shape[1] * 1.5, rel=0.01)


def test_composite_keeps_original_outside_regions(tone):
    audio, sr = tone
    gen = np.zeros_like(audio)
    out = dsp.composite(audio, gen, [(sr // 4, sr // 2)], xfade=int(0.02 * sr))
    assert np.allclose(out[:, : sr // 4 - int(0.02 * sr)], audio[:, : sr // 4 - int(0.02 * sr)])
    assert np.allclose(out[:, sr // 4 : sr // 2], 0)
    assert np.allclose(out[:, sr // 2 + int(0.02 * sr) :], audio[:, sr // 2 + int(0.02 * sr) :])


@pytest.mark.parametrize("fmt,bits", [("wav", 16), ("wav", 24), ("wav", 32), ("flac", 16), ("flac", 24), ("mp3", 16)])
def test_write_roundtrip(tmp_path, tone, fmt, bits):
    audio, sr = tone
    path = audio_io.write(tmp_path / f"x.{fmt}", audio, sr, fmt, bits, 192, title="t", comment="prompt")
    back, sr2 = audio_io.load(path)
    assert sr2 == sr and back.shape[0] == 2
    assert back.shape[1] == pytest.approx(audio.shape[1], rel=0.05)


def test_mp3_bitrate_controls_size(tmp_path, tone):
    audio, sr = tone
    hi = audio_io.write(tmp_path / "hi.mp3", audio, sr, "mp3", mp3_bitrate=320)
    lo = audio_io.write(tmp_path / "lo.mp3", audio, sr, "mp3", mp3_bitrate=96)
    assert hi.stat().st_size > lo.stat().st_size * 2
