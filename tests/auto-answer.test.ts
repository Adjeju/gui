import { describe, expect, test } from 'bun:test'
import { autoAnswersFor } from '../src/shared/auto-answer'
import type { TurnItem } from '../src/shared/types'

// What the cards still waiting get when Auto is switched on (`autoAnswersFor`).

type PermissionItem = Extract<TurnItem, { kind: 'permission' }>

const ASK_OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
]

function card(id: string, toolKind = 'execute', more: Partial<PermissionItem> = {}): TurnItem {
  return {
    kind: 'permission',
    id,
    title: `run ${id}`,
    toolKind,
    locations: [],
    sensitive: false,
    options: ASK_OPTIONS,
    resolved: null,
    ...more,
  }
}

const question = (id: string) =>
  card(id, 'question', {
    options: [
      { optionId: 'a', name: 'Red', kind: 'answer' },
      { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
    ],
  })
const plan = (id: string) => card(id, 'switch_mode')
const text = (id: string): TurnItem => ({ kind: 'text', id, text: 'Working on it.' })

describe('switching Auto on answers the cards waiting', () => {
  const waitingOnly = (item: PermissionItem) => item.resolved === null

  test('a waiting request Auto would approve gets "allow once", never "always"', () => {
    expect(autoAnswersFor([card('a')], waitingOnly)).toEqual([{ itemId: 'a', optionId: 'yes' }])
  })

  test("the agent's questions and Claude's plan approval keep waiting", () => {
    const items = [question('q'), plan('p'), card('a', 'edit')]
    expect(autoAnswersFor(items, waitingOnly)).toEqual([{ itemId: 'a', optionId: 'yes' }])
  })

  test('cards already answered, and requests with no "allow once", are left alone', () => {
    const always = [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]
    const items = [
      card('a', 'execute', { resolved: 'no' }),
      card('b', 'execute', { options: always }),
    ]
    expect(autoAnswersFor(items, waitingOnly)).toEqual([])
  })

  test('only cards the agent is still waiting on', () => {
    const items = [card('a'), card('b')]
    expect(autoAnswersFor(items, (item) => item.id === 'b')).toEqual([
      { itemId: 'b', optionId: 'yes' },
    ])
  })
})
