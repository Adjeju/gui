import { expect, test } from 'bun:test'
import { undo } from 'prosemirror-history'
import type { EditorState } from 'prosemirror-state'
import { buildPrompt } from '../src/main/prompt'
import {
  createDraft,
  draftText,
  insertPieces,
  pieceIds,
  removePieces,
  replaceText,
  serializeDraft,
} from '../src/renderer/src/chat/draft'
import type { ElementContext, Picked } from '../src/shared/types'

// Each element picked in the preview is a marker in the message ('pick' piece). Markers are
// numbered by their order in the text; the picks go to the agent in that order, under the
// same labels.

const typed = (state: EditorState, text: string) => state.apply(state.tr.insertText(text))
const picked = (state: EditorState, id: string) => state.apply(insertPieces(state, 'pick', [id]))

function element(id: string, tag: string): Picked {
  return {
    id,
    kind: 'element',
    url: 'http://localhost:5173/',
    viewport: { width: 1280, height: 800 },
    tag,
    text: tag,
    selector: `main > ${tag}`,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    styles: {},
    outerHTML: `<${tag}>${tag}</${tag}>`,
    source: null,
    componentStack: [],
    screenshot: null,
  } as unknown as ElementContext & { kind: 'element' }
}

/** A heading picked, a note, a button picked, a note: as a user writes it. */
function twoNotes() {
  let draft = picked(createDraft(), 'heading')
  draft = typed(draft, 'make this shorter ')
  draft = picked(draft, 'button')
  return typed(draft, 'make it blue')
}

test('markers are numbered in the order the text has them', () => {
  const draft = twoNotes()
  expect(pieceIds(draft.doc, 'pick')).toEqual(['heading', 'button'])
  const { text, order } = serializeDraft(draft.doc)
  expect(text).toBe('[Selection 1] make this shorter [Selection 2] make it blue')
  expect(order.pick).toEqual(['heading', 'button'])
})

test('a new marker before the others takes the first number', () => {
  let draft = twoNotes()
  // The caret at the start, then a pick: it's 1, and the others follow.
  draft = draft.apply(replaceText(draft, draftText(draft.doc), 0))
  draft = picked(draft, 'link')
  expect(pieceIds(draft.doc, 'pick')).toEqual(['link', 'heading', 'button'])
  expect(serializeDraft(draft.doc).text).toBe(
    '[Selection 1] [Selection 2] make this shorter [Selection 3] make it blue',
  )
})

test('deleting a marker renumbers the rest, and ⌘Z brings it back in its place', () => {
  const before = twoNotes()
  // Backspace after the first marker deletes it as one piece.
  const after = before.apply(before.tr.delete(1, 2))
  expect(pieceIds(after.doc, 'pick')).toEqual(['button'])
  expect(serializeDraft(after.doc).text).toBe('make this shorter [Selection 1] make it blue')
  let back = after
  undo(after, (tr) => {
    back = after.apply(tr)
  })
  expect(pieceIds(back.doc, 'pick')).toEqual(['heading', 'button'])
})

test('a pick dropped from outside takes its marker, and the rest renumber', () => {
  const draft = twoNotes()
  const dropped = draft.apply(removePieces(draft, 'pick', ['heading']))
  expect(serializeDraft(dropped.doc).text).toBe('make this shorter [Selection 1] make it blue')
})

test('a marker moved after another swaps their numbers', () => {
  const draft = twoNotes()
  // Cut from the front, pasted at the end: the button is 1 now.
  const cut = draft.apply(draft.tr.delete(1, 2))
  const end = cut.doc.content.size - 1
  const moved = cut.apply(cut.tr.insert(end, draft.doc.nodeAt(1) ?? []))
  expect(pieceIds(moved.doc, 'pick')).toEqual(['button', 'heading'])
  expect(serializeDraft(moved.doc).text).toBe(
    'make this shorter [Selection 1] make it blue[Selection 2]',
  )
})

test('the agent gets the message with its labels, then the picks under them in that order', () => {
  const { text, order } = serializeDraft(twoNotes().doc)
  const picks: Record<string, Picked> = {
    heading: element('heading', 'h1'),
    button: element('button', 'button'),
  }
  const blocks = buildPrompt({
    text,
    selection: order.pick.map((id) => picks[id] as Picked),
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [],
  }).flatMap((block) => (block.type === 'text' ? [block.text] : []))
  expect(blocks[0]).toBe('[Selection 1] make this shorter [Selection 2] make it blue')
  expect(blocks[1]).toBe(
    'The user selected 2 things in the preview. The message calls them [Selection 1] to [Selection 2], in this order:',
  )
  expect(blocks[2]).toMatch(/^<selected_element_[0-9a-f]+>\n\[Selection 1\]\n.*\nElement: <h1>/)
  expect(blocks[3]).toMatch(/^<selected_element_[0-9a-f]+>\n\[Selection 2\]\n.*\nElement: <button>/)
})

test('one pick named in the message is labelled too; picks it doesn’t name lead, as before', () => {
  const only = buildPrompt({
    text: '[Selection 1] bigger',
    selection: [element('a', 'h1')],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [],
  }).flatMap((block) => (block.type === 'text' ? [block.text] : []))
  expect(only[0]).toBe('[Selection 1] bigger')
  expect(only[1]).toBe(
    'The user selected 1 thing in the preview. The message calls it [Selection 1]:',
  )
  const unnamed = buildPrompt({
    text: 'Make these match',
    selection: [element('a', 'h1'), element('b', 'p')],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [],
  }).flatMap((block) => (block.type === 'text' ? [block.text] : []))
  expect(unnamed[0]).toBe('The user selected 2 things in the preview, in this order:')
  expect(unnamed.at(-1)).toBe('Make these match')
})
