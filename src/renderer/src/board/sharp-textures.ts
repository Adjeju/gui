import type { BoardCamera } from '../../../shared/board'
import {
  overlaps,
  planSharp,
  type SharpFrame,
  type SharpTile,
  sameTile,
  tileOfFrame,
  visiblePart,
} from './sharp'
import type { TextureUpload } from './textures'

/*
 * The sharp tiles (sharp.ts) as textures, over the frames' thumbnails. Planned only once the
 * camera has held still; while it moves, renders under way are abandoned (main stops them) and
 * tiles already in stay drawn, moving with their frames, until they leave the view. A tile is
 * replaced by the next one only once that one is in, so nothing blanks between; and it goes
 * at once when its frame changes (a new thumbnail, a new size). They swap in without a fade:
 * the same pixels, sharper, in the same place. Never kept on disk.
 */

/** A render, as PNG bytes; null when there's none. Aborting it stops it in main. */
export type SharpFetch = (tile: SharpTile, signal: AbortSignal) => Promise<Blob | null>

/** A render, decoded; null when there's none. */
export type SharpLoad = (tile: SharpTile, signal: AbortSignal) => Promise<ImageBitmap | null>

/** Renders from main (`SharpFetch`), decoded off the main thread. */
export const decodeSharp =
  (fetchTile: SharpFetch): SharpLoad =>
  async (tile, signal) => {
    const blob = await fetchTile(tile, signal)
    return blob && !signal.aborted ? createImageBitmap(blob) : null
  }

interface Held<T> {
  tile: SharpTile
  texture: T
}

const keyOf = (tile: SharpTile) =>
  `${tile.id}@${tile.version}:${tile.width}x${tile.height}:${tile.rect.x},${tile.rect.y},${tile.rect.width},${tile.rect.height}@${tile.scale}`

export class SharpTextures<T> {
  private held = new Map<string, Held<T>>()
  private loading = new Map<string, { tile: SharpTile; abort: AbortController }>()
  private ready = new Map<string, { tile: SharpTile; bitmap: ImageBitmap }>()
  /** By frame, the render that came back with nothing: not asked for again until the plan changes */
  private failed = new Map<string, string>()
  private shown = new Map<string, SharpTile>()
  private disposed = false
  /** Counts each tile made or freed */
  changes = 0

  constructor(
    private readonly textures: TextureUpload<T>,
    private readonly loadTile: SharpLoad,
    /** A render came back: there's something to draw */
    private readonly changed: () => void,
  ) {}

  /** The tiles to draw, by frame. */
  get tiles(): ReadonlyMap<string, SharpTile> {
    return this.shown
  }

  texture(id: string) {
    return this.held.get(id)?.texture ?? null
  }

  /** The scale of the tile a frame has drawn over it; 0 for none. */
  scale(id: string) {
    return this.held.get(id)?.tile.scale ?? 0
  }

  /**
   * Before each draw: drops tiles whose frame changed or that left the view, puts in what has
   * come back, abandons renders when the camera `moved`, and once it's `still`, asks for what
   * the view wants (`planSharp`).
   */
  update(
    frames: readonly SharpFrame[],
    camera: BoardCamera,
    size: { width: number; height: number },
    dpr: number,
    moved: boolean,
    still: boolean,
  ) {
    const byId = new Map(frames.map((frame) => [frame.id, frame]))
    const current = (tile: SharpTile) => {
      const frame = byId.get(tile.id)
      if (!frame || !tileOfFrame(tile, frame)) return false
      const seen = visiblePart(frame, camera, size)
      return !!seen && overlaps(seen, tile.rect)
    }
    for (const [id, held] of this.held) if (!current(held.tile)) this.free(id)
    for (const [id, { tile, bitmap }] of this.ready) {
      this.ready.delete(id)
      if (current(tile)) this.upload(tile, bitmap)
      else bitmap.close()
    }
    if (moved) {
      for (const { abort } of this.loading.values()) abort.abort()
      this.loading.clear()
    }
    if (still) {
      const held = new Map([...this.held].map(([id, { tile }]) => [id, tile]))
      const wanted = new Map(
        planSharp(frames, camera, size, dpr, held).map((tile) => [tile.id, tile]),
      )
      for (const [id, { tile, abort }] of this.loading) {
        const want = wanted.get(id)
        if (want && sameTile(want, tile)) continue
        abort.abort()
        this.loading.delete(id)
      }
      // Zoomed back to where the thumbnail holds enough, or out of the budget.
      for (const id of [...this.held.keys()]) if (!wanted.has(id)) this.free(id)
      for (const [id, tile] of wanted) {
        const has = this.held.get(id)?.tile
        if (
          (has && sameTile(has, tile)) ||
          this.loading.has(id) ||
          this.failed.get(id) === keyOf(tile)
        )
          continue
        void this.load(tile)
      }
    }
    this.shown = new Map([...this.held].map(([id, { tile }]) => [id, tile]))
  }

  private async load(tile: SharpTile) {
    const abort = new AbortController()
    this.loading.set(tile.id, { tile, abort })
    try {
      const bitmap = await this.loadTile(tile, abort.signal)
      if (abort.signal.aborted || this.disposed) {
        bitmap?.close()
        return
      }
      if (!bitmap) {
        this.failed.set(tile.id, keyOf(tile))
        return
      }
      this.ready.get(tile.id)?.bitmap.close()
      this.ready.set(tile.id, { tile, bitmap })
    } catch {
      if (!abort.signal.aborted) this.failed.set(tile.id, keyOf(tile))
    } finally {
      if (this.loading.get(tile.id)?.abort === abort) this.loading.delete(tile.id)
      if (!this.disposed) this.changed()
    }
  }

  private upload(tile: SharpTile, bitmap: ImageBitmap) {
    // Levels for a pinch out that draws it smaller, before the zoom rests and it's replaced.
    const texture = this.textures.upload(bitmap, true)
    this.free(tile.id)
    this.held.set(tile.id, { tile, texture })
    this.changes++
    bitmap.close()
  }

  private free(id: string) {
    const held = this.held.get(id)
    if (!held) return
    this.textures.release(held.texture)
    this.held.delete(id)
    this.changes++
  }

  private abandon() {
    for (const { abort } of this.loading.values()) abort.abort()
    this.loading.clear()
    for (const { bitmap } of this.ready.values()) bitmap.close()
    this.ready.clear()
    this.failed.clear()
  }

  /** The GPU context went, and its textures with it: they're asked for again once it's back. */
  lost() {
    this.abandon()
    this.held.clear()
    this.shown = new Map()
    this.changes++
  }

  dispose() {
    this.disposed = true
    this.abandon()
    for (const id of [...this.held.keys()]) this.free(id)
    this.shown = new Map()
  }
}
