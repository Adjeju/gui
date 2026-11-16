import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isBoardId } from '../shared/board'
import { writeFileAtomic } from './atomic-file'

/**
 * Canvases kept in a folder of the user's (a repo's `design/landing/`, or a repo of its own),
 * rather than in Gui's data. Gui knows each by an id of its own, kept here by the folder's path,
 * never in the folder: the id names its thumbnails, where its board was looking, its frames'
 * host (`<id>.localhost`) and its place under Recent canvases. A path is a canvas's identity,
 * as it is a project's (its chats, checkpoints and Ask/Auto are keyed by path too), so a repo
 * cloned twice is two canvases, and nothing in the folder changes for Gui to tell them apart.
 */
export interface CanvasFolder {
  id: string
  /** Its real path */
  root: string
  /** When it was last opened, for Recent canvases when it's gone */
  openedAt: number
}

/** More than Recent canvases shows; the oldest go, with what Gui kept of them. */
export const MAX_CANVAS_FOLDERS = 50

function isEntry(value: unknown): value is CanvasFolder {
  if (!value || typeof value !== 'object') return false
  const { id, root, openedAt } = value as Record<string, unknown>
  return (
    isBoardId(id) && typeof root === 'string' && isAbsolute(root) && typeof openedAt === 'number'
  )
}

/** The saved list, each id and each folder once; anything malformed is dropped. */
export function parseCanvasFolders(text: string | null): CanvasFolder[] {
  let parsed: unknown = []
  try {
    parsed = text ? JSON.parse(text) : []
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const ids = new Set<string>()
  const roots = new Set<string>()
  return parsed.filter(isEntry).filter(({ id, root }) => {
    if (ids.has(id) || roots.has(root)) return false
    ids.add(id)
    roots.add(root)
    return true
  })
}

export const newCanvasId = () => randomBytes(6).toString('hex')

/**
 * The list with `root` opened now, first: its id kept, or a new one that's no other canvas's
 * (`taken`: Gui's own canvases' ids). Past MAX_CANVAS_FOLDERS the oldest are `dropped`.
 */
export function openCanvasFolder(
  list: readonly CanvasFolder[],
  root: string,
  taken: (id: string) => boolean,
  now = Date.now(),
  makeId = newCanvasId,
): { id: string; list: CanvasFolder[]; dropped: CanvasFolder[] } {
  const known = list.find((entry) => entry.root === root)
  let id = known?.id
  while (!id || (!known && (taken(id) || list.some((entry) => entry.id === id)))) id = makeId()
  const next = [{ id, root, openedAt: now }, ...list.filter((entry) => entry.root !== root)]
  return { id, list: next.slice(0, MAX_CANVAS_FOLDERS), dropped: next.slice(MAX_CANVAS_FOLDERS) }
}

let pending: Promise<unknown> = Promise.resolve()

/**
 * One change at a time to the list saved in `file` (`canvas-folders.json` in Gui's data), each
 * reading what the last wrote.
 */
function update<T>(
  file: string,
  change: (list: CanvasFolder[]) => { list: CanvasFolder[]; result: T },
) {
  const task = pending.then(async () => {
    const { list, result } = change(await read(file))
    await writeFileAtomic(file, `${JSON.stringify(list, null, 2)}\n`)
    return result
  })
  pending = task.catch(() => undefined)
  return task
}

const read = async (file: string) =>
  parseCanvasFolders(await readFile(file, 'utf8').catch(() => null))

export async function loadCanvasFolders(file: string): Promise<CanvasFolder[]> {
  await pending
  return read(file)
}

/** The id for the canvas at `root` (a real path), remembered as opened now. */
export function rememberCanvasFolder(file: string, root: string, taken: (id: string) => boolean) {
  return update(file, (list) => {
    const { id, list: next, dropped } = openCanvasFolder(list, root, taken)
    return { list: next, result: { id, dropped } }
  })
}

/** Takes it off Recent canvases; the folder itself stays as it is. */
export function forgetCanvasFolder(file: string, id: string) {
  return update(file, (list) => ({
    list: list.filter((entry) => entry.id !== id),
    result: undefined,
  }))
}
