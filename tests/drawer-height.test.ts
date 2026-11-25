import { describe, expect, test } from 'bun:test'
import { DRAWER_CANVAS_MIN, DRAWER_HEIGHT, drawerHeight } from '../src/shared/layout'

describe('drawerHeight', () => {
  const room = 800

  test('draws the remembered height when it fits', () => {
    expect(drawerHeight(DRAWER_HEIGHT.default, room)).toBe(DRAWER_HEIGHT.default)
    expect(drawerHeight(400, room)).toBe(400)
  })

  test('never goes under the minimum', () => {
    expect(drawerHeight(40, room)).toBe(DRAWER_HEIGHT.min)
    expect(drawerHeight(0, room)).toBe(DRAWER_HEIGHT.min)
  })

  test('leaves the canvas its strip', () => {
    expect(drawerHeight(5000, room)).toBe(room - DRAWER_CANVAS_MIN)
    expect(drawerHeight(room, room)).toBe(room - DRAWER_CANVAS_MIN)
  })

  test('a window shorter than the remembered height draws less, and taller again draws it all', () => {
    const remembered = 500
    expect(drawerHeight(remembered, 400)).toBe(400 - DRAWER_CANVAS_MIN)
    // The remembered height is the caller's; it comes back once there's room.
    expect(drawerHeight(remembered, 900)).toBe(remembered)
  })

  test('too short for both minimums, the drawer keeps its own', () => {
    expect(drawerHeight(300, DRAWER_CANVAS_MIN + 50)).toBe(DRAWER_HEIGHT.min)
    expect(drawerHeight(300, 0)).toBe(DRAWER_HEIGHT.min)
  })

  test('whole pixels', () => {
    expect(drawerHeight(250.6, room)).toBe(251)
    expect(drawerHeight(5000, 700.9)).toBe(700 - DRAWER_CANVAS_MIN)
  })
})
