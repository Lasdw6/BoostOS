import { spawnSync } from 'node:child_process'

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true'

if (isVercel) {
  console.log('[desktop postinstall] Vercel detected, skipping electron-builder install-app-deps')
  process.exit(0)
}

const result = spawnSync('electron-builder', ['install-app-deps'], {
  stdio: 'inherit',
  shell: true
})

if (typeof result.status === 'number') {
  process.exit(result.status)
}

if (result.error) {
  console.error('[desktop postinstall] Failed to run electron-builder install-app-deps')
  console.error(result.error)
}

process.exit(1)
