/** What Electron's `render-process-gone` says of a renderer that went away. */
export interface RendererGone {
  reason: string
  exitCode: number
}

/** The exit code Chromium gives a process SIGTERM ended: the signal's number. */
const SIGTERM = 15
/** Renderers SIGTERM ends within this long of the first went together. */
export const TOGETHER_MS = 2000

/**
 * Which of Gui's renderers that went away are Gui failing. Quitting ends them all, and so does
 * the system ending Gui (logging out, restarting, an update installing, Gui's own process
 * sent SIGTERM): every renderer killed by SIGTERM in the same moment. Neither is a crash, and
 * neither page should come back. A crash, running out of memory, or one renderer killed on
 * its own is reported, and its page comes back.
 */
export class RendererExits {
  private held: { message: string; recover: () => void }[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly report: (message: string) => void,
    /** Gui is quitting, or the system is ending it. */
    private readonly ending: () => boolean,
    private readonly wait = TOGETHER_MS,
  ) {}

  /** `recover` loads the page again; it runs only if the page should come back. */
  gone(page: string, details: RendererGone, recover: () => void) {
    if (this.ending()) return
    const message = `${page} renderer gone (${details.reason}, exit code ${details.exitCode})`
    if (details.reason !== 'killed' || details.exitCode !== SIGTERM) {
      this.report(message)
      recover()
      return
    }
    // Held a moment: the rest of a shutdown's renderers, or the quit itself, follow.
    this.held.push({ message, recover })
    this.timer ??= setTimeout(() => this.settle(), this.wait)
  }

  private settle() {
    const held = this.held
    this.held = []
    this.timer = undefined
    if (this.ending()) return
    // Renderers killed together while Gui goes on aren't a crash, but their pages come back.
    if (held.length === 1) this.report(held[0].message)
    for (const { recover } of held) recover()
  }
}
