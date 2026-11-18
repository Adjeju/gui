const NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
}

/**
 * The computer's system as a person names it, for support email: "macOS 15.5 (arm64)",
 * "Linux 6.8.0-45-generic (x64)". `version` is Electron's `process.getSystemVersion()`, which
 * is the kernel's version on Linux.
 */
export function systemName(platform: NodeJS.Platform, version: string, arch: string): string {
  return `${NAMES[platform] ?? platform} ${version} (${arch})`
}
