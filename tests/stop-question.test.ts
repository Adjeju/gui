import { expect, test } from 'bun:test'
import { replyRunning, stopQuestion } from '../src/shared/stop-question'
import type { ChatMeta, QueuedMessage } from '../src/shared/types'

const queued = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `q${index}` }) as QueuedMessage)
const meta = (status: ChatMeta['status'], queue = 0) => ({
  status,
  queue: queued(queue),
  agentName: 'Claude Code',
})

test('a reply is running while a turn works or messages wait in the queue', () => {
  expect(replyRunning(meta('working'))).toBe(true)
  expect(replyRunning(meta('ready', 1))).toBe(true)
  expect(replyRunning(meta('error', 2))).toBe(true)
  // Done, still loading, or failed with nothing waiting: nothing is lost by starting over.
  expect(replyRunning(meta('ready'))).toBe(false)
  expect(replyRunning(meta('idle'))).toBe(false)
  expect(replyRunning(meta('starting'))).toBe(false)
  expect(replyRunning(meta('error'))).toBe(false)
})

test('New chat asks in the picker’s words, about this agent', () => {
  expect(stopQuestion(meta('working'), null)).toEqual({
    title: 'Stop Claude Code and start a new chat?',
    detail: 'Claude Code is still working. This chat is archived with what it has done so far.',
    confirm: 'Stop and Start New Chat',
  })
})

test('the picker names the agent and model it switches to', () => {
  const next = { agentName: 'Codex', modelName: 'GPT-5' }
  expect(stopQuestion(meta('working'), next)).toMatchObject({
    title: 'Stop Claude Code and start a new chat with Codex on GPT-5?',
    confirm: 'Stop and Switch',
  })
  expect(stopQuestion(meta('working'), { agentName: 'Codex', modelName: null }).title).toBe(
    'Stop Claude Code and start a new chat with Codex?',
  )
})

test('what stopping costs: the work so far is archived, and queued messages are dropped', () => {
  expect(stopQuestion(meta('working', 1), null).detail).toBe(
    'Claude Code is still working. This chat is archived with what it has done so far, and its queued message is dropped.',
  )
  expect(stopQuestion(meta('ready', 3), null).detail).toBe(
    'This chat is archived, and its 3 queued messages are dropped.',
  )
})
