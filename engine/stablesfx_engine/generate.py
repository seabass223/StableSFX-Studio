"""Turns a JobRequest into backend calls for each mode (text, audio2audio, inpaint,
extend, loop) and post-processes the results."""

from __future__ import annotations

import random
import re
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from . import dsp
from .models import _CATALOG, GenerateCall, conditioning_seconds, defaults_for, snap_regions
from .schema import GenerateParams, JobRequest

SFX_PREFIX = "TrackType: SFX, "
_HAS_TRACKTYPE = re.compile(r"^\s*TrackType\s*:", re.I)
XFADE_SECONDS = 0.02
CUT_FADE_MS = 10.0


@dataclass
class Source:
    audio: np.ndarray  # [C, N] at the backend sample rate, stereo
    sr: int
    sidecar: dict[str, Any]
    uid: str | None
    path: str


@dataclass
class Take:
    audio: np.ndarray
    sr: int
    seed: int
    meta: dict[str, Any]  # sidecar fields describing how it was made


def model_prompt(params: GenerateParams) -> str:
    prompt = params.prompt.strip()
    if params.sfx_prefix and _CATALOG[params.model]["kind"] != "music" and not _HAS_TRACKTYPE.match(prompt):
        prompt = SFX_PREFIX + prompt
    return prompt


def resolved(params: GenerateParams) -> GenerateParams:
    d = defaults_for(params.model)
    return params.model_copy(update={
        "steps": params.steps or d.steps,
        "cfg_scale": d.cfg_scale if params.cfg_scale is None else params.cfg_scale,
        "sampler": params.sampler or d.sampler,
        "duration": min(params.duration, d.max_duration),
    })


def to_stereo(audio: np.ndarray) -> np.ndarray:
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    return audio[:2]


def prepare_source(audio: np.ndarray, sr: int, target_sr: int) -> tuple[np.ndarray, int]:
    audio = to_stereo(audio)
    if sr != target_sr:
        audio = dsp.resample(audio, sr, target_sr)
    return np.ascontiguousarray(audio, dtype=np.float32), target_sr


def plan_seeds(seed: int, count: int) -> list[int]:
    base = seed if seed >= 0 else random.randint(0, 2**31 - 1 - count)
    return [base + i for i in range(count)]


def run(
    req: JobRequest,
    backend: Any,
    source: Source | None,
    on_variation: Callable[[int, int], None],
    on_step: Callable[[int], None],
) -> list[Take]:
    p = resolved(req.params)
    if req.mode != "text" and source is None:
        raise ValueError(f"mode '{req.mode}' needs a source clip")
    if req.mode != "text" and not p.prompt.strip() and source and source.sidecar.get("prompt"):
        p = p.model_copy(update={"prompt": source.sidecar["prompt"]})
    sr = backend.sample_rate
    max_d = backend.max_duration
    seeds = plan_seeds(p.seed, req.variations)

    regions: list[tuple[float, float]] = []
    src_audio = source.audio if source else None
    duration = p.duration
    init_level = 1.0
    use_init = False
    inpaint = False

    if req.mode == "audio2audio":
        duration = min(src_audio.shape[1] / sr, max_d) if req.duration_from_source else p.duration
        use_init, init_level = True, req.strength
    elif req.mode == "inpaint":
        duration = min(src_audio.shape[1] / sr, max_d)
        if not req.regions:
            raise ValueError("inpaint needs at least one region")
        regions = snap_regions(req.regions, sr, duration)
        inpaint = True
    elif req.mode == "extend":
        src_len = src_audio.shape[1] / sr
        duration = min(src_len + req.extend_seconds, max_d)
        if duration <= src_len:
            raise ValueError(f"source is already at the model maximum ({max_d:.0f}s)")
        regions = snap_regions([(src_len, duration)], sr, duration)
        inpaint = True
    elif req.mode == "loop":
        n = src_audio.shape[1]
        src_len = n / sr
        if src_len < 1.0:
            raise ValueError("AI loop needs a clip of at least 1 second")
        seam = min(req.loop_seam_seconds, src_len / 2)
        src_audio = np.roll(src_audio, -(n // 2), axis=1)  # old end->start junction now mid-clip
        mid = (n - n // 2) / sr
        duration = min(src_len, max_d)
        regions = snap_regions([(mid - seam / 2, mid + seam / 2)], sr, duration)
        inpaint = True

    if inpaint and req.strength < 1.0:
        use_init, init_level = True, req.strength

    takes: list[Take] = []
    for i, seed in enumerate(seeds):
        on_variation(i, p.steps)
        call = GenerateCall(
            prompt=model_prompt(p), negative_prompt=p.negative_prompt, duration=duration,
            steps=p.steps, cfg_scale=p.cfg_scale, seed=seed, sampler=p.sampler,
            apg_scale=p.apg_scale, cfg_interval=p.cfg_interval, cfg_rescale=p.cfg_rescale,
            cfg_norm_threshold=p.cfg_norm_threshold, duration_padding=p.duration_padding,
            chunked_decode=p.chunked_decode, shift=p.shift, loras=p.loras, callback=on_step,
            init_audio=(src_audio, sr) if use_init else None, init_noise_level=init_level,
            inpaint_audio=(src_audio, sr) if inpaint else None, regions=regions or None,
        )
        audio = backend.generate(call)
        audio = audio[:, : int(round(duration * sr))]
        if req.mode in ("text", "audio2audio") and conditioning_seconds(duration) - duration > 0.02:
            # The model rendered a whole second; soften the cut so short one-shots don't click.
            audio = dsp.fade(audio, sr, CUT_FADE_MS, "linear", "out")
        if inpaint and req.preserve_outside:
            frames = [(int(round(s * sr)), int(round(e * sr))) for s, e in regions]
            audio = dsp.composite(src_audio, audio, frames, int(XFADE_SECONDS * sr))
        out_sr = sr
        if req.post:
            audio, out_sr = dsp.apply_all(audio, sr, list(req.post))
        meta = {
            "prompt": p.prompt,
            "negative_prompt": p.negative_prompt or None,
            "model": p.model,
            "mode": req.mode,
            "seed": seed,
            "params": p.model_copy(update={"seed": seed}).model_dump(mode="json"),
            "ops": [op.model_dump() for op in req.post],
            "origin": req.origin,
        }
        if req.mode != "text":
            meta["strength"] = req.strength if (use_init or req.mode == "audio2audio") else None
            meta["regions"] = regions or None
        if source is not None:
            meta["source"] = {"uid": source.uid, "path": source.path}
        takes.append(Take(audio=audio, sr=out_sr, seed=seed, meta=meta))
    return takes
