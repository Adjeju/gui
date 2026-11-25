import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentId, CUSTOM_AGENT_PREFIX, isRegion } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Picking happens in Gui's overlay over the preview (main/picker.ts): a click picks an element,
// a drag an area, each after what's picked, and picking goes on; the wheel scrolls the page
// underneath. Each pick is a numbered marker in the message box (store.ts `syncPicks`).

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Picks`

/** A stand-in ACP agent that echoes the prompt's text and counts its images. No login, no usage. */
const AGENT_SCRIPT = String.raw`
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const handle = ({ id, method, params }) => {
  if (method === undefined || id === undefined) return
  if (method === 'initialize') {
    const agentCapabilities = { promptCapabilities: { image: true } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'session-' + process.pid } })
  if (method === 'session/prompt') {
    const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    const images = params.prompt.filter((block) => block.type === 'image').length
    const content = { type: 'text', text: 'IMAGES ' + images + '\n' + text }
    write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content } } })
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

async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'picks-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Picks: { command: electronExecutable(), args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
  }
  writeFileSync(join(session.fixture.userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the stand-in agent to be selected')
}

const selection = async (session: GuiSession) => (await session.chatSnapshot()).meta.selection
const selecting = async (session: GuiSession) => (await session.state()).preview.selecting

/** The message box's markers, in the order the text has them. */
const markers = (session: GuiSession) => session.chat.locator('[data-composer] [data-piece="pick"]')

/** What the message box reads, each marker as its number and name. */
const written = (session: GuiSession) =>
  session.chat
    .locator('[data-composer]')
    .evaluate((box) => (box as HTMLElement).innerText.replace(/\s+/g, ' ').trim())

/** The webContents with the keyboard, by what it shows: chat, pick, preview, or null. */
const keyboardAt = (session: GuiSession) =>
  session.app.evaluate(({ webContents }) => {
    const url = webContents.getFocusedWebContents()?.getURL() ?? null
    if (!url) return null
    if (url.endsWith('/chat.html')) return 'chat'
    if (url.endsWith('/pick.html')) return 'pick'
    return /^https?:/.test(url) ? 'preview' : url
  })

/** Types `text` as keys to whatever has the keyboard, as the user's typing would go. */
const typeToFocused = (session: GuiSession, text: string) =>
  session.app.evaluate(({ webContents }, keys) => {
    const focused = webContents.getFocusedWebContents()
    if (!focused) throw new Error('Nothing has the keyboard')
    for (const key of keys) focused.sendInputEvent({ type: 'char', keyCode: key })
  }, text)

const centerOf = (box: { x: number; y: number; width: number; height: number }) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
})

test('each click picks and picking goes on; a picked element clicked again drops out', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const overlay = await session.pickPage()

  // Click after click: each joins the selection, numbered in the overlay, still picking.
  const heading = await session.pickElement('h1')
  expect(heading.tag).toBe('h1')
  expect(await selecting(session)).toBe(true)
  await expect(overlay.locator('[data-pick-badge]')).toHaveText(['1'])
  const button = await session.pickElement('button.counter')
  expect(button.tag).toBe('button')
  expect(await selecting(session)).toBe(true)
  expect((await selection(session)).map((picked) => picked.id)).toEqual([heading.id, button.id])
  await expect(overlay.locator('[data-outline="picked"]')).toHaveCount(2)
  await expect(overlay.locator('[data-outline="picked"]').nth(1)).toHaveText('2')
  await expect(markers(session)).toHaveText(['1Heading', '2Button'])
  await session.shot('picked-two')

  // A click on a picked element takes it back out, and its marker with it; the button is 1.
  await session.overlayGesture(centerOf(await session.viewBox('h1')))
  await waitFor(async () => (await selection(session)).length === 1, 'the heading taken out')
  expect((await selection(session))[0]?.id).toBe(button.id)
  await expect(overlay.locator('[data-outline="picked"]')).toHaveCount(1)
  await expect(markers(session)).toHaveText(['1Button'])
  await expect(overlay.locator('[data-pick-badge]')).toHaveText(['1'])

  // The rows that listed picks above the message box are gone: the markers stand for them.
  await expect(session.chat.getByRole('list', { name: 'Selected' })).toHaveCount(0)

  // Esc over the page ends picking and keeps what's picked, marker and all.
  await overlay.keyboard.press('Escape')
  await waitFor(async () => !(await selecting(session)), 'picking to end')
  expect((await selection(session)).map((picked) => picked.id)).toEqual([button.id])
  await expect(markers(session)).toHaveCount(1)

  // Esc in the message box then clears the picks, and their markers with them.
  await session.chat.locator('[data-composer]').focus()
  await session.chat.keyboard.press('Escape')
  await waitFor(async () => (await selection(session)).length === 0, 'an empty selection')
  await expect(markers(session)).toHaveCount(0)
})

test('picks are markers in the message box: typing goes there, and the agent gets them in order', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await useStandIn(session)
  await session.waitForPreview()
  const overlay = await session.pickPage()
  const shots = process.env.GUI_E2E_PICK_SHOTS

  // A click picks the heading; the keyboard goes to the message box, the caret after its
  // marker, and picking goes on. Typed keys go to whatever has the keyboard, as a hand's do.
  await session.startPicking()
  expect(await keyboardAt(session)).toBe('pick')
  await session.overlayGesture(centerOf(await session.viewBox('h1')))
  await expect(markers(session)).toHaveText(['1Heading'])
  await waitFor(async () => (await keyboardAt(session)) === 'chat', 'the keyboard in the chat')
  await expect(session.chat.locator('[data-composer]')).toBeFocused()
  await typeToFocused(session, 'make this shorter ')
  expect(await written(session)).toBe('1Heading make this shorter')
  expect(await selecting(session)).toBe(true)

  // A second click, on the button, soon after: a pick too, not a double-click.
  await session.overlayGesture(centerOf(await session.viewBox('button.counter')))
  await expect(markers(session)).toHaveText(['1Heading', '2Button'])
  await waitFor(async () => (await keyboardAt(session)) === 'chat', 'the keyboard in the chat')
  await typeToFocused(session, 'make it blue')
  expect(await written(session)).toBe('1Heading make this shorter 2Button make it blue')
  await expect(overlay.locator('[data-pick-badge]')).toHaveText(['1', '2'])
  if (shots) {
    await session.chat.locator('form').screenshot({ path: join(shots, 'message-box.png') })
    await session.shot('page-badges', true)
  }

  // Pointing at a marker shows its element in the page, as its row did.
  await markers(session).first().hover()
  await expect(markers(session).first()).toHaveAttribute('title', /^h1/)

  // Enter sends: the message with each marker as its label, the picks under the same labels,
  // in the same order.
  const index = (await session.chatSnapshot()).turns.length
  await session.chat.locator('[data-composer]').press('Enter')
  const { turn, meta } = await session.waitForTurn(index)
  expect(turn.status, turn.error ?? '').toBe('done')
  expect(turn.prompt).toBe('[Selection 1] make this shorter [Selection 2] make it blue')
  expect(turn.context.map((picked) => (isRegion(picked) ? 'area' : picked.tag))).toEqual([
    'h1',
    'button',
  ])
  const answer = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
  const message = answer.indexOf('[Selection 1] make this shorter [Selection 2] make it blue')
  const header = answer.indexOf(
    'The user selected 2 things in the preview. The message calls them [Selection 1] to [Selection 2], in this order:',
  )
  const first = answer.search(
    /<selected_element_[0-9a-f]+>\n\[Selection 1\]\nPage: [^\n]*\nElement: <h1>/,
  )
  const second = answer.search(
    /<selected_element_[0-9a-f]+>\n\[Selection 2\]\nPage: [^\n]*\nElement: <button>/,
  )
  expect(message).toBeGreaterThan(-1)
  expect(header).toBeGreaterThan(message)
  expect(first).toBeGreaterThan(header)
  expect(second).toBeGreaterThan(first)
  expect(meta.selection).toEqual([])

  // The message box is empty again; the sent message shows each marker as a chip.
  await expect(markers(session)).toHaveCount(0)
  const sent = session.chat.locator(`[data-user-message="${turn.id}"]`)
  await expect(sent.locator('[data-pick-ref]')).toHaveText(['1Heading', '2Button'])
  if (shots) await session.shot('sent-message', true)
})

test('deleting a marker drops its pick and the rest renumber, on the page too', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const overlay = await session.pickPage()
  const heading = await session.pickElement('h1')
  const button = await session.pickElement('button.counter')
  await expect(markers(session)).toHaveText(['1Heading', '2Button'])

  // Backspace after the first marker deletes it as one piece: the heading's pick and badge go,
  // and the button is 1, in the message box and on the page.
  const box = session.chat.locator('[data-composer]')
  await box.focus()
  await box.press('Home')
  await box.press('ArrowRight')
  await box.press('Backspace')
  await waitFor(async () => (await selection(session)).length === 1, 'the heading dropped')
  expect((await selection(session))[0]?.id).toBe(button.id)
  await expect(markers(session)).toHaveText(['1Button'])
  await expect(overlay.locator('[data-pick-badge]')).toHaveText(['1'])

  // ⌘Z brings the marker back, and its pick and badge with it, in its place: 1 again.
  await box.press('ControlOrMeta+z')
  await expect(markers(session)).toHaveText(['1Heading', '2Button'])
  await waitFor(
    async () =>
      (await selection(session)).map((picked) => picked.id).join() === `${heading.id},${button.id}`,
    'the heading back',
  )
  await expect(overlay.locator('[data-pick-badge]')).toHaveText(['1', '2'])

  // Cut and pasted after the button, the heading's marker moves, and the numbers follow it.
  await box.press('Home')
  await box.press('Shift+ArrowRight')
  await box.press('ControlOrMeta+x')
  await waitFor(async () => (await selection(session)).length === 1, 'the cut marker’s pick out')
  await box.press('End')
  await box.press('ControlOrMeta+v')
  await expect(markers(session)).toHaveText(['1Button', '2Heading'])
  await waitFor(
    async () =>
      (await selection(session)).map((picked) => picked.id).join() === `${button.id},${heading.id}`,
    'the picks in the markers’ order',
  )
  await expect(overlay.locator('[data-pick-badge]')).toHaveCount(2)
})

test('dragging picks an area as a screenshot, and the agent gets every pick', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await useStandIn(session)
  await session.waitForPreview()

  // From just inside the heading's corner to just inside the button's: an area within <main>.
  const heading = await session.viewBox('h1')
  const button = await session.viewBox('button.counter')
  const from = { x: heading.x + 2, y: heading.y + 2 }
  const to = { x: button.x + button.width - 2, y: button.y + button.height - 2 }
  const area = await session.pickArea(from, to)
  expect(await selecting(session)).toBe(true)
  expect(area.screenshot).toMatch(/^data:image\/png;base64,/)
  // The gesture lands on whole pixels, so the area is within a pixel of the drag.
  expect(Math.abs(area.rect.width - (to.x - from.x))).toBeLessThanOrEqual(1)
  expect(Math.abs(area.rect.height - (to.y - from.y))).toBeLessThanOrEqual(1)
  expect(area.container?.tag).toBe('main')
  expect(area.container?.componentStack).toEqual(['App'])
  expect(area.container?.source?.file).toBe('src/App.tsx')
  await expect(session.chat.getByText('Area', { exact: true })).toBeVisible()
  await session.shot('picked-area')

  // A drag too small for an area is a click: it picks the element.
  const inButton = { x: button.x + button.width / 2, y: button.y + button.height / 2 }
  const clicked = await session.pickAt(inButton, { to: { x: inButton.x + 3, y: inButton.y + 2 } })
  expect(isRegion(clicked)).toBe(false)
  expect(await selection(session)).toHaveLength(2)
  await (await session.pickPage()).keyboard.press('Escape')
  await waitFor(async () => !(await selecting(session)), 'picking to end')

  // Both go to the agent, in order, each with its image; the turn keeps both.
  const index = (await session.chatSnapshot()).turns.length
  expect(await session.chat.evaluate(() => window.gui.send('Make these match'))).toBe(true)
  const { turn, meta } = await session.waitForTurn(index)
  expect(turn.status, turn.error ?? '').toBe('done')
  const answer = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
  expect(answer).toMatch(/^IMAGES 2\n/)
  expect(answer).toContain('The user selected 2 things in the preview, in this order:')
  expect(answer).toMatch(/<selected_area_[0-9a-f]+>\n\[Selection 1\]\n/)
  expect(answer).toContain('Inside: <main>, the smallest element around all of the area')
  expect(answer).toMatch(/<selected_element_[0-9a-f]+>\n\[Selection 2\]\n/)
  expect(turn.context.map((picked) => picked.kind ?? 'element')).toEqual(['region', 'element'])
  expect(meta.selection).toEqual([])
  await expect(session.chat.getByRole('list', { name: 'Selected' })).toHaveCount(1)
})

test('the wheel scrolls the page while picking, and outlines follow it', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '3000px'
    document.body.append(spacer)
  })
  const overlay = await session.pickPage()

  // Hovering outlines the element under the pointer and names it: what it is first, then its
  // component and its size.
  const button = await session.viewBox('button.counter')
  const inButton = { x: button.x + button.width / 2, y: button.y + button.height / 2 }
  await session.startPicking()
  await session.overlayPointer(inButton)
  await expect(overlay.locator('[data-outline="hover"]')).toHaveCount(1)
  await expect(overlay.locator('[data-label]')).toHaveText(/^buttonApp\d/)
  await expect(overlay.locator('[data-label]')).toContainText(
    `${Math.round(button.width)} × ${Math.round(button.height)}`,
  )
  await session.shot('hover')

  await session.pickElement('button.counter')
  const outline = overlay.locator('[data-outline="picked"]')
  const top = async () => (await outline.boundingBox())?.y ?? Number.NaN
  const before = await top()
  expect(before).toBeCloseTo(button.y, 0)

  // The wheel over the overlay scrolls the page under it; the outline moves with the button.
  await session.overlayPointer(inButton, 200)
  await waitFor(() => preview.evaluate(() => scrollY > 0), 'the page to scroll')
  const scrolled = await preview.evaluate(() => scrollY)
  await waitFor(
    async () => Math.abs((await top()) - (before - scrolled)) <= 1,
    'the outline to follow the scroll',
  )
  expect(await selecting(session)).toBe(true)
})

test('picks below the first screen once the page is scrolled', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    const spacer = document.createElement('div')
    spacer.style.height = '2000px'
    const below = document.createElement('p')
    below.id = 'below'
    below.textContent = 'Below the fold'
    const after = document.createElement('div')
    after.style.height = '2000px'
    document.body.append(spacer, below, after)
    below.scrollIntoView({ block: 'center' })
  })
  await waitFor(() => preview.evaluate(() => scrollY > 1000), 'the page to scroll')
  const overlay = await session.pickPage()

  // The protocol hit-tests in page coordinates; the overlay's are the viewport's.
  const box = await session.viewBox('#below')
  await session.startPicking()
  await session.overlayPointer({ x: box.x + 10, y: box.y + box.height / 2 })
  await expect(overlay.locator('[data-label]')).toContainText(
    `${Math.round(box.width)} × ${Math.round(box.height)}`,
  )
  const picked = await session.pickElement('#below')
  expect(picked.tag).toBe('p')
  expect(picked.attributes.id).toBe('below')
})

// Picking is what Design mode is for: a click picks at once, with no wait to see whether a
// second click makes it a double-click (text-edit.spec), and its marker comes with it.
test('a click picks at once, and its marker comes without a wait', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  const box = await session.viewBox('button.counter')
  await session.startPicking()
  const started = performance.now()
  await session.overlayGesture(centerOf(box))
  await waitFor(async () => (await selection(session)).length === 1, 'the pick', { interval: 10 })
  const picked = performance.now() - started
  await expect(markers(session)).toHaveCount(1, { timeout: 1000 })
  const marker = performance.now() - started
  console.log(`[e2e] click → pick ${Math.round(picked)} ms, marker ${Math.round(marker)} ms`)
  // Reading the pick takes well under 300 ms here; a click that waited for a second one
  // would take that long before it even began.
  expect(picked).toBeLessThan(300)
  expect(await selecting(session)).toBe(true)
  const [only] = await selection(session)
  expect(only && !isRegion(only) ? only.tag : null).toBe('button')
})
