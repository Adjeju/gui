import { expect, test } from 'bun:test'
import { imageRefParts, withoutImageRefs } from '../src/shared/image-refs'

test('a message splits into text and image numbers', () => {
  expect(imageRefParts('Is [Image 1] darker than [Image 2]?')).toEqual([
    'Is ',
    1,
    ' darker than ',
    2,
    '?',
  ])
  expect(imageRefParts('[Image 3]')).toEqual([3])
  expect(imageRefParts('No images')).toEqual(['No images'])
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
