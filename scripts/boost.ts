#!/usr/bin/env bun

import { basename, dirname, join } from 'path'
import { spawn } from 'child_process'
import { homedir } from 'os'
import { mkdir, readFile, writeFile } from 'fs/promises'
import React from 'react'
import { Box, Text, render } from 'ink'
import { emitKeypressEvents } from 'readline'

const rawArgs = process.argv.slice(2)
const useLastChoices = rawArgs.includes('--last') || rawArgs.includes('-l')
const args = rawArgs.filter((arg) => arg !== '--last' && arg !== '-l')

let input = args.join(' ')
const cwd = process.cwd()
const selectionCachePath = join(homedir(), '.boost', 'cli-last-selections.json')
const commandCenterCandidates = [
  process.env.BOOST_COMMAND_CENTER_URL || 'http://127.0.0.1:45701',
  'http://127.0.0.1:45700'
]

interface CommandCandidate {
  id: string
  label: string
  command?: string
  cwd?: string
  source?: string
}

interface ExecuteResponse {
  ok?: boolean
  message?: string
  command?: string
  data?: {
    executeInCaller?: {
      command?: string
      cwd?: string
    }
    [key: string]: unknown
  }
  requiresResolution?: boolean
  resolutionPicker?: string
  candidates?: CommandCandidate[]
}

interface CommandResolution {
  picker: string
  selectedId: string
}

interface SelectionCache {
  lastCommand?: string
  byCommand?: Record<
    string,
    {
      updatedAt: string
      pickers: Record<string, string[]>
    }
  >
}

function detectTerminalContext(): {
  host: string
  shell: string
  termProgram?: string
  parentProcess?: string
  currentPid?: string
  terminalSessionId?: string
  terminalSessionTag?: string
  executeInCaller: boolean
} {
  const termProgram = process.env.TERM_PROGRAM || ''
  const shellPath = (process.env.SHELL || '').toLowerCase()
  const cmdCmdLine = (process.env.CMDCMDLINE || '').trim()
  const hasPowerShellEnv = Boolean(process.env.PSModulePath || process.env.PSExecutionPolicyPreference)

  let shell = 'unknown'
  if (shellPath.includes('pwsh') || shellPath.includes('powershell')) shell = 'powershell'
  else if (shellPath.includes('cmd.exe')) shell = 'cmd'
  else if (shellPath.includes('bash')) shell = 'bash'
  else if (shellPath.includes('zsh')) shell = 'zsh'
  else if (process.platform === 'win32') shell = hasPowerShellEnv ? 'powershell' : cmdCmdLine ? 'cmd' : 'powershell'

  let host = 'terminal'
  if (process.env.WT_SESSION) {
    host = 'windows-terminal'
  } else if ((process.env.CURSOR_TRACE_ID || '').trim()) {
    host = 'cursor'
  } else if (termProgram.toLowerCase() === 'vscode') {
    host = 'vscode'
  } else if (shell === 'cmd') {
    host = 'cmd'
  } else if (shell === 'powershell') {
    host = 'powershell'
  }

  return {
    host,
    shell,
    termProgram: termProgram || undefined,
    parentProcess: process.ppid > 0 ? String(process.ppid) : undefined,
    currentPid: process.pid > 0 ? String(process.pid) : undefined,
    terminalSessionId: (process.env.BOOST_TERMINAL_SESSION_ID || '').trim() || undefined,
    terminalSessionTag: (process.env.BOOST_TERMINAL_SESSION_TAG || '').trim() || undefined,
    executeInCaller: true
  }
}

async function execute(inputText: string, resolution?: CommandResolution): Promise<ExecuteResponse> {
  let lastError = 'Boost command center is not reachable'
  for (const baseUrl of commandCenterCandidates) {
    try {
      const response = await fetch(`${baseUrl}/execute`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ input: inputText, cwd, resolution, terminalContext: detectTerminalContext() })
      })

      if (!response.ok) {
        const text = await response.text()
        lastError = `HTTP ${response.status}: ${text}`
        continue
      }

      return (await response.json()) as ExecuteResponse
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  throw new Error(lastError)
}

async function loadSelectionCache(): Promise<SelectionCache> {
  try {
    const raw = await readFile(selectionCachePath, 'utf8')
    const parsed = JSON.parse(raw) as SelectionCache
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function saveSelectionCache(cache: SelectionCache): Promise<void> {
  await mkdir(dirname(selectionCachePath), { recursive: true })
  await writeFile(selectionCachePath, JSON.stringify(cache, null, 2), 'utf8')
}

function getCachedResolutions(cache: SelectionCache, commandInput: string, picker: string): CommandResolution[] | null {
  const ids = cache.byCommand?.[commandInput]?.pickers?.[picker]
  if (!Array.isArray(ids) || ids.length === 0) return null
  return ids.map((selectedId) => ({ picker, selectedId }))
}

function rememberResolutions(
  cache: SelectionCache,
  commandInput: string,
  picker: string,
  resolutions: CommandResolution[]
): void {
  const ids = resolutions.map((entry) => entry.selectedId).filter((value) => value && value.trim().length > 0)
  if (ids.length === 0) return

  cache.byCommand ||= {}
  cache.byCommand[commandInput] ||= { updatedAt: new Date().toISOString(), pickers: {} }
  cache.byCommand[commandInput].updatedAt = new Date().toISOString()
  cache.byCommand[commandInput].pickers[picker] = ids
}

function printResult(result: ExecuteResponse): void {
  if (typeof result?.message === 'string') {
    console.log(result.message)
  } else {
    console.log(JSON.stringify(result, null, 2))
  }

  if (result?.data && !result.data.executeInCaller) {
    console.log(JSON.stringify(result.data, null, 2))
  }
}

async function runInCurrentTerminal(command: string, commandCwd?: string): Promise<number> {
  const runCwd = commandCwd && commandCwd.trim() ? commandCwd : cwd
  return await new Promise<number>((resolve) => {
    const child = spawn(command, {
      cwd: runCwd,
      stdio: 'inherit',
      shell: true
    })
    child.on('exit', (code) => resolve(typeof code === 'number' ? code : 0))
    child.on('error', () => resolve(1))
  })
}

function fallbackPrintCandidates(candidates: CommandCandidate[]): void {
  console.log('Selection required:')
  for (const candidate of candidates) {
    const folder = formatCandidateScope(candidate)
    const command = candidate.command ? ` -> ${candidate.command}` : ''
    console.log(`- ${candidate.id}: ${candidate.label} [${folder}]${command}`)
  }
}

function formatCandidateScope(candidate: CommandCandidate): string {
  if (candidate.cwd && candidate.cwd.trim().length > 0) {
    return basename(candidate.cwd)
  }
  if (candidate.source === 'jump:agent') {
    return 'global'
  }
  return 'unknown'
}

function renderPickerView(
  candidates: CommandCandidate[],
  index: number,
  selectedIds: ReadonlySet<string>,
  hasSavedChoice: boolean,
  multiSelectMode: boolean
): React.ReactElement {
  const selected = candidates[index]
  const selectedFolder = selected ? formatCandidateScope(selected) : 'unknown'

  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(
      Text,
      { color: 'gray' },
      `⚡ ${selected?.label || 'unknown'}  [${selectedFolder}]${selected?.command ? ` -> ${selected.command}` : ''}`
    ),
    ...candidates.map((candidate, idx) => {
      const isCurrent = idx === index
      const isMarked = selectedIds.has(candidate.id)
      const marker = multiSelectMode ? (isMarked ? '[x]' : '[]') : isCurrent ? '>' : ' '
      const folder = formatCandidateScope(candidate)
      const command = candidate.command ? ` -> ${candidate.command}` : ''
      const line = `${marker} ${String(idx + 1).padStart(2, ' ')}. ${candidate.label} [${folder}]${command}`
      return React.createElement(Text, { key: candidate.id, color: idx === index ? 'green' : undefined }, line)
    }),
    React.createElement(
      Text,
      { color: 'gray' },
      hasSavedChoice
        ? 'q quit, tab mode, space select, w run last choice'
        : 'q quit, tab mode, space select'
    )
  )
}

function pickWithInk(candidates: CommandCandidate[], lastSelectedIds: string[] = []): Promise<CommandCandidate[] | null> {
  return new Promise<CommandCandidate[] | null>((resolve) => {
    let index = 0
    let multiSelectMode = false
    const selectedIds = new Set<string>()
    const lastSelectedIdSet = new Set(lastSelectedIds)
    const hasSavedChoice = lastSelectedIds.length > 0
    const app = render(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
    const stdin = process.stdin
    const canSetRawMode = typeof stdin.setRawMode === 'function'

    const cleanup = () => {
      stdin.off('keypress', onKeypress)
      if (canSetRawMode) stdin.setRawMode(false)
      app.unmount()
    }

    const onKeypress = (inputKey: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        resolve(null)
        return
      }

      const normalized = (inputKey || '').toLowerCase()
      if (key.name === 'escape' || normalized === 'q') {
        cleanup()
        resolve(null)
        return
      }

      if (key.name === 'up' || normalized === 'k') {
        index = (index - 1 + candidates.length) % candidates.length
        app.rerender(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
        return
      }

      if (key.name === 'down' || normalized === 'j') {
        index = (index + 1) % candidates.length
        app.rerender(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
        return
      }

      if (key.name === 'tab' || inputKey === '\t') {
        multiSelectMode = !multiSelectMode
        app.rerender(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
        return
      }

      if (key.name === 'space' || inputKey === ' ') {
        if (!multiSelectMode) {
          return
        }
        const current = candidates[index]
        if (current) {
          if (selectedIds.has(current.id)) {
            selectedIds.delete(current.id)
          } else {
            selectedIds.add(current.id)
          }
        }
        app.rerender(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
        return
      }

      if (normalized === 'w' && hasSavedChoice) {
        const selected = candidates.filter((candidate) => lastSelectedIdSet.has(candidate.id))
        if (selected.length > 0) {
          cleanup()
          resolve(selected)
        }
        return
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (multiSelectMode && selectedIds.size === 0) {
          app.rerender(renderPickerView(candidates, index, selectedIds, hasSavedChoice, multiSelectMode))
          return
        }

        const selected =
          multiSelectMode && selectedIds.size > 0
            ? candidates.filter((candidate) => selectedIds.has(candidate.id))
            : candidates[index]
              ? [candidates[index]]
              : []
        cleanup()
        resolve(selected.length > 0 ? selected : null)
      }
    }

    emitKeypressEvents(stdin)
    if (canSetRawMode) stdin.setRawMode(true)
    stdin.on('keypress', onKeypress)
  })
}

async function promptForCandidate(
  picker: string,
  candidates: CommandCandidate[],
  cachedResolutions: CommandResolution[] | null
): Promise<CommandResolution[] | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fallbackPrintCandidates(candidates)
    return null
  }

  const selected = await pickWithInk(
    candidates,
    (cachedResolutions || []).map((entry) => entry.selectedId).filter((id) => id && id.trim().length > 0)
  )
  if (!selected || selected.length === 0) return null

  return selected.map((candidate) => ({
    picker,
    selectedId: candidate.id
  }))
}

async function runInNewTerminal(command: string, commandCwd?: string): Promise<number> {
  const runCwd = commandCwd && commandCwd.trim() ? commandCwd : cwd
  const terminalContext = detectTerminalContext()

  return await new Promise<number>((resolve) => {
    let child
    if (process.platform === 'win32') {
      const wantsCmd = terminalContext.shell === 'cmd'

      // Prefer opening a new tab in Windows Terminal when available.
      if (process.env.WT_SESSION) {
        if (!wantsCmd) {
          child = spawn('wt', ['new-tab', 'pwsh', '-NoExit', '-Command', command], {
            cwd: runCwd,
            detached: true,
            stdio: 'ignore'
          })
        } else {
          child = spawn('wt', ['new-tab', 'cmd.exe', '/k', command], {
            cwd: runCwd,
            detached: true,
            stdio: 'ignore'
          })
        }
      } else if (!wantsCmd) {
        child = spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', command], {
          cwd: runCwd,
          detached: true,
          stdio: 'ignore'
        })
      } else {
        child = spawn('cmd.exe', ['/c', 'start', '', 'cmd.exe', '/k', command], {
          cwd: runCwd,
          detached: true,
          stdio: 'ignore'
        })
      }
    } else if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script ${JSON.stringify(`cd ${runCwd}; ${command}`)}`
      child = spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore'
      })
    } else {
      child = spawn('x-terminal-emulator', ['-e', `bash -lc 'cd "${runCwd}" && ${command}; exec bash'`], {
        detached: true,
        stdio: 'ignore',
        shell: true
      })
    }

    child.on('error', () => resolve(1))
    child.on('spawn', () => {
      child.unref()
      resolve(0)
    })
  })
}

async function runInNewTerminals(commands: Array<{ command: string; cwd?: string }>): Promise<number> {
  let exitCode = 0
  for (const entry of commands) {
    const code = await runInNewTerminal(entry.command, entry.cwd)
    if (code !== 0) {
      exitCode = code
    }
  }
  return exitCode
}

async function runMultiSelection(commands: Array<{ command: string; cwd?: string }>): Promise<number> {
  if (commands.length === 0) return 0
  if (commands.length === 1) {
    return await runInCurrentTerminal(commands[0].command, commands[0].cwd)
  }

  const [first, ...rest] = commands
  const launchCode = await runInNewTerminals(rest)
  const firstCode = await runInCurrentTerminal(first.command, first.cwd)
  return firstCode !== 0 ? firstCode : launchCode
}

async function run() {
  try {
    const cache = await loadSelectionCache()
    if (!input.trim() && useLastChoices) {
      input = cache.lastCommand || ''
    }

    if (!input.trim()) {
      console.log('Usage: boost <command> [-l|--last]')
      process.exit(1)
    }

    let result = await execute(input)
    printResult(result)

    while (result?.requiresResolution && Array.isArray(result?.candidates) && result.candidates.length > 0) {
      const picker = result.resolutionPicker || ''
      if (!picker) {
        break
      }

      const cachedResolutions = getCachedResolutions(cache, input, picker)
      const resolutions = useLastChoices
        ? cachedResolutions
        : await promptForCandidate(picker, result.candidates, cachedResolutions)
      if (!resolutions) {
        if (useLastChoices) {
          console.error(`No saved choices for "${input}" (${picker}). Run without --last once to save choices.`)
        }
        process.exit(2)
      }
      rememberResolutions(cache, input, picker, resolutions)
      cache.lastCommand = input
      await saveSelectionCache(cache)

      if (resolutions.length === 1) {
        result = await execute(input, resolutions[0])
        printResult(result)
      } else {
        const multiResults: ExecuteResponse[] = []
        for (const resolution of resolutions) {
          const nextResult = await execute(input, resolution)
          printResult(nextResult)
          multiResults.push(nextResult)
        }

        const commandsToRun = multiResults
          .map((entry) => entry.data?.executeInCaller)
          .filter((entry): entry is { command: string; cwd?: string } => Boolean(entry?.command))

        if (commandsToRun.length > 0) {
          const exitCode = await runMultiSelection(commandsToRun)
          process.exit(exitCode)
        }

        result = multiResults[multiResults.length - 1] ?? result
      }
    }

    const inCaller = result?.data?.executeInCaller
    if (inCaller?.command) {
      const countValue = Number((result?.data as { count?: unknown } | undefined)?.count)
      const spawnCount = Number.isFinite(countValue) ? Math.max(1, Math.floor(countValue)) : 1

      if (result?.command === 'spawn' && spawnCount > 1) {
        const extraCommands = Array.from({ length: spawnCount - 1 }, () => ({
          command: inCaller.command as string,
          cwd: inCaller.cwd
        }))
        await runInNewTerminals(extraCommands)
      }

      const exitCode = await runInCurrentTerminal(inCaller.command, inCaller.cwd)
      process.exit(exitCode)
    }

    if (!result?.ok) {
      process.exit(1)
    }

    cache.lastCommand = input
    await saveSelectionCache(cache)
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Boost command center is not reachable. Start Boost CLI daemon or launch desktop and try again.'
    )
    process.exit(1)
  }
}

void run()
