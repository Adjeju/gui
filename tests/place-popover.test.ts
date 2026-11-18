import { afterAll, expect, test } from 'bun:test'

// The renderer's modules reach for `window.gui` as they load (icons ask for the system's
// symbols); a stand-in for this file only.
const realWindow = globalThis.window
globalThis.window = {
  innerHeight: 1000,
  gui: { getSymbols: () => Promise.resolve({}) },
} as unknown as Window & typeof globalThis
afterAll(() => {
  globalThis.window = realWindow
})
const { placePopover } = await import('../src/renderer/src/lib/surface')

/** A stand-in element: just a box, its parent, and the lookups placePopover makes. */
interface Box {
  rect: { left: number; top: number; width: number; height: number }
  attr?: string
  parent?: Box
  children: Box[]
}

function box(rect: Box['rect'], parent?: Box, attr?: string): Box {
  const made: Box = { rect, parent, attr, children: [] }
  parent?.children.push(made)
  return made
}

function element(b: Box): HTMLElement {
  const { left, top, width, height } = b.rect
  return {
    getBoundingClientRect: () =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect,
    closest(selector: string) {
      const name = selector.slice(1, -1)
      for (let at: Box | undefined = b; at; at = at.parent) if (at.attr === name) return element(at)
      return null
    },
    get children() {
      return b.children.map(element)
    },
    contains(other: HTMLElement) {
      return (
        other.getBoundingClientRect().top >= top && other.getBoundingClientRect().top < top + height
      )
    },
  } as unknown as HTMLElement
}

/**
 * A chat panel with the composer's frame at its bottom: the message box, maybe the tool notice,
 * then the row with the model button.
 */
function composer(panelHeight: number, notice: number) {
  const panel = box(
    { left: 0, top: 0, width: 320, height: panelHeight },
    undefined,
    'data-chat-panel',
  )
  const frameHeight = 72 + notice
  const frameTop = panelHeight - 9 - frameHeight
  const frame = box(
    { left: 9, top: frameTop, width: 302, height: frameHeight },
    panel,
    'data-popover-anchor',
  )
  box({ left: 9, top: frameTop, width: 302, height: 36 + notice }, frame)
  const row = box({ left: 9, top: frameTop + 36 + notice, width: 302, height: 36 }, frame)
  const button = box({ left: 200, top: row.rect.top + 4, width: 80, height: 28 }, row)
  return { frame, row, button: element(button) }
}

test('in a normal panel it opens off the frame, spanning it', () => {
  const { frame, button } = composer(720, 36)
  const placed = placePopover(button)
  expect(placed.left).toBe(frame.rect.left)
  expect(placed.width).toBe(frame.rect.width)
  expect(placed.bottom).toBe(1000 - frame.rect.top + 4)
  expect(placed.maxHeight).toBe(440)
  expect(placed.origin).toBe('231px 100%')
})

test('when the room above the frame is too short, it opens off the button row instead', () => {
  const { frame, row, button } = composer(360, 36)
  const placed = placePopover(button)
  expect(placed.left).toBe(frame.rect.left)
  expect(placed.width).toBe(frame.rect.width)
  expect(placed.bottom).toBe(1000 - row.rect.top + 4)
  // From the panel's top edge (8) to just above the row (4).
  expect(placed.maxHeight).toBe(row.rect.top - 4 - 8)
  expect(placed.origin).toBe('231px 100%')
})

test('with just enough room above the frame it still opens off the frame', () => {
  // 264 between the panel's edge and the frame, after the gaps.
  const { frame, button } = composer(264 + 12 + 9 + 72, 0)
  const placed = placePopover(button)
  expect(placed.bottom).toBe(1000 - frame.rect.top + 4)
  expect(placed.maxHeight).toBe(264)
})

test('outside a frame it opens against the button as before', () => {
  const panel = box({ left: 0, top: 0, width: 600, height: 300 }, undefined, 'data-chat-panel')
  const button = element(box({ left: 500, top: 20, width: 30, height: 30 }, panel))
  const placed = placePopover(button)
  expect(placed.top).toBe(54)
  expect(placed.bottom).toBeNull()
  expect(placed.width).toBe(336)
  expect(placed.left).toBe(530 - 336)
  expect(placed.maxHeight).toBe(300 - 8 - 50 - 4)
})
