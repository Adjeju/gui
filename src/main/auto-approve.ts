import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { autoOption } from '../shared/auto-answer'
import type { AgentId } from '../shared/types'
import { getPrefs, setPrefs } from './prefs'

/**
 * Auto mode (`ChatMeta.autoApprove`): on for every project unless the user turned it off
 * there, which prefs remember by project root. Chats follow it through `prefsEvents`.
 */
export function setAutoApprove(root: string, on: boolean) {
  const roots = getPrefs().askRoots
  if (roots.includes(root) !== on) return
  setPrefs({ askRoots: on ? roots.filter((saved) => saved !== root) : [...roots, root] })
}

export function isAutoApprove(root: string) {
  return !getPrefs().askRoots.includes(root)
}

const JSON_FILE = 'json[c5]?'
const YAML_FILE = 'ya?ml'
const CODE_FILE = '[cm]?[jt]s'
/** Makefile, justfile, Taskfile, Rakefile, Gemfile, Podfile, Pipfile, Brewfile, Procfile… */
const NAMED_FILES =
  'make|gnumake|just|task|rake|gem|pod|pip|brew|proc|jenkins|vagrant|tilt|earth|gulp|grunt'

/**
 * Sensitive file names, in any folder, by family, so the next tool's file is one too.
 * JSON and YAML also hold ordinary content (`src/data/products.json`, `content/post.yaml`),
 * so in those formats a file is sensitive by its name, never by its extension. Source files
 * named after a tool (`src/lib/firebase.ts`) are ordinary.
 */
const SENSITIVE_NAMES = [
  // Scripts.
  '[^/]*\\.(sh|bash|zsh)',
  // Config: named as config (vite.config.ts, babel.config.json), a TypeScript or JavaScript
  // project's own, and the formats only config is written in.
  `[^/]*\\.config(\\.(${CODE_FILE}|${JSON_FILE}|${YAML_FILE}))?`,
  '[jt]sconfig[^/]*\\.json',
  '[^/]*\\.(toml|ini|cfg|conf)',
  // Containers: Dockerfile, Dockerfile.dev, web.Dockerfile, compose.yaml, docker-compose.yml.
  '([^/]*\\.)?(docker|container)file(\\.[^/]*)?',
  `(docker-)?compose(\\.[^/]*)?\\.${YAML_FILE}`,
  // Lockfiles: yarn.lock, Cargo.lock, bun.lockb, package-lock.json, pnpm-lock.yaml.
  '[^/]*\\.lockb?',
  `[^/]*[-.]lock\\.(${JSON_FILE}|${YAML_FILE})`,
  'npm-shrinkwrap\\.json|go\\.sum|go\\.work\\.sum|package\\.resolved',
  // Workspaces: pnpm-workspace.yaml.
  `[^/]*[-.]workspace\\.(${JSON_FILE}|${YAML_FILE})`,
  'go\\.work',
  // Package manifests, by ecosystem (Cargo.toml and pyproject.toml are TOML, above; Gemfile,
  // Pipfile and Podfile are below).
  `package\\.(json5?|${YAML_FILE})`,
  `(deno|jsr|composer)\\.${JSON_FILE}`,
  `pubspec\\.${YAML_FILE}`,
  '(requirements|constraints)[^/]*\\.(txt|in)',
  'setup\\.py|go\\.mod|pom\\.xml|mix\\.exs|package\\.swift',
  '[^/]*\\.(gemspec|podspec|gradle|gradle\\.kts|csproj|fsproj|vbproj|sln|nix)',
  // Deploy and CI config kept outside dot-folders (netlify.toml and fly.toml are TOML).
  `(vercel|firebase|wrangler|railway)\\.${JSON_FILE}`,
  `(render|apphosting|amplify|serverless|heroku)\\.${YAML_FILE}`,
  `([^/]*-pipelines|cloudbuild|buildspec|appveyor)\\.${YAML_FILE}`,
  // Task runners and tools: turbo.json, Makefile, justfile, Taskfile.yml, Procfile, Gemfile.
  `(turbo|nx|lerna|rush|nodemon|biome)\\.${JSON_FILE}`,
  `([^/]*\\.)?(${NAMED_FILES})file(\\.[^/]*)?`,
  '[^/]*\\.mk',
  // Git-hook runners (husky and pre-commit keep theirs in dotfiles).
  `(lefthook|simple-git-hooks|captainhook)[^/]*\\.(${CODE_FILE}|${JSON_FILE}|${YAML_FILE})`,
]

/**
 * Files that can change how code runs (build/tool config, dependencies, CI, hooks,
 * dotfiles): Ask mode asks before editing one, though it approves other project edits, and
 * the permission card marks them. Anything in a dotfile or dot-folder, a name in `SENSITIVE_NAMES`, and what's in
 * `node_modules`, `scripts` or `bin`. Letter case doesn't matter.
 */
export const SENSITIVE_PATH = new RegExp(
  `(^|/)\\.|(^|/)(${SENSITIVE_NAMES.join('|')})$|(^|/)(node_modules|scripts|bin)/`,
  'i',
)

/** Where agents that send no `locations` put a file's path in the tool's input. */
const PATH_FIELDS = ['path', 'file_path', 'filePath', 'notebook_path']

const allowOnce = (request: RequestPermissionRequest) =>
  request.options.find((option) => option.kind === 'allow_once')

const isReject = (option: PermissionOption | undefined) =>
  option?.kind === 'reject_once' || option?.kind === 'reject_always'

/**
 * The agent itself says a person should decide: it put a reject option first (its way of
 * defaulting to No), or it's Claude asking with no "always allow" (forced by the user's own
 * ask rules or Claude's safety checks).
 */
export function flaggedCaution(request: RequestPermissionRequest, agentId: AgentId) {
  const { options } = request
  if (isReject(options[0])) return true
  return agentId === 'claude' && !options.some((option) => option.kind === 'allow_always')
}

/** The paths a request names: its `locations`, else the path fields of its raw input. */
export function requestPaths(request: RequestPermissionRequest): string[] {
  const { locations, rawInput } = request.toolCall
  if (locations?.length) return locations.map(({ path }) => path)
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return []
  const input = rawInput as Record<string, unknown>
  return PATH_FIELDS.flatMap((field) => {
    const value = input[field]
    return typeof value === 'string' && value !== '' ? [value] : []
  })
}

/**
 * What Auto mode answers `request` with: allow once, never "always" (no lasting grants in
 * the agent's own settings), whatever the request is for. Null when the user decides: the
 * agent's own questions (`QUESTION_KIND`), Claude's plan approval (`switch_mode`), and a
 * request that offers no "allow once".
 */
export function autoApproval(request: RequestPermissionRequest): string | null {
  return autoOption({ kind: request.toolCall.kind, options: request.options })
}

/**
 * What Ask mode answers an edit with: allow once when it names only ordinary source files
 * inside the project; null (the user decides) when the agent flagged it, it offers no
 * "allow once", names no file, names one `place` can't put inside the project, or names a
 * sensitive one.
 */
export async function editApproval(
  request: RequestPermissionRequest,
  agentId: AgentId,
  /**
   * Where `path` lands, relative to the project, when it's safely inside it (a file, not
   * through a symlink, not in Gui's own data); otherwise null.
   */
  place: (path: string) => Promise<string | null>,
): Promise<string | null> {
  if (request.toolCall.kind !== 'edit' || flaggedCaution(request, agentId)) return null
  const allow = allowOnce(request)
  const paths = requestPaths(request)
  if (!allow || paths.length === 0) return null
  const placed = await Promise.all(paths.map(place))
  return placed.every((rel) => rel !== null && !SENSITIVE_PATH.test(rel)) ? allow.optionId : null
}
