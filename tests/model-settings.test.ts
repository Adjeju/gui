import { describe, expect, test } from 'bun:test'
import type * as acp from '@agentclientprotocol/sdk'

import { parseModelSettings } from '../src/main/agent-protocol'

const select = (
  id: string,
  category: string,
  currentValue: string,
  values: string[],
  name = id,
): acp.SessionConfigOption =>
  ({
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  }) as acp.SessionConfigOption

const choices = (values: string[]) => values.map((value) => ({ value, name: value, group: null }))

describe('parseModelSettings', () => {
  // As fx 0.0.16 reports a new session: its provider before its model, both in `model`.
  const fx = [
    select('provider', 'model', 'gateway', ['gateway', 'codex', 'grok'], 'Provider'),
    select('model', 'model', 'gpt-5', ['gpt-5', 'claude-opus']),
    select('mode', 'mode', 'default', ['default', 'plan']),
    select('effort', 'thought_level', 'auto', ['auto', 'low', 'high', 'max']),
  ]

  test('finds the provider beside the model and effort', () => {
    expect(parseModelSettings(fx)).toEqual({
      model: { id: 'model', value: 'gpt-5', options: choices(['gpt-5', 'claude-opus']) },
      effort: { id: 'effort', value: 'auto', options: choices(['auto', 'low', 'high', 'max']) },
      provider: {
        id: 'provider',
        value: 'gateway',
        options: choices(['gateway', 'codex', 'grok']),
      },
    })
  })

  test('none for agents without one', () => {
    const plain = [select('model', 'model', 'sonnet', ['sonnet', 'opus'])]
    expect(parseModelSettings(plain)?.provider).toBeNull()
    // Another model-category setting isn't a provider unless it's called one (fx's fast mode).
    const fast = [
      select('fast', 'model', 'off', ['off', 'on'], 'Fast mode'),
      select('model', 'model', 'sonnet', ['sonnet', 'opus']),
    ]
    expect(parseModelSettings(fast)?.provider).toBeNull()
    expect(parseModelSettings(fast)?.model.id).toBe('model')
  })

  test('by name under another id, and never taken for the model', () => {
    const named = [
      select('backend', 'model', 'a', ['a', 'b'], 'Provider'),
      select('llm', 'model', 'x', ['x', 'y']),
    ]
    const models = parseModelSettings(named)
    expect(models?.provider?.id).toBe('backend')
    expect(models?.model.id).toBe('llm')
  })

  test('none when malformed or with nothing to choose', () => {
    const model = select('model', 'model', 'gpt-5', ['gpt-5'])
    const one = [select('provider', 'model', 'gateway', ['gateway']), model]
    expect(parseModelSettings(one)?.provider).toBeNull()
    expect(parseModelSettings(one)?.model.id).toBe('model')
    const broken = [
      { id: 'provider', name: 'Provider', category: 'model', type: 'select', options: 'gateway' },
      { id: 'provider', category: 'model', type: 'boolean', currentValue: true },
      null,
      model,
    ] as unknown as acp.SessionConfigOption[]
    expect(parseModelSettings(broken)?.provider).toBeNull()
    expect(parseModelSettings(broken)?.model.id).toBe('model')
    // A provider alone isn't a model choice.
    expect(parseModelSettings([fx[0] as acp.SessionConfigOption])).toBeNull()
  })
})
