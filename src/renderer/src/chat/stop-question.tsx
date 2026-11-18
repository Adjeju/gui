import type { ReactNode, RefObject } from 'react'
import { type StopTarget, stopQuestion } from '../../../shared/stop-question'
import type { ChatMeta } from '../../../shared/types'
import { AgentIcon } from '../agents/agent-icon'
import { ArrowRight } from '../lib/icons'
import { Button } from '../lib/ui'

/**
 * The question before a new chat stops one whose reply is running (`replyRunning`): the model
 * picker's, for another agent's model, and New chat's. What it's about, what stopping costs,
 * then Cancel (focused, `cancel`) and the yes.
 */
export function StopQuestion({
  id,
  meta,
  next,
  to,
  cancel,
  onCancel,
  onConfirm,
}: {
  id: string
  meta: ChatMeta
  /** The picker's other agent and model; null for New chat on this one */
  next: StopTarget | null
  /** What the new chat is, beside the chat's agent: the other agent's mark, or New chat's */
  to: ReactNode
  cancel: RefObject<HTMLButtonElement | null>
  onCancel: () => void
  onConfirm: () => void
}) {
  const { title, detail, confirm } = stopQuestion(meta, next)
  return (
    <section
      aria-labelledby={id}
      className="flex min-h-0 flex-col gap-2 overflow-y-auto px-4 pt-5 pb-4"
    >
      <div className="mb-1 flex items-center gap-2">
        <AgentIcon agentId={meta.agentId} small />
        <ArrowRight className="size-3.5 text-subtle" aria-hidden="true" />
        {to}
      </div>
      <p id={id} className="text-body font-medium text-pretty">
        {title}
      </p>
      <p className="text-small text-pretty text-muted">{detail}</p>
      <div className="mt-2 flex justify-end gap-2">
        <Button ref={cancel} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </section>
  )
}
