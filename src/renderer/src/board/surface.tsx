import {
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import type { BoardCamera } from '../../../shared/board'
import { Card } from '../lib/surface'
import type { BoardBackend, BoardBackendHooks, BoardSources } from './backend'
import { BoardRenderer } from './gl/renderer'
import { sharpTile } from './intents'
import type { SceneInput } from './scene'
import { readInks } from './theme'

/*
 * The canvas the board's pixels are drawn on, and when: React says what's on the board (each
 * render), the board says the camera moved (`invalidate`), and one draw a frame at most
 * follows, only while something changed. Nothing here handles input: the board's DOM above
 * the canvas does, as it did when it drew the frames itself. Each frame's tile in that DOM
 * says which thumbnail the canvas holds for it (`data-thumb`, its width in pixels, 0 for
 * none), and the scale of the sharp tile drawn over it zoomed in (`data-sharp`, sharp.ts, 0
 * for none), for tests and for anyone inspecting the board. What draws is a backend
 * (backend.ts); the canvas says which (`data-board-backend`).
 */

/** A spare buffer of the canvas's is given back once nothing has been drawn for this long. */
const TRIM_AFTER_MS = 1500

/**
 * A lost context not given back within this long isn't coming back (the GPU blocked after
 * repeated crashes, say): the board says it can't be shown rather than staying blank. A new
 * GPU process gives one back in about a second.
 */
const RESTORE_WAIT_MS = 5000

export interface BoardSurfaceHandle {
  /** The camera moved, or something else the next frame should show */
  invalidate(): void
  /** The frame under the pointer, or null */
  hover(id: string | null): void
}

export type BoardSurfaceInput = Omit<SceneInput, 'hovered'> & {
  /** The Hand or the Zoom tool is on: no frame's edge lights up under the pointer */
  hand: boolean
}

export function BoardSurface({
  ref,
  input,
  camera,
  board,
  thumbs,
  tiles,
  onUnavailable,
}: {
  ref: Ref<BoardSurfaceHandle>
  input: BoardSurfaceInput
  /** The camera as it is this moment, which React's own copy follows a little behind */
  camera: () => BoardCamera | null
  /** The canvas's id, which its sharp tiles are asked for by */
  board: string
  /** Where thumbnails load from (`BoardState.thumbs`) */
  thumbs: string
  /** What holds the frames' tiles (`[data-frame]`), which say which thumbnail is drawn */
  tiles: RefObject<HTMLElement | null>
  /** WebGL2 couldn't start here, or its context was lost and never given back: nothing will be drawn */
  onUnavailable: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const latest = useRef({
    input,
    camera,
    board,
    thumbs,
    tiles,
    onUnavailable,
    hovered: null as string | null,
    /** React has rendered since the tiles were last marked: some may be new */
    rendered: true,
  })
  const loop = useRef<{ invalidate(): void; frames(ids: ReadonlySet<string>): void } | null>(null)

  useImperativeHandle(ref, () => ({
    invalidate: () => loop.current?.invalidate(),
    hover: (id) => {
      if (latest.current.hovered === id) return
      latest.current.hovered = id
      loop.current?.invalidate()
    },
  }))

  // What's on the board changed: the next frame draws it.
  useLayoutEffect(() => {
    latest.current.input = input
    latest.current.camera = camera
    latest.current.board = board
    latest.current.thumbs = thumbs
    latest.current.tiles = tiles
    latest.current.onUnavailable = onUnavailable
    latest.current.rendered = true
    loop.current?.invalidate()
  })

  // Frames that left the board give up their textures.
  const ids = input.frames.map((frame) => frame.id).join('\n')
  useEffect(() => {
    loop.current?.frames(new Set(ids.split('\n')))
  }, [ids])

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let trimmer: ReturnType<typeof setTimeout> | undefined
    let restoring: ReturnType<typeof setTimeout> | undefined
    let backend: BoardBackend | null = null
    const invalidate = () => {
      if (!frame && backend) frame = requestAnimationFrame(() => draw())
    }
    const hooks: BoardBackendHooks = {
      changed: invalidate,
      lost: () => {
        invalidate()
        clearTimeout(restoring)
        restoring = setTimeout(() => latest.current.onUnavailable(), RESTORE_WAIT_MS)
      },
      restored: () => {
        clearTimeout(restoring)
        invalidate()
      },
      failed: () => {
        clearTimeout(restoring)
        latest.current.onUnavailable()
      },
    }
    const sources: BoardSources = {
      thumbUrl: (want) =>
        `${latest.current.thumbs}/${want.id}${want.source === 'small' ? '.small' : ''}?v=${want.version}`,
      sharpTile: (tile, signal) => sharpTile(latest.current.board, tile, signal),
    }

    let marked = -1
    /** Each tile says the width of the texture its frame has now, when that may have changed. */
    const markTiles = (renderer: BoardBackend) => {
      if (!latest.current.rendered && marked === renderer.thumbChanges) return
      latest.current.rendered = false
      marked = renderer.thumbChanges
      for (const tile of latest.current.tiles.current?.querySelectorAll<HTMLElement>(
        '[data-frame]',
      ) ?? []) {
        const id = tile.dataset.frame ?? ''
        const width = String(renderer.thumbWidth(id))
        if (tile.dataset.thumb !== width) tile.dataset.thumb = width
        const sharp = String(renderer.sharpScale(id))
        if (tile.dataset.sharp !== sharp) tile.dataset.sharp = sharp
      }
    }
    const draw = (trimmed = false) => {
      frame = 0
      const renderer = backend
      if (!renderer) return
      const { input, hovered } = latest.current
      const camera = latest.current.camera()
      if (!camera) return
      const lit = hovered && !input.hand && !input.selected.has(hovered) ? hovered : null
      const again = renderer.draw({ ...input, hovered: lit }, camera, performance.now())
      markTiles(renderer)
      clearTimeout(timer)
      if (again === 0) invalidate()
      else if (again !== null) timer = setTimeout(invalidate, again)
      // Still for a while: a buffer the moving board needed goes back to the GPU.
      clearTimeout(trimmer)
      if (!trimmed)
        trimmer = setTimeout(() => {
          renderer.trim()
          cancelAnimationFrame(frame)
          draw(true)
        }, TRIM_AFTER_MS)
    }

    const theme = () => {
      backend?.setInks(readInks(el))
      invalidate()
    }
    const scheme = matchMedia('(prefers-color-scheme: dark)')

    // The canvas in device pixels, exactly: its size or the display's scale changing (the
    // window dragged to another display) both arrive here. Drawn at once, in the same frame
    // the size changes: a canvas resized is a canvas cleared.
    let size: Parameters<BoardBackend['resize']> | null = null
    const observer = new ResizeObserver(([entry]) => {
      const [device] = entry.devicePixelContentBoxSize
      const [css] = entry.contentBoxSize
      size = [
        { width: css.inlineSize, height: css.blockSize },
        { width: device.inlineSize, height: device.blockSize },
      ]
      if (!backend) return
      backend.resize(...size)
      cancelAnimationFrame(frame)
      draw()
    })

    /** The backend is ready: everything that drives it starts. */
    const start = (made: BoardBackend) => {
      backend = made
      el.dataset.boardBackend = made.kind
      loop.current = { invalidate, frames: (ids) => made.keep(ids) }
      theme()
      scheme.addEventListener('change', theme)
      observer.observe(el, { box: 'device-pixel-content-box' })
      if (size) made.resize(...size)
    }

    try {
      start(new BoardRenderer(el, sources, hooks))
    } catch {
      latest.current.onUnavailable()
    }

    return () => {
      loop.current = null
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      clearTimeout(trimmer)
      clearTimeout(restoring)
      observer.disconnect()
      scheme.removeEventListener('change', theme)
      backend?.dispose()
      backend = null
    }
  }, [])

  return (
    // Nothing to a screen reader: the board's DOM over it says what's here.
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <canvas ref={canvas} className="block size-full" />
    </div>
  )
}

/** In place of the board when the canvas it's drawn on can't start, or has stopped for good. */
export function BoardUnavailable() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas p-8">
      <Card padding="canvas" role="alert" className="flex w-full max-w-md flex-col gap-1">
        <h2 className="font-semibold">This canvas can’t be shown</h2>
        <p className="text-pretty text-muted">
          Gui draws canvases with WebGL 2, which isn’t available on this Mac right now. Quitting and
          opening Gui again may bring it back.
        </p>
      </Card>
    </div>
  )
}
