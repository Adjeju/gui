import { expect, test } from 'bun:test'
import { RendererExits } from '../src/main/renderer-exits'

const WAIT = 20
const settled = () => new Promise((resolve) => setTimeout(resolve, WAIT * 3))
const SIGTERM = { reason: 'killed', exitCode: 15 }

function setup() {
  const reports: string[] = []
  const recovered: string[] = []
  let ending = false
  const exits = new RendererExits(
    (message) => reports.push(message),
    () => ending,
    WAIT,
  )
  const gone = (page: string, details: { reason: string; exitCode: number }) =>
    exits.gone(page, details, () => recovered.push(page))
  return { reports, recovered, gone, end: () => (ending = true) }
}

test('a crash or running out of memory is reported at once and the page comes back', () => {
  const { reports, recovered, gone } = setup()
  gone('index.html', { reason: 'crashed', exitCode: 11 })
  gone('chat.html', { reason: 'oom', exitCode: 0 })
  expect(reports).toEqual([
    'index.html renderer gone (crashed, exit code 11)',
    'chat.html renderer gone (oom, exit code 0)',
  ])
  expect(recovered).toEqual(['index.html', 'chat.html'])
})

test('one renderer killed by SIGTERM on its own is still reported', async () => {
  const { reports, recovered, gone } = setup()
  gone('chat.html', SIGTERM)
  expect(reports).toEqual([])
  await settled()
  expect(reports).toEqual(['chat.html renderer gone (killed, exit code 15)'])
  expect(recovered).toEqual(['chat.html'])
})

test('every renderer killed by SIGTERM together is the system ending Gui, not a crash', async () => {
  const { reports, recovered, gone } = setup()
  for (const page of ['index.html', 'chat.html', 'pick.html', 'guides.html', 'blank'])
    gone(page, SIGTERM)
  await settled()
  expect(reports).toEqual([])
  // Gui itself goes on, so its pages come back.
  expect(recovered).toEqual(['index.html', 'chat.html', 'pick.html', 'guides.html', 'blank'])
})

test('a SIGTERM followed by the quit is neither reported nor reloaded', async () => {
  const { reports, recovered, gone, end } = setup()
  gone('index.html', SIGTERM)
  end()
  await settled()
  expect(reports).toEqual([])
  expect(recovered).toEqual([])
})

test('nothing that goes away while Gui is quitting is reported', () => {
  const { reports, recovered, gone, end } = setup()
  end()
  gone('index.html', { reason: 'crashed', exitCode: 11 })
  gone('chat.html', SIGTERM)
  expect(reports).toEqual([])
  expect(recovered).toEqual([])
})
