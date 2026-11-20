import {
  type BoardCamera,
  SHARP_MAX_EDGE,
  SHARP_MAX_PIXELS,
  SHARP_MAX_SCALE,
  THUMB_MAX_HEIGHT,
  thumbWidthOf,
} from '../../../shared/board'
import { type BoardRect, boardRect, type PageRect, pageRect } from '../../../shared/coords'

/*
 * Zoomed in past what a frame's thumbnail holds (a desktop frame's is two device pixels a CSS
 * pixel, a Retina screen at 200% shows four), the board asks main for the part of the frame in
 * view again, rendered at the zoom, once the camera has held still; and draws it over the
 * thumbnail, in exactly its place (sharp-textures.ts). This is which part, at what scale:
 * plain data, no GPU, so a test can read it.
 */

/** A frame as the board has it this moment (scene.ts's `SceneFrame`). */
export interface SharpFrame {
  id: string
  version: number
  x: number
  y: number
  width: number
  height: number
  captured: boolean
}

/** A part of a frame rendered sharp, as asked for and as drawn. */
export interface SharpTile {
  id: string
  /** The thumbnail version and frame size it was made for: either changing ends it */
  version: number
  width: number
  height: number
  /** The part of the frame, in its page's CSS pixels */
  rect: PageRect
  /** Device pixels for each of its CSS pixels */
  scale: number
}

/** Scales go up in steps of this: a pinch that ends a little further in can keep what it has. */
export const SHARP_STEP = 0.25
/** A thumbnail with this much less than the screen shows is still sharp enough: no tile. */
export const SHARP_SLACK = 1.1
/**
 * A tile reaches this share of the view past what's in view, each side, so a small pan needs
 * nothing new.
 */
export const SHARP_MARGIN = 0.1
/** Every tile together holds at most this many times the view's own device pixels. */
export const SHARP_BUDGET = 1.5
/** A tile this many times denser than the zoom needs is made again for the zoom there is. */
export const SHARP_EXCESS = 1.5

/** How many device pixels a frame's thumbnail has for each of its CSS pixels. */
export const thumbDensity = (frameWidth: number) => thumbWidthOf(frameWidth) / frameWidth

/**
 * The device pixels a CSS pixel of a frame `frameWidth` wide takes at `zoom` on a display of
 * `dpr`, in SHARP_STEPs up to SHARP_MAX_SCALE; 0 when its thumbnail holds enough.
 */
export function sharpScale(frameWidth: number, zoom: number, dpr: number) {
  const need = zoom * dpr
  if (need <= thumbDensity(frameWidth) * SHARP_SLACK) return 0
  return Math.min(SHARP_MAX_SCALE, Math.ceil(need / SHARP_STEP - 1e-9) * SHARP_STEP)
}

/**
 * The part of `frame` its thumbnail covers that's in a view of `size` through `camera`, the
 * view grown by `margin` of its size each side: in the frame's page's CSS pixels, out to whole
 * pixels. Null when none of it is.
 */
export function visiblePart(
  frame: SharpFrame,
  camera: BoardCamera,
  size: { width: number; height: number },
  margin = 0,
): PageRect | null {
  const { zoom } = camera
  const padX = (size.width * margin) / zoom
  const padY = (size.height * margin) / zoom
  const left = Math.max(0, Math.floor(camera.x - padX - frame.x))
  const top = Math.max(0, Math.floor(camera.y - padY - frame.y))
  const right = Math.min(frame.width, Math.ceil(camera.x + size.width / zoom + padX - frame.x))
  const bottom = Math.min(
    frame.height,
    THUMB_MAX_HEIGHT,
    Math.ceil(camera.y + size.height / zoom + padY - frame.y),
  )
  return right > left && bottom > top ? pageRect(left, top, right - left, bottom - top) : null
}

/** Where a part of a frame is on the board: a frame's page pixel is a board pixel. */
export const tileBoardRect = (frame: { x: number; y: number }, rect: PageRect): BoardRect =>
  boardRect(frame.x + rect.x, frame.y + rect.y, rect.width, rect.height)

const contains = (outer: PageRect, inner: PageRect) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height

export const overlaps = (a: PageRect, b: PageRect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

const pixels = (tile: SharpTile) => tile.rect.width * tile.rect.height * tile.scale * tile.scale

/** A tile of `rect` at `scale`, or less where the limits on one render say so; null if too little. */
function tileOf(frame: SharpFrame, rect: PageRect, scale: number): SharpTile | null {
  const fits = Math.min(
    scale,
    SHARP_MAX_EDGE / rect.width,
    SHARP_MAX_EDGE / rect.height,
    Math.sqrt(SHARP_MAX_PIXELS / (rect.width * rect.height)),
  )
  const stepped = Math.floor(fits / SHARP_STEP + 1e-9) * SHARP_STEP
  if (stepped <= thumbDensity(frame.width) * SHARP_SLACK) return null
  return {
    id: frame.id,
    version: frame.version,
    width: frame.width,
    height: frame.height,
    rect,
    scale: stepped,
  }
}

/** Whether `tile` is still of `frame` as it is: the same thumbnail and size. */
export const tileOfFrame = (tile: SharpTile, frame: SharpFrame) =>
  frame.captured &&
  tile.version === frame.version &&
  tile.width === frame.width &&
  tile.height === frame.height

/**
 * The tiles the board wants with the camera still: one for each frame in view whose thumbnail
 * holds too little for the zoom, of the part in view and SHARP_MARGIN around it. A tile it has
 * (`held`) stays while it covers what's in view at enough of a scale, and not wastefully more.
 * Together they hold SHARP_BUDGET times the view's device pixels at most: the frames filling
 * most of the view come first, and those that don't fit keep their thumbnails.
 */
export function planSharp(
  frames: readonly SharpFrame[],
  camera: BoardCamera,
  size: { width: number; height: number },
  dpr: number,
  held: ReadonlyMap<string, SharpTile>,
): SharpTile[] {
  if (size.width <= 0 || size.height <= 0) return []
  const candidates: { options: SharpTile[]; area: number }[] = []
  for (const frame of frames) {
    if (!frame.captured) continue
    const scale = sharpScale(frame.width, camera.zoom, dpr)
    if (!scale) continue
    const seen = visiblePart(frame, camera, size)
    if (!seen) continue
    const tile = held.get(frame.id)
    const kept =
      tile &&
      tileOfFrame(tile, frame) &&
      tile.scale >= scale &&
      tile.scale <= scale * SHARP_EXCESS &&
      contains(tile.rect, seen)
        ? tile
        : null
    const around = visiblePart(frame, camera, size, SHARP_MARGIN) ?? seen
    const options = [kept ?? tileOf(frame, around, scale), tileOf(frame, seen, scale)]
    candidates.push({
      options: options.filter((option): option is SharpTile => option !== null),
      area: seen.width * seen.height,
    })
  }
  candidates.sort((a, b) => b.area - a.area)
  const budget = size.width * size.height * dpr * dpr * SHARP_BUDGET
  let spent = 0
  const wanted: SharpTile[] = []
  for (const { options } of candidates) {
    const tile = options.find((option) => spent + pixels(option) <= budget)
    if (!tile) continue
    spent += pixels(tile)
    wanted.push(tile)
  }
  return wanted
}

/** Two tiles are the same render: the same frame, version, part and scale. */
export const sameTile = (a: SharpTile, b: SharpTile) =>
  a.id === b.id &&
  a.version === b.version &&
  a.width === b.width &&
  a.height === b.height &&
  a.scale === b.scale &&
  a.rect.x === b.rect.x &&
  a.rect.y === b.rect.y &&
  a.rect.width === b.rect.width &&
  a.rect.height === b.rect.height
