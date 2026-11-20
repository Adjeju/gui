import { expect, test } from 'bun:test'
import {
  planSharp,
  SHARP_BUDGET,
  type SharpFrame,
  type SharpTile,
  sharpScale,
  visiblePart,
} from '../src/renderer/src/board/sharp'
import { isSharpRequest, SHARP_MAX_PIXELS, THUMB_MAX_HEIGHT } from '../src/shared/board'

// Zoomed in past what a thumbnail holds, which part of each frame the board asks for again,
// rendered at the zoom: plain data, readable without a GPU or main.

const desktop = (id = 'a', x = 0, y = 0, over: Partial<SharpFrame> = {}): SharpFrame => ({
  id,
  version: 1,
  x,
  y,
  width: 1440,
  height: 900,
  captured: true,
  ...over,
})
const mobile = (id = 'm', x = 0, y = 0): SharpFrame => ({
  id,
  version: 1,
  x,
  y,
  width: 390,
  height: 844,
  captured: true,
})
/** A Retina window's board, 1440 × 900 CSS pixels. */
const view = { width: 1440, height: 900 }
const none = new Map<string, SharpTile>()
const rect = (tile: SharpTile | undefined) =>
  tile && [tile.rect.x, tile.rect.y, tile.rect.width, tile.rect.height]
const pixels = (tiles: SharpTile[]) =>
  tiles.reduce((sum, t) => sum + t.rect.width * t.rect.height * t.scale * t.scale, 0)

test('a frame is rendered sharp only where its thumbnail holds too little for the zoom', () => {
  // A desktop frame's thumbnail, like a narrower frame's, is 2 device pixels a CSS pixel.
  expect(sharpScale(1440, 0.5, 2)).toBe(0)
  expect(sharpScale(1440, 1, 2)).toBe(0)
  expect(sharpScale(1440, 1.1, 2)).toBe(0)
  expect(sharpScale(1440, 2, 2)).toBe(4)
  // In steps of a quarter, rounded up: never less than the screen shows.
  expect(sharpScale(1440, 1.3, 2)).toBe(2.75)
  expect(sharpScale(1440, 2, 1)).toBe(0)
  expect(sharpScale(1440, 3, 1)).toBe(3)
  expect(sharpScale(390, 1, 2)).toBe(0)
  expect(sharpScale(390, 2, 2)).toBe(4)
  // Wider than a desktop frame: captured at 1×.
  expect(sharpScale(2000, 0.5, 2)).toBe(0)
  expect(sharpScale(2000, 1, 2)).toBe(2)
})

test('zoomed in to 200% on a desktop frame, the part in view is asked for at 4×, with a margin', () => {
  // The view's centre on the frame's centre at 200%: 720 × 450 of the frame in view.
  const camera = { x: 360, y: 225, zoom: 2 }
  expect(visiblePart(desktop(), camera, view)).toEqual(
    expect.objectContaining({ x: 360, y: 225, width: 720, height: 450 }),
  )
  const [tile] = planSharp([desktop()], camera, view, 2, none)
  expect(tile.scale).toBe(4)
  // A tenth of the view more each side: 72 × 45 frame pixels at 200%.
  expect(rect(tile)).toEqual([288, 180, 864, 540])
  expect(tile).toMatchObject({ id: 'a', version: 1, width: 1440, height: 900 })
})

test('a frame partly in view, or out of it, or not captured yet, asks for only what shows', () => {
  // The frame's right half off the view's left edge.
  const camera = { x: 1000, y: 0, zoom: 2 }
  const [tile] = planSharp([desktop()], camera, view, 2, none)
  expect(rect(tile)).toEqual([928, 0, 512, 495])
  expect(planSharp([desktop('a', 5000, 0)], camera, view, 2, none)).toEqual([])
  expect(planSharp([desktop('a', 1000, 0, { captured: false })], camera, view, 2, none)).toEqual([])
})

test('a tall frame is sharpened only as far down as its thumbnail goes', () => {
  const tall = desktop('t', 0, 0, { height: 4000 })
  const camera = { x: 0, y: THUMB_MAX_HEIGHT - 100, zoom: 2 }
  const [tile] = planSharp([tall], camera, view, 2, none)
  expect(tile.rect.y + tile.rect.height).toBe(THUMB_MAX_HEIGHT)
  expect(planSharp([tall], { x: 0, y: THUMB_MAX_HEIGHT + 10, zoom: 2 }, view, 2, none)).toEqual([])
})

test('a tile is kept for a small pan or zoom, and made again past its margin or its scale', () => {
  const camera = { x: 360, y: 225, zoom: 2 }
  const [tile] = planSharp([desktop()], camera, view, 2, none)
  const held = new Map([[tile.id, tile]])
  // A pan within the margin: the same tile.
  expect(planSharp([desktop()], { ...camera, x: 400 }, view, 2, held)[0]).toBe(tile)
  // Past it: a new part.
  const panned = planSharp([desktop()], { ...camera, x: 500 }, view, 2, held)[0]
  expect(panned).not.toBe(tile)
  expect(panned.rect.x).toBeGreaterThan(tile.rect.x)
  // Zoomed out a little (and still covered): at 3.75× needed, 4× is kept.
  expect(planSharp([desktop()], { x: 380, y: 235, zoom: 1.9 }, view, 2, held)[0]).toBe(tile)
  // Zoomed out far: 4× where 2.5× is needed is wasted pixels, so it's made again.
  const out = planSharp([desktop()], { x: 0, y: 0, zoom: 1.25 }, view, 2, held)[0]
  expect(out.scale).toBe(2.5)
  // Zoomed back to where the thumbnail is enough: nothing.
  expect(planSharp([desktop()], { x: 0, y: 0, zoom: 1 }, view, 2, held)).toEqual([])
})

test('a frame whose thumbnail changed, or that was resized, gets a new tile', () => {
  const camera = { x: 360, y: 225, zoom: 2 }
  const [tile] = planSharp([desktop()], camera, view, 2, none)
  const held = new Map([[tile.id, tile]])
  expect(planSharp([desktop('a', 0, 0, { version: 2 })], camera, view, 2, held)[0]).toMatchObject({
    version: 2,
  })
  const wider = planSharp([desktop('a', 0, 0, { width: 1600 })], camera, view, 2, held)[0]
  expect(wider).not.toBe(tile)
  expect(wider.width).toBe(1600)
})

test('all the tiles together hold at most the budget, the frames filling most of the view first', () => {
  // A grid of phone frames at 200%: twelve in view, each of 2× thumbnails.
  const frames = Array.from({ length: 24 }, (_, i) =>
    mobile(`m${i}`, (i % 6) * 200, Math.floor(i / 6) * 220),
  )
  const tiles = planSharp(frames, { x: 0, y: 0, zoom: 2 }, view, 2, none)
  expect(tiles.length).toBeGreaterThan(0)
  expect(pixels(tiles)).toBeLessThanOrEqual(view.width * view.height * 4 * SHARP_BUDGET)
  // At 100% a frame wider than a desktop's (captured at 1×) and a phone beside it: only the
  // wide frame's thumbnail is short.
  const both = planSharp(
    [desktop('a', 0, 0, { width: 2000 }), mobile('m', 1000, 0)],
    { x: 0, y: 0, zoom: 1 },
    view,
    2,
    none,
  )
  expect(both.map((t) => t.id)).toEqual(['a'])
  // Two desktop frames filling a tall view at 125%: both fit.
  const big = planSharp(
    [desktop('a'), desktop('b', 0, 920)],
    { x: 0, y: 0, zoom: 1.25 },
    { width: 1440, height: 1800 },
    2,
    none,
  )
  expect(big.map((t) => t.id).sort()).toEqual(['a', 'b'])
  expect(pixels(big)).toBeLessThanOrEqual(1440 * 1800 * 4 * SHARP_BUDGET)
})

test('main takes a sharp request only within its frame, its thumbnail, and the limits', () => {
  const frame = { width: 1440, height: 900 }
  const ok = { id: 'a', rect: { x: 288, y: 180, width: 864, height: 540 }, scale: 4 }
  expect(isSharpRequest(ok, frame)).toBe(true)
  expect(isSharpRequest(ok, null)).toBe(false)
  expect(isSharpRequest({ ...ok, id: '../x' }, frame)).toBe(false)
  expect(isSharpRequest({ ...ok, scale: 5 }, frame)).toBe(false)
  expect(isSharpRequest({ ...ok, scale: 0 }, frame)).toBe(false)
  expect(isSharpRequest({ ...ok, rect: { ...ok.rect, x: 0.5 } }, frame)).toBe(false)
  expect(isSharpRequest({ ...ok, rect: { ...ok.rect, x: 700 } }, frame)).toBe(false)
  expect(isSharpRequest({ ...ok, rect: { ...ok.rect, y: -1 } }, frame)).toBe(false)
  expect(
    isSharpRequest(
      { id: 'a', rect: { x: 0, y: 0, width: 1440, height: 3000 }, scale: 4 },
      { width: 1440, height: 4000 },
    ),
  ).toBe(false)
  expect(SHARP_MAX_PIXELS).toBeLessThan(1440 * 3000 * 16)
  expect(isSharpRequest('a', frame)).toBe(false)
})
