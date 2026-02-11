const required = ['CSC_LINK', 'CSC_KEY_PASSWORD']
const optional = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']

const has = (name) => {
  const value = process.env[name]
  return typeof value === 'string' && value.trim().length > 0
}

const missing = required.filter((name) => !has(name))

if (missing.length > 0) {
  console.error('[check-signing-env] Missing required signing env vars:')
  for (const name of missing) {
    console.error(` - ${name}`)
  }
  console.error('[check-signing-env] Configure your .pfx certificate before running secure release.')
  console.error('[check-signing-env] See RELEASE_SECURITY.md for setup details.')
  process.exit(1)
}

console.log('[check-signing-env] Required signing env vars are set.')
for (const name of optional) {
  console.log(`[check-signing-env] ${name}: ${has(name) ? 'set' : 'not set (optional)'}`)
}
