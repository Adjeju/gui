import { expect, test } from 'bun:test'
import {
  matchesWords,
  modelEntries,
  searchSections,
  searchWords,
  sections,
} from '../src/renderer/src/chat/model-search'
import type { AgentModelList } from '../src/shared/types'

const finds = (query: string, ...fields: string[]) => matchesWords(fields, searchWords(query))

test('every typed word appears in a field, in any case', () => {
  expect(finds('kimi', 'moonshotai/kimi-k3')).toBe(true)
  expect(finds('SON 4', 'Anthropic/Claude Sonnet 4.5')).toBe(true)
  expect(finds('deepseek flash', 'deepseek/deepseek-v4-flash')).toBe(true)
  expect(finds('glm 5.3', 'zai/glm-5.3')).toBe(true)
  expect(finds('glm-5.3', 'zai/glm-5.3')).toBe(true)
  expect(finds('gpt 6', 'openai/gpt-5')).toBe(false)
})

test('spaces, dashes, dots and slashes are loose', () => {
  expect(finds('glm5.3', 'zai/glm-5.3')).toBe(true)
  expect(finds('glm53', 'zai/glm-5.3')).toBe(true)
  expect(finds('kimik3', 'Kimi K3', 'moonshotai/kimi-k3')).toBe(true)
  expect(finds('opus-5.5', 'Anthropic/Claude Opus 5.5')).toBe(true)
  expect(finds('moonshotai/kimi', 'moonshotai/kimi-k3')).toBe(true)
})

test('words match within one field, not across two', () => {
  expect(finds('k3openai', 'Kimi K3', 'openai')).toBe(false)
})

test('nothing typed matches everything', () => {
  expect(finds('', 'anything')).toBe(true)
  expect(finds('   ', 'anything')).toBe(true)
})

const list = (
  options: { value: string; name: string; group?: string }[],
  provider: string | null = null,
): AgentModelList => ({
  model: {
    id: 'model',
    value: options[0].value,
    options: options.map((option) => ({ ...option, group: option.group ?? null })),
  },
  provider: provider
    ? {
        id: 'provider',
        value: provider,
        options: [{ value: provider, name: provider, group: null }],
      }
    : null,
})

const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  entries: modelEntries(
    { id: 'opencode', name: 'OpenCode' },
    list([
      { value: 'fw/kimi-k3', name: 'Kimi K3', group: 'fireworks-ai' },
      { value: 'fw/glm', name: 'GLM 5.3', group: 'fireworks-ai' },
      { value: 'oc/kimi-k3', name: 'Kimi K3', group: 'opencode' },
    ]),
  ),
}
const fx = {
  id: 'fx',
  name: 'fx',
  // Ungrouped "provider/model" names are grouped by that provider.
  entries: modelEntries(
    { id: 'fx', name: 'fx' },
    list(
      [
        { value: 'moonshot/kimi-k3', name: 'moonshot/Kimi K3' },
        { value: 'openai/gpt-5', name: 'openai/GPT-5' },
      ],
      'gateway',
    ),
  ),
}
const cursor = {
  id: 'cursor',
  name: 'Cursor',
  entries: modelEntries(
    { id: 'cursor', name: 'Cursor' },
    list([
      { value: 'kimi-k3', name: 'Kimi K3' },
      { value: 'auto', name: 'Auto' },
    ]),
  ),
}

test('search finds every agent’s models, under the agent and its provider, in the agents’ order', () => {
  const found = searchSections([opencode, fx, cursor], 'kimi')
  expect(found.map((section) => section.label)).toEqual([
    'OpenCode · fireworks-ai',
    'OpenCode · opencode',
    'fx · moonshot',
    'Cursor',
  ])
  expect(found.map((section) => section.agentId)).toEqual(['opencode', 'opencode', 'fx', 'cursor'])
  // Each row reads as the model alone, numbered in order across the sections.
  const rows = found.flatMap((section) => section.rows)
  expect(rows.map((row) => row.entry.label)).toEqual(['Kimi K3', 'Kimi K3', 'Kimi K3', 'Kimi K3'])
  expect(rows.map((row) => row.index)).toEqual([0, 1, 2, 3])
  // The same value under two agents (or providers) is two rows.
  expect(new Set(rows.map((row) => row.entry.key)).size).toBe(4)
  expect(rows[2].entry.provider).toBe('gateway')
})

test('search matches the agent’s name too, and every word somewhere', () => {
  const found = searchSections([opencode, fx, cursor], 'cursor kimi')
  expect(found.flatMap((section) => section.rows.map((row) => row.entry.key))).toEqual([
    JSON.stringify(['cursor', null, 'kimi-k3']),
  ])
  expect(searchSections([opencode, fx, cursor], 'nothing like it')).toEqual([])
})

test('one agent’s models group by provider, with no header when there are none', () => {
  expect(sections(opencode.entries).map((section) => section.label)).toEqual([
    'fireworks-ai',
    'opencode',
  ])
  expect(sections(cursor.entries).map((section) => section.label)).toEqual([null])
})
