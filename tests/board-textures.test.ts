import { expect, test } from 'bun:test'
import {
  DrawPlan,
  SHARP_REST_MS,
  thumbBudget,
  ZOOM_REST_MS,
} from '../src/renderer/src/board/draw-plan'
import { QUAD, QUAD_STRIDE, type SceneInput, type ThumbWant } from '../src/renderer/src/board/scene'
import type { TextureUpload } from '../src/renderer/src/board/textures'

// Which thumbnails the board holds as textures, and when it loads, replaces and frees them:
// the policy apart from the GPU (draw-plan.ts), run here with no GPU at all.

interface Fake {
  n: number
  width: number
  mips: boolean
}

/** A GPU that records what it's asked to make and free. */
function fakeGpu() {
  let made = 0
  const live = new Set<Fake>()
  const upload: TextureUpload<Fake> = {
    upload: (bitmap, mips) => {
      const texture = { n: ++made, width: bitmap.width, mips }
      live.add(texture)
      return texture
    },
    release: (texture) => {
      if (!live.delete(texture)) throw new Error('freed twice, or never made')
    },
  }
  return { upload, live, made: () => made }
}

/** Thumbnails that load at once, at the width asked for; `fail` ids have none. */
function fakeLoads(fail = new Set<string>()) {
  const asked: string[] = []
  const thumb = async (want: ThumbWant) => {
    asked.push(`${want.id}:${want.width}`)
    if (fail.has(want.id)) throw new Error('No thumbnail')
    return {
      width: want.width,
      height: Math.round((want.width * 900) / 1440),
      close() {},
    } as unknown as ImageBitmap
  }
  return { asked, load: { thumb, sharp: async () => null } }
}

const frame = (id: string, x: number, y = 0) => ({
  id,
  x,
  y,
  width: 1440,
  height: 900,
  version: 1,
  captured: true,
})

const input = (frames = [frame('a', 0), frame('b', 1540)]): SceneInput => ({
  frames,
  sections: [],
  selected: new Set(),
  handle: null,
  hovered: null,
  marquee: null,
})

/** A Retina window's board. */
const view = { width: 1440, height: 900 }
const scale = 2
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function draw(plan: DrawPlan<Fake>, scene: SceneInput, zoom: number, now: number, x = 0) {
  const camera = { x, y: 0, zoom }
  const { scene: drawn, textures } = plan.begin(scene, camera, view, scale, now)
  const kinds = Array.from(
    { length: drawn.quads.count },
    (_, i) => drawn.quads.data[i * QUAD_STRIDE + 7],
  )
  const textured = textures.filter(Boolean) as Fake[]
  const again = plan.end(camera, now)
  return { kinds, textured, again }
}

test('a frame with nothing to show loads at once, drawn flat until its texture is in', async () => {
  const gpu = fakeGpu()
  const loads = fakeLoads()
  const plan = new DrawPlan(gpu.upload, loads.load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  // 0.25: each frame 360 CSS pixels wide, 720 device pixels, so 1024-wide textures.
  const first = draw(plan, input(), 0.25, 0)
  expect(first.textured).toEqual([])
  expect(first.kinds).not.toContain(QUAD.thumb)
  expect(loads.asked).toEqual(['a:1024', 'b:1024'])
  expect(plan.thumbWidth('a')).toBe(0)
  await settle()
  // Uploaded in the next draw, which it asks for at once.
  const second = draw(plan, input(), 0.25, 1000)
  expect(second.again).toBe(0)
  const third = draw(plan, input(), 0.25, 2000)
  expect(third.textured.map((t) => t.width)).toEqual([1024, 1024])
  expect(third.kinds.filter((kind) => kind === QUAD.thumb)).toHaveLength(2)
  expect(plan.thumbWidth('a')).toBe(1024)
  // Wider than the small file: mip levels, for a pinch that draws it smaller.
  expect([...gpu.live].every((t) => t.mips)).toBe(true)
  expect(third.again).toBeNull()
})

test('zoomed, a frame keeps the texture it has until the zoom rests, then swaps without a blank', async () => {
  const gpu = fakeGpu()
  const loads = fakeLoads()
  const plan = new DrawPlan(gpu.upload, loads.load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  draw(plan, input(), 0.25, 0)
  await settle()
  draw(plan, input(), 0.25, 1000)
  const before = draw(plan, input(), 0.25, 2000).textured
  loads.asked.length = 0

  // Out to 0.1: each frame 288 device pixels wide, so 360 from the small file, once still.
  const moving = draw(plan, input(), 0.1, 3000)
  expect(moving.textured).toEqual(before)
  expect(loads.asked).toEqual([])
  expect(moving.again).toBe(ZOOM_REST_MS)
  draw(plan, input(), 0.1, 3000 + ZOOM_REST_MS)
  expect(loads.asked).toEqual(['a:360', 'b:360'])
  await settle()
  // Until the new one is uploaded, the old one draws.
  const swapping = draw(plan, input(), 0.1, 4000)
  expect(swapping.textured).toEqual(before)
  const after = draw(plan, input(), 0.1, 5000)
  expect(after.textured.map((t) => t.width)).toEqual([360, 360])
  expect(after.textured.every((t) => !t.mips)).toBe(true)
  // The old ones are freed as the new ones go in.
  expect(gpu.live.size).toBe(2)
})

test('over budget, frames out of view give up theirs, the longest unseen first; in view never', async () => {
  const gpu = fakeGpu()
  const loads = fakeLoads()
  const plan = new DrawPlan(gpu.upload, loads.load, () => {})
  // A tiny canvas: its budget is about the 32 MB of room for what was just looked at.
  plan.resize({ width: 1, height: 1 })
  expect(thumbBudget({ width: 1, height: 1 })).toBeCloseTo(32 * 1048576 + 16, 0)
  // Frames one view apart, each 1440 wide at zoom 1: 1440 × 900 textures, 6.9 MB with levels.
  const frames = Array.from({ length: 6 }, (_, i) => frame(`f${i}`, i * 1440))
  const scene = input(frames)
  let now = 0
  const look = async (i: number) => {
    now += 1000
    draw(plan, scene, 1, now, i * 1440)
    await settle()
    now += 1000
    draw(plan, scene, 1, now, i * 1440)
  }
  for (let i = 0; i < frames.length; i++) await look(i)
  // Four fit; the oldest went first.
  const held = () => frames.map((f) => plan.thumbWidth(f.id) > 0)
  expect(held()).toEqual([false, false, true, true, true, true])
  // Back to the first: it loads again, and the longest unseen of the rest make room.
  await look(0)
  // (The second's shadow reaches into the view at its edge: it's drawn, so it loads too.)
  expect(held()).toEqual([true, true, false, false, true, true])
})

test('frames that leave the board, and the board itself, free what they hold', async () => {
  const gpu = fakeGpu()
  const plan = new DrawPlan(gpu.upload, fakeLoads().load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  draw(plan, input(), 0.25, 0)
  await settle()
  draw(plan, input(), 0.25, 1000)
  expect(gpu.live.size).toBe(2)
  plan.keep(new Set(['b']))
  expect(gpu.live.size).toBe(1)
  expect(plan.thumbWidth('a')).toBe(0)
  plan.dispose()
  expect(gpu.live.size).toBe(0)
})

test('a thumbnail that fails to load is not asked for again until the frame wants another', async () => {
  const loads = fakeLoads(new Set(['a']))
  const plan = new DrawPlan(fakeGpu().upload, loads.load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  draw(plan, input(), 0.25, 0)
  await settle()
  draw(plan, input(), 0.25, 1000)
  draw(plan, input(), 0.25, 2000)
  expect(loads.asked.filter((asked) => asked.startsWith('a:'))).toEqual(['a:1024'])
  draw(plan, input(), 0.1, 3000)
  draw(plan, input(), 0.1, 3000 + ZOOM_REST_MS)
  expect(loads.asked.filter((asked) => asked.startsWith('a:'))).toEqual(['a:1024', 'a:360'])
})

test('a lost GPU loses every texture without freeing it, and each loads again as drawn', async () => {
  const gpu = fakeGpu()
  const loads = fakeLoads()
  const plan = new DrawPlan(gpu.upload, loads.load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  draw(plan, input(), 0.25, 0)
  await settle()
  draw(plan, input(), 0.25, 1000)
  const changes = plan.changes
  plan.lost()
  expect(plan.changes).toBeGreaterThan(changes)
  expect(plan.thumbWidth('a')).toBe(0)
  // Gone with the device: nothing to release.
  expect(gpu.live.size).toBe(2)
  gpu.live.clear()
  loads.asked.length = 0
  draw(plan, input(), 0.25, 2000)
  expect(loads.asked).toEqual(['a:1024', 'b:1024'])
})

test('a draw is asked for once the camera has held still, for the sharp tiles', () => {
  const plan = new DrawPlan(fakeGpu().upload, fakeLoads().load, () => {})
  plan.resize({ width: 2880, height: 1800 })
  const moved = draw(plan, input([]), 0.25, 0)
  expect(moved.again).toBe(SHARP_REST_MS)
  expect(draw(plan, input([]), 0.25, 100).again).toBe(SHARP_REST_MS - 100)
  expect(draw(plan, input([]), 0.25, SHARP_REST_MS).again).toBeNull()
})
