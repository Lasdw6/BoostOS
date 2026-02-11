import https from 'node:https'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import dotenv from 'dotenv'

const owner = 'Lasdw6'
const repo = 'Boost'

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function loadEnvFiles() {
  const envPaths = [path.join(process.cwd(), '.env.publish'), path.join(process.cwd(), '.env')]
  for (const envPath of envPaths) {
    if (await pathExists(envPath)) {
      dotenv.config({ path: envPath, override: false })
    }
  }
}

function githubGet(pathname, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: pathname,
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'boost-release-preflight'
        }
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          let message = ''
          try {
            const parsed = JSON.parse(body)
            message = String(parsed?.message || '')
          } catch {
            message = body.slice(0, 200)
          }
          resolve({
            status: res.statusCode || 0,
            message
          })
        })
      }
    )

    req.on('error', reject)
    req.end()
  })
}

async function main() {
  await loadEnvFiles()

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token) {
    console.error('[check-publish-env] Missing GH_TOKEN/GITHUB_TOKEN.')
    console.error('[check-publish-env] Add token in apps/desktop/.env.publish or environment.')
    process.exit(1)
  }

  const repoCheck = await githubGet(`/repos/${owner}/${repo}`, token)
  if (repoCheck.status !== 200) {
    console.error(
      `[check-publish-env] Cannot access repo ${owner}/${repo}. Status=${repoCheck.status} Message=${repoCheck.message || 'N/A'}`
    )
    console.error(
      '[check-publish-env] Ensure token has access to this repository (fine-grained: repository selected; classic: repo scope).'
    )
    process.exit(1)
  }

  const releasesCheck = await githubGet(`/repos/${owner}/${repo}/releases`, token)
  if (releasesCheck.status !== 200) {
    console.error(
      `[check-publish-env] Cannot access releases API for ${owner}/${repo}. Status=${releasesCheck.status} Message=${releasesCheck.message || 'N/A'}`
    )
    console.error(
      '[check-publish-env] Ensure token can read/write repository contents and releases.'
    )
    process.exit(1)
  }

  console.log(`[check-publish-env] GitHub publish preflight passed for ${owner}/${repo}.`)
}

await main()
