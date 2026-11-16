/**
 * Why the session can't be kept safely on this machine, or null when it can. On Linux,
 * Electron's `basic_text` store reports encryption as available but uses a fixed key, so it
 * counts as no store; so does `unknown`, which Electron reports only before the app is ready.
 */
export function secureStorageProblem(
  platform: NodeJS.Platform,
  available: boolean,
  linuxBackend: () => string,
): string | null {
  if (platform !== 'linux')
    return available ? null : 'Secure storage is unavailable. Signing in needs the system keychain.'
  const backend = linuxBackend()
  if (available && backend !== 'basic_text' && backend !== 'unknown') return null
  return 'Signing in needs a keyring, such as GNOME Keyring or KWallet. Set one up, then try again.'
}
