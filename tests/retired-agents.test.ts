import { expect, test } from 'bun:test'
import { settleHistory } from '../src/main/history-record'
import { currentAgentId } from '../src/shared/types'

// Google replaced Gemini CLI with Antigravity CLI, and Gui did the same. A saved choice of
// Gemini CLI (prefs.json's agent, a chat's) is Antigravity CLI's now.

test('a saved Gemini CLI is Antigravity CLI; other ids stay as they are', () => {
  expect(currentAgentId('gemini')).toBe('antigravity')
  expect(currentAgentId('claude')).toBe('claude')
  expect(currentAgentId('custom:Gemini')).toBe('custom:Gemini')
  expect(currentAgentId('nobody')).toBeNull()
  expect(currentAgentId('constructor')).toBeNull()
  expect(currentAgentId(undefined)).toBeNull()
})

test('a Gemini chat reads as it was, and continues with Antigravity CLI in a new session', () => {
  const turn = { id: 't1', prompt: 'Fix the header', items: [], startedAt: 1, endedAt: 2 }
  const saved = { version: 1, agentId: 'gemini', sessionId: 'gemini-session', turns: [turn] }
  const chat = settleHistory(saved)
  expect(chat.agentId).toBe('antigravity')
  expect(chat.sessionId).toBeNull()
  expect(chat.turns.map((each) => each.prompt)).toEqual(['Fix the header'])
  // A chat with an agent Gui still has keeps its session.
  expect(settleHistory({ ...saved, agentId: 'codex' }).sessionId).toBe('gemini-session')
})
