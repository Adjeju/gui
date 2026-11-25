import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ThemePanelState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The Theme popover (toolbar → Theme) lists the project's CSS variables, previews a change
// live in the page, and writes nothing until Keep, which is a chat line with Undo. Other
// agents read the same theme through preview_theme.

declare global {
  interface Window {
    themeStates?: ThemePanelState[]
  }
}

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function pageEnding(session: GuiSession, suffix: string): Promise<Page> {
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith(suffix) && !page.isClosed())
  return waitFor(find, suffix, { timeout: 30_000 })
}

/** Records every state the popover is sent from here on. */
async function watchTheme(popover: Page) {
  await popover.waitForFunction(() => 'gui' in window)
  await popover.evaluate(() => {
    window.themeStates = []
    window.gui.onThemeState((state) => window.themeStates?.push(state))
  })
  return (check: (state: ThemePanelState) => boolean, label: string) =>
    waitFor(async () => {
      const state = await popover.evaluate(() => window.themeStates?.at(-1) ?? null)
      return state && check(state) ? state : null
    }, label)
}

test('the Theme popover edits a variable live, cancels, keeps with Undo, and the agent can read it', async ({
  launch,
}) => {
  const port = await freePort()
  const session = await launch({
    fixture: 'vite',
    env: { GUI_E2E_OUTSIDE_MCP_PORT: String(port) },
  })
  await session.waitForPreview()
  const css = join(session.fixture.root, 'src/index.css')
  const original = readFileSync(css, 'utf8')
  const background = () => session.styleOf('button.counter', 'backgroundColor')
  expect(await background()).toBe('rgb(226, 232, 240)')

  await session.chrome.evaluate(() => window.gui.toggleTheme())
  const popover = await pageEnding(session, '/theme.html')
  const themeWhere = await watchTheme(popover)
  // Asking for the page's own mode sends the state again, now that we listen.
  await popover.evaluate(() => window.gui.themeMode(null))

  const listed = await themeWhere(
    (state) => !!state.snapshot?.variables.some((v) => v.name === '--brand-bg'),
    'the theme to list --brand-bg',
  )
  expect(listed.snapshot?.modes.map((mode) => mode.id)).toEqual(['default', 'dark'])
  const brand = listed.snapshot?.variables.find((v) => v.name === '--brand-bg')
  expect(brand?.values).toEqual({ default: '#e2e8f0', dark: '#1e293b' })
  expect(brand?.uses).toBeGreaterThanOrEqual(1)
  expect(brand?.locked).toBeNull()

  // A preview shows in the page at once; the file stays as it was.
  const edit = { name: '--brand-bg', mode: 'default', value: '#7c3aed' }
  await popover.evaluate((e) => window.gui.themePreview(e), edit)
  await waitFor(async () => (await background()) === 'rgb(124, 58, 237)', 'the live preview')
  expect(readFileSync(css, 'utf8')).toBe(original)

  // Cancel puts the page back.
  await popover.evaluate(() => window.gui.themeCancel())
  await waitFor(async () => (await background()) === 'rgb(226, 232, 240)', 'the cancel')
  await themeWhere((state) => state.pending.length === 0, 'no pending edits')
  expect(readFileSync(css, 'utf8')).toBe(original)

  // Keep writes it, as a line in the chat with Undo.
  await popover.evaluate((e) => window.gui.themePreview(e), edit)
  await themeWhere((state) => state.pending.length === 1, 'the edit to be pending')
  await popover.evaluate(() => window.gui.themeKeep())
  await waitFor(
    () => readFileSync(css, 'utf8').includes('--brand-bg: #7c3aed;'),
    'the theme change to be written',
  )
  expect(readFileSync(css, 'utf8')).toBe(
    original.replace('--brand-bg: #e2e8f0;', '--brand-bg: #7c3aed;'),
  )
  const turn = await waitFor(
    async () => (await session.chatSnapshot()).turns[0] ?? null,
    'the theme change in the chat',
  )
  expect(turn.themeEdits?.[0]?.name).toBe('--brand-bg')
  expect(turn.themeEdits?.[0]).toMatchObject({ before: '#e2e8f0', after: '#7c3aed' })

  await session.expandChat()
  const line = session.chat.locator(`[data-direct-edit="${turn.id}"]`)
  await line.getByRole('button', { name: 'Undo' }).click()
  await waitFor(() => readFileSync(css, 'utf8') === original, 'the theme change to be undone')
  await expect(line).toContainText('Undone')

  // An agent outside Gui reads the same theme.
  await session.chrome.evaluate(() => window.gui.openSettings('agents'))
  const settings = await pageEnding(session, '/settings.html')
  await settings.waitForFunction(() => 'gui' in window)
  await settings.getByRole('switch', { name: 'Let other agents use Gui' }).click()
  const url = `http://127.0.0.1:${port}/mcp`
  await waitFor(
    () =>
      fetch(url, { method: 'POST' }).then(
        (reply) => reply.status === 401,
        () => false,
      ),
    'Gui listening for other agents',
  )
  const token = readFileSync(join(session.fixture.userData, 'outside-agents-token'), 'utf8').trim()
  const reply = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'preview_theme', arguments: {} },
    }),
  })
  const result = (await reply.json()).result as { isError?: boolean; content: { text: string }[] }
  expect(result.isError).not.toBe(true)
  expect(result.content.map((c) => c.text).join('\n')).toContain('--brand-bg')
})
