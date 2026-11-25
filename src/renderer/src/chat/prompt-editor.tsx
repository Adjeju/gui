import { Fragment, type Node, Slice } from 'prosemirror-model'
import type { EditorState } from 'prosemirror-state'
import { EditorView, type NodeView } from 'prosemirror-view'
import { type Ref, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { draftText, isPiece, type PieceKind, schema } from './draft'
import { fileSize, shortName } from './images'
import { applyDraft, useChat } from './store'

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
  return { dom, ignoreMutation: () => true, destroy: () => redraws.delete(draw) }
}

const pieceText = (node: Node) =>
  isPiece(node) ? PIECE_VIEWS[node.attrs.kind as PieceKind].text(node.attrs.id) : (node.text ?? '')

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
            editorView.state.tr.replaceSelection(plainSlice(text)).scrollIntoView(),
          )
        return true
      },
      // Files dropped here attach through the chat panel's drop (useImageDrop); the editor
      // writes nothing for them.
      handleDrop: (_view, event) => event.dataTransfer?.types.includes('Files') ?? false,
      clipboardTextSerializer: (slice) => {
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
      },
      dispatchTransaction: applyDraft,
    })
    view.current = editor
    // The store's draft is the truth: the view follows it, whoever changed it.
    const unsubscribe = useChat.subscribe((state, previous) => {
      if (state.draft !== editor.state) editor.updateState(state.draft)
      if (state.attachments !== previous.attachments) for (const redraw of redraws) redraw()
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
