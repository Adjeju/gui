import { formatColor, parseColor, toHex } from '../../../shared/theme-color'
import { Input } from '../lib/field'

/** Arrow keys nudge a size's number by this (Shift: ten times), in its own unit. */
const NUDGE: Record<string, number> = { rem: 0.125, em: 0.125 }
const SIZE = /^(-?\d*\.?\d+)([a-z%]*)$/

/**
 * A value as text, sent on Enter or when the field is left. Sizes nudge with the arrow keys.
 * Uncontrolled, keyed by its value: a new value from main starts it over.
 */
export function TextField({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  const commit = (text: string) => {
    if (text.trim() && text !== value) onChange(text.trim())
  }
  return (
    <Input
      key={value}
      mono
      aria-label={label}
      spellCheck={false}
      defaultValue={value}
      onBlur={(event) => commit(event.currentTarget.value)}
      onKeyDown={(event) => {
        const input = event.currentTarget
        if (event.key === 'Enter') return commit(input.value)
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        const size = SIZE.exec(input.value.trim())
        if (!size) return
        event.preventDefault()
        const step = (NUDGE[size[2]] ?? 1) * (event.shiftKey ? 10 : 1)
        const next = Number(size[1]) + (event.key === 'ArrowUp' ? step : -step)
        onChange(`${Number(next.toFixed(3))}${size[2]}`)
      }}
    />
  )
}

/**
 * A color: the platform's picker beside its text. The picker only speaks #rrggbb, so its
 * choice is written back in the value's own format, with the value's alpha. A value that isn't
 * one Gui parses (a named color, color-mix(), calc()) is edited as text only.
 */
export function ColorField({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (value: string) => void
}) {
  const parsed = parseColor(value)
  return (
    <div className="flex items-center gap-2">
      {parsed && (
        <input
          type="color"
          aria-label={`${label} color`}
          value={toHex(parsed.rgba)}
          onChange={(event) => {
            const picked = parseColor(event.currentTarget.value)
            if (picked) onChange(formatColor({ ...picked.rgba, a: parsed.rgba.a }, parsed.format))
          }}
          className="h-7 w-9 shrink-0 cursor-pointer rounded-md border border-edge bg-raised p-0.5"
        />
      )}
      <TextField value={value} label={label} onChange={onChange} />
    </div>
  )
}
