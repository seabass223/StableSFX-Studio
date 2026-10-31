"""Game-oriented audio processing. Pure numpy/scipy (no torch), float32 ``[C, N]``."""

from __future__ import annotations

import math
from fractions import Fraction

import numpy as np
from scipy import signal

from . import audio_io
from .schema import (
    ChannelsOp, FadeOp, FilterOp, GainOp, LoopCrossfadeOp, NormalizeOp, PadOp, PitchOp,
    ProcessOp, ResampleOp, ReverseOp, StretchOp, TrimOp, TrimSilenceOp,
)


def _curve(n: int, curve: str) -> np.ndarray:
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    if curve == "exp":
        return t**2
    if curve == "log":
        return np.sqrt(t)
    if curve == "scurve":
        return (0.5 - 0.5 * np.cos(np.pi * t)).astype(np.float32)
    return t


def equal_power(n: int) -> tuple[np.ndarray, np.ndarray]:
    """Fade-in / fade-out gain pair whose squared sum is 1 (constant power)."""
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    return np.sin(t * np.pi / 2), np.cos(t * np.pi / 2)


def trim(audio: np.ndarray, sr: int, start: float, end: float | None) -> np.ndarray:
    a = max(0, int(round(start * sr)))
    b = audio.shape[1] if end is None else min(audio.shape[1], int(round(end * sr)))
    if b <= a:
        raise ValueError("trim range is empty")
    return audio[:, a:b].copy()


def trim_silence(audio: np.ndarray, sr: int, threshold_db: float, pad_ms: float, head: bool, tail: bool) -> np.ndarray:
    start, end = audio_io.silence_bounds(audio, sr, threshold_db)
    if end == 0:
        return audio
    pad = int(pad_ms * sr / 1000)
    a = max(0, start - pad) if head else 0
    b = min(audio.shape[1], end + pad) if tail else audio.shape[1]
    return audio[:, a:b].copy()


def normalize(audio: np.ndarray, sr: int, mode: str, target: float) -> np.ndarray:
    peak = float(np.abs(audio).max())
    if peak <= 1e-9:
        return audio
    if mode == "peak":
        gain_db = target - audio_io.db(peak)
    else:
        loud = audio_io.loudness_lufs(audio, sr)
        if loud is None:  # too short for gated LUFS: approximate with RMS
            loud = audio_io.db(float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))))
        gain_db = target - loud
    out = audio * np.float32(10 ** (gain_db / 20))
    # Never clip: keep at least 0.3 dB of headroom.
    ceiling = 10 ** (-0.3 / 20)
    new_peak = float(np.abs(out).max())
    if new_peak > ceiling:
        out *= np.float32(ceiling / new_peak)
    return out


def fade(audio: np.ndarray, sr: int, ms: float, curve: str, direction: str) -> np.ndarray:
    n = min(audio.shape[1], max(1, int(ms * sr / 1000)))
    out = audio.copy()
    g = _curve(n, curve)
    if direction == "in":
        out[:, :n] *= g
    else:
        out[:, -n:] *= g[::-1]
    return out


def loop_crossfade(audio: np.ndarray, sr: int, ms: float) -> np.ndarray:
    """Make a clip loop seamlessly by crossfading its tail into its head (length shrinks by the fade)."""
    n = audio.shape[1]
    x = min(int(ms * sr / 1000), n // 3)
    if x < 2:
        return audio
    fin, fout = equal_power(x)
    out = audio[:, : n - x].copy()
    out[:, :x] = audio[:, :x] * fin + audio[:, n - x :] * fout
    return out


def _resample_ratio(audio: np.ndarray, ratio: float) -> np.ndarray:
    """Resample by ``ratio`` (output_len ~= input_len * ratio)."""
    frac = Fraction(ratio).limit_denominator(1000)
    return signal.resample_poly(audio, frac.numerator, frac.denominator, axis=1).astype(np.float32)


def resample(audio: np.ndarray, sr: int, new_sr: int) -> np.ndarray:
    if new_sr == sr:
        return audio
    g = math.gcd(sr, new_sr)
    return signal.resample_poly(audio, new_sr // g, sr // g, axis=1).astype(np.float32)


def time_stretch(audio: np.ndarray, factor: float, n_fft: int = 2048, hop: int = 512) -> np.ndarray:
    """Phase-vocoder time stretch; factor > 1 makes the clip longer. Pitch is preserved."""
    if abs(factor - 1.0) < 1e-4:
        return audio
    window = np.hanning(n_fft).astype(np.float32)
    out_channels = []
    for ch in audio:
        padded = np.pad(ch, (n_fft, n_fft))
        frames = np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop] * window
        spec = np.fft.rfft(frames, axis=1)
        steps = np.arange(0, spec.shape[0] - 1, 1.0 / factor)
        omega = 2 * np.pi * hop * np.arange(spec.shape[1]) / n_fft
        phase = np.angle(spec[0])
        out_frames = np.empty((len(steps), n_fft), dtype=np.float32)
        for k, s in enumerate(steps):
            i = int(s)
            frac = s - i
            mag = (1 - frac) * np.abs(spec[i]) + frac * np.abs(spec[i + 1])
            out_frames[k] = np.fft.irfft(mag * np.exp(1j * phase), n=n_fft) * window
            dphi = np.angle(spec[i + 1]) - np.angle(spec[i]) - omega
            dphi -= 2 * np.pi * np.round(dphi / (2 * np.pi))
            phase += omega + dphi
        length = (len(steps) - 1) * hop + n_fft
        y = np.zeros(length, dtype=np.float32)
        norm = np.zeros(length, dtype=np.float32)
        for k in range(len(steps)):
            y[k * hop : k * hop + n_fft] += out_frames[k]
            norm[k * hop : k * hop + n_fft] += window**2
        y /= np.maximum(norm, 1e-6)
        target = int(round(ch.shape[0] * factor))
        out_channels.append(y[n_fft : n_fft + target])
    n = min(len(c) for c in out_channels)
    return np.stack([c[:n] for c in out_channels]).astype(np.float32)


def pitch(audio: np.ndarray, semitones: float, preserve_length: bool) -> np.ndarray:
    if abs(semitones) < 1e-4:
        return audio
    ratio = 2 ** (semitones / 12)
    if preserve_length:
        audio = time_stretch(audio, ratio)
    return _resample_ratio(audio, 1 / ratio)


def biquad(audio: np.ndarray, sr: int, kind: str, freq: float, q: float) -> np.ndarray:
    freq = min(max(freq, 10.0), sr / 2 * 0.99)
    w0 = 2 * np.pi * freq / sr
    alpha = np.sin(w0) / (2 * max(q, 0.05))
    cos = np.cos(w0)
    if kind == "lowpass":
        b = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
    else:
        b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
    a = [1 + alpha, -2 * cos, 1 - alpha]
    return signal.lfilter(b, a, audio, axis=1).astype(np.float32)


def apply(audio: np.ndarray, sr: int, op: ProcessOp) -> tuple[np.ndarray, int]:
    if isinstance(op, TrimOp):
        return trim(audio, sr, op.start, op.end), sr
    if isinstance(op, TrimSilenceOp):
        return trim_silence(audio, sr, op.threshold_db, op.pad_ms, op.head, op.tail), sr
    if isinstance(op, NormalizeOp):
        return normalize(audio, sr, op.mode, op.target), sr
    if isinstance(op, FadeOp):
        return fade(audio, sr, op.ms, op.curve, "in" if op.op == "fade_in" else "out"), sr
    if isinstance(op, ReverseOp):
        return audio[:, ::-1].copy(), sr
    if isinstance(op, GainOp):
        return audio * np.float32(10 ** (op.db / 20)), sr
    if isinstance(op, LoopCrossfadeOp):
        return loop_crossfade(audio, sr, op.ms), sr
    if isinstance(op, PitchOp):
        return pitch(audio, op.semitones, op.preserve_length), sr
    if isinstance(op, StretchOp):
        return time_stretch(audio, op.factor), sr
    if isinstance(op, ChannelsOp):
        if op.op == "mono":
            return audio.mean(axis=0, keepdims=True), sr
        return (np.repeat(audio, 2, axis=0) if audio.shape[0] == 1 else audio), sr
    if isinstance(op, ResampleOp):
        return resample(audio, sr, op.sample_rate), op.sample_rate
    if isinstance(op, FilterOp):
        return biquad(audio, sr, op.op, op.freq_hz, op.q), sr
    if isinstance(op, PadOp):
        head = np.zeros((audio.shape[0], int(op.head_ms * sr / 1000)), dtype=np.float32)
        tail = np.zeros((audio.shape[0], int(op.tail_ms * sr / 1000)), dtype=np.float32)
        return np.concatenate([head, audio, tail], axis=1), sr
    raise ValueError(f"unknown op {op!r}")


def apply_all(audio: np.ndarray, sr: int, ops: list[ProcessOp]) -> tuple[np.ndarray, int]:
    for op in ops:
        audio, sr = apply(audio, sr, op)
    return np.ascontiguousarray(audio, dtype=np.float32), sr


def composite(original: np.ndarray, generated: np.ndarray, regions: list[tuple[int, int]], xfade: int) -> np.ndarray:
    """Original audio outside ``regions`` (frame ranges), generated audio inside, joined by
    equal-power crossfades of ``xfade`` frames that sit just outside each region."""
    n = generated.shape[1]
    orig = np.zeros_like(generated)
    m = min(n, original.shape[1])
    orig[:, :m] = original[:, :m]
    w = np.zeros(n, dtype=np.float32)  # 1 = generated; linear here, equal-power below
    fin = np.linspace(0.0, 1.0, max(xfade, 1), dtype=np.float32)
    for a, b in regions:
        a, b = max(0, a), min(n, b)
        w[a:b] = 1.0
        lo = max(0, a - xfade)
        w[lo:a] = np.maximum(w[lo:a], fin[xfade - (a - lo) :])
        hi = min(n, b + xfade)
        w[b:hi] = np.maximum(w[b:hi], fin[::-1][: hi - b])
    w[m:] = 1.0  # beyond the original (extend): always generated
    g = np.where(w <= 0, 0.0, np.sin(w * np.pi / 2)).astype(np.float32)
    o = np.where(w >= 1, 0.0, np.cos(w * np.pi / 2)).astype(np.float32)
    return (generated * g + orig * o).astype(np.float32)
