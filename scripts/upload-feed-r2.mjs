import { promises as fs } from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3'

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

async function loadEnvFiles() {
  const envPaths = [path.join(process.cwd(), '.env.publish'), path.join(process.cwd(), '.env')]
  for (const envPath of envPaths) {
    if (await pathExists(envPath)) {
      dotenv.config({ path: envPath, override: false })
    }
  }
}

function getRequiredEnv(name) {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value.trim()
}

function normalizePrefix(prefix) {
  if (!prefix) return ''
  return prefix.replace(/^\/+|\/+$/g, '')
}

function joinKey(prefix, filename) {
  return prefix ? `${prefix}/${filename}` : filename
}

function contentTypeForFile(filename) {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'text/yaml; charset=utf-8'
  if (lower.endsWith('.exe')) return 'application/octet-stream'
  if (lower.endsWith('.blockmap')) return 'application/octet-stream'
  return 'application/octet-stream'
}

function cacheControlForFile(filename) {
  const lower = filename.toLowerCase()
  if (lower === 'latest.yml') return 'no-store, max-age=0'
  return 'public, max-age=31536000, immutable'
}

function parseVersionFromInstallerKey(key) {
  const match = key.match(/BoostOS-([0-9]+\.[0-9]+\.[0-9]+)-setup\.exe$/i)
  return match?.[1] || null
}

function compareSemver(a, b) {
  const aParts = a.split('.').map((p) => Number.parseInt(p, 10))
  const bParts = b.split('.').map((p) => Number.parseInt(p, 10))
  for (let i = 0; i < 3; i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function keyBasename(key) {
  const idx = key.lastIndexOf('/')
  return idx >= 0 ? key.slice(idx + 1) : key
}

async function listKeys(client, bucket, prefix) {
  const keys = []
  let continuationToken = undefined

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken
      })
    )
    for (const item of res.Contents || []) {
      if (item.Key) keys.push(item.Key)
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (continuationToken)

  return keys
}

function computeRetentionDeletes(keys, keepCount) {
  const installerKeys = keys.filter((k) => /BoostOS-[0-9]+\.[0-9]+\.[0-9]+-setup\.exe$/i.test(k))

  const versions = new Set()
  for (const key of installerKeys) {
    const version = parseVersionFromInstallerKey(keyBasename(key))
    if (version) versions.add(version)
  }

  const sortedVersions = Array.from(versions).sort((a, b) => compareSemver(b, a))
  const keepVersions = new Set(sortedVersions.slice(0, keepCount))
  const deleteVersions = new Set(sortedVersions.slice(keepCount))

  const toDelete = keys.filter((k) => {
    const base = keyBasename(k)
    const installerVersion = parseVersionFromInstallerKey(base)
    if (installerVersion && deleteVersions.has(installerVersion)) return true
    const blockmapMatch = base.match(/BoostOS-([0-9]+\.[0-9]+\.[0-9]+)-setup\.exe\.blockmap$/i)
    if (blockmapMatch?.[1] && deleteVersions.has(blockmapMatch[1])) return true
    return false
  })

  return { toDelete, keepVersions: Array.from(keepVersions), deleteVersions: Array.from(deleteVersions) }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  await loadEnvFiles()

  const accountId = getRequiredEnv('R2_ACCOUNT_ID')
  const accessKeyId = getRequiredEnv('R2_ACCESS_KEY_ID')
  const secretAccessKey = getRequiredEnv('R2_SECRET_ACCESS_KEY')
  const bucket = getRequiredEnv('R2_BUCKET')
  const prefix = normalizePrefix(process.env.R2_PREFIX || 'downloads')
  const publicBaseUrl = (process.env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '')

  const desktopDir = process.cwd()
  const distDir = path.join(desktopDir, 'dist')
  const latestYmlPath = path.join(distDir, 'latest.yml')

  if (!(await pathExists(latestYmlPath))) {
    throw new Error(`Missing ${latestYmlPath}. Build/publish Windows first.`)
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

  const files = [
    { path: latestYmlPath, key: joinKey(prefix, 'latest.yml') },
    { path: artifactPath, key: joinKey(prefix, path.basename(artifactPath)) },
    { path: blockmapPath, key: joinKey(prefix, path.basename(blockmapPath)) }
  ]

  if (dryRun) {
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey }
    })
    const existingKeys = await listKeys(client, bucket, prefix ? `${prefix}/` : '')
    const retention = computeRetentionDeletes(existingKeys, 3)

    console.log('[upload-feed-r2] Dry run mode enabled.')
    console.log(`[upload-feed-r2] Bucket: ${bucket}`)
    for (const file of files) {
      console.log(`[upload-feed-r2] Would upload ${file.path} -> s3://${bucket}/${file.key}`)
    }
    console.log(
      `[upload-feed-r2] Retention keep versions (newest 3): ${retention.keepVersions.join(', ') || '(none)'}`
    )
    for (const key of retention.toDelete) {
      console.log(`[upload-feed-r2] Would delete s3://${bucket}/${key}`)
    }
    return
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  })

  for (const file of files) {
    const body = await fs.readFile(file.path)
    const filename = path.basename(file.path)
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: file.key,
        Body: body,
        ContentType: contentTypeForFile(filename),
        CacheControl: cacheControlForFile(filename)
      })
    )
    console.log(`[upload-feed-r2] Uploaded s3://${bucket}/${file.key}`)
  }

  const existingKeys = await listKeys(client, bucket, prefix ? `${prefix}/` : '')
  const retention = computeRetentionDeletes(existingKeys, 3)
  if (retention.toDelete.length > 0) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: retention.toDelete.map((key) => ({ Key: key })),
          Quiet: true
        }
      })
    )
    console.log(
      `[upload-feed-r2] Retention applied. Kept newest 3 versions: ${retention.keepVersions.join(', ')}`
    )
    console.log(`[upload-feed-r2] Deleted ${retention.toDelete.length} old object(s).`)
  } else {
    console.log('[upload-feed-r2] Retention applied. No old versions to delete.')
  }

  if (publicBaseUrl) {
    const latestUrl = `${publicBaseUrl}/${joinKey(prefix, 'latest.yml')}`
    try {
      const res = await fetch(latestUrl, { method: 'GET' })
      console.log(`[upload-feed-r2] Public check ${latestUrl} -> ${res.status}`)
    } catch (error) {
      console.warn('[upload-feed-r2] Public URL check failed:', error)
    }
  }

  console.log(`[upload-feed-r2] Version uploaded: ${latest.version || 'unknown'}`)
}

await main()
