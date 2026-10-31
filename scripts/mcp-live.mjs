// Cross-context check: with the packaged app open on the Library, Claude's MCP server (the entry
// registered in ~/.claude.json) generates a sound; it must use the app's engine (same PID) and the
// new file must appear in the app live.
//   node scripts/mcp-live.mjs [screenshotDir]
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'mcp-live'))
fs.mkdirSync(outDir, { recursive: true })
const python = path.join(root, 'engine', '.venv', 'Scripts', 'python.exe')
const name = `mcp_live_${Date.now().toString(36)}`

const app = await electron.launch({ executablePath: path.join(root, 'dist', 'windows', 'StableSFX Studio.exe') })
const win = await app.firstWindow()
try {
  await win.getByRole('button', { name: 'Library' }).waitFor({ timeout: 300_000 })
  await win.getByText(/LOCAL ·/).waitFor({ timeout: 120_000 })
  const appEngine = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.stablesfx', 'run', 'engine.json'), 'utf8'))
  await win.getByRole('button', { name: 'Library', exact: true }).click()

  const status = JSON.parse(execFileSync(python, [path.join(root, 'scripts', 'mcp-call.py'), 'engine_status', '{}'], { encoding: 'utf8' }))
  console.log(`app engine pid ${appEngine.pid}, MCP engine pid ${status.pid}: ${status.pid === appEngine.pid ? 'SHARED' : 'DIFFERENT'}`)
  if (status.pid !== appEngine.pid) process.exitCode = 1

  const gen = JSON.parse(
    execFileSync(python, [path.join(root, 'scripts', 'mcp-call.py'), 'generate_sfx', JSON.stringify({ prompt: 'small creature squeak, playful', duration: 1, folder: 'Claude/Test', name, tags: ['mcp-test'] })], { encoding: 'utf8' })
  )
  console.log('MCP generated', gen.results[0].path)
  await win.getByText(`${name}_001`).waitFor({ timeout: 15_000 })
  console.log('appeared live in the app library')
  await win.screenshot({ path: path.join(outDir, 'library-after-mcp.png') })
} catch (err) {
  console.error('MCP LIVE FAILED:', err.message)
  await win.screenshot({ path: path.join(outDir, 'failure.png') }).catch(() => undefined)
  process.exitCode = 1
} finally {
  await app.close()
}
