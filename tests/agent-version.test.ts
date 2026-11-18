import { expect, test } from 'bun:test'
import { meetsVersion } from '../src/main/agent-binaries'

// Gui reads an agent's `--version` before starting it, and refuses one older than the floor
// its definition names (agents.ts `minVersion`), or one that prints no version.

test("Muse Code's own output, at, above and below the floor", () => {
  expect(meetsVersion('Muse Code 1.4.23 (1.4.23-R8977.1)', '1.4.23')).toBe(true)
  expect(meetsVersion('Muse Code 1.4.24 (1.4.24-R9001.1)', '1.4.23')).toBe(true)
  expect(meetsVersion('Muse Code 1.5.0', '1.4.23')).toBe(true)
  expect(meetsVersion('Muse Code 2.0.0', '1.4.23')).toBe(true)
  expect(meetsVersion('Muse Code 1.4.22 (1.4.22-R8900.1)', '1.4.23')).toBe(false)
  expect(meetsVersion('Muse Code 1.3.99', '1.4.23')).toBe(false)
  expect(meetsVersion('Muse Code 0.11.0', '1.4.23')).toBe(false)
})

test("Antigravity CLI's own output (a bare version), at, above and below the floor", () => {
  expect(meetsVersion('1.5.0', '1.5.0')).toBe(true)
  expect(meetsVersion('1.5.11\n', '1.5.0')).toBe(true)
  expect(meetsVersion('1.4.12', '1.5.0')).toBe(false)
})

test('output without a version never meets it', () => {
  expect(meetsVersion('', '1.4.23')).toBe(false)
  expect(meetsVersion('muse: unknown option --version', '1.4.23')).toBe(false)
  expect(meetsVersion('Muse Code 1.4', '1.4.23')).toBe(false)
})
