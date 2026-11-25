import { describe, expect, test } from 'bun:test'
import { autoAnswersFor, offersAuto } from '../src/shared/auto-answer'
import type { TurnItem } from '../src/shared/types'

// When a permission card in Ask mode offers to turn on Auto (`offersAuto`), and what the
// cards still waiting get when Auto is switched on (`autoAnswersFor`).

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

describe('the card offers Auto', () => {
  test('from the third request answered by hand in the turn, not before', () => {
    const items = [card('a'), text('t'), card('b'), card('c'), card('d')]
    expect(offersAuto(items, 'a')).toBe(false)
    expect(offersAuto(items, 'b')).toBe(false)
    expect(offersAuto(items, 'c')).toBe(true)
    expect(offersAuto(items, 'd')).toBe(true)
  })

  test('requests of any kind Auto would answer count: edits, commands, tools', () => {
    const items = [card('a', 'edit'), card('b', 'other'), card('c', 'fetch')]
    expect(offersAuto(items, 'c')).toBe(true)
  })

  test("never on the agent's own question or Claude's plan approval", () => {
    const items = [card('a'), card('b'), card('c'), question('q'), plan('p')]
    expect(offersAuto(items, 'q')).toBe(false)
    expect(offersAuto(items, 'p')).toBe(false)
  })

  test("questions and plan approvals don't count toward it", () => {
    const items = [question('q1'), plan('p'), card('a'), question('q2'), card('b')]
    expect(offersAuto(items, 'b')).toBe(false)
    expect(offersAuto([...items, card('c')], 'c')).toBe(true)
  })

  test('nor a request that offers no "allow once", which Auto leaves to the user', () => {
    const always = [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]
    const items = [card('a', 'execute', { options: always }), card('b'), card('c')]
    expect(offersAuto(items, 'a')).toBe(false)
    expect(offersAuto(items, 'c')).toBe(false)
  })

  test('answered cards still count: each was a click', () => {
    const items = [card('a', 'execute', { resolved: 'yes' }), card('b', 'edit', { resolved: 'no' })]
    expect(offersAuto([...items, card('c')], 'c')).toBe(true)
  })

  test('an id not in the turn is not offered', () => {
    expect(offersAuto([card('a'), card('b'), card('c')], 'z')).toBe(false)
  })
})

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
