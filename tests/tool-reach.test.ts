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
  const muse = new ToolReach()
  pi.started(1, 1)
  muse.started(1, 1)
  pi.connected()
  pi.turnEnded()
  muse.turnEnded()
  expect(pi.notice).toBeNull()
  expect(muse.notice).toBe('unconnected')
})

test('the words, with the agent hint only when it never connected', () => {
  expect(toolReachText('unsupported', 'Pi', 'ignored')).toBe(
    "Pi can't use Gui's preview and canvas tools. It can still read and edit your files.",
  )
  expect(toolReachText('unconnected', 'Muse Code', null)).toBe(
    "Muse Code hasn't connected to Gui's preview and canvas tools.",
  )
  expect(toolReachText('unconnected', 'Muse Code', 'Run `muse` once.')).toBe(
    "Muse Code hasn't connected to Gui's preview and canvas tools. Run `muse` once.",
  )
})
