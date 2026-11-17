import { GhosttyTerminal } from 'ghostty-web'

/** The parts of Ghostty's terminal its write uses, private in its types. */
interface WasmTerminal {
  exports: {
    ghostty_wasm_alloc_u8_array(length: number): number
    ghostty_wasm_free_u8_array(at: number, length: number): void
    ghostty_terminal_write(handle: number, at: number, length: number): void
  }
  memory: WebAssembly.Memory
  handle: number
}

const encoder = new TextEncoder()

/**
 * Ghostty 0.4's own write, with two holes closed.
 *
 * Nothing to write is skipped. Its allocator hands back -1 for zero bytes, and copying to -1
 * throws "offset is out of bounds" (coder/ghostty-web#199): every terminal and dev server
 * that hadn't printed yet when its view opened has an empty snapshot.
 *
 * A pointer that isn't in its memory throws before anything is copied: 0 when it couldn't
 * allocate (copied there, the chunk would overwrite Ghostty's own data), and negative once its
 * memory is past 2 GB. Whatever throws says, on the last line of its stack, how big Ghostty's
 * memory was, the chunk, and the pointer: what a crash report needs to say why.
 */
function write(this: WasmTerminal, data: string | Uint8Array) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data
  if (bytes.length === 0) return
  const { exports, memory } = this
  let at: number | null = null
  try {
    at = exports.ghostty_wasm_alloc_u8_array(bytes.length)
    if (at <= 0 || at + bytes.length > memory.buffer.byteLength) {
      throw new RangeError('offset is out of bounds')
    }
    new Uint8Array(memory.buffer).set(bytes, at)
    exports.ghostty_terminal_write(this.handle, at, bytes.length)
    exports.ghostty_wasm_free_u8_array(at, bytes.length)
  } catch (error) {
    throw withDiagnostics(error, memory.buffer.byteLength, bytes.length, at)
  }
}

/**
 * The stack gets the line, not the message: reports are counted by message, and main sends
 * the same failure once a session by its message and first frame.
 */
function withDiagnostics(error: unknown, memory: number, length: number, at: number | null) {
  const failure = error instanceof Error ? error : new Error(String(error))
  const line = `ghostty: wasm memory ${memory} bytes, chunk ${length} bytes, pointer ${at ?? 'none'}`
  failure.stack = `${failure.stack ?? `${failure.name}: ${failure.message}`}\n    ${line}`
  return failure
}

/**
 * Every Ghostty terminal writes through `write`. On the class, so the terminal Ghostty makes
 * again on `reset()` does too.
 */
export function guardGhosttyWrites() {
  ;(GhosttyTerminal.prototype as unknown as { write: typeof write }).write = write
}
