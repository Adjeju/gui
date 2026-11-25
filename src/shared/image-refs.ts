/**
 * How a sent message names its Nth image: the composer writes each image piece this way,
 * numbered in the order the message names them, and main labels the images to match.
 */
export const imageRef = (n: number) => `[Image ${n}]`

/**
 * The message without its labels for images 1 to `count`, for an agent that can't see them.
 * Only the space around a label goes with it: the rest of the message, indentation
 * included, stays as written.
 */
export function withoutImageRefs(text: string, count: number) {
  if (count < 1) return text
  return text
    .replace(
      /([ \t]*)\[Image (\d+)\]([ \t]*)/g,
      (ref, before: string, digits: string, after: string, at: number) => {
        if (Number(digits) < 1 || Number(digits) > count) return ref
        const startsLine = at === 0 || text[at - 1] === '\n'
        return before && after && !startsLine ? ' ' : ''
      },
    )
    .trim()
}

/**
 * How a sent message names its Nth pick (an element or area picked in the preview): the
 * composer writes each marker this way, numbered in the order the message names them, and
 * main lists the picks in that order under the same labels (`buildPrompt`).
 */
export const pickRef = (n: number) => `[Selection ${n}]`

const REFS = /\[(Image|Selection) (\d+)\]/g

/** A label in a sent message: the Nth image or pick. */
export interface MessageRef {
  kind: 'image' | 'pick'
  n: number
}

/** A sent message as text and labels, to show each label as what it names. */
export function messageRefParts(text: string): (string | MessageRef)[] {
  const parts: (string | MessageRef)[] = []
  let cursor = 0
  for (const match of text.matchAll(REFS)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push({ kind: match[1] === 'Image' ? 'image' : 'pick', n: Number(match[2]) })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
