import { expect, test } from 'bun:test'
import { matchesWords, searchWords } from '../src/renderer/src/chat/model-search'

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
