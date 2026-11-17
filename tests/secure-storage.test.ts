import { describe, expect, test } from 'bun:test'
import { linuxPasswordStore, secureStorageProblem } from '../src/main/secure-storage'

const backend = (name: string) => () => name

describe('secureStorageProblem', () => {
  test('macOS needs only the Keychain', () => {
    expect(secureStorageProblem('darwin', true, backend('unknown'))).toBeNull()
    expect(secureStorageProblem('darwin', false, backend('unknown'))).toContain('system keychain')
  })

  test('Linux refuses the fixed-key basic_text store even when it reports available', () => {
    expect(secureStorageProblem('linux', true, backend('basic_text'))).toContain('keyring')
  })

  test('Linux refuses an unknown store or no encryption', () => {
    expect(secureStorageProblem('linux', true, backend('unknown'))).toContain('keyring')
    expect(secureStorageProblem('linux', false, backend('gnome_libsecret'))).toContain('keyring')
  })

  test('Linux says a keyring must be running when libsecret finds no Secret Service', () => {
    const problem = secureStorageProblem('linux', false, backend('gnome_libsecret'))
    expect(problem).toContain('running and unlocked')
    expect(problem).toContain('KeePassXC')
  })

  test('Linux accepts a real keyring', () => {
    for (const name of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
      expect(secureStorageProblem('linux', true, backend(name))).toBeNull()
  })
})

describe('linuxPasswordStore', () => {
  const linux = (env: Record<string, string>, argv = ['/opt/Gui/gui']) =>
    linuxPasswordStore('linux', argv, env)

  test('desktops Chromium does not recognize use libsecret', () => {
    for (const desktop of ['Hyprland', 'sway', 'i3', 'niri', 'river', ''])
      expect(linux({ XDG_CURRENT_DESKTOP: desktop })).toBe('gnome-libsecret')
    expect(linux({})).toBe('gnome-libsecret')
  })

  test('GNOME-like desktops ask for the libsecret store Chromium would pick anyway', () => {
    for (const desktop of ['GNOME', 'ubuntu:GNOME', 'X-Cinnamon', 'XFCE'])
      expect(linux({ XDG_CURRENT_DESKTOP: desktop })).toBe('gnome-libsecret')
  })

  test('KDE keeps KWallet', () => {
    expect(linux({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' })).toBeNull()
    expect(linux({ XDG_CURRENT_DESKTOP: 'foo:KDE' })).toBeNull()
    expect(linux({ DESKTOP_SESSION: 'kde-plasma' })).toBeNull()
    expect(linux({ KDE_FULL_SESSION: 'true' })).toBeNull()
  })

  test('a store the user chose wins', () => {
    const env = { XDG_CURRENT_DESKTOP: 'Hyprland' }
    expect(linux(env, ['gui', '--password-store=kwallet6'])).toBeNull()
    expect(linux(env, ['gui', '--password-store', 'basic'])).toBeNull()
  })

  test('macOS and Windows pass nothing', () => {
    expect(linuxPasswordStore('darwin', ['gui'], { XDG_CURRENT_DESKTOP: 'Hyprland' })).toBeNull()
    expect(linuxPasswordStore('win32', ['gui'], {})).toBeNull()
  })
})
