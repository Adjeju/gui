import { describe, expect, test } from 'bun:test'
import {
  bounded,
  boundedLocations,
  boundedTool,
  clampMiddle,
  MAX_TOOL_LOCATION,
  MAX_TOOL_LOCATIONS,
  MAX_TOOL_TITLE,
} from '../src/shared/bounded'
import type { TurnItem } from '../src/shared/types'

type ToolStep = Extract<TurnItem, { kind: 'tool' }>

describe('bounded growth', () => {
  test('keeps the newest items', () => {
    expect(bounded([1, 2, 3, 4], 2)).toEqual([3, 4])
    expect(bounded([1, 2], 5)).toEqual([1, 2])
  })
})

// What one tool step keeps in a chat: its title (often the whole command) and its paths. Its
// output is never kept, and the person's words and the agent's reply are never cut.
describe('what a tool step keeps', () => {
  /** Numbered lines, so the start and the end of a long text can be told apart. */
  const lines = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i}: export const value${i} = ${i}`).join('\n')

  test('text within the cap is kept as it is', () => {
    const command = 'bun run build && bun run check'
    expect(clampMiddle(command, MAX_TOOL_TITLE)).toBe(command)
    const exact = 'x'.repeat(MAX_TOOL_TITLE)
    expect(clampMiddle(exact, MAX_TOOL_TITLE)).toBe(exact)
  })

  test('longer text keeps its start and its end, and says how much is gone between', () => {
    const body = lines(8000)
    const command = `cat > src/data.ts <<'EOF'\n${body}\nEOF`
    const kept = clampMiddle(command, MAX_TOOL_TITLE)
    expect(kept.length).toBeLessThanOrEqual(MAX_TOOL_TITLE)
    expect(kept.startsWith("cat > src/data.ts <<'EOF'\nline 0: export const value0 = 0\n")).toBe(
      true,
    )
    expect(kept.endsWith('line 7999: export const value7999 = 7999\nEOF')).toBe(true)
    const said = /\n… ([\d,]+) characters left out …\n/.exec(kept)
    expect(said).not.toBeNull()
    // The count is exact: what's kept and what's left out add up to what came.
    const leftOut = Number(said?.[1].replaceAll(',', ''))
    expect(kept.length - (said?.[0].length ?? 0) + leftOut).toBe(command.length)
    // Capping what was already capped changes nothing (a saved chat loaded again).
    expect(clampMiddle(kept, MAX_TOOL_TITLE)).toBe(kept)
  })

  test('a character of two code units is never cut in half', () => {
    const half = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    for (const lead of ['', 'a']) {
      const kept = clampMiddle(lead + '😀'.repeat(MAX_TOOL_TITLE), MAX_TOOL_TITLE)
      expect(kept.length).toBeLessThanOrEqual(MAX_TOOL_TITLE)
      expect(half.test(kept)).toBe(false)
    }
  })

  test('the first paths are kept, and how many more there were', () => {
    expect(boundedLocations(['src/App.tsx:3'])).toEqual({
      locations: ['src/App.tsx:3'],
      moreLocations: undefined,
    })
    const paths = Array.from({ length: 5000 }, (_, i) => `src/generated/File${i}.tsx`)
    const kept = boundedLocations(paths)
    expect(kept.locations).toEqual(paths.slice(0, MAX_TOOL_LOCATIONS))
    expect(kept.moreLocations).toBe(5000 - MAX_TOOL_LOCATIONS)
    // Paths the caller left out before formatting any are counted too.
    expect(boundedLocations(paths.slice(0, 3), 40).moreLocations).toBe(40)
    // Something longer than any path is cut like a title.
    const long = boundedLocations([`src/${'deep/'.repeat(1000)}File.tsx`]).locations[0]
    expect(long.length).toBeLessThanOrEqual(MAX_TOOL_LOCATION)
    expect(long).toContain('characters left out')
  })

  test('a saved step that fits is untouched; an oversized one is capped and keeps the rest', () => {
    const step: ToolStep = {
      kind: 'tool',
      id: 'call-1',
      title: 'Read src/App.tsx',
      toolKind: 'read',
      status: 'completed',
      locations: ['src/App.tsx'],
      startedAt: 1,
      endedAt: 2,
      subagent: 'session-2',
    }
    expect(boundedTool(step)).toBe(step)

    const paths = Array.from({ length: 250 }, (_, i) => `src/File${i}.tsx`)
    const old = { ...step, title: lines(4000), locations: paths }
    const capped = boundedTool(old)
    expect(capped.title).toBe(clampMiddle(old.title, MAX_TOOL_TITLE))
    expect(capped.locations).toEqual(paths.slice(0, MAX_TOOL_LOCATIONS))
    expect(capped.moreLocations).toBe(250 - MAX_TOOL_LOCATIONS)
    const { title: _title, locations: _locations, moreLocations: _more, ...rest } = capped
    const { title: _oldTitle, locations: _oldLocations, ...oldRest } = old
    expect(rest).toEqual(oldRest)
    // Capped once: loading what was saved after the cap changes nothing more.
    expect(boundedTool(capped)).toBe(capped)
  })

  test('a damaged saved step still loads', () => {
    const damaged = [
      { title: null, locations: null },
      { title: 7, locations: 'src/App.tsx' },
      { locations: [null, 'src/App.tsx', 12] },
      {},
    ]
    for (const step of damaged) expect(() => boundedTool(step as never)).not.toThrow()
    expect(boundedTool({ title: 'x', locations: [null, 'src/App.tsx', 12] } as never)).toEqual({
      title: 'x',
      locations: ['src/App.tsx'],
      moreLocations: undefined,
    } as never)
  })
})
