import { expect, test } from 'bun:test'
import {
  type NoticeSink,
  type NoticeText,
  noticeText,
  shouldNotify,
  type WaitingCard,
  WaitingNotice,
} from '../src/main/waiting-notice'

const CARD: WaitingCard = {
  waiting: true,
  looking: false,
  kind: 'approval',
  agent: 'Claude',
  project: 'my-app',
}

function setup({ enabled = true, supported = true } = {}) {
  const shown: { text: NoticeText; closed: boolean; click: () => void; gone: () => void }[] = []
  const sink: NoticeSink = {
    supported: () => supported,
    show(text, click, gone) {
      const entry = { text, closed: false, click, gone }
      shown.push(entry)
      return { close: () => (entry.closed = true) }
    },
  }
  const state = { enabled, clicks: 0 }
  const closing = new AbortController()
  const notice = new WaitingNotice({
    enabled: () => state.enabled,
    signal: closing.signal,
    onClick: () => state.clicks++,
    sink,
  })
  return { notice, shown, state, closing }
}

test('the rule: a card really waiting, starting a wait, nobody looking, on, supported', () => {
  const yes = { waiting: true, newWait: true, looking: false, enabled: true, supported: true }
  expect(shouldNotify(yes)).toBe(true)
  // Gui answered it itself (Auto, or an ordinary edit in Ask).
  expect(shouldNotify({ ...yes, waiting: false })).toBe(false)
  // Another card in the same wait.
  expect(shouldNotify({ ...yes, newWait: false })).toBe(false)
  expect(shouldNotify({ ...yes, looking: true })).toBe(false)
  expect(shouldNotify({ ...yes, enabled: false })).toBe(false)
  expect(shouldNotify({ ...yes, supported: false })).toBe(false)
})

test('the wording is Gui’s own: the agent’s name and the project’s folder', () => {
  expect(noticeText('Claude', 'my-app', 'approval')).toEqual({
    title: 'Claude is waiting for your OK',
    body: 'my-app',
  })
  expect(noticeText('Codex', 'site', 'question')).toEqual({
    title: 'Codex has a question',
    body: 'site',
  })
})

test('one notification per wait, closed when the wait ends; the next wait notifies again', () => {
  const { notice, shown } = setup()
  notice.cardWaiting(CARD)
  notice.cardWaiting({ ...CARD, kind: 'question' })
  expect(shown.map((s) => s.text.title)).toEqual(['Claude is waiting for your OK'])
  // One card answered, another still waits: the same wait.
  notice.settle(true)
  expect(shown[0]?.closed).toBe(false)
  notice.settle(false)
  expect(shown[0]?.closed).toBe(true)
  notice.cardWaiting({ ...CARD, kind: 'question' })
  expect(shown.map((s) => s.text.title)).toEqual([
    'Claude is waiting for your OK',
    'Claude has a question',
  ])
})

test('a card the user is looking at starts a wait without notifying', () => {
  const { notice, shown } = setup()
  notice.cardWaiting({ ...CARD, looking: true })
  // They looked away before answering: still the same wait.
  notice.cardWaiting(CARD)
  expect(shown).toEqual([])
  notice.settle(false)
  notice.cardWaiting(CARD)
  expect(shown).toHaveLength(1)
})

test('nothing when Gui answered it, the setting is off, or the system has no notifications', () => {
  const answered = setup()
  answered.notice.cardWaiting({ ...CARD, waiting: false })
  expect(answered.shown).toEqual([])
  // A request Gui answered doesn't start a wait: the next real card notifies.
  answered.notice.cardWaiting(CARD)
  expect(answered.shown).toHaveLength(1)

  const off = setup({ enabled: false })
  off.notice.cardWaiting(CARD)
  expect(off.shown).toEqual([])
  off.state.enabled = true
  // Switched on during the wait: that wait already started.
  off.notice.cardWaiting(CARD)
  expect(off.shown).toEqual([])

  const unsupported = setup({ supported: false })
  unsupported.notice.cardWaiting(CARD)
  expect(unsupported.shown).toEqual([])
})

test('a click acts once while the wait is on; after the project closes it does nothing', () => {
  const { notice, shown, state, closing } = setup()
  notice.cardWaiting(CARD)
  shown[0]?.click()
  shown[0]?.click()
  expect(state.clicks).toBe(1)

  notice.settle(false)
  notice.cardWaiting(CARD)
  closing.abort()
  expect(shown[1]?.closed).toBe(true)
  shown[1]?.click()
  expect(state.clicks).toBe(1)
  // Closed or reopened: nothing more shows.
  notice.cardWaiting(CARD)
  expect(shown).toHaveLength(2)
})

test('a notification the user dismissed is let go, and not closed again', () => {
  const { notice, shown } = setup()
  notice.cardWaiting(CARD)
  shown[0]?.gone()
  notice.settle(false)
  expect(shown[0]?.closed).toBe(false)
})
