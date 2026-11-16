import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type CanvasFolder,
  MAX_CANVAS_FOLDERS,
  openCanvasFolder,
  parseCanvasFolders,
} from '../src/main/canvas-folders'

// Canvases in folders of the user's (main/canvas-folders.ts): Gui's id for each is kept in its
// own data by the folder's path, never written into the folder.

const ids = (...list: string[]) => {
  let next = 0
  return () => list[next++] ?? `${String(next).padStart(12, 'z')}`
}
const none = () => false

test('a folder keeps its id each time it opens, and comes first', () => {
  const first = openCanvasFolder([], '/work/shop/design/landing', none, 1, ids('aaaaaaaaaaaa'))
  expect(first.id).toBe('aaaaaaaaaaaa')
  const other = openCanvasFolder(first.list, '/work/brand', none, 2, ids('bbbbbbbbbbbb'))
  const again = openCanvasFolder(
    other.list,
    '/work/shop/design/landing',
    none,
    3,
    ids('cccccccccccc'),
  )
  expect(again.id).toBe('aaaaaaaaaaaa')
  expect(again.list.map((entry) => [entry.root, entry.openedAt])).toEqual([
    ['/work/shop/design/landing', 3],
    ['/work/brand', 2],
  ])
})

test('a repo cloned twice is two canvases, with two ids', () => {
  const one = openCanvasFolder([], '/work/a/design', none, 1, ids('aaaaaaaaaaaa'))
  const two = openCanvasFolder(one.list, '/work/b/design', none, 2, ids('bbbbbbbbbbbb'))
  expect(two.id).not.toBe(one.id)
})

test("a new id is never another canvas's: one of the user's folders or one in Gui's data", () => {
  const known = openCanvasFolder([], '/work/a', none, 1, ids('aaaaaaaaaaaa')).list
  const taken = (id: string) => id === 'bbbbbbbbbbbb'
  const next = openCanvasFolder(
    known,
    '/work/b',
    taken,
    2,
    ids('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc'),
  )
  expect(next.id).toBe('cccccccccccc')
})

test('past the cap the oldest go, so what Gui kept of them can go too', () => {
  let list: CanvasFolder[] = []
  for (let n = 0; n < MAX_CANVAS_FOLDERS; n++)
    list = openCanvasFolder(list, `/work/${n}`, none, n, () => String(n).padStart(12, '0')).list
  const { list: next, dropped } = openCanvasFolder(list, '/work/new', none, 99, ids('nnnnnnnnnnnn'))
  expect(next).toHaveLength(MAX_CANVAS_FOLDERS)
  expect(dropped.map((entry) => entry.root)).toEqual(['/work/0'])
})

test('a damaged or hand-edited list keeps only well-formed entries, each id and folder once', () => {
  expect(parseCanvasFolders('{oops')).toEqual([])
  expect(parseCanvasFolders(null)).toEqual([])
  const list = parseCanvasFolders(
    JSON.stringify([
      { id: 'aaaaaaaaaaaa', root: '/work/a', openedAt: 1 },
      { id: 'aaaaaaaaaaaa', root: '/work/b', openedAt: 2 },
      { id: 'bbbbbbbbbbbb', root: '/work/a', openedAt: 3 },
      { id: '../escape', root: '/work/c', openedAt: 4 },
      { id: 'cccccccccccc', root: 'relative/d', openedAt: 5 },
      { id: 'dddddddddddd', root: '/work/e', openedAt: 6 },
    ]),
  )
  expect(list.map((entry) => entry.id)).toEqual(['aaaaaaaaaaaa', 'dddddddddddd'])
})

test('canvas folders on disk: detection, ids, Gui’s own, and moved ones', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'canvas-folders.ts'),
  ])
  expect(result.stdout).toContain('canvas folders passed')
  expect(result.stderr).toBe('')
}, 10_000)
