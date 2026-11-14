import { readdir, readFile, readlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { IS_MAC } from '../shared/platform'
import { execFile } from './process'

export interface Listener {
  pid: number
  /** Host part of the bound address, e.g. '127.0.0.1', '*', '[::1]', '[::]' */
  host: string
}

/** Its output; null when it couldn't run or timed out. */
function run(command: string, args: string[]) {
  return new Promise<string | null>((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout) => {
      // lsof exits 1 when nothing matches: it ran, and its output (none) is the answer.
      const ran = !error || (typeof error.code === 'number' && !error.killed)
      resolve(ran || stdout ? String(stdout) : null)
    })
  })
}

/** TCP listeners on a port, or null when lsof isn't available. */
export async function listenersOn(port: number): Promise<Listener[] | null> {
  if (!IS_MAC) {
    const pids = (await readdir('/proc').catch(() => [] as string[]))
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
    const found = await procListeners(pids, { unowned: true })
    return found ? found.filter((listener) => listener.port === port) : null
  }
  const out = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'])
  if (out === null) return null
  const listeners: Listener[] = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const name = line.slice(1)
      listeners.push({ pid, host: name.slice(0, name.lastIndexOf(':')) })
    }
  }
  return listeners
}

export interface PortListener extends Listener {
  port: number
}

/** `*:5173` → { host: '*', port: 5173 }, as lsof names a listening socket. */
function parseAddress(name: string) {
  const colon = name.lastIndexOf(':')
  const port = Number(name.slice(colon + 1))
  return colon > 0 && Number.isInteger(port) && port > 0
    ? { host: name.slice(0, colon), port }
    : null
}

/**
 * TCP listeners held by the process `root` or anything it started: its descendants, and
 * whatever is in its process group. Null when lsof isn't available.
 */
export async function listenersOf(root: number): Promise<PortListener[] | null> {
  const table = await run('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='])
  const pids = table === null ? [root] : descendants(table, root)
  if (!IS_MAC) return procListeners(pids, { unowned: false })
  const args = ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-Fpn']
  const out = await run('/usr/sbin/lsof', [...args, '-p', pids.join(',')])
  if (out === null) return null
  const listeners: PortListener[] = []
  let pid = 0
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid) {
      const address = parseAddress(line.slice(1))
      if (address) listeners.push({ pid, ...address })
    }
  }
  return listeners
}

async function procSockets() {
  const sockets = new Map<string, { host: string; port: number }>()
  let read = false
  for (const [file, v6] of [
    ['/proc/net/tcp', false],
    ['/proc/net/tcp6', true],
  ] as const) {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) continue
    read = true
    for (const line of text.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/)
      const local = fields[1]
      const inode = fields[9]
      if (fields[3] !== '0A' || !local || !inode) continue
      const [hex, portHex] = local.split(':')
      const port = Number.parseInt(portHex ?? '', 16)
      if (!hex || !Number.isInteger(port) || port <= 0) continue
      sockets.set(inode, { host: v6 ? procIpv6(hex) : procIpv4(hex), port })
    }
  }
  return read ? sockets : null
}

export function procIpv4(hex: string) {
  const bytes = (hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)).reverse()
  const address = bytes.join('.')
  return address === '0.0.0.0' ? '*' : address
}

export function procIpv6(hex: string) {
  const words = hex.match(/.{8}/g) ?? []
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse())
  const groups: string[] = []
  for (let i = 0; i < bytes.length; i += 2) groups.push(`${bytes[i]}${bytes[i + 1]}`)
  const full = groups.join(':')
  if (/^(0000:){5}ffff:/i.test(full)) {
    return procIpv4(bytes.slice(12).reverse().join(''))
  }
  return new URL(`http://[${full}]/`).hostname
}

async function socketInodes(pid: number) {
  const inodes = new Set<string>()
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1]
    if (inode) inodes.add(inode)
  }
  return inodes
}

async function procListeners(
  pids: number[],
  { unowned }: { unowned: boolean },
): Promise<PortListener[] | null> {
  const sockets = await procSockets()
  if (sockets === null) return null
  const inherited = await socketInodes(process.pid)
  const listeners: PortListener[] = []
  const owned = new Set<string>()
  for (const pid of pids) {
    for (const inode of await socketInodes(pid)) {
      if (pid !== process.pid && inherited.has(inode)) continue
      const address = sockets.get(inode)
      if (!address) continue
      owned.add(inode)
      listeners.push({ pid, ...address })
    }
  }
  if (unowned) {
    for (const [inode, address] of sockets) {
      if (!owned.has(inode)) listeners.push({ pid: 0, ...address })
    }
  }
  return listeners
}

/** `root`, its descendants, and the members of its process group, from `ps` output. */
function descendants(table: string, root: number): number[] {
  const children = new Map<number, number[]>()
  const found = new Set([root])
  for (const line of table.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
    if (pgid === root) found.add(pid)
  }
  const stack = [...found]
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (!found.has(child)) {
        found.add(child)
        stack.push(child)
      }
    }
  }
  return [...found]
}

/** Process group ids for the given pids. */
export async function processGroups(pids: number[]): Promise<Map<number, number>> {
  const groups = new Map<number, number>()
  if (pids.length === 0) return groups
  const known = pids.filter((pid) => pid > 0)
  if (known.length === 0) return groups
  const out = await run('/bin/ps', ['-o', 'pid=,pgid=', '-p', known.join(',')])
  for (const line of out?.split('\n') ?? []) {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number)
    if (pid && pgid) groups.set(pid, pgid)
  }
  return groups
}

/** Loopback host that reaches a listener bound to `host`. */
export function loopbackFor(host: string) {
  return host.startsWith('[') ? '[::1]' : '127.0.0.1'
}

export function portOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(1000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
