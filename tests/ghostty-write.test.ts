import { beforeAll, describe, expect, test } from 'bun:test'
import { Ghostty, GhosttyTerminal } from 'ghostty-web'
import { guardGhosttyWrites } from '../src/renderer/src/app/ghostty-write'

const wasm = `${import.meta.dirname}/../node_modules/ghostty-web/dist/ghostty-vt.wasm`
const config = { scrollbackLimit: 16 * 1024 * 1024, fgColor: 0, bgColor: 0, cursorColor: 0 }

interface Exports {
  ghostty_wasm_alloc_u8_array(length: number): number
}

/** A terminal in a Ghostty of its own, as each of the drawer's has. */
async function freshTerminal() {
  const ghostty = await Ghostty.load(wasm)
  const { exports, memory } = ghostty as unknown as { exports: Exports; memory: WebAssembly.Memory }
  return { terminal: ghostty.createTerminal(120, 24, config), exports, memory }
}

/** Lines of grapheme clusters in many colors: past about 500 at 120 columns, Ghostty 0.4 traps. */
function graphemesInColor(lines: number) {
  let text = ''
  for (let i = 0; i < lines; i++) text += `\x1b[38;2;${i & 255};${i >> 8};0m👩‍👩‍👧‍👦 x\x1b[0m\r\n`
  return text
}

// Ghostty as published, before the guard. If one of these starts failing, an update fixed it.
describe('ghostty-web 0.4, as published', () => {
  test('hands back -1 for zero bytes, which Uint8Array.set rejects as V8’s "offset is out of bounds"', async () => {
    const { exports, memory } = await freshTerminal()
    const at = exports.ghostty_wasm_alloc_u8_array(0)
    expect(at).toBe(-1)
    // Bun words it differently from Chromium: "Offset should not be negative".
    expect(() => new Uint8Array(memory.buffer).set(new Uint8Array(0), at)).toThrow(RangeError)
  })

  test('hands back 0 for what it can’t allocate', async () => {
    const { exports } = await freshTerminal()
    expect(exports.ghostty_wasm_alloc_u8_array(2 ** 31)).toBe(0)
  })
})

describe('a guarded Ghostty write', () => {
  beforeAll(guardGhosttyWrites)

  test('nothing to write is skipped, and the terminal goes on', async () => {
    const { terminal } = await freshTerminal()
    terminal.write('ab')
    terminal.write('')
    terminal.write(new Uint8Array(0))
    terminal.write('c')
    expect(terminal.getCursor().x).toBe(3)
  })

  test('a pointer outside its memory throws before anything is copied, saying why', () => {
    const memory = new WebAssembly.Memory({ initial: 1 })
    const copied: number[] = []
    for (const pointer of [0, -2_147_418_112, 65_535]) {
      const fake = {
        memory,
        handle: 1,
        exports: {
          ghostty_wasm_alloc_u8_array: () => pointer,
          ghostty_wasm_free_u8_array: () => {},
          ghostty_terminal_write: (_handle: number, at: number) => copied.push(at),
        },
      }
      let thrown: unknown
      try {
        GhosttyTerminal.prototype.write.call(fake, 'abc')
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RangeError)
      expect((thrown as Error).message).toBe('offset is out of bounds')
      expect((thrown as Error).stack?.split('\n').at(-1)).toBe(
        `    ghostty: wasm memory 65536 bytes, chunk 3 bytes, pointer ${pointer}`,
      )
    }
    // Copied to 0, it would have overwritten Ghostty's own data.
    expect(new Uint8Array(memory.buffer, 0, 3)).toEqual(new Uint8Array(3))
    expect(copied).toEqual([])
  })

  test('a write Ghostty itself fails on says how big it was, and every write after fails too', async () => {
    const { terminal } = await freshTerminal()
    let thrown: Error | null = null
    try {
      terminal.write(graphemesInColor(1000))
    } catch (error) {
      thrown = error as Error
    }
    // "memory access out of bounds" in Chromium.
    expect(thrown).toBeInstanceOf(WebAssembly.RuntimeError)
    expect(thrown?.stack?.split('\n').at(-1)).toMatch(
      /^ {4}ghostty: wasm memory \d+ bytes, chunk \d+ bytes, pointer [1-9]\d*$/,
    )
    // Why a terminal that threw is always made again.
    expect(() => terminal.write('plain\r\n')).toThrow()
    // And why the next one starts after main's snapshot when it holds what failed.
    const next = await freshTerminal()
    expect(() => next.terminal.write(graphemesInColor(1000))).toThrow()
    const after = await freshTerminal()
    after.terminal.write('plain\r\n')
  })
})
