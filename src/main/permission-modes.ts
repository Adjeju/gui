import type { AgentSetting } from '../shared/types'
import type { PermissionControls, PermissionPolicy } from './agents'

/** What a running session offers for Gui's permission controls, as the agent reported it. */
export interface OfferedControls {
  /** The session's config option in the `mode` category, if it has one */
  modeOption: AgentSetting | null
  /** Its ACP session modes, used when it has no `mode` option */
  modes: { current: string; offered: string[] } | null
}

/** One change Ask or Auto makes to a session: a config option, or its ACP session mode. */
export type PermissionChange =
  | { kind: 'option'; configId: string; value: string }
  | { kind: 'mode'; modeId: string }

const values = (setting: AgentSetting) => setting.options.map(({ value }) => value)

interface Control {
  current: string
  offered: string[]
  change: (value: string) => PermissionChange
}

/** The session's mode control: its `mode` option, else its ACP modes; null with neither. */
function modeControl(offered: OfferedControls): Control | null {
  const option = offered.modeOption
  if (option) {
    return {
      current: option.value,
      offered: values(option),
      change: (value) => ({ kind: 'option', configId: option.id, value }),
    }
  }
  if (!offered.modes) return null
  return { ...offered.modes, change: (modeId) => ({ kind: 'mode', modeId }) }
}

/** What an agent's definition says about its permission controls (see AgentDefinition). */
export interface DeclaredControls {
  permissions?: PermissionControls
  ownPermissions?: true
}

/**
 * Whether the agent's own settings decide what it asks, because Gui can't make it ask
 * first: its definition says it offers no such mode, or the session doesn't offer the
 * mode Ask wants (one renamed or dropped).
 * Ask taken as the session starts (Grok's `_meta`) holds. An agent Gui knows nothing
 * about (a custom one) isn't said to decide: Gui's answers to what it asks are all there
 * is. `offered` is null before a session starts, when the definition alone decides.
 */
export function ownPermissions(agent: DeclaredControls, offered: OfferedControls | null) {
  if (agent.ownPermissions) return true
  const controls = agent.permissions
  if (!controls || !offered || controls.sessionMeta) return false
  const mode = controls.mode && modeControl(offered)
  return !(mode && controls.mode?.ask.some((value) => mode.offered.includes(value)))
}

/**
 * What Ask or Auto changes in a session (see PermissionControls): the first mode it prefers
 * that the session offers, unless that's already set. `missing` says so when the session
 * offers none of the modes the policy wants.
 */
export function permissionChanges(
  controls: PermissionControls | undefined,
  policy: PermissionPolicy,
  offered: OfferedControls,
): { changes: PermissionChange[]; missing: string[] } {
  const changes: PermissionChange[] = []
  const missing: string[] = []
  const wanted = controls?.mode?.[policy]
  if (!wanted) return { changes, missing }
  const control = modeControl(offered)
  const value = control && wanted.find((choice) => control.offered.includes(choice))
  if (!control || !value) missing.push(`No ${wanted.join(' or ')} mode offered.`)
  else if (value !== control.current) changes.push(control.change(value))
  return { changes, missing }
}
