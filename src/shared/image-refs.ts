const REF = /\[Image (\d+)\]/g

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

/** A sent message as text and image numbers, to show each label as its image. */
export function imageRefParts(text: string): (string | number)[] {
  const parts: (string | number)[] = []
  let cursor = 0
  for (const match of text.matchAll(REF)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index))
    parts.push(Number(match[1]))
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}
