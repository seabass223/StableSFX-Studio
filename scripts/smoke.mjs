// UI smoke test of the packaged app with Playwright's Electron driver.
//   node scripts/smoke.mjs [screenshotDir]
// Launches dist/windows/StableSFX Studio.exe, waits for engine setup/connection, generates a take
// and a batch of variations, visits every view and saves screenshots.
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'smoke'))
fs.mkdirSync(outDir, { recursive: true })
const exe = path.join(root, 'dist', 'windows', 'StableSFX Studio.exe')

const app = await electron.launch({ executablePath: exe, args: [], timeout: 60_000 })
const win = await app.firstWindow()
win.on('console', (m) => {
  if (m.type() === 'error') console.log('[renderer error]', m.text())
})
const shot = async (name) => {
  await win.screenshot({ path: path.join(outDir, `${name}.png`) })
  console.log('screenshot', name)
}

try {
  await win.waitForLoadState('domcontentloaded')
  await shot('00-start')
  // First run: environment setup can take several minutes.
  await win.getByRole('button', { name: 'Library' }).waitFor({ timeout: 20 * 60_000 })
  // Attached, not visible: the title bar hides this prefix on narrow windows.
  await win.getByText(/LOCAL ·/).waitFor({ state: 'attached', timeout: 120_000 })
  await shot('01-generate-empty')

  await win.getByPlaceholder(/Describe the sound/).fill('Heavy wooden door slam, short room reverb, close mic')
  await win.getByRole('button', { name: /^GENERATE$/ }).click()
  await win.getByText('Take 1').waitFor({ timeout: 180_000 })
  await win.waitForTimeout(1500)
  await shot('02-generated-one')

  await win.getByRole('button', { name: /VARIATIONS/ }).first().click()
  await win.getByText('Take 4').waitFor({ timeout: 180_000 })
  await win.waitForTimeout(1500)
  await shot('03-variations')

  // Marquee-select left→right on the waveform, then regenerate just that part (inpaint).
  const box = await win.getByTestId('waveform').boundingBox()
  const y = box.y + box.height / 2
  await win.mouse.move(box.x + box.width * 0.3, y)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width * 0.45, y, { steps: 8 })
  await win.mouse.move(box.x + box.width * 0.55, y, { steps: 8 })
  await win.mouse.up()
  await win.getByText(/^\d+\.\d\d–\d+\.\d\d s$/).waitFor({ timeout: 5_000 })
  await shot('03b-selection')
  await win.getByRole('button', { name: 'Regenerate' }).click()
  await win.getByText(/^\d+\.\d\d–\d+\.\d\d s$/).waitFor({ state: 'detached', timeout: 120_000 })
  await win.getByText('Ready', { exact: true }).waitFor({ timeout: 60_000 })
  await win.waitForTimeout(1200)
  await shot('03c-regenerated')
  await win.getByRole('radio', { name: 'Text → SFX' }).click()

  await win.getByRole('button', { name: /Advanced/ }).click()
  await win.waitForTimeout(500)
  await shot('04-advanced')
  await win.getByRole('button', { name: /Advanced/ }).click()

  await win.getByRole('radio', { name: 'Modify / Clone' }).click()
  await win.waitForTimeout(500)
  await shot('05-modify-mode')
  await win.getByRole('radio', { name: 'Text → SFX' }).click()

  await win.getByRole('button', { name: 'Library', exact: true }).click()
  await win.waitForTimeout(1200)
  await shot('06-library')
  await win.getByRole('button', { name: 'History' }).click()
  await win.waitForTimeout(1200)
  await shot('07-history')

  await win.getByRole('button', { name: 'Presets', exact: true }).click()
  await win.waitForTimeout(800)
  await shot('08-presets')

  await win.getByRole('button', { name: 'Settings', exact: true }).first().click()
  await win.waitForTimeout(1200)
  await shot('09-settings')
  console.log('SMOKE OK')
} catch (err) {
  await shot('zz-failure').catch(() => undefined)
  console.error('SMOKE FAILED:', err.message)
  process.exitCode = 1
} finally {
  await app.close()
}
