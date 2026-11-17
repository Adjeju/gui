import { listedRecents } from '../shared/recent-models'
import type {
  AgentChoice,
  AgentId,
  AgentModelList,
  AgentSetting,
  ChatMeta,
  ModelSettings,
} from '../shared/types'
import { reportedModels } from './agent'
import { agentHealth } from './agent-status'
import { agentChoices } from './agents'
import { listOf } from './model-cache'
import { getPrefs, savedAgentSettings } from './prefs'

/** The agent's models before a session starts: its last check's list, with the user's choices. */
export function availableModels(agentId: AgentId): ModelSettings | null {
  const models = agentHealth.list().find((agent) => agent.id === agentId)?.models ?? null
  return models && withChoices(models, agentId, null)
}

/**
 * Another agent's models for the picker: its list (its check's, or the last one remembered)
 * with the user's saved provider and model applied. Null while it can't be listed.
 */
export function listedModels(agentId: AgentId): AgentModelList | null {
  const models = agentHealth.listedModels(agentId)
  if (!models) return null
  const { model, provider } = withChoices({ effort: null, ...models }, agentId, null)
  return listOf({ model, provider })
}

/**
 * The models `agentId` lists under `provider` (null for an agent without providers): the
 * chat's own list for its agent, else the agent's listed one, or a provider's list a session
 * reported this launch. Null when not known.
 */
export function modelsUnder(
  agentId: AgentId,
  provider: string | null,
  own: { agentId: AgentId; models: ModelSettings | null } | null = null,
): AgentSetting | null {
  const lists = [own?.agentId === agentId ? own.models : null, agentHealth.listedModels(agentId)]
  for (const list of lists) {
    if (!list) continue
    if ((list.provider?.value ?? null) === provider) return list.model
  }
  if (provider === null) return null
  return reportedModels(agentId, provider)?.model ?? null
}

/**
 * What the chat's picker lists besides its own agent's models: the agents with theirs, and the
 * recent models still on offer.
 */
export function pickerFields(
  agentId: AgentId,
  models: ModelSettings | null,
): Pick<ChatMeta, 'agents' | 'recentModels'> {
  const health = agentHealth.list()
  const agents: AgentChoice[] = agentChoices(health, agentId).map((choice) =>
    choice.id === agentId ? choice : { ...choice, models: listedModels(choice.id) },
  )
  const enabled = (id: AgentId) =>
    agents.some((agent) => agent.id === id) &&
    (health.find((agent) => agent.id === id)?.enabled ?? false)
  const own = { agentId, models }
  const recentModels = listedRecents(getPrefs().recentModels, enabled, (id, provider) =>
    modelsUnder(id, provider, own),
  )
  return { agents, recentModels }
}

/** Whether `value` is one of the choices `models` lists for its setting `settingId`. */
export function offersChoice(models: ModelSettings | null, settingId: string, value: string) {
  const setting = [models?.model, models?.effort, models?.provider].find((s) => s?.id === settingId)
  return setting?.options.some((option) => option.value === value) ?? false
}

/**
 * `models` with the user's saved choices for `agentId` applied, where they still apply. A
 * saved provider other than the one `models` is on brings that provider's model list, once a
 * session of the agent has reported it; until then the provider stays as it is, with its list.
 */
export function withChoices(
  models: ModelSettings,
  agentId: AgentId,
  refused: Map<string, string> | null,
): ModelSettings {
  const saved = savedAgentSettings(agentId)
  const provider = models.provider && chosenValue(models.provider, saved, refused)
  const listed =
    (provider && provider !== models.provider?.value && reportedModels(agentId, provider)) || models
  const apply = (setting: AgentSetting) => ({
    ...setting,
    value: chosenValue(setting, saved, refused) ?? setting.value,
  })
  return {
    model: apply(listed.model),
    effort: listed.effort && apply(listed.effort),
    provider: listed.provider,
  }
}

/** The user's saved choice for `setting`, when it's still on offer and wasn't refused. */
export function chosenValue(
  setting: AgentSetting,
  saved: Record<string, string>,
  refused: Map<string, string> | null,
) {
  const value = Object.hasOwn(saved, setting.id) ? saved[setting.id] : undefined
  if (value === undefined || refused?.get(setting.id) === value) return null
  return setting.options.some((option) => option.value === value) ? value : null
}
