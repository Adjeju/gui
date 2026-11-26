import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { kitProjectCss, STYLE_KITS } from '../src/shared/style-kits'
import { waitFor } from './helpers/env'
import { expect, test } from './helpers/test'

// The New project form picks a style kit; the new project's src/index.css is that kit's.
test('a new website project takes the chosen style kit', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'gui-kit-')))
  await session.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (() =>
      Promise.resolve({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog
  }, parent)

  await chrome.getByRole('button', { name: /New project/ }).click()
  await chrome.getByRole('button', { name: 'Editorial', exact: true }).click()
  await expect(chrome.getByRole('button', { name: 'Editorial', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await chrome.getByRole('textbox').fill('kit-demo')
  await session.shot('project-form')
  await chrome.getByRole('textbox').press('Enter')

  const css = join(parent, 'kit-demo', 'src', 'index.css')
  await waitFor(() => existsSync(css), 'the new project')
  const editorial = STYLE_KITS.find((kit) => kit.id === 'editorial') ?? STYLE_KITS[0]
  expect(readFileSync(css, 'utf8')).toBe(kitProjectCss(editorial))
})
