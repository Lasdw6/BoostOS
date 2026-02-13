import { spawn } from 'node:child_process'
import process from 'node:process'
import net from 'node:net'

const PORT = 9222
const SESSION = 'default'
const APP_STARTUP_TIMEOUT_MS = 20000
const APP_CWD = process.cwd()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForPort(port, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timed out waiting for port ${port}`))
          return
        }
        setTimeout(tryConnect, 250)
      })
    }
    tryConnect()
  })
}

function runHarness(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bunx', ['harness-electron', ...args], {
      cwd: APP_CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      const output = stdout.trim() || stderr.trim()
      if (code !== 0) {
        reject(new Error(output || `harness-electron ${args.join(' ')} failed`))
        return
      }
      try {
        resolve(JSON.parse(output))
      } catch {
        reject(new Error(`Non-JSON output from harness-electron: ${output}`))
      }
    })
  })
}

function printResult(label, result) {
  const suffix = result?.ok === true ? 'ok' : 'error'
  console.log(`[${suffix}] ${label}`)
  if (result?.data) {
    console.log(JSON.stringify(result.data))
  }
  if (result?.error) {
    console.log(JSON.stringify(result.error))
  }
}

async function main() {
  const electronProc = spawn('bunx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: APP_CWD,
    stdio: 'ignore',
    detached: false,
    windowsHide: true
  })

  const cleanup = async () => {
    try {
      await runHarness(['disconnect', '--session', SESSION])
    } catch {
      // no-op
    }
    if (!electronProc.killed) {
      electronProc.kill('SIGTERM')
      await sleep(800)
      if (!electronProc.killed) {
        electronProc.kill('SIGKILL')
      }
    }
  }

  try {
    await waitForPort(PORT, APP_STARTUP_TIMEOUT_MS)

    const connect = await runHarness(['connect', '--port', String(PORT), '--session', SESSION])
    printResult('connect', connect)

    const before = await runHarness(['dom', '--format', 'summary', '--session', SESSION])
    printResult('dom summary (before)', before)

    const assertUrl = await runHarness([
      'assert',
      '--kind',
      'url',
      '--expected',
      'out/renderer/index.html',
      '--session',
      SESSION
    ])
    printResult('assert url', assertUrl)

    const assertHeader = await runHarness([
      'assert',
      '--kind',
      'text',
      '--css',
      'h1',
      '--expected',
      'Boost',
      '--session',
      SESSION
    ])
    printResult('assert header', assertHeader)

    const clickAddProject = await runHarness([
      'click',
      '--css',
      'button.px-3',
      '--session',
      SESSION
    ])
    printResult('click add project', clickAddProject)

    const assertInputVisible = await runHarness([
      'assert',
      '--kind',
      'visible',
      '--css',
      'input',
      '--session',
      SESSION
    ])
    printResult('assert input visible', assertInputVisible)

    const typeInput = await runHarness([
      'type',
      '--css',
      'input',
      '--value',
      'harness_test_project',
      '--session',
      SESSION
    ])
    printResult('type input', typeInput)

    const after = await runHarness(['dom', '--format', 'summary', '--session', SESSION])
    printResult('dom summary (after)', after)

    await cleanup()
  } catch (error) {
    await cleanup()
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

await main()
