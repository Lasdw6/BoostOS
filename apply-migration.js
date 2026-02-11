const Database = require('better-sqlite3')
const path = require('path')
const os = require('os')
const fs = require('fs')

const dbPath = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'boost-workflow-launcher',
  'workflows.db'
)
console.log('Database path:', dbPath)

const db = new Database(dbPath)

// Check if migration was already applied
const migrations = db
  .prepare('SELECT name FROM migrations WHERE name = ?')
  .get('003_script_files.sql')

if (migrations) {
  console.log('Migration 003 already applied')
  process.exit(0)
}

console.log('Applying migration 003_script_files.sql...')

// Apply migration
const migrationSql = `
-- Simplify workflows to use script files instead of steps
-- Version: 3
-- Date: 2026-01-22

-- Add script path column to workflows
ALTER TABLE workflows ADD COLUMN script_path TEXT;

-- Add shell type column (powershell, bash, cmd, etc.)
ALTER TABLE workflows ADD COLUMN shell TEXT DEFAULT 'powershell';
`

db.exec(migrationSql)

// Record migration
db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
  '003_script_files.sql',
  new Date().toISOString()
)

console.log('Migration 003 applied successfully')

db.close()
