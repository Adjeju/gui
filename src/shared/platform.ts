type Platform = 'mac' | 'windows' | 'linux'

function detectPlatform(): Platform {
  const scope = globalThis as {
    process?: { platform?: string }
    navigator?: { platform?: string; userAgent?: string }
  }
  const platform = scope.process?.platform
  if (typeof platform === 'string') {
    return platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
  }
  const agent = scope.navigator?.platform || scope.navigator?.userAgent || ''
  return /mac/i.test(agent) ? 'mac' : /win/i.test(agent) ? 'windows' : 'linux'
}

const PLATFORM = detectPlatform()

export const IS_MAC = PLATFORM === 'mac'
export const IS_WINDOWS = PLATFORM === 'windows'
/** Linux and the other Unixes: anything that is neither macOS nor Windows. */
export const IS_LINUX = PLATFORM === 'linux'
