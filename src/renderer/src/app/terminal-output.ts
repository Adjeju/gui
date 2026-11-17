import type { OutputChunk, Unsubscribe } from '../../../shared/ipc'
import { reportError } from '../lib/crash-reports'

/** ESC c: resets the terminal, in turn with what's being drawn. */
const RESET = '\u001bc'

/** The terminal a view draws into. */
export interface OutputTarget {
  write: (data: string) => void
  /** Its memory is past what a terminal needs: Ghostty leaks, and only a new one gives it back */
  outgrown: () => boolean
}

export interface OutputSource {
  /** All main keeps of the output, to draw first */
  snapshot: () => Promise<OutputChunk>
  /** The output as main sends it, while the view is on screen */
  subscribe: (cb: (chunk: OutputChunk) => void) => Unsubscribe
  /** Drawn up to `end`: main sends more, and lets go of a shell it held */
  ack: (id: string, end: number) => void
}

/**
 * Draws a drawer view's output into `target`: main's snapshot, then what main sends, past
 * what's drawn already. Each chunk is acknowledged once drawn: main sends more as the terminal
 * keeps up, and holds a shell printing faster than that. `replaying` is true while old output
 * draws (the snapshot, or all main kept when the view missed more than that): Ghostty answers
 * the queries in it (cursor position, colors) as if just asked, and those answers mustn't
 * reach the shell.
 *
 * A terminal that can't draw, or has outgrown its memory, asks to be made again (`remount`).
 * Once Ghostty has failed a write it fails every one after it, so a terminal that threw is
 * always made again. The new one draws main's snapshot, so nothing on screen is lost; but when
 * this one threw before it drew any output, the snapshot is what it couldn't draw, and the new
 * one starts after it (`fromSnapshot` false) rather than fail on it again: what is lost is only
 * what Ghostty can't draw. A chunk is acknowledged even when drawing it failed, so main never
 * waits on a view that can't draw.
 */
export function drawOutput(
  target: OutputTarget,
  source: OutputSource,
  remount: (fromSnapshot: boolean) => void,
  { fromSnapshot = true } = {},
) {
  /** Drawn, or on its way to the terminal, up to here; null until the snapshot is */
  let at: number | null = null
  /** Sent before the snapshot came, which main sends after them on the same channel */
  const early: OutputChunk[] = []
  let replaying = false
  let disposed = false
  /** Some output drew into it */
  let drawn = false
  let failed = false
  let remounting = false

  const draw = (chunk: OutputChunk, data: string, replay: boolean) => {
    at = chunk.end
    // Waiting to be made again, what it draws now goes with it. Nothing to draw (a terminal
    // that hasn't printed yet, or one made after a snapshot it couldn't draw) isn't written:
    // a terminal that failed on it would be made again, and fail on it again.
    if (remounting || !data) {
      if (!disposed) source.ack(chunk.id, chunk.end)
      return
    }
    let threw = false
    try {
      replaying = replay
      // Ghostty reads it all now, answering any queries in it as it goes; its callback waits
      // for a frame, which a hidden window never draws, and main would hold the shell meanwhile.
      target.write(data)
    } catch (error) {
      threw = true
      // Once per terminal: one that keeps failing doesn't send a report per chunk.
      if (!failed) reportError(error)
      failed = true
    } finally {
      replaying = false
      if (!disposed) source.ack(chunk.id, chunk.end)
    }
    if (threw) {
      remounting = true
      remount(drawn)
      return
    }
    // Outgrown only after drawing more than main's snapshot, so that alone can't loop.
    const drewBefore = drawn
    drawn = true
    if (drewBefore && target.outgrown()) {
      remounting = true
      remount(true)
    }
  }
  const receive = (chunk: OutputChunk) => {
    if (at === null) {
      early.push(chunk)
      return
    }
    if (chunk.end <= at) return
    const start = chunk.end - chunk.data.length
    // Main had already let go of some of what this view missed: it starts over.
    if (start > at) draw(chunk, RESET + chunk.data, true)
    else draw(chunk, chunk.data.slice(at - start), false)
  }

  const off = source.subscribe(receive)
  void source.snapshot().then((snapshot) => {
    if (disposed) return
    draw(snapshot, fromSnapshot ? snapshot.data : '', true)
    for (const chunk of early.splice(0)) receive(chunk)
  })
  return {
    replaying: () => replaying,
    dispose() {
      disposed = true
      off()
    },
  }
}
