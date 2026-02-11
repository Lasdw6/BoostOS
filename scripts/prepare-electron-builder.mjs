import { promises as fs } from 'node:fs'
import path from 'node:path'

const cwd = process.cwd()
const nodeModulesDir = path.join(cwd, 'node_modules')
const viteCacheDir = path.join(nodeModulesDir, '.vite')
const releaseNodeModulesDir = path.join(cwd, '.release-node_modules')
const repoRoot = path.resolve(cwd, '..', '..')
const rootNodeModulesDir = path.join(repoRoot, 'node_modules')

async function removeViteCache() {
  try {
    await fs.rm(viteCacheDir, { recursive: true, force: true })
    console.log(`[prepare-electron-builder] Removed ${viteCacheDir}`)
  } catch (error) {
    console.warn('[prepare-electron-builder] Failed to remove .vite cache:', error)
  }
}

async function removeNamelessPackageJsonFiles(rootDir) {
  let removed = 0

  async function walk(dir) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
          return
        }

        if (!entry.isFile() || entry.name !== 'package.json') return

        try {
          const raw = await fs.readFile(fullPath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (!parsed?.name) {
            await fs.unlink(fullPath)
            removed += 1
          }
        } catch {
          // Ignore unreadable/invalid files
        }
      })
    )
  }

  await walk(rootDir)
  return removed
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function backfillRequiredRuntimeDeps() {
  const required = ['extract-file-icon', 'node-gyp-build', 'node-addon-api']
  let copied = 0
  for (const dep of required) {
    const localPath = path.join(nodeModulesDir, dep)
    if (await pathExists(localPath)) continue
    const rootPath = path.join(rootNodeModulesDir, dep)
    if (!(await pathExists(rootPath))) continue
    await fs.cp(rootPath, localPath, { recursive: true, dereference: true })
    copied += 1
    console.log(`[prepare-electron-builder] Backfilled runtime dep: ${dep}`)
  }
  if (copied === 0) {
    console.log('[prepare-electron-builder] No runtime dep backfill needed')
  }
}

async function backfillProductionDependencies() {
  const pkgPath = path.join(cwd, 'package.json')
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
  const rootDeps = Object.keys(pkg.dependencies || {})
  const visited = new Set()
  let copied = 0

  async function ensureDependency(name) {
    if (visited.has(name)) return
    visited.add(name)

    const localPath = path.join(nodeModulesDir, name)
    if (!(await pathExists(localPath))) {
      const rootPath = path.join(rootNodeModulesDir, name)
      if (!(await pathExists(rootPath))) return
      await fs.cp(rootPath, localPath, { recursive: true, dereference: true })
      copied += 1
      console.log(`[prepare-electron-builder] Backfilled dependency: ${name}`)
    }

    try {
      const depPkgPath = path.join(localPath, 'package.json')
      const depPkg = JSON.parse(await fs.readFile(depPkgPath, 'utf-8'))
      for (const child of Object.keys(depPkg.dependencies || {})) {
        await ensureDependency(child)
      }
    } catch {
      // ignore missing/invalid package metadata
    }
  }

  for (const dep of rootDeps) {
    await ensureDependency(dep)
  }

  if (copied === 0) {
    console.log('[prepare-electron-builder] No production dependency backfill needed')
  }
}

async function materializeSlimReleaseNodeModules() {
  const pkgPath = path.join(cwd, 'package.json')
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'))
  const rootDeps = Object.keys(pkg.dependencies || {})
  const visited = new Set()
  let copied = 0

  await fs.rm(releaseNodeModulesDir, { recursive: true, force: true })
  await fs.mkdir(releaseNodeModulesDir, { recursive: true })

  async function includeDependency(name) {
    if (visited.has(name)) return
    visited.add(name)

    const localPath = path.join(nodeModulesDir, name)
    if (!(await pathExists(localPath))) return

    const releasePath = path.join(releaseNodeModulesDir, name)
    await fs.mkdir(path.dirname(releasePath), { recursive: true })
    await fs.cp(localPath, releasePath, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const normalized = src.replaceAll('\\', '/')
        if (normalized.includes('/.vite/')) return false
        if (normalized.includes('/.cache/')) return false
        if (normalized.endsWith('/.vite')) return false
        return true
      }
    })
    copied += 1

    try {
      const depPkgPath = path.join(localPath, 'package.json')
      const depPkg = JSON.parse(await fs.readFile(depPkgPath, 'utf-8'))
      for (const child of Object.keys(depPkg.dependencies || {})) {
        await includeDependency(child)
      }
    } catch {
      // ignore missing/invalid package metadata
    }
  }

  for (const dep of rootDeps) {
    await includeDependency(dep)
  }

  console.log(
    `[prepare-electron-builder] Materialized slim release node_modules at ${releaseNodeModulesDir} (${copied} package roots)`
  )
}

async function main() {
  await removeViteCache()
  await backfillProductionDependencies()
  await backfillRequiredRuntimeDeps()
  await materializeSlimReleaseNodeModules()

  const removed = await removeNamelessPackageJsonFiles(nodeModulesDir)
  if (removed > 0) {
    console.log(`[prepare-electron-builder] Removed ${removed} nameless package.json file(s)`)
  } else {
    console.log('[prepare-electron-builder] No nameless package.json files found')
  }
}

await main()
