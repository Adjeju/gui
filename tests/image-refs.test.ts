import { expect, test } from 'bun:test'
import { messageRefParts, pickRef, withoutImageRefs } from '../src/shared/image-refs'

test('a message splits into text and labels for images and picks', () => {
  expect(messageRefParts('Is [Image 1] darker than [Image 2]?')).toEqual([
    'Is ',
    { kind: 'image', n: 1 },
    ' darker than ',
    { kind: 'image', n: 2 },
    '?',
  ])
  expect(messageRefParts('[Image 3]')).toEqual([{ kind: 'image', n: 3 }])
  expect(messageRefParts('No images')).toEqual(['No images'])
  expect(messageRefParts(`Make ${pickRef(1)} match ${pickRef(2)}`)).toEqual([
    'Make ',
    { kind: 'pick', n: 1 },
    ' match ',
    { kind: 'pick', n: 2 },
  ])
})

test('without images, pick labels stay', () => {
  expect(withoutImageRefs('Put [Image 1] in [Selection 1]', 1)).toBe('Put in [Selection 1]')
})

test('without images, a message loses only the labels of the images it had', () => {
  expect(withoutImageRefs('Compare [Image 1] with [Image 2]', 2)).toBe('Compare with')
  expect(withoutImageRefs('[Image 1] looks off', 1)).toBe('looks off')
  expect(withoutImageRefs('See [Image 3]', 2)).toBe('See [Image 3]')
  expect(withoutImageRefs('Is [Image 2] darker than [Image 1]?', 2)).toBe('Is darker than?')
})

test('without images, the rest of the message keeps its indentation', () => {
  const code = 'Fix this:\n  if (x) {\n    return 1\n  }'
  expect(withoutImageRefs(code, 0)).toBe(code)
  expect(withoutImageRefs(`[Image 1] ${code}`, 1)).toBe(code)
})
