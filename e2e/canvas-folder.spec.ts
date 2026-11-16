import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardState, RecentBoard } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

/** Git for the test's own repo: none of the developer's config. */
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

// A canvas kept in a folder of the user's, outside Gui's data (inside a project's repo here):
// made there with New Canvas, listed under Recent canvases, opened again from there and with
// File › Open, and told apart when it's moved away outside Gui.

/** New Canvas's sheet, answered with `path` as if the user picked it and pressed Create. */
function answerSaveSheet(session: GuiSession, path: string) {
  return session.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (() =>
      Promise.resolve({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog
  }, path)
}

/** File › Open's sheet, answered with `path`. */
function answerOpenSheet(session: GuiSession, path: string) {
  return session.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog
  }, path)
}

const board = (session: GuiSession): Promise<BoardState> =>
  waitFor(async () => (await session.state()).board, 'the canvas')

/** Closes the canvas's tab, leaving the window's start screen. */
async function closeCanvas(session: GuiSession) {
  const { activeTab } = await session.state()
  await session.chrome.evaluate(() => window.gui.newTab())
  await session.chrome.evaluate((id) => window.gui.closeTab(id), activeTab)
  await waitFor(async () => {
    const state = await session.state()
    return state.tabs.length === 1 && !state.board
  }, 'the start screen')
}

const listed = (session: GuiSession, folder: string) =>
  waitFor(
    async () =>
      (await session.state()).recentBoards?.find((entry: RecentBoard) => entry.folder === folder),
    'the canvas under Recent canvases',
  )

test('a canvas made in a folder of the user’s holds only its own files, and opens again from Recents and File › Open', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  const repo = join(session.fixture.base, 'my-app')
  mkdirSync(join(repo, 'design'), { recursive: true })
  const folder = join(repo, 'design', 'landing')
  await answerSaveSheet(session, folder)

  await chrome.getByRole('button', { name: /New canvas/ }).click()
  const made = await board(session)
  expect(made.name).toBe('landing')
  expect((await session.state()).project?.root).toBe(folder)
  await chrome.evaluate(() => window.gui.boardAddFrame('desktop', null))
  await waitFor(async () => (await board(session)).frames[0]?.captured, 'a thumbnail')
  // Only what a canvas is: no hidden files, nothing of Gui's own (thumbnails stay in its data).
  expect(readdirSync(folder).sort()).toEqual(['assets', 'canvas.json', 'frames'])
  expect(readdirSync(join(folder, 'frames'))).toEqual(['desktop.html'])
  expect(existsSync(join(session.fixture.userData, 'canvas-thumbnails', made.id))).toBe(true)
  await session.shot('canvas-in-folder')

  await closeCanvas(session)
  const recent = await listed(session, folder)
  expect(recent).toMatchObject({ id: made.id, name: 'landing', missing: false })
  await expect(chrome.getByRole('button', { name: /^landing/ })).toBeVisible()
  await session.shot('recent-canvas-folder')
  await chrome.getByRole('button', { name: /^landing/ }).click()
  const reopened = await board(session)
  expect(reopened.id).toBe(made.id)
  expect(reopened.frames.map((frame) => frame.id)).toEqual(['desktop'])

  // File › Open on the folder opens it as the canvas it is, not as a project.
  await closeCanvas(session)
  await answerOpenSheet(session, folder)
  await chrome.evaluate(() => window.gui.openProject())
  const opened = await board(session)
  expect(opened.id).toBe(made.id)
  expect((await session.state()).project?.root).toBe(folder)

  // Moved away outside Gui: its entry says so, and can leave the list.
  await closeCanvas(session)
  renameSync(folder, join(repo, 'design', 'moved'))
  await session.acceptConsentDialogs()
  await chrome.evaluate((id) => window.gui.openBoard(id), made.id)
  await waitFor(
    async () =>
      (await session.consentPrompts()).some(
        (prompt) => prompt.message === 'This canvas moved or was deleted',
      ),
    'the moved message',
  )
  await waitFor(
    async () =>
      !(await session.state()).recentBoards?.some((entry: RecentBoard) => entry.id === made.id),
    'the entry removed',
  )
  expect((await session.state()).board).toBe(null)
})

test('in a git repo, the line under the turn commits the canvas and nothing else', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const repo = join(session.fixture.base, 'shop')
  const hooks = join(session.fixture.base, 'no-hooks')
  mkdirSync(join(repo, 'design'), { recursive: true })
  mkdirSync(hooks)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: GIT_ENV })
  git('init', '-q', '-b', 'main')
  // The repo's own identity, and none of the developer's hooks or signing.
  git('config', 'user.name', 'Gui Test')
  git('config', 'user.email', 'gui-test@example.com')
  git('config', 'core.hooksPath', hooks)
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(repo, 'notes.md'), 'notes\n')

  const folder = join(repo, 'design', 'landing')
  await answerSaveSheet(session, folder)
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  await board(session)
  git('add', '.')
  git('commit', '-q', '-m', 'start')
  // The user's own work in progress, elsewhere in the repo: one change unstaged, one staged.
  writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')
  writeFileSync(join(repo, 'notes.md'), 'staged notes\n')
  git('add', 'notes.md')

  await installToolAgent(session)
  await ask(session, [
    {
      name: 'canvas_create_frame',
      args: { name: 'Hero', width: 1440, height: 900, html: '<h1>Hero</h1>' },
    },
  ])
  const offered = await waitFor(async () => {
    const offer = (await session.chatSnapshot()).meta.canvasCommit
    return offer?.state === 'offered' && offer
  }, 'the commit line')
  expect(offered.message).toMatch(/^landing: /)
  const line = session.chat.locator('[data-canvas-commit]')
  await expect(line).toBeVisible()
  await line.getByLabel('Commit message').fill('Add a hero frame')
  await session.shot('commit-line-offered')
  await line.getByRole('button', { name: 'Commit to git' }).click()
  const committed = await waitFor(async () => {
    const offer = (await session.chatSnapshot()).meta.canvasCommit
    return offer?.state === 'committed' && offer
  }, 'the commit')
  expect(committed.note).toMatch(/^Committed [0-9a-f]{7,} to main$/)
  await expect(line.getByRole('status')).toHaveText(committed.note ?? '')
  await session.shot('commit-line-committed')

  const files = git('show', '--name-only', '--format=%s', 'HEAD').trim().split('\n')
  expect(files[0]).toBe('Add a hero frame')
  expect(files.slice(2).every((file) => file.startsWith('design/landing/'))).toBe(true)
  expect(files).toContain('design/landing/frames/hero.html')
  expect(git('status', '--porcelain')).toBe(' M app.ts\nM  notes.md\n')
})
