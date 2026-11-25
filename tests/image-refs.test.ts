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
})
