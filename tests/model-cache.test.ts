import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskFile } from '../src/main/coalesced-file'
import { listOf, ModelCache, parseModelCache } from '../src/main/model-cache'
import { MAX_CACHED_MODEL_AGENTS, MAX_CACHED_MODELS, MAX_MODEL_TEXT } from '../src/shared/bounded'
import type { ModelSettings } from '../src/shared/types'

// Each agent's model list as its last check found it (agent-models.json), so the picker can
// list and search them before this launch's checks finish.

const models = (count: number, provider = false): ModelSettings => ({
  model: {
    id: 'model',
    value: 'm0',
    options: Array.from({ length: count }, (_, i) => ({
      value: `m${i}`,
      name: `Model ${i}`,
      group: i % 2 ? 'odd' : null,
    })),
  },
  effort: { id: 'effort', value: 'high', options: [{ value: 'high', name: 'High', group: null }] },
  provider: provider
    ? {
        id: 'provider',
        value: 'gateway',
        options: [{ value: 'gateway', name: 'Gateway', group: null }],
      }
    : null,
})

const NOW = Date.UTC(2026, 10, 17)
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const open = (file: string) =>
  new ModelCache(
    () => file,
    diskFile(() => file),
  )

function withFile(run: (file: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gui-model-cache-'))
  return Promise.resolve(run(join(dir, 'agent-models.json'))).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  )
}

test('a list is kept between launches, without its effort levels', () =>
  withFile(async (file) => {
    const cache = new ModelCache(
      () => file,
      diskFile(() => file),
    )
    expect(cache.get('opencode')).toBeNull()
    cache.set('opencode', models(3), NOW)
    cache.set('fx', models(2, true), NOW)
    cache.flushSync()
    const next = new ModelCache(
      () => file,
      diskFile(() => file),
    )
    expect(next.get('opencode')).toEqual({ model: models(3).model, provider: null })
    expect(next.get('fx')?.provider?.value).toBe('gateway')
    expect(JSON.parse(readFileSync(file, 'utf8')).agents.opencode.effort).toBeUndefined()
    // The write that started before the flush finishes (and is dropped) before the folder goes.
    await new Promise((resolve) => setTimeout(resolve, 100))
  }))

test('it keeps at most MAX_CACHED_MODELS per list and the newest MAX_CACHED_MODEL_AGENTS agents', () =>
  withFile((file) => {
    const cache = new ModelCache(
      () => file,
      diskFile(() => file),
    )
    cache.set('opencode', models(MAX_CACHED_MODELS + 50), NOW)
    expect(cache.get('opencode')?.model.options).toHaveLength(MAX_CACHED_MODELS)
    for (let i = 0; i <= MAX_CACHED_MODEL_AGENTS; i++)
      cache.set(`custom:Agent ${i}`, models(1), NOW)
    expect(cache.get('opencode')).toBeNull()
    expect(cache.get('custom:Agent 1')).not.toBeNull()
    expect(cache.get(`custom:Agent ${MAX_CACHED_MODEL_AGENTS}`)).not.toBeNull()
  }))

test('a damaged or foreign file reads as empty; bad entries are dropped', () =>
  withFile((file) => {
    writeFileSync(file, '{not json')
    expect(
      new ModelCache(
        () => file,
        diskFile(() => file),
      ).get('opencode'),
    ).toBeNull()
    expect(parseModelCache({ version: 2, agents: {} }).size).toBe(0)
    const parsed = parseModelCache({
      version: 1,
      agents: {
        opencode: {
          model: {
            id: 'model',
            value: 'a',
            options: [
              { value: 'a', name: 'A', group: null },
              { value: 'b', name: 'x'.repeat(MAX_MODEL_TEXT + 1), group: null },
              { value: 'c', name: 'C', group: 3 },
              'junk',
            ],
          },
          provider: null,
        },
        nobody: { model: { id: 'model', value: 'a', options: [] }, provider: null },
        codex: { model: null, provider: null },
        cursor: { model: { id: 'model', value: 'a', options: [] }, provider: { id: 7 } },
      },
    })
    expect([...parsed.keys()]).toEqual(['opencode'])
    expect(parsed.get('opencode')?.list?.model.options).toEqual([
      { value: 'a', name: 'A', group: null },
    ])
  }))

// Each list keeps when a check found it, so the checks after launch start an agent at most once
// a day.

test('a list a check found less than a day ago is fresh; an older one is due', () =>
  withFile(async (file) => {
    const cache = open(file)
    expect(cache.fresh('opencode', NOW, DAY)).toBe(false)
    cache.set('opencode', models(2), NOW)
    expect(cache.fresh('opencode', NOW + 23 * HOUR, DAY)).toBe(true)
    expect(cache.fresh('opencode', NOW + DAY, DAY)).toBe(false)
    cache.flushSync()
    // Kept between launches.
    expect(open(file).fresh('opencode', NOW + HOUR, DAY)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }))

test('a time in the future (the clock was changed) is due', () =>
  withFile(async (file) => {
    const cache = open(file)
    cache.set('opencode', models(2), NOW + HOUR)
    expect(cache.fresh('opencode', NOW, DAY)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }))

test('a file from before times were kept still lists its models, and they are due', () =>
  withFile((file) => {
    writeFileSync(file, JSON.stringify({ version: 1, agents: { opencode: listOf(models(2)) } }))
    const cache = open(file)
    expect(cache.get('opencode')).toEqual(listOf(models(2)))
    expect(cache.fresh('opencode', NOW, DAY)).toBe(false)
  }))

test('the same list found again moves its time, in the file too', () =>
  withFile(async (file) => {
    const cache = open(file)
    cache.set('opencode', models(2), NOW)
    cache.flushSync()
    await new Promise((resolve) => setTimeout(resolve, 50))
    cache.set('opencode', models(2), NOW + 2 * DAY)
    expect(cache.fresh('opencode', NOW + 2 * DAY + HOUR, DAY)).toBe(true)
    cache.flushSync()
    expect(JSON.parse(readFileSync(file, 'utf8')).agents.opencode.checkedAt).toBe(NOW + 2 * DAY)
    expect(open(file).fresh('opencode', NOW + 2 * DAY + HOUR, DAY)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }))

test('an agent that can list none keeps only its time; one with a list keeps it and moves its time', () =>
  withFile(async (file) => {
    const cache = open(file)
    cache.checkedWithout('kiro', NOW)
    expect(cache.get('kiro')).toBeNull()
    expect(cache.fresh('kiro', NOW + HOUR, DAY)).toBe(true)
    cache.set('opencode', models(2), NOW - 2 * DAY)
    cache.checkedWithout('opencode', NOW)
    expect(cache.get('opencode')).toEqual(listOf(models(2)))
    expect(cache.fresh('opencode', NOW + HOUR, DAY)).toBe(true)
    cache.flushSync()
    const next = open(file)
    expect(next.get('kiro')).toBeNull()
    expect(next.fresh('kiro', NOW + HOUR, DAY)).toBe(true)
    // Deleted (a check found it has no models): no list and no time.
    next.delete('opencode')
    expect(next.fresh('opencode', NOW, DAY)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }))
