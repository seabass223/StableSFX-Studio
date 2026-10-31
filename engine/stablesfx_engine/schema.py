"""The engine contract: request/response models shared by the HTTP API, the MCP
server and (via openapi.json -> openapi-typescript) the Electron renderer."""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

# --------------------------------------------------------------------------- models

ModelId = Literal["small-sfx", "small-sfx-base", "small-music", "small-music-base", "medium", "medium-base"]
Sampler = Literal["pingpong", "euler", "dpmpp", "rk4"]
Device = Literal["auto", "cuda", "cpu"]
Precision = Literal["auto", "fp32", "bf16", "fp16"]
AudioFormat = Literal["wav", "flac", "mp3"]


class ModelDefaults(BaseModel):
    steps: int
    cfg_scale: float
    sampler: Sampler
    max_duration: float


class ModelInfo(BaseModel):
    id: ModelId
    label: str
    kind: Literal["sfx", "music", "general"]
    distilled: bool
    repo_id: str
    license_url: str
    defaults: ModelDefaults
    downloaded: bool = False
    size_bytes: int = 0
    loaded: bool = False
    available: bool = True
    note: str | None = None


# --------------------------------------------------------------------------- generation params


class ShiftParams(BaseModel):
    """Inference-time timestep schedule shift. ``default`` uses the model's own."""

    type: Literal["default", "logsnr", "flux", "full", "none"] = "default"
    # logsnr
    anchor_length: int = Field(2000, ge=100, le=10000)
    anchor_logsnr: float = Field(-6.2, ge=-12, le=0)
    rate: float = Field(0.0, ge=-2, le=2)
    logsnr_end: float = Field(2.0, ge=-2, le=6)
    # flux / full
    min_length: int = Field(256, ge=1, le=10000)
    max_length: int = Field(4096, ge=1, le=10000)
    alpha_min: float = Field(6.93, ge=0.1, le=20)
    alpha_max: float = Field(6.93, ge=0.1, le=20)
    base_shift: float = Field(0.5, ge=0, le=5)
    max_shift: float = Field(1.15, ge=0, le=5)


class LoraSpec(BaseModel):
    path: str = Field(description="Absolute path to a .safetensors LoRA")
    strength: float = Field(1.0, ge=0, le=10)
    interval: tuple[float, float] = (0.0, 1.0)
    layer_filter: str = ""


class GenerateParams(BaseModel):
    """Every meaningful Stable Audio 3 sampling parameter. ``None`` = model default."""

    model: ModelId = "small-sfx"
    prompt: str = ""
    negative_prompt: str = ""
    sfx_prefix: bool = Field(True, description="Prepend 'TrackType: SFX, ' (upstream prompting guide)")
    duration: float = Field(3.0, gt=0, le=384)
    seed: int = Field(-1, ge=-1, le=2**31 - 1, description="-1 = random")
    steps: int | None = Field(None, ge=1, le=500)
    cfg_scale: float | None = Field(None, ge=0, le=25)
    apg_scale: float = Field(1.0, ge=0, le=1)
    cfg_interval: tuple[float, float] = (0.0, 1.0)
    cfg_rescale: float = Field(0.0, ge=0, le=1)
    cfg_norm_threshold: float = Field(0.0, ge=0, le=100)
    sampler: Sampler | None = None
    duration_padding: float = Field(6.0, ge=0, le=30)
    chunked_decode: bool | None = None
    shift: ShiftParams = ShiftParams()
    loras: list[LoraSpec] = []


JobMode = Literal["text", "audio2audio", "inpaint", "extend", "loop"]


class JobRequest(BaseModel):
    mode: JobMode = "text"
    params: GenerateParams = GenerateParams()
    variations: int = Field(1, ge=1, le=16)
    source: str | None = Field(None, description="Item id (lib:/hist:) or absolute audio path")
    strength: float = Field(
        0.5, ge=0.01, le=1.0,
        description="audio2audio: how far from the source (init noise level). inpaint/extend/loop: <1 keeps the source's structure inside the region too",
    )
    duration_from_source: bool = Field(True, description="audio2audio: use the source length as duration")
    regions: list[tuple[float, float]] = Field(default_factory=list, description="inpaint regions in seconds")
    preserve_outside: bool = Field(True, description="inpaint/extend/loop: composite the untouched source back outside the regions")
    extend_seconds: float = Field(2.0, gt=0, le=380)
    loop_seam_seconds: float = Field(0.75, ge=0.1, le=10)
    target: Literal["history", "library"] = "history"
    folder: str | None = Field(None, description="Library folder (relative) when target=library")
    name: str | None = None
    tags: list[str] = []
    post: list["ProcessOp"] = []
    origin: Literal["app", "mcp", "api"] = "app"


# --------------------------------------------------------------------------- DSP ops


class _Op(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TrimOp(_Op):
    op: Literal["trim"] = "trim"
    start: float = 0.0
    end: float | None = None


class TrimSilenceOp(_Op):
    op: Literal["trim_silence"] = "trim_silence"
    threshold_db: float = -50.0
    pad_ms: float = 10.0
    head: bool = True
    tail: bool = True


class NormalizeOp(_Op):
    op: Literal["normalize"] = "normalize"
    mode: Literal["peak", "lufs"] = "peak"
    target: float = -1.0


class FadeOp(_Op):
    op: Literal["fade_in", "fade_out"]
    ms: float = 50.0
    curve: Literal["linear", "exp", "log", "scurve"] = "linear"


class ReverseOp(_Op):
    op: Literal["reverse"] = "reverse"


class GainOp(_Op):
    op: Literal["gain"] = "gain"
    db: float = 0.0


class LoopCrossfadeOp(_Op):
    op: Literal["loop_crossfade"] = "loop_crossfade"
    ms: float = 250.0


class PitchOp(_Op):
    op: Literal["pitch"] = "pitch"
    semitones: float = 0.0
    preserve_length: bool = False


class StretchOp(_Op):
    op: Literal["stretch"] = "stretch"
    factor: float = Field(1.0, gt=0.25, le=4.0, description=">1 = longer/slower, pitch preserved")


class ChannelsOp(_Op):
    op: Literal["mono", "stereo"]


class ResampleOp(_Op):
    op: Literal["resample"] = "resample"
    sample_rate: int = 44100


class FilterOp(_Op):
    op: Literal["highpass", "lowpass"]
    freq_hz: float = 100.0
    q: float = 0.707


class PadOp(_Op):
    op: Literal["pad"] = "pad"
    head_ms: float = 0.0
    tail_ms: float = 0.0


ProcessOp = Annotated[
    Union[
        TrimOp, TrimSilenceOp, NormalizeOp, FadeOp, ReverseOp, GainOp, LoopCrossfadeOp,
        PitchOp, StretchOp, ChannelsOp, ResampleOp, FilterOp, PadOp,
    ],
    Field(discriminator="op"),
]

JobRequest.model_rebuild()


class ProcessRequest(BaseModel):
    source: str
    ops: list[ProcessOp]
    target: Literal["history", "replace", "library"] = "history"
    folder: str | None = None
    name: str | None = None


# --------------------------------------------------------------------------- items / library


class AudioStats(BaseModel):
    duration: float
    sample_rate: int
    channels: int
    frames: int
    peak_db: float
    rms_db: float
    lufs: float | None = None
    head_silence: float = 0.0
    tail_silence: float = 0.0


class SfxItem(BaseModel):
    id: str = Field(description="lib:<relative path> or hist:<relative path>")
    uid: str
    kind: Literal["library", "history", "external"]
    path: str
    folder: str
    name: str
    ext: str
    size: int
    created: str
    modified: float
    prompt: str | None = None
    model: str | None = None
    mode: str | None = None
    seed: int | None = None
    params: dict[str, Any] | None = None
    source_uid: str | None = None
    parent_uid: str | None = None
    ops: list[dict[str, Any]] = []
    tags: list[str] = []
    starred: bool = False
    origin: str | None = None
    generation_time: float | None = None
    stats: AudioStats | None = None
    peaks: list[float] = []


class FolderNode(BaseModel):
    name: str
    path: str
    count: int
    children: list["FolderNode"] = []


class ItemPatch(BaseModel):
    name: str | None = None
    folder: str | None = None
    tags: list[str] | None = None
    starred: bool | None = None
    prompt: str | None = None


class KeepRequest(BaseModel):
    id: str
    folder: str = "Inbox"
    name: str | None = None
    tags: list[str] = []
    move: bool = False


class ImportRequest(BaseModel):
    paths: list[str]
    folder: str = "Imported"


class FolderRequest(BaseModel):
    path: str
    new_path: str | None = None


# --------------------------------------------------------------------------- export


class ExportRequest(BaseModel):
    sources: list[str]
    dest_dir: str
    format: AudioFormat = "wav"
    sample_rate: int | None = Field(None, description="None = keep source rate")
    bit_depth: Literal[16, 24, 32] = 24
    channels: Literal[1, 2] | None = None
    mp3_bitrate: int = Field(320, ge=64, le=320)
    normalize: NormalizeOp | None = None
    name_template: str = Field("{name}", description="Tokens: {name} {index} {seed} {folder}")
    overwrite: bool = False


class ExportResult(BaseModel):
    files: list[str]
    warnings: list[str] = []


# --------------------------------------------------------------------------- jobs / events


JobState = Literal["queued", "loading", "encoding", "sampling", "decoding", "saving", "done", "error", "cancelled"]


class JobInfo(BaseModel):
    id: str
    mode: JobMode
    state: JobState
    origin: str
    created: float
    started: float | None = None
    finished: float | None = None
    variation: int = 0
    variations: int = 1
    step: int = 0
    steps: int = 0
    progress: float = 0.0
    message: str | None = None
    error: str | None = None
    results: list[SfxItem] = []
    seeds: list[int] = []
    request: JobRequest


class EngineStatus(BaseModel):
    version: str
    src_hash: str
    pid: int
    ready: bool
    device: str | None = None
    device_name: str | None = None
    vram_total_gb: float | None = None
    vram_used_gb: float | None = None
    torch: str | None = None
    cuda: str | None = None
    flash_attn: bool = False
    loaded_model: str | None = None
    loaded_precision: str | None = None
    busy: bool = False
    queue: int = 0
    clients: int = 0
    library_path: str
    history_path: str
    fake: bool = False
    error: str | None = None


class OutputDefaults(BaseModel):
    format: AudioFormat = "wav"
    sample_rate: int = 44100
    bit_depth: Literal[16, 24, 32] = 24
    channels: Literal[1, 2] = 2
    mp3_bitrate: int = 320


class EngineConfig(BaseModel):
    model_config = ConfigDict(extra="ignore")

    library_path: str = ""
    default_model: ModelId = "small-sfx"
    device: Device = "auto"
    precision: Precision = Field("auto", description="auto = fp32 for small models, bf16 for Medium (fp16 can overflow to NaN)")
    model_idle_unload_minutes: float = 10
    engine_idle_exit_minutes: float = 30
    history_retention_days: float = 14
    history_max_gb: float = 2.0
    output: OutputDefaults = OutputDefaults()


class Preset(BaseModel):
    id: str
    name: str
    category: str
    builtin: bool = False
    description: str = ""
    mode: JobMode = "text"
    params: GenerateParams
    variations: int = 4


class Event(BaseModel):
    type: Literal["status", "job", "library", "history", "model", "log", "config", "presets"]
    data: dict[str, Any] = {}


FolderNode.model_rebuild()
