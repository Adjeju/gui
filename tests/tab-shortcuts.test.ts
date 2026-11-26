import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { IS_MAC } from '../src/shared/platform'
import {
  acceleratorKeys,
  allShortcuts,
  isAppKeyInTerminal,
  type KeyPress,
  placeIndex,
  placeKeys,
  SHORTCUTS,
  shortcutText,
  VIEWPORT_SHORTCUTS,
} from '../src/shared/shortcuts'
import { VIEWPORTS } from '../src/shared/types'

function press(key: string, modifiers: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }
}

describe('⌘1 to ⌘9 show a tab by its place', () => {
  test('⌘1 to ⌘8 are places 1 to 8, and ⌘9 the last', () => {
    expect(placeKeys('showTab')).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((place) => ({ accelerator: `CmdOrCtrl+${place}`, place })),
      { accelerator: 'CmdOrCtrl+9', place: 'last' },
    ])
    // Any other shortcut has no places.
    expect(placeKeys('nextTab')).toEqual([])
  })

  test('a place picks its tab, and nothing past the last one', () => {
    expect(placeIndex(1, 3)).toBe(0)
    expect(placeIndex(3, 3)).toBe(2)
    expect(placeIndex(4, 3)).toBeNull()
    expect(placeIndex(8, 3)).toBeNull()
    expect(placeIndex(8, 8)).toBe(7)
    expect(placeIndex(1, 1)).toBe(0)
  })

  test('⌘9 picks the last tab, however many there are', () => {
    expect(placeIndex('last', 1)).toBe(0)
    expect(placeIndex('last', 3)).toBe(2)
    expect(placeIndex('last', 12)).toBe(11)
    expect(placeIndex('last', 0)).toBeNull()
  })

  test('no other shortcut is on ⌘1 to ⌘9', () => {
    const tabKeys = placeKeys('showTab').map((key) => key.accelerator)
    const others = allShortcuts()
      .filter((shortcut) => shortcut.id !== 'showTab')
      .flatMap((shortcut) => [shortcut.accelerator, ...(shortcut.alternates ?? [])])
    expect(others.filter((keys) => tabKeys.includes(keys))).toEqual([])
  })
})

describe('device sizes on ⌃1 to ⌃4 (Alt+1 to Alt+4 on Linux)', () => {
  test('in VIEWPORTS order, one modifier', () => {
    const modifier = IS_MAC ? 'Ctrl' : 'Alt'
    expect(VIEWPORTS.map(({ id }) => SHORTCUTS[VIEWPORT_SHORTCUTS[id]].accelerator)).toEqual([
      `${modifier}+1`,
      `${modifier}+2`,
      `${modifier}+3`,
      `${modifier}+4`,
    ])
  })

  test('menus and the sheet show ⌃1, or Alt+1', () => {
    expect(acceleratorKeys(SHORTCUTS.viewportDesktop.accelerator)).toEqual(
      IS_MAC ? ['⌃', '1'] : ['Alt', '1'],
    )
    expect(shortcutText('viewportMobile')).toBe(IS_MAC ? '⌃4' : 'Alt+4')
  })

  test('no other shortcut is on their keys', () => {
    const viewportIds: string[] = Object.values(VIEWPORT_SHORTCUTS)
    const viewportKeys = viewportIds.map(
      (id) => SHORTCUTS[id as keyof typeof SHORTCUTS].accelerator,
    )
    const others = allShortcuts()
      .filter((shortcut) => !viewportIds.includes(shortcut.id))
      .flatMap((shortcut) => [shortcut.accelerator, ...(shortcut.alternates ?? [])])
    expect(others.filter((keys) => viewportKeys.includes(keys))).toEqual([])
  })
})

/**
 * `isAppKeyInTerminal` for each key, on the platform given: shortcuts.ts reads the platform as
 * it loads, so another platform's answers come from a fresh Bun that thinks it's on that one.
 */
function appKeysInTerminal(platform: 'darwin' | 'linux', keys: KeyPress[]): boolean[] {
  const script = `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })
    const { isAppKeyInTerminal } = await import(${JSON.stringify(join(import.meta.dirname, '..', 'src', 'shared', 'shortcuts.ts'))})
    console.log(JSON.stringify(${JSON.stringify(keys)}.map(isAppKeyInTerminal)))
  `
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }))
}

const DIGITS = '1234567890'
const each = (modifiers: Partial<KeyPress>) => [...DIGITS].map((digit) => press(digit, modifiers))
// true for 1 to 9 and not 0, as ⌘1 to ⌘9; true for 1 to 4 only, as ⌃1 to ⌃4.
const TABS = [...DIGITS].map((digit) => digit !== '0')
const DEVICES = [...DIGITS].map((digit) => '1234'.includes(digit))
const NONE = [...DIGITS].map(() => false)

describe('a terminal leaves the tab keys, and on a Mac the device keys, to the menu', () => {
  test('on a Mac, ⌘1 to ⌘9 and ⌃1 to ⌃4 are the app’s', () => {
    const keys = [each({ metaKey: true }), each({ ctrlKey: true }), each({ altKey: true })]
    const answers = appKeysInTerminal('darwin', keys.flat())
    expect(answers).toEqual([...TABS, ...DEVICES, ...NONE])
  })

  test('on Linux, Ctrl+1 to Ctrl+9 are the app’s and Alt+1 to Alt+4 the shell’s', () => {
    const keys = [each({ ctrlKey: true }), each({ altKey: true }), each({ metaKey: true })]
    const answers = appKeysInTerminal('linux', keys.flat())
    expect(answers).toEqual([...TABS, ...NONE, ...NONE])
  })

  test('other digits and modifiers are the shell’s', () => {
    const command = IS_MAC ? { metaKey: true } : { ctrlKey: true }
    const device = IS_MAC ? { ctrlKey: true } : { altKey: true }
    expect(isAppKeyInTerminal(press('1'))).toBe(false)
    expect(isAppKeyInTerminal(press('0', command))).toBe(false)
    expect(isAppKeyInTerminal(press('5', device))).toBe(false)
    expect(isAppKeyInTerminal(press('1', { ...command, shiftKey: true }))).toBe(false)
    expect(isAppKeyInTerminal(press('1', { ...device, shiftKey: true }))).toBe(false)
  })
})
