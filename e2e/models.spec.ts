import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Locator, Page } from '@playwright/test'
import {
  AGENTS,
  type AgentId,
  CUSTOM_AGENT_PREFIX,
  DEFAULT_AGENT_ID,
  type ModelSettings,
} from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// The composer's model button and its picker, against a stand-in ACP agent: a small Node
// script that offers a model and an effort setting (under its own ids, found by category)
// and records every request, so no agent login or usage is needed.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Models`

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio. The model list is long and grouped by provider,
 * like OpenCode's ("short": three models, ungrouped; "none": no models or effort at all);
 * effort is flat, and refuses "max". A `mode` setting stands in for the categories Gui
 * ignores. "signed-out" turns every session down until the user signs in. "providers" adds a
 * provider setting, as fx has: Gateway lists the long list, Codex two models of its own, and
 * Grok isn't signed in. A message saying SLOW keeps its turn running until it's stopped. With
 * a `gate` file, its health check's session waits for that file to exist.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync, existsSync } = require('node:fs')
const [log, size, gate] = process.argv.slice(2)
const state = { provider: 'gateway', llm: 'swift', depth: 'medium' }
const CODEX = [{ value: 'gpt-5-codex', name: 'GPT-5 Codex' }, { value: 'gpt-5', name: 'GPT-5' }]
let held = null
const PROVIDERS = {
  Anthropic: ['Claude Opus 4.1', 'Claude Opus 4', 'Claude Sonnet 4.5', 'Claude Sonnet 4',
    'Claude Haiku 4.5', 'Claude 3.7 Sonnet', 'Claude 3.5 Haiku'],
  OpenAI: ['GPT-5', 'GPT-5 Mini', 'GPT-5 Nano', 'GPT-4.1', 'GPT-4.1 Mini', 'GPT-4o', 'o3', 'o4-mini'],
  Google: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash', 'Gemini 2.5 Flash Lite', 'Gemini 2.0 Flash',
    'Gemma 3 27B', 'Gemma 3 12B'],
  Mistral: ['Mistral Large', 'Mistral Medium 3', 'Codestral', 'Devstral Medium', 'Devstral Small'],
  xAI: ['Grok 4', 'Grok 3', 'Grok 3 Mini', 'Grok Code Fast 1'],
  DeepSeek: ['DeepSeek V3.1', 'DeepSeek R1', 'DeepSeek V3'],
  Qwen: ['Qwen3 Coder', 'Qwen3 Max', 'Qwen3 235B', 'Qwen3 32B'],
  'Moonshot AI': ['Kimi K2', 'Kimi K2 Turbo'],
}
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9.]+/g, '-')
const models = () => size === 'short'
  ? ['Swift', 'Sage', 'Atlas'].map((name) => ({ value: slug(name), name }))
  : state.provider === 'codex' ? CODEX
  : [
      { group: 'fast', name: 'Fast', options: [{ value: 'swift', name: 'Swift' }] },
      { group: 'smart', name: 'Smart', options: [{ value: 'sage', name: 'Acme/Sage' }] },
      ...Object.entries(PROVIDERS).map(([provider, names]) => ({
        group: slug(provider),
        name: provider,
        options: names.map((name) => ({ value: slug(provider) + '/' + slug(name), name: provider + '/' + name })),
      })),
    ]
const MODE = { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
  options: [{ value: 'ask', name: 'Ask' }] }
const PROVIDER = () => ({ id: 'provider', name: 'Provider', category: 'model', type: 'select',
  currentValue: state.provider,
  options: [{ value: 'gateway', name: 'Gateway' }, { value: 'codex', name: 'Codex' },
    { value: 'grok', name: 'Grok' }] })
const configOptions = () => size === 'none' ? [MODE] : [
  MODE,
  ...(size === 'providers' ? [PROVIDER()] : []),
  { id: 'llm', name: 'Model', category: 'model', type: 'select', currentValue: state.llm,
    options: models() },
  { id: 'depth', name: 'Thinking', category: 'thought_level', type: 'select',
    currentValue: state.depth,
    options: ['Low', 'Medium', 'High', 'Max'].map((name) => ({ value: name.toLowerCase(), name })) },
]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const handle = ({ id, method, params }) => {
  if (id === undefined) {
    if (method === 'session/cancel' && held !== null) {
      write({ id: held, result: { stopReason: 'cancelled' } })
      held = null
    }
    return
  }
  appendFileSync(log, JSON.stringify({ pid: process.pid, method, params }) + '\n')
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    if (size === 'signed-out') {
      return write({ id, error: { code: -32000, message: 'Authentication required' } })
    }
    const answer = () =>
      write({ id, result: { sessionId: 'session-' + process.pid, configOptions: configOptions() } })
    if (!gate || !params.cwd.includes('agent-check')) return answer()
    const wait = setInterval(() => {
      if (!existsSync(gate)) return
      clearInterval(wait)
      answer()
    }, 50)
    return
  }
  if (method === 'session/set_config_option') {
    if (params.value === 'max') return write({ id, error: { code: -32602, message: 'Max is not on this plan' } })
    if (params.value === 'grok') {
      return write({ id, error: { code: -32603, message: "Grok isn't signed in. Run fx login grok." } })
    }
    // Another provider starts on its own first model.
    if (params.configId === 'provider') {
      state.provider = params.value
      const first = models()[0]
      state.llm = first.value ?? first.options[0].value
    }
    state[params.configId] = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') {
    if (JSON.stringify(params.prompt).includes('SLOW')) return void (held = id)
    return write({ id, result: { stopReason: 'end_turn' } })
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

/**
 * The built-in agents switched off, so the picker lists only the stand-ins whatever agents
 * the Mac running the tests has installed (Check Agents would check those too).
 */
const STAND_INS_ONLY = { disabledAgents: AGENTS.map((agent) => agent.id) }

type Kind = 'long' | 'short' | 'none' | 'signed-out' | 'providers'

interface Call {
  pid: number
  method: string
  params: Record<string, unknown>
}

/** The requests each chat session's agent received, one entry per process, oldest first. */
type ChatRuns = () => Call[][]

/**
 * Adds the stand-in agent to agents.json (run on Electron's own Node), opens the project
 * with it as the chat's agent, and waits for its models. Its health check starts a
 * session too, outside the project.
 */
async function addAgent(
  session: GuiSession,
  size: Kind = 'long',
  /** More agents by name, of these kinds, for the picker to list */
  others: Record<string, Kind> = {},
): Promise<ChatRuns> {
  const { base, userData, root } = session.fixture
  const log = join(base, 'agent-calls.ndjson')
  const script = join(base, 'models-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const entry = (kind: Kind) => ({
    command: electronExecutable(),
    args: [script, log, kind],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  const agents = Object.fromEntries(
    Object.entries({ Models: size, ...others }).map(([name, kind]) => [name, entry(kind)]),
  )
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  if (size === 'none') {
    await waitFor(async () => (await session.chatSnapshot()).meta.agentId === AGENT, 'the agent')
  } else {
    await waitFor(async () => (await models(session))?.model.id === 'llm', "the agent's models")
  }
  return () => {
    if (!existsSync(log)) return []
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call)
    const pids = calls
      .filter((call) => call.method === 'session/new' && call.params.cwd === root)
      .map((call) => call.pid)
    return pids.map((pid) => calls.filter((call) => call.pid === pid))
  }
}

async function models(session: GuiSession): Promise<ModelSettings | null> {
  return (await session.chatSnapshot()).meta.models
}

/** Waits for the chat's model and effort values to be these. */
function modelsAre(session: GuiSession, model: string, effort: string) {
  return waitFor(async () => {
    const current = await models(session)
    return current?.model.value === model && current.effort?.value === effort ? current : null
  }, `model ${model} and effort ${effort}`)
}

const configCalls = (calls: Call[] | undefined) =>
  (calls ?? [])
    .filter((call) => call.method === 'session/set_config_option')
    .map(({ params }) => ({ configId: params.configId, value: params.value }))

const send = (session: GuiSession, text: string) =>
  session.chat.evaluate((message) => window.gui.send(message), text)

/** The picker's parts, by role. */
function pickerOf(session: GuiSession) {
  const dialog = session.chat.getByRole('dialog', { name: 'Choose a model' })
  const tabs = dialog.getByRole('tablist', { name: 'Agents' })
  return {
    dialog,
    search: dialog.getByRole('combobox', { name: 'Search all models' }),
    list: dialog.getByRole('listbox', { name: 'Models' }),
    options: dialog.getByRole('option'),
    effort: dialog.getByRole('group', { name: 'Effort' }),
    provider: dialog.getByRole('group', { name: 'Provider' }),
    tabs,
    /** Recent, an agent's, by name */
    tab: (name: string) => tabs.getByRole('tab', { name, exact: true }),
  }
}

/** The highlighted option, as the combobox (or list) points at it. */
async function expectActive(owner: Locator, option: Locator) {
  const id = await option.getAttribute('id')
  expect(id).toBeTruthy()
  await expect(owner).toHaveAttribute('aria-activedescendant', id ?? '')
}

/**
 * Just above the composer's frame (or the button, outside one) and inside the chat panel. In
 * the frame it spans the frame; outside one, it's against the button's right edge unless that
 * would cross the panel's left edge.
 */
async function expectPlaced(session: GuiSession, dialog: Locator, button: Locator) {
  // Once it has opened: it grows into place from 97% of its size.
  let last = ''
  await waitFor(
    async () => {
      const box = JSON.stringify(await dialog.boundingBox())
      const settled = box === last
      last = box
      return settled
    },
    'the picker at full size',
    { interval: 100 },
  )
  const panel = await session.chat.locator('[data-chat-panel]').boundingBox()
  const box = await dialog.boundingBox()
  const anchor = await button.boundingBox()
  // It opens over the frame's edge rather than covering it, unless that leaves it too short:
  // then it opens off the button's own row in the frame, covering the message box.
  const frame = button.locator('xpath=ancestor::*[@data-popover-anchor][1]')
  const framed = (await frame.count()) > 0
  const frameBox = framed ? await frame.boundingBox() : anchor
  const row = framed
    ? await button.locator('xpath=ancestor::*[parent::*[@data-popover-anchor]][1]').boundingBox()
    : null
  const above = frameBox && box && row && box.y + box.height > frameBox.y ? row : frameBox
  if (!panel || !box || !anchor || !above || !frameBox)
    throw new Error('The picker, its button or the panel has no box')
  expect(box.x).toBeGreaterThanOrEqual(panel.x)
  expect(box.y).toBeGreaterThanOrEqual(panel.y)
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width)
  expect(box.y + box.height).toBeLessThanOrEqual(above.y)
  expect(above.y - (box.y + box.height)).toBeLessThanOrEqual(8)
  const right = anchor.x + anchor.width
  if (framed) {
    expect(Math.abs(box.x - frameBox.x)).toBeLessThan(1)
    expect(Math.abs(box.width - frameBox.width)).toBeLessThan(1)
  } else if (right - box.width >= panel.x + 8)
    expect(Math.abs(box.x + box.width - right)).toBeLessThan(1)
  else expect(Math.abs(box.x - (panel.x + 8))).toBeLessThan(1)
  return { panel, box, overFrame: above !== frameBox }
}

test('the model picker searches the models, sets the model and effort, and new sessions start with them', async ({
  launch,
}) => {
  const session = await launch({
    fixture: 'vite',
    // Room in the floating panel for a message beside the open picker, to click away on.
    prefs: { ...STAND_INS_ONLY, chatSize: { width: 480, height: 720 } },
  })
  await session.declineConsentDialogs()
  const runs = await addAgent(session)
  const { chat } = session

  // Before any chat session: the agent's list from its health check, groups flattened.
  // Settings are found by category, whatever the agent calls them; `mode` isn't one.
  const listed = await modelsAre(session, 'swift', 'medium')
  expect(listed.model.options).toHaveLength(41)
  expect(listed.model.options.slice(0, 3)).toEqual([
    { value: 'swift', name: 'Swift', group: 'Fast' },
    { value: 'sage', name: 'Acme/Sage', group: 'Smart' },
    { value: 'anthropic/claude-opus-4.1', name: 'Anthropic/Claude Opus 4.1', group: 'Anthropic' },
  ])
  expect(listed.effort?.id).toBe('depth')
  expect(listed.effort?.options.map((option) => option.name)).toEqual([
    'Low',
    'Medium',
    'High',
    'Max',
  ])
  // No provider setting, no provider row.
  expect(listed.provider).toBeNull()
  const health = (await session.state()).agents.find((agent) => agent.id === AGENT)
  expect(health?.models).toEqual(listed)

  // After a turn the session's own settings show; nothing was chosen, so nothing was set.
  expect(await send(session, 'Hello')).toBe(true)
  const first = await session.waitForTurn(0)
  expect(first.turn.status).toBe('done')
  expect(first.meta.models).toEqual(listed)
  expect(runs()).toHaveLength(1)
  expect(configCalls(runs()[0])).toEqual([])

  // The button opens the picker over the chat, next to itself: search field focused, the
  // models under their provider, the current one marked.
  const button = chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  const { dialog, search, list, options, effort, provider, tab } = pickerOf(session)
  await expect(dialog).toBeVisible()
  // It opens on Recent: the model the message went on, with its agent, marked as the chat's.
  await expect(tab('Recent')).toHaveAttribute('aria-selected', 'true')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await expect(options.first()).toContainText('Swift')
  await expect(options.first()).toContainText('Models')
  await expect(effort).toBeVisible()
  // The chat has started: another agent's model would start a new one, and it says so.
  await expect(dialog.getByText('A model from another agent starts a new chat.')).toBeVisible()
  await session.shot('model-picker-recent')
  // The agent's tab lists its models, and says how many.
  await tab('Models').click()
  await expect(tab('Models')).toHaveAttribute('aria-selected', 'true')
  await expect(tab('Recent')).toHaveAttribute('aria-selected', 'false')
  await expect(dialog.getByText('41 models')).toBeVisible()
  await expect(provider).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(search).toBeFocused()
  await expect(search).toHaveAttribute('aria-controls', (await list.getAttribute('id')) ?? '')
  await expect(options).toHaveCount(41)
  await expect(list.getByRole('option', { selected: true })).toHaveText('Swift')
  await expectActive(search, list.getByRole('option', { name: 'Swift' }))
  // "Anthropic/Claude Opus 4" reads as "Claude Opus 4" under its provider's header.
  const anthropic = list.getByRole('group', { name: 'Anthropic' })
  await expect(anthropic.getByRole('option')).toHaveCount(7)
  await expect(anthropic.getByRole('option').first()).toHaveText('Claude Opus 4.1')
  expect((await expectPlaced(session, dialog, button)).overFrame).toBe(false)

  // Scrolled into a provider's models, its header stays pinned at the top of the list, so
  // every row still says whose model it is.
  const google = list.getByRole('group', { name: 'Google' })
  // Its third model at the top of the list: unpinned, the header would be scrolled away.
  const scrolled = await google.getByRole('option').nth(2).elementHandle()
  await list.evaluate((el, row) => {
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top
  }, scrolled)
  const header = google.getByText('Google', { exact: true })
  await expect(header).toBeInViewport()
  const [listTop, headerTop] = await Promise.all([
    list.evaluate((el) => el.getBoundingClientRect().top),
    header.evaluate((el) => el.getBoundingClientRect().top),
  ])
  expect(Math.abs(headerTop - listTop)).toBeLessThanOrEqual(1)
  await session.shot('model-picker-pinned-provider')
  await list.evaluate((el) => el.scrollTo(0, 0))

  await session.shot('model-picker-agent')

  // Every typed word matches somewhere in the name, value or provider, in any case. While
  // something is typed, no tab is shown as selected: the search is every agent's.
  await chat.keyboard.type('SON 4')
  await expect(options).toHaveText(['Claude Sonnet 4.5', 'Claude Sonnet 4'])
  await expect(dialog.getByRole('tab', { selected: true })).toHaveCount(0)
  await expect(list.getByRole('group', { name: 'Models · Anthropic' })).toBeVisible()
  await search.fill('qwen coder')
  await expect(options).toHaveText(['Qwen3 Coder'])
  // Spaces, dashes and dots are loose: "kimik2" finds "Kimi K2", "gpt4.1" finds "GPT-4.1".
  await search.fill('kimik2')
  await expect(options).toHaveText(['Kimi K2', 'Kimi K2 Turbo'])
  await session.shot('model-picker-filtered')
  await search.fill('gpt4.1')
  await expect(options).toHaveText(['GPT-4.1', 'GPT-4.1 Mini'])
  await search.fill('nothing like this')
  await expect(options).toHaveCount(0)
  await expect(dialog.getByText('No models match')).toBeVisible()
  await session.shot('model-picker-empty')
  // Cleared, the tab it was on again.
  await search.fill('')
  await expect(tab('Models')).toHaveAttribute('aria-selected', 'true')
  await expect(options).toHaveCount(41)

  // ↑/↓ move keyboard selection; pointer highlighting leaves aria-activedescendant in place.
  await search.fill('gpt 5')
  await expect(options).toHaveText(['GPT-5', 'GPT-5 Mini', 'GPT-5 Nano'])
  await expectActive(search, options.nth(0))
  await search.press('ArrowDown')
  await search.press('ArrowDown')
  await search.press('ArrowDown')
  await expectActive(search, options.nth(2))
  await search.press('ArrowUp')
  await expectActive(search, options.nth(1))
  await options.nth(0).hover()
  await expectActive(search, options.nth(1))
  await expect(options.nth(0)).toHaveCSS(
    'background-color',
    await options.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor),
  )
  await session.shot('model-picker-search')

  // Enter picks the highlighted model: it applies now (between turns), the picker closes
  // and focus goes back to the button.
  await search.fill('acme sage')
  await expect(options).toHaveText(['Acme/Sage'])
  await search.press('Enter')
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'sage', 'medium')
  await waitFor(() => configCalls(runs()[0]).length === 1, 'the model change')
  expect(configCalls(runs()[0])).toEqual([{ configId: 'llm', value: 'sage' }])
  // "Provider/Model" names show the model; the picker has the full name.
  const sage = chat.getByRole('button', { name: 'Model: Sage, effort Medium' })
  await expect(sage).toBeFocused()
  await session.shot('model-button')

  // Effort is a segmented control in the picker; it applies now and the picker stays.
  await sage.click()
  await expect(effort.getByRole('button', { name: 'Medium' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await effort.getByRole('button', { name: 'High' }).click()
  await modelsAre(session, 'sage', 'high')
  await waitFor(() => configCalls(runs()[0]).length === 2, 'the effort change')
  expect(configCalls(runs()[0])[1]).toEqual({ configId: 'depth', value: 'high' })
  await expect(dialog).toBeVisible()
  await expect(effort.getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')

  // Typing while an effort level has focus goes to the search field; Esc closes the picker
  // and returns focus to the button.
  await expect(effort.getByRole('button', { name: 'High' })).toBeFocused()
  await chat.keyboard.type('gem')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('gem')
  await chat.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const sageHigh = chat.getByRole('button', { name: 'Model: Sage, effort High' })
  await expect(sageHigh).toBeFocused()
  await expect(sageHigh).toHaveAttribute('aria-expanded', 'false')

  // From the keyboard it opens fresh; a click elsewhere in the chat closes it, picking nothing.
  await chat.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  // (In the transcript: the picker, as wide as six effort levels need, covers the message box.)
  await chat.getByRole('article').first().getByText('Hello', { exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(sageHigh).not.toBeFocused()
  expect(configCalls(runs()[0])).toHaveLength(2)

  // At the panel's smallest it still fits inside the panel and scrolls its list.
  const panel = chat.locator('[data-chat-panel]')
  await chat.evaluate(() => {
    window.gui.resizeChat('bottom-left', 10_000, -10_000)
    window.gui.endResizeChat()
  })
  await waitFor(async () => {
    const box = await panel.boundingBox()
    return box && box.width <= 320 && box.height <= 360
  }, 'the smallest panel')
  await sageHigh.click()
  await tab('Models').click()
  // With the tool notice in the composer there isn't room above it, so it covers the message box.
  await expect(chat.locator('[data-tool-notice]')).toBeVisible()
  const small = await expectPlaced(session, dialog, sageHigh)
  expect(small.overFrame).toBe(true)
  expect(small.box.height).toBeGreaterThan(200)
  const listBox = await list.boundingBox()
  expect(listBox?.height).toBeGreaterThan(100)
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await chat.keyboard.type('grok')
  await expect(options).toHaveCount(4)
  await session.shot('model-picker-small')
  await chat.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Remembered per agent, under the agent's own ids; the file is written a moment after.
  const prefsFile = join(session.fixture.userData, 'prefs.json')
  await waitFor(() => {
    const prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as {
      agentSettings?: Record<string, unknown>
    }
    return isDeepStrictEqual(prefs.agentSettings?.[AGENT], { llm: 'sage', depth: 'high' })
  }, "the agent's settings in prefs.json")

  // A new chat starts a new session at the agent's defaults; the choices go in before the
  // first prompt, the model before the effort.
  await chat.evaluate(() => window.gui.newSession())
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 0, 'the new chat')
  await modelsAre(session, 'sage', 'high')
  expect(await send(session, 'Hello again')).toBe(true)
  const second = await session.waitForTurn(0)
  expect(second.turn.status).toBe('done')
  expect(runs()).toHaveLength(2)
  const methods = (runs()[1] ?? []).map((call) => call.method)
  expect(methods.slice(methods.indexOf('session/new'))).toEqual([
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
    'session/prompt',
  ])
  expect(configCalls(runs()[1])).toEqual([
    { configId: 'llm', value: 'sage' },
    { configId: 'depth', value: 'high' },
  ])
  expect(second.meta.models?.model.value).toBe('sage')
  expect(second.meta.models?.effort?.value).toBe('high')

  // A refused choice doesn't fail the turn: it says so quietly and runs on the agent's own.
  await sageHigh.click()
  await effort.getByRole('button', { name: 'Max' }).click()
  await modelsAre(session, 'sage', 'max')
  await chat.keyboard.press('Escape')
  expect(await send(session, 'Think harder')).toBe(true)
  const third = await session.waitForTurn(1)
  expect(third.turn.status).toBe('done')
  expect(third.turn.items).toContainEqual(
    expect.objectContaining({
      kind: 'notice',
      tone: 'info',
      text: "Couldn't switch the effort to Max, so this message uses High.",
    }),
  )
  expect(third.meta.models?.effort?.value).toBe('high')
  expect((runs()[1] ?? []).filter((call) => call.method === 'session/prompt')).toHaveLength(2)

  // Main takes only a choice the agent offers; a click on a row picks it.
  await chat.evaluate(() => window.gui.setAgentSetting('llm', 'not-a-model'))
  await chat.evaluate(() => window.gui.setAgentSetting('mode', 'ask'))
  await sageHigh.click()
  await tab('Models').click()
  await options.filter({ hasText: 'GPT-5 Nano' }).click()
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'openai/gpt-5-nano', 'high')
  const nano = { configId: 'llm', value: 'openai/gpt-5-nano' }
  await waitFor(() => configCalls(runs()[1]).at(-1)?.value === nano.value, 'the model change')
  const calls = configCalls(runs()[1])
  expect(calls.at(-1)).toEqual(nano)
  expect(calls.filter((call) => call.value === 'not-a-model' || call.configId === 'mode')).toEqual(
    [],
  )
})

test('a short model list is driven from the search field', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  await addAgent(session, 'short')
  await modelsAre(session, 'swift', 'medium')

  // Nothing used yet: it opens on the chat's own agent.
  const button = session.chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await button.click()
  const { dialog, search, list, options, tab } = pickerOf(session)
  await expect(dialog).toBeVisible()
  await expect(tab('Models')).toHaveAttribute('aria-selected', 'true')
  await expect(search).toBeFocused()
  await expect(options).toHaveText(['Swift', 'Sage', 'Atlas'])
  await expect(list.getByRole('group')).toHaveCount(0)
  expect((await expectPlaced(session, dialog, button)).overFrame).toBe(false)
  await session.shot('model-picker-short')

  await session.chat.keyboard.press('ArrowDown')
  await expectActive(search, options.nth(1))
  await session.chat.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'sage', 'medium')
  await expect(
    session.chat.getByRole('button', { name: 'Model: Sage, effort Medium' }),
  ).toBeFocused()
})

test('an agent with providers: the picker switches provider, lists its models, and new chats keep it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  const runs = await addAgent(session, 'providers')
  const { chat } = session

  // Before any chat session: the health check's provider, beside the model and effort.
  const listed = await modelsAre(session, 'swift', 'medium')
  expect(listed.provider).toEqual({
    id: 'provider',
    value: 'gateway',
    options: [
      { value: 'gateway', name: 'Gateway', group: null },
      { value: 'codex', name: 'Codex', group: null },
      { value: 'grok', name: 'Grok', group: null },
    ],
  })
  expect(listed.model.options).toHaveLength(41)

  // A row above the models, in the agent's own names.
  await chat.getByRole('button', { name: 'Model: Swift, effort Medium' }).click()
  const { dialog, search, options, provider } = pickerOf(session)
  const choice = (name: string) => provider.getByRole('button', { name })
  await expect(provider).toBeVisible()
  await expect(provider.getByRole('button')).toHaveText(['Gateway', 'Codex', 'Grok'])
  await expect(choice('Gateway')).toHaveAttribute('aria-pressed', 'true')
  await expect(options).toHaveCount(41)
  await search.fill('gpt 5')
  await expect(options).toHaveText(['GPT-5', 'GPT-5 Mini', 'GPT-5 Nano'])
  // The Provider row is the agent's tab's: a search is every agent's models.
  await expect(provider).toHaveCount(0)
  await search.fill('')
  await expect(provider).toBeVisible()

  // One the agent turns down says why, and the picker stays on the provider it had. The
  // chat had no session yet: asking started one.
  await choice('Grok').click()
  await expect(dialog.getByRole('alert')).toHaveText("Grok isn't signed in. Run fx login grok.")
  await expect(choice('Gateway')).toHaveAttribute('aria-pressed', 'true')
  await expect(options).toHaveCount(41)
  expect(runs()).toHaveLength(1)
  await session.shot('model-picker-provider-refused')

  // Another one lists its models in place.
  await choice('Codex').click()
  await expect(choice('Codex')).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(options).toHaveText(['GPT-5 Codex', 'GPT-5'])
  await expect(dialog.getByText('2 models')).toBeVisible()
  await modelsAre(session, 'gpt-5-codex', 'medium')
  await session.shot('model-picker-provider')
  await options.filter({ hasText: /^GPT-5$/ }).click()
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'gpt-5', 'medium')
  await waitFor(() => configCalls(runs()[0]).length === 3, 'the model change')
  expect(configCalls(runs()[0])).toEqual([
    { configId: 'provider', value: 'grok' },
    { configId: 'provider', value: 'codex' },
    { configId: 'llm', value: 'gpt-5' },
  ])

  // Remembered with the model; the refused one never was.
  const prefsFile = join(session.fixture.userData, 'prefs.json')
  await waitFor(() => {
    const prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as {
      agentSettings?: Record<string, unknown>
    }
    return isDeepStrictEqual(prefs.agentSettings?.[AGENT], { provider: 'codex', llm: 'gpt-5' })
  }, "the agent's settings in prefs.json")

  // The agent's next check lists that provider too, so a chat after a restart has its models.
  const checks = () => {
    const chats = new Set(runs().flatMap((calls) => calls.map((call) => call.pid)))
    return readFileSync(join(session.fixture.base, 'agent-calls.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call)
      .filter((call) => !chats.has(call.pid))
  }
  const before = checks().length
  await session.chrome.evaluate(() => window.gui.checkAgents())
  await waitFor(
    () =>
      checks()
        .slice(before)
        .some(
          (call) => call.method === 'session/set_config_option' && call.params.value === 'codex',
        ),
    "the check's switch to Codex",
  )

  // A new chat lists that provider's models before its session starts, and its session
  // switches to the provider before the model, before the first prompt.
  await chat.evaluate(() => window.gui.newSession())
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 0, 'the new chat')
  const next = await modelsAre(session, 'gpt-5', 'medium')
  expect(next.provider?.value).toBe('codex')
  expect(next.model.options.map((option) => option.value)).toEqual(['gpt-5-codex', 'gpt-5'])
  await chat.getByRole('button', { name: 'Model: GPT-5, effort Medium' }).click()
  // Recent has it under its provider; the Provider row is the agent's tab's.
  const { tab } = pickerOf(session)
  await expect(tab('Recent')).toHaveAttribute('aria-selected', 'true')
  await expect(options).toHaveCount(1)
  await expect(options.first()).toHaveAttribute('aria-selected', 'true')
  await expect(provider).toHaveCount(0)
  await tab('Models').click()
  await expect(choice('Codex')).toHaveAttribute('aria-pressed', 'true')
  await expect(options).toHaveText(['GPT-5 Codex', 'GPT-5'])
  await chat.keyboard.press('Escape')
  expect(await send(session, 'Hello')).toBe(true)
  const turn = await session.waitForTurn(0)
  expect(turn.turn.status).toBe('done')
  expect(runs()).toHaveLength(2)
  const methods = (runs()[1] ?? []).map((call) => call.method)
  expect(methods.slice(methods.indexOf('session/new'))).toEqual([
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
    'session/prompt',
  ])
  expect(configCalls(runs()[1])).toEqual([
    { configId: 'provider', value: 'codex' },
    { configId: 'llm', value: 'gpt-5' },
  ])
  expect(turn.meta.models?.provider?.value).toBe('codex')
  expect(turn.meta.models?.model.value).toBe('gpt-5')
})

const OTHER: AgentId = `${CUSTOM_AGENT_PREFIX}Other`

const agentIs = (session: GuiSession, id: AgentId) =>
  waitFor(async () => (await session.chatSnapshot()).meta.agentId === id, `the chat on ${id}`)

/** Waits for the picker to have `id`'s models from its check. */
const listsModelsOf = (session: GuiSession, id: AgentId) =>
  waitFor(
    async () =>
      !!(await session.chatSnapshot()).meta.agents.find((agent) => agent.id === id)?.models,
    `${id}'s models`,
  )

/** The Settings window, once it's open and its page has loaded. */
async function settingsPage(session: GuiSession): Promise<Page> {
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
  const page = await waitFor(find, 'the Settings window', { timeout: 30_000 })
  await page.waitForFunction(() => 'gui' in window)
  return page
}

/** A screenshot in the dark appearance and in the light. */
async function shots(session: GuiSession, name: string) {
  if (process.env.GUI_E2E_SHOTS !== '1') return
  await session.chat.emulateMedia({ colorScheme: 'dark' })
  await session.shot(`${name}-dark`)
  await session.chat.emulateMedia({ colorScheme: 'light' })
  await session.shot(name)
}

test('an empty chat takes another agent’s model from the picker, which leaves the default agent alone', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  await addAgent(session, 'short', { Other: 'short' })
  await modelsAre(session, 'swift', 'medium')
  await listsModelsOf(session, OTHER)
  const { chat } = session
  const picker = pickerOf(session)

  // The header names the agent and no longer switches it: the picker does.
  await expect(chat.getByRole('heading', { level: 2, name: 'Models' })).toBeVisible()
  await expect(chat.getByRole('button', { name: /^Switch agent/ })).toHaveCount(0)

  // Nothing used yet: it opens on the chat's agent, among a tab per agent after Recent.
  const button = chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await button.click()
  await expect(picker.tab('Models')).toHaveAttribute('aria-selected', 'true')
  const names = await picker.tabs
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('aria-label')))
  expect(names[0]).toBe('Recent')
  expect(names.indexOf('Other')).toBeGreaterThan(names.indexOf('Models'))
  await expect(picker.tab('Other')).toHaveAttribute('title', 'Other')
  await expect(picker.dialog.getByRole('button', { name: 'Agent Settings…' })).toBeVisible()

  // ←/→ go along the tabs, each shown as it's reached.
  await picker.tab('Models').focus()
  await chat.keyboard.press('ArrowLeft')
  await expect(picker.tab('Recent')).toBeFocused()
  await expect(picker.tab('Recent')).toHaveAttribute('aria-selected', 'true')
  await expect(picker.dialog.getByText('No recent models')).toBeVisible()
  await chat.keyboard.press('ArrowRight')
  await expect(picker.tab('Models')).toBeFocused()
  await expect(picker.tab('Models')).toHaveAttribute('aria-selected', 'true')

  // Another agent's tab lists its models. The effort is the chat's own model's: not there.
  await picker.tab('Other').click()
  await expect(picker.search).toBeFocused()
  await expect(picker.options).toHaveText(['Swift', 'Sage', 'Atlas'])
  await expect(picker.dialog.getByText('3 models')).toBeVisible()
  await expect(picker.effort).toHaveCount(0)
  await expect(
    picker.dialog.getByText('A model from another agent starts a new chat.'),
  ).toHaveCount(0)
  await session.shot('model-picker-other-agent')

  // Typing searches every agent's models, under each agent.
  await chat.keyboard.type('atlas')
  await expect(picker.search).toHaveValue('atlas')
  await expect(picker.dialog.getByRole('tab', { selected: true })).toHaveCount(0)
  const found = (agent: string) =>
    picker.list.getByRole('group', { name: agent, exact: true }).getByRole('option')
  await expect(found('Models')).toHaveText(['Atlas'])
  await expect(found('Other')).toHaveText(['Atlas'])
  // Nothing said yet, so nothing starts a new chat.
  await expect(picker.dialog.getByText('New chat')).toHaveCount(0)
  await session.shot('model-picker-search-all')
  // Cleared, the tab it was on again.
  await picker.search.fill('')
  await expect(picker.tab('Other')).toHaveAttribute('aria-selected', 'true')

  // Another agent's model, from the keyboard: the chat takes that agent, on that model.
  await picker.search.fill('atlas')
  await chat.keyboard.press('ArrowDown')
  await expectActive(picker.search, found('Other'))
  await chat.keyboard.press('Enter')
  await expect(picker.dialog).toHaveCount(0)
  await agentIs(session, OTHER)
  await waitFor(async () => (await models(session))?.model.value === 'atlas', 'Other on Atlas')
  await expect(chat.getByRole('heading', { level: 2, name: 'Other' })).toBeVisible()
  // Nothing was said, so nothing was archived.
  expect((await session.chatSnapshot()).meta.archived).toBeNull()

  // Recent has it first, with its agent, marked as the chat's.
  await chat.getByRole('button', { name: 'Model: Atlas, effort Medium' }).click()
  await expect(picker.tab('Recent')).toHaveAttribute('aria-selected', 'true')
  await expect(picker.options.first()).toContainText('Atlas')
  await expect(picker.options.first()).toContainText('Other')
  await expect(picker.options.first()).toHaveAttribute('aria-selected', 'true')

  // This chat only: the default agent is still Settings' own, and Agent Settings… opens there.
  await picker.dialog.getByRole('button', { name: 'Agent Settings…' }).click()
  await expect(picker.dialog).toHaveCount(0)
  const settings = await settingsPage(session)
  await expect(settings.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible()
  expect((await settings.evaluate(() => window.gui.getSettings())).defaultAgentId).toBe(
    DEFAULT_AGENT_ID,
  )
})

test('a started chat: another agent’s model starts a new chat, and while it works the picker asks first', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  await addAgent(session, 'short', { Other: 'short' })
  await modelsAre(session, 'swift', 'medium')
  await listsModelsOf(session, OTHER)
  const { chat } = session
  const picker = pickerOf(session)
  const open = async () => {
    await chat.getByRole('button', { name: /^Model: / }).click()
    await expect(picker.dialog).toBeVisible()
  }
  const snapshot = () => session.chatSnapshot()

  // While a turn runs it opens on Recent, the model the message went on, and says what
  // another agent's model does.
  expect(await send(session, 'SLOW')).toBe(true)
  await waitFor(async () => (await snapshot()).meta.status === 'working', 'the turn')
  await open()
  await expect(picker.tab('Recent')).toHaveAttribute('aria-selected', 'true')
  await expect(picker.options).toHaveCount(1)
  await expect(picker.options.first()).toHaveAttribute('aria-selected', 'true')
  await expect(
    picker.dialog.getByText('A model from another agent starts a new chat.'),
  ).toBeVisible()
  await shots(session, 'model-picker-recent-started')

  // Its rows say so too; nothing is disabled.
  await chat.keyboard.type('sage')
  const found = (agent: string) =>
    picker.list.getByRole('group', { name: agent, exact: true }).getByRole('option')
  await expect(found('Other')).toContainText('New chat')
  await expect(found('Models')).not.toContainText('New chat')
  await expect(picker.dialog.locator('[aria-disabled="true"]')).toHaveCount(0)
  await shots(session, 'model-picker-search-started')

  // Picking it asks first. Cancel goes back to the list.
  const question = picker.dialog.getByRole('region', {
    name: 'Stop Models and start a new chat with Other on Sage?',
  })
  await found('Other').click()
  await expect(question).toBeVisible()
  await expect(question).toContainText(
    'Models is still working. This chat is archived with what it has done so far.',
  )
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(picker.list).toBeHidden()
  await expect(picker.effort).toHaveCount(0)
  await shots(session, 'model-picker-confirm')
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toHaveCount(0)
  await expect(found('Other')).toBeVisible()
  await expect(picker.search).toBeFocused()
  // Esc too, with the picker still open.
  await found('Other').click()
  await expect(question).toBeVisible()
  await chat.keyboard.press('Escape')
  await expect(question).toHaveCount(0)
  await expect(picker.dialog).toBeVisible()
  expect((await snapshot()).meta.agentId).toBe(AGENT)
  expect((await snapshot()).meta.status).toBe('working')

  // Stop and Switch: the turn stops, this chat is archived, and Other starts on Sage.
  await found('Other').click()
  await question.getByRole('button', { name: 'Stop and Switch' }).click()
  await expect(picker.dialog).toHaveCount(0)
  await agentIs(session, OTHER)
  await waitFor(async () => {
    const { turns, meta } = await snapshot()
    return turns.length === 0 && meta.archived !== null && meta.models?.model.value === 'sage'
  }, 'a new chat on Other, on Sage, with the old one archived')

  // Started and done: another agent's model starts a new chat right away.
  expect(await send(session, 'Hello')).toBe(true)
  expect((await session.waitForTurn(0)).turn.status).toBe('done')
  await open()
  await chat.keyboard.type('atlas')
  await expect(found('Models')).toContainText('New chat')
  await found('Models').click()
  await expect(picker.dialog).toHaveCount(0)
  await agentIs(session, AGENT)
  await waitFor(async () => {
    const { turns, meta } = await snapshot()
    return turns.length === 0 && meta.models?.model.value === 'atlas'
  }, 'a new chat on Models, on Atlas')
})

test('New chat while a reply runs asks first, as the picker does; with none it starts at once', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  await addAgent(session, 'short')
  const { chat } = session
  const snapshot = () => session.chatSnapshot()
  const newChat = chat.getByRole('button', { name: 'New chat', exact: true })
  const message = chat.getByRole('textbox', { name: /^Message / })
  const question = chat.getByRole('region', { name: 'Stop Models and start a new chat?' })
  const working = async () => {
    const { meta, turns } = await snapshot()
    expect(meta.status).toBe('working')
    expect(turns).toHaveLength(1)
  }

  expect(await send(session, 'SLOW')).toBe(true)
  await waitFor(async () => (await snapshot()).meta.status === 'working', 'the turn')

  // Its button asks, over the message box, with what stopping costs.
  await newChat.click()
  await expect(question).toBeVisible()
  await expect(question).toContainText(
    'Models is still working. This chat is archived with what it has done so far.',
  )
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await shots(session, 'new-chat-confirm')
  // Cancel: the reply keeps running, and the keyboard goes back to the button.
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toHaveCount(0)
  await expect(newChat).toBeFocused()
  await working()

  // ⇧⌘K (Agent → New Chat) asks the same; Esc is a no too, back to the message box.
  await message.focus()
  await session.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === 'New Chat' && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    find(Menu.getApplicationMenu()?.items ?? [])?.click()
  })
  await expect(question).toBeVisible()
  await expect(question.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await chat.keyboard.press('Escape')
  await expect(question).toHaveCount(0)
  await expect(message).toBeFocused()
  await working()

  // Yes: the turn stops and the chat is archived, as New chat always did.
  await newChat.click()
  await question.getByRole('button', { name: 'Stop and Start New Chat' }).click()
  await expect(question).toHaveCount(0)
  await waitFor(async () => {
    const { turns, meta } = await snapshot()
    return turns.length === 0 && meta.archived !== null
  }, 'a new chat, with the old one archived')

  // With no reply running, New chat doesn't ask.
  expect(await send(session, 'Hello')).toBe(true)
  expect((await session.waitForTurn(0)).turn.status).toBe('done')
  await newChat.click()
  await waitFor(async () => (await snapshot()).turns.length === 0, 'a new chat at once')
  await expect(question).toHaveCount(0)
})

test('an agent that isn’t ready: its tab is dimmed and says why; one with no models says so', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: STAND_INS_ONLY })
  await session.declineConsentDialogs()
  await addAgent(session, 'none', { Locked: 'signed-out' })
  const { chat } = session
  const locked: AgentId = `${CUSTOM_AGENT_PREFIX}Locked`
  await waitFor(
    async () =>
      (await session.state()).agents.find((agent) => agent.id === locked)?.status === 'signed-out',
    'the signed-out agent checked',
  )
  const picker = pickerOf(session)

  // Nothing used yet: it opens on the chat's agent, which has no models to choose.
  const button = chat.getByRole('button', { name: 'Agent: Models' })
  await expect(button).toHaveText('Models')
  await button.click()
  await expect(picker.tab('Models')).toHaveAttribute('aria-selected', 'true')
  await expect(picker.dialog.getByText('No models to choose')).toBeVisible()
  await expect(picker.effort).toHaveCount(0)

  // Locked isn't signed in: its mark is dimmed, and its tab says why, with a way to use it.
  const opacity = (name: string) =>
    picker
      .tab(name)
      .locator('span')
      .first()
      .evaluate((el) => Number(getComputedStyle(el).opacity))
  expect(await opacity('Locked')).toBeLessThan(0.5)
  expect(await opacity('Models')).toBe(1)
  await picker.tab('Locked').click()
  await expect(picker.dialog.getByText('Not signed in')).toBeVisible()
  await expect(picker.options).toHaveCount(0)
  await session.shot('model-picker-not-ready')
  // Typing doesn't search it: it has nothing to list.
  await chat.keyboard.type('swift')
  await expect(picker.dialog.getByText('No models match')).toBeVisible()
  await picker.search.fill('')
  await picker.dialog.getByRole('button', { name: 'Use Locked' }).click()
  await expect(picker.dialog).toHaveCount(0)
  await agentIs(session, locked)

  // ⇧⌘M (Agent → Choose Model…) opens the picker too.
  await session.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === 'Choose Model…' && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    find(Menu.getApplicationMenu()?.items ?? [])?.click()
  })
  await expect(picker.dialog).toBeVisible()
  await expect(picker.tab('Locked')).toHaveAttribute('aria-selected', 'true')
})

test('a chat reopened on an agent not checked since launch lists its models, saying so while it checks', async ({
  launch,
}) => {
  // OpenCode is neither pinned nor the default agent, so launching doesn't check it. Its
  // stand-in's check waits for the gate, so the picker can be seen in the meantime.
  const session = await launch({
    fixture: 'vite',
    open: 'recent',
    prefs: { agentSettings: { opencode: { llm: 'sage' } } },
  })
  const { root, base, userData } = session.fixture
  const script = join(base, 'models-agent.cjs')
  const gate = join(base, 'check-gate')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      opencode: {
        command: electronExecutable(),
        args: [script, join(base, 'agent-calls.ndjson'), 'long', gate],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    }),
  )
  // A started chat on it, as the last launch left it: one turn, and its session.
  const chats = join(userData, 'chats')
  mkdirSync(chats, { recursive: true })
  const name = createHash('sha1').update(realpathSync(root)).digest('hex').slice(0, 16)
  writeFileSync(
    join(chats, `${name}.json`),
    JSON.stringify({
      version: 1,
      agentId: 'opencode',
      sessionId: 'old-session',
      checkpoints: {},
      redo: null,
      turns: [
        {
          id: 'turn-1',
          index: 0,
          prompt: 'Change the heading',
          context: [],
          items: [{ kind: 'text', id: 'reply', text: 'Done.' }],
          status: 'done',
          error: null,
          reverted: false,
          startedAt: 1,
          endedAt: 2,
          changes: [],
        },
      ],
    }),
  )
  await session.chrome.evaluate((at) => window.gui.openRecent(at), root)
  await agentIs(session, 'opencode')
  const { chat } = session

  // While it's checked: no models yet, and its tab says it's being checked rather than
  // looking like an agent without any.
  const button = chat.getByRole('button', { name: 'Agent: OpenCode' })
  await button.click()
  const { dialog, list, options, effort, tab } = pickerOf(session)
  await expect(tab('OpenCode')).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByText('Checking')).toBeVisible()
  expect((await session.chatSnapshot()).meta.models).toBeNull()

  // Checked: its tab lists its models in place, the saved choice marked, with no message sent.
  writeFileSync(gate, '')
  await expect(dialog).toBeVisible()
  await expect(options).toHaveCount(41)
  await expect(list.getByRole('option', { selected: true })).toHaveText('Acme/Sage')
  await expect(effort.getByRole('button', { name: 'Medium' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await chat.keyboard.press('Escape')
  await expect(chat.getByRole('button', { name: 'Model: Sage, effort Medium' })).toBeVisible()
  expect((await session.chatSnapshot()).turns).toHaveLength(1)
})
