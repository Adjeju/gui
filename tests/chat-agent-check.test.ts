import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

test("a chat restored on an agent not checked since launch checks it, and lists the check's models", async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'chat-agent-check.ts'),
  ])
  expect(result.stdout).toContain('A restored chat checks its agent passed.')
  expect(result.stderr).toBe('')
}, 10_000)
