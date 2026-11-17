import { afterEach, expect, test } from 'bun:test'
import {
  ASK_FIRST_TOOLS,
  GUI_TOOL_TITLES,
  type RunningMcpServer,
  sessionToolNames,
  startMcpServer,
} from '../src/main/mcp-server'

// Each tab serves Gui's tools to its agent over MCP on loopback (docs/architecture.md,
// "Preview tools for the agent"). The server listens before the MCP SDK has loaded, so a
// project opening doesn't wait the tens of milliseconds that takes; the first call does.

/** Nothing here calls a tool: the server only has to list them. */
const unused = {} as never

type McpConfig = ReturnType<ReturnType<RunningMcpServer['session']>['config']>

const servers: RunningMcpServer[] = []
async function start() {
  const server = await startMcpServer(unused, unused, unused)
  servers.push(server)
  return server.session().config()
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Where the agent is told to call, and the token it's told to send. */
function endpoint(config: McpConfig) {
  if (!('url' in config)) throw new Error('Gui serves its tools over HTTP')
  const headers = Object.fromEntries(config.headers.map((header) => [header.name, header.value]))
  return { url: config.url, headers }
}

function call(
  config: McpConfig,
  method: string,
  headers: Record<string, string> = endpoint(config).headers,
) {
  return fetch(endpoint(config).url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params:
        method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'test', version: '1' },
            }
          : {},
    }),
  })
}
test('the first call is answered, and lists the tools', async () => {
  const config = await start()
  const hello = await call(config, 'initialize')
  expect(hello.status).toBe(200)
  expect((await hello.json()).result.serverInfo.name).toBe('gui')

  const listed = await call(config, 'tools/list')
  const names = (await listed.json()).result.tools.map((tool: { name: string }) => tool.name)
  expect(names).toContain('preview_screenshot')
  expect(names).toContain('dev_server_logs')
  expect(names).not.toContain('dev_server_status')
  expect(names).not.toContain('canvas_list_frames')
})

test('calls arriving together while nothing has loaded yet are all answered', async () => {
  const config = await start()
  const answers = await Promise.all([1, 2, 3].map(() => call(config, 'tools/list')))
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
})

test('only the token Gui gave its agent gets in', async () => {
  const config = await start()
  expect((await call(config, 'tools/list', {})).status).toBe(401)
  expect((await call(config, 'tools/list', { Authorization: 'Bearer nope' })).status).toBe(401)
  const { url, headers } = endpoint(config)
  expect((await fetch(url, { headers })).status).toBe(405)
})

async function listed(config: McpConfig) {
  const reply = await call(config, 'tools/list')
  return (await reply.json()).result.tools as { name: string; title: string }[]
}

test('a canvas lists its own tools and none that need a dev server, rulers or websites', async () => {
  const project = await listed(await start())
  const canvasServer = await startMcpServer(unused, unused, unused, unused)
  servers.push(canvasServer)
  const canvas = await listed(canvasServer.session().config())

  // What each session is told it has is what it gets.
  expect(project.map((tool) => tool.name).sort()).toEqual(sessionToolNames(false).sort())
  expect(canvas.map((tool) => tool.name).sort()).toEqual(sessionToolNames(true).sort())
  for (const name of [
    'dev_server_logs',
    'dev_server_restart',
    'set_start_command',
    'preview_open_website',
    'preview_back',
    'preview_guides',
    'preview_variations',
  ]) {
    expect(canvas.map((tool) => tool.name)).not.toContain(name)
  }
  expect(canvas.map((tool) => tool.name)).toContain('canvas_list_frames')
  expect(canvas.map((tool) => tool.name)).toContain('preview_navigate')
  expect(canvas.map((tool) => tool.name)).toContain('preview_wait')
  expect(canvas.map((tool) => tool.name)).toContain('canvas_section')

  // Every tool registers under the title the chat labels it with.
  for (const tool of [...project, ...canvas]) {
    expect(tool.title).toBe(GUI_TOOL_TITLES[tool.name as keyof typeof GUI_TOOL_TITLES])
  }
})

test('opening a website is its own tool, which asks first', async () => {
  const names = (await listed(await start())).map((tool) => tool.name)
  expect(names).toContain('preview_open_website')
  expect(ASK_FIRST_TOOLS.has('preview_open_website')).toBe(true)
  expect(ASK_FIRST_TOOLS.has('preview_navigate')).toBe(false)
})

test("a session that can't open websites is served every tool but that one", async () => {
  const server = await startMcpServer(unused, unused, unused)
  servers.push(server)
  const session = server.session()
  const all = (await listed(session.config())).map((tool) => tool.name)
  const without = (await listed(session.config(false))).map((tool) => tool.name)
  expect(without.sort()).toEqual(sessionToolNames(false, false).sort())
  expect(without).not.toContain('preview_open_website')
  expect(all.filter((name) => name !== 'preview_open_website').sort()).toEqual(without)
  // The same token; only that session's own address.
  expect(endpoint(session.config(false)).headers).toEqual(endpoint(session.config()).headers)
  const elsewhere = {
    ...session.config(),
    url: endpoint(session.config()).url.replace('/mcp', '/other'),
  }
  expect((await call(elsewhere, 'tools/list')).status).toBe(401)
})

test('each session has its own token, and tells only of its own first request', async () => {
  const server = await startMcpServer(unused, unused, unused)
  servers.push(server)
  const reached: string[] = []
  const one = server.session(() => reached.push('one'))
  const two = server.session(() => reached.push('two'))
  expect(endpoint(one.config()).headers).not.toEqual(endpoint(two.config()).headers)

  await listed(one.config())
  await listed(one.config())
  expect(reached).toEqual(['one'])

  // A token that's wrong, or revoked as its session stopped, reaches nothing.
  const wrong = { ...endpoint(two.config()).headers, Authorization: 'Bearer nope' }
  expect((await call(two.config(), 'tools/list', wrong)).status).toBe(401)
  two.close()
  expect((await call(two.config(), 'tools/list')).status).toBe(401)
  expect(reached).toEqual(['one'])
})
