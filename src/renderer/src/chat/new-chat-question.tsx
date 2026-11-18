import { type FocusEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatMeta } from '../../../shared/types'
import { gui } from '../lib/api'
import { SquarePen } from '../lib/icons'
import { motionMs, usePresence } from '../lib/motion'
import { Popover, type PopoverPlacement, placePopover } from '../lib/surface'
import { whenSettled } from './model-picker'
import { StopQuestion } from './stop-question'
import { useChat, whenPanelShown } from './store'

/**
 * New chat (its button, the menu, ⇧⌘K) while a reply is running: main asks the chat to ask
 * first (`askNewChat`), and this asks it as the model picker does, over the message box. Yes
 * starts the new chat as New chat always has; Cancel or Esc leaves the reply running and puts
 * the keyboard back where it was. Lives in the message box's frame, which it opens off.
 */
export function NewChatQuestion({ meta }: { meta: ChatMeta }) {
  const ask = useChat((s) => s.askNewChat)
  const anchor = useRef<HTMLSpanElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  /** What had the keyboard when it asked, for after */
  const back = useRef<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  // Kept while it closes, which it does where it was.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const shown = usePresence(open, motionMs('--motion-exit'))
  const questionId = useId()

  useEffect(() => {
    if (!ask) return
    useChat.setState({ askNewChat: false })
    const active = document.activeElement
    back.current = active instanceof HTMLElement && active !== document.body ? active : null
    // The message box alone has no room for it: the panel grows first.
    whenPanelShown(() =>
      whenSettled(anchor.current, () => {
        const frame = anchor.current?.closest<HTMLElement>('[data-popover-anchor]')
        if (!frame) return
        setPlacement(placePopover(frame))
        setOpen(true)
      }),
    )
  }, [ask])

  useEffect(() => {
    if (open) cancel.current?.focus()
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus && back.current?.isConnected) back.current.focus({ preventScroll: true })
  }

  // A click elsewhere, the view losing focus, or a resize (which moves the box) is a no.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close only reads refs
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && root.current?.contains(target)) return
      close(false)
    }
    const dismiss = () => close(false)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (next instanceof Node && !event.currentTarget.contains(next)) close(false)
  }

  return (
    <>
      <span ref={anchor} hidden />
      {shown &&
        placement &&
        createPortal(
          <Popover
            key={`${placement.left},${placement.top},${placement.bottom}`}
            ref={root}
            open={open}
            role="dialog"
            aria-labelledby={questionId}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            placement={placement}
          >
            <StopQuestion
              id={questionId}
              meta={meta}
              next={null}
              to={<SquarePen className="size-4 text-muted" aria-hidden="true" />}
              cancel={cancel}
              onCancel={() => close(true)}
              onConfirm={() => {
                gui.newSession(undefined, true)
                close(true)
              }}
            />
          </Popover>,
          document.body,
        )}
    </>
  )
}
