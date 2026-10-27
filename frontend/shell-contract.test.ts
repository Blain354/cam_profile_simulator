import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

// @blain-projects/ui 2.1: F4 webfonts + viewport-fit (2.1.0); the kit pads
// .bui-workspace-shell below the header blur (2.1.1), so the first block under
// the header adds no top margin of its own.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('index.html declares the safe areas and the F4 webfonts', () => {
  const html = read('./index.html')
  expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/)
  expect(html).toContain('family=Hanken+Grotesk')
  expect(html).toContain('family=JetBrains+Mono')
})

test('the workspace spaces its blocks with gap, not a top margin under the header', () => {
  const app = read('./src/App.tsx')
  expect(app).toMatch(/bui-workspace-shell cam-workspace[^"]*\bgap-4\b/)
  expect(app).not.toMatch(/shrink-0 mt-4 bg-red-900/)
  expect(app).not.toMatch(/flex-1 mt-4 grid/)
  expect(read('./src/ProfileBuilder.tsx')).not.toMatch(/flex-1 mt-4 grid/)
})
