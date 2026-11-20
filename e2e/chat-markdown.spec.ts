import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Turn } from '../src/shared/types'
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
  /** Frames in which a reply's text wasn't drawn yet (held unseen), as runs */
  blanks: string[]
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
    type Run = { what: string; frames: number }
    const runs: Run[] = []
    const blankRuns: Run[] = []
    const track = (log: Run[], seen: string[]) => {
      const what = seen.join('; ')
      const last = log.at(-1)
      if (!what) {
        if (last?.what) log.push({ what: '', frames: 1 })
      } else if (last?.what === what) last.frames++
      else log.push({ what, frames: 1 })
    }
    const summary = (log: Run[]) =>
      log.filter((run) => run.what).map((run) => `${run.what} ×${run.frames}`)
    const redrawn: string[] = []
    const blocks = new WeakMap<Element, Map<string, Element>>()
    let removed = 0
    let frames = 0
    let running = true
    const look = () => {
      const seen: string[] = []
      const blank: string[] = []
      for (const reply of document.querySelectorAll<HTMLElement>('[data-transcript] .markdown')) {
        const phase = reply.dataset.markdownPhase
        const raw = reply.querySelector<HTMLElement>(':scope > p.whitespace-pre-wrap')
        if (raw) {
          const shown = `${raw.textContent?.length} of ${reply.textContent?.length} chars, ${phase}`
          if (getComputedStyle(raw).visibility === 'hidden') blank.push(`not drawn (${shown})`)
          else seen.push(`plain text (${shown})`)
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
      track(runs, seen)
      track(blankRuns, blank)
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
        return summary(runs)
      },
      get blanks() {
        return summary(blankRuns)
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
      blanks: probe.blanks.slice(0, 12),
      removed: probe.removed,
      redrawn: probe.redrawn.slice(0, 12),
      frames: probe.frames,
    }
  })
}

function turn(index: number, text: string): Turn {
  return {
    id: `markdown-turn-${index}`,
    index,
    prompt: `Request ${index}`,
    context: [],
    status: 'done',
    error: null,
    startedAt: Date.now() - 2000,
    endedAt: Date.now() - 1000,
    reverted: false,
    changes: [],
    items: [{ kind: 'text', id: `markdown-text-${index}`, text }],
  }
}

/** Replaces the chat's turns, as a restored chat or a chat switch does. */
async function showTurns(session: GuiSession, turns: Turn[]) {
  const snapshot = await session.chatSnapshot()
  await session.app.evaluate(
    ({ webContents }, value) => {
      const chat = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().endsWith('/chat.html'))
      if (!chat) throw new Error('Missing chat renderer')
      chat.send('chat:reset', value)
    },
    { ...snapshot, turns },
  )
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

test('a streamed reply is formatted from its first words to its last', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  await session.waitForPreview()
  await startProbe(session.chat)
  await streamReply(session)
  const { flashes, frames } = await stopProbe(session.chat)
  expect(frames).toBeGreaterThan(10)
  expect(flashes).toEqual([])
})

test('a restored short reply is formatted in its first frame', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  const scripts: string[] = []
  const cdp = await session.chat.context().newCDPSession(session.chat)
  cdp.on('Debugger.scriptParsed', ({ url }) => scripts.push(url))
  await cdp.send('Debugger.enable')
  await session.chat.evaluate(() => window.gui.expandChat())
  // The parser for finished replies loads once the chat is idle, before any reply needs it.
  await waitFor(() => scripts.some((url) => url.includes('/small-markdown-')), 'the parser')
  await cdp.detach()
  await startProbe(session.chat)
  await showTurns(session, [turn(0, REPLY)])
  const reply = session.chat.locator('[data-transcript] .markdown')
  await expect(reply.locator('strong')).toHaveText(['emphasis', '$5'])
  const probe = await stopProbe(session.chat)
  expect(probe.flashes).toEqual([])
})

const LONG = `${REPLY}\n\n`.repeat(80)

/** Shows a restored chat of long replies, and waits for the newest to be drawn. */
async function showLongReplies(session: GuiSession) {
  expect(LONG.length).toBeGreaterThan(16_384)
  await showTurns(
    session,
    Array.from({ length: 13 }, (_, index) => turn(index, LONG)),
  )
  const last = session.chat.locator('[data-turn-row="markdown-turn-12"] .markdown')
  await expect(last).toHaveAttribute('data-markdown-phase', 'complete')
  await expect(last.locator('[data-markdown-rendering]')).toHaveCount(0)
}

test('a long finished reply is never shown as plain text while it is drawn', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  await startProbe(session.chat)
  await showLongReplies(session)
  const { flashes } = await stopProbe(session.chat)
  expect(flashes).toEqual([])
})

test('a long finished reply scrolled back into view is drawn in its first frame', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  await session.chat.evaluate(() => window.gui.expandChat())
  await showLongReplies(session)
  const first = session.chat.locator('[data-turn-row="markdown-turn-0"] .markdown')
  await expect(first).toHaveCount(0)
  // Back to the first reply with the wheel, as the user scrolls: it mounts again.
  await startProbe(session.chat)
  const transcript = session.chat.locator('[data-transcript]')
  await transcript.hover()
  await session.chat.mouse.wheel(0, -10_000_000)
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0)
  await expect(first).toHaveAttribute('data-markdown-phase', 'complete')
  const { flashes, blanks } = await stopProbe(session.chat)
  expect({ flashes, blanks }).toEqual({ flashes: [], blanks: [] })
})
