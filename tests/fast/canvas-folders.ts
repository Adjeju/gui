// Isolated process: Electron stubs must not replace modules used by other fast tests.
import { expect, mock } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gui-canvas-folders-')))
const userData = join(scratch, 'data')
mkdirSync(join(userData, 'canvases'), { recursive: true })
mock.module('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getAppPath: () => scratch },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
  dialog: {},
}))
const { boardIdOf, boardRoot, canvasAt, canvasId, canvasRoot, listBoards } = await import(
  '../../src/main/board'
)

/** Each check, in order; they build on one another's folders. */
async function check(name: string, run: () => Promise<void>) {
  try {
    await run()
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : error}`, { cause: error })
  }
}

/** A folder holding a manifest, as New Canvas makes one or a clone brings one. */
function canvasFolder(path: string, name = 'Landing') {
  mkdirSync(join(path, 'frames'), { recursive: true })
  writeFileSync(
    join(path, 'canvas.json'),
    JSON.stringify({ version: 1, name, createdAt: 1, frames: [], sections: [] }),
  )
  return path
}

await check(
  'a folder with a canvas.json opens as a canvas wherever it is, by its real path',
  async () => {
    const repo = join(scratch, 'my-app')
    const landing = canvasFolder(join(repo, 'design', 'landing'))
    writeFileSync(join(repo, 'package.json'), '{}')
    expect(await canvasAt(landing)).toBe(landing)
    // The project around it is a project, not a canvas; nor is a folder with another canvas.json.
    expect(await canvasAt(repo)).toBe(null)
    const other = join(scratch, 'not-a-canvas')
    mkdirSync(other)
    writeFileSync(join(other, 'canvas.json'), JSON.stringify({ width: 10 }))
    expect(await canvasAt(other)).toBe(null)
    // Through a link, it's the folder the link points at.
    symlinkSync(landing, join(scratch, 'link'))
    expect(await canvasAt(join(scratch, 'link'))).toBe(landing)
  },
)

await check(
  "a folder's id stays its own across openings, and two clones of one repo get two",
  async () => {
    const one = canvasFolder(join(scratch, 'clone-1', 'design'))
    const two = canvasFolder(join(scratch, 'clone-2', 'design'))
    const id = await canvasId(one)
    expect(id).toMatch(/^[a-z0-9]{12}$/)
    expect(await canvasId(one)).toBe(id)
    const other = await canvasId(two)
    expect(other).not.toBe(id)
    expect(await canvasRoot(id ?? '')).toBe(one)
    expect(await canvasRoot(other ?? '')).toBe(two)
    // Nothing of Gui's goes in the folder: its manifest is as it was.
    expect(JSON.parse(readFileSync(join(one, 'canvas.json'), 'utf8'))).not.toHaveProperty('id')
    expect(await canvasId(join(scratch, 'my-app'))).toBe(null)
  },
)

await check("one in Gui's data is known by its folder's name, as it always was", async () => {
  const root = canvasFolder(boardRoot('0123456789ab'), 'Own')
  expect(boardIdOf(root)).toBe('0123456789ab')
  expect(await canvasId(root)).toBe('0123456789ab')
  expect(await canvasAt(root)).toBe(root)
  expect(await canvasRoot('0123456789ab')).toBe(root)
})

await check(
  'a folder moved or deleted outside Gui stays on the list as missing, named for its folder',
  async () => {
    const gone = canvasFolder(join(scratch, 'gone', 'sketches'), 'Sketches')
    const id = await canvasId(gone)
    rmSync(join(scratch, 'gone'), { recursive: true })
    const listed = (await listBoards()).find((board) => board.id === id)
    expect(listed).toMatchObject({ name: 'sketches', missing: true, folder: gone })
    const own = (await listBoards()).find((board) => board.id === '0123456789ab')
    expect(own).toMatchObject({ name: 'Own', folder: null, missing: false })
  },
)

rmSync(scratch, { recursive: true, force: true })
console.log('canvas folders passed')
