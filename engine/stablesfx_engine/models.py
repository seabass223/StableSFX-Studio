"""Model catalog, generation backends (real Stable Audio 3 and a fake for tests/UI dev),
HF downloads, and the ModelManager that keeps at most one model resident."""

from __future__ import annotations

import contextlib
import gc
import hashlib
import io
import json
import math
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .schema import LoraSpec, ModelDefaults, ModelId, ModelInfo, ShiftParams

SAMPLE_RATE = 44100
LATENT_HOP = 4096  # samples per latent frame (SAME autoencoders)

_CATALOG: dict[str, dict[str, Any]] = {
    "small-sfx": {"label": "SA3 Small SFX", "kind": "sfx", "distilled": True, "max": 120.0},
    "small-music": {"label": "SA3 Small Music", "kind": "music", "distilled": True, "max": 120.0},
    "medium": {"label": "SA3 Medium", "kind": "general", "distilled": True, "max": 380.0},
    "small-sfx-base": {"label": "SA3 Small SFX (base)", "kind": "sfx", "distilled": False, "max": 120.0},
    "small-music-base": {"label": "SA3 Small Music (base)", "kind": "music", "distilled": False, "max": 120.0},
    "medium-base": {"label": "SA3 Medium (base)", "kind": "general", "distilled": False, "max": 380.0},
}
_FILES = ["model_config.json", "model.safetensors"]
_TEXT_ENCODER = "t5gemma-b-b-ul2"


def repo_id(model: str) -> str:
    return f"stabilityai/stable-audio-3-{model}"


def defaults_for(model: str) -> ModelDefaults:
    c = _CATALOG[model]
    if c["distilled"]:
        return ModelDefaults(steps=8, cfg_scale=1.0, sampler="pingpong", max_duration=c["max"])
    return ModelDefaults(steps=50, cfg_scale=7.0, sampler="euler", max_duration=c["max"])


def _cached(repo: str, filename: str) -> str | None:
    from huggingface_hub import try_to_load_from_cache

    path = try_to_load_from_cache(repo, filename)
    return path if isinstance(path, str) and os.path.exists(path) else None


def _encoder_repos(config_path: str | None, own_repo: str) -> list[str]:
    """Repos whose text-encoder subfolder a model config references (base models borrow one)."""
    repos = {own_repo}
    if config_path:
        try:
            cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))

            def walk(node: Any) -> None:
                if isinstance(node, dict):
                    if isinstance(node.get("repo_id"), str) and "stable-audio-3" in node["repo_id"]:
                        repos.add(node["repo_id"])
                    for v in node.values():
                        walk(v)
                elif isinstance(node, list):
                    for v in node:
                        walk(v)

            walk(cfg)
        except (OSError, ValueError):
            pass
    return sorted(repos)


def flash_attn_available() -> bool:
    import importlib.util

    return importlib.util.find_spec("flash_attn") is not None


def model_info(model: str, loaded: str | None, fake: bool = False) -> ModelInfo:
    c = _CATALOG[model]
    repo = repo_id(model)
    cfg = None if fake else _cached(repo, "model_config.json")
    weights = None if fake else _cached(repo, "model.safetensors")
    size = 0
    downloaded = fake or bool(cfg and weights)
    if weights:
        size += os.path.getsize(weights)
        enc = _cached(repo, f"{_TEXT_ENCODER}/model.safetensors")
        if enc:
            size += os.path.getsize(enc)
    note = None
    if model.startswith("medium") and not fake and not flash_attn_available():
        note = "Runs without flash-attn (PyTorch SDPA fallback, bf16 by default)"
    return ModelInfo(
        id=model, label=c["label"], kind=c["kind"], distilled=c["distilled"], repo_id=repo,
        license_url=f"https://huggingface.co/{repo}", defaults=defaults_for(model),
        downloaded=downloaded, size_bytes=size, loaded=(loaded == model), note=note,
    )


class GatedModelError(RuntimeError):
    def __init__(self, model: str):
        super().__init__(
            f"{model} is gated on Hugging Face. Accept the license at https://huggingface.co/{repo_id(model)} "
            "(logged in as the account whose token is saved locally), then retry."
        )
        self.model = model


def download(model: str, progress: Callable[[int, int], None] | None = None) -> None:
    """Download weights + text encoder into the standard HF cache, reporting bytes."""
    from huggingface_hub import HfApi, hf_hub_download, snapshot_download
    from huggingface_hub.errors import GatedRepoError, HfHubHTTPError

    repo = repo_id(model)
    try:
        cfg_path = hf_hub_download(repo, "model_config.json")
        repos = _encoder_repos(cfg_path, repo)
        api = HfApi()
        plan: list[tuple[str, list[str]]] = []
        total = 0
        for r in repos:
            patterns = [f"{_TEXT_ENCODER}/*"] + (_FILES if r == repo else [])
            info = api.model_info(r, files_metadata=True)
            for s in info.siblings or []:
                if any(s.rfilename == p or (p.endswith("/*") and s.rfilename.startswith(p[:-1])) for p in patterns):
                    total += s.size or 0
            plan.append((r, patterns))

        stop = threading.Event()

        def poll() -> None:
            from huggingface_hub.constants import HF_HUB_CACHE

            while not stop.wait(0.5):
                done = 0
                for r, _ in plan:
                    # Real files only: blobs (+ .incomplete) with symlinks, snapshot copies without
                    # (Windows without Developer Mode); symlinks themselves are skipped.
                    folder = Path(HF_HUB_CACHE) / ("models--" + r.replace("/", "--"))
                    for dirpath, _dirs, files in os.walk(folder):
                        for f in files:
                            p = os.path.join(dirpath, f)
                            if not os.path.islink(p):
                                try:
                                    done += os.path.getsize(p)
                                except OSError:
                                    pass
                if progress:
                    progress(min(done, total), total)

        poller = threading.Thread(target=poll, daemon=True)
        poller.start()
        try:
            for r, patterns in plan:
                snapshot_download(r, allow_patterns=patterns)
        finally:
            stop.set()
        if progress:
            progress(total, total)
    except GatedRepoError as e:
        raise GatedModelError(model) from e
    except HfHubHTTPError as e:
        if getattr(e.response, "status_code", None) in (401, 403):
            raise GatedModelError(model) from e
        raise


def delete_cache(model: str) -> int:
    from huggingface_hub import scan_cache_dir

    info = scan_cache_dir()
    hashes = [rev.commit_hash for repo in info.repos if repo.repo_id == repo_id(model) for rev in repo.revisions]
    if not hashes:
        return 0
    strategy = info.delete_revisions(*hashes)
    strategy.execute()
    return strategy.expected_freed_size


@contextlib.contextmanager
def _hf_offline(enabled: bool):
    """Skip HF's per-file online revalidation (tens of seconds) when weights are cached."""
    if not enabled:
        yield
        return
    from huggingface_hub import constants

    old_env, old_const = os.environ.get("HF_HUB_OFFLINE"), constants.HF_HUB_OFFLINE
    os.environ["HF_HUB_OFFLINE"] = "1"
    constants.HF_HUB_OFFLINE = True
    try:
        yield
    finally:
        constants.HF_HUB_OFFLINE = old_const
        if old_env is None:
            os.environ.pop("HF_HUB_OFFLINE", None)
        else:
            os.environ["HF_HUB_OFFLINE"] = old_env


# --------------------------------------------------------------------------- backends


class Cancelled(Exception):
    pass


@dataclass
class GenerateCall:
    prompt: str
    negative_prompt: str
    duration: float
    steps: int
    cfg_scale: float
    seed: int
    sampler: str
    apg_scale: float = 1.0
    cfg_interval: tuple[float, float] = (0.0, 1.0)
    cfg_rescale: float = 0.0
    cfg_norm_threshold: float = 0.0
    duration_padding: float = 6.0
    chunked_decode: bool | None = None
    shift: ShiftParams = field(default_factory=ShiftParams)
    init_audio: tuple[np.ndarray, int] | None = None
    init_noise_level: float = 1.0
    inpaint_audio: tuple[np.ndarray, int] | None = None
    regions: list[tuple[float, float]] | None = None
    loras: list[LoraSpec] = field(default_factory=list)
    callback: Callable[[int], None] | None = None  # called with the step index


class RealBackend:
    """Wraps ``stable_audio_3.StableAudioModel``."""

    def __init__(self, model: str, device: str, precision: str, loras: list[LoraSpec], log: Callable[[str], None]):
        import importlib.util

        import torch

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), _hf_offline(model_info(model, None).downloaded):
            from stable_audio_3 import StableAudioModel
            import stable_audio_3.models.transformer as sa_transformer

            if importlib.util.find_spec("triton") is None:
                # Without Triton, torch.compile(flex_attention) fails and dynamo silently runs flex
                # attention eagerly (slow, memory hungry). Force upstream's chunked-SDPA fallback.
                sa_transformer.flex_attention_compiled = None
            self.sa = StableAudioModel.from_pretrained(model, device=device, model_half=(precision == "fp16"))
            if precision == "bf16":
                self.sa.model.to(torch.bfloat16)
            if loras:
                self.sa.load_lora([l.path for l in loras])
        for line in buf.getvalue().splitlines():
            log(line)
        self.model = model
        self.device = device
        self.precision = precision
        self.lora_paths = tuple(l.path for l in loras)
        self.sample_rate = int(self.sa.model.sample_rate)
        self.sample_size = int(self.sa.model_config["sample_size"])
        self.max_duration = self.sample_size / self.sample_rate
        self._torch = torch

    def generate(self, call: GenerateCall) -> np.ndarray:
        torch = self._torch
        from .shift import build_shift

        sigma_max = call.init_noise_level if call.init_audio is not None else 1.0
        # The models diverge (latents explode into full-scale noise) when seconds_total is
        # fractional, e.g. 0.8 or 1.2 s; whole seconds are stable. Condition on whole seconds
        # and let generate() truncate the output to the requested duration.
        cond_seconds = conditioning_seconds(call.duration)
        conditioning = [{"prompt": call.prompt, "seconds_total": cond_seconds}]
        negative = [{"prompt": call.negative_prompt, "seconds_total": cond_seconds}] if call.negative_prompt else None
        kwargs: dict[str, Any] = dict(
            conditioning=conditioning,
            negative_conditioning=negative,
            duration=float(call.duration),
            steps=int(call.steps),
            cfg_scale=float(call.cfg_scale),
            seed=int(call.seed),
            sample_size=self.sample_size,
            duration_padding_sec=float(call.duration_padding),
            apg_scale=float(call.apg_scale),
            chunked_decode=call.chunked_decode,
            dist_shift=build_shift(call.shift, self.sa.model.sampling_dist_shift, sigma_max),
            sampler_type=call.sampler,
            cfg_interval=tuple(call.cfg_interval),
            scale_phi=float(call.cfg_rescale),
            cfg_norm_threshold=float(call.cfg_norm_threshold),
            disable_tqdm=True,
        )
        if call.callback:
            cb = call.callback
            kwargs["callback"] = lambda d: cb(int(d["i"]))
        if call.init_audio is not None:
            a, sr = call.init_audio
            kwargs["init_audio"] = (sr, torch.from_numpy(np.ascontiguousarray(a)))
            kwargs["init_noise_level"] = float(call.init_noise_level)
        if call.inpaint_audio is not None:
            a, sr = call.inpaint_audio
            kwargs["inpaint_audio"] = (sr, torch.from_numpy(np.ascontiguousarray(a)))
            if call.regions:
                kwargs["inpaint_mask_start_seconds"] = [float(s) for s, _ in call.regions]
                kwargs["inpaint_mask_end_seconds"] = [float(e) for _, e in call.regions]
        if call.loras:
            for i, l in enumerate(call.loras):
                self.sa.set_lora_strength(float(l.strength), lora_index=i)
            kwargs["lora_configs"] = [
                {"lora_index": i, "interval": tuple(l.interval), "layer_filter": l.layer_filter}
                for i, l in enumerate(call.loras)
            ]
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                out = self.sa.generate(**kwargs)
            audio = out[0].float().cpu().numpy()
            if not np.isfinite(audio).all():
                raise RuntimeError(
                    f"the model produced NaN/Inf at {self.precision} precision (numeric overflow); "
                    "set Settings > Engine > Precision to fp32 or bf16"
                )
            return audio
        finally:
            if self.device == "cuda":
                torch.cuda.empty_cache()

    def close(self) -> None:
        del self.sa
        gc.collect()
        if self.device == "cuda":
            self._torch.cuda.empty_cache()


class FakeBackend:
    """Deterministic synthetic audio with real progress/cancel behaviour (no torch)."""

    def __init__(self, model: str, device: str, precision: str, loras: list[LoraSpec], log: Callable[[str], None]):
        self.model = model
        self.device = device
        self.precision = precision
        self.lora_paths = tuple(l.path for l in loras)
        self.sample_rate = SAMPLE_RATE
        self.max_duration = _CATALOG[model]["max"]
        self.step_delay = float(os.environ.get("STABLESFX_FAKE_STEP_DELAY", "0.01"))

    def generate(self, call: GenerateCall) -> np.ndarray:
        for i in range(call.steps):
            if call.callback:
                call.callback(i)
            time.sleep(self.step_delay)
        sr = self.sample_rate
        n = int(call.duration * sr)
        h = int(hashlib.sha1(f"{call.prompt}|{call.seed}".encode()).hexdigest()[:8], 16)
        rng = np.random.default_rng(h)
        t = np.arange(n, dtype=np.float32) / sr
        f0 = 200 + (h % 800)
        env = np.exp(-t * (1 + (h % 5))).astype(np.float32)
        tone = np.sin(2 * np.pi * f0 * t * (1 + 0.3 * t)).astype(np.float32)
        noise = rng.standard_normal(n).astype(np.float32) * 0.2
        mono = (0.5 * tone + noise) * env
        out = np.stack([mono, np.roll(mono, 37)]).astype(np.float32) * 0.8
        src = call.inpaint_audio or call.init_audio
        if src is not None:
            a, _ = src
            m = min(n, a.shape[1])
            base = np.zeros_like(out)
            base[:, :m] = a[:2, :m] if a.shape[0] >= 2 else np.repeat(a[:1, :m], 2, axis=0)
            if call.inpaint_audio is not None:
                mask = np.zeros(n, dtype=bool)
                for s, e in call.regions or []:
                    mask[int(s * sr): int(e * sr)] = True
                if not call.regions:
                    mask[:] = True
                mask[m:] = True
                out = np.where(mask, out, base)
            else:
                k = call.init_noise_level
                out = base * (1 - k) + out * k
        return np.clip(out, -1, 1).astype(np.float32)

    def close(self) -> None:
        pass


# --------------------------------------------------------------------------- manager


class ModelManager:
    def __init__(self, fake: bool, emit: Callable[[str, dict], None], log: Callable[[str], None]):
        self.fake = fake
        self.emit = emit
        self.log = log
        self.backend: RealBackend | FakeBackend | None = None
        self.last_used = time.time()
        self._lock = threading.RLock()
        self.downloads: dict[str, dict[str, Any]] = {}

    @staticmethod
    def resolve_device(pref: str) -> str:
        if pref == "cpu":
            return "cpu"
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"

    @staticmethod
    def resolve_precision(pref: str, model: str, device: str) -> str:
        """fp16 overflows to NaN in some audio-to-audio runs, so 'auto' avoids it: fp32 for the
        small models (fastest on Ampere too), bf16 for Medium (fp32 would need ~10 GB)."""
        if device != "cuda":
            return "fp32"
        if pref != "auto":
            return pref
        if model.startswith("medium"):
            try:
                import torch

                return "bf16" if torch.cuda.is_bf16_supported() else "fp16"
            except Exception:
                return "fp16"
        return "fp32"

    def acquire(self, model: str, device_pref: str, precision_pref: str, loras: list[LoraSpec]):
        for l in loras:
            if not l.path.lower().endswith(".safetensors"):
                raise ValueError(f"LoRA must be a .safetensors file: {l.path}")
            if not os.path.isfile(l.path):
                raise FileNotFoundError(l.path)
        device = "cpu" if self.fake and device_pref == "auto" else self.resolve_device(device_pref)
        precision = self.resolve_precision(precision_pref, model, device)
        key = (model, device, precision, tuple(l.path for l in loras))
        with self._lock:
            b = self.backend
            if b is not None and (b.model, b.device, b.precision, b.lora_paths) == key:
                self.last_used = time.time()
                return b
            self.unload()
            if not self.fake and not model_info(model, None).downloaded:
                self.emit("model", {"model": model, "state": "downloading", "done": 0, "total": 0})
                download(model, lambda d, t: self.emit("model", {"model": model, "state": "downloading", "done": d, "total": t}))
            self.emit("model", {"model": model, "state": "loading"})
            t0 = time.time()
            cls = FakeBackend if self.fake else RealBackend
            self.backend = cls(model, device, precision, loras, self.log)
            self.log(f"loaded {model} on {device} ({precision}) in {time.time() - t0:.1f}s")
            self.emit("model", {"model": model, "state": "loaded", "device": device})
            self.last_used = time.time()
            return self.backend

    def unload(self) -> None:
        with self._lock:
            if self.backend is not None:
                name = self.backend.model
                self.backend.close()
                self.backend = None
                self.emit("model", {"model": name, "state": "unloaded"})
                self.log(f"unloaded {name}")

    @property
    def loaded(self) -> str | None:
        return self.backend.model if self.backend else None

    def catalog(self) -> list[ModelInfo]:
        infos = []
        for m in _CATALOG:
            info = model_info(m, self.loaded, self.fake)
            if m in self.downloads:
                info.note = self.downloads[m].get("error") or info.note
            infos.append(info)
        return infos

    def start_download(self, model: str) -> None:
        if model not in _CATALOG:
            raise KeyError(model)
        if self.downloads.get(model, {}).get("running"):
            return

        def run() -> None:
            state = self.downloads[model] = {"running": True}
            try:
                if not self.fake:
                    download(model, lambda d, t: self.emit("model", {"model": model, "state": "downloading", "done": d, "total": t}))
                self.emit("model", {"model": model, "state": "downloaded"})
            except Exception as e:  # noqa: BLE001
                state["error"] = str(e)
                self.emit("model", {"model": model, "state": "error", "error": str(e)})
            finally:
                state["running"] = False

        threading.Thread(target=run, name=f"download-{model}", daemon=True).start()


def conditioning_seconds(duration: float) -> int:
    """Whole-second seconds_total for the model (see RealBackend.generate)."""
    return max(1, math.ceil(duration - 1e-6))


def snap_regions(regions: list[tuple[float, float]], sr: int, total: float) -> list[tuple[float, float]]:
    """Snap regions outward to the latent grid (4096 samples ~ 93 ms) and merge overlaps."""
    hop = LATENT_HOP / sr
    snapped = []
    for s, e in sorted((min(a, b), max(a, b)) for a, b in regions):
        s = max(0.0, math.floor(s / hop) * hop)
        e = min(total, max(math.ceil(e / hop) * hop, s + hop))
        if snapped and s <= snapped[-1][1]:
            snapped[-1] = (snapped[-1][0], max(snapped[-1][1], e))
        else:
            snapped.append((s, e))
    return snapped
