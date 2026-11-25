import { expect, test } from 'bun:test'
import { closeHistory, undo } from 'prosemirror-history'
import { type EditorState, TextSelection } from 'prosemirror-state'
import {
  appendText,
  caretOffset,
  createDraft,
  draftText,
  hasWords,
  insertPieces,
  inTextOrder,
  OBJECT,
  removePieces,
  replaceText,
  serializeDraft,
} from '../src/renderer/src/chat/draft'

const typed = (state: EditorState, text: string) => state.apply(state.tr.insertText(text))
/** Typed after a pause: its own step in the undo history. */
const typedLater = (state: EditorState, text: string) =>
  state.apply(closeHistory(state.tr.insertText(text)))
const sent = (state: EditorState) => serializeDraft(state.doc).text
const undone = (state: EditorState) => {
  let next = state
  undo(state, (tr) => {
    next = state.apply(tr)
  })
  return next
}

test('pieces are numbered in the order the message names them', () => {
  let draft = typed(createDraft(), 'Is')
  draft = draft.apply(insertPieces(draft, 'image', ['b']))
  draft = typed(draft, 'darker than')
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = typed(draft, 'or')
  draft = draft.apply(insertPieces(draft, 'image', ['b']))
  expect(sent(draft)).toBe('Is [Image 1] darker than [Image 2] or [Image 1]')
  expect(serializeDraft(draft.doc).order.image).toEqual(['b', 'a'])
  // The images go in that order; one the text doesn't name comes after.
  const strip = [{ id: 'a' }, { id: 'c' }, { id: 'b' }]
  expect(inTextOrder(strip, ['b', 'a']).map((image) => image.id)).toEqual(['b', 'a', 'c'])
})

test('a message of pieces alone sends no text', () => {
  let draft = createDraft()
  draft = draft.apply(insertPieces(draft, 'image', ['a', 'b']))
  expect(hasWords(draft.doc)).toBe(false)
  expect(sent(draft)).toBe('')
  expect(sent(typed(draft, 'this'))).toBe('[Image 1] [Image 2] this')
})

test('typed text that looks like a label stays text', () => {
  let draft = typed(createDraft(), 'Keep [Image 1] as typed')
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = draft.apply(removePieces(draft, 'image', ['a']))
  expect(draftText(draft.doc)).toBe('Keep [Image 1] as typed ')
  expect(hasWords(createDraft('[Image 1]').doc)).toBe(true)
})

test('removing an image takes its piece and one space, and leaves the caret', () => {
  let draft = typed(createDraft(), 'Compare')
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = typed(draft, 'with')
  draft = draft.apply(insertPieces(draft, 'image', ['b']))
  draft = typed(draft, 'please')
  expect(draftText(draft.doc)).toBe(`Compare ${OBJECT} with ${OBJECT} please`)
  const caret = caretOffset(draft)
  draft = draft.apply(removePieces(draft, 'image', ['a']))
  expect(draftText(draft.doc)).toBe(`Compare with ${OBJECT} please`)
  expect(caretOffset(draft)).toBe(caret - 2)
  expect(sent(draft)).toBe('Compare with [Image 1] please')
})

test('⌘Z after removing an image undoes the typing before it', () => {
  let draft = typed(createDraft(), 'one')
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = typedLater(draft, 'two')
  draft = draft.apply(removePieces(draft, 'image', ['a']))
  expect(draftText(draft.doc)).toBe('one two')
  draft = undone(draft)
  expect(draftText(draft.doc)).toBe('one ')
  // Then the image's step, which has nothing left to take out but its spaces.
  expect(draftText(undone(draft).doc)).toBe('one')
})

test('a piece whose image is gone leaves when ⌘Z would bring it back', () => {
  const attached = new Set(['a'])
  let draft = typed(
    createDraft('', (_kind, id) => attached.has(id)),
    'see',
  )
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  // Backspace over the piece, then remove the image from the strip.
  const end = draft.selection.from
  draft = draft.apply(closeHistory(draft.tr.delete(end - 2, end)))
  attached.delete('a')
  draft = undone(draft)
  // The space that came back with it stays; the piece doesn't.
  expect(draftText(draft.doc)).toBe('see  ')
})

test('a command chosen from the menu keeps the pieces and puts the caret after it', () => {
  let draft = typed(createDraft(), 'look at')
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = typed(draft, '/re')
  const text = draftText(draft.doc)
  expect(text).toBe(`look at ${OBJECT} /re`)
  // As insertCommand writes it: the command first, the rest of the message after.
  const next = `/review look at ${OBJECT}`
  draft = draft.apply(replaceText(draft, next, '/review '.length))
  expect(draftText(draft.doc)).toBe(next)
  expect(caretOffset(draft)).toBe('/review '.length)
  draft = typed(draft, 'main ')
  expect(sent(draft)).toBe('/review main look at [Image 1]')
})

test('a transcript goes after the pieces when nothing is written', () => {
  let draft = createDraft()
  draft = draft.apply(insertPieces(draft, 'image', ['a']))
  draft = draft.apply(appendText(draft, 'make it blue'))
  expect(sent(draft)).toBe('[Image 1] make it blue')
  expect(sent(createDraft().apply(appendText(createDraft(), 'hi')))).toBe('hi')
})

test('offsets count newlines and pieces as one character each', () => {
  let draft = createDraft('ab\ncd')
  draft = draft.apply(
    draft.tr.setSelection(TextSelection.create(draft.doc, draft.doc.content.size - 1)),
  )
  expect(caretOffset(draft)).toBe(5)
  draft = draft.apply(replaceText(draft, 'ab\nXcd', 4))
  expect(draftText(draft.doc)).toBe('ab\nXcd')
  expect(caretOffset(draft)).toBe(4)
  expect(sent(draft)).toBe('ab\nXcd')
})
