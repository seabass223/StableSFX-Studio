"""Timestep-schedule shift wrapper used for every real generation.

Upstream builds ``linspace(sigma_max, 0)`` and then applies a shift designed for the
full ``[0, 1]`` range. With ``sigma_max < 1`` (audio-to-audio strength) that makes the
schedule non-monotonic (e.g. 0.30 -> 0.54 -> 0.46 ...), so "strength" re-noises far
more than asked. Upstream also hands the shift a per-item length tensor, producing a
2-D schedule that the rk4 sampler iterates row-wise (zero steps). Wrapping fixes both:

    shift(t, L) = s * inner.shift(t / s, int(max(L)))
"""

from __future__ import annotations

import torch

from .schema import ShiftParams


class StrengthAwareShift:
    def __init__(self, inner, sigma_max: float = 1.0):
        self.inner = inner
        self.sigma_max = float(sigma_max)

    def shift(self, t: torch.Tensor, seq_len):
        if isinstance(seq_len, torch.Tensor):
            seq_len = int(seq_len.max().item())
        s = self.sigma_max
        if s >= 1.0:
            return self.inner.shift(t, seq_len)
        return s * self.inner.shift(t / s, seq_len)


def build_shift(params: ShiftParams, model_default, sigma_max: float) -> StrengthAwareShift:
    from stable_audio_3.inference.distribution_shift import (
        DistributionShift, FluxDistributionShift, IdentityDistributionShift, LogSNRShift,
    )

    if params.type == "default":
        inner = model_default
    elif params.type == "none":
        inner = IdentityDistributionShift()
    elif params.type == "logsnr":
        inner = LogSNRShift(
            anchor_length=params.anchor_length, anchor_logsnr=params.anchor_logsnr,
            rate=params.rate, logsnr_end=params.logsnr_end,
        )
    elif params.type == "flux":
        inner = FluxDistributionShift(
            min_length=params.min_length, max_length=params.max_length,
            alpha_min=params.alpha_min, alpha_max=params.alpha_max,
        )
    else:
        inner = DistributionShift(
            base_shift=params.base_shift, max_shift=params.max_shift,
            min_length=params.min_length, max_length=max(params.max_length, params.min_length + 1),
        )
    return StrengthAwareShift(inner, sigma_max)
