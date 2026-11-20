import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentDefinition } from '../src/main/agents'

// Opening a website can carry data out in its address, so the agent asks every call: Claude
// isn't allowed the website tools up front and keeps asking about them in its own Auto mode,
// so in Ask the user decides (in Auto, Gui answers: tests/auto-approve.test.ts).

const { sessionMeta } = await import('../src/main/session-meta')

const claude = { id: 'claude', permissions: undefined } as unknown as AgentDefinition

test("Claude may call Gui's tools without asking, but never the ones that open websites", () => {
  const meta = sessionMeta(claude, 'auto') as {
    claudeCode: {
      options: { allowedTools: string[]; settings: { permissions: { ask: string[] } } }
    }
  }
  const { allowedTools, settings } = meta.claudeCode.options
  expect(allowedTools).toContain('mcp__gui__preview_navigate')
  expect(allowedTools).toContain('mcp__gui__preview_click')
  expect(allowedTools).not.toContain('mcp__gui__preview_open_website')
  expect(allowedTools).not.toContain('mcp__gui__canvas_screenshot_url')
  expect(settings.permissions.ask.sort()).toEqual([
    'mcp__gui__canvas_screenshot_url',
    'mcp__gui__preview_open_website',
  ])
})

test("agents Gui can't make ask first aren't offered a website, in their own process", async () => {
  const file = join(import.meta.dirname, 'fast', 'agent-websites.ts')
  const result = await promisify(execFile)(process.execPath, ['test', file]).catch(
    (error: { stdout: string; stderr: string }) => error,
  )
  // The whole report, so a failure in there is shown here.
  const report = `${result.stdout}${result.stderr}`
  expect(report).toContain('\n 0 fail\n')
  expect(report).toMatch(/\n 2 pass\n/)
}, 10_000)
