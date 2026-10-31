// Only used by tooling (shadcn CLI) to detect the framework; the app builds with electron.vite.config.ts.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: 'src/renderer',
  resolve: { alias: { '@': resolve('src/renderer/src') } },
  plugins: [react(), tailwindcss()]
})
