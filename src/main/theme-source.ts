import { chmod, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MAX_THEME_CSS_BYTES, MAX_THEME_CSS_FILES } from '../shared/bounded'
import { modeOf, safeName, safeValue, type ThemeEdit, type ThemeMode } from '../shared/theme-tokens'
import { writeTemp } from './atomic-file'

// Keep rewrites the user's own CSS, so it is strict: a value is rewritten only where its
// declaration is found exactly once, directly inside a mode's block, in a plain .css file.
// Anything else (nested rules, @layer, @supports, preprocessors, dependencies) is locked.

/** A project CSS file; `path` is relative to the project root. */
export interface CssFile {
  path: string
  text: string
}

/** `start`/`end` bound the value text alone, trimmed. */
export type Located =
  | { ok: true; file: string; start: number; end: number; value: string }
  | { ok: false; reason: string }

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out'])

async function cssFiles(root: string, limit: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= limit) return
      const path = join(dir, entry.name)
      // Dirents don't follow symlinks, so nothing outside the root is listed.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.css')) {
        const size = await stat(path).then(
          (s) => s.size,
          () => Infinity,
        )
        if (size <= MAX_THEME_CSS_BYTES) found.push(relative(root, path).split(sep).join('/'))
      }
    }
  }
  await walk(root)
  return found.sort()
}

/** Plain .css files under `root`, relative to it, outside dependency and build folders. */
export const listCssFiles = (root: string) => cssFiles(root, MAX_THEME_CSS_FILES)

/** `text` with every comment blanked to spaces, so offsets stay the same. */
function blankComments(text: string) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? text.length : close + 2
      out += text.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Index just past the string starting at `i`; an unclosed string ends at its line. */
function stringEnd(text: string, i: number) {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === quote || text[j] === '\n') return j + 1
  }
  return text.length
}

/** The mode a block's preludes (outermost first) belong to, when Keep may write there. */
function blockMode(preludes: string[]): string | null {
  const [outer, inner] = preludes
  if (preludes.length === 1) {
    if (/^@theme(?:\s[\w\s-]*)?$/.test(outer)) return 'default'
    return outer.startsWith('@') ? null : (modeOf(outer, null)?.id ?? null)
  }
  if (preludes.length === 2 && /^@media\s/i.test(outer) && !inner.startsWith('@')) {
    return modeOf(inner, outer.slice(6).trim())?.id ?? null
  }
  return null
}

interface Hit {
  file: string
  start: number
  end: number
  awkward: boolean
}

function declarations(file: CssFile, name: string, mode: string): Hit[] {
  const { text } = file
  const clean = blankComments(text)
  const hits: Hit[] = []
  const stack: { prelude: string; mode: string | null }[] = []
  let statement = 0
  let parens = 0
  const declaration = (end: number) => {
    if (stack.at(-1)?.mode !== mode) return
    const match = /^\s*(--[A-Za-z0-9_-]+)\s*:/.exec(clean.slice(statement, end))
    if (match?.[1] !== name) return
    let start = statement + match[0].length
    const commented = text.slice(start, end) !== clean.slice(start, end)
    let stop = end
    while (start < stop && /\s/.test(clean[start])) start++
    while (stop > start && /\s/.test(clean[stop - 1])) stop--
    const raw = text.slice(start, stop)
    hits.push({
      file: file.path,
      start,
      end: stop,
      awkward: commented || /!\s*important/i.test(raw),
    })
  }
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '"' || ch === "'") i = stringEnd(clean, i) - 1
    else if (ch === '(') parens++
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (parens > 0) continue
    else if (ch === '{') {
      const preludes = [...stack.map((b) => b.prelude), clean.slice(statement, i).trim()]
      stack.push({
        prelude: preludes.at(-1) as string,
        mode: blockMode(preludes),
      })
      statement = i + 1
    } else if (ch === ';' || ch === '}') {
      declaration(i)
      if (ch === '}') stack.pop()
      statement = i + 1
    }
  }
  return hits
}

/** The one declaration of `name` in `mode`'s block across `files`, or why there isn't one. */
export function locate(files: CssFile[], name: string, mode: ThemeMode): Located {
  const hits = files.flatMap((file) => declarations(file, name, mode.id))
  if (hits.length === 0) return { ok: false, reason: 'Not in a plain .css file' }
  if (hits.length > 1) {
    const where = [...new Set(hits.map((hit) => hit.file))]
    return {
      ok: false,
      reason:
        where.length > 1
          ? `Declared in ${where.length} files: ${where.join(', ')}`
          : `Declared more than once in ${where[0]}`,
    }
  }
  const [hit] = hits
  if (hit.awkward) return { ok: false, reason: 'Its value has a comment or !important' }
  const text = files.find((file) => file.path === hit.file)?.text ?? ''
  return {
    ok: true,
    file: hit.file,
    start: hit.start,
    end: hit.end,
    value: text.slice(hit.start, hit.end),
  }
}

/**
 * Writes every edit or none. Files are read fresh, every edit must still locate, and each
 * changed file is replaced whole by rename, keeping its permissions.
 */
export async function writeThemeEdits(
  root: string,
  edits: ThemeEdit[],
  modes: ThemeMode[],
): Promise<{ ok: true; files: string[] } | { ok: false; blocked: string; reason: string }> {
  for (const edit of edits) {
    if (!safeName(edit.name))
      return { ok: false, blocked: edit.name, reason: 'Not a variable name' }
    if (!safeValue(edit.value))
      return {
        ok: false,
        blocked: edit.name,
        reason: 'Not a value Gui can write',
      }
    if (!modes.some((mode) => mode.id === edit.mode)) {
      return { ok: false, blocked: edit.name, reason: 'Unknown theme mode' }
    }
  }
  // One past the cap: a project with more files than Gui reads can't prove a declaration is the only one.
  const paths = await cssFiles(root, MAX_THEME_CSS_FILES + 1)
  if (paths.length > MAX_THEME_CSS_FILES) {
    return {
      ok: false,
      blocked: edits[0]?.name ?? '',
      reason: 'The project has too many .css files',
    }
  }
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      text: await readFile(join(root, path), 'utf8'),
    })),
  )
  const splices = new Map<string, { start: number; end: number; value: string }[]>()
  for (const edit of edits) {
    const found = locate(files, edit.name, modes.find((mode) => mode.id === edit.mode) as ThemeMode)
    if (!found.ok) return { ok: false, blocked: edit.name, reason: found.reason }
    const list = splices.get(found.file) ?? []
    if (list.some((s) => s.start === found.start)) {
      return { ok: false, blocked: edit.name, reason: 'Edited twice' }
    }
    splices.set(found.file, [...list, { start: found.start, end: found.end, value: edit.value }])
  }
  const temps: { tmp: string; file: string }[] = []
  try {
    for (const [path, list] of splices) {
      let text = (files.find((file) => file.path === path) as CssFile).text
      for (const s of [...list].sort((a, b) => b.start - a.start)) {
        text = text.slice(0, s.start) + s.value + text.slice(s.end)
      }
      const file = join(root, path)
      const tmp = await writeTemp(file, text)
      temps.push({ tmp, file })
      await chmod(tmp, (await stat(file)).mode & 0o7777)
    }
  } catch (error) {
    await Promise.all(temps.map(({ tmp }) => rm(tmp, { force: true }).catch(() => undefined)))
    throw error
  }
  // shortcut: a rename failing midway leaves earlier files written; Keep's checkpoint can undo it.
  for (const { tmp, file } of temps) await rename(tmp, file)
  return { ok: true, files: [...splices.keys()] }
}
