import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const api = 'http://127.0.0.1:4000'
const page = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Two pages: the Switchboard console (index.html) and the HYKR app for owners (app.html).
    rollupOptions: { input: { index: page('./web/index.html'), app: page('./web/app.html') } },
  },
  server: {
    port: 5173,
    proxy: { '/api': api, '/sandbox': api, '/graph': api, '/webhook': api },
  },
})
