# StableSFX Studio

A local Windows app for generating, modifying and organising **game sound effects** with
[Stable Audio 3](https://github.com/Stability-AI/stable-audio-3), plus an MCP server so Claude can do the same.

- **Generate**: text → SFX with every Stable Audio 3 sampling parameter (model, duration, seed, guidance, steps,
  sampler, APG, guidance interval/rescale/norm threshold, schedule shift, duration padding, chunked decode, LoRAs).
  Batches of variations; A/B parameter slots; undo/redo.
- **Modify / Clone**: audio-to-audio from any clip (Close/Medium/Loose similarity), **Inpaint** selected regions,
  **Extend** a clip, **AI Loop** (the model heals the loop seam).
- **Edit & Process**: trim, trim silence, normalize (peak/LUFS), fades, reverse, crossfade loop, gain, pitch,
  time-stretch, filters, mono/stereo, resample. Non-destructive (every edit is a new version; undo steps back).
- **Library**: `Documents\StableSFX Library` is plain folders + a `.sfx.json` sidecar per sound (prompt, model, seed,
  all parameters, edit history, stats). Takes live in an auto-pruned History until you **Keep** them.
- **Export** WAV (16/24/32f), FLAC, MP3 at any rate/channel count, with optional normalization; or **drag to DAW/Unity**.

## Run / build
`./build.sh` (Git Bash) builds `dist/windows/StableSFX Studio.exe` and refreshes the Start Menu shortcut
(*Dev Tools → StableSFX Studio*; right-click → Pin to Start once). First launch installs the engine's Python
environment (Python 3.12 + CUDA PyTorch, ~3 GB) into `%USERPROFILE%\.stablesfx`. Model weights come from the shared
Hugging Face cache.

## Claude (MCP)
Registered for all Claude Code projects as `stablesfx` (Settings → Claude can re-register it). Tools:
`generate_sfx`, `modify_sfx` (clone/variations), `inpaint_sfx`, `extend_sfx`, `make_loop`, `process_sfx`,
`export_sfx` (e.g. straight into a Unity `Assets/Audio` folder), `list_library`, `get_sfx`, `organize_sfx`,
`delete_sfx`, `list_presets`, `engine_status`, `wait_job`. The app and Claude share one engine and the library
updates live.

Developer notes (architecture, upstream quirks, tests) are in [CLAUDE.md](CLAUDE.md).
