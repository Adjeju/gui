import { stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { execFile } from './process'

/**
 * Committing a canvas kept in a git repo (a folder of the user's, canvas-folders.ts): only its
 * own folder's files, whatever else is staged or changed in the repo. Never a push, a branch,
 * an amend or `--no-verify`, and nothing of the repo's config is touched: its hooks run and its
 * identity is used, as when the user commits. Gui never makes a repo either.
 *
 * Git runs only for a canvas the user trusts (its chat runs an agent there already): it can
 * run the repo's own code (hooks, fsmonitor).
 */

/** A canvas's place in its repo. */
export interface CanvasRepo {
  /** The work tree's top folder, its real path */
  top: string
  /** The repo's git folder (a linked worktree's own) */
  gitDir: string
  /** The canvas's folder from `top`, with `/`; `.` when the canvas is the whole repo */
  path: string
}

/** Pathspecs are literal (a folder called `*` is that folder), and fsmonitor doesn't run. */
const BASE = ['--literal-pathspecs', '-c', 'core.fsmonitor=false']

/** The canvas's folder as git names it from the top of its work tree. */
export function canvasPath(top: string, root: string): string | null {
  const rel = relative(top, root)
  if (rel === '') return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('/')) return null
  return rel.split(sep).join('/')
}

/** What's changed under the canvas's folder, untracked files included. */
export const statusArgs = (path: string) => [
  ...BASE,
  'status',
  '--porcelain=v1',
  '-z',
  '--untracked-files=all',
  '--',
  path,
]

/** New, changed and removed files under the canvas's folder, staged; nothing else. */
export const addArgs = (path: string) => [...BASE, 'add', '--all', '--', path]

/**
 * The commit: only the canvas's folder (`--only`), so whatever else the user has staged stays
 * staged and out of it. Hooks run (no `--no-verify`); no amend, no editor.
 */
export const commitArgs = (path: string, message: string) => [
  '--literal-pathspecs',
  'commit',
  '--only',
  '--quiet',
  '-m',
  message,
  '--',
  path,
]

/** Why a commit can't happen now, when a merge, rebase, cherry-pick or revert is under way. */
const IN_PROGRESS: [string, string][] = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
]

export type CommitOutcome =
  | { ok: true; sha: string; branch: string | null }
  | { ok: false; message: string; detail: string | null }

interface GitResult {
  code: number
  out: string
}

export class CanvasGit {
  constructor(
    readonly root: string,
    private readonly env: () => Promise<NodeJS.ProcessEnv>,
  ) {}

  private async git(cwd: string, args: string[]): Promise<GitResult> {
    const env: NodeJS.ProcessEnv = { ...(await this.env()), GIT_TERMINAL_PROMPT: '0' }
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
      delete env[key]
    return new Promise((done) => {
      execFile(
        'git',
        args,
        { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
        (error, stdout, stderr) => {
          const out = [stdout, stderr].map((text) => String(text).trim()).filter(Boolean)
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
          done({ code, out: out.join('\n') })
        },
      )
    })
  }

  /** The repo the canvas is in; null when it isn't in one (or git isn't there). */
  async repo(): Promise<CanvasRepo | null> {
    const found = await this.git(this.root, [
      ...BASE,
      'rev-parse',
      '--is-inside-work-tree',
      '--show-toplevel',
      '--absolute-git-dir',
    ])
    const [inside, top, gitDir] = found.out.split('\n')
    if (found.code !== 0 || inside !== 'true' || !top || !gitDir) return null
    const path = canvasPath(top, this.root)
    return path ? { top, gitDir, path } : null
  }

  /** Whether anything under the canvas's folder differs from what's committed. */
  async changed(repo: CanvasRepo): Promise<boolean> {
    const status = await this.git(repo.top, statusArgs(repo.path))
    return status.code === 0 && status.out.length > 0
  }

  /** What's under way that a commit would get in the middle of; null when nothing is. */
  async busy(repo: CanvasRepo): Promise<string | null> {
    for (const [file, what] of IN_PROGRESS)
      if (await stat(join(repo.gitDir, file)).catch(() => null)) return what
    return null
  }

  /** The canvas's folder, committed as it is now, with `message`. */
  async commit(repo: CanvasRepo, message: string): Promise<CommitOutcome> {
    const busy = await this.busy(repo)
    if (busy)
      return {
        ok: false,
        message: `Not committed: ${busy} is under way in this repo. Finish it, then commit.`,
        detail: null,
      }
    const added = await this.git(repo.top, addArgs(repo.path))
    if (added.code !== 0) return failed(added)
    const committed = await this.git(repo.top, commitArgs(repo.path, message))
    if (committed.code !== 0) return failed(committed)
    const [sha, branch] = await Promise.all([
      this.git(repo.top, [...BASE, 'rev-parse', '--short', 'HEAD']),
      this.git(repo.top, [...BASE, 'symbolic-ref', '--quiet', '--short', 'HEAD']),
    ])
    return { ok: true, sha: sha.out, branch: branch.code === 0 ? branch.out : null }
  }
}

/** Git's own words: its first line in the line, all of it (a hook's output too) one click away. */
function failed({ out }: GitResult): CommitOutcome {
  const lines = out.split('\n').filter((line) => line.trim())
  const first = (lines[0] ?? 'Git stopped without saying why.').replace(/^(fatal|error): /, '')
  return {
    ok: false,
    message: `Not committed: ${first}`,
    detail: lines.length > 1 ? out : null,
  }
}

/** A commit message from the turn's request: its first line, short, after the canvas's name. */
export function commitMessage(canvas: string, prompt: string | null) {
  const line =
    prompt
      ?.split('\n')
      .map((text) => text.trim())
      .find(Boolean) ?? ''
  const subject = line ? `${canvas}: ${line}` : `Update ${canvas}`
  return subject.length > 72 ? `${subject.slice(0, 71).trimEnd()}…` : subject
}
