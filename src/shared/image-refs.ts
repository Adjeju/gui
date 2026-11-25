const REF = /\[Image (\d+)\]/g

/**
 * How a sent message names its Nth image: the composer writes each image piece this way,
 * numbered in the order the message names them, and main labels the images to match.
 */
export const imageRef = (n: number) => `[Image ${n}]`

/** The message without its labels for images 1 to `count`, for an agent that can't see them. */
export function withoutImageRefs(text: string, count: number) {
  return text
    .replace(/[ \t]*\[Image (\d+)\]/g, (ref, digits: string) =>
      Number(digits) >= 1 && Number(digits) <= count ? '' : ref,
    )
    .replace(/^[ \t]+/gm, '')
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
