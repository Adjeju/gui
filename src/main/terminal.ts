import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { IS_MAC } from '../shared/platform'
import { findExecutable } from './executables'
import { DEFAULT_SHELL } from './os'
import { spawnProcess } from './process'
import { getShellEnv } from './shell-env'

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

const LINUX_TERMINALS: readonly { command: string; args: (file: string) => string[] }[] = [
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

export async function runInTerminal(command: string, intro: string) {
  const dir = join(app.getPath('userData'), 'terminal')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, IS_MAC ? 'sign-in.command' : 'sign-in.sh')
  const script = IS_MAC
    ? [
        '#!/bin/sh',
        'clear',
        `printf '%s\\n\\n' ${quote(intro)}`,
        `exec "\${SHELL:-${DEFAULT_SHELL}}" -lic ${quote(`${command}; echo; echo "All done. You can close this window and go back to Gui."`)}`,
        '',
      ]
    : [
        '#!/bin/sh',
        'clear',
        `printf '%s\\n\\n' ${quote(intro)}`,
        `"\${SHELL:-${DEFAULT_SHELL}}" -lic ${quote(command)}`,
        'echo',
        'printf "All done. Press Enter to close this window and go back to Gui."',
        'read -r _',
        '',
      ]
  await writeFile(file, script.join('\n'), { mode: 0o700 })
  if (IS_MAC) {
    const error = await shell.openPath(file)
    if (error) throw new Error(`Couldn't open Terminal: ${error}`)
    return
  }
  const env = await getShellEnv()
  for (const terminal of LINUX_TERMINALS) {
    const path = await findExecutable(terminal.command, env.PATH)
    if (!path) continue
    const child = spawnProcess(path, terminal.args(file), {
      env,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', (error) => console.error('[gui] terminal failed to start', error))
    child.unref()
    return
  }
  throw new Error(`Couldn't find a terminal app. Run \`${command}\` in a terminal, then try again.`)
}
