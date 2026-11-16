import type { Page } from '@playwright/test'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The board drawn by WebGL2 and by WebGPU (the development switch GUI_BOARD_WEBGPU=1) looks
// the same: one board, two launches, the two pictures compared pixel by pixel. Where WebGPU
// doesn't start the switch falls back to WebGL2, and the comparison is skipped.

/** The width of the texture each frame's tile says the canvas holds for it. */
const thumbWidths = (chrome: Page) =>
  chrome.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-frame]')].map((tile) =>
      Number(tile.dataset.thumb ?? 0),
    ),
  )

const backendOf = (chrome: Page) =>
  chrome.evaluate(
    () =>
      document.querySelector<HTMLCanvasElement>('[role="application"] canvas')?.dataset
        .boardBackend ?? null,
  )

/** A canvas with two captured frames, fitted, every thumbnail drawn: its picture, and what drew it. */
async function picture(session: GuiSession) {
  const { chrome } = session
  await chrome.emulateMedia({ colorScheme: 'light' })
  await chrome.getByRole('button', { name: /New canvas/ }).click()
  await waitFor(async () => (await session.state()).board, 'the canvas')
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('desktop', null)
  })
  await waitFor(async () => {
    const board = (await session.state()).board
    return board?.frames.length === 2 && board.frames.every((frame) => frame.captured)
  }, 'two captured frames')
  await waitFor(async () => (await thumbWidths(chrome)).every((width) => width > 0), 'thumbnails')
  const backend = await waitFor(() => backendOf(chrome), 'a backend')
  const box = await chrome.locator('[role="application"]').boundingBox()
  if (!box) throw new Error('No board')
  // At rest: the same picture twice running.
  let last = ''
  const png = await waitFor(async () => {
    const shot = (await chrome.screenshot({ clip: box })).toString('base64')
    const same = shot === last
    last = shot
    return same && shot
  }, 'the board at rest')
  return { backend, png, widths: await thumbWidths(chrome) }
}

test('the board drawn with WebGPU matches WebGL2 within a small tolerance', async ({
  launch,
}, testInfo) => {
  const gl = await launch({ fixture: 'vite', open: 'recent' })
  const webgl = await picture(gl)
  expect(webgl.backend).toBe('webgl2')
  await gl.close()

  const gpu = await launch({ fixture: 'vite', open: 'recent', env: { GUI_BOARD_WEBGPU: '1' } })
  const webgpu = await picture(gpu)
  console.log(`[e2e] GUI_BOARD_WEBGPU=1 drew with ${webgpu.backend}`)
  test.skip(webgpu.backend !== 'webgpu', 'WebGPU did not start here: it fell back to WebGL2')
  expect(webgpu.widths).toEqual(webgl.widths)

  const diff = await gpu.chrome.evaluate(
    async ([a, b]) => {
      const pixels = async (data: string) => {
        const image = new Image()
        image.src = `data:image/png;base64,${data}`
        await image.decode()
        const context = new OffscreenCanvas(image.width, image.height).getContext('2d')
        if (!context) throw new Error('No 2D canvas')
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, image.width, image.height)
      }
      const [one, two] = [await pixels(a), await pixels(b)]
      if (one.width !== two.width || one.height !== two.height)
        return { size: false, mean: 255, max: 255, off: 1, colors: 0 }
      let sum = 0
      let max = 0
      let off = 0
      const colors = new Set<number>()
      for (let at = 0; at < one.data.length; at += 4) {
        let most = 0
        for (let channel = 0; channel < 3; channel++)
          most = Math.max(most, Math.abs(one.data[at + channel] - two.data[at + channel]))
        sum += most
        max = Math.max(max, most)
        if (most > 8) off++
        colors.add((one.data[at] << 16) | (one.data[at + 1] << 8) | one.data[at + 2])
      }
      const count = one.data.length / 4
      return { size: true, mean: sum / count, max, off: off / count, colors: colors.size }
    },
    [webgl.png, webgpu.png] as const,
  )
  console.log(`[e2e] WebGL2 vs WebGPU: ${JSON.stringify(diff)}`)
  for (const [name, shot] of [
    ['webgl2.png', webgl.png],
    ['webgpu.png', webgpu.png],
  ] as const)
    await testInfo.attach(name, { body: Buffer.from(shot, 'base64'), contentType: 'image/png' })
  expect(diff.size).toBe(true)
  // A picture of frames and their pages, not of an empty board.
  expect(diff.colors).toBeGreaterThan(20)
  // Thumbnails are captured by each launch, and filtered by two drivers: close, not exact.
  expect(diff.mean).toBeLessThan(1)
  expect(diff.off).toBeLessThan(0.005)
})
