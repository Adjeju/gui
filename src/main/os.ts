import type { BrowserWindowConstructorOptions } from 'electron'
import { TRAFFIC_LIGHTS } from '../shared/layout'
import { IS_MAC } from '../shared/platform'

export const DEFAULT_SHELL = IS_MAC ? '/bin/zsh' : '/bin/bash'

export function windowChrome(): BrowserWindowConstructorOptions {
  return IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS }
    : { autoHideMenuBar: true }
}
