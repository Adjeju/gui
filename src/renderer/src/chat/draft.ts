import { baseKeymap, splitBlock } from 'prosemirror-commands'
import { closeHistory, history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Fragment, type Node, Schema, Slice } from 'prosemirror-model'
import { EditorState, Plugin, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import { imageRef } from '../../../shared/image-refs'

/**
 * The message being written: a ProseMirror document of paragraphs holding text and pieces.
 * A piece stands for something attached to the message (an image, for now) by that thing's
 * id, never by a number: numbers are given only when the message is sent (`serializeDraft`),
 * in the order the pieces appear in the text. Text the user types is only ever text.
 *
 * Another kind of piece is one more entry in PIECES: its label for the sent message.
 */
export const PIECES = {
  image: { label: imageRef },
} satisfies Record<string, { label: (n: number) => string }>

export type PieceKind = keyof typeof PIECES

/** What each piece in the text view stands as: one character, as it is one position. */
export const OBJECT = '￼'

export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', toDOM: () => ['p', 0] },
    // No parseDOM: pasted or dropped HTML never becomes a piece.
    piece: {
      inline: true,
      group: 'inline',
      atom: true,
      selectable: false,
      attrs: { kind: { validate: 'string' }, id: { validate: 'string' } },
      toDOM: (node) => ['span', { 'data-piece': node.attrs.kind, 'data-id': node.attrs.id }],
    },
    text: { group: 'inline' },
  },
})

export const isPiece = (node: Node, kind?: PieceKind) =>
  node.type === schema.nodes.piece && (!kind || node.attrs.kind === kind)

export const pieceNode = (kind: PieceKind, id: string) => schema.nodes.piece.create({ kind, id })

function paragraphs(text: string, pieces: Node[] = []) {
  let next = 0
  return text.split('\n').map((line) =>
    schema.nodes.paragraph.create(
      null,
      line.split(OBJECT).flatMap((part, i) => {
        const nodes: Node[] = []
        const piece = i > 0 ? pieces[next++] : undefined
        if (piece) nodes.push(piece)
        if (part) nodes.push(schema.text(part))
        return nodes
      }),
    ),
  )
}

/**
 * Pieces whose thing is gone (an image removed from the strip, then ⌘Z brought back the
 * text around it) leave with the change that brought them.
 */
function dropOrphans(exists: (kind: PieceKind, id: string) => boolean) {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const orphans: number[] = []
      state.doc.descendants((node, pos) => {
        if (isPiece(node) && !exists(node.attrs.kind, node.attrs.id)) orphans.push(pos)
      })
      if (orphans.length === 0) return null
      const tr = state.tr
      for (const pos of orphans.reverse()) tr.delete(pos, pos + 1)
      return tr.setMeta('addToHistory', false)
    },
  })
}

/** A new draft holding `text`, with the caret at its end and no history. */
export function createDraft(
  text = '',
  exists: (kind: PieceKind, id: string) => boolean = () => true,
) {
  const doc = schema.nodes.doc.create(null, paragraphs(text))
  return EditorState.create({
    doc,
    selection: Selection.atEnd(doc),
    plugins: [
      history(),
      keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo, 'Shift-Enter': splitBlock }),
      keymap(baseKeymap),
      dropOrphans(exists),
    ],
  })
}

/** The text with each piece as OBJECT and a newline between paragraphs: what offsets count. */
export const draftText = (doc: Node) => doc.textBetween(0, doc.content.size, '\n', OBJECT)

/** Whether anything is written besides pieces and space. */
export const hasWords = (doc: Node) => draftText(doc).replaceAll(OBJECT, '').trim() !== ''

/** The document position of a text offset (`draftText`). */
export function positionAt(doc: Node, offset: number) {
  let left = Math.max(0, offset)
  let found = doc.content.size - 1
  let done = false
  doc.forEach((paragraph, start) => {
    if (done) return
    if (left <= paragraph.content.size) {
      found = start + 1 + left
      done = true
    }
    left -= paragraph.content.size + 1
  })
  return found
}

/** The text offset of a document position. */
export function offsetAt(doc: Node, pos: number) {
  let offset = 0
  let found = -1
  doc.forEach((paragraph, start) => {
    if (found !== -1) return
    if (pos <= start + paragraph.nodeSize)
      found = offset + Math.min(Math.max(pos - start - 1, 0), paragraph.content.size)
    offset += paragraph.content.size + 1
  })
  return found === -1 ? offset - 1 : found
}

/** Where the caret is as a text offset; -1 while text is selected. */
export function caretOffset(state: EditorState) {
  const { empty, from } = state.selection
  return empty ? offsetAt(state.doc, from) : -1
}

/**
 * The message as sent: each piece written as its label, numbered per kind in the order the
 * pieces first appear in the text, and those ids in that order. Nothing written but pieces
 * sends no text, as a message of images alone always has.
 */
export function serializeDraft(doc: Node) {
  const order = Object.fromEntries(
    Object.keys(PIECES).map((kind) => [kind, [] as string[]]),
  ) as Record<PieceKind, string[]>
  const lines: string[] = []
  doc.forEach((paragraph) => {
    let line = ''
    paragraph.forEach((child) => {
      if (!isPiece(child)) {
        line += child.text ?? ''
        return
      }
      const kind = child.attrs.kind as PieceKind
      const ids = order[kind]
      if (!ids.includes(child.attrs.id)) ids.push(child.attrs.id)
      line += PIECES[kind].label(ids.indexOf(child.attrs.id) + 1)
    })
    lines.push(line)
  })
  return { text: hasWords(doc) ? lines.join('\n').trim() : '', order }
}

/** `ids` put in the order the message names them, then those it doesn't name, as they were. */
export function inTextOrder<T extends { id: string }>(items: T[], named: string[]): T[] {
  const rank = (item: T) => {
    const at = named.indexOf(item.id)
    return at === -1 ? named.length : at
  }
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.i - b.i)
    .map(({ item }) => item)
}

/**
 * Pieces for `ids` at the caret, replacing any selection, each with a space around it where
 * there's none. A step of its own in the undo history.
 */
export function insertPieces(state: EditorState, kind: PieceKind, ids: string[]): Transaction {
  const tr = state.tr
  if (ids.length === 0) return tr
  const { $from, $to, from, to } = state.selection
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, OBJECT)
  const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, OBJECT)
  const nodes: Node[] = []
  if (before && !/\s$/.test(before)) nodes.push(schema.text(' '))
  ids.forEach((id, i) => {
    if (i > 0) nodes.push(schema.text(' '))
    nodes.push(pieceNode(kind, id))
  })
  if (!/^\s/.test(after)) nodes.push(schema.text(' '))
  const size = nodes.reduce((total, node) => total + node.nodeSize, 0)
  tr.replaceWith(from, to, nodes)
  tr.setSelection(TextSelection.create(tr.doc, from + size)).scrollIntoView()
  return closed(tr)
}

/**
 * Takes out the pieces for `ids`, with one of the spaces around each. Out of the undo
 * history: what they stood for is gone, so ⌘Z goes on to undo the typing before.
 */
export function removePieces(state: EditorState, kind: PieceKind, ids: string[]): Transaction {
  const tr = state.tr
  const found: { from: number; to: number }[] = []
  state.doc.descendants((node, pos) => {
    if (!isPiece(node, kind) || !ids.includes(node.attrs.id)) return
    const $pos = state.doc.resolve(pos)
    const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, OBJECT)
    const after = $pos.parent.textBetween(
      $pos.parentOffset + 1,
      $pos.parent.content.size,
      undefined,
      OBJECT,
    )
    let from = pos
    let to = pos + 1
    // One space goes with it: the one after, or else the one before.
    if (after.startsWith(' ')) to += 1
    else if (before.endsWith(' ')) from -= 1
    found.push({ from, to })
  })
  for (const { from, to } of found.reverse()) tr.delete(tr.mapping.map(from), tr.mapping.map(to))
  return tr.setMeta('addToHistory', false)
}

/**
 * The draft changed to read `next` (a `draftText`, its pieces as OBJECT in the same order),
 * with the caret at `caret`: only the part that differs is replaced, so pieces outside it
 * stay as they are and the change undoes in one step. A slash command chosen from the menu
 * is one.
 */
export function replaceText(state: EditorState, next: string, caret: number): Transaction {
  const { doc } = state
  const current = draftText(doc)
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let end = 0
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  )
    end++
  const from = positionAt(doc, start)
  const to = positionAt(doc, current.length - end)
  const pieces: Node[] = []
  doc.nodesBetween(from, to, (node) => {
    if (isPiece(node)) pieces.push(node)
  })
  const inserted = paragraphs(next.slice(start, next.length - end), pieces)
  const tr = state.tr
  if (from !== to || inserted.some((p) => p.content.size > 0) || inserted.length > 1)
    tr.replace(from, to, new Slice(Fragment.from(inserted), 1, 1))
  tr.setSelection(TextSelection.near(tr.doc.resolve(positionAt(tr.doc, caret))))
  return closed(tr).scrollIntoView()
}

/** `text` written at the end of the draft, after a space when there's no space before it. */
export function appendText(state: EditorState, text: string): Transaction {
  const end = state.doc.content.size - 1
  const written = draftText(state.doc)
  const gap = written !== '' && !/\s$/.test(written) ? ' ' : ''
  return closed(state.tr.insertText(`${gap}${text}`, end))
}

/** The whole draft replaced by `text`, caret at its end: one step to undo. */
export function setText(state: EditorState, text: string): Transaction {
  const tr = state.tr.replaceWith(0, state.doc.content.size, paragraphs(text))
  tr.setSelection(Selection.atEnd(tr.doc))
  return closed(tr)
}

/** A change from outside the editor is its own step in the undo history. */
const closed = (tr: Transaction) => closeHistory(tr)
