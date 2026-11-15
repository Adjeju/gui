import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const LINUX_LAUNCHER_PREFIX = '#!/bin/sh\nGUI_EXECUTABLE='

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`

async function isGuiLauncher(target: string) {
  const existing = await lstat(target).catch(() => null)
  if (!existing) return null
  if (!existing.isFile()) return false
  const content = await readFile(target, 'utf8').catch(() => '')
  return content.startsWith(LINUX_LAUNCHER_PREFIX)
}

export async function installLinuxLauncher({
  target,
  executable,
  script,
  confirmReplace,
}: {
  target: string
  executable: string
  script: string
  confirmReplace: () => Promise<boolean>
}): Promise<boolean> {
  const ours = await isGuiLauncher(target)
  if (ours === false && !(await confirmReplace())) return false
  const body = (await readFile(script, 'utf8')).replace(/^#!.*\n/, '')
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  try {
    await writeFile(
      temporary,
      `${LINUX_LAUNCHER_PREFIX}${quote(executable)}\nexport GUI_EXECUTABLE\n${body}`,
      { mode: 0o755 },
    )
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
  return true
}
