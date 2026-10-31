"""Audio file IO, analysis and export. Audio is handled as float32 ``[channels, frames]``."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import soundfile as sf

from .schema import AudioStats

AUDIO_EXTS = {".wav", ".flac", ".mp3", ".ogg", ".aif", ".aiff"}
PEAK_BUCKETS = 160


def load(path: str | Path) -> tuple[np.ndarray, int]:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(data.T), int(sr)


def info(path: str | Path) -> sf._SoundFileInfo:
    return sf.info(str(path))


def _subtype(fmt: str, bit_depth: int) -> str:
    if fmt == "wav":
        return {16: "PCM_16", 24: "PCM_24", 32: "FLOAT"}[bit_depth]
    if fmt == "flac":
        return "PCM_16" if bit_depth == 16 else "PCM_24"
    return "MPEG_LAYER_III"


def _mp3_compression_level(bitrate_kbps: int) -> float:
    # libsndfile maps CBR compression level linearly from 320 kbps (0.0) down to 32 kbps (1.0).
    return float(min(1.0, max(0.0, (320 - bitrate_kbps) / (320 - 32))))


def write(
    path: str | Path,
    audio: np.ndarray,
    sr: int,
    fmt: str = "wav",
    bit_depth: int = 24,
    mp3_bitrate: int = 320,
    title: str | None = None,
    comment: str | None = None,
) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = np.clip(audio, -1.0, 1.0).T if fmt != "wav" or bit_depth != 32 else audio.T
    kwargs: dict = {}
    if fmt == "mp3":
        kwargs = {"bitrate_mode": "CONSTANT", "compression_level": _mp3_compression_level(mp3_bitrate)}
    tmp = path.with_name(f".{path.stem}.partial{path.suffix}")
    with sf.SoundFile(
        str(tmp), mode="w", samplerate=int(sr), channels=data.shape[1],
        format={"wav": "WAV", "flac": "FLAC", "mp3": "MP3"}[fmt], subtype=_subtype(fmt, bit_depth), **kwargs,
    ) as f:
        for attr, value in (("title", title), ("comment", comment), ("software", "StableSFX Studio")):
            if value:
                try:
                    setattr(f, attr, value[:1000])
                except Exception:
                    pass
        f.write(data)
    tmp.replace(path)
    return path


def db(x: float) -> float:
    return float(20 * math.log10(max(x, 1e-9)))


def silence_bounds(audio: np.ndarray, sr: int, threshold_db: float = -50.0) -> tuple[int, int]:
    """First/last frame whose |amplitude| exceeds the threshold (in a 5 ms window)."""
    env = np.abs(audio).max(axis=0)
    win = max(1, int(sr * 0.005))
    if env.size >= win:
        env = np.maximum.reduceat(env, np.arange(0, env.size, win)).repeat(win)[: env.size]
    above = np.nonzero(env > 10 ** (threshold_db / 20))[0]
    if above.size == 0:
        return 0, 0
    return int(above[0]), int(above[-1] + 1)


def loudness_lufs(audio: np.ndarray, sr: int) -> float | None:
    if audio.shape[1] < int(0.4 * sr):
        return None
    try:
        import pyloudnorm

        value = pyloudnorm.Meter(sr).integrated_loudness(audio.T.astype(np.float64))
        return float(value) if math.isfinite(value) else None
    except Exception:
        return None


def analyze(audio: np.ndarray, sr: int) -> AudioStats:
    frames = audio.shape[1]
    peak = float(np.abs(audio).max()) if frames else 0.0
    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))) if frames else 0.0
    start, end = silence_bounds(audio, sr)
    return AudioStats(
        duration=frames / sr,
        sample_rate=sr,
        channels=audio.shape[0],
        frames=frames,
        peak_db=round(db(peak), 2),
        rms_db=round(db(rms), 2),
        lufs=(round(v, 2) if (v := loudness_lufs(audio, sr)) is not None else None),
        head_silence=round(start / sr, 3),
        tail_silence=round((frames - end) / sr, 3) if end else round(frames / sr, 3),
    )


def peaks(audio: np.ndarray, buckets: int = PEAK_BUCKETS) -> list[float]:
    env = np.abs(audio).max(axis=0)
    if env.size == 0:
        return []
    edges = np.linspace(0, env.size, num=min(buckets, env.size) + 1).astype(int)
    return [round(float(env[a:b].max()), 3) for a, b in zip(edges[:-1], edges[1:]) if b > a]
