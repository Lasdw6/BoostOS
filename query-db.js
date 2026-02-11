const Database = require('better-sqlite3')
const path = require('path')
const os = require('os')

const dbPath = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'boost-workflow-launcher',
  'workflows.db'
)
console.log('Database path:', dbPath)

const db = new Database(dbPath)

console.log('\n=== All Workflows ===')
const workflows = db
  .prepare(
    `
  SELECT w.id, w.name, w.description, w.shortcut, w.is_active,
         COUNT(ws.id) as step_count
  FROM workflows w
  LEFT JOIN workflow_steps ws ON w.id = ws.workflow_id
  GROUP BY w.id
`
  )
  .all()

console.log(JSON.stringify(workflows, null, 2))

console.log('\n=== All Workflow Steps ===')
const steps = db.prepare('SELECT * FROM workflow_steps').all()
console.log(JSON.stringify(steps, null, 2))

console.log('\n=== All Execution History ===')
const history = db.prepare('SELECT id, workflow_id, status FROM execution_history').all()
console.log(JSON.stringify(history, null, 2))

db.close()
