import { defineConfig } from 'vitest/config'
import pkg from './package.json'
import { buildDefines } from './build-meta'

export default defineConfig({ define: buildDefines(process.env, pkg.version), test: { environment: 'jsdom' } })
