import { expect, test } from 'bun:test'
import { ToolReach, toolReachText } from '../src/main/tool-reach'

// Whether a chat's agent can reach Gui's own tools, judged from what happens: what Gui
// passed the session, and whether any request from it reached Gui's MCP server.

test('an agent that was sent none is said to be unable as its session starts', () => {
  const reach = new ToolReach()
  reach.started(1, 0)
  expect(reach.notice).toBe('unsupported')
  // A request can't come, and a turn ending changes nothing.
  reach.turnEnded()
  expect(reach.notice).toBe('unsupported')
})

test('an opening without tools has nothing to say', () => {
  const reach = new ToolReach()
  reach.started(0, 0)
  reach.turnEnded()
  expect(reach.notice).toBeNull()
})

test('an agent that connected is never mentioned', () => {
  const reach = new ToolReach()
  reach.started(1, 1)
  reach.connected()
  reach.turnEnded()
  expect(reach.notice).toBeNull()
})

test('an agent that connects while its session is still starting counts as connected', () => {
  const reach = new ToolReach()
  // Muse Code connects before it answers session/new or session/resume.
  reach.starting()
  reach.connected()
  reach.started(1, 1)
  reach.turnEnded()
  expect(reach.notice).toBeNull()
})

test('a restarted session is judged on its own, not on the one before', () => {
  const reach = new ToolReach()
  reach.starting()
  reach.connected()
  reach.started(1, 1)
  reach.starting()
  reach.started(1, 1)
  reach.turnEnded()
  expect(reach.notice).toBe('unconnected')
})

test('one sent tools waits for a turn to end before saying it never connected', () => {
  const reach = new ToolReach()
  reach.started(1, 1)
  // Some agents connect only when they first need a tool.
  expect(reach.notice).toBeNull()
  reach.turnEnded()
  expect(reach.notice).toBe('unconnected')
})

test('connecting later clears it', () => {
  const reach = new ToolReach()
  reach.started(1, 1)
  reach.turnEnded()
  expect(reach.notice).toBe('unconnected')
  reach.connected()
  expect(reach.notice).toBeNull()
  reach.turnEnded()
  expect(reach.notice).toBeNull()
})

test('it is said once per chat: gone after the next message, back in a new chat', () => {
  const reach = new ToolReach()
  // A message sent before anything showed doesn't count as seeing it.
  reach.messageSent()
  reach.started(1, 0)
  expect(reach.notice).toBe('unsupported')
  reach.messageSent()
  expect(reach.notice).toBeNull()
  // A restarted session in the same chat doesn't repeat it.
  reach.started(1, 0)
  expect(reach.notice).toBeNull()
  reach.reset()
  reach.started(1, 0)
  expect(reach.notice).toBe('unsupported')
})

test("two chats' sessions don't affect each other", () => {
  const pi = new ToolReach()
  const quiet = new ToolReach()
  pi.started(1, 1)
  quiet.started(1, 1)
  pi.connected()
  pi.turnEnded()
  quiet.turnEnded()
  expect(pi.notice).toBeNull()
  expect(quiet.notice).toBe('unconnected')
})

test('the words', () => {
  expect(toolReachText('unsupported', 'Pi')).toBe(
    "Pi can't use Gui's preview and canvas tools. It can still read and edit your files.",
  )
  expect(toolReachText('unconnected', 'Muse Code')).toBe(
    "Muse Code hasn't connected to Gui's preview and canvas tools.",
  )
})
