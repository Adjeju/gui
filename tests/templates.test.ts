import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTemplate } from '../src/main/templates'
import { kitProjectCss, STYLE_KITS } from '../src/shared/style-kits'

const soft = STYLE_KITS.find((kit) => kit.id === 'soft') ?? STYLE_KITS[0]
const dirs: string[] = []
const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gui-template-'))
  dirs.push(dir)
  return dir
}
afterEach(() => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))))

for (const template of ['website', 'dashboard'] as const) {
  test(`${template} starter takes its colors from the kit`, async () => {
    const dir = await tmp()
    await writeTemplate(dir, template, 'Demo', 'soft')
    expect(await readFile(join(dir, 'src/index.css'), 'utf8')).toBe(kitProjectCss(soft))
    const app = await readFile(join(dir, 'src/App.jsx'), 'utf8')
    expect(app).not.toMatch(/(zinc|indigo|slate|gray)-\d|bg-white|text-white|text-black/)
    expect(app).toContain('bg-primary')
  })
}

test('an unknown kit id falls back to Neutral', async () => {
  const dir = await tmp()
  await writeTemplate(dir, 'website', 'Demo', 'nope' as never)
  expect(await readFile(join(dir, 'src/index.css'), 'utf8')).toBe(kitProjectCss(STYLE_KITS[0]))
})

test('no starter uses bg-accent without text-accent-foreground', async () => {
  for (const template of ['website', 'dashboard'] as const) {
    const dir = await tmp()
    await writeTemplate(dir, template, 'Demo', 'soft')
    const app = await readFile(join(dir, 'src/App.jsx'), 'utf8')
    for (const [, classes] of app.matchAll(/className=["'{`]([^"'}`]*)/g))
      if (/(^|[\s:])bg-accent\b/.test(classes)) expect(classes).toContain('text-accent-foreground')
    for (const [, classes] of app.matchAll(/'([^']*\bbg-accent\b[^']*)'/g))
      expect(classes).toContain('text-accent-foreground')
  }
})

test('blank writes no files', async () => {
  const dir = await tmp()
  await writeTemplate(dir, 'blank', 'Demo', 'soft')
  expect(await readdir(dir)).toEqual([])
})
