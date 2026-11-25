import { Fragment, type Node, Slice } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { draftText, isPiece, type PieceKind, pieceIds, schema } from './draft'
import { fileSize, shortName } from './images'
import { pickLabel, pickName } from './picks'
import { applyDraft, pickById, pieceAttached, useChat } from './store'

/** The picks' markers in the order the draft has them, for their numbers. */
let numbered: { doc: Node; ids: string[] } | null = null

/** A pick's marker's number: its place among the markers in the text, as the page shows it. */
function pickNumber(id: string) {
  const { doc } = useChat.getState().draft
  if (numbered?.doc !== doc) numbered = { doc, ids: pieceIds(doc, 'pick') }
  return numbered.ids.indexOf(id) + 1
}

/** Each kind of piece as the message box draws it, redrawn when what it stands for changes. */
const PIECE_VIEWS: Record<
  PieceKind,
  { draw(dom: HTMLElement, id: string): void; text(id: string): string }
> = {
  image: {
    draw(dom, id) {
      const image = useChat.getState().attachments.find((attached) => attached.id === id)
      dom.replaceChildren()
      if (!image) {
        dom.removeAttribute('title')
        return
      }
      dom.title = image.name
      const thumbnail = document.createElement('img')
      thumbnail.src = image.thumbnail
      thumbnail.alt = ''
      thumbnail.className = 'size-4 shrink-0 rounded-sm object-cover'
      const name = document.createElement('span')
      name.className = 'truncate'
      name.textContent = shortName(image.name)
      dom.append(thumbnail, name)
      if (image.size) {
        const size = document.createElement('span')
        size.className = 'shrink-0 text-caption text-subtle'
        size.textContent = fileSize(image.size)
        dom.append(size)
      }
    },
    // Copied out of the message box, an image reads as its file's name.
    text: (id) => useChat.getState().attachments.find((attached) => attached.id === id)?.name ?? '',
  },
  // Something picked in the preview: its number, as the page's badge shows it, and its name.
  pick: {
    draw(dom, id) {
      const picked = pickById(id)
      dom.replaceChildren()
      if (!picked) {
        dom.removeAttribute('title')
        return
      }
      const number = String(pickNumber(id))
      const { name, detail, where } = pickLabel(picked)
      dom.title = [[name, detail].filter(Boolean).join(' '), where].filter(Boolean).join('\n')
      dom.dataset.pickNumber = number
      // The page's badge (Counter), at the size of an image piece's thumbnail.
      const badge = document.createElement('span')
      badge.className =
        'flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-caption font-medium text-accent-fg tabular-nums'
      badge.textContent = number
      const label = document.createElement('span')
      label.className = 'truncate'
      label.textContent = pickName(picked)
      dom.append(badge, label)
    },
    text: (id) => {
      const picked = pickById(id)
      return picked ? pickName(picked) : ''
    },
  },
}

const redraws = new Set<() => void>()

function pieceView(node: Node): NodeView {
  const kind = node.attrs.kind as PieceKind
  const dom = document.createElement('span')
  dom.contentEditable = 'false'
  dom.dataset.piece = kind
  dom.className =
    'mx-0.5 inline-flex max-w-56 items-center gap-1 rounded-md border border-line bg-fill py-px pr-1.5 pl-0.5 align-bottom text-small leading-snug text-fg select-none'
  const draw = () => PIECE_VIEWS[kind].draw(dom, node.attrs.id)
  draw()
  redraws.add(draw)
  // Pointing at a pick's marker shows which it is in the page.
  let hovered = false
  if (kind === 'pick') {
    dom.addEventListener('pointerenter', () => {
      hovered = true
      gui.hoverSelection(node.attrs.id)
    })
    dom.addEventListener('pointerleave', () => {
      hovered = false
      gui.hoverSelection(null)
    })
  }
  return {
    dom,
    ignoreMutation: () => true,
    destroy: () => {
      redraws.delete(draw)
      if (hovered) gui.hoverSelection(null)
    },
  }
}

const pieceText = (node: Node) =>
  isPiece(node) ? PIECE_VIEWS[node.attrs.kind as PieceKind].text(node.attrs.id) : (node.text ?? '')

/**
 * What was last cut or copied from the message box, as text and as it was: pasted back, its
 * pieces come back with it when what they stand for is still there and they aren't in the
 * message already (a marker cut and pasted elsewhere moves; a copied one pastes as its name).
 */
let copied: { text: string; slice: Slice } | null = null

function revived(fragment: Fragment, keep: (piece: Node) => boolean): Fragment {
  const nodes: Node[] = []
  fragment.forEach((node) => {
    if (isPiece(node)) {
      if (keep(node)) nodes.push(node)
      else {
        const text = pieceText(node)
        if (text) nodes.push(schema.text(text))
      }
    } else if (node.isText) nodes.push(node)
    else nodes.push(node.copy(revived(node.content, keep)))
  })
  return Fragment.from(nodes)
}

/** A slice of the message as plain text, each piece as its text (`PIECE_VIEWS`). */
function sliceText(slice: Slice) {
  const lines: string[] = []
  slice.content.forEach((node) => {
    const parts: string[] = []
    if (node.isTextblock)
      node.forEach((child) => {
        parts.push(pieceText(child))
      })
    else parts.push(pieceText(node))
    lines.push(parts.join(''))
  })
  return lines.join('\n')
}

/** What's selected is being cut or copied: kept, to paste back with its pieces. */
function remember(view: EditorView) {
  const { selection } = view.state
  if (!selection.empty) {
    const slice = selection.content()
    copied = { text: sliceText(slice), slice }
  }
  return false
}

/** `text` pasted into `state`: what was cut or copied here, as it was; anything else plain. */
function pastedSlice(state: EditorState, text: string) {
  if (!copied || copied.text !== text) return plainSlice(text)
  const present = new Set<string>()
  state.doc.descendants((node) => {
    if (isPiece(node)) present.add(`${node.attrs.kind}:${node.attrs.id}`)
  })
  const { slice } = copied
  const content = revived(slice.content, (piece) => {
    const key = `${piece.attrs.kind}:${piece.attrs.id}`
    if (present.has(key) || !pieceAttached(piece.attrs.kind as PieceKind, piece.attrs.id))
      return false
    present.add(key)
    return true
  })
  return new Slice(content, slice.openStart, slice.openEnd)
}

/** Pasted text as paragraphs of plain text: never rich text, never a piece. */
function plainSlice(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return new Slice(
    Fragment.from(
      lines.map((line) => schema.nodes.paragraph.create(null, line ? schema.text(line) : null)),
    ),
    1,
    1,
  )
}

export interface PromptEditorHandle {
  focus(options?: FocusOptions): void
}

interface PromptEditorProps {
  ref?: Ref<PromptEditorHandle>
  onKeyDown(event: KeyboardEvent): boolean
  /** Images pasted: true when it took the paste */
  onPaste(event: ClipboardEvent): boolean
  attributes: Record<string, string>
  placeholder: string
  className?: string
}

/**
 * The message box: a ProseMirror view of the store's draft (draft.ts). Every change, typed
 * or from outside, is a transaction on that state, so undo and the caret carry through.
 */
export function PromptEditor({
  ref,
  onKeyDown,
  onPaste,
  attributes,
  placeholder,
  className,
}: PromptEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ onKeyDown, onPaste })
  latest.current = { onKeyDown, onPaste }

  const domAttributes = (state: EditorState): Record<string, string> => ({
    ...attributes,
    role: attributes.role ?? 'textbox',
    'aria-multiline': 'true',
    'aria-placeholder': placeholder,
    'data-placeholder': placeholder,
    spellcheck: 'true',
    ...(draftText(state.doc) === '' ? { 'data-empty': '' } : {}),
    class: cn(
      // ProseMirror's own stylesheet isn't used: it turns ligatures off. What it needs is here.
      'relative whitespace-break-spaces break-words outline-none focus-visible:outline-none',
      'data-empty:before:pointer-events-none data-empty:before:absolute data-empty:before:text-subtle data-empty:before:content-[attr(data-placeholder)]',
      className,
    ),
  })
  const attributesRef = useRef(domAttributes)
  attributesRef.current = domAttributes

  useLayoutEffect(() => {
    if (!host.current) return
    const editor: EditorView = new EditorView(host.current, {
      state: useChat.getState().draft,
      attributes: (state) => attributesRef.current(state),
      nodeViews: { piece: (node) => pieceView(node) },
      handleKeyDown: (_view, event) => latest.current.onKeyDown(event),
      handlePaste: (editorView, event) => {
        if (latest.current.onPaste(event)) return true
        const text = event.clipboardData?.getData('text/plain') ?? ''
        // Always handled here, so nothing pasted is read as HTML.
        if (text)
          editorView.dispatch(
            editorView.state.tr
              .replaceSelection(pastedSlice(editorView.state, text))
              .scrollIntoView(),
          )
        return true
      },
      // Files dropped here attach through the chat panel's drop (useImageDrop); the editor
      // writes nothing for them.
      handleDrop: (_view, event) => event.dataTransfer?.types.includes('Files') ?? false,
      clipboardTextSerializer: (slice) => {
        const text = sliceText(slice)
        copied = { text, slice }
        return text
      },
      handleDOMEvents: {
        cut: (editorView) => remember(editorView),
        copy: (editorView) => remember(editorView),
      },
      dispatchTransaction: applyDraft,
    })
    view.current = editor
    // The store's draft is the truth: the view follows it, whoever changed it.
    const unsubscribe = useChat.subscribe((state, previous) => {
      if (state.draft !== editor.state) editor.updateState(state.draft)
      // A pick's marker shows its number, which changes as markers come, go and move.
      const picks =
        state.attachments !== previous.attachments ||
        state.meta?.selection !== previous.meta?.selection ||
        (state.draft.doc !== previous.draft.doc &&
          pieceIds(state.draft.doc, 'pick').join() !== pieceIds(previous.draft.doc, 'pick').join())
      if (picks) for (const redraw of redraws) redraw()
    })
    return () => {
      unsubscribe()
      editor.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    view.current?.setProps({ attributes: (state) => attributesRef.current(state) })
  })

  useImperativeHandle(ref, () => ({
    focus(options) {
      view.current?.dom.focus(options)
    },
  }))

  return <div ref={host} className="contents" />
}
