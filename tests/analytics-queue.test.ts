import { describe, expect, test } from 'bun:test'
import {
  turnUsage,
  type UsageQueueOptions,
  type UsageReply,
  usageAgent,
  usageQueue,
} from '../src/main/analytics-queue'
import { MAX_QUEUED_USAGE_EVENTS, USAGE_BATCH } from '../src/shared/bounded'

const INSTALL = '0f8e2a4c-5b1d-4e7f-9a3b-6c2d8e0f1a2b'

interface Sent {
  installId: string
  events: { event: string; at: number; props?: Record<string, string> }[]
}

/** A queue whose sends are recorded; `reply` answers each one (or throws, as offline). */
function setup(
  overrides: Partial<UsageQueueOptions> & { reply?: (body: Sent) => UsageReply } = {},
) {
  const sent: Sent[] = []
  let enabled = true
  const { reply = () => ({ status: 204, json: async () => null }), ...rest } = overrides
  const queue = usageQueue({
    official: true,
    enabled: () => enabled,
    installId: () => INSTALL,
    post: async (body) => {
      const parsed = JSON.parse(body) as Sent
      sent.push(parsed)
      return reply(parsed)
    },
    now: () => 1_000,
    ...rest,
  })
  return {
    queue,
    sent,
    events: () => sent.flatMap((batch) => batch.events.map((e) => e.event)),
    setEnabled: (on: boolean) => {
      enabled = on
    },
  }
}

describe('usage queue', () => {
  test('a flush sends what was tracked, with the install ID, then nothing is left', async () => {
    const { queue, sent } = setup()
    queue.track('app_opened', { version: '1.0.0', os: 'darwin', osVersion: '26.1', arch: 'arm64' })
    queue.track('project_opened')
    queue.track('turn_finished', { agent: 'claude', outcome: 'done' })
    await queue.flush()
    expect(sent).toEqual([
      {
        installId: INSTALL,
        events: [
          {
            event: 'app_opened',
            at: 1_000,
            props: { version: '1.0.0', os: 'darwin', osVersion: '26.1', arch: 'arm64' },
          },
          { event: 'project_opened', at: 1_000 },
          { event: 'turn_finished', at: 1_000, props: { agent: 'claude', outcome: 'done' } },
        ],
      },
    ])
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toHaveLength(1)
  })

  test('a build that is not an official release never keeps or sends anything', async () => {
    let asked = false
    const { queue, sent } = setup({
      official: false,
      installId: () => {
        asked = true
        return INSTALL
      },
    })
    queue.track('project_opened')
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toEqual([])
    expect(asked).toBe(false)
  })

  test('the queue is bounded: past the cap, the oldest go', async () => {
    const { queue, sent } = setup()
    for (let i = 0; i < MAX_QUEUED_USAGE_EVENTS + 50; i++) {
      queue.track('agent_connected', { agent: `a${i}` })
    }
    expect(queue.size).toBe(MAX_QUEUED_USAGE_EVENTS)
    await queue.flush()
    const agents = sent.flatMap((batch) => batch.events.map((e) => e.props?.agent))
    expect(agents).toHaveLength(MAX_QUEUED_USAGE_EVENTS)
    expect(agents[0]).toBe('a50')
    // Sent a batch at a time.
    expect(sent.every((batch) => batch.events.length <= USAGE_BATCH)).toBe(true)
    expect(sent).toHaveLength(MAX_QUEUED_USAGE_EVENTS / USAGE_BATCH)
  })

  test('offline, events are kept for the next flush, within the cap', async () => {
    let online = false
    const { queue, sent, events } = setup({
      reply: () => {
        if (!online) throw new Error('offline')
        return { status: 204, json: async () => null }
      },
    })
    queue.track('project_opened')
    queue.track('canvas_created')
    await queue.flush()
    expect(queue.size).toBe(2)
    for (let i = 0; i < MAX_QUEUED_USAGE_EVENTS; i++) queue.track('preview_opened')
    expect(queue.size).toBe(MAX_QUEUED_USAGE_EVENTS)
    online = true
    sent.length = 0
    await queue.flush()
    expect(queue.size).toBe(0)
    // The two kept from before were the oldest, so the cap dropped them.
    expect(events().filter((name) => name !== 'preview_opened')).toEqual([])
  })

  test('a server error keeps the batch; a refused batch is dropped', async () => {
    let status = 503
    const { queue } = setup({ reply: () => ({ status, json: async () => null }) })
    queue.track('project_opened')
    await queue.flush()
    expect(queue.size).toBe(1)
    status = 400
    await queue.flush()
    expect(queue.size).toBe(0)
  })

  test('an event tracked while a send is under way is kept if the send fails', async () => {
    let release: () => void = () => {}
    const { queue } = setup({
      reply: () => {
        throw new Error('offline')
      },
      post: () =>
        new Promise((_, reject) => {
          release = () => reject(new Error('offline'))
        }),
    })
    queue.track('project_opened')
    const flushing = queue.flush()
    queue.track('canvas_created')
    release()
    await flushing
    expect(queue.size).toBe(2)
  })

  test('switched off: nothing is kept, and the queue clears', async () => {
    const { queue, sent, setEnabled } = setup()
    queue.track('project_opened')
    queue.clear()
    expect(queue.size).toBe(0)
    setEnabled(false)
    queue.track('canvas_created')
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toEqual([])
  })

  test('switched off between tracking and the flush: nothing goes', async () => {
    const { queue, sent, setEnabled } = setup()
    queue.track('project_opened')
    setEnabled(false)
    await queue.flush()
    expect(sent).toEqual([])
    expect(queue.size).toBe(0)
  })

  test('{ stop: true } stops sending and keeping for the rest of the launch', async () => {
    const { queue, sent } = setup({
      reply: () => ({ status: 200, json: async () => ({ stop: true }) }),
    })
    queue.track('project_opened')
    await queue.flush()
    expect(sent).toHaveLength(1)
    expect(queue.stopped).toBe(true)
    queue.track('canvas_created')
    expect(queue.size).toBe(0)
    await queue.flush()
    expect(sent).toHaveLength(1)
  })

  test('a flush that runs out of time keeps what it could not send', async () => {
    const { queue } = setup({
      post: (_body, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason))
        }),
    })
    queue.track('project_opened')
    const started = Date.now()
    await queue.flush(50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(queue.size).toBe(1)
  })

  test('two flushes at once send once', async () => {
    const { queue, sent } = setup()
    queue.track('project_opened')
    await Promise.all([queue.flush(), queue.flush()])
    expect(sent).toHaveLength(1)
  })
})

describe('what a turn sends', () => {
  test('the agent, how it ended, and the provider only when it is a short name', () => {
    expect(turnUsage('claude', 'done')).toEqual({ agent: 'claude', outcome: 'done' })
    expect(turnUsage('codex', 'error', 'grok')).toEqual({
      agent: 'codex',
      outcome: 'failed',
      provider: 'grok',
    })
    expect(turnUsage('fx', 'cancelled', 'https://example.com/v1')).toEqual({
      agent: 'fx',
      outcome: 'stopped',
    })
  })

  test('an agent from agents.json is custom, never its name', () => {
    expect(usageAgent('custom:My Secret Agent')).toBe('custom')
    expect(usageAgent('claude')).toBe('claude')
  })
})
