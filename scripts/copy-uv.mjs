// Copies the pip-installed uv binary into resources/uv.exe so the packaged app can create
// its Python environment without relying on uv being on PATH. Skips when already identical.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = path.join(root, 'resources', 'uv.exe')

function findUv() {
  if (process.env.STABLESFX_UV && fs.existsSync(process.env.STABLESFX_UV)) return process.env.STABLESFX_UV
  for (const py of ['python3.12', 'python', 'py']) {
    try {
      const args = py === 'py' ? ['-3.12', '-c', 'import uv; print(uv.find_uv_bin())'] : ['-c', 'import uv; print(uv.find_uv_bin())']
      const out = execFileSync(py, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (out && fs.existsSync(out)) return out
    } catch {
      /* try the next interpreter */
    }
  }
  try {
    const out = execFileSync('where', ['uv'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim()
    if (out && fs.existsSync(out)) return out
  } catch {
    /* not on PATH */
  }
  return null
}

const hash = (p) => createHash('sha1').update(fs.readFileSync(p)).digest('hex')

const src = findUv()
if (!src) {
  console.error('copy-uv: could not find uv (pip install uv, or set STABLESFX_UV)')
  process.exit(1)
}
fs.mkdirSync(path.dirname(dest), { recursive: true })
if (fs.existsSync(dest) && hash(dest) === hash(src)) {
  console.log('copy-uv: resources/uv.exe is up to date')
} else {
  fs.copyFileSync(src, dest)
  console.log(`copy-uv: copied ${src} -> resources/uv.exe`)
}
