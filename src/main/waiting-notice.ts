import { app, Notification } from 'electron'

/**
 * What a waiting card asks: the agent's own question, or anything else that needs the user's
 * OK (a permission, Claude's plan).
 */
export type WaitKind = 'question' | 'approval'

/** What the system notification says. Only Gui's own words: nothing the agent or page wrote. */
export interface NoticeText {
  title: string
  body: string
}

/** A notification on screen, as `WaitingNotice` holds it. */
export interface ShownNotice {
  close(): void
}

/** Where notifications go: the system's, or the e2e record (`electronNotices`). */
export interface NoticeSink {
  supported(): boolean
  /** `onClick` and `onGone` (closed by the user or the system) are the notice's own events. */
  show(text: NoticeText, onClick: () => void, onGone: () => void): ShownNotice
}

export function noticeText(agent: string, project: string, kind: WaitKind): NoticeText {
  return {
    title: kind === 'question' ? `${agent} has a question` : `${agent} is waiting for your OK`,
    body: project,
  }
}

/**
 * Whether a card that just came up notifies: it really waits on the user (Gui didn't answer it
 * itself), it starts a wait (the first card since the user last had none to answer), nobody is
 * looking at its chat, the setting is on, and the system shows notifications at all.
 */
export function shouldNotify(card: {
  waiting: boolean
  newWait: boolean
  looking: boolean
  enabled: boolean
  supported: boolean
}): boolean {
  return card.waiting && card.newWait && !card.looking && card.enabled && card.supported
}

export interface WaitingCard {
  /** A card is waiting on the user now (ChatController.awaitingPermission) */
  waiting: boolean
  /** The user is looking at the chat (ChatPanel.looking) */
  looking: boolean
  kind: WaitKind
  agent: string
  project: string
}

/**
 * One chat's waits on the user, and the one notification each may show (see `shouldNotify`).
 * It lives as long as one opening of a project: once `signal` aborts (the project closed or
 * reopened), it shows nothing more, closes what it showed, and ignores a click on it. The
 * notification is held while it shows, so it isn't collected with its click handler.
 */
export class WaitingNotice {
  private inWait = false
  private shown: ShownNotice | null = null

  constructor(
    private readonly options: {
      enabled: () => boolean
      /** Aborts when the opening ends (ProjectResources.signal) */
      signal: AbortSignal
      /** The notification was clicked while its wait was still on */
      onClick: () => void
      sink?: NoticeSink
    },
  ) {
    options.signal.addEventListener('abort', () => this.end(), { once: true })
  }

  private get sink() {
    return this.options.sink ?? electronNotices
  }

  /** A card came up (ChatController's `attention`). */
  cardWaiting(card: WaitingCard) {
    if (this.options.signal.aborted) return
    const newWait = !this.inWait
    if (card.waiting) this.inWait = true
    const notify = shouldNotify({
      waiting: card.waiting,
      newWait,
      looking: card.looking,
      enabled: this.options.enabled(),
      supported: this.sink.supported(),
    })
    if (!notify) return
    const shown = this.sink.show(
      noticeText(card.agent, card.project, card.kind),
      () => {
        if (this.shown !== shown || this.options.signal.aborted) return
        this.release()
        this.options.onClick()
      },
      () => {
        if (this.shown === shown) this.shown = null
      },
    )
    this.shown = shown
  }

  /** The chat changed: once nothing waits, the wait is over and its notification goes. */
  settle(waiting: boolean) {
    if (!waiting) this.end()
  }

  private end() {
    this.inWait = false
    this.release()?.close()
  }

  private release() {
    const shown = this.shown
    this.shown = null
    return shown
  }
}

/** A record of what would have shown, for the e2e tests to read from main (`guiE2eNotices`). */
interface RecordedNotice extends NoticeText {
  closed: boolean
  click: () => void
}

/**
 * Under the e2e tests (an unpackaged build with GUI_E2E_BACKGROUND=1) nothing real shows: each
 * notification is recorded on `globalThis.guiE2eNotices` instead, with a `click` to act as the
 * user's.
 */
const recording = !app.isPackaged && process.env.GUI_E2E_BACKGROUND === '1'

const recordedNotices: NoticeSink = {
  supported: () => true,
  show(text, onClick) {
    const store = globalThis as { guiE2eNotices?: RecordedNotice[] }
    const record: RecordedNotice = { ...text, closed: false, click: onClick }
    store.guiE2eNotices ??= []
    store.guiE2eNotices.push(record)
    return {
      close: () => {
        record.closed = true
      },
    }
  },
}

/** The system's notifications, or nothing where it has none. */
const systemNotices: NoticeSink = {
  supported: () => Notification.isSupported(),
  show(text, onClick, onGone) {
    const notification = new Notification({ title: text.title, body: text.body })
    let gone = false
    const forget = () => {
      if (gone) return
      gone = true
      onGone()
    }
    notification.on('click', onClick)
    notification.on('close', forget)
    notification.on('failed', (_event, error) => {
      console.error('[gui] a notification could not show', error)
      forget()
    })
    notification.show()
    return {
      close: () => {
        forget()
        notification.close()
      },
    }
  },
}

export const electronNotices: NoticeSink = recording ? recordedNotices : systemNotices
