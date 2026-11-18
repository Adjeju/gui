import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AgentId, TurnItem } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// Ask and Auto set the agent's own permission controls, as agents.ts declares them for
// each built-in agent. A stand-in ACP agent (a small Node script) takes the place of Muse
// Code, Grok Build or Antigravity CLI through GUI_AGENT_STAND_INS, so it gets that agent's
// mapping, and records every request. No agent login or usage is needed.

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio, as `kind`: `muse` offers `muse acp`'s modes (its
 * approval policies) as a `mode` config option and as ACP session modes, and starts in
 * Allow all (as a user's own settings may pick); `grok` has no modes; `antigravity` offers
 * `agy acp`'s modes the same two ways, and starts in Default, as agy 1.5.11 did. A
 * prompt containing SWITCH=<mode> changes the mode itself and reports only the mode; one
 * containing RUN asks to run a command.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log, kind] = process.argv.slice(2)
const MODES = kind === 'antigravity' ? [
  { id: 'default', name: 'Default' },
  { id: 'accept-edits', name: 'Accept edits' },
  { id: 'auto', name: 'Auto' },
  { id: 'plan', name: 'Plan' },
] : [
  { id: 'allowAll', name: 'Allow all' },
  { id: 'promptUnmatched', name: 'Ask before unmatched actions' },
  { id: 'onRequest', name: 'Ask on request' },
  { id: 'denyUnmatched', name: 'Deny unmatched actions' },
]
const state = { mode: kind === 'antigravity' ? 'default' : 'allowAll' }
const select = (id, name, currentValue, options, extra = {}) =>
  ({ id, name, type: 'select', currentValue, options, ...extra })
const configOptions = () => {
  if (kind === 'grok') {
    return [select('model', 'Model', 'grok-code', [{ value: 'grok-code', name: 'Grok Code' }], { category: 'model' })]
  }
  const modes = MODES.map(({ id, name }) => ({ value: id, name }))
  return [select('mode', 'Mode', state.mode, modes, { category: 'mode' })]
}
const session = () => ({
  configOptions: configOptions(),
  ...(kind === 'grok' ? {} : { modes: { currentModeId: state.mode, availableModes: MODES } }),
})
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const modeChanged = (sessionId, mode) =>
  notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode })

// Requests sent to Gui that it hasn't answered yet, by id.
const pending = new Map()
let lastId = 1000
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const mode = /SWITCH=(\w+)/.exec(text)?.[1]
  if (mode) {
    state.mode = mode
    modeChanged(sessionId, mode)
  }
  if (text.includes('RUN')) {
    const toolCall = { toolCallId: 'run-1', title: 'npm test', kind: 'execute', status: 'pending' }
    notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
  }
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    // Gui's answer to a request above.
    pending.get(id)?.(message.result)
    pending.delete(id)
    return
  }
  // Notifications, such as session/cancel, need no answer.
  if (id === undefined) return
  appendFileSync(log, JSON.stringify({ pid: process.pid, method, params }) + '\n')
  if (method === 'initialize') {
    const agentCapabilities = { loadSession: true }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'session-1', ...session() } })
  if (method === 'session/load') return write({ id, result: session() })
  if (method === 'session/set_mode' && kind !== 'grok') {
    state.mode = params.modeId
    return write({ id, result: {} })
  }
  if (method === 'session/set_config_option' && kind !== 'grok') {
    state[params.configId] = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') {
    prompt(params).then((result) => write({ id, result }))
    return
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

type Kind = 'muse' | 'grok' | 'antigravity'

interface Call {
  pid: number
  method: string
  params: Record<string, unknown>
}

interface StandIn {
  /** The requests each chat session's agent process received, oldest process first. */
  runs: () => Call[][]
}

/**
 * Stands the script in for built-in agent `id`, opens the project with it as the chat's
 * agent. Picking it may start a health check session too, outside the project.
 */
async function useStandIn(session: GuiSession, id: AgentId, kind: Kind): Promise<StandIn> {
  const { base, root } = session.fixture
  const log = join(base, 'agent-calls.ndjson')
  const script = join(base, 'modes-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = { command: electronExecutable(), args: [script, log, kind] }
  const env = { ELECTRON_RUN_AS_NODE: '1' }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ [id]: { ...standIn, env } }))
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((agentId) => window.gui.setAgent(agentId), id)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === id
  await waitFor(selected, 'the agent to be selected')
  return {
    runs: () => {
      if (!existsSync(log)) return []
      const calls = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
      const opened = calls.filter(
        ({ method, params }) =>
          (method === 'session/new' || method === 'session/load') && params.cwd === root,
      )
      const pids = [...new Set(opened.map((call) => call.pid))]
      return pids.map((pid) => calls.filter((call) => call.pid === pid))
    },
  }
}

/** What a process was asked to change, and when it was prompted, in order. */
const steps = (calls: Call[] | undefined) =>
  (calls ?? []).flatMap(({ method, params }) => {
    if (method === 'session/set_mode') return [`set_mode ${params.modeId}`]
    if (method === 'session/set_config_option') return [`${params.configId}=${params.value}`]
    return method === 'session/prompt' ? ['prompt'] : []
  })

/** The `_meta` each chat process's session started with, and whether it was resumed. */
const starts = (runs: Call[][]) =>
  runs.map((calls) => {
    const start = calls.find((c) => c.method === 'session/new' || c.method === 'session/load')
    return { method: start?.method, meta: start?.params._meta }
  })

const send = (chat: Page, text: string) =>
  chat.evaluate((message) => window.gui.send(message), text)

const autoChip = (chat: Page) => chat.getByRole('button', { name: 'Auto mode', exact: true })

async function autoModeIs(session: GuiSession, on: boolean) {
  const autoApprove = async () => (await session.chatSnapshot()).meta.autoApprove
  await waitFor(async () => (await autoApprove()) === on, `Auto mode to be ${on ? 'on' : 'off'}`)
}

/**
 * Waits for the session's mode to be `name`. The chat header names it only when it's not the
 * one Gui set for Ask or Auto (the Auto chip says that) or the agent's default: like Plan.
 */
async function modeIs(session: GuiSession, name: string) {
  const modeName = async () => (await session.chatSnapshot()).meta.modeName
  await waitFor(async () => (await modeName()) === name, `the mode to be ${name}`)
  const badge = session.chat.getByText(name, { exact: true })
  if ((await session.chatSnapshot()).meta.modeIsUsual) await expect(badge).toBeHidden()
  else await expect(badge).toBeVisible()
}

/** Sends a message and waits for its turn, the `index`th, to finish well. */
async function turn(session: GuiSession, index: number, text: string) {
  expect(await send(session.chat, text)).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.status).toBe('done')
  return turn
}

type PermissionCard = Extract<TurnItem, { kind: 'permission' }>

test('Ask and Auto set Muse Code’s approval mode, and leave a mode it picks', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useStandIn(session, 'muse', 'muse')
  const { chat } = session

  // Auto (a fresh profile's default): before the first prompt, Ask on request through the
  // `mode` config option, so Muse asks only about what it says needs approval.
  await autoModeIs(session, true)
  await turn(session, 0, 'Hello')
  expect(agent.runs()).toHaveLength(1)
  expect(steps(agent.runs()[0])).toEqual(['mode=onRequest', 'prompt'])
  await modeIs(session, 'Ask on request')

  // Ask between turns applies at once: the mode that asks about every action the user's
  // own Muse rules don't cover.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await modeIs(session, 'Ask before unmatched actions')
  expect(steps(agent.runs()[0])).toEqual(['mode=onRequest', 'prompt', 'mode=promptUnmatched'])

  // The agent switches itself to another mode, reporting only its mode: Gui shows it, and
  // the next turn keeps it.
  await turn(session, 1, 'SWITCH=denyUnmatched Be strict')
  await modeIs(session, 'Deny unmatched actions')
  await turn(session, 2, 'Go on')
  await modeIs(session, 'Deny unmatched actions')
  expect(steps(agent.runs()[0]).slice(3)).toEqual(['prompt', 'prompt'])

  // Auto during a turn waits for the next prompt (the agent is busy).
  expect(await send(chat, 'RUN the tests')).toBe(true)
  const card = await waitFor(async () => {
    const current = (await session.chatSnapshot()).turns[3]
    const open = current?.items.find(
      (item): item is PermissionCard => item.kind === 'permission' && item.resolved === null,
    )
    return current && open ? { turnId: current.id, itemId: open.id } : null
  }, 'the command to ask')
  await autoChip(chat).click()
  await autoModeIs(session, true)
  await sleep(1000)
  await chat.evaluate(
    ({ turnId, itemId }) => window.gui.respondPermission(turnId, itemId, 'allow'),
    card,
  )
  expect((await session.waitForTurn(3)).turn.status).toBe('done')
  await sleep(500)
  expect(steps(agent.runs()[0]).slice(5)).toEqual(['prompt'])
  await modeIs(session, 'Deny unmatched actions')
  await turn(session, 4, 'Carry on')
  expect(steps(agent.runs()[0]).slice(6)).toEqual(['mode=onRequest', 'prompt'])
  await modeIs(session, 'Ask on request')
  await session.shot('agent-mode-auto')
})

test('Ask and Auto start Grok Build’s session with its own permission mode, resuming it on a switch', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useStandIn(session, 'grok', 'grok')
  const { chat } = session

  // Auto: the session starts in Grok's auto mode.
  await autoModeIs(session, true)
  await turn(session, 0, 'Hello')
  expect(starts(agent.runs())).toEqual([{ method: 'session/new', meta: { autoMode: true } }])

  // Ask between turns takes effect with the next message, which resumes the session with
  // always-approve and auto mode off. It remembers the conversation, so no notice.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await sleep(500)
  expect(agent.runs()).toHaveLength(1)
  const resumed = await turn(session, 1, 'Hello again')
  expect(resumed.items.filter((item) => item.kind === 'notice')).toEqual([])
  const ask = { method: 'session/load', meta: { yoloMode: false, autoMode: false } }
  expect(starts(agent.runs())).toEqual([{ method: 'session/new', meta: { autoMode: true } }, ask])
  expect(agent.runs()[1]?.find((call) => call.method === 'session/load')?.params.sessionId).toBe(
    'session-1',
  )

  // Without a switch the session carries on; Auto resumes it in auto mode again. Grok has
  // no modes to set, so nothing else is asked of it.
  await turn(session, 2, 'And again')
  expect(agent.runs()).toHaveLength(2)
  await autoChip(chat).click()
  await autoModeIs(session, true)
  await turn(session, 3, 'Once more')
  expect(starts(agent.runs()).at(-1)).toEqual({ method: 'session/load', meta: { autoMode: true } })
  expect(agent.runs().map(steps)).toEqual([['prompt'], ['prompt', 'prompt'], ['prompt']])
})

test('Ask sets Antigravity CLI to Default and Auto to its Auto, and a mode it picks stays', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useStandIn(session, 'antigravity', 'antigravity')
  const { chat } = session

  // Auto (a fresh profile's default): before the first prompt, from Default to agy's Auto.
  await autoModeIs(session, true)
  await turn(session, 0, 'Hello')
  expect(steps(agent.runs()[0])).toEqual(['mode=auto', 'prompt'])
  await modeIs(session, 'Auto')

  // Ask between turns applies at once: Default, which asks before every edit and command.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await modeIs(session, 'Default')
  expect(steps(agent.runs()[0])).toEqual(['mode=auto', 'prompt', 'mode=default'])

  // The agent enters Plan itself: the header shows it, and Auto then sets Auto.
  await turn(session, 1, 'SWITCH=plan Plan the next step')
  await modeIs(session, 'Plan')
  await autoChip(chat).click()
  await autoModeIs(session, true)
  await modeIs(session, 'Auto')
  expect(steps(agent.runs()[0])).toEqual([
    'mode=auto',
    'prompt',
    'mode=default',
    'prompt',
    'mode=auto',
  ])
})
