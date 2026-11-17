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

/** The file's lists, by agent: the well-formed ones, at most MAX_CACHED_MODEL_AGENTS. */
export function parseModelCache(raw: unknown): Map<AgentId, AgentModelList> {
  const lists = new Map<AgentId, AgentModelList>()
  const { version, agents } = (raw ?? {}) as Record<string, unknown>
  if (version !== VERSION || !agents || typeof agents !== 'object' || Array.isArray(agents)) {
    return lists
  }
  for (const [id, entry] of Object.entries(agents)) {
    if (lists.size >= MAX_CACHED_MODEL_AGENTS) break
    if (!isAgentId(id)) continue
    const fields = (entry ?? {}) as Record<string, unknown>
    const model = setting(fields.model)
    const provider = fields.provider === null ? null : setting(fields.provider)
    if (!model || (fields.provider !== null && !provider)) continue
    lists.set(id, { model, provider })
  }
  return lists
}

/**
 * Each agent's model list as its last check found it, kept between launches so the picker can
 * list and search them before this launch's checks finish. Only for listing: whether the agent
 * can take a message is its check's to say.
 */
export class ModelCache {
  private lists: Map<AgentId, AgentModelList> | null = null
  private writer: CoalescedFile

  constructor(
    private readonly file: () => string,
    files: FileLayer,
  ) {
    this.writer = new CoalescedFile(
      () => JSON.stringify({ version: VERSION, agents: Object.fromEntries(this.all()) }),
      files,
      (error) => console.error('[gui] failed to save the agents’ models', error),
    )
  }

  private all() {
    if (!this.lists) {
      try {
        this.lists = parseModelCache(JSON.parse(readFileSync(this.file(), 'utf8')))
      } catch {
        this.lists = new Map()
      }
    }
    return this.lists
  }

  get(id: AgentId): AgentModelList | null {
    return this.all().get(id) ?? null
  }

  /** Remembers `models` as the agent's list; the newest MAX_CACHED_MODEL_AGENTS agents are kept. */
  set(id: AgentId, models: ModelSettings | AgentModelList) {
    const lists = this.all()
    const list = listOf(models)
    if (JSON.stringify(lists.get(id)) === JSON.stringify(list)) return
    lists.delete(id)
    lists.set(id, list)
    while (lists.size > MAX_CACHED_MODEL_AGENTS) {
      const oldest = lists.keys().next().value
      if (oldest === undefined) break
      lists.delete(oldest)
    }
    this.writer.changed()
  }

  /** At quit: what the file doesn't hold yet. */
  flushSync() {
    this.writer.flushSync()
  }
}
