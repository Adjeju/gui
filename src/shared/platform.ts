function detectMac(): boolean {
  const scope = globalThis as {
    process?: { platform?: string }
    navigator?: { platform?: string; userAgent?: string }
  }
  const platform = scope.process?.platform
  if (typeof platform === 'string') return platform === 'darwin'
  const agent = scope.navigator?.platform || scope.navigator?.userAgent || ''
  return /mac/i.test(agent)
}

export const IS_MAC = detectMac()
