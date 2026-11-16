import { bounded, MAX_QUEUED_USAGE_EVENTS, USAGE_BATCH } from '../shared/bounded'
import { AGENTS, type AgentId, type TurnStatus } from '../shared/types'

/**
 * Every usage event Gui sends, and what each carries. Nothing else is ever sent: no paths,
 * project or file names, addresses, prompts, replies, or code. usegui.com (www/worker.js)
 * keeps the same list and drops anything that isn't on it.
 */
export interface UsageEvents {
  app_opened: { version: string; os: string; osVersion: string; arch: string }
  /** `agent`: a built-in agent's id, or `custom`; `provider`: its model provider, if it has one */
  turn_finished: { agent: string; outcome: 'done' | 'failed' | 'stopped'; provider?: string }
  project_opened: undefined
  canvas_created: undefined
  preview_opened: undefined
  agent_connected: { agent: string }
  update_installed: { from: string; to: string }
}
export type UsageEventName = keyof UsageEvents
export type UsageProps<E extends UsageEventName> = UsageEvents[E] extends undefined
  ? []
  : [props: UsageEvents[E]]

/** An agent as usage data has it: a built-in agent's id; one from agents.json is `custom`. */
export function usageAgent(id: AgentId) {
  return AGENTS.some((agent) => agent.id === id) ? id : 'custom'
}

/** A provider setting's value is a short name (`codex`, `grok`); anything else isn't sent. */
const PROVIDER = /^[a-z][\w-]{0,39}$/i

export function turnUsage(
  agent: AgentId,
  status: TurnStatus,
  provider?: string,
): UsageEvents['turn_finished'] {
  const outcome = status === 'done' ? 'done' : status === 'error' ? 'failed' : 'stopped'
  const kept = provider && PROVIDER.test(provider) ? { provider } : {}
  return { agent: usageAgent(agent), outcome, ...kept }
}

interface Queued {
  event: UsageEventName
  /** When it happened, ms since the epoch */
  at: number
  props?: Record<string, string>
}

/** What a send got back: enough of a fetch Response. */
export interface UsageReply {
  status: number
  json(): Promise<unknown>
}

export interface UsageQueueOptions {
  /** An official release (official-build.ts); every other build never sends */
  official: boolean
  /** Settings → Account → Share usage data */
  enabled(): boolean
  /** The install's random ID, read (or made) the first time a batch goes */
  installId(): string
  /** POSTs `body` to usegui.com/t/v1 */
  post(body: string, signal: AbortSignal): Promise<UsageReply>
  now?: () => number
}

/**
 * Usage events, held in memory until a flush sends them in batches. Bounded: past
 * MAX_QUEUED_USAGE_EVENTS the oldest go, whether they were never sent or a send failed and
 * kept them for the next try. A batch the site refused isn't tried again. The site can say
 * `{ stop: true }`, after which nothing more is kept or sent until Gui next launches.
 */
export function usageQueue(options: UsageQueueOptions) {
  const now = options.now ?? Date.now
  let queue: Queued[] = []
  let stopped = false
  let sending: Promise<void> | null = null

  const sends = () => options.official && !stopped && options.enabled()

  const keep = (events: Queued[]) => {
    queue = bounded(events, MAX_QUEUED_USAGE_EVENTS)
  }

  /** Sends what's queued, a batch at a time, until it's all sent or a send fails. */
  async function send(signal: AbortSignal) {
    while (queue.length > 0 && sends() && !signal.aborted) {
      const batch = queue.slice(0, USAGE_BATCH)
      queue = queue.slice(batch.length)
      const body = JSON.stringify({ installId: options.installId(), events: batch })
      let reply: UsageReply
      try {
        reply = await options.post(body, signal)
      } catch {
        // Offline, or the quit's wait ran out: tried again at the next flush.
        keep([...batch, ...queue])
        return
      }
      if (reply.status >= 500 || reply.status === 429) {
        keep([...batch, ...queue])
        return
      }
      // Anything else that isn't a success is a batch the site won't take; it's dropped.
      if (reply.status === 200) {
        const answer = await reply.json().catch(() => null)
        if (answer && typeof answer === 'object' && (answer as { stop?: unknown }).stop === true) {
          stopped = true
          queue = []
        }
      }
    }
  }

  return {
    track<E extends UsageEventName>(event: E, ...[props]: UsageProps<E>) {
      if (!sends()) return
      keep([...queue, props ? { event, at: now(), props: { ...props } } : { event, at: now() }])
    },

    /** Sends what's queued; a flush already under way is joined. `timeoutMs` bounds it. */
    flush(timeoutMs = 10_000): Promise<void> {
      if (!sends()) {
        queue = []
        return Promise.resolve()
      }
      sending ??= send(AbortSignal.timeout(timeoutMs)).finally(() => {
        sending = null
      })
      return sending
    },

    /** Share usage data switched off: what's queued goes at once. */
    clear() {
      queue = []
    },

    /** Events waiting to be sent */
    get size() {
      return queue.length
    },

    /** The site said to stop for this launch. */
    get stopped() {
      return stopped
    },
  }
}

export type UsageQueue = ReturnType<typeof usageQueue>
