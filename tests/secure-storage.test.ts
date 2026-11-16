import { describe, expect, test } from 'bun:test'
import { secureStorageProblem } from '../src/main/secure-storage'

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

  test('Linux accepts a real keyring', () => {
    for (const name of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])
      expect(secureStorageProblem('linux', true, backend(name))).toBeNull()
  })
})
