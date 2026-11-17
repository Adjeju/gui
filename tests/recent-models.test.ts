import { expect, test } from 'bun:test'
import { MAX_RECENT_MODELS } from '../src/shared/bounded'
import { listedRecents, parseRecents, withRecent } from '../src/shared/recent-models'
import type { AgentSetting, RecentModel } from '../src/shared/types'

// The model picker's Recent (prefs.json `recentModels`): newest first, each once, capped, and
// shown only while its agent is on and still lists the model.

const recent = (agentId: string, model: string, provider: string | null = null): RecentModel => ({
  agentId,
  model,
  provider,
})

test('the newest goes first, and a model picked again moves up rather than repeating', () => {
  let list: RecentModel[] = []
  list = withRecent(list, recent('claude', 'opus'))
  list = withRecent(list, recent('codex', 'gpt-5'))
  list = withRecent(list, recent('opencode', 'kimi', null))
  list = withRecent(list, recent('claude', 'opus'))
  expect(list).toEqual([
    recent('claude', 'opus'),
    recent('opencode', 'kimi'),
    recent('codex', 'gpt-5'),
  ])
})

test('the same model under another provider is another recent', () => {
  let list = withRecent([], recent('fx', 'kimi', 'gateway'))
  list = withRecent(list, recent('fx', 'kimi', 'codex'))
  expect(list).toHaveLength(2)
})

test('it keeps the newest MAX_RECENT_MODELS', () => {
  let list: RecentModel[] = []
  for (let i = 0; i < MAX_RECENT_MODELS + 5; i++) list = withRecent(list, recent('claude', `m${i}`))
  expect(list).toHaveLength(MAX_RECENT_MODELS)
  expect(list[0].model).toBe(`m${MAX_RECENT_MODELS + 4}`)
  expect(list.at(-1)?.model).toBe('m5')
})

test('from prefs.json: the well-formed ones, each once, capped', () => {
  const parsed = parseRecents([
    recent('claude', 'opus'),
    { agentId: 'claude', model: 'opus', provider: null },
    { agentId: 'nobody', model: 'x', provider: null },
    { agentId: 'codex', model: '', provider: null },
    { agentId: 'codex', model: 'gpt-5' },
    { agentId: 'codex', model: 'gpt-5', provider: 7 },
    'junk',
    null,
    recent('fx', 'kimi', 'gateway'),
    ...Array.from({ length: 20 }, (_, i) => recent('claude', `m${i}`)),
  ])
  expect(parsed.slice(0, 2)).toEqual([recent('claude', 'opus'), recent('fx', 'kimi', 'gateway')])
  expect(parsed).toHaveLength(MAX_RECENT_MODELS)
  expect(parseRecents({})).toEqual([])
})

const setting = (...values: string[]): AgentSetting => ({
  id: 'model',
  value: values[0],
  options: values.map((value) => ({ value, name: value.toUpperCase(), group: null })),
})

test('shown with their names, without agents switched off or models no longer listed', () => {
  const list = [
    recent('claude', 'opus'),
    recent('off', 'x'),
    recent('codex', 'gone'),
    recent('fx', 'kimi', 'codex'),
    recent('fx', 'grok', 'unknown-provider'),
    recent('codex', 'gpt-5'),
  ]
  const shown = listedRecents(
    list,
    (agentId) => agentId !== 'off',
    (agentId, provider) =>
      agentId === 'claude'
        ? setting('opus', 'sonnet')
        : agentId === 'codex'
          ? setting('gpt-5')
          : agentId === 'fx' && provider === 'codex'
            ? setting('kimi')
            : null,
  )
  expect(shown).toEqual([
    { ...recent('claude', 'opus'), name: 'OPUS' },
    { ...recent('fx', 'kimi', 'codex'), name: 'KIMI' },
    { ...recent('codex', 'gpt-5'), name: 'GPT-5' },
  ])
})
