/** Theme variables as the Theme panel sees them. Pure: no Electron, no React. */

export type ThemeKind = 'color' | 'size' | 'font' | 'other'

export type ThemeModeHow =
  | { kind: 'root' }
  | { kind: 'class'; name: string }
  | { kind: 'attribute'; name: string; value: string }
  | { kind: 'media' }

export interface ThemeMode {
  id: string
  label: string
  selector: string
  how: ThemeModeHow
}

/** One custom property declaration, raw from the page. */
export interface ThemeDeclaration {
  name: string
  value: string
  selector: string
  media: string | null
  sheet: string | null
}

export interface ThemeVariable {
  name: string
  kind: ThemeKind
  values: Record<string, string | null>
  resolved: Record<string, string>
  refersTo: string | null
  uses: number
  locked: string | null
}

export interface ThemeSnapshot {
  modes: ThemeMode[]
  variables: ThemeVariable[]
  appSetsMode: string[]
}

export interface ThemeEdit {
  name: string
  mode: string
  value: string
}

const ROOT = /^(?::root|html|:host)$/
const DARK_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i
const DARK_CLASS = /^(?::root|html)?\.dark$/
const THEME_ATTR =
  /^(?::root|html)?\[data-theme=(?:"([^"]{1,100})"|'([^']{1,100})'|([\w-]{1,100}))\]$/

export function modeOf(selector: string, media: string | null): ThemeMode | null {
  const parts = selector.split(',').map((part) => part.trim())
  const trimmed = selector.trim()
  const darkMedia = media !== null && DARK_MEDIA.test(media.trim())
  if (media !== null && !darkMedia) return null
  if (parts.some((part) => ROOT.test(part))) {
    return darkMedia
      ? { id: 'dark', label: 'Dark', selector: trimmed, how: { kind: 'media' } }
      : { id: 'default', label: 'Default', selector: trimmed, how: { kind: 'root' } }
  }
  if (darkMedia) return null
  if (parts.some((part) => DARK_CLASS.test(part))) {
    return { id: 'dark', label: 'Dark', selector: trimmed, how: { kind: 'class', name: 'dark' } }
  }
  for (const part of parts) {
    const match = THEME_ATTR.exec(part)
    const value = match && (match[1] ?? match[2] ?? match[3])
    if (value) {
      return {
        id: `theme:${value}`,
        label: value,
        selector: trimmed,
        how: { kind: 'attribute', name: 'data-theme', value },
      }
    }
  }
  return null
}

const COLOR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const BARE_HSL = /^\d*\.?\d+(?:deg)?[\s,]+\d*\.?\d+%[\s,]+\d*\.?\d+%$/
const SIZE = /^(?:0|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch))$/
const FONT_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
  'auto',
  'normal',
  'transparent',
  'currentcolor',
  'solid',
  'ease',
  'linear',
  'infinite',
  'block',
  'flex',
  'grid',
  'inline',
  'hidden',
  'visible',
])
const FONT_FIRST = /^(?:"[^"]+"|'[^']+'|[A-Za-z][A-Za-z_-]*(?: [A-Za-z][A-Za-z_-]*)*)$/
const GENERIC_FAMILY =
  /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong)$/i

export function variableKind(value: string, usedInHsl: boolean, name = ''): ThemeKind {
  const v = value.trim()
  if (HEX.test(v) || COLOR_FN.test(v) || (usedInHsl && BARE_HSL.test(v))) return 'color'
  if (SIZE.test(v)) return 'size'
  if (/^[1-9]00$/.test(v) && /weight/i.test(name)) return 'font'
  const items = v.split(',')
  const first = items[0]?.trim() ?? ''
  const quoted = /^["']/.test(first)
  const generic = items.some((item) => GENERIC_FAMILY.test(item.trim()))
  if (
    items.length > 1 &&
    FONT_FIRST.test(first) &&
    !FONT_KEYWORDS.has(first.toLowerCase()) &&
    (quoted || generic)
  ) {
    return 'font'
  }
  return 'other'
}

const REFERENCE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/

export function referenceOf(value: string): string | null {
  return REFERENCE.exec(value.trim())?.[1] ?? null
}

const SCALE_STEP = /^(.+)-(\d+)$/

/** Groups `--x-50 … --x-950` style names by prefix; a scale needs at least three steps. */
export function foldScales(names: string[]): { prefix: string; names: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const prefix = SCALE_STEP.exec(name)?.[1]
    if (prefix) groups.set(prefix, [...(groups.get(prefix) ?? []), name])
  }
  return [...groups]
    .filter(([, members]) => members.length >= 3)
    .map(([prefix, members]) => ({ prefix, names: members }))
}

const MAX_VALUE = 500

export function safeName(name: string): boolean {
  return /^--[A-Za-z0-9_-]{1,100}$/.test(name)
}

/** Every quote in `value` opens or closes a string. */
function quotesBalanced(value: string) {
  let open: string | null = null
  for (const ch of value) {
    if (open === null && (ch === '"' || ch === "'")) open = ch
    else if (ch === open) open = null
  }
  return open === null
}

/**
 * Page values are untrusted; refuse anything that could end a declaration, a style tag or a
 * comment, or run on past its own end (an open string, a backslash escaping what follows).
 */
export function safeValue(value: string): boolean {
  return (
    quotesBalanced(value) &&
    !value.includes('\\') &&
    value.length <= MAX_VALUE &&
    !/[;{}]/.test(value) &&
    ![...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) &&
    !value.includes('</') &&
    !value.includes('/*') &&
    !value.includes('*/')
  )
}
