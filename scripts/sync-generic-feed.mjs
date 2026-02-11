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

function parseLatestYml(raw) {
  const version = raw.match(/^version:\s*(.+)$/m)?.[1]?.trim() || null
  const artifact = raw.match(/^path:\s*(.+)$/m)?.[1]?.trim() || null
  return { version, artifact }
}

async function main() {
  const desktopDir = process.cwd()
  const distDir = path.join(desktopDir, 'dist')
  const latestYmlPath = path.join(distDir, 'latest.yml')
  const targetDir = path.resolve(desktopDir, '..', 'web', 'public', 'downloads')

  if (!(await pathExists(latestYmlPath))) {
    throw new Error(`Missing ${latestYmlPath}. Build a Windows release first.`)
  }

  const latestRaw = await fs.readFile(latestYmlPath, 'utf-8')
  const latest = parseLatestYml(latestRaw)
  if (!latest.artifact) {
    throw new Error('Could not resolve installer filename from dist/latest.yml')
  }

  const artifactPath = path.join(distDir, latest.artifact)
  const blockmapPath = `${artifactPath}.blockmap`
  if (!(await pathExists(artifactPath))) {
    throw new Error(`Missing installer artifact: ${artifactPath}`)
  }
  if (!(await pathExists(blockmapPath))) {
    throw new Error(`Missing blockmap artifact: ${blockmapPath}`)
  }

  await fs.mkdir(targetDir, { recursive: true })

  const entries = await fs.readdir(targetDir)
  for (const entry of entries) {
    const lower = entry.toLowerCase()
    if (
      /^boostos-.*-setup\.exe(\.blockmap)?$/.test(lower) ||
      lower === 'latest.yml' ||
      lower === 'latest-mac.yml' ||
      lower === 'latest-linux.yml'
    ) {
      await fs.rm(path.join(targetDir, entry), { force: true })
    }
  }

  await fs.copyFile(latestYmlPath, path.join(targetDir, 'latest.yml'))
  await fs.copyFile(artifactPath, path.join(targetDir, path.basename(artifactPath)))
  await fs.copyFile(blockmapPath, path.join(targetDir, path.basename(blockmapPath)))

  console.log(`[sync-generic-feed] Synced Windows feed artifacts to ${targetDir}`)
  console.log(`[sync-generic-feed] Version: ${latest.version || 'unknown'}`)
  console.log(`[sync-generic-feed] Installer: ${path.basename(artifactPath)}`)
}

await main()
