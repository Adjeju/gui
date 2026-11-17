import { expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Every name src/ imports from Electron is one the run's Electron stand-in has
// (tests/electron-stand-in.ts), so no test file's own stand-in decides what the others
// can import, whatever order the files run in.
test('the Electron stand-in names every Electron export src/ imports', async () => {
  const used = new Set<string>()
  const src = join(import.meta.dirname, '..', 'src')
  for (const file of await readdir(src, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue
    const source = await readFile(join(src, file), 'utf8')
    for (const [statement, clause = ''] of source.matchAll(
      /import\s+([^'"]*?)\s*from\s*'electron(?:\/[\w-]+)?'/g,
    )) {
      // Only `import { … } from 'electron'` is read; another form needs this test taught it.
      expect({ file, statement }).toEqual({
        file,
        statement: expect.stringMatching(/^import (type )?\{/),
      })
      if (clause.startsWith('type ')) continue
      for (const part of clause.slice(1, -1).split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]
        if (name && !name.startsWith('type ')) used.add(name)
      }
    }
  }
  expect(used.has('app')).toBe(true)
  const named = Object.keys(await import('electron'))
  expect([...used].filter((name) => !named.includes(name))).toEqual([])
})
