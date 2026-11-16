import type { AgentId, AgentSetting, ModelSettings } from '../shared/types'
import { reportedModels } from './agent'
import { agentHealth } from './agent-status'
import { savedAgentSettings } from './prefs'

/** The agent's models before a session starts: its last check's list, with the user's choices. */
export function availableModels(agentId: AgentId): ModelSettings | null {
  const models = agentHealth.list().find((agent) => agent.id === agentId)?.models ?? null
  return models && withChoices(models, agentId, null)
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
