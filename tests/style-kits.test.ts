import { expect, test } from 'bun:test'

import {
  isStyleKitId,
  KIT_TOKENS,
  kitBrand,
  kitCss,
  kitFrameHtml,
  kitStylesheetName,
  STYLE_KITS,
} from '../src/shared/style-kits'

test('every kit defines every token in light and dark', () => {
  for (const kit of STYLE_KITS) {
    for (const token of KIT_TOKENS) {
      expect(kit.light[token]).toBeTruthy()
      expect(kit.dark[token]).toBeTruthy()
    }
  }
})

test('kitCss has :root and .dark blocks with every token, and no url or @import', () => {
  const css = kitCss(STYLE_KITS[0])
  expect(css).toContain(':root {')
  expect(css).toContain('.dark {')
  for (const token of KIT_TOKENS) expect(css.split(`${token}:`).length - 1).toBe(2)
  expect(css).not.toMatch(/url\(|@import/)
})

test('kitBrand names the stylesheet and says to use variables', () => {
  const md = kitBrand(STYLE_KITS[1])
  expect(md).toContain('../assets/kit-editorial.css')
  expect(md).toContain('var(--primary)')
})

test('the sample frame links its kit stylesheet and uses variables, not raw colors', () => {
  for (const kit of STYLE_KITS) {
    const html = kitFrameHtml(kit)
    expect(html).toContain(`href="../assets/${kitStylesheetName(kit)}"`)
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i)
  }
})

test('generated files differ between kits', () => {
  expect(new Set(STYLE_KITS.map(kitCss)).size).toBe(STYLE_KITS.length)
})

test('isStyleKitId', () => {
  expect(isStyleKitId('mono')).toBe(true)
  expect(isStyleKitId('../x')).toBe(false)
})
