import type { TurnItem } from './types'

type PermissionItem = Extract<TurnItem, { kind: 'permission' }>

/** A permission request as far as Auto looks at it: what it's for, and what it offers. */
interface Asked {
  /** ACP tool kind; 'question' for the agent's own question, 'switch_mode' for Claude's plan */
  kind: string | null | undefined
  options: ReadonlyArray<{ optionId: string; kind: string }>
}

/**
 * What Auto mode answers a request with: allow once, never "always", whatever the request is
 * for. Null when the user decides: the agent's own questions, Claude's plan approval
 * (`switch_mode`), and a request that offers no "allow once".
 */
export function autoOption({ kind, options }: Asked): string | null {
  if (kind === 'question' || kind === 'switch_mode') return null
  return options.find((option) => option.kind === 'allow_once')?.optionId ?? null
}

const cardAsked = (item: PermissionItem): Asked => ({
  kind: item.toolKind ?? 'other',
  options: item.options,
})

/**
 * Auto was just switched on: the turn's cards still waiting (`waiting`) that Auto would have
 * answered, with the answer, so the user isn't left with one more click. Questions and plan
 * approvals keep waiting.
 */
export function autoAnswersFor(items: TurnItem[], waiting: (item: PermissionItem) => boolean) {
  return items.flatMap((item) => {
    if (item.kind !== 'permission' || !waiting(item)) return []
    const optionId = autoOption(cardAsked(item))
    return optionId === null ? [] : [{ itemId: item.id, optionId }]
  })
}

/** Hand-answered requests in a turn before the card offers Auto (it shows on the next one). */
export const ASKS_BEFORE_AUTO_HINT = 2

/**
 * Whether the card `id` offers to turn Auto on: it's a request Auto would answer, and the
 * turn already had `ASKS_BEFORE_AUTO_HINT` like it before it. Every card in a turn is one
 * the user answers by hand (what Gui answers itself never gets one); questions and plan
 * approvals don't count, as Auto wouldn't answer them either.
 */
export function offersAuto(items: TurnItem[], id: string) {
  let before = 0
  for (const item of items) {
    if (item.kind !== 'permission' || autoOption(cardAsked(item)) === null) continue
    if (item.id === id) return before >= ASKS_BEFORE_AUTO_HINT
    before++
  }
  return false
}
