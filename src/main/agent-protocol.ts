import * as acp from '@agentclientprotocol/sdk'
import type { AgentSetting, ModelSettings } from '../shared/types'
import type { AgentFailure } from './analytics-queue'

// How Gui reads what agents send where they differ from one another. No Electron here,
// so tests can load it on its own.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isChoice = (value: unknown): value is { value: string; name: string } =>
  isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string'

/** The values a select config option offers, with grouped lists flattened. */
function selectValues(option: unknown): string[] {
  if (!isRecord(option) || option.type !== 'select' || !Array.isArray(option.options)) return []
  const entries: unknown[] = option.options
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (typeof entry.value === 'string') return [entry.value]
    const choices: unknown[] = Array.isArray(entry.options) ? entry.options : []
    return choices.flatMap((choice) =>
      isRecord(choice) && typeof choice.value === 'string' ? [choice.value] : [],
    )
  })
}

/**
 * The session's ACP modes, unless they only mirror another of its settings: pi's adapter
 * reports its thinking levels as modes ("Thinking: high") as well as a `thought_level`
 * option, which the effort picker shows. Such modes aren't a mode to name in the header.
 */
export function displayedModes(
  modes: acp.SessionModeState | null | undefined,
  configOptions: acp.SessionConfigOption[] | null | undefined,
): acp.SessionModeState | null {
  if (!modes || !Array.isArray(modes.availableModes)) return modes ?? null
  const ids = modes.availableModes.map((mode) => mode.id)
  const options: unknown[] = Array.isArray(configOptions) ? configOptions : []
  const mirrored = options.some((option) => {
    if (!isRecord(option) || option.category === 'mode') return false
    if (option.currentValue !== modes.currentModeId) return false
    const values = selectValues(option)
    return values.length === ids.length && ids.every((id) => values.includes(id))
  })
  return mirrored ? null : modes
}

/**
 * The useful part of an agent's error. Many put it in `data` behind a generic "Internal
 * error": the ACP TypeScript SDK wraps anything an agent throws as `{ details }` (Codex),
 * the Go SDK as `{ error }` (jcode), and Codex reports a failed turn as `{ message }`.
 */
export function errorDetail(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const { data } = error
    const fields = isRecord(data) ? [data.details, data.error, data.message] : [data]
    const detail = fields.find(
      (field): field is string => typeof field === 'string' && !!field.trim(),
    )
    if (detail) return detail.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Known ways an agent's turn fails, in plain words, checked in order: a quota error can come
 * as a 429, so the account's limit is checked before the rate limit. Matched on the agent's
 * own text, which often carries the provider's raw JSON (`API Error: 529 {"type":"error",…}`).
 */
const PLAIN_ERRORS: [RegExp, AgentFailure, string][] = [
  [
    /context.?(?:length|window)|prompt is too long|input is too long|too many (?:input )?tokens|maximum context/i,
    'context_too_long',
    'This chat is too long for the agent. Start a new chat to keep going.',
  ],
  [
    /credit balance|billing|insufficient.?(?:quota|funds|credits?)|quota exceeded|payment required|\b402\b|usage limit/i,
    'no_credit',
    'Your agent account is out of credit or at its usage limit. Check its plan, then try again.',
  ],
  [/overloaded|\b529\b/i, 'servers_busy', 'The agent’s servers are busy. Try again in a minute.'],
  [
    /rate.?limit|too many requests|\b429\b/i,
    'rate_limited',
    'The agent is sending too many requests. Wait a minute, then try again.',
  ],
  [
    /(?:api error|status(?: code)?|http)[:\s]+5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|"api_error"/i,
    'server_error',
    'The agent’s servers had a problem. Try again in a minute.',
  ],
  [
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH)\b|socket hang up|network error|fetch failed|connection (?:error|refused|reset)|timed? ?out\b/i,
    'offline',
    'The agent couldn’t reach its servers. Check your internet connection, then try again.',
  ],
]

/**
 * What a failed turn's error means, in plain words, and its name for usage data; null when it
 * isn't one Gui knows.
 */
export function plainAgentError(detail: string): { failure: AgentFailure; message: string } | null {
  const known = PLAIN_ERRORS.find(([pattern]) => pattern.test(detail))
  return known ? { failure: known[1], message: known[2] } : null
}

/**
 * How the agent can pick an earlier session back up, best first. session/resume continues
 * it without sending the history again; session/load replays every message, which Gui
 * (keeping its own transcript) only drops.
 */
export function resumeMethods(
  capabilities: acp.AgentCapabilities | null | undefined,
): ('resume' | 'load')[] {
  const methods: ('resume' | 'load')[] = []
  if (isRecord(capabilities?.sessionCapabilities?.resume)) methods.push('resume')
  if (capabilities?.loadSession === true) methods.push('load')
  return methods
}

/**
 * The MCP servers Gui may pass the agent: ACP lets a client send HTTP servers only to an
 * agent that advertises `mcpCapabilities.http`, so one without it gets none of Gui's tools.
 */
export function mcpServersFor(
  capabilities: acp.AgentCapabilities | null | undefined,
  servers: acp.McpServer[],
): acp.McpServer[] {
  const http = capabilities?.mcpCapabilities?.http === true
  return servers.filter((server) => http || !('type' in server && server.type === 'http'))
}

/** A question Gui can ask on its permission card: one pick from a list. */
export interface FormQuestion {
  id: string
  /** The field's title: often a short heading ("Base branch"), sometimes the question */
  title: string | undefined
  /** The field's description: the question in full, when the form says it here */
  description: string | undefined
  /** Each choice's label, and what it means when the agent says (Claude's AskUserQuestion) */
  choices: { value: string; name: string; description?: string }[]
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)

/**
 * The questions in an elicitation form, or null when Gui can't ask them. Gui's card offers
 * buttons, not fields, so each question must be a single pick from a list. An optional field
 * without choices (OpenCode's "type your own answer" beside its choices) is left out, since
 * leaving it empty is a valid answer; a required one, or a multi-pick, makes the form one
 * Gui can't ask.
 */
export function formQuestions(requestedSchema: unknown): FormQuestion[] | null {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return null
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((key): key is string => typeof key === 'string')
      : [],
  )
  const questions: FormQuestion[] = []
  for (const [id, field] of Object.entries(requestedSchema.properties)) {
    const choices = isRecord(field) ? fieldChoices(field) : null
    if (!choices) {
      if (required.has(id)) return null
      continue
    }
    questions.push({
      id,
      title: isRecord(field) ? text(field.title) : undefined,
      description: isRecord(field) ? text(field.description) : undefined,
      choices,
    })
  }
  return questions.length ? questions : null
}

/** Not an ACP kind: the tool kind of an agent's own question, whose card shows its title as the question. */
export const QUESTION_KIND = 'question' as acp.ToolKind

/**
 * A permission request, or one of an agent's own questions put as one (`questionRequest`):
 * then what the form says beside the question, and what each choice means.
 */
export type PermissionRequest = Omit<acp.RequestPermissionRequest, 'options'> & {
  message?: string
  options: (acp.PermissionOption & { description?: string })[]
}

/**
 * One of a form's questions as a request for Gui's permission card: the question in full,
 * the form's message beside it when that says something else, and each choice with what it
 * means. Claude's AskUserQuestion puts a lone question in the form's message and only a short
 * heading in the field; with several, each field has its question and the message is the
 * form's own.
 */
export function questionRequest(
  sessionId: string,
  question: FormQuestion,
  message: string | undefined,
  /** One of several in the form: its message speaks for them all ("Please answer…"), so it isn't shown */
  several = false,
): PermissionRequest {
  const said = text(message)?.trim()
  const title = (
    question.description ??
    said ??
    question.title ??
    'The agent has a question'
  ).trim()
  return {
    sessionId,
    toolCall: {
      toolCallId: `question:${question.id}`,
      title,
      kind: QUESTION_KIND,
    },
    ...(said && said !== title && !several ? { message: said } : {}),
    // Skip first, so Auto mode never answers for the user (see `flaggedCaution`).
    options: [
      { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
      ...question.choices.map((choice, index) => ({
        optionId: String(index),
        name: choice.name,
        kind: 'answer' as acp.PermissionOptionKind,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    ],
  }
}

/** A field's choices, when it asks for a single pick from a list; otherwise null. */
function fieldChoices(field: Record<string, unknown>) {
  if (field.type !== 'string') return null
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const oneOf = list(field.oneOf).flatMap((option) =>
    isRecord(option) && typeof option.const === 'string'
      ? [
          {
            value: option.const,
            name: typeof option.title === 'string' ? option.title : option.const,
            ...(text(option.description) ? { description: text(option.description) } : {}),
          },
        ]
      : [],
  )
  if (oneOf.length) return oneOf
  const values = list(field.enum).filter((value): value is string => typeof value === 'string')
  return values.length ? values.map((value) => ({ value, name: value })) : null
}

/**
 * The model, effort and provider settings among an agent's session config options. Found by
 * category, since every agent names them differently (`effort`, `reasoning_effort`, …).
 * An agent may put other settings in the model category too (fx: its provider, and fast
 * mode, before the model), so one with the id `model` wins. The provider is one of those
 * others, named as one, with a choice to make. Null when the agent offers no model choice.
 */
export function parseModelSettings(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): ModelSettings | null {
  const inModels = (option: Record<string, unknown>) => option.category === 'model'
  const named = (option: Record<string, unknown>, name: string) =>
    [option.id, option.name].some((text) => typeof text === 'string' && text.toLowerCase() === name)
  const found =
    findSetting(configOptions, (option) => inModels(option) && option.id === 'provider') ??
    findSetting(configOptions, (option) => inModels(option) && named(option, 'provider'))
  const provider = found && found.options.length > 1 ? found : null
  const model =
    findSetting(configOptions, (option) => inModels(option) && option.id === 'model') ??
    findSetting(configOptions, (option) => inModels(option) && option.id !== found?.id)
  if (!model) return null
  return { model, effort: selectSetting(configOptions, 'thought_level'), provider }
}

export function selectSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  category: string,
): AgentSetting | null {
  return findSetting(configOptions, (option) => option.category === category)
}

/** The first select config option `match` accepts, with its choices flattened. */
export function findSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  match: (option: Record<string, unknown>) => boolean,
): AgentSetting | null {
  // Custom agents can send anything; a malformed list mustn't break the session.
  if (!Array.isArray(configOptions)) return null
  for (const option of configOptions) {
    if (!isRecord(option) || !match(option) || option.type !== 'select') continue
    if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) continue
    const entries: unknown[] = option.options
    // Grouped lists (e.g. by provider) are flattened; each choice keeps its group's name.
    const options = entries.flatMap((entry): AgentSetting['options'] => {
      if (isChoice(entry)) return [{ value: entry.value, name: entry.name, group: null }]
      if (!isRecord(entry) || !Array.isArray(entry.options)) return []
      const group = typeof entry.name === 'string' ? entry.name : null
      const choices: unknown[] = entry.options
      return choices.filter(isChoice).map(({ value, name }) => ({ value, name, group }))
    })
    return { id: option.id, value: option.currentValue, options }
  }
  return null
}
