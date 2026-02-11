import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'

const projectDir = process.cwd()
const repoRoot = path.resolve(projectDir, '..', '..')
const bunLockPath = path.join(repoRoot, 'bun.lock')
const bunLockBackupPath = path.join(repoRoot, 'bun.lock.__builderbak')
const releaseNodeModulesPath = path.join(projectDir, '.release-node_modules')

const builderArgs = process.argv.length > 2 ? process.argv.slice(2) : ['--win']
const defaultOutputDir = 'dist'
const stagingOutputPrefix = 'dist-staging'

function hasOutputOverride(args) {
  return args.some((arg) => arg.startsWith('--config.directories.output='))
}

function shouldUseStagingOutput(args) {
  return args.includes('--win') && !hasOutputOverride(args)
}

async function copyIfExists(from, to) {
  if (!(await pathExists(from))) return
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.cp(from, to, { force: true, recursive: true })
}

async function syncStagedArtifactsToDist(stagingOutputDirName) {
  const stagingDir = path.join(projectDir, stagingOutputDirName)
  const distDir = path.join(projectDir, defaultOutputDir)

  if (!(await pathExists(stagingDir))) return

  await fs.mkdir(distDir, { recursive: true })

  const entries = await fs.readdir(stagingDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    const shouldCopy =
      lower.endsWith('.exe') ||
      lower.endsWith('.blockmap') ||
      lower === 'latest.yml' ||
      lower === 'builder-debug.yml'
    if (!shouldCopy) continue

    await copyIfExists(path.join(stagingDir, entry.name), path.join(distDir, entry.name))
  }

  await fs.rm(stagingDir, { recursive: true, force: true })
  console.log('[run-electron-builder-safe] Synced staged installer artifacts to dist')
}

async function validateStagedRuntimeModules(stagingOutputDirName) {
  const unpackedDir = path.join(
    projectDir,
    stagingOutputDirName,
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules'
  )
  const resourcesNodeModulesDir = path.join(
    projectDir,
    stagingOutputDirName,
    'win-unpacked',
    'resources',
    'node_modules'
  )

  const betterSqliteCandidates = [
    path.join(unpackedDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    path.join(resourcesNodeModulesDir, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  ]
  const koffiCandidates = [
    path.join(unpackedDir, 'koffi'),
    path.join(resourcesNodeModulesDir, 'koffi')
  ]

  const requiredPaths = [
    { label: 'better-sqlite3', candidates: betterSqliteCandidates },
    { label: 'koffi', candidates: koffiCandidates }
  ]

  for (const required of requiredPaths) {
    let found = false
    for (const candidate of required.candidates) {
      if (await pathExists(candidate)) {
        found = true
        break
      }
    }
    if (!found) {
      throw new Error(
        `[run-electron-builder-safe] Missing packaged runtime dependency (${required.label}). Checked: ${required.candidates.join(', ')}`
      )
    }
  }

  console.log('[run-electron-builder-safe] Validated staged runtime native modules')
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function move(from, to) {
  await fs.rename(from, to)
}

async function loadPublishEnvFiles() {
  const envPaths = [path.join(projectDir, '.env.publish'), path.join(projectDir, '.env')]
  for (const envPath of envPaths) {
    if (await pathExists(envPath)) {
      dotenv.config({ path: envPath, override: false })
    }
  }
}

async function run() {
  await loadPublishEnvFiles()
  const hadBunLock = await pathExists(bunLockPath)
  const useStagingOutput = shouldUseStagingOutput(builderArgs)
  const effectiveArgs = [...builderArgs]
  const stagingOutputDirName = `${stagingOutputPrefix}-${Date.now()}`

  if (useStagingOutput) {
    effectiveArgs.push(`--config.directories.output=${stagingOutputDirName}`)
  }

  try {
    if (await pathExists(bunLockBackupPath)) {
      await fs.rm(bunLockBackupPath, { force: true })
    }

    if (hadBunLock) {
      await move(bunLockPath, bunLockBackupPath)
      console.log('[run-electron-builder-safe] Temporarily moved repo bun.lock')
    }

    const cliPath = path.join(projectDir, 'node_modules', 'electron-builder', 'cli.js')
    const childEnv = { ...process.env }
    childEnv.npm_config_user_agent = 'npm/11.7.0 node/v22.14.0 win32 x64'

    // Bun workspace hints cause electron-builder to fall back to Bun collector.
    delete childEnv.BUN_INSTALL
    delete childEnv.npm_execpath
    delete childEnv.BUN
    delete childEnv.bun
    if (!childEnv.GH_TOKEN && childEnv.GITHUB_TOKEN) {
      childEnv.GH_TOKEN = childEnv.GITHUB_TOKEN
    }

    const result = spawnSync('node', ['--max-old-space-size=8192', cliPath, ...effectiveArgs], {
      cwd: projectDir,
      stdio: 'inherit',
      env: childEnv
    })

    if (result.status !== 0) {
      process.exit(result.status || 1)
    }

    if (useStagingOutput) {
      await validateStagedRuntimeModules(stagingOutputDirName)
      await syncStagedArtifactsToDist(stagingOutputDirName)
    }
  } finally {
    if (await pathExists(releaseNodeModulesPath)) {
      await fs.rm(releaseNodeModulesPath, { recursive: true, force: true })
      console.log('[run-electron-builder-safe] Cleaned .release-node_modules')
    }

    const hasBackup = await pathExists(bunLockBackupPath)
    if (hasBackup) {
      if (await pathExists(bunLockPath)) {
        await fs.rm(bunLockPath, { force: true })
      }
      await move(bunLockBackupPath, bunLockPath)
      console.log('[run-electron-builder-safe] Restored repo bun.lock')
    }
  }
}

await run()
