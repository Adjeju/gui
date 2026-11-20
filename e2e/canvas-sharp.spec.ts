import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Zoomed in past what a frame's thumbnail holds, the board has the part in view rendered
// again at the zoom and draws it over the thumbnail; zoomed back out, it goes. Read from the
// frame's tile (`data-sharp`, the scale it's drawn at), not from the screen's pixels.

/** A page of small text: the kind a soft thumbnail blurs. */
const SMALL_TEXT = `<!doctype html><body style="margin:0;padding:24px;text-align:center;font:9px/12px -apple-system,sans-serif">${Array.from(
  { length: 70 },
  (_, line) => `<p style="margin:0">Line ${line}: the quick brown fox jumps over the lazy dog</p>`,
).join('')}</body>`

const zoom = (chrome: Page) =>
  chrome.evaluate(() =>
    Number(
      document
        .querySelector<HTMLElement>('[style*="--board-zoom"]')
        ?.style.getPropertyValue('--board-zoom'),
    ),
  )

const sharp = (chrome: Page, id: string) =>
  chrome.evaluate(
    (id) => Number(document.querySelector<HTMLElement>(`[data-frame="${id}"]`)?.dataset.sharp ?? 0),
    id,
  )

/** Presses `key` on the board, one a poll, until the zoom is what's `wanted`. */
const zoomUntil = (session: GuiSession, key: string, wanted: (zoom: number) => boolean) =>
  waitFor(async () => {
    if (wanted(await zoom(session.chrome))) return true
    await session.chrome.keyboard.press(key)
    return false
  }, `zoomed with ${key}`)

test('zoomed in past a frame’s thumbnail, the part in view is drawn sharp at the zoom', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await chrome.getByRole('button', { name: /New canvas/ }).click()
  await waitFor(async () => (await session.state()).board, 'the canvas')
  await chrome.evaluate(() => window.gui.boardAddFrame('desktop', null))
  const added = await waitFor(
    async () => (await session.state()).board?.frames.find((frame) => frame.captured) ?? null,
    'a captured frame',
  )
  const root = (await session.state()).project?.root
  if (!root) throw new Error('No canvas folder')
  // Wider than a desktop frame, so its thumbnail is one device pixel a CSS pixel (a desktop
  // frame's is two): at 200% a Retina screen shows four, a standard one two.
  await chrome.evaluate((id) => window.gui.boardArrange([{ id, width: 2000 }]), added.id)
  writeFileSync(join(root, 'frames', `${added.id}.html`), SMALL_TEXT)
  await waitFor(async () => {
    const frame = (await session.state()).board?.frames.find((f) => f.id === added.id)
    return frame && frame.width === 2000 && frame.version > added.version && !frame.rendering
      ? frame
      : null
  }, 'its new thumbnail')

  const board = chrome.getByRole('application')
  await board.focus()
  await chrome.keyboard.press('Shift+Digit1')
  await zoomUntil(session, '=', (z) => z >= 2 - 1e-9)
  const dpr = await chrome.evaluate(() => devicePixelRatio)
  const expected = Math.min(4, Math.ceil(2 * dpr * 4) / 4)
  await waitFor(async () => (await sharp(chrome, added.id)) === expected, `a tile at ${expected}×`)
  expect(await sharp(chrome, added.id)).toBeGreaterThan(1)

  // Zoomed out to where the thumbnail holds enough: the tile goes.
  await zoomUntil(session, '-', (z) => z * dpr <= 1)
  await waitFor(async () => (await sharp(chrome, added.id)) === 0, 'the tile gone')
})
