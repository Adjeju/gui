import type { ChatMeta } from './types'

/**
 * Whether starting over now would cut a reply short or drop a queued message: a turn still
 * working (answering, waiting on a permission card, or stopping) or messages queued. New chat
 * and another agent's model in the picker ask first then; main holds both back unless the user
 * said to stop.
 */
export function replyRunning(meta: Pick<ChatMeta, 'status' | 'queue'>) {
  return meta.status === 'working' || meta.queue.length > 0
}

/** Another agent the picker would start the new chat on, and its model. */
export interface StopTarget {
  agentName: string
  modelName: string | null
}

/**
 * What Gui asks before it stops a chat that `replyRunning` to start a new one: on `next`
 * (the picker's other agent), or on the chat's own agent (New chat) when null.
 */
export function stopQuestion(
  meta: Pick<ChatMeta, 'status' | 'queue' | 'agentName'>,
  next: StopTarget | null,
) {
  const on = next ? ` with ${next.agentName}${next.modelName ? ` on ${next.modelName}` : ''}` : ''
  return {
    title: `Stop ${meta.agentName} and start a new chat${on}?`,
    detail: whyAsked(meta),
    confirm: next ? 'Stop and Switch' : 'Stop and Start New Chat',
  }
}

/** The second line of the question: what stopping the chat costs. */
function whyAsked(meta: Pick<ChatMeta, 'status' | 'queue' | 'agentName'>) {
  const queued = meta.queue.length
  const dropped =
    queued === 1 ? 'its queued message is dropped' : `its ${queued} queued messages are dropped`
  if (meta.status === 'working') {
    return queued
      ? `${meta.agentName} is still working. This chat is archived with what it has done so far, and ${dropped}.`
      : `${meta.agentName} is still working. This chat is archived with what it has done so far.`
  }
  return `This chat is archived, and ${dropped}.`
}
