# StableSFX Studio

## Build
This project follows the Local Build Protocol (~/.claude/build-protocol/PROTOCOL.md).
Build only through `./build.sh` from Git Bash (`--target all`, `--run`, `--launch [--target <t>]`, `--pin`, `--info`);
output goes to `dist/`. Settings live in `build.config.json`. `build.sh` is a managed copy: don't edit it;
change build behaviour through the build-protocol agent.

Project specifics: the `preBuild` hook runs `node scripts/copy-uv.mjs` to stage `resources/uv.exe` (needs uv
installed via pip, or `STABLESFX_UV` set). The Python engine is not built here; the app creates its own Python
env at runtime under `%USERPROFILE%\.stablesfx`. Close the running app before building (it locks `dist/windows`).

## Architecture
- `engine/` — Python (uv, Python 3.12, CUDA torch 2.7.1+cu126) FastAPI server that owns the model/GPU, the SFX library
  (`Documents\StableSFX Library`, one `<name>.sfx.json` sidecar per file) and History (`~\.stablesfx\history`).
  `python -m stablesfx_engine serve|ensure|stop|mcp|openapi`. One engine per user (lock file + `~\.stablesfx\run\engine.json`
  with port/token); the app and the MCP server both call `ensure` and share it.
- `src/main` — Electron main: env setup (bundled `uv.exe` → `~\.stablesfx\env\<lockhash>`, `env\current` junction),
  engine client, `sfx://` audio proxy (renderer never sees the token), drag-out, MCP registration (`~\.claude.json`).
- `src/renderer` — React + shadcn/ui + zustand + wavesurfer. API types come from `engine/openapi.json`:
  after changing `engine/stablesfx_engine/schema.py` run
  `PYTHONPATH=engine engine/.venv/Scripts/python -m stablesfx_engine openapi > engine/openapi.json && npm run gen:api`.
  Wavesurfer only handles timing, cursor, regions and input: the wave itself is painted by `lib/wave.ts` onto two canvases
  (`dull`, plus `bright` clipped to the selection, or to the playhead without one). Its heights are a display curve
  (compressed envelope, stylised spikes), not true amplitude. Buttons use the `.key` family in `styles.css`.
- Shared state lives in `%USERPROFILE%\.stablesfx`, never AppData: processes started from the Claude desktop app (MSIX)
  get AppData writes redirected.

## Engine gotchas (verified on the RTX 3060)
- Stable Audio 3 diverges into full-scale noise when `seconds_total` is fractional (0.8 s, 1.2 s…); the engine
  conditions on whole seconds and trims (`models.conditioning_seconds`). Keep it.
- fp16 overflows to NaN in some audio-to-audio runs: precision `auto` = fp32 for small models, bf16 for Medium.
- Without Triton, upstream's compiled flex_attention silently runs eagerly; the backend forces the chunked-SDPA path.
- `shift.StrengthAwareShift` fixes the non-monotonic schedule for audio-to-audio strength < 1 and rk4.

## Dev / tests
- Engine tests (fake backend, no GPU): `cd engine && .venv/Scripts/python -m pytest -q` (use `--basetemp` inside the repo
  or scratch dir if the temp dir is not writable).
- Real GPU regression: `engine/.venv/Scripts/python scripts/engine-check.py`.
- MCP over stdio: `engine/.venv/Scripts/python scripts/mcp-smoke.py <python.exe> <PYTHONPATH> <export dir>`.
- UI smoke (packaged app, screenshots): `node scripts/smoke.mjs [dir]`. `npm run typecheck`, `npm run lint`.
- The app restarts an idle engine whose `src_hash` differs from the bundled engine sources.
