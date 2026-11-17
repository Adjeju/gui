/**
 * Why the session can't be kept safely on this machine, or null when it can. On Linux,
 * Electron's `basic_text` store uses a fixed key, so it counts as no store; so does
 * `unknown`, which Electron reports only before the app is ready. `gnome_libsecret` that
 * isn't available means no Secret Service answered: none is running, or it's locked.
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
  if (backend === 'gnome_libsecret')
    return 'Signing in needs a keyring, such as GNOME Keyring or KeePassXC, running and unlocked. Start one, then try again.'
  return 'Signing in needs a keyring, such as GNOME Keyring or KWallet. Set one up, then try again.'
}

/**
 * The `--password-store` Gui should pass Chromium, or null to leave its choice alone.
 *
 * Chromium picks a store from the desktop it detects: KDE gets KWallet, GNOME-like desktops
 * get libsecret, and any desktop it doesn't know (Hyprland, Sway, i3, niri, …) gets the
 * fixed-key `basic_text` store even when a Secret Service is running. So on Linux Gui asks
 * for libsecret unless the user chose a store or the session is KDE. On GNOME-like desktops
 * that is what Chromium would pick anyway. With no Secret Service, libsecret fails at once
 * and safeStorage reports encryption unavailable, so nothing needs probing at startup.
 */
export function linuxPasswordStore(
  platform: NodeJS.Platform,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): 'gnome-libsecret' | null {
  if (platform !== 'linux') return null
  if (argv.some((arg) => arg === '--password-store' || arg.startsWith('--password-store=')))
    return null
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').split(':').map((name) => name.trim())
  const session = env.DESKTOP_SESSION ?? ''
  const kde =
    desktops.includes('KDE') ||
    session === 'kde' ||
    session === 'kde4' ||
    session === 'kde-plasma' ||
    env.KDE_FULL_SESSION !== undefined
  return kde ? null : 'gnome-libsecret'
}
