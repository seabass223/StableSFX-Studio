"""MCP server (stdio) exposing StableSFX Studio to Claude.

A thin HTTP client: it never imports torch. Each call makes sure the shared engine is
running (starting it detached if needed) so the desktop app and Claude share one model.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Literal

import httpx
from mcp.server.mcpserver import MCPServer

from . import instance

WAIT_SECONDS = 90
SPARK = "▁▂▃▄▅▆▇█"

logging.getLogger("httpx").setLevel(logging.WARNING)  # per-request INFO lines would flood Claude's MCP log

server = MCPServer(
    name="stablesfx",
    title="StableSFX Studio",
    instructions=(
        "Generate, modify and organise game sound effects with a local Stable Audio 3 engine. "
        "Files live in the user's SFX library (Documents\\StableSFX Library); results give absolute paths. "
        "Prompts work best describing source, action, decay and recording character (e.g. 'heavy wooden door "
        "slam, short room reverb, close mic'). Keep durations short and realistic: UI/impacts 0.3-2 s, actions "
        "1-5 s, ambiences 6-15 s. small-sfx (default) is the dedicated SFX model; generation takes about a second "
        "per clip on GPU. You cannot hear results: use the returned stats (peak/LUFS, leading/trailing silence, "
        "envelope sparkline) and generate several variations, then let the user pick in the app."
    ),
)


class Engine:
    def __init__(self) -> None:
        self.info: dict[str, Any] | None = None

    def _connect(self, force: bool = False) -> dict[str, Any]:
        if force or self.info is None or not instance.ping(self.info, timeout=1.0):
            self.info = instance.ensure(timeout=90)
        return self.info

    def request(self, method: str, path: str, **kwargs: Any) -> Any:
        timeout = kwargs.pop("timeout", 120)
        for attempt in range(2):
            info = self._connect(force=attempt > 0)
            try:
                r = httpx.request(
                    method, f"http://127.0.0.1:{info['port']}{path}",
                    headers={"Authorization": f"Bearer {info['token']}"},
                    timeout=timeout, **kwargs,
                )
            except httpx.TransportError:
                if attempt == 0:
                    continue
                raise
            if r.status_code >= 400:
                try:
                    detail = r.json().get("detail")
                except ValueError:
                    detail = r.text
                raise RuntimeError(f"engine error {r.status_code}: {detail}")
            return r.json()
        raise RuntimeError("engine unreachable")


engine = Engine()


def _envelope(peaks: list[float | None], width: int = 32, floor_db: float = -48.0) -> str:
    """Loudness-over-time sparkline (dB scale, 0 dBFS = full block) so Claude can 'see' attack/decay."""
    import math

    vals = [p for p in peaks if isinstance(p, (int, float)) and math.isfinite(p)]
    if not vals:
        return ""
    step = max(1, len(vals) // width)
    out = []
    for i in range(0, len(vals), step):
        peak = max(vals[i:i + step])
        db = 20 * math.log10(max(peak, 1e-6))
        level = min(1.0, max(0.0, (db - floor_db) / -floor_db))
        out.append(" " if level == 0 else SPARK[min(len(SPARK) - 1, int(level * (len(SPARK) - 1) + 0.5))])
    return "".join(out[:width])


def _summary(item: dict[str, Any]) -> dict[str, Any]:
    stats = item.get("stats") or {}
    return {
        "id": item["id"],
        "path": item["path"],
        "name": item["name"],
        "folder": item.get("folder"),
        "prompt": item.get("prompt"),
        "model": item.get("model"),
        "seed": item.get("seed"),
        "tags": item.get("tags") or [],
        "duration": round(stats.get("duration", 0), 3),
        "peak_db": stats.get("peak_db"),
        "lufs": stats.get("lufs"),
        "head_silence": stats.get("head_silence"),
        "tail_silence": stats.get("tail_silence"),
        "envelope": _envelope(item.get("peaks") or []),
    }


def _finish(job: dict[str, Any]) -> dict[str, Any]:
    if job["state"] not in ("done", "error", "cancelled"):
        job = engine.request("GET", f"/jobs/{job['id']}/wait", params={"timeout": WAIT_SECONDS}, timeout=WAIT_SECONDS + 30)
    if job["state"] == "error":
        raise RuntimeError(job.get("error") or "generation failed")
    if job["state"] != "done":
        return {
            "job_id": job["id"], "state": job["state"], "progress": round(job.get("progress", 0), 2),
            "note": "Still running (first use may download/load the model). Call wait_job with this job_id.",
        }
    return {"job_id": job["id"], "results": [_summary(i) for i in job["results"]]}


def _submit(body: dict[str, Any]) -> dict[str, Any]:
    body.setdefault("origin", "mcp")
    body.setdefault("target", "library")
    return _finish(engine.request("POST", "/jobs", json=body))


def _params(**kw: Any) -> dict[str, Any]:
    return {k: v for k, v in kw.items() if v is not None}


@server.tool()
def generate_sfx(
    prompt: str,
    duration: float = 2.0,
    variations: int = 1,
    model: Literal["small-sfx", "small-sfx-base", "small-music", "small-music-base", "medium", "medium-base"] | None = None,
    seed: int = -1,
    folder: str = "Claude",
    name: str | None = None,
    tags: list[str] | None = None,
    preset: str | None = None,
    negative_prompt: str | None = None,
    steps: int | None = None,
    cfg_scale: float | None = None,
    sampler: Literal["pingpong", "euler", "dpmpp", "rk4"] | None = None,
    sfx_prefix: bool = True,
    advanced: dict[str, Any] | None = None,
    post: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Generate sound effects from a text prompt and save them into the SFX library.

    variations: 1-16 takes with consecutive seeds. folder: library subfolder (created if needed).
    preset: a preset id or name from list_presets; explicit arguments override it.
    steps/cfg_scale/sampler default per model (distilled models: 8 steps, cfg 1, pingpong;
    -base models: 50 steps, cfg 7, euler). negative_prompt only matters when cfg_scale != 1.
    advanced: extra GenerateParams fields (apg_scale, cfg_interval, cfg_rescale,
    cfg_norm_threshold, duration_padding, chunked_decode, shift, loras).
    post: DSP ops applied after generation, e.g. [{"op":"trim_silence"},{"op":"normalize","mode":"peak","target":-1},{"op":"fade_out","ms":80}].
    """
    params: dict[str, Any] = {}
    variations_default = 1
    if preset:
        presets = engine.request("GET", "/presets")
        match = next((p for p in presets if preset.lower() in (p["id"].lower(), p["name"].lower())), None)
        if match is None:
            raise ValueError(f"unknown preset {preset!r}; see list_presets")
        params = dict(match["params"])
        variations_default = match.get("variations", 1)
    params.update(_params(
        prompt=prompt, duration=duration, model=model, seed=seed, negative_prompt=negative_prompt,
        steps=steps, cfg_scale=cfg_scale, sampler=sampler, sfx_prefix=sfx_prefix,
    ))
    params.update(advanced or {})
    return _submit({
        "mode": "text", "params": params, "variations": variations or variations_default,
        "folder": folder, "name": name, "tags": tags or [], "post": post or [],
    })


@server.tool()
def modify_sfx(
    source: str,
    strength: float = 0.4,
    prompt: str | None = None,
    variations: int = 3,
    seed: int = -1,
    model: str | None = None,
    folder: str = "Claude",
    name: str | None = None,
    duration: float | None = None,
) -> dict[str, Any]:
    """Clone or modify an existing sound (audio-to-audio). Use this to make variations of a sound
    the user likes, or to restyle it with a new prompt.

    source: library id (lib:...), library-relative path, or any absolute .wav/.flac/.mp3 path.
    strength: 0.1-0.25 = close variations (same character), ~0.4-0.6 = clearly different but related,
    0.8+ = loosely inspired. prompt defaults to the source's original prompt (needed for imported
    files without one). duration defaults to the source length.
    """
    params = _params(prompt=prompt or "", seed=seed, model=model, duration=duration)
    return _submit({
        "mode": "audio2audio", "source": source, "strength": strength, "params": params,
        "variations": variations, "duration_from_source": duration is None, "folder": folder, "name": name,
    })


@server.tool()
def inpaint_sfx(
    source: str,
    regions: list[list[float]],
    prompt: str | None = None,
    variations: int = 1,
    strength: float = 1.0,
    seed: int = -1,
    folder: str = "Claude",
    name: str | None = None,
) -> dict[str, Any]:
    """Regenerate parts of a sound while keeping the rest intact.

    regions: [[start_s, end_s], ...] (snapped to ~93 ms). strength < 1 keeps some of the original
    structure inside the regions. prompt defaults to the source's prompt.
    """
    return _submit({
        "mode": "inpaint", "source": source, "regions": [tuple(r[:2]) for r in regions],
        "strength": strength, "params": _params(prompt=prompt or "", seed=seed),
        "variations": variations, "folder": folder, "name": name,
    })


@server.tool()
def extend_sfx(
    source: str,
    seconds: float,
    prompt: str | None = None,
    variations: int = 1,
    seed: int = -1,
    folder: str = "Claude",
    name: str | None = None,
) -> dict[str, Any]:
    """Continue a sound for `seconds` more (e.g. lengthen a tail or an ambience)."""
    return _submit({
        "mode": "extend", "source": source, "extend_seconds": seconds,
        "params": _params(prompt=prompt or "", seed=seed), "variations": variations, "folder": folder, "name": name,
    })


@server.tool()
def make_loop(
    source: str,
    method: Literal["ai", "crossfade"] = "ai",
    seam_seconds: float = 0.75,
    crossfade_ms: float = 250,
    prompt: str | None = None,
    variations: int = 1,
    folder: str = "Claude",
    name: str | None = None,
) -> dict[str, Any]:
    """Make a seamlessly looping version of a sustained sound (ambience, hum, engine, fire...).

    method "ai": the clip is rotated so its seam sits mid-file and the model regenerates a
    `seam_seconds` window across it (clip must be >= 1 s). method "crossfade": classic tail-to-head
    equal-power crossfade of `crossfade_ms` (shortens the clip by that much). Export loops as WAV/FLAC.
    """
    if method == "crossfade":
        return {"result": _summary(engine.request("POST", "/process", json={
            "source": source, "ops": [{"op": "loop_crossfade", "ms": crossfade_ms}],
            "target": "library", "folder": folder, "name": name,
        }))}
    return _submit({
        "mode": "loop", "source": source, "loop_seam_seconds": seam_seconds,
        "params": _params(prompt=prompt or ""), "variations": variations, "folder": folder, "name": name,
    })


@server.tool()
def process_sfx(
    source: str,
    ops: list[dict[str, Any]],
    save: Literal["new", "replace"] = "new",
    folder: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    """Apply DSP edits. ops run in order; each is one of:
    {"op":"trim","start":s,"end":s} | {"op":"trim_silence","threshold_db":-50,"pad_ms":10}
    {"op":"normalize","mode":"peak"|"lufs","target":-1 or -16} | {"op":"fade_in"|"fade_out","ms":50,"curve":"linear|exp|log|scurve"}
    {"op":"reverse"} | {"op":"gain","db":-3} | {"op":"loop_crossfade","ms":250}
    {"op":"pitch","semitones":-3,"preserve_length":false} | {"op":"stretch","factor":1.5}
    {"op":"mono"} | {"op":"stereo"} | {"op":"resample","sample_rate":48000}
    {"op":"highpass"|"lowpass","freq_hz":200,"q":0.707} | {"op":"pad","head_ms":0,"tail_ms":100}
    save "new" writes a new library file (lineage kept); "replace" edits in place (a backup goes to History).
    """
    body = {"source": source, "ops": ops, "target": "replace" if save == "replace" else "library", "folder": folder, "name": name}
    return {"result": _summary(engine.request("POST", "/process", json=body))}


@server.tool()
def export_sfx(
    sources: list[str],
    dest_dir: str,
    format: Literal["wav", "flac", "mp3"] = "wav",
    sample_rate: int | None = None,
    bit_depth: Literal[16, 24, 32] = 16,
    channels: Literal[1, 2] | None = None,
    mp3_bitrate: int = 192,
    normalize_peak_db: float | None = None,
    normalize_lufs: float | None = None,
    name_template: str = "{name}",
    overwrite: bool = False,
) -> dict[str, Any]:
    """Export library sounds to a folder, e.g. a game project's Assets/Audio/SFX directory.

    name_template tokens: {name} {index} {seed} {folder}. Games usually want 16-bit WAV, 44.1/48 kHz,
    mono for positional 3D sounds. Normalization applies on export only (library masters are untouched).
    """
    normalize = None
    if normalize_lufs is not None:
        normalize = {"op": "normalize", "mode": "lufs", "target": normalize_lufs}
    elif normalize_peak_db is not None:
        normalize = {"op": "normalize", "mode": "peak", "target": normalize_peak_db}
    return engine.request("POST", "/export", json={
        "sources": sources, "dest_dir": dest_dir, "format": format, "sample_rate": sample_rate,
        "bit_depth": bit_depth, "channels": channels, "mp3_bitrate": mp3_bitrate, "normalize": normalize,
        "name_template": name_template, "overwrite": overwrite,
    })


@server.tool()
def list_library(folder: str | None = None, query: str | None = None, tags: list[str] | None = None, limit: int = 50) -> dict[str, Any]:
    """List/search sounds in the library (newest first). query matches name, folder, prompt, tags, model."""
    items = engine.request("GET", "/library/items", params=_params(folder=folder, q=query, tags=",".join(tags) if tags else None, limit=limit))
    tree = engine.request("GET", "/library/tree")
    folders = []

    def walk(node: dict[str, Any]) -> None:
        if node["path"]:
            folders.append(f"{node['path']} ({node['count']})")
        for c in node["children"]:
            walk(c)

    walk(tree)
    return {"library": engine.request("GET", "/status")["library_path"], "folders": folders, "items": [_summary(i) for i in items]}


@server.tool()
def get_sfx(source: str) -> dict[str, Any]:
    """Full metadata for one sound: prompt, model, seed, every generation parameter, edit history and stats."""
    item = engine.request("GET", "/resolve", params={"ref": source})
    out = _summary(item)
    out.update({k: item.get(k) for k in ("params", "ops", "mode", "origin", "created", "source_uid", "parent_uid", "uid")})
    out["stats"] = item.get("stats")
    return out


@server.tool()
def organize_sfx(
    source: str,
    folder: str | None = None,
    name: str | None = None,
    tags: list[str] | None = None,
    add_tags: list[str] | None = None,
    starred: bool | None = None,
) -> dict[str, Any]:
    """Move/rename a library sound, or set its tags/star. History takes are copied into the library first."""
    item = engine.request("GET", "/resolve", params={"ref": source})
    if item["kind"] == "history":
        item = engine.request("POST", "/library/keep", json={"id": item["id"], "folder": folder or "Claude", "name": name})
        folder = name = None
    elif item["kind"] == "external":
        item = engine.request("POST", "/library/import", json={"paths": [item["path"]], "folder": folder or "Imported"})[0]
        folder = None
    if add_tags:
        tags = sorted(set(item.get("tags") or []) | set(add_tags))
    patch = _params(folder=folder, name=name, tags=tags, starred=starred)
    if patch:
        item = engine.request("PATCH", f"/items/{item['id']}", json=patch)
    return _summary(item)


@server.tool()
def delete_sfx(source: str) -> dict[str, Any]:
    """Delete a library sound (moved to the Windows Recycle Bin, together with its metadata sidecar)."""
    item = engine.request("GET", "/resolve", params={"ref": source})
    engine.request("DELETE", f"/items/{item['id']}")
    return {"deleted": item["path"]}


@server.tool()
def list_presets(category: str | None = None) -> dict[str, Any]:
    """Built-in and user presets (game SFX categories) usable with generate_sfx(preset=...)."""
    presets = engine.request("GET", "/presets")
    return {"presets": [
        {"id": p["id"], "name": p["name"], "category": p["category"], "prompt": p["params"]["prompt"],
         "duration": p["params"]["duration"], "variations": p["variations"]}
        for p in presets if not category or p["category"].lower() == category.lower()
    ]}


@server.tool()
def engine_status() -> dict[str, Any]:
    """Engine device/VRAM, loaded model and which models are downloaded."""
    status = engine.request("GET", "/status")
    deadline = time.time() + 30
    while not status.get("ready") and not status.get("error") and time.time() < deadline:
        time.sleep(0.5)  # torch import / CUDA init right after a cold start
        status = engine.request("GET", "/status")
    models = engine.request("GET", "/models")
    status["models"] = [{k: m[k] for k in ("id", "label", "kind", "downloaded", "loaded", "note")} for m in models]
    return status


@server.tool()
def wait_job(job_id: str, timeout: float = 90) -> dict[str, Any]:
    """Wait for a generation that was still running when its tool call returned."""
    job = engine.request("GET", f"/jobs/{job_id}/wait", params={"timeout": min(timeout, 300)}, timeout=min(timeout, 300) + 30)
    return _finish(job)


def run() -> None:
    server.run("stdio")
