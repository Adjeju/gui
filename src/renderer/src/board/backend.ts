import type { BoardCamera } from '../../../shared/board'
import type { SceneInput, ThumbWant } from './scene'
import type { SharpFetch } from './sharp-textures'

/*
 * What draws the board's pixels on its canvas, as surface.tsx sees it: WebGL2, in
 * gl/renderer.ts. It draws the scene (scene.ts) with a texture policy that knows nothing of
 * the GPU (draw-plan.ts): which thumbnails and sharp tiles to hold, at what width, for how
 * long. The renderer only makes, draws and frees textures.
 */

/** Where the board's pixels come from. */
export interface BoardSources {
  /** Where a frame's thumbnail is fetched from, at the width wanted */
  thumbUrl: (want: ThumbWant) => string
  /** A frame's part rendered again at the zoom (sharp.ts) */
  sharpTile: SharpFetch
}

/** What the renderer tells the surface, between draws. */
export interface BoardBackendHooks {
  /** Something loaded or ended: there's something to draw */
  changed(): void
  /** The GPU went (a driver reset, the GPU process restarting): nothing draws, textures are gone */
  lost(): void
  /** It came back: drawing again loads what's drawn */
  restored(): void
  /** It went and none could be made again: nothing will draw again */
  failed(): void
}

export interface BoardBackend {
  /** The view's size in CSS pixels and the canvas's in device pixels. */
  resize(view: { width: number; height: number }, device: { width: number; height: number }): void
  /** Each ink's colour, premultiplied: INK_COUNT × rgba (theme.ts). */
  setInks(inks: Float32Array): void
  /** Frames that left the board give up their textures. */
  keep(ids: ReadonlySet<string>): void
  /** The width of the thumbnail texture a frame has, in pixels; 0 while it has none. */
  thumbWidth(id: string): number
  /** The scale of the sharp tile drawn over a frame's thumbnail (sharp.ts); 0 for none. */
  sharpScale(id: string): number
  /** Changes each time a frame's texture, or sharp tile, is made or freed. */
  readonly thumbChanges: number
  /** Draws the board. Returns how soon it wants drawing again (ms), or null if it doesn't. */
  draw(input: SceneInput, camera: BoardCamera, now: number): number | null
  /**
   * Gives back a buffer the canvas no longer needs, once it has been still a while. The canvas
   * is blank until the draw that must follow in the same task.
   */
  trim(): void
  dispose(): void
}
