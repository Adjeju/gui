/**
 * Whether a chat's agent can use Gui's own tools (preview, canvas), judged from what
 * happens rather than from which agent it is:
 *
 * - `unsupported`: Gui had tools for the session and passed none on, because the agent can't
 *   take them (it doesn't advertise HTTP MCP, like Pi). Known as the session starts.
 * - `unconnected`: Gui passed its server, and a turn ended without a single request from that
 *   session reaching it (an agent may withhold MCP servers by its own rules). Some agents
 *   only connect when they first need a tool, so this waits for a turn
 *   to end, and a request arriving later clears it. Others connect while the session is
 *   still starting (Muse Code, before it answers), which counts the same.
 *
 * Said once per chat: shown from when it's known until the user sends a message with it on
 * screen (`messageSent`), or until it no longer holds.
 */
export type ToolReachNotice = 'unsupported' | 'unconnected'

type State = 'none' | 'starting' | 'unsupported' | 'waiting' | 'connected' | 'unconnected'

export class ToolReach {
  private state: State = 'none'
  private said = false
  /** A request reached Gui's server while the session was still starting. */
  private early = false

  /** A session is about to start; what the last one did no longer counts. */
  starting() {
    this.state = 'starting'
    this.early = false
  }

  /** A session started: Gui had `offered` tool servers for it and passed `sent` of them on. */
  started(offered: number, sent: number) {
    const waiting = this.early ? 'connected' : 'waiting'
    this.state = offered === 0 ? 'none' : sent === 0 ? 'unsupported' : waiting
    this.early = false
  }

  /** A request from this session reached Gui's server. */
  connected() {
    if (this.state === 'starting') this.early = true
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

/** The notice in plain words. */
export function toolReachText(notice: ToolReachNotice, agentName: string): string {
  if (notice === 'unsupported') {
    return `${agentName} can't use Gui's preview and canvas tools. It can still read and edit your files.`
  }
  return `${agentName} hasn't connected to Gui's preview and canvas tools.`
}
