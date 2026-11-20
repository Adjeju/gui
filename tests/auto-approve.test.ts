import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { type EditScope, projectEditPath } from '../src/main/chat-paths'
import type { AgentId } from '../src/shared/types'

// What Gui answers a permission request with on its own, and what it leaves to the user.
// docs/architecture.md ("Agents") is the specification:
//
//   In Auto mode Gui answers every request itself, picking only one-time approvals: commands,
//   fetches, reads and edits anywhere, sensitive files, websites, and what the agent flags.
//   It leaves the agent's own questions, Claude's plan approval (a mode switch), and a
//   request that offers only "always allow" to the user. In Ask mode it approves edits to
//   ordinary source files in the project and asks about everything else.
//
// `decide` answers as chat.ts does (`ChatController.autoAnswer`): `autoApproval` in Auto,
// `editApproval` in Ask, placing each path with `projectEditPath`. It returns the option
// picked, or null when the user is asked.

let userData = ''
mock.module('electron', () => ({ app: { getPath: () => userData } }))
const {
  autoApproval,
  editApproval,
  flaggedCaution,
  isAutoApprove,
  requestPaths,
  SENSITIVE_PATH,
  setAutoApprove,
} = await import('../src/main/auto-approve')
const { flushPrefsSync } = await import('../src/main/prefs')

let base = ''
let scope: EditScope

beforeAll(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-auto-'))
  userData = join(base, 'gui-data')
  const proj = join(base, 'proj')
  const files = ['proj/src/app.tsx', 'proj/package.json', 'proj/.env', 'outside/secret.txt']
  for (const file of files) {
    mkdirSync(dirname(join(base, file)), { recursive: true })
    writeFileSync(join(base, file), 'x')
  }
  mkdirSync(join(base, 'proj-other'))
  symlinkSync('../outside', join(proj, 'link-out'))
  scope = { root: proj, realRoot: proj, home: join(base, 'home'), protectedDirs: [userData] }
})

afterAll(() => {
  // Preferences are saved a moment after they change: into this folder, before it goes.
  flushPrefsSync()
  rmSync(base, { recursive: true, force: true })
})

const ONCE: PermissionOption = { optionId: 'once', name: 'Allow', kind: 'allow_once' }
const ALWAYS: PermissionOption = { optionId: 'always', name: 'Always allow', kind: 'allow_always' }
const NO: PermissionOption = { optionId: 'no', name: 'Reject', kind: 'reject_once' }
const NEVER: PermissionOption = { optionId: 'never', name: 'Never', kind: 'reject_always' }
/** What agents usually offer, in their order. */
const USUAL = [ONCE, ALWAYS, NO]
/** Gui's own question cards (agent-protocol.ts `questionRequest`): Skip first, then answers. */
const QUESTION = [
  { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
  { optionId: '0', name: 'Blue', kind: 'answer' },
] as PermissionOption[]

interface Asked {
  /** The tool kind; left out when the request doesn't say */
  kind?: string
  title?: string
  /** The request's `locations`; `$` stands for the temp folder */
  paths?: string[]
  /** The tool's raw input, where agents without `locations` put the path */
  input?: unknown
  options?: PermissionOption[]
  agentId?: AgentId
}

function request({ kind, title, paths, input, options = USUAL }: Asked): RequestPermissionRequest {
  return {
    sessionId: 'session',
    options,
    toolCall: {
      toolCallId: 'tool',
      kind: kind as RequestPermissionRequest['toolCall']['kind'],
      ...(title ? { title } : {}),
      locations: paths?.map((path) => ({ path: path.replace(/^\$/, base) })),
      rawInput: input,
    },
  }
}

function decide(asked: Asked, mode: 'auto' | 'ask') {
  if (mode === 'auto') return Promise.resolve(autoApproval(request(asked)))
  return editApproval(request(asked), asked.agentId ?? 'codex', (path) =>
    projectEditPath(path, scope),
  )
}

const edit = (...paths: string[]): Asked => ({ kind: 'edit', paths })

/** What Ask mode approves: edits to ordinary source files inside the project. */
const IN_PROJECT_EDITS: Array<[what: string, asked: Asked]> = [
  ['an edit to a source file', edit('src/app.tsx')],
  ['an edit named by its absolute path', edit('$/proj/src/app.tsx')],
  ['a new file', edit('src/components/button.tsx')],
  ['an edit to several source files', edit('src/app.tsx', 'src/main.tsx')],
  ['an edit that names its file in the raw input', { kind: 'edit', input: { path: 'src/a.ts' } }],
]

/** What only Auto answers: Ask leaves each of these to the user. */
const AUTO_ONLY: Array<[what: string, asked: Asked]> = [
  // Not edits.
  ['a command', { kind: 'execute' }],
  ['a command in another folder', { kind: 'execute', paths: ['$/outside'] }],
  ['a fetch', { kind: 'fetch' }],
  ['a read in the project', { kind: 'read', paths: ['src/app.tsx'] }],
  ['a search of the project', { kind: 'search', paths: ['$/proj'] }],
  ['deleting a source file', { kind: 'delete', paths: ['src/app.tsx'] }],
  ['moving a file within the project', { kind: 'move', paths: ['src/app.tsx', 'src/home.tsx'] }],
  ['a tool of no particular kind', { kind: 'other' }],
  ['a tool that says no kind at all', {}],
  // Outside the project.
  ['a read of a system file', { kind: 'read', paths: ['/etc/hosts'] }],
  ['a read that climbs out with ..', { kind: 'read', paths: ['../outside/secret.txt'] }],
  ['a read through a link to outside', { kind: 'read', paths: ['link-out/secret.txt'] }],
  ['a read from ~', { kind: 'read', paths: ['~/.ssh/id_ed25519'] }],
  ['a search of the folder above', { kind: 'search', paths: ['$'] }],
  ['an edit outside', edit('$/outside/secret.txt')],
  ["an edit in a sibling whose name starts with the project's", edit('$/proj-other/a.ts')],
  ['an edit through a link', edit('link-out/secret.txt')],
  ['an edit to several files, one of them outside', edit('src/app.tsx', '$/outside/a.ts')],
  // See tests/chat-paths.test.ts: to Claude Code, `~/notes.md` is a file in the home folder.
  ['an edit to a path from ~, the home folder', edit('~/notes.md')],
  ["a change to Gui's own data", edit('$/gui-data/prefs.json')],
  ['an edit whose raw input names a file outside', { kind: 'edit', input: { path: '/etc/x' } }],
  ['a move out of the project', { kind: 'move', paths: ['src/app.tsx', '$/outside/app.tsx'] }],
  // Sensitive files.
  ['an edit to package.json', edit('package.json')],
  ['an edit to .env', edit('.env')],
  ['an edit to a config among ordinary files', edit('src/app.tsx', 'vite.config.ts')],
  ['an edit to a git hook', edit('.githooks/pre-commit')],
  ['one named only in the raw input', { kind: 'edit', input: { file_path: 'package.json' } }],
  // Changes that name no file.
  ['an edit with no locations and no input', { kind: 'edit' }],
  ['an edit whose input has no path', { kind: 'edit', input: { command: 'sed -i' } }],
  ['an edit that names the project folder', edit('$/proj')],
  // The agent flags it.
  ['a command the agent leads with "no" on', { kind: 'execute', options: [NO, ONCE, ALWAYS] }],
  ['an edit the agent leads with "never" on', { ...edit('src/app.tsx'), options: [NEVER, ONCE] }],
  [
    'Claude offering no "always allow" (its ask rules and safety checks)',
    { kind: 'execute', agentId: 'claude', options: [ONCE, NO] },
  ],
  [
    'a flagged edit from Claude to a source file',
    { ...edit('src/app.tsx'), agentId: 'claude', options: [ONCE, NO] },
  ],
  // Opening a website: Claude asks about it by an ask rule (session-meta.ts).
  [
    'opening a website, from Claude',
    {
      kind: 'other',
      title: 'mcp__gui__preview_open_website',
      agentId: 'claude',
      options: [ONCE, NO],
    },
  ],
  ['opening a website, from another agent', { kind: 'other', title: 'gui.preview_open_website' }],
  [
    'a screenshot of a website',
    { kind: 'other', title: 'mcp__gui__canvas_screenshot_url', agentId: 'claude' },
  ],
]

describe('Auto: allowed once, without asking, whatever it is for', () => {
  test.each([...IN_PROJECT_EDITS, ...AUTO_ONLY])('%s', async (_what, asked) => {
    expect(await decide(asked, 'auto')).toBe('once')
  })
})

describe('Ask: edits to ordinary project files are allowed once', () => {
  test.each(IN_PROJECT_EDITS)('%s', async (_what, asked) => {
    expect(await decide(asked, 'ask')).toBe('once')
  })
})

describe('Ask: everything else asks', () => {
  test.each(AUTO_ONLY)('%s', async (_what, asked) => {
    expect(await decide(asked, 'ask')).toBeNull()
  })
})

describe('both modes: the user decides', () => {
  const agents: AgentId[] = ['claude', 'codex', 'muse', 'antigravity', 'cursor']
  const cases: Array<[what: string, asked: Asked]> = [
    ...agents.map((agentId): [string, Asked] => [
      `a question of ${agentId}'s own`,
      { kind: 'question', options: QUESTION, agentId },
    ]),
    // Claude's plan approval arrives as a mode switch.
    ...agents.map((agentId): [string, Asked] => [
      `a mode switch from ${agentId}`,
      { kind: 'switch_mode', agentId },
    ]),
    ['a mode switch that names a file', { kind: 'switch_mode', paths: ['src/app.tsx'] }],
  ]
  test.each(cases)('%s', async (_what, asked) => {
    expect(await decide(asked, 'auto')).toBeNull()
    expect(await decide(asked, 'ask')).toBeNull()
  })
})

describe('only one-time approvals are picked: no lasting grants', () => {
  const cases: Array<[what: string, options: PermissionOption[], answer: string | null]> = [
    ['"allow once" among the usual options', [ONCE, ALWAYS, NO], 'once'],
    ['"allow once" when "always" comes first', [ALWAYS, ONCE, NO], 'once'],
    ['only "always allow" on offer: asks', [ALWAYS, NO], null],
    ['only ways to say no: asks', [NO, NEVER], null],
    ['nothing on offer: asks', [], null],
  ]
  test.each(cases)('%s', async (_what, options, answer) => {
    expect(await decide({ kind: 'execute', options }, 'auto')).toBe(answer)
    expect(await decide({ ...edit('$/outside/a.ts'), options }, 'auto')).toBe(answer)
    expect(await decide({ ...edit('src/app.tsx'), options }, 'ask')).toBe(answer)
  })
})

describe('Ask: an edit to a sensitive file asks', () => {
  // By family (`SENSITIVE_NAMES` in auto-approve.ts): the next tool's file should ask too.
  const sensitive: Array<[group: string, paths: string[]]> = [
    [
      'config',
      [
        'vite.config.ts',
        'next.config.mjs',
        'tailwind.config.cjs',
        'apps/web/eslint.config.js',
        'babel.config.json',
        'jest.config.json',
        'postcss.config.yaml',
        'web.config',
        'tsconfig.json',
        'tsconfig.node.json',
        'jsconfig.json',
        'biome.json',
        'bunfig.toml',
        'supabase/config.toml',
        'tox.ini',
        'setup.cfg',
        'nginx.conf',
      ],
    ],
    [
      'containers',
      [
        'Dockerfile',
        'Dockerfile.dev',
        'apps/api/Dockerfile.prod',
        'web.Dockerfile',
        'Containerfile',
        'docker-compose.yml',
        'docker-compose.override.yml',
        'compose.yaml',
        'compose.dev.yml',
      ],
    ],
    [
      'dotfiles',
      ['.env', '.gitignore', '.eslintrc.json', '.github/workflows/ci.yml', 'src/.cache/a.ts'],
    ],
    [
      'lockfiles',
      [
        'package-lock.json',
        'npm-shrinkwrap.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'bun.lock',
        'bun.lockb',
        'deno.lock',
        'Cargo.lock',
        'uv.lock',
        'Gemfile.lock',
        'go.sum',
        'packages.lock.json',
      ],
    ],
    ['scripts', ['scripts/release.ts', 'bin/cli.js', 'deploy.sh', 'tools/setup.bash', 'env.zsh']],
    ['package.json', ['package.json', 'apps/web/package.json', 'PACKAGE.JSON']],
    [
      'manifests and workspaces',
      [
        'pnpm-workspace.yaml',
        'deno.json',
        'deno.jsonc',
        'requirements.txt',
        'requirements-dev.txt',
        'pyproject.toml',
        'setup.py',
        'Pipfile',
        'Cargo.toml',
        'go.mod',
        'go.work',
        'Gemfile',
        'app.gemspec',
        'composer.json',
        'pom.xml',
        'build.gradle',
        'Package.swift',
        'pubspec.yaml',
        'flake.nix',
      ],
    ],
    [
      'deploy and CI',
      [
        'vercel.json',
        'apps/web/vercel.json',
        'netlify.toml',
        'wrangler.toml',
        'wrangler.jsonc',
        'fly.toml',
        'render.yaml',
        'firebase.json',
        'serverless.yml',
        'Procfile',
        'azure-pipelines.yml',
        'Jenkinsfile',
      ],
    ],
    [
      'task runners',
      [
        'Makefile',
        'rules.mk',
        'justfile',
        'Taskfile.yml',
        'Rakefile',
        'gulpfile.js',
        'turbo.json',
        'nx.json',
        'nodemon.json',
      ],
    ],
    [
      'git hooks',
      [
        '.git/hooks/pre-commit',
        '.githooks/pre-commit',
        '.husky/pre-push',
        '.pre-commit-config.yaml',
        'lefthook.yml',
        'lefthook-local.yml',
        'simple-git-hooks.json',
        'lint-staged.config.js',
      ],
    ],
    ['dependencies', ['node_modules/react/index.js', 'apps/web/node_modules/zod/index.js']],
  ]
  for (const [group, paths] of sensitive) {
    test.each(paths)(`${group}: an edit to %s`, async (path) => {
      expect(await decide(edit(path), 'ask')).toBeNull()
      // The permission card marks the same files (`sensitive`).
      expect(SENSITIVE_PATH.test(path)).toBe(true)
    })
  }

  const changes: Array<[what: string, asked: Asked]> = [
    ['deleting one', { kind: 'delete', paths: ['package.json'] }],
    ['moving a file onto one', { kind: 'move', paths: ['src/app.tsx', 'scripts/app.tsx'] }],
  ]
  test.each(changes)('%s', async (_what, asked) => {
    expect(await decide(asked, 'ask')).toBeNull()
  })

  // Ordinary content stays automatic in Ask, or every edit would ask. JSON and YAML are sensitive
  // by name, never by extension, and a source file named after a tool is a source file.
  const ordinary = [
    'src/app.tsx',
    'src/components/Button.tsx',
    'src/styles/app.css',
    'README.md',
    'content/about.md',
    'public/logo.svg',
    'public/robots.txt',
    // Data and copy in the formats config is also written in.
    'src/data/products.json',
    'src/data/config.json',
    'locales/en.json',
    'locales/en/compose.json',
    'public/manifest.json',
    'content/post.yaml',
    'src/i18n/messages.yml',
    'openapi.yaml',
    // Names that only look like a sensitive one.
    'src/config.ts',
    'src/app-config.ts',
    'src/config/site.ts',
    'src/lib/scripts.ts',
    'src/bin.ts',
    'src/package.json.ts',
    'src/lockfile.ts',
    'src/lock.ts',
    'src/requirements.ts',
    'src/setup.ts',
    'src/pages/profile.tsx',
    'src/models/workspace.ts',
    'src/hooks/use-workspace.ts',
    'src/components/compose.tsx',
    'src/lib/docker.ts',
    'src/dockerfile-parser.ts',
    'src/lib/firebase.ts',
    'src/lib/vercel.ts',
    'src/utils/render.ts',
    'src/data/render.json',
    'src/turbo.ts',
    // Pages about a sensitive file.
    'docs/install.sh.md',
    'docs/vite.config.md',
    'docs/docker-compose.md',
    'docs/requirements.md',
  ]
  test.each(ordinary)('an ordinary file is not one: %s', async (path) => {
    expect(SENSITIVE_PATH.test(path)).toBe(false)
    expect(await decide(edit(path), 'ask')).toBe('once')
  })
})

describe('flaggedCaution: the agent itself says a person should decide', () => {
  const cases: Array<[what: string, asked: Asked, flagged: boolean]> = [
    ['"no" is its first option', { options: [NO, ONCE, ALWAYS] }, true],
    ['"never" is its first option', { options: [NEVER, ONCE] }, true],
    ["Gui's own question cards, which put Skip first", { options: QUESTION }, true],
    ['Claude offers no "always allow"', { agentId: 'claude', options: [ONCE, NO] }, true],
    ['Claude with its usual options', { agentId: 'claude' }, false],
    ['another agent that never offers "always allow"', { options: [ONCE, NO] }, false],
    ['the usual options', {}, false],
  ]
  test.each(cases)('%s', (_what, asked, flagged) => {
    expect(flaggedCaution(request(asked), asked.agentId ?? 'codex')).toBe(flagged)
  })
})

describe('requestPaths: the files a request names', () => {
  const cases: Array<[what: string, asked: Asked, paths: string[]]> = [
    ['its locations', { paths: ['src/a.ts', 'src/b.ts'] }, ['src/a.ts', 'src/b.ts']],
    [
      'its locations, not its input, when it has both',
      { paths: ['a.ts'], input: { path: 'b.ts' } },
      ['a.ts'],
    ],
    ['`path` in the input', { input: { path: 'a.ts' } }, ['a.ts']],
    ['`file_path` in the input', { input: { file_path: 'a.ts' } }, ['a.ts']],
    ['`filePath` in the input', { input: { filePath: 'a.ts' } }, ['a.ts']],
    ['`notebook_path` in the input', { input: { notebook_path: 'a.ipynb' } }, ['a.ipynb']],
    [
      'every path field the input has',
      { input: { path: 'a.ts', file_path: 'b.ts' } },
      ['a.ts', 'b.ts'],
    ],
    ['the input when locations are empty', { paths: [], input: { path: 'a.ts' } }, ['a.ts']],
    ['nothing from a field that is empty or not text', { input: { path: '', file_path: 7 } }, []],
    ['nothing from other fields', { input: { command: 'cat a.ts', cwd: '/tmp' } }, []],
    ['nothing from a list', { input: ['a.ts'] }, []],
    ['nothing from text', { input: 'a.ts' }, []],
    ['nothing from no input', {}, []],
  ]
  test.each(cases)('%s', (_what, asked, paths) => {
    expect(requestPaths(request(asked))).toEqual(paths)
  })
})

describe('Auto is on for a project unless the user switched it off there', () => {
  test('every project starts in Auto, and switching one to Ask leaves the others', () => {
    const one = join(base, 'proj')
    const other = join(base, 'proj-other')
    expect(isAutoApprove(one)).toBe(true)
    expect(isAutoApprove(other)).toBe(true)

    setAutoApprove(one, false)
    expect(isAutoApprove(one)).toBe(false)
    expect(isAutoApprove(other)).toBe(true)
    expect(isAutoApprove(join(one, 'apps/web'))).toBe(true)

    // Asking twice is the same as once, and Auto again forgets the project.
    setAutoApprove(one, false)
    setAutoApprove(other, false)
    setAutoApprove(one, true)
    setAutoApprove(one, true)
    expect(isAutoApprove(one)).toBe(true)
    expect(isAutoApprove(other)).toBe(false)
    setAutoApprove(other, true)
    expect(isAutoApprove(other)).toBe(true)
  })
})
