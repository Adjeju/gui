import { readFileSync } from 'node:fs'
import { MAX_CACHED_MODEL_AGENTS, MAX_CACHED_MODELS, MAX_MODEL_TEXT } from '../shared/bounded'
import {
  type AgentId,
  type AgentModelList,
  type AgentSetting,
  isAgentId,
  type ModelSettings,
} from '../shared/types'
import { CoalescedFile, type FileLayer } from './coalesced-file'

const VERSION = 1

const text = (value: unknown, empty = false): value is string =>
  typeof value === 'string' && (empty || value.length > 0) && value.length <= MAX_MODEL_TEXT

/** A setting as the file has it: its well-formed choices, at most MAX_CACHED_MODELS. */
function setting(value: unknown): AgentSetting | null {
  const { id, value: selected, options } = (value ?? {}) as Record<string, unknown>
  if (!text(id) || !text(selected, true) || !Array.isArray(options)) return null
  const kept: AgentSetting['options'] = []
  for (const option of options) {
    if (kept.length >= MAX_CACHED_MODELS) break
    const { value: choice, name, group } = (option ?? {}) as Record<string, unknown>
    if (!text(choice) || !text(name) || !(group === null || text(group))) continue
    kept.push({ value: choice, name, group })
  }
  return { id, value: selected, options: kept }
}

/** Only what listing needs: names, values and groups (no effort). */
export function listOf(models: ModelSettings | AgentModelList): AgentModelList {
  const trim = (s: AgentSetting): AgentSetting => ({
    id: s.id,
    value: s.value,
    options: s.options.slice(0, MAX_CACHED_MODELS),
  })
  return { model: trim(models.model), provider: models.provider && trim(models.provider) }
}

/**
 * What the file holds for one agent: its list (null for an agent whose check found none to
 * list, kept only for its time), and when a check last found it (null in files from before
 * times were kept: due for a check).
 */
export type CachedModels = { list: AgentModelList | null; checkedAt: number | null }

const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/** The file's entries, by agent: the well-formed ones, at most MAX_CACHED_MODEL_AGENTS. */
export function parseModelCache(raw: unknown): Map<AgentId, CachedModels> {
  const entries = new Map<AgentId, CachedModels>()
  const { version, agents } = (raw ?? {}) as Record<string, unknown>
  if (version !== VERSION || !agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return entries
  }
  for (const [id, entry] of Object.entries(agents)) {
    if (entries.size >= MAX_CACHED_MODEL_AGENTS) break
    if (!isAgentId(id)) continue
    const fields = (entry ?? {}) as Record<string, unknown>
    const checkedAt = time(fields.checkedAt)
    if (fields.model === undefined) {
      // No list, only when it was last checked.
      if (checkedAt !== null) entries.set(id, { list: null, checkedAt })
      continue
    }
    const model = setting(fields.model)
    const provider = fields.provider === null ? null : setting(fields.provider)
    if (!model || (fields.provider !== null && !provider)) continue
    entries.set(id, { list: { model, provider }, checkedAt })
  }
  return entries
}

/**
 * Each agent's model list as its last check found it, kept between launches so the picker can
 * list and search them before this launch's checks finish. Only for listing: whether the agent
 * can take a message is its check's to say.
 */
export class ModelCache {
  private entries: Map<AgentId, CachedModels> | null = null
  private writer: CoalescedFile

  constructor(
    private readonly file: () => string,
    files: FileLayer,
  ) {
    this.writer = new CoalescedFile(
      () =>
        JSON.stringify({
          version: VERSION,
          agents: Object.fromEntries(
            [...this.all()].map(([id, { list, checkedAt }]) => [
              id,
              list ? { ...list, checkedAt } : { checkedAt },
            ]),
          ),
        }),
      files,
      (error) => console.error('[gui] failed to save the agents’ models', error),
    )
  }

  private all() {
    if (!this.entries) {
      try {
        this.entries = parseModelCache(JSON.parse(readFileSync(this.file(), 'utf8')))
      } catch {
        this.entries = new Map()
      }
    }
    return this.entries
  }

  get(id: AgentId): AgentModelList | null {
    return this.all().get(id)?.list ?? null
  }

  /**
   * Whether a check found the agent less than `maxAge` ago. A time from before the file kept
   * times, or one in the future (the clock was changed), isn't.
   */
  fresh(id: AgentId, now: number, maxAge: number) {
    const checkedAt = this.all().get(id)?.checkedAt ?? null
    return checkedAt !== null && checkedAt <= now && now - checkedAt < maxAge
  }

  /**
   * Remembers `models` as the agent's list, found by a check at `now`; the newest
   * MAX_CACHED_MODEL_AGENTS agents are kept. The same list again still moves its time.
   */
  set(id: AgentId, models: ModelSettings | AgentModelList, now: number) {
    const list = listOf(models)
    const current = this.all().get(id)
    if (current?.list && JSON.stringify(current.list) === JSON.stringify(list)) {
      if (current.checkedAt === now) return
      current.checkedAt = now
      this.writer.changed()
      return
    }
    this.put(id, { list, checkedAt: now })
  }

  /**
   * A check at `now` found the agent but no models to list (not signed in, or it has none). Its
   * time moves, so the background checks don't start it again for nothing; a list it has stays.
   */
  checkedWithout(id: AgentId, now: number) {
    const current = this.all().get(id)
    if (!current) return this.put(id, { list: null, checkedAt: now })
    if (current.checkedAt === now) return
    current.checkedAt = now
    this.writer.changed()
  }

  delete(id: AgentId) {
    if (this.all().delete(id)) this.writer.changed()
  }

  /** At quit: what the file doesn't hold yet. */
  flushSync() {
    this.writer.flushSync()
  }

  private put(id: AgentId, entry: CachedModels) {
    const entries = this.all()
    entries.delete(id)
    entries.set(id, entry)
    while (entries.size > MAX_CACHED_MODEL_AGENTS) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    this.writer.changed()
  }
}
