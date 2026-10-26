import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'
import { buildDefines } from './build-meta'

// https://vite.dev/config/
export default defineConfig({
  define: buildDefines(process.env, pkg.version),
  plugins: [react(), tailwindcss()],
  server: {
    port: 5115
  }
})
