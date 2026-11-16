import type { BoardCamera } from '../../../shared/board'
import type { BoardSources } from './backend'
import { buildScene, QUAD, QUAD_STRIDE, QuadList, type Scene, type SceneInput } from './scene'
import { decodeSharp, type SharpLoad, SharpTextures } from './sharp-textures'
import { fetchThumb, type TextureUpload, type ThumbLoad, ThumbTextures } from './textures'

/*
 * One draw of the board, without the GPU: the scene for the camera, which texture each quad
 * draws with, and afterwards what to load, replace or free and how soon to draw again. Both
 * backends (backend.ts) draw through it, each with its own `TextureUpload`; a test can run it
 * with none.
 */

/** Textures are replaced for the zoom there is once it has held still this long. */
export const ZOOM_REST_MS = 120
/** Frames in view are rendered sharp for the zoom once the camera has held still this long. */
export const SHARP_REST_MS = 150

/** Bytes of thumbnail texture held for a canvas of `device` pixels. */
export const thumbBudget = (device: { width: number; height: number }) =>
  // What's in view holds at most three times the canvas's pixels (`THUMB_TIERS`), and a
  // third again in mip levels; the rest is room for what was just looked at.
  device.width * device.height * 4 * 3 * (4 / 3) + 32 * 1048576

export interface PlannedDraw<T> {
  scene: Scene
  /** By quad, the texture it's drawn with; none for a quad without a thumbnail */
  textures: (T | undefined)[]
}

export class DrawPlan<T> {
  private readonly thumbs: ThumbTextures<T>
  private readonly sharp: SharpTextures<T>
  private readonly quads = new QuadList()
  private readonly textures: (T | undefined)[] = []
  /** The zoom last drawn, and when it last changed */
  private zoom = 0
  private zoomedAt = 0
  /**
   * Where the camera, the view and the frames were last drawn, and when that last changed: a
   * frame dragged or a window resized moves what's in view as a pan does.
   */
  private placed = ''
  private movedAt = 0
  /** How long until the camera has held still for sharp tiles, as of the last draw begun */
  private resting = 0

  constructor(
    upload: TextureUpload<T>,
    sources: BoardSources | { thumb: ThumbLoad; sharp: SharpLoad },
    changed: () => void,
  ) {
    const load =
      'thumbUrl' in sources
        ? { thumb: fetchThumb(sources.thumbUrl), sharp: decodeSharp(sources.sharpTile) }
        : sources
    this.thumbs = new ThumbTextures(upload, load.thumb, changed)
    this.sharp = new SharpTextures(upload, load.sharp, changed)
  }

  /** The canvas is this many device pixels: what's held of thumbnails follows. */
  resize(device: { width: number; height: number }) {
    this.thumbs.budget = thumbBudget(device)
  }

  /**
   * Before drawing: what's in view, and which texture each quad draws with. A quad whose
   * texture isn't in yet becomes a flat one, its frame's fill; a thumbnail's height on screen
   * is set from its texture's.
   */
  begin(
    input: SceneInput,
    camera: BoardCamera,
    view: { width: number; height: number },
    scale: number,
    now: number,
  ): PlannedDraw<T> {
    let placed = `${camera.x},${camera.y},${camera.zoom},${view.width},${view.height},${scale}`
    for (const frame of input.frames)
      placed += `|${frame.id},${frame.x},${frame.y},${frame.width},${frame.height}`
    const moved = placed !== this.placed
    if (moved) {
      this.placed = placed
      this.movedAt = now
    }
    this.resting = SHARP_REST_MS - (now - this.movedAt)
    this.sharp.update(input.frames, camera, view, scale, moved, this.resting <= 0)
    const scene = buildScene(input, camera, view, scale, this.quads, this.sharp.tiles)
    const { quads } = scene
    const { textures } = this
    textures.length = 0
    for (let index = 0; index < quads.count; index++) {
      const at = index * QUAD_STRIDE
      const tile = quads.sharp[index]
      if (tile) {
        const texture = this.sharp.texture(tile)
        if (texture) textures[index] = texture
        else quads.data[at + 7] = QUAD.flat
        continue
      }
      const want = quads.thumbs[index]
      if (!want) continue
      const held = this.thumbs.use(want)
      if (held?.texture) {
        textures[index] = held.texture
        quads.data[at + 10] = (quads.data[at + 2] * held.height) / held.width
      } else quads.data[at + 7] = QUAD.flat
    }
    return { scene, textures }
  }

  /** After drawing: loads, replaces and frees textures. How soon to draw again (ms), or null. */
  end(camera: BoardCamera, now: number): number | null {
    if (camera.zoom !== this.zoom) {
      this.zoom = camera.zoom
      this.zoomedAt = now
    }
    const again = this.thumbs.settle(Math.max(0, ZOOM_REST_MS - (now - this.zoomedAt)))
    // A draw once the camera rests, to ask for the sharp tiles.
    const { resting } = this
    if (resting <= 0) return again
    return again === null ? resting : Math.min(again, resting)
  }

  keep(ids: ReadonlySet<string>) {
    this.thumbs.keep(ids)
  }

  thumbWidth(id: string) {
    return this.thumbs.width(id)
  }

  sharpScale(id: string) {
    return this.sharp.scale(id)
  }

  get changes() {
    return this.thumbs.changes + this.sharp.changes
  }

  /** The GPU went, and every texture with it: each loads again as it's next drawn. */
  lost() {
    this.thumbs.lost()
    this.sharp.lost()
  }

  dispose() {
    this.thumbs.dispose()
    this.sharp.dispose()
  }
}
