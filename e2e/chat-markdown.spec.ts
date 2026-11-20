import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { electronExecutable, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// A reply's Markdown is drawn formatted in every frame: while it streams, as it settles, when
// a finished one is shown again. A probe in the chat page looks at each painted frame (and
// every DOM change) for plain-text stand-ins of a reply and for a reply redrawn from scratch.
// A stand-in ACP agent streams the reply; no agent login or usage is needed.

const REPLY = [
  '## Result',
  '',
  'A structured answer with **emphasis**, `inline code`, and [a link](https://example.com).',
  '',
  '- Keep the preview responsive.',
  '- Preserve the current layout.',
  '',
  '| Choice | Cost |',
  '| --- | --- |',
  '| A | **$5** |',
  '',
  'Checked the finished result.',
].join('\n')

/** Speaks ACP on stdio and streams REPLY in small chunks, then waits a moment and ends. */
const AGENT_SCRIPT = String.raw`
const REPLY = ${JSON.stringify(REPLY)}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const prompt = async ({ sessionId }) => {
  for (let at = 0; at < REPLY.length; at += 12) {
    const text = REPLY.slice(at, at + 12)
    write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
    await sleep(25)
  }
  await sleep(600)
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || method === undefined) return
  if (method === 'initialize') return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  if (method === 'session/new') return write({ id, result: { sessionId: 'markdown-1' } })
  if (method === 'session/prompt') return void prompt(params).then((result) => write({ id, result }))
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'markdown-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = {
    command: electronExecutable(),
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ muse: standIn }))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const ready = async () =>
    (await session.state()).agents.some((agent) => agent.id === 'muse' && agent.status === 'ready')
  await waitFor(ready, 'the stand-in to be checked')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate(() => window.gui.setAgent('muse'))
  const selected = async () => (await session.chatSnapshot()).meta.agentId === 'muse'
  await waitFor(selected, 'the stand-in to be the chat agent')
}

interface Probe {
  /** What frames showed that they shouldn't have, as runs: what, and for how many frames */
  flashes: string[]
  /** Reply elements (`.markdown`) taken out of the page while the probe ran */
  removed: number
  /** Blocks of a reply replaced by a new element with the same text: drawn again */
  redrawn: string[]
  frames: number
  stop: () => void
}

type ProbeWindow = Window & { __markdownProbe?: Probe }

/**
 * Runs in the chat page. Each frame, a reply shows no plain-text paragraph (the stand-in for
 * Markdown not drawn yet) and no half-mounted block. Every DOM change is watched for a reply
 * element that's taken out (redrawn from scratch).
 */
function startProbe(page: Page) {
  return page.evaluate(() => {
    const runs: { what: string; frames: number }[] = []
    const redrawn: string[] = []
    const blocks = new WeakMap<Element, Map<string, Element>>()
    let removed = 0
    let frames = 0
    let running = true
    const look = () => {
      const seen: string[] = []
      for (const reply of document.querySelectorAll<HTMLElement>('[data-transcript] .markdown')) {
        const phase = reply.dataset.markdownPhase
        const raw = reply.querySelector<HTMLElement>(':scope > p.whitespace-pre-wrap')
        if (raw && getComputedStyle(raw).visibility !== 'hidden') {
          const shown = raw.textContent?.length ?? 0
          seen.push(`plain text (${shown} of ${reply.textContent?.length} chars, ${phase})`)
        }
        if (reply.querySelector('[data-markdown-rendering]')) seen.push(`partly drawn (${phase})`)
        const drawn = blocks.get(reply) ?? new Map<string, Element>()
        blocks.set(reply, drawn)
        for (const [index, block] of [...reply.children].entries()) {
          const key = `${index} ${block.tagName.toLowerCase()} ${block.textContent?.slice(0, 30)}`
          const before = drawn.get(key)
          if (before && before !== block && !redrawn.includes(key)) redrawn.push(key)
          drawn.set(key, block)
        }
      }
      const what = seen.join('; ')
      const last = runs.at(-1)
      if (!what) {
        if (last?.what) runs.push({ what: '', frames: 1 })
      } else if (last?.what === what) last.frames++
      else runs.push({ what, frames: 1 })
    }
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches('.markdown') || node.querySelector('.markdown')) removed++
        }
      }
    })
    observer.observe(document.querySelector('[data-transcript]') ?? document.body, {
      childList: true,
      subtree: true,
    })
    const frame = () => {
      if (!running) return
      frames++
      look()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    ;(window as ProbeWindow).__markdownProbe = {
      get flashes() {
        return runs.filter((run) => run.what).map((run) => `${run.what} ×${run.frames}`)
      },
      get removed() {
        return removed
      },
      redrawn,
      get frames() {
        return frames
      },
      stop: () => {
        running = false
        observer.disconnect()
      },
    }
  })
}

function stopProbe(page: Page) {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).__markdownProbe
    if (!probe) throw new Error('The Markdown probe was not started')
    probe.stop()
    delete (window as ProbeWindow).__markdownProbe
    return {
      flashes: probe.flashes.slice(0, 12),
      removed: probe.removed,
      redrawn: probe.redrawn.slice(0, 12),
      frames: probe.frames,
    }
  })
}

/** Sends a message to the stand-in, which streams REPLY, and waits for the turn to end. */
async function streamReply(session: GuiSession) {
  const box = session.chat.getByRole('textbox', { name: /^Message / })
  await box.fill('Summarize the page.')
  await box.press('Enter')
  await session.waitForTurn(0, 30_000)
  const reply = session.chat.locator('[data-transcript] .markdown')
  await expect(reply).toHaveAttribute('data-markdown-phase', 'complete')
  await expect(reply.locator('strong')).toHaveText(['emphasis', '$5'])
  await expect(reply.locator('table')).toHaveCount(1)
}

test('a streamed reply keeps its elements as each block settles and as the turn ends', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  await session.waitForPreview()
  await startProbe(session.chat)
  await streamReply(session)
  const { removed, redrawn } = await stopProbe(session.chat)
  expect({ removed, redrawn }).toEqual({ removed: 0, redrawn: [] })
})
