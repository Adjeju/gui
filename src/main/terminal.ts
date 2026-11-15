import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { IS_MAC } from '../shared/platform'
import { DEFAULT_SHELL } from './os'
import { getShellEnv } from './shell-env'
import { launchTerminal } from './terminal-launch'

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

export async function runInTerminal(command: string, intro: string) {
  const dir = join(app.getPath('userData'), 'terminal')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const name = `sign-in-${randomBytes(6).toString('hex')}`
  const file = join(dir, IS_MAC ? `${name}.command` : `${name}.sh`)
  const script = IS_MAC
    ? [
        '#!/bin/sh',
        'rm -f -- "$0"',
        'clear',
        `printf '%s\\n\\n' ${quote(intro)}`,
        `exec "\${SHELL:-${DEFAULT_SHELL}}" -lic ${quote(`${command}; echo; echo "All done. You can close this window and go back to Gui."`)}`,
        '',
      ]
    : [
        '#!/bin/sh',
        'rm -f -- "$0"',
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
    if (!error) return
    await rm(file, { force: true })
    throw new Error(`Couldn't open Terminal: ${error}`)
  }
  const env = await getShellEnv()
  try {
    await launchTerminal(file, env)
  } catch (error) {
    await rm(file, { force: true })
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} Run \`${command}\` in a terminal, then try again.`)
  }
}
