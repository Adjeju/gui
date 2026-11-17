import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diskFile } from '../src/main/coalesced-file'
import { ModelCache, parseModelCache } from '../src/main/model-cache'
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
    cache.set('opencode', models(3))
    cache.set('fx', models(2, true))
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
    cache.set('opencode', models(MAX_CACHED_MODELS + 50))
    expect(cache.get('opencode')?.model.options).toHaveLength(MAX_CACHED_MODELS)
    for (let i = 0; i <= MAX_CACHED_MODEL_AGENTS; i++) cache.set(`custom:Agent ${i}`, models(1))
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
    expect(parsed.get('opencode')?.model.options).toEqual([{ value: 'a', name: 'A', group: null }])
  }))
