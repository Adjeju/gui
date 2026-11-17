import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Ghostty } from 'ghostty-web'
import { drawOutput } from '../src/renderer/src/app/terminal-output'
import type { OutputChunk } from '../src/shared/ipc'

/** Main's side of one view: its snapshot, what it sends, and what the view acknowledged. */
function fakeMain(snapshot: OutputChunk) {
  let send: ((chunk: OutputChunk) => void) | null = null
  const acks: number[] = []
  return {
    acks,
    send: (chunk: OutputChunk) => send?.(chunk),
    source: {
      snapshot: async () => snapshot,
      subscribe: (cb: (chunk: OutputChunk) => void) => {
        send = cb
        return () => {
          send = null
        }
      },
      ack: (_id: string, end: number) => acks.push(end),
    },
  }
}

/** A terminal that draws, until told to throw as Ghostty does once its memory is past 2 GB. */
function fakeTerminal() {
  const terminal = {
    written: [] as string[],
    throws: false,
    outgrown: false,
    write(data: string) {
      if (terminal.throws) throw new RangeError('offset is out of bounds')
      terminal.written.push(data)
    },
  }
  return { terminal, target: { write: terminal.write, outgrown: () => terminal.outgrown } }
}

const chunk = (data: string, end: number): OutputChunk => ({ id: 'term-1', data, end })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let reports: unknown[]
beforeEach(() => {
  reports = []
  ;(globalThis as { window?: unknown }).window = {
    gui: { reportError: (report: unknown) => reports.push(report) },
  }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('drawing a terminal’s output', () => {
  test('a write that throws is still acknowledged, reported once, and the view is made again from main’s snapshot', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    const remounts: boolean[] = []
    drawOutput(target, main.source, (fromSnapshot) => remounts.push(fromSnapshot))
    await settle()
    expect(main.acks).toEqual([2])

    terminal.throws = true
    main.send(chunk('ls\r\n', 6))
    // Main isn't left holding the shell for a view that can't draw.
    expect(main.acks).toEqual([2, 6])
    expect(remounts).toEqual([true])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ message: 'offset is out of bounds' })

    // Until it's made again, what comes is acknowledged, not drawn, and not asked for again.
    main.send(chunk('a\r\n', 9))
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toEqual([true])
    expect(reports).toHaveLength(1)
  })

  test('a terminal that can’t draw main’s snapshot is made again after it', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    terminal.throws = true
    const remounts: boolean[] = []
    drawOutput(target, main.source, (fromSnapshot) => remounts.push(fromSnapshot))
    await settle()
    main.send(chunk('ls\r\n', 6))
    main.send(chunk('a\r\n', 9))
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toEqual([false])
    expect(reports).toHaveLength(1)
  })

  test('made after main’s snapshot, a terminal draws only what comes after it', async () => {
    const main = fakeMain(chunk('$ ls\r\n', 7))
    const { terminal, target } = fakeTerminal()
    drawOutput(target, main.source, () => {}, { fromSnapshot: false })
    // Sent before the snapshot came, and in it.
    main.send(chunk('ls\r\n', 7))
    await settle()
    main.send(chunk('a\r\n', 10))
    expect(terminal.written).toEqual(['', 'a\r\n'])
    expect(main.acks).toEqual([7, 10])
  })

  test('a fresh terminal whose first output fails is made again after it', async () => {
    // A terminal that hadn't printed yet: main's snapshot is empty.
    const main = fakeMain(chunk('', 0))
    const { terminal, target } = fakeTerminal()
    const remounts: boolean[] = []
    drawOutput(target, main.source, (fromSnapshot) => remounts.push(fromSnapshot))
    await settle()
    terminal.throws = true
    main.send(chunk('ls\r\n', 4))
    expect(remounts).toEqual([false])
  })

  test('a terminal past its memory is made again once, from main’s snapshot', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    const remounts: boolean[] = []
    drawOutput(target, main.source, (fromSnapshot) => remounts.push(fromSnapshot))
    await settle()
    terminal.outgrown = true
    main.send(chunk('ls\r\n', 6))
    main.send(chunk('a\r\n', 9))
    expect(terminal.written).toEqual(['$ ', 'ls\r\n'])
    expect(main.acks).toEqual([2, 6, 9])
    expect(remounts).toEqual([true])
    expect(reports).toHaveLength(0)
  })

  test('a terminal whose snapshot alone is past its memory isn’t made again in a loop', async () => {
    const main = fakeMain(chunk('$ ', 2))
    const { terminal, target } = fakeTerminal()
    terminal.outgrown = true
    const remounts: boolean[] = []
    drawOutput(target, main.source, (fromSnapshot) => remounts.push(fromSnapshot))
    await settle()
    expect(remounts).toEqual([])
  })

  test('output Ghostty can’t draw costs only itself: the view goes on drawing what follows', async () => {
    // Like Ghostty 0.4: a write with what it can't take fails, and so does every one after it.
    const main = fakeMain(chunk('$ ', 2))
    let output = '$ '
    const send = (data: string) => {
      output += data
      main.send(chunk(data, output.length))
    }
    main.source.snapshot = async () => chunk(output, output.length)
    const views: ReturnType<typeof fakeTerminal>['terminal'][] = []
    const mount = (fromSnapshot: boolean) => {
      const { terminal, target } = fakeTerminal()
      views.push(terminal)
      const write = target.write
      target.write = (data: string) => {
        if (data.includes('POISON')) terminal.throws = true
        write(data)
      }
      drawOutput(target, main.source, (again) => void settle().then(() => mount(again)), {
        fromSnapshot,
      })
    }
    mount(true)
    await settle()
    send('ok\r\n')
    send('POISON\r\n')
    // Made again from main's snapshot, which holds it; made again after that.
    for (let i = 0; i < 10; i++) await settle()
    send('after\r\n')
    expect(views).toHaveLength(3)
    expect(views[2].written).toEqual(['', 'after\r\n'])
    expect(reports).toHaveLength(2)
    expect(main.acks.at(-1)).toBe(output.length)
  })
})

// Why a terminal has a Ghostty of its own, made again past a size: Ghostty 0.4 leaks in its
// WebAssembly memory, which only grows. Once that passes 2 GB its pointers are negative in
// JavaScript and every write throws "offset is out of bounds". If this starts failing, an
// update fixed the leak.
describe('ghostty-web 0.4', () => {
  const wasm = `${import.meta.dirname}/../node_modules/ghostty-web/dist/ghostty-vt.wasm`
  const config = { scrollbackLimit: 5000, fgColor: 0, bgColor: 0, cursorColor: 0, palette: [] }

  async function growth(colors: number) {
    const ghostty = await Ghostty.load(wasm)
    const memory = (ghostty as unknown as { memory: WebAssembly.Memory }).memory
    const terminal = ghostty.createTerminal(80, 24, config)
    let text = ''
    for (let line = 0; line < 8000; line++) text += `\x1b[38;5;${line % colors}mx\x1b[0m\r\n`
    // Twice: the first fills the scrollback, which may grow the memory once.
    terminal.write(text)
    const filled = memory.buffer.byteLength
    terminal.write(text)
    terminal.free()
    return memory.buffer.byteLength - filled
  }

  test('leaks once a page of output has more than about a hundred colors', async () => {
    expect(await growth(16)).toBe(0)
    expect(await growth(200)).toBeGreaterThan(8 * 1024 * 1024)
  })
})
