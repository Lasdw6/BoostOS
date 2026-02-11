import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

function parseLatestYml(raw) {
  const pathMatch = raw.match(/^path:\s*(.+)$/m)
  const versionMatch = raw.match(/^version:\s*(.+)$/m)
  return {
    path: pathMatch?.[1]?.trim() || null,
    version: versionMatch?.[1]?.trim() || null
  }
}

function sha256File(filePath) {
  const data = readFileSync(filePath)
  return createHash('sha256').update(data).digest('hex')
}

function getAuthenticodeStatus(filePath) {
  if (process.platform !== 'win32') {
    return { status: 'SKIPPED', signer: 'N/A', timestamp: 'N/A' }
  }

  const escapedPath = filePath.replace(/'/g, "''")
  const script = [
    `$sig = Get-AuthenticodeSignature -FilePath '${escapedPath}'`,
    '$subject = ""',
    '$timestamp = ""',
    'if ($sig.SignerCertificate -and $sig.SignerCertificate.Subject) { $subject = $sig.SignerCertificate.Subject }',
    'if ($sig.TimeStamperCertificate -and $sig.TimeStamperCertificate.Subject) { $timestamp = $sig.TimeStamperCertificate.Subject }',
    '[PSCustomObject]@{status=[string]$sig.Status;signer=$subject;timestamp=$timestamp} | ConvertTo-Json -Compress'
  ].join('; ')

  const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
    encoding: 'utf-8'
  })

  if (result.status !== 0) {
    return { status: 'ERROR', signer: result.stderr?.trim() || 'unknown', timestamp: 'N/A' }
  }

  try {
    const parsed = JSON.parse(String(result.stdout || '').trim())
    const status = String(parsed?.status || '').trim() || 'UNKNOWN'
    const signer = String(parsed?.signer || '').trim() || 'N/A'
    const timestamp = String(parsed?.timestamp || '').trim() || 'N/A'
    return { status, signer, timestamp }
  } catch {
    return { status: 'UNKNOWN', signer: 'N/A', timestamp: 'N/A' }
  }
}

function main() {
  const distDir = resolve(process.cwd(), 'dist')
  const latestYmlPath = resolve(distDir, 'latest.yml')
  const directArtifactPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : null

  let artifactPath = directArtifactPath
  let version = null

  if (!artifactPath) {
    if (!existsSync(latestYmlPath)) {
      console.error('[verify-win-installer] Missing dist/latest.yml')
      process.exit(1)
    }
    const latest = parseLatestYml(readFileSync(latestYmlPath, 'utf-8'))
    if (!latest.path) {
      console.error('[verify-win-installer] Could not resolve artifact path from dist/latest.yml')
      process.exit(1)
    }
    version = latest.version
    artifactPath = resolve(dirname(latestYmlPath), latest.path)
  }

  if (!existsSync(artifactPath)) {
    console.error(`[verify-win-installer] Artifact not found: ${artifactPath}`)
    process.exit(1)
  }

  const sha256 = sha256File(artifactPath)
  const signature = getAuthenticodeStatus(artifactPath)

  console.log(`[verify-win-installer] Artifact: ${artifactPath}`)
  if (version) console.log(`[verify-win-installer] Version: ${version}`)
  console.log(`[verify-win-installer] SHA256: ${sha256}`)
  console.log(`[verify-win-installer] Signature status: ${signature.status}`)
  console.log(`[verify-win-installer] Signer: ${signature.signer}`)
  console.log(`[verify-win-installer] Timestamp signer: ${signature.timestamp}`)

  const allowUnsigned = process.env.ALLOW_UNSIGNED_INSTALLER === '1'
  if (process.platform === 'win32' && signature.status !== 'Valid' && !allowUnsigned) {
    console.error(
      '[verify-win-installer] Installer is not Authenticode Valid. Set ALLOW_UNSIGNED_INSTALLER=1 to bypass.'
    )
    process.exit(1)
  }
}

main()
