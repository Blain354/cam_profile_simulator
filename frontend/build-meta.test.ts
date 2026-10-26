import { expect, test } from 'vitest'
import { buildDefines } from './build-meta'

const git = (cmd: string) => (cmd.includes('rev-parse') ? 'abc1234' : cmd.includes('log') ? '2026-10-20' : '')

test('build data comes from the environment first (Docker has no .git)', () => {
  const defines = buildDefines({ APP_VERSION: '3.1.0', APP_COMMIT: 'def5678', APP_COMMIT_DATE: '2026-10-25' }, '0.0.0', git)
  expect(defines).toEqual({
    __APP_VERSION__: '"3.1.0"',
    __APP_COMMIT__: '"def5678"',
    __APP_COMMIT_DATE__: '"2026-10-25"',
  })
})

test('falls back to package.json and git locally', () => {
  expect(buildDefines({}, '0.4.2', git)).toEqual({
    __APP_VERSION__: '"0.4.2"',
    __APP_COMMIT__: '"abc1234"',
    __APP_COMMIT_DATE__: '"2026-10-20"',
  })
})

test('stays empty rather than failing without git', () => {
  expect(buildDefines({}, '0.4.2', () => '').__APP_COMMIT__).toBe('""')
})
