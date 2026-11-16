import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, autoUpdater, type Event, net, powerMonitor } from 'electron'
import type { AgentId, TurnStatus } from '../shared/types'
import { turnUsage, type UsageEventName, type UsageProps, usageQueue } from './analytics-queue'
import { officialBuild } from './official-build'
import { getPrefs } from './prefs'

/**
 * Usage data: installed copies count a few things people do in Gui (analytics-queue.ts lists
 * every event and what it carries) and send them to usegui.com/t/v1, which passes them on to
 * PostHog. Each copy is a random install ID, not the Gui account. Never paths, names,
 * prompts, replies, or code. Builds from source and tests send nothing. Settings → Account →
 * Share usage data turns it off. The privacy page says what is sent.
 */

const ENDPOINT = 'https://usegui.com/t/v1'
const FLUSH_EVERY = 5 * 60 * 1000
/** The longest quitting waits for the last events to go. */
const QUIT_WAIT = 1000

/**
 * The install's random ID and the version it last launched, in Gui's data. The ID is made
 * the first time usage data is sent, so a copy that never shares it never has one.
 */
interface Install {
  id: string | null
  version: string | null
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const installFile = () => join(app.getPath('userData'), 'install.json')
let install: Install | null = null

function readInstall(): Install {
  if (install) return install
  install = { id: null, version: null }
  try {
    const saved = JSON.parse(readFileSync(installFile(), 'utf8')) as Partial<Install>
    if (typeof saved.id === 'string' && UUID.test(saved.id)) install.id = saved.id
    if (typeof saved.version === 'string') install.version = saved.version
  } catch {
    // None yet, or unreadable: starts again.
  }
  return install
}

function saveInstall(patch: Partial<Install>) {
  install = { ...readInstall(), ...patch }
  try {
    writeFileSync(installFile(), JSON.stringify(install), { mode: 0o600 })
  } catch (error) {
    console.error('[gui] failed to save install.json', error)
  }
}

function installId() {
  const { id } = readInstall()
  if (id) return id
  const made = randomUUID()
  saveInstall({ id: made })
  return made
}

const queue = usageQueue({
  official: officialBuild,
  enabled: () => getPrefs().shareUsage,
  installId,
  post: (body, signal) =>
    net.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal,
    }),
})

/** Counts one usage event; does nothing unless this copy shares usage data. */
export function track<E extends UsageEventName>(event: E, ...props: UsageProps<E>) {
  queue.track(event, ...props)
}

/** A chat turn ended; `provider` is the agent's model provider setting, if it has one. */
export function trackTurn(agent: AgentId, status: TurnStatus, provider?: string) {
  track('turn_finished', turnUsage(agent, status, provider))
}

/** Share usage data switched off: nothing queued is sent. */
export function clearUsage() {
  queue.clear()
}

let systemEnding = false
let quitting = false

/**
 * At launch, once the app is ready: counts the launch, and an update if the version changed
 * since the last one, then sends every few minutes.
 */
export function startAnalytics() {
  if (!officialBuild) return
  // Logging out, shutting down, or Restart to Update isn't held up, even by a second: an
  // update's installer waits on this quit. The update is counted at the next launch anyway.
  const ending = () => {
    systemEnding = true
  }
  powerMonitor.on('shutdown', ending)
  autoUpdater.on('before-quit-for-update', ending)
  const version = app.getVersion()
  const saved = readInstall()
  track('app_opened', {
    version,
    os: process.platform,
    osVersion: process.getSystemVersion(),
    arch: process.arch,
  })
  if (saved.version && saved.version !== version) {
    track('update_installed', { from: saved.version, to: version })
  }
  if (saved.version !== version) saveInstall({ version })
  setInterval(() => void queue.flush(), FLUSH_EVERY).unref()
}

/**
 * `before-quit`: holds the quit for at most QUIT_WAIT while the last events go, then quits.
 * With nothing to send it doesn't hold it at all.
 */
export function sendUsageBeforeQuit(event: Event) {
  if (quitting || systemEnding || queue.size === 0 || !officialBuild) return
  quitting = true
  event.preventDefault()
  const waited = new Promise<void>((resolve) => setTimeout(resolve, QUIT_WAIT))
  void Promise.race([queue.flush(QUIT_WAIT), waited]).finally(() => app.quit())
}
