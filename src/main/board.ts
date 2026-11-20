import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { app, protocol } from 'electron'
import {
  BOARD_MANIFEST,
  type BoardManifest,
  FRAMES_DIR,
  isBoardId,
  isCanvasManifest,
  isFrameId,
  parseManifest,
} from '../shared/board'
import type { RecentBoard } from '../shared/types'
import { writeFileAtomic } from './atomic-file'
import { forgetCanvasFolder, loadCanvasFolders, rememberCanvasFolder } from './canvas-folders'
import { shadowRepoName } from './checkpoints'
import { claimedHistoryFiles, historyFile } from './history'
import { recordingProjectKey } from './recordings'
import { trust } from './trust'

export { isBoardId }

/**
 * A canvas is a folder: its manifest (`canvas.json`), its frames (`frames/<frame>.html`) and
 * whatever they share (`assets/`), and nothing else of Gui's. Being real folders, a canvas's
 * chat history, checkpoints and Ask/Auto key off its path like a project's do. Most live in
 * Gui's own data, `canvases/<id>/`; any other folder holding a manifest is one too, wherever
 * the user keeps it (canvas-folders.ts knows those).
 */
export const boardsDir = () => join(app.getPath('userData'), 'canvases')

export const boardRoot = (id: string) => join(boardsDir(), id)

/** The canvases in folders of the user's that Gui has opened (canvas-folders.ts) */
const foldersFile = () => join(app.getPath('userData'), 'canvas-folders.json')

/** Gui's data as given and as its real path: a test's temporary data is behind a link. */
function dataDirs() {
  const dir = resolve(boardsDir())
  let real = dir
  try {
    real = realpathSync(dir)
  } catch {}
  return real === dir ? [dir] : [dir, real]
}

/** The canvas a folder is, when it's one in Gui's data; null for any other folder. */
export function boardIdOf(root: string): string | null {
  const path = resolve(root)
  for (const dir of dataDirs()) {
    if (!path.startsWith(dir + sep)) continue
    const id = path.slice(dir.length + 1)
    return isBoardId(id) ? id : null
  }
  return null
}

/** Inside Gui's data's canvases folder, at any depth. */
export function inBoardsDir(path: string) {
  const at = resolve(path)
  return dataDirs().some((dir) => at === dir || at.startsWith(dir + sep))
}

export async function readManifest(root: string, fallbackName = 'Untitled canvas') {
  const text = await readFile(join(root, BOARD_MANIFEST), 'utf8').catch(() => null)
  return parseManifest(text, fallbackName)
}

/** Writes the manifest as Gui keeps it; where the board was looking is left out until there is one. */
export function writeManifest(root: string, manifest: BoardManifest) {
  const { camera, ...rest } = manifest
  return writeFileAtomic(
    join(root, BOARD_MANIFEST),
    `${JSON.stringify(camera ? manifest : rest, null, 2)}\n`,
  )
}

/** Whether `path` is a canvas's folder: one holding Gui's manifest. */
export async function isCanvasFolder(path: string) {
  return isCanvasManifest(await readFile(join(path, BOARD_MANIFEST), 'utf8').catch(() => null))
}

/**
 * The folder a canvas opens at, when `path` is one: Gui's own as `boardRoot` names it, any
 * other by its real path (as a project's is). Null for a folder that isn't a canvas.
 */
export async function canvasAt(path: string): Promise<string | null> {
  const own = boardIdOf(path)
  if (own) return (await isDirectory(boardRoot(own))) ? boardRoot(own) : null
  if (!(await isCanvasFolder(path))) return null
  return realpath(path).catch(() => resolve(path))
}

async function isDirectory(path: string) {
  return (await stat(path).catch(() => null))?.isDirectory() === true
}

/** A canvas's folder by its id: one of the user's that Gui knows, or one in Gui's data. */
export async function canvasRoot(id: string): Promise<string | null> {
  if (!isBoardId(id)) return null
  const folder = (await loadCanvasFolders(foldersFile())).find((entry) => entry.id === id)
  return folder?.root ?? boardRoot(id)
}

/** What Gui keeps of a folder's canvas that's dropped from its list: thumbnails, and view. */
const forgetKept = (ids: readonly string[]) =>
  Promise.all(
    ids.map((id) =>
      Promise.all([
        rm(thumbsDir(id), { recursive: true, force: true }),
        rm(viewFile(id), { force: true }),
      ]),
    ),
  )

/**
 * The id of the canvas at `root` (as `canvasAt` gives it), remembered under Recent canvases;
 * null when it isn't one. A folder of the user's gets one the first time it opens.
 */
export async function canvasId(root: string): Promise<string | null> {
  const own = boardIdOf(root)
  if (own) return own
  if (!(await isCanvasFolder(root))) return null
  const { id, dropped } = await rememberCanvasFolder(foldersFile(), root, (id) => isOwnId(id))
  void forgetKept(dropped.map((entry) => entry.id)).catch(() => undefined)
  return id
}

const isOwnId = (id: string) => {
  try {
    realpathSync(boardRoot(id))
    return true
  } catch {
    return false
  }
}

/**
 * Where the board of a canvas in the user's folder was looking, by its id: each person's own,
 * so it's kept in Gui's data rather than in a folder they may share through git. (A canvas in
 * Gui's data keeps it in its manifest, as it always has.)
 */
export const viewFile = (id: string) => join(app.getPath('userData'), 'canvas-views', `${id}.json`)

const emptyManifest = (name: string): BoardManifest => ({
  version: 1,
  name,
  createdAt: Date.now(),
  frames: [],
  sections: [],
  camera: null,
})

/** A new, empty canvas in Gui's data, named for when it was made until someone names it. */
export async function createBoard(name = 'Untitled canvas'): Promise<string> {
  const id = randomBytes(6).toString('hex')
  const root = boardRoot(id)
  await mkdir(join(root, FRAMES_DIR), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'assets'), { mode: 0o700 })
  await writeManifest(root, emptyManifest(name))
  // Gui made it and only Gui and the agent write in it, like a new project.
  await trust(root).catch((error: unknown) => console.error('[gui] failed to trust canvas', error))
  return root
}

/**
 * A new, empty canvas at `path`, a folder of the user's choosing: made there, or in it when
 * it's an empty folder already. One that's a canvas already is simply that canvas. Anything
 * else there is the user's, and stays as it is.
 */
export async function createCanvasFolder(path: string, name: string): Promise<string> {
  const existing = await canvasAt(path)
  if (existing) return existing
  const info = await stat(path).catch(() => null)
  if (info && (!info.isDirectory() || (await readdir(path)).length > 0))
    throw new Error(
      `There's already something called ${basename(path)} there. Choose another name.`,
    )
  await mkdir(join(path, FRAMES_DIR), { recursive: true })
  await mkdir(join(path, 'assets'), { recursive: true })
  await writeManifest(path, emptyManifest(name))
  const root = await realpath(path)
  await trust(root).catch((error: unknown) => console.error('[gui] failed to trust canvas', error))
  return root
}

/** A canvas as Recent canvases lists it; null when its manifest can't be read. */
async function recentBoard(id: string, root: string, folder: string | null) {
  try {
    const [manifest, info] = await Promise.all([
      readManifest(root),
      stat(join(root, BOARD_MANIFEST)),
    ])
    const frames = await readdir(join(root, FRAMES_DIR)).catch(() => [] as string[])
    const newest = await Promise.all(
      frames.map((file) =>
        stat(join(root, FRAMES_DIR, file)).then(
          (frame) => frame.mtimeMs,
          () => 0,
        ),
      ),
    )
    return {
      id,
      name: manifest.name,
      frames: manifest.frames.length,
      editedAt: Math.max(info.mtimeMs, ...newest),
      folder,
      missing: false,
    }
  } catch {
    return null
  }
}

/**
 * Every canvas, last edited first: Gui's own, and the user's folders it has opened. One of
 * theirs that's no longer there (moved, deleted, or its manifest gone) stays listed as missing,
 * named for its folder, so opening it can say so.
 */
export async function listBoards(): Promise<RecentBoard[]> {
  const ids = (await readdir(boardsDir()).catch(() => [] as string[])).filter(isBoardId)
  const folders = await loadCanvasFolders(foldersFile())
  const boards = await Promise.all([
    ...ids.map((id) => recentBoard(id, boardRoot(id), null)),
    ...folders.map(
      async ({ id, root, openedAt }): Promise<RecentBoard> =>
        ((await isCanvasFolder(root)) && (await recentBoard(id, root, root))) || {
          id,
          name: basename(root),
          frames: 0,
          editedAt: openedAt,
          folder: root,
          missing: true,
        },
    ),
  ])
  return boards
    .filter((board): board is RecentBoard => board !== null)
    .sort((a, b) => b.editedAt - a.editedAt)
}

/** Off Recent canvases, with what Gui kept of it; a folder of the user's stays as it is. */
export async function forgetCanvas(id: string) {
  await forgetCanvasFolder(foldersFile(), id)
  await forgetKept([id])
}

/** Entries in `dir` that are `name` itself or start with it and then `.` or `-`. */
async function removeNamed(dir: string, name: string, keep: ReadonlySet<string> = new Set()) {
  const entries = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          (entry === name || entry.startsWith(`${name}.`) || entry.startsWith(`${name}-`)) &&
          !keep.has(join(dir, entry)),
      )
      .map((entry) => rm(join(dir, entry), { recursive: true, force: true })),
  )
}

/**
 * Gone for good: its frames, the thumbnails Gui kept of them, and what Gui kept for its chats,
 * as for a project folder: chat history and archive, checkpoints and recordings. A tab must not
 * have it open (they're keyed off its path, and a live chat writes them).
 */
export async function deleteBoard(id: string) {
  if (!isBoardId(id)) return
  const root = boardRoot(id)
  const real = await realpath(root).catch(() => root)
  const data = app.getPath('userData')
  // The chat file, numbered ones beside it, their summaries and the archive folder.
  const chats = await historyFile(root)
  await rm(root, { recursive: true, force: true })
  await Promise.all([
    rm(thumbsDir(id), { recursive: true, force: true }),
    removeNamed(join(data, 'chats'), basename(chats, '.json'), new Set(claimedHistoryFiles())),
    // Its shadow repo and the marker of when it was last pruned.
    removeNamed(join(data, 'checkpoints'), shadowRepoName(real)),
    rm(join(data, 'recordings', recordingProjectKey(root)), { recursive: true, force: true }),
  ])
}

/** Where a canvas's frame thumbnails are kept: Gui's, outside the folder the agent works in. */
export const thumbsDir = (id: string) => join(app.getPath('userData'), 'canvas-thumbnails', id)

/**
 * Where the board loads a frame's thumbnail from: `${thumbsUrl(id)}/<frame id>?v=<version>`,
 * or `<frame id>.small` for its zoomed-out copy, `<frame id>.mid` for its middle one.
 */
export const thumbsUrl = (id: string) => `gui-thumb://${id}`

/**
 * Serves frame thumbnails to Gui's own pages, `gui-thumb://<canvas>/<frame>`. Only Gui's UI
 * session has the protocol; previewed pages can't read them. So any origin may read one's
 * pixels (CORS): the only pages that can ask are Gui's own.
 */
export function registerThumbProtocol() {
  protocol.handle('gui-thumb', async (request) => {
    try {
      const url = new URL(request.url)
      const name = url.pathname.slice(1)
      const frame = name.replace(/\.(small|mid)$/, '')
      if (!isBoardId(url.hostname) || !isFrameId(frame)) return new Response(null, { status: 404 })
      const dir = thumbsDir(url.hostname)
      // A thumbnail made before its smaller copies existed has none until it's made again.
      const image = await readFile(join(dir, `${name}.jpg`)).catch(() =>
        readFile(join(dir, `${frame}.jpg`)),
      )
      return new Response(image, {
        headers: {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
