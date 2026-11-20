import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { shell } from 'electron'
import { IS_MAC } from '../shared/platform'
import { spawnProcess } from './process'

/**
 * Opening a web page or file in the user's own app. On Linux, Electron's `shell.openExternal`
 * and `shell.openPath` run xdg-open with Gui's process.env as it is, so the browser or editor
 * they start keeps the AppImage's ARGV0, APPDIR and mount paths, and passes them on to its own
 * terminals (zsh then runs every command as "Gui.AppImage"). There Gui runs xdg-open itself,
 * through `spawnProcess`, which drops them. On the Mac, Electron's `shell` is used as is.
 */

/** Opens a URL in the user's browser (or the app it belongs to); rejects if nothing could start. */
export function openExternal(url: string): Promise<void> {
  return IS_MAC ? shell.openExternal(url) : xdgOpen(url, { wait: false, cwd: homedir() })
}

/** Opens a file in its default app. Like `shell.openPath`: '' once it opened, else why not. */
export async function openPath(path: string): Promise<string> {
  if (IS_MAC) return shell.openPath(path)
  try {
    await xdgOpen(path, { wait: true, cwd: dirname(path) })
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Runs `xdg-open target` in its own process group with no stdio, so what it starts doesn't go
 * when Gui quits. `wait` resolves on its exit status (as Electron's openPath does), otherwise
 * once it started (as openExternal does).
 */
export function xdgOpen(
  target: string,
  { wait, cwd }: { wait: boolean; cwd: string },
  spawn: typeof spawnProcess = spawnProcess,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('xdg-open', [target], {
      cwd,
      detached: true,
      stdio: 'ignore',
      // What Chromium sets: a mailcap fallback must open its own terminal, there is no tty.
      extra: { MM_NOTTTY: '1' },
    })
    child.once('error', (error) => reject(new Error(`Couldn't run xdg-open: ${error.message}`)))
    if (wait) {
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`xdg-open couldn't open it (${code ?? signal}).`))
      })
    } else {
      child.once('spawn', () => resolve())
    }
    child.unref()
  })
}
