import { findExecutable } from './executables'
import { spawnProcess } from './process'

export interface TerminalApp {
  command: string
  args: (file: string) => string[]
}

export const LINUX_TERMINALS: readonly TerminalApp[] = [
  { command: 'x-terminal-emulator', args: (file) => ['-e', file] },
  { command: 'gnome-terminal', args: (file) => ['--', file] },
  { command: 'ptyxis', args: (file) => ['--', file] },
  { command: 'konsole', args: (file) => ['-e', file] },
  { command: 'xfce4-terminal', args: (file) => ['-x', file] },
  { command: 'kitty', args: (file) => [file] },
  { command: 'alacritty', args: (file) => ['-e', file] },
  { command: 'wezterm', args: (file) => ['start', '--', file] },
  { command: 'foot', args: (file) => [file] },
  { command: 'xterm', args: (file) => ['-e', file] },
]

const EARLY_EXIT_MS = 1000

function started(path: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawnProcess(path, args, { env, detached: true, stdio: 'ignore' })
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const settle = (ok: boolean) => {
      clearTimeout(timer)
      child.removeAllListeners('exit')
      if (ok) child.unref()
      resolve(ok)
    }
    child.once('error', () => settle(false))
    child.once('spawn', () => {
      timer = setTimeout(() => settle(true), EARLY_EXIT_MS)
      child.once('exit', (code) => settle(code === 0))
    })
  })
}

export async function launchTerminal(
  file: string,
  env: NodeJS.ProcessEnv,
  terminals: readonly TerminalApp[] = LINUX_TERMINALS,
): Promise<string> {
  const failed: string[] = []
  for (const terminal of terminals) {
    const path = await findExecutable(terminal.command, env.PATH)
    if (!path) continue
    if (await started(path, terminal.args(file), env)) return terminal.command
    failed.push(terminal.command)
  }
  throw new Error(
    failed.length > 0
      ? `Couldn't open a terminal: ${failed.join(', ')} failed to start.`
      : "Couldn't find a terminal app.",
  )
}
