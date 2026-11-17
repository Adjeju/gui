/**
 * Whether a chat's agent can use Gui's own tools (preview, canvas), judged from what
 * happens rather than from which agent it is:
 *
 * - `unsupported`: Gui had tools for the session and passed none on, because the agent can't
 *   take them (it doesn't advertise HTTP MCP, like Pi). Known as the session starts.
 * - `unconnected`: Gui passed its server, and a turn ended without a single request from that
 *   session reaching it (Muse in a folder the user hasn't trusted in Muse withholds every MCP
 *   server). Some agents only connect when they first need a tool, so this waits for a turn
 *   to end, and a request arriving later clears it.
 *
 * Said once per chat: shown from when it's known until the user sends a message with it on
 * screen (`messageSent`), or until it no longer holds.
 */
export type ToolReachNotice = 'unsupported' | 'unconnected'

type State = 'none' | 'unsupported' | 'waiting' | 'connected' | 'unconnected'

export class ToolReach {
  private state: State = 'none'
  private said = false

  /** A session started: Gui had `offered` tool servers for it and passed `sent` of them on. */
  started(offered: number, sent: number) {
    this.state = offered === 0 ? 'none' : sent === 0 ? 'unsupported' : 'waiting'
  }

  /** A request from this session reached Gui's server. */
  connected() {
    if (this.state === 'waiting' || this.state === 'unconnected') this.state = 'connected'
  }

  /** A turn in this session ended as the agent meant it to (not stopped or failed). */
  turnEnded() {
    if (this.state === 'waiting') this.state = 'unconnected'
  }

  /** A new chat, or another agent: it may be said again. */
  reset() {
    this.state = 'none'
    this.said = false
  }

  /** The user sent a message: one shown while they wrote it has been seen. */
  messageSent() {
    if (this.notice) this.said = true
  }

  get notice(): ToolReachNotice | null {
    if (this.said) return null
    return this.state === 'unsupported' || this.state === 'unconnected' ? this.state : null
  }
}

/** The notice in plain words, with the agent's own hint for when it never connected. */
export function toolReachText(
  notice: ToolReachNotice,
  agentName: string,
  hint: string | null,
): string {
  if (notice === 'unsupported') {
    return `${agentName} can't use Gui's preview and canvas tools. It can still read and edit your files.`
  }
  const text = `${agentName} hasn't connected to Gui's preview and canvas tools.`
  return hint ? `${text} ${hint}` : text
}
