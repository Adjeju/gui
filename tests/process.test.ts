import { describe, expect, test } from 'bun:test'
import {
  childEnv,
  endInput,
  execFile,
  isInheritedAgentMarker,
  scrubInheritedEnv,
} from '../src/main/process'

describe('child process env', () => {
  test('inherited agent session vars are stripped before a login shell', () => {
    expect(isInheritedAgentMarker('CLAUDECODE')).toBe(true)
    expect(isInheritedAgentMarker('CODEX_THREAD_ID')).toBe(true)
    expect(isInheritedAgentMarker('CODEX_HOME')).toBe(true)
    expect(isInheritedAgentMarker('PATH')).toBe(false)
    const env = scrubInheritedEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CODEX_THREAD_ID: 't',
      CLAUDE_CODE_USE_BEDROCK: '1',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CODEX_THREAD_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  })

  test('spawn env drops session markers and Electron flags, keeps profile agent settings', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
      },
      { CODEX_PATH: '/opt/codex' },
      { browser: 'none' },
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.CODEX_PATH).toBe('/opt/codex')
    expect(env.BROWSER).toBe('none')
  })

  test('AppImage runtime env and mount paths reach neither children nor the login shell', () => {
    const mount = '/tmp/.mount_GuiAbc123'
    const appImage = {
      APPDIR: mount,
      APPIMAGE: '/home/me/Apps/Gui.AppImage',
      ARGV0: 'Gui.AppImage',
      OWD: '/home/me',
      PATH: `${mount}:${mount}/usr/sbin:/home/me/.local/share/mise/shims:/usr/bin`,
      LD_LIBRARY_PATH: `${mount}/usr/lib`,
      XDG_DATA_DIRS: `${mount}/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/`,
      GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas:/opt/schemas`,
      HOME: '/home/me',
    }
    for (const env of [childEnv(appImage), scrubInheritedEnv(appImage)]) {
      expect(env.APPDIR).toBeUndefined()
      expect(env.APPIMAGE).toBeUndefined()
      expect(env.ARGV0).toBeUndefined()
      expect(env.OWD).toBeUndefined()
      expect(env.PATH).toBe('/home/me/.local/share/mise/shims:/usr/bin')
      expect(env.LD_LIBRARY_PATH).toBeUndefined()
      expect(env.XDG_DATA_DIRS).toBe('/usr/share/gnome:/usr/local/share/:/usr/share/')
      expect(env.GSETTINGS_SCHEMA_DIR).toBe('/opt/schemas')
      expect(env.HOME).toBe('/home/me')
    }
    // Gui's own env keeps them: updates and the CLI read APPIMAGE.
    expect(appImage.APPIMAGE).toBe('/home/me/Apps/Gui.AppImage')
  })

  test('without an AppImage mount, path lists are left alone', () => {
    const env = childEnv({
      PATH: '/tmp/.mount_x:/usr/bin',
      LD_LIBRARY_PATH: '/opt/lib',
      ARGV0: 'x',
    })
    expect(env.PATH).toBe('/tmp/.mount_x:/usr/bin')
    expect(env.LD_LIBRARY_PATH).toBe('/opt/lib')
    expect(env.ARGV0).toBeUndefined()
  })

  test('sign-in spawn does not block the browser', () => {
    const env = childEnv({ PATH: '/usr/bin' }, {}, { browser: false })
    expect(env.BROWSER).toBeUndefined()
  })
})

describe('endInput', () => {
  test('a child that exits without reading its stdin is not an uncaught EPIPE', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    try {
      const exited = new Promise<void>((resolve) => {
        const child = execFile('true', [], () => resolve())
        // Far more than a pipe buffer holds, so the write is still going when `true` exits.
        endInput(child, 'x'.repeat(8 * 1024 * 1024))
      })
      await exited
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })
})
