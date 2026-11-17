import type { AgentId, AgentModelList, AgentSetting } from '../../../shared/types'

/** Spaces, dashes, dots, slashes and the like: model names and ids spell them differently. */
const SEPARATORS = /[\s\-_./:]+/g

const compact = (text: string) => text.replace(SEPARATORS, '')

/** The typed words, in lower case. */
export function searchWords(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Every typed word appears in one of `fields`, ignoring case, and ignoring separators so
 * "glm5.3" finds "zai/glm-5.3" and "kimik3" finds "Kimi K3".
 */
export function matchesWords(fields: string[], words: string[]) {
  if (words.length === 0) return true
  const texts = fields.map((field) => field.toLowerCase())
  const compacted = texts.map(compact)
  return words.every((word) => {
    if (texts.some((text) => text.includes(word))) return true
    const bare = compact(word)
    return bare === '' || compacted.some((text) => text.includes(bare))
  })
}

type Choice = AgentSetting['options'][number]

/** A model in the picker, of any agent. */
export interface ModelEntry {
  /** Unique across agents and providers */
  key: string
  agentId: AgentId
  agentName: string
  value: string
  /** The provider it's under, for an agent with providers */
  provider: string | null
  /** In its row */
  label: string
  /** In full, for the tooltip and the search */
  name: string
  group: string | null
}

export const rowKey = (agentId: AgentId, provider: string | null, value: string) =>
  JSON.stringify([agentId, provider, value])

/**
 * "OpenCode Zen/Big Pickle" reads as "Big Pickle", and "Default (recommended)" as "Default";
 * the picker keeps the full name.
 */
export function shortName(name: string) {
  const last = name.split('/').at(-1)?.trim() || name
  return last.replace(/\s*\(recommended\)$/i, '') || last
}

/** Under its provider's header, "Anthropic/Claude Sonnet 4" reads as "Claude Sonnet 4". */
function rowName(choice: Choice) {
  const prefix = choice.group && `${choice.group}/`
  if (!prefix || !choice.name.startsWith(prefix)) return choice.name
  return choice.name.slice(prefix.length).trim() || choice.name
}

/**
 * Ungrouped models all named `provider/model` (fx's "openai/gpt-5") are grouped by that
 * provider, so each row reads as the model alone under its provider's header.
 */
function withProviderGroups(choices: Choice[]): Choice[] {
  if (choices.some((choice) => choice.group !== null || !/^[^/\s]+\/./.test(choice.name))) {
    return choices
  }
  return choices.map((choice) => ({ ...choice, group: choice.name.split('/')[0] }))
}

/** An agent's models as the picker's rows. */
export function modelEntries(
  agent: { id: AgentId; name: string },
  list: AgentModelList,
): ModelEntry[] {
  const provider = list.provider?.value ?? null
  return withProviderGroups(list.model.options).map((choice) => ({
    key: rowKey(agent.id, provider, choice.value),
    agentId: agent.id,
    agentName: agent.name,
    value: choice.value,
    provider,
    label: rowName(choice),
    name: choice.name,
    group: choice.group,
  }))
}

/** Every typed word appears somewhere in the name, value, group or agent (see matchesWords). */
export function matchesEntry(entry: ModelEntry, words: string[]) {
  return matchesWords([entry.name, entry.value, entry.group ?? '', entry.agentName], words)
}

export interface Section {
  key: string
  /** Its header's agent mark, in search results */
  agentId: AgentId | null
  /** Its header; null for a list without groups */
  label: string | null
  /** Each row numbered in order across the sections */
  rows: { entry: ModelEntry; index: number }[]
}

function numbered(groups: Omit<Section, 'rows'>[], lists: ModelEntry[][]): Section[] {
  let index = 0
  return groups.map((group, at) => ({
    ...group,
    rows: lists[at].map((entry) => ({ entry, index: index++ })),
  }))
}

function byGroup(entries: ModelEntry[]) {
  const groups = new Map<string | null, ModelEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.group)
    if (list) list.push(entry)
    else groups.set(entry.group, [entry])
  }
  return groups
}

/**
 * One agent's models under their group's header, groups in the order they first appear.
 * Without groups there's one section and no header.
 */
export function sections(entries: ModelEntry[]): Section[] {
  const grouped = entries.some((entry) => entry.group !== null)
  const groups = [...byGroup(entries)]
  return numbered(
    groups.map(([group]) => ({
      key: group ?? '',
      agentId: null,
      label: grouped ? (group ?? 'Other') : null,
    })),
    groups.map(([, list]) => list),
  )
}

/**
 * What `query` finds in every agent's models, in the agents' order: under the agent and then
 * its group ("OpenCode · fireworks-ai"), or the agent alone when it has no groups.
 */
export function searchSections(
  agents: { id: AgentId; name: string; entries: ModelEntry[] }[],
  query: string,
): Section[] {
  const words = searchWords(query)
  const heads: Omit<Section, 'rows'>[] = []
  const lists: ModelEntry[][] = []
  for (const agent of agents) {
    const grouped = agent.entries.some((entry) => entry.group !== null)
    const found = agent.entries.filter((entry) => matchesEntry(entry, words))
    for (const [group, list] of byGroup(found)) {
      heads.push({
        key: JSON.stringify([agent.id, group]),
        agentId: agent.id,
        label: grouped ? `${agent.name} · ${group ?? 'Other'}` : agent.name,
      })
      lists.push(list)
    }
  }
  return numbered(heads, lists)
}
