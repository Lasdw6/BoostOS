import { promises as fs } from 'node:fs'
import path from 'node:path'

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function assertExists(target, label) {
  if (!(await pathExists(target))) {
    throw new Error(`[verify-win-runtime] Missing ${label}: ${target}`)
  }
}

async function assertOneExists(candidates, label) {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  throw new Error(
    `[verify-win-runtime] Missing ${label}. Checked: ${candidates.join(', ')}`
  )
}

async function main() {
  const distDir = path.resolve(process.cwd(), 'dist')
  let unpackedDir = path.join(distDir, 'win-unpacked')
  if (!(await pathExists(unpackedDir))) {
    const projectDir = process.cwd()
    const entries = await fs.readdir(projectDir, { withFileTypes: true })
    const staging = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('dist-staging-'))
      .map((e) => e.name)
      .sort()
      .reverse()
    for (const dir of staging) {
      const candidate = path.join(projectDir, dir, 'win-unpacked')
      if (await pathExists(candidate)) {
        unpackedDir = candidate
        break
      }
    }
  }
  const resourcesDir = path.join(unpackedDir, 'resources')
  const nodeModulesDir = path.join(resourcesDir, 'node_modules')

  await assertExists(unpackedDir, 'unpacked app output')
  await assertExists(path.join(unpackedDir, 'BoostOS.exe'), 'BoostOS.exe')
  await assertExists(path.join(resourcesDir, 'app.asar'), 'app.asar')
  await assertExists(path.join(resourcesDir, 'icon.ico'), 'icon.ico')
  await assertExists(path.join(resourcesDir, 'migrations'), 'migrations directory')

  await assertExists(path.join(nodeModulesDir, 'zod'), 'zod runtime dependency')
  await assertExists(path.join(nodeModulesDir, 'electron-updater'), 'electron-updater runtime dependency')
  await assertExists(path.join(nodeModulesDir, 'koffi'), 'koffi runtime dependency')
  await assertExists(path.join(nodeModulesDir, 'ps-list'), 'ps-list runtime dependency')

  await assertOneExists(
    [
      path.join(nodeModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
      path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    ],
    'better-sqlite3 native binary'
  )

  await assertOneExists(
    [
      path.join(nodeModulesDir, 'koffi', 'build', 'koffi', 'win32_x64', 'koffi.node'),
      path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'koffi', 'build', 'koffi', 'win32_x64', 'koffi.node')
    ],
    'koffi native binary'
  )

  console.log('[verify-win-runtime] Runtime smoke checks passed for win-unpacked.')
}

await main()
