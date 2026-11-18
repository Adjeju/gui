import { expect, test } from 'bun:test'
import { systemName } from '../src/main/system-name'

test('support email names the system Gui runs on', () => {
  expect(systemName('darwin', '15.5.0', 'arm64')).toBe('macOS 15.5.0 (arm64)')
  expect(systemName('linux', '6.8.0-45-generic', 'x64')).toBe('Linux 6.8.0-45-generic (x64)')
  expect(systemName('win32', '10.0.26100', 'x64')).toBe('Windows 10.0.26100 (x64)')
})

test('a system without a name of its own is called what Node calls it', () => {
  expect(systemName('freebsd', '14.1-RELEASE', 'x64')).toBe('freebsd 14.1-RELEASE (x64)')
})
