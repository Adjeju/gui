import { isRegion, type Picked, type SourceLocation } from '../../../shared/types'

function sourceLabel(source: SourceLocation | null) {
  if (!source) return null
  return `${source.file.split('/').at(-1)}:${source.line}${source.approximate ? ' (approx.)' : ''}`
}

/**
 * How a pick is named in the chat. An element: what it is (`name`: its tag, h1 or button),
 * its text (`detail`), and quieter, its component and source location (`where`). An area:
 * its size, and what it's in. `title` is the full path, for a tooltip.
 */
export function pickLabel(picked: Picked) {
  if (isRegion(picked)) {
    const { rect, container } = picked
    const size = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
    const source = sourceLabel(container?.source ?? null)
    return {
      name: 'Area',
      detail: size,
      where: container ? `in ${container.tag}${source ? ` · ${source}` : ''}` : null,
      title: container?.source?.file ?? container?.selector,
    }
  }
  const where = [picked.componentStack[0], sourceLabel(picked.source)].filter(Boolean).join(' · ')
  return {
    name: picked.tag,
    detail: picked.text ? `“${picked.text.slice(0, 60)}”` : null,
    where: where || null,
    title: picked.source?.file ?? picked.selector,
  }
}

/** What an element is called to whoever looks at it, by its tag; others go by their tag. */
const ELEMENT_NAMES: Record<string, string> = {
  a: 'Link',
  button: 'Button',
  footer: 'Footer',
  form: 'Form',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  header: 'Header',
  img: 'Image',
  input: 'Field',
  label: 'Label',
  li: 'List item',
  nav: 'Navigation',
  ol: 'List',
  p: 'Text',
  section: 'Section',
  select: 'Menu',
  svg: 'Icon',
  table: 'Table',
  textarea: 'Field',
  ul: 'List',
  video: 'Video',
}

/** A pick's short name, for its marker: "Heading", "Button", "Area". */
export function pickName(picked: Picked) {
  if (isRegion(picked)) return 'Area'
  const tag = picked.tag.toLowerCase()
  return ELEMENT_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1)
}
