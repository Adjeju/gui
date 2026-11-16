/** Spaces, dashes, dots, slashes and the like: model names and ids spell them differently. */
const SEPARATORS = /[\s\-_./:]+/g

const compact = (text: string) => text.replace(SEPARATORS, '')

/** The typed words, in lower case. */
export function searchWords(query: string) {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Every typed word appears in one of `fields`, ignoring case, and ignoring separators so
 * "glm5.3" finds "zai/glm-5.3" and "kimik3" finds "Kimi K3".
 */
export function matchesWords(fields: string[], words: string[]) {
  if (words.length === 0) return true
  const texts = fields.map((field) => field.toLowerCase())
  const compacted = texts.map(compact)
  return words.every((word) => {
    if (texts.some((text) => text.includes(word))) return true
    const bare = compact(word)
    return bare === '' || compacted.some((text) => text.includes(bare))
  })
}
