import { MAX_MODEL_TEXT, MAX_RECENT_MODELS } from './bounded'
import { type AgentId, type AgentSetting, isAgentId, type RecentModel } from './types'

const same = (a: RecentModel, b: RecentModel) =>
  a.agentId === b.agentId && a.model === b.model && a.provider === b.provider

/** `entry` first, without its older copy, keeping the newest `max`. */
export function withRecent(
  list: readonly RecentModel[],
  entry: RecentModel,
  max = MAX_RECENT_MODELS,
): RecentModel[] {
  return [entry, ...list.filter((recent) => !same(recent, entry))].slice(0, Math.max(0, max))
}

const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_MODEL_TEXT

/** Recent models as prefs.json has them: the well-formed ones, each once, at most `max`. */
export function parseRecents(value: unknown, max = MAX_RECENT_MODELS): RecentModel[] {
  if (!Array.isArray(value)) return []
  const list: RecentModel[] = []
  for (const item of value) {
    const { agentId, model, provider } = (item ?? {}) as Record<string, unknown>
    if (!isAgentId(agentId) || !text(model) || !(provider === null || text(provider))) continue
    const entry = { agentId, model, provider }
    if (!list.some((recent) => same(recent, entry))) list.push(entry)
    if (list.length >= max) break
  }
  return list
}

/**
 * The recents the picker shows, newest first, each with its model's name: ones whose agent
 * isn't `listed` (switched off) or whose model `models` doesn't find (no longer listed, or
 * under a provider whose list isn't known) are left out.
 */
export function listedRecents(
  list: readonly RecentModel[],
  listed: (agentId: AgentId) => boolean,
  models: (agentId: AgentId, provider: string | null) => AgentSetting | null,
): (RecentModel & { name: string })[] {
  return list.flatMap((recent) => {
    if (!listed(recent.agentId)) return []
    const option = models(recent.agentId, recent.provider)?.options.find(
      (choice) => choice.value === recent.model,
    )
    return option ? [{ ...recent, name: option.name }] : []
  })
}
