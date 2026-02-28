import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import {
  clearRuntimeFeedback,
  loadProjectHubConfig,
  removeSessionBinding,
  recordRuntimeFeedback,
  saveProjectHubConfig,
  setDefaultSessionBinding,
  upsertSessionBinding,
  upsertProject
} from './project-hub-config'
import { windowManager } from './window-manager'
import { classifyProjectsWithLLM } from './project-classifier'
import { discoverProjectProfiles } from './project-discovery'
import { CommandServer, type ExecuteResult } from './command-server'
import { getPsListFn } from './ps-list-loader'
import type {
  ProjectHubConfig,
  ProjectProfile,
  RuntimeFeedbackScope,
  RuntimeSurface,
  SessionBinding,
  SessionBindingType
} from '../shared/project-hub'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuittingApp = false
let commandServer: CommandServer | null = null

const appIconPath = [
  isDev ? join(__dirname, '../../resources/icon.png') : '',
  join(process.resourcesPath, 'icon.png'),
  join(__dirname, '../../build/icon.png')
].find((p) => p && existsSync(p))

const appIcon = appIconPath ? nativeImage.createFromPath(appIconPath) : nativeImage.createEmpty()

function getConfig(): ProjectHubConfig {
  return loadProjectHubConfig()
}

function setConfig(config: ProjectHubConfig): void {
  saveProjectHubConfig(config)
}

function getActiveProject(config: ProjectHubConfig): ProjectProfile | null {
  if (!config.active_project_id) return null
  return config.projects.find((p) => p.id === config.active_project_id) || null
}

function focusBestWindow(processNames: string[], titleHints: string[]): boolean {
  const candidates: Array<{ win: any; score: number }> = []

  for (const processName of processNames) {
    const wins = windowManager.findWindowsByProcessName(processName)
    for (const win of wins) {
      const title = String(win.getTitle?.() || '').toLowerCase()
      let score = 1
      for (const hint of titleHints) {
        if (!hint) continue
        const lowHint = hint.toLowerCase()
        if (title.includes(lowHint)) score += 5
      }
      candidates.push({ win, score })
    }
  }

  if (candidates.length === 0) return false
  candidates.sort((a, b) => b.score - a.score)
  try {
    windowManager.focusWindow(candidates[0].win)
    return true
  } catch {
    return false
  }
}

function openIde(project: ProjectProfile): { ok: boolean; message: string } {
  const titleHints = [project.ide_hint || '', project.name, project.root_path.split(/[\\/]/).pop() || '']
  if (focusBestWindow(['cursor.exe', 'code.exe', 'zed.exe'], titleHints)) {
    return { ok: true, message: `Focused IDE for ${project.name}` }
  }
  if (focusBestWindow(['cursor.exe', 'code.exe', 'zed.exe'], [])) {
    return { ok: true, message: `Focused IDE for ${project.name}` }
  }

  const command = (project.ide_command || 'cursor').trim()
  const proc = spawn('cmd.exe', ['/c', 'start', '""', command, '--reuse-window', project.root_path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  proc.unref()
  return { ok: true, message: `Launched IDE for ${project.name}` }
}

function openBrowser(project: ProjectProfile): { ok: boolean; message: string } {
  const hint = project.browser_hint?.trim()
  const url = project.dev_url?.trim() || 'http://localhost:3000'
  const fromUrl = (() => {
    try {
      const u = new URL(url)
      return [u.host, u.hostname, u.port].filter(Boolean).join(' ')
    } catch {
      return ''
    }
  })()

  const hints = [hint || '', project.name, fromUrl]
  if (focusBestWindow(['chrome.exe', 'msedge.exe', 'brave.exe'], hints)) {
    return { ok: true, message: `Focused browser for ${project.name}` }
  }

  void shell.openExternal(url)
  return { ok: true, message: `Opened ${url}` }
}

function openAgent(project: ProjectProfile): { ok: boolean; message: string } {
  const titleHints = [project.agent_hint || '', project.name, project.root_path.split(/[\\/]/).pop() || '']
  if (
    focusBestWindow(
      ['windowsterminal.exe', 'windows terminal.exe', 'wezterm-gui.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe'],
      titleHints
    )
  ) {
    return { ok: true, message: `Focused agent terminal for ${project.name}` }
  }

  const command = (project.agent_command || 'codex').trim()
  const psCommand = `Set-Location -LiteralPath '${project.root_path.replace(/'/g, "''")}'; ${command}`
  const proc = spawn(
    'cmd.exe',
    ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  )
  proc.unref()
  return { ok: true, message: `Launched agent terminal for ${project.name}` }
}

function focusWindowById(windowId: number): boolean {
  const window = windowManager.getWindowById(windowId)
  if (!window) return false
  try {
    windowManager.focusWindow(window)
    return true
  } catch {
    return false
  }
}

function focusWindowByPid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  const windows = windowManager.getAllWindows()
  const candidate = windows.find((window: any) => Number(window.processId || 0) === pid)
  if (!candidate) return false
  try {
    windowManager.focusWindow(candidate)
    return true
  } catch {
    return false
  }
}

function parsePortFromText(value: string): number | null {
  const text = value.toLowerCase()
  const url = text.match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/)
  if (url?.[1]) return Number(url[1])
  const flag = text.match(/(?:--port|-p|port=)\s*([0-9]{2,5})/)
  if (flag?.[1]) return Number(flag[1])
  return null
}

function low(value: string): string {
  return String(value || '').toLowerCase()
}

function isIdeProcessName(name: string): boolean {
  const n = low(name)
  return n === 'code.exe' || n === 'code' || n === 'cursor.exe' || n === 'cursor'
}

function isShellProcessName(name: string): boolean {
  const n = low(name)
  return (
    n === 'pwsh.exe' ||
    n === 'pwsh' ||
    n === 'powershell.exe' ||
    n === 'powershell' ||
    n === 'cmd.exe' ||
    n === 'cmd' ||
    n === 'bash.exe' ||
    n === 'bash' ||
    n === 'zsh.exe' ||
    n === 'zsh' ||
    n === 'wsl.exe' ||
    n === 'wsl'
  )
}

function splitCommandTokens(input: string): string[] {
  const tokens: string[] = []
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  let match: RegExpExecArray | null = null
  while ((match = re.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token) tokens.push(token)
  }
  return tokens
}

function getProjectCandidates(config: ProjectHubConfig, query?: string): ProjectProfile[] {
  if (!query || !query.trim()) return config.projects
  const needle = query.trim().toLowerCase()
  return config.projects.filter((project) => {
    if (project.id.toLowerCase() === needle) return true
    if (project.name.toLowerCase().includes(needle)) return true
    return project.root_path.toLowerCase().includes(needle)
  })
}

function getDefaultBinding(config: ProjectHubConfig, projectId: string, type: SessionBindingType): SessionBinding | null {
  const defaultId = config.session_defaults_by_project?.[projectId]?.[type]
  if (defaultId) {
    const explicit = config.session_bindings.find((binding) => binding.id === defaultId && binding.project_id === projectId)
    if (explicit) return explicit
  }
  const fallback = config.session_bindings
    .filter((binding) => binding.project_id === projectId && binding.type === type)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0]
  return fallback || null
}

function getProjectBindings(
  config: ProjectHubConfig,
  projectId: string,
  type: SessionBindingType
): SessionBinding[] {
  return config.session_bindings
    .filter((binding) => binding.project_id === projectId && binding.type === type)
    .sort((a, b) => {
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1
      return a.updated_at < b.updated_at ? -1 : 1
    })
}

function pickPairedDevserverBinding(
  config: ProjectHubConfig,
  projectId: string,
  agentBinding: SessionBinding,
  preferredDevId?: string
): SessionBinding | null {
  const devservers = getProjectBindings(config, projectId, 'devserver')
  if (devservers.length === 0) return null

  const agentLabel = (agentBinding.label || '').trim().toLowerCase()
  if (agentLabel) {
    const labeled = devservers.find((binding) => (binding.label || '').trim().toLowerCase() === agentLabel)
    if (labeled) return labeled
  }

  if (preferredDevId) {
    const preferred = devservers.find((binding) => binding.id === preferredDevId)
    if (preferred) return preferred
  }

  const agents = getProjectBindings(config, projectId, 'agent')
  const agentIndex = agents.findIndex((binding) => binding.id === agentBinding.id)
  if (agentIndex >= 0 && agentIndex < devservers.length) return devservers[agentIndex]
  return devservers[0]
}

function parseFlags(tokens: string[]): { project?: string; label?: string; cmd?: string; port?: number; index?: number } {
  const out: { project?: string; label?: string; cmd?: string; port?: number; index?: number } = {}
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    if (token.startsWith('--project=')) {
      out.project = token.slice('--project='.length)
      continue
    }
    if (token === '--project' && tokens[i + 1]) {
      out.project = tokens[i + 1]
      i += 1
      continue
    }
    if (token.startsWith('--label=')) {
      out.label = token.slice('--label='.length)
      continue
    }
    if (token === '--label' && tokens[i + 1]) {
      out.label = tokens[i + 1]
      i += 1
      continue
    }
    if (token.startsWith('--cmd=')) {
      out.cmd = token.slice('--cmd='.length).trim()
      continue
    }
    if (token === '--cmd' && tokens[i + 1]) {
      out.cmd = tokens[i + 1].trim()
      i += 1
      continue
    }
    if (token.startsWith('--port=')) {
      const value = Number(token.slice('--port='.length))
      if (Number.isFinite(value) && value > 0) out.port = value
      continue
    }
    if (token === '--port' && tokens[i + 1]) {
      const value = Number(tokens[i + 1])
      if (Number.isFinite(value) && value > 0) out.port = value
      i += 1
      continue
    }
    if (token.startsWith('--index=')) {
      const value = Number(token.slice('--index='.length))
      if (Number.isFinite(value) && value > 0) out.index = value
      continue
    }
    if (token === '--index' && tokens[i + 1]) {
      const value = Number(tokens[i + 1])
      if (Number.isFinite(value) && value > 0) out.index = value
      i += 1
      continue
    }
  }
  return out
}

async function resolveBindingContext(
  terminalContext:
    | {
        currentPid?: string
        parentProcess?: string
        host?: string
        termProgram?: string
      }
    | undefined
): Promise<{ bindingPid: number | undefined; bindingWindowId: number | undefined; integrated: boolean }> {
  const currentPid = Number(terminalContext?.currentPid || 0)
  const parentPid = Number(terminalContext?.parentProcess || 0)
  const seedPid = Number.isFinite(parentPid) && parentPid > 0 ? parentPid : currentPid
  if (!Number.isFinite(seedPid) || seedPid <= 0) {
    const active = windowManager.getActiveWindow()
    if (active && Number((active as any).processId) > 0 && Number((active as any).id) > 0) {
      const path = low(String((active as any).path || ''))
      const name = path.split(/[\\/]/).pop() || ''
      return {
        bindingPid: Number((active as any).processId),
        bindingWindowId: Number((active as any).id),
        integrated: isIdeProcessName(name)
      }
    }
    return { bindingPid: undefined, bindingWindowId: undefined, integrated: false }
  }

  const psList = getPsListFn()
  const rows = await psList()
  const byPid = new Map<number, { pid: number; ppid: number; name: string }>()
  for (const row of rows as any[]) {
    const pid = Number(row?.pid || 0)
    if (!pid) continue
    byPid.set(pid, {
      pid,
      ppid: Number(row?.ppid || 0),
      name: String(row?.name || '')
    })
  }

  const chain: Array<{ pid: number; ppid: number; name: string }> = []
  let cursor = seedPid
  const seen = new Set<number>()
  for (let i = 0; i < 12; i += 1) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const row = byPid.get(cursor)
    if (!row) break
    chain.push(row)
    if (!row.ppid || row.ppid === cursor) break
    cursor = row.ppid
  }

  const hostText = `${terminalContext?.host || ''} ${terminalContext?.termProgram || ''}`.toLowerCase()
  const hostIntegratedHint = hostText.includes('cursor') || hostText.includes('vscode')
  const integratedByParent = chain.some((row) => isIdeProcessName(row.name))
  const integrated = hostIntegratedHint || integratedByParent

  const shellRow = chain.find((row) => isShellProcessName(row.name))
  const bindingPid = shellRow?.pid || seedPid

  let bindingWindowId: number | undefined
  if (bindingPid > 0) {
    const windows = windowManager.getAllWindows()
    const byPidWindow = windows.find((window: any) => Number(window.processId || 0) === bindingPid)
    if (byPidWindow && Number(byPidWindow.id) > 0) bindingWindowId = Number(byPidWindow.id)
  }

  if (!bindingWindowId && integrated) {
    const active = windowManager.getActiveWindow()
    if (active && Number(active.id) > 0) {
      const activePath = low(String((active as any).path || ''))
      const activeName = activePath.split(/[\\/]/).pop() || ''
      if (isIdeProcessName(activeName)) {
        bindingWindowId = Number(active.id)
      }
    }
    if (!bindingWindowId) {
      const windows = windowManager.getAllWindows()
      const ideWindow = windows.find((window: any) => {
        const path = low(String(window.path || ''))
        const name = path.split(/[\\/]/).pop() || ''
        return isIdeProcessName(name)
      })
      if (ideWindow && Number(ideWindow.id) > 0) bindingWindowId = Number(ideWindow.id)
    }
  }

  if (!bindingWindowId) {
    const active = windowManager.getActiveWindow()
    if (active && Number((active as any).id) > 0) {
      const activePid = Number((active as any).processId || 0)
      const activePath = low(String((active as any).path || ''))
      const activeName = activePath.split(/[\\/]/).pop() || ''
      if (activePid === bindingPid || isShellProcessName(activeName) || isIdeProcessName(activeName)) {
        bindingWindowId = Number((active as any).id)
      }
    }
  }

  return { bindingPid, bindingWindowId, integrated }
}

function bindingLabel(binding: SessionBinding): string {
  const label = (binding.label || '').trim()
  return label || binding.id.slice(0, 8)
}

function getWindowProcessNameById(windowId: number | undefined): string {
  if (!windowId || windowId <= 0) return ''
  const window = windowManager.getWindowById(windowId)
  if (!window) return ''
  const path = low(String((window as any).path || ''))
  return path.split(/[\\/]/).pop() || ''
}

function getBindingIntegratedState(binding: SessionBinding): 'yes' | 'no' | 'unknown' {
  if (typeof binding.integrated_terminal === 'boolean') {
    return binding.integrated_terminal ? 'yes' : 'no'
  }
  // Without an explicit integrated marker, a missing PID means we cannot
  // reliably classify terminal mode for old/stale bindings.
  if (!binding.pid) {
    return 'unknown'
  }
  const windowProcessName = getWindowProcessNameById(binding.window_id)
  if (!windowProcessName) return 'unknown'
  return isIdeProcessName(windowProcessName) ? 'yes' : 'no'
}

function isBindingIntegrated(binding: SessionBinding): boolean {
  return getBindingIntegratedState(binding) === 'yes'
}

async function focusIntegratedHostForBinding(binding: SessionBinding, project: ProjectProfile): Promise<boolean> {
  if (binding.window_id && focusWindowById(binding.window_id)) return true

  const psList = getPsListFn()
  const rows = await psList()
  const byPid = new Map<number, { pid: number; ppid: number; name: string }>()
  for (const row of rows as any[]) {
    const pid = Number(row?.pid || 0)
    if (!pid) continue
    byPid.set(pid, {
      pid,
      ppid: Number(row?.ppid || 0),
      name: String(row?.name || '')
    })
  }

  const seedPid = Number(binding.pid || 0)
  if (seedPid > 0) {
    let cursor = seedPid
    const seen = new Set<number>()
    for (let i = 0; i < 12; i += 1) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      const row = byPid.get(cursor)
      if (!row) break
      if (isIdeProcessName(row.name)) {
        if (focusWindowByPid(row.pid)) return true
        break
      }
      if (!row.ppid || row.ppid === cursor) break
      cursor = row.ppid
    }
  }

  const titleHints = [project.ide_hint || '', project.name, project.root_path.split(/[\\/]/).pop() || '']
  return focusBestWindow(['cursor.exe', 'code.exe', 'zed.exe'], titleHints)
}

async function focusIntegratedTerminalIndex(index: number): Promise<boolean> {
  if (!Number.isFinite(index) || index < 1 || index > 9) return false
  const commandId = `workbench.action.terminal.focusAtIndex${Math.floor(index)}`
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 120',
    "[System.Windows.Forms.SendKeys]::SendWait('^+p')",
    'Start-Sleep -Milliseconds 120',
    `$cmd='>${commandId}'`,
    '[System.Windows.Forms.SendKeys]::SendWait($cmd)',
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
  ].join('; ')

  return await new Promise<boolean>((resolve) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true }
    )
    proc.on('exit', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function focusIntegratedTerminalBySessionTag(tag: string): Promise<boolean> {
  const normalizedTag = String(tag || '').trim()
  if (!normalizedTag) return false
  const escapedTag = normalizedTag.replace(/'/g, "''")
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Start-Sleep -Milliseconds 120',
    "[System.Windows.Forms.SendKeys]::SendWait('^+p')",
    'Start-Sleep -Milliseconds 120',
    "[System.Windows.Forms.SendKeys]::SendWait('>workbench.action.quickOpenTerm')",
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    'Start-Sleep -Milliseconds 140',
    `$tag='${escapedTag}'`,
    '[System.Windows.Forms.SendKeys]::SendWait($tag)',
    'Start-Sleep -Milliseconds 80',
    "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"
  ].join('; ')

  return await new Promise<boolean>((resolve) => {
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true }
    )
    proc.on('exit', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

async function applyIntegratedTerminalSelection(binding: SessionBinding): Promise<void> {
  const tag = (binding.terminal_session_tag || '').trim()
  if (tag) {
    const byTag = await focusIntegratedTerminalBySessionTag(tag)
    if (byTag) return
  }
  if (binding.integrated_terminal_index) {
    void focusIntegratedTerminalIndex(binding.integrated_terminal_index)
  }
}

function bindingMatchesAgent(binding: SessionBinding, agent: SessionBinding): boolean {
  const a = (agent.label || '').trim().toLowerCase()
  const b = (binding.label || '').trim().toLowerCase()
  return Boolean(a && b && a === b)
}

type ActiveRelationshipRow = {
  project: ProjectProfile
  activeAgent: SessionBinding
  devservers: SessionBinding[]
  pairedDevserver: SessionBinding | null
}

async function getRunningPidSet(): Promise<Set<number>> {
  const psList = getPsListFn()
  const rows = await psList()
  const out = new Set<number>()
  for (const row of rows) {
    const pid = Number((row as any)?.pid || 0)
    if (pid > 0) out.add(pid)
  }
  return out
}

async function getActiveRelationshipRows(
  config: ProjectHubConfig,
  projectFilter?: string
): Promise<ActiveRelationshipRow[]> {
  const projects = getProjectCandidates(config, projectFilter)
  const activeProjectId = config.active_project_id

  const rows: ActiveRelationshipRow[] = []
  for (const project of projects) {
    const agents = getProjectBindings(config, project.id, 'agent')
    if (agents.length === 0) continue

    const defaultAgent = getDefaultBinding(config, project.id, 'agent')
    const activeAgent = (defaultAgent && agents.find((binding) => binding.id === defaultAgent.id)) || agents[0]

    const devservers = getProjectBindings(config, project.id, 'devserver')
    const defaultDevId = config.session_defaults_by_project?.[project.id]?.devserver
    const paired =
      devservers.find((binding) => bindingMatchesAgent(binding, activeAgent)) ||
      (defaultDevId ? devservers.find((binding) => binding.id === defaultDevId) || null : null) ||
      devservers[0] ||
      null

    rows.push({
      project,
      activeAgent,
      devservers,
      pairedDevserver: paired
    })
  }

  rows.sort((a, b) => {
    if (a.project.id === activeProjectId) return -1
    if (b.project.id === activeProjectId) return 1
    return a.project.name.localeCompare(b.project.name)
  })

  return rows
}

function ensureProjectTracked(config: ProjectHubConfig, rootPath: string): { config: ProjectHubConfig; project: ProjectProfile } {
  const repoRoot = findGitRoot(rootPath) || rootPath
  const normalized = repoRoot.toLowerCase()
  let next = config
  let project = next.projects.find((p) => p.root_path.toLowerCase() === normalized)

  if (!project) {
    const id = randomUUID()
    const name = repoRoot.split(/[\\/]/).pop() || repoRoot
    next = upsertProject(next, {
      id,
      name,
      root_path: repoRoot,
      ide_command: 'cursor',
      agent_command: 'codex',
      dev_url: 'http://localhost:3000',
      ide_hint: name,
      agent_hint: name,
      browser_hint: 'localhost'
    })
    if (!next.active_project_id) next.active_project_id = id
    project = next.projects.find((p) => p.id === id)
  }

  return { config: next, project: project as ProjectProfile }
}

async function executeCommandServerInput(
  input: string,
  cwd: string,
  terminalContext?: {
    host?: string
    shell?: string
    termProgram?: string
    parentProcess?: string
    executeInCaller?: boolean
    currentPid?: string
    terminalSessionId?: string
    terminalSessionTag?: string
  },
  resolution?: { picker?: string; selectedId?: string }
): Promise<ExecuteResult> {
  const commandText = input.replace(/^:/, '').trim()
  let tokens = splitCommandTokens(commandText)
  if (tokens[0]?.toLowerCase() === 'boost') {
    tokens = tokens.slice(1)
  }
  const normalized = tokens.join(' ').toLowerCase()
  const head = tokens[0]?.toLowerCase() || ''
  const sub = tokens[1]?.toLowerCase() || ''
  const flags = parseFlags(tokens.slice(2))

  if (!normalized || normalized === 'init') {
    const config = getConfig()
    const tracked = ensureProjectTracked(config, cwd)
    setConfig(tracked.config)
    return {
      ok: true,
      command: 'init',
      message: `Initialized and tracked: ${tracked.project.name}`
    }
  }

  const currentConfig = getConfig()
  const tracked = ensureProjectTracked(currentConfig, cwd)
  let config = tracked.config
  setConfig(config)

  const binding = await resolveBindingContext(terminalContext)
  const bindingPid = binding.bindingPid
  const bindingWindowId = binding.bindingWindowId

  if (head === 'add' && ['agent', 'devserver', 'dev-server', 'dev'].includes(sub)) {
    const type: SessionBindingType = sub === 'agent' ? 'agent' : 'devserver'
    const projectsFromFlag = getProjectCandidates(config, flags.project)
    let chosenProject: ProjectProfile | null = null

    if (resolution?.picker === `session:${type}:project` && resolution.selectedId) {
      chosenProject = config.projects.find((project) => project.id === resolution.selectedId) || null
    }

    if (!chosenProject) {
      if (!flags.project && tracked.project) {
        // Prefer cwd-inferred project when no explicit --project is provided.
        chosenProject = tracked.project
      } else if (projectsFromFlag.length === 1) {
        chosenProject = projectsFromFlag[0]
      } else if (projectsFromFlag.length > 1) {
        return {
          ok: false,
          command: `add-${type}`,
          message: 'Select project for this terminal session.',
          requiresResolution: true,
          resolutionPicker: `session:${type}:project`,
          candidates: projectsFromFlag.map((project) => ({
            id: project.id,
            label: project.name,
            cwd: project.root_path,
            source: `session:${type}`
          }))
        }
      } else if (!flags.project && config.projects.length > 1) {
        return {
          ok: false,
          command: `add-${type}`,
          message: 'Select project for this terminal session.',
          requiresResolution: true,
          resolutionPicker: `session:${type}:project`,
          candidates: config.projects.map((project) => ({
            id: project.id,
            label: project.name,
            cwd: project.root_path,
            source: `session:${type}`
          }))
        }
      } else if (flags.project && projectsFromFlag.length === 0) {
        return {
          ok: false,
          command: `add-${type}`,
          message: `No project matches '${flags.project}'.`
        }
      } else {
        chosenProject = tracked.project
      }
    }

    if (!chosenProject) {
      return {
        ok: false,
        command: `add-${type}`,
        message: 'Project not found. Use --project <name|id>.'
      }
    }

    const cmdHint = String(flags.cmd || '')
    const cwdHint = String(cwd || '')
    const portHint =
      type === 'devserver'
        ? parsePortFromText(cmdHint) || parsePortFromText(chosenProject.dev_url || '') || undefined
        : undefined
    const explicitPortHint = Number.isFinite(flags.port) && Number(flags.port) > 0 ? Number(flags.port) : undefined
    const finalPortHint = explicitPortHint || portHint
    const integratedIndexHint =
      binding.integrated && Number.isFinite(flags.index) && Number(flags.index) > 0 ? Math.floor(Number(flags.index)) : undefined
    const terminalSessionId =
      binding.integrated && terminalContext?.terminalSessionId?.trim()
        ? terminalContext.terminalSessionId.trim()
        : undefined
    const terminalSessionTag =
      binding.integrated && terminalContext?.terminalSessionTag?.trim()
        ? terminalContext.terminalSessionTag.trim()
        : undefined

    const id = randomUUID()
    const upserted = upsertSessionBinding(config, {
      id,
      project_id: chosenProject.id,
      type,
      label: flags.label?.trim() || undefined,
      integrated_terminal: binding.integrated,
      integrated_terminal_index: integratedIndexHint,
      terminal_session_id: terminalSessionId,
      terminal_session_tag: terminalSessionTag,
      pid: bindingPid,
      window_id: bindingWindowId,
      cwd_hint: cwdHint || undefined,
      cmd_hint: cmdHint || undefined,
      port_hint: finalPortHint
    })
    config = setDefaultSessionBinding(upserted.config, {
      project_id: chosenProject.id,
      type,
      binding_id: upserted.binding.id
    })

    setConfig(config)
    return {
      ok: true,
      command: `add-${type}`,
      message: `Added ${type} session for ${chosenProject.name}${upserted.binding.id ? ` (${upserted.binding.id.slice(0, 8)})` : ''}.${binding.integrated ? ` Integrated terminal detected${terminalSessionTag ? ` (tag=${terminalSessionTag})` : ''}.` : ''}${binding.integrated && !terminalSessionTag && !integratedIndexHint ? ' Tip: reload Boost hook in this terminal, then re-add to auto-target integrated tab.' : ''}${binding.integrated && !terminalSessionTag && integratedIndexHint ? '' : binding.integrated && !integratedIndexHint ? ' Fallback: --index <1-9>.' : ''}`
    }
  }

  if (head === 'list' && ['sessions', 'session'].includes(sub)) {
    const sessions = getProjectCandidates(config, flags.project)
      .flatMap((project) => {
        const defaults = config.session_defaults_by_project[project.id] || {}
        return config.session_bindings
          .filter((binding) => binding.project_id === project.id)
          .map((binding) => {
            const isDefault = defaults[binding.type] === binding.id ? 'default' : ''
            return `- ${binding.id.slice(0, 8)} ${binding.type} ${project.name} pid=${binding.pid || '-'} port=${binding.port_hint || '-'} ${isDefault}`.trim()
          })
      })
    return {
      ok: true,
      command: 'list-sessions',
      message: sessions.length > 0 ? sessions.join('\n') : 'No session bindings found.'
    }
  }

  if (
    head === 'relationships' ||
    head === 'relationship' ||
    head === 'relations' ||
    (head === 'list' && ['relationships', 'relationship', 'relations'].includes(sub))
  ) {
    const relationFlags = parseFlags(tokens.slice(head === 'list' ? 2 : 1))
    const rows = await getActiveRelationshipRows(config, relationFlags.project)
    if (rows.length === 0) {
      return {
        ok: true,
        command: 'relationships',
        message: 'No active agent relationships found.'
      }
    }

    const runningPids = await getRunningPidSet()
    const lines: string[] = []
    for (const row of rows) {
      const activeAgentRunning = Boolean(row.activeAgent.pid && runningPids.has(row.activeAgent.pid))
      const agentIndex =
        row.activeAgent.integrated_terminal_index && row.activeAgent.integrated_terminal_index > 0
          ? ` index=${row.activeAgent.integrated_terminal_index}`
          : ''
      const agentTag = row.activeAgent.terminal_session_tag ? ` tag=${row.activeAgent.terminal_session_tag}` : ''
      lines.push(`[${row.project.name}]`)
      lines.push(
        `  agent: ${bindingLabel(row.activeAgent)} pid=${row.activeAgent.pid || '-'} ${activeAgentRunning ? 'running' : 'stopped'} integrated=${getBindingIntegratedState(row.activeAgent)}${agentIndex}${agentTag}`
      )
      if (row.devservers.length === 0) {
        lines.push('  devservers: none')
        continue
      }
      for (const dev of row.devservers) {
        const running = Boolean(dev.pid && runningPids.has(dev.pid))
        const paired = row.pairedDevserver?.id === dev.id ? '*' : ' '
        const command = (dev.cmd_hint || '').trim()
        const devIndex =
          dev.integrated_terminal_index && dev.integrated_terminal_index > 0
            ? ` index=${dev.integrated_terminal_index}`
            : ''
        const devTag = dev.terminal_session_tag ? ` tag=${dev.terminal_session_tag}` : ''
        lines.push(
          `  ${paired} devserver: ${bindingLabel(dev)} pid=${dev.pid || '-'} port=${dev.port_hint || '-'} ${running ? 'running' : 'stopped'} integrated=${getBindingIntegratedState(dev)}${devIndex}${devTag} cmd=${command || '-'}`
        )
      }
    }

    return {
      ok: true,
      command: 'relationships',
      message: lines.join('\n')
    }
  }

  if (
    (head === 'reset' && ['relationships', 'relationship', 'relations'].includes(sub)) ||
    (head === 'clear' && ['relationships', 'relationship', 'relations'].includes(sub))
  ) {
    let next: ProjectHubConfig = {
      ...config,
      session_bindings: [],
      session_defaults_by_project: {}
    }
    next = clearRuntimeFeedback(next)
    setConfig(next)
    return {
      ok: true,
      command: 'reset-relationships',
      message: 'Cleared all agent/devserver relationships and defaults.'
    }
  }

  if (head === 'use' && ['agent', 'devserver', 'dev-server', 'dev'].includes(sub)) {
    const type: SessionBindingType = sub === 'agent' ? 'agent' : 'devserver'
    const needle = tokens[2]?.trim()
    if (!needle) {
      return {
        ok: false,
        command: `use-${type}`,
        message: `Usage: boost use ${type} <session-id>`
      }
    }
    const candidates = config.session_bindings.filter((binding) =>
      binding.id.toLowerCase().startsWith(needle.toLowerCase()) && binding.type === type
    )
    if (candidates.length !== 1) {
      return {
        ok: false,
        command: `use-${type}`,
        message:
          candidates.length === 0
            ? `No ${type} session found for '${needle}'.`
            : `Multiple sessions match '${needle}'. Use a longer id.`
      }
    }
    const binding = candidates[0]
    config = setDefaultSessionBinding(config, {
      project_id: binding.project_id,
      type,
      binding_id: binding.id
    })
    if (type === 'agent') {
      const currentDevId = config.session_defaults_by_project?.[binding.project_id]?.devserver
      const pairedDev = pickPairedDevserverBinding(config, binding.project_id, binding, currentDevId)
      if (pairedDev) {
        config = setDefaultSessionBinding(config, {
          project_id: binding.project_id,
          type: 'devserver',
          binding_id: pairedDev.id
        })
      }
    }
    setConfig(config)
    const project = config.projects.find((row) => row.id === binding.project_id)
    return {
      ok: true,
      command: `use-${type}`,
      message: `Default ${type} session set for ${project?.name || binding.project_id}.`
    }
  }

  if (head === 'remove' && ['session', 'binding'].includes(sub)) {
    const needle = tokens[2]?.trim()
    if (!needle) {
      return {
        ok: false,
        command: 'remove-session',
        message: 'Usage: boost remove session <session-id>'
      }
    }
    const candidates = config.session_bindings.filter((binding) =>
      binding.id.toLowerCase().startsWith(needle.toLowerCase())
    )
    if (candidates.length !== 1) {
      return {
        ok: false,
        command: 'remove-session',
        message:
          candidates.length === 0
            ? `No session found for '${needle}'.`
            : `Multiple sessions match '${needle}'. Use a longer id.`
      }
    }
    const target = candidates[0]
    const removed = removeSessionBinding(config, target.id)
    config = removed.config
    setConfig(config)
    return {
      ok: true,
      command: 'remove-session',
      message: `Removed session ${target.id.slice(0, 8)}.`
    }
  }

  return {
    ok: false,
    command: normalized.split(/\s+/)[0] || 'unknown',
    message: `Command '${input}' is not implemented in Boost v2 command server yet.`
  }
}

function findGitRoot(start: string): string | null {
  const pathMod = require('path') as typeof import('path')
  const fsMod = require('fs') as typeof import('fs')
  const resolved = pathMod.resolve(start)
  let current = fsMod.existsSync(resolved) && fsMod.statSync(resolved).isDirectory()
    ? resolved
    : pathMod.dirname(resolved)

  for (let i = 0; i < 10; i += 1) {
    if (fsMod.existsSync(pathMod.join(current, '.git'))) return current
    const parent = pathMod.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function runBoostInit(rootPath: string): Promise<{ ok: boolean; message: string }> {
  const command = `Set-Location -LiteralPath '${rootPath.replace(/'/g, "''")}'; boost init`
  return await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    )

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk || '')
    })

    child.on('error', (error) => {
      resolve({ ok: false, message: error.message || 'Failed to run boost init.' })
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, message: 'boost init completed.' })
        return
      }
      const detail = stderr.trim()
      if (detail.toLowerCase().includes('not recognized')) {
        resolve({
          ok: false,
          message:
            "boost command not found in PATH. Install/enable Boost CLI, then retry 'boost init'."
        })
        return
      }
      resolve({
        ok: false,
        message: detail ? `boost init failed: ${detail}` : `boost init exited with code ${code}.`
      })
    })
  })
}

async function isPidRunning(pid: number | undefined): Promise<boolean> {
  if (!pid || pid <= 0) return false
  const psList = getPsListFn()
  const processes = await psList()
  return processes.some((row: any) => Number(row?.pid || 0) === pid)
}

function launchDevServerBinding(
  project: ProjectProfile,
  binding: SessionBinding
): { ok: boolean; message: string } {
  const command = (binding.cmd_hint || '').trim()
  const cwd = (binding.cwd_hint || project.root_path || '').trim()
  if (!command || !cwd) {
    return { ok: false, message: `No restart command recorded for ${project.name} devserver.` }
  }

  const escapedCwd = cwd.replace(/'/g, "''")
  const psCommand = `Set-Location -LiteralPath '${escapedCwd}'; ${command}`
  const proc = spawn(
    'cmd.exe',
    ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  )
  proc.unref()
  return { ok: true, message: `Started devserver for ${project.name}.` }
}

async function openSurfaceForActive(surface: 'ide' | 'browser' | 'agent'): Promise<{ ok: boolean; message: string }> {
  const config = getConfig()
  const active = getActiveProject(config)
  if (!active) {
    return { ok: false, message: 'No active project selected.' }
  }

  if (surface === 'ide') {
    const defaultAgent = getDefaultBinding(config, active.id, 'agent')
    if (defaultAgent && isBindingIntegrated(defaultAgent)) {
      const focusedIntegrated = await focusIntegratedHostForBinding(defaultAgent, active)
      if (focusedIntegrated) {
        void applyIntegratedTerminalSelection(defaultAgent)
        return { ok: true, message: `Focused IDE-integrated agent host for ${active.name}` }
      }
    }
    const defaultDev = getDefaultBinding(config, active.id, 'devserver')
    if (defaultDev && isBindingIntegrated(defaultDev)) {
      const focusedIntegrated = await focusIntegratedHostForBinding(defaultDev, active)
      if (focusedIntegrated) {
        void applyIntegratedTerminalSelection(defaultDev)
        return { ok: true, message: `Focused IDE-integrated devserver host for ${active.name}` }
      }
    }
    return openIde(active)
  }

  if (surface === 'browser') {
    const activeAgent = getDefaultBinding(config, active.id, 'agent')
    const currentDevId = config.session_defaults_by_project?.[active.id]?.devserver
    const defaultDev = activeAgent
      ? pickPairedDevserverBinding(config, active.id, activeAgent, currentDevId)
      : getDefaultBinding(config, active.id, 'devserver')
    if (defaultDev) {
      if (isBindingIntegrated(defaultDev)) {
        const focusedIntegrated = await focusIntegratedHostForBinding(defaultDev, active)
        if (focusedIntegrated) {
          void applyIntegratedTerminalSelection(defaultDev)
          return { ok: true, message: `Focused IDE-integrated devserver for ${active.name}` }
        }
        const ide = openIde(active)
        return { ok: ide.ok, message: `Focused IDE host for devserver session in ${active.name}` }
      }
      const running = await isPidRunning(defaultDev.pid)
      if (defaultDev.window_id && focusWindowById(defaultDev.window_id)) {
        return { ok: true, message: `Focused devserver terminal for ${active.name}` }
      }
      if (!defaultDev.window_id && !defaultDev.pid) {
        const ide = openIde(active)
        return { ok: ide.ok, message: `Focused IDE host for devserver session in ${active.name}` }
      }
      if (running && defaultDev.pid && focusWindowByPid(defaultDev.pid)) {
        return { ok: true, message: `Focused devserver session for ${active.name}` }
      }
      if (!running && defaultDev.cmd_hint) {
        const started = launchDevServerBinding(active, defaultDev)
        if (started.ok) {
          if (defaultDev.port_hint) {
            const url = `http://localhost:${defaultDev.port_hint}`
            void shell.openExternal(url)
            return { ok: true, message: `${started.message} Opened ${url}` }
          }
          return started
        }
      }
      if (defaultDev.port_hint) {
        const url = `http://localhost:${defaultDev.port_hint}`
        void shell.openExternal(url)
        return { ok: true, message: `Opened ${url}` }
      }
    }
    return openBrowser(active)
  }

  const defaultAgent = getDefaultBinding(config, active.id, 'agent')
  if (defaultAgent) {
    if (isBindingIntegrated(defaultAgent)) {
      const focusedIntegrated = await focusIntegratedHostForBinding(defaultAgent, active)
      if (focusedIntegrated) {
        void applyIntegratedTerminalSelection(defaultAgent)
        return { ok: true, message: `Focused IDE-integrated agent for ${active.name}` }
      }
      const ide = openIde(active)
      return { ok: ide.ok, message: `Focused IDE host for agent session in ${active.name}` }
    }
    if (defaultAgent.window_id && focusWindowById(defaultAgent.window_id)) {
      return { ok: true, message: `Focused agent session for ${active.name}` }
    }
    if (!defaultAgent.window_id && !defaultAgent.pid) {
      const ide = openIde(active)
      return { ok: ide.ok, message: `Focused IDE host for agent session in ${active.name}` }
    }
    if (defaultAgent.pid && focusWindowByPid(defaultAgent.pid)) {
      return { ok: true, message: `Focused agent terminal for ${active.name}` }
    }
  }
  return openAgent(active)
}

async function cycleActiveAgentBinding(): Promise<{ ok: boolean; message: string }> {
  const config = getConfig()
  const active = getActiveProject(config)
  if (!active) {
    return { ok: false, message: 'No active project selected.' }
  }

  const agents = getProjectBindings(config, active.id, 'agent')
  if (agents.length === 0) {
    return { ok: false, message: `No agent sessions for ${active.name}. Run 'boost add agent'.` }
  }

  const currentAgent = getDefaultBinding(config, active.id, 'agent')
  const currentIndex = currentAgent ? agents.findIndex((binding) => binding.id === currentAgent.id) : -1
  const nextAgent = agents[(currentIndex + 1 + agents.length) % agents.length]

  let nextConfig = setDefaultSessionBinding(config, {
    project_id: active.id,
    type: 'agent',
    binding_id: nextAgent.id
  })

  const currentDevId = nextConfig.session_defaults_by_project?.[active.id]?.devserver
  const pairedDev = pickPairedDevserverBinding(nextConfig, active.id, nextAgent, currentDevId)
  if (pairedDev) {
    nextConfig = setDefaultSessionBinding(nextConfig, {
      project_id: active.id,
      type: 'devserver',
      binding_id: pairedDev.id
    })
  }
  setConfig(nextConfig)

  const focused = await openSurfaceForActive('agent')
  const agentLabel = (nextAgent.label || '').trim() || nextAgent.id.slice(0, 8)
  const devLabel = pairedDev ? (pairedDev.label || '').trim() || pairedDev.id.slice(0, 8) : null
  const suffix = devLabel ? ` (devserver: ${devLabel})` : ''
  return {
    ok: focused.ok,
    message: `Active agent for ${active.name}: ${agentLabel}${suffix}. ${focused.message}`
  }
}

async function buildBindingRuntimeMap(config: ProjectHubConfig): Promise<{
  projects: Array<{
    project_id: string
    ide_window_ids: number[]
    terminal_window_ids: number[]
    browser_window_ids: number[]
    ide_pids: number[]
    terminal_pids: number[]
    browser_pids: number[]
    localhost_ports: number[]
    focused: boolean
  }>
  focused_project_id: string | null
}> {
  const projects = config.projects
    .map((project) => {
      const agents = getProjectBindings(config, project.id, 'agent')
      if (agents.length === 0) return null
      const devservers = getProjectBindings(config, project.id, 'devserver')
      return {
        project_id: project.id,
        ide_window_ids: [],
        terminal_window_ids: [],
        browser_window_ids: [],
        ide_pids: [],
        terminal_pids: [...new Set([...agents.map((binding) => binding.pid || 0), ...devservers.map((binding) => binding.pid || 0)].filter((pid) => pid > 0))],
        browser_pids: [],
        localhost_ports: [...new Set(devservers.map((binding) => binding.port_hint || 0).filter((port) => port > 0))],
        focused: config.active_project_id === project.id
      }
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
  return {
    projects,
    focused_project_id: projects.some((row) => row.project_id === config.active_project_id)
      ? config.active_project_id
      : null
  }
}

async function buildBindingActivity(config: ProjectHubConfig): Promise<{
  projects: Array<{
    project_id: string
    ide_windows: number
    terminal_windows: number
    browser_windows: number
    total_windows: number
    focused: boolean
  }>
  focused_project_id: string | null
}> {
  const runtime = await buildBindingRuntimeMap(config)
  return {
    projects: runtime.projects.map((row) => {
      const terminal_windows = Math.max(1, row.terminal_pids.length)
      const browser_windows = row.localhost_ports.length > 0 ? 1 : 0
      const ide_windows = 0
      return {
        project_id: row.project_id,
        ide_windows,
        terminal_windows,
        browser_windows,
        total_windows: ide_windows + terminal_windows + browser_windows,
        focused: row.focused
      }
    }),
    focused_project_id: runtime.focused_project_id
  }
}

function createWindow(showOnReady: boolean = true): BrowserWindow {
  if (mainWindow) {
    if (showOnReady) {
      mainWindow.show()
      mainWindow.focus()
    }
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#050505',
    titleBarStyle: 'hidden',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (showOnReady) mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuittingApp) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus()
    return overlayWindow
  }

  overlayWindow = new BrowserWindow({
    width: 720,
    height: 520,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  overlayWindow.on('ready-to-show', () => {
    overlayWindow?.show()
    overlayWindow?.focus()
  })

  overlayWindow.on('blur', () => {
    overlayWindow?.close()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#project-switcher`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'project-switcher' })
  }

  return overlayWindow
}

function createTray(): void {
  tray = new Tray(appIcon.resize({ width: 24, height: 24 }))
  tray.setToolTip('Boost v2')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Boost v2', enabled: false },
      { type: 'separator' },
      { label: 'Open Dashboard', click: () => createWindow(true) },
      { label: 'Project Switcher', click: () => createOverlayWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )

  tray.on('double-click', () => createWindow(true))
}

function registerShortcuts(): void {
  const config = getConfig()
  globalShortcut.unregisterAll()

  globalShortcut.register(config.shortcuts.switcher, () => {
    createOverlayWindow()
  })

  globalShortcut.register(config.shortcuts.open_ide, () => {
    void openSurfaceForActive('ide')
  })

  globalShortcut.register(config.shortcuts.open_browser, () => {
    void openSurfaceForActive('browser')
  })

  globalShortcut.register(config.shortcuts.open_agent, () => {
    void openSurfaceForActive('agent')
  })

  globalShortcut.register(config.shortcuts.cycle_agent, () => {
    void cycleActiveAgentBinding()
  })
}

function setupIpc(): void {
  const channels = [
    'project-hub:get-config',
    'project-hub:save-project',
    'project-hub:delete-project',
    'project-hub:set-active',
    'project-hub:discover-projects',
    'project-hub:boost-init',
    'project-hub:get-activity',
    'project-hub:get-runtime-map',
    'project-hub:get-runtime-debug',
    'project-hub:get-terminal-content-debug',
    'project-hub:get-runtime-map-llm',
    'project-hub:auto-classify',
    'project-hub:record-runtime-feedback',
    'project-hub:clear-runtime-feedback',
    'project-hub:open-surface',
    'project-hub:update-shortcuts',
    'overlay:close',
    'window:minimize',
    'window:close'
  ]

  // Dev hot-reload can preserve old handlers; clear before re-registering.
  for (const channel of channels) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle('project-hub:get-config', () => {
    return getConfig()
  })

  ipcMain.handle(
    'project-hub:save-project',
    (
      _,
      project: Omit<ProjectProfile, 'id' | 'created_at' | 'updated_at'> & { id?: string }
    ) => {
      const config = getConfig()
      const id = project.id || randomUUID()
      const next = upsertProject(config, {
        id,
        name: project.name,
        root_path: project.root_path,
        ide_command: project.ide_command,
        agent_command: project.agent_command,
        dev_url: project.dev_url,
        browser_hint: project.browser_hint,
        agent_hint: project.agent_hint,
        ide_hint: project.ide_hint
      })

      if (!next.active_project_id) {
        next.active_project_id = id
      }

      setConfig(next)
      return next
    }
  )

  ipcMain.handle('project-hub:delete-project', (_, projectId: string) => {
    const config = getConfig()
    const nextProjects = config.projects.filter((p) => p.id !== projectId)
    const nextBindings = config.session_bindings.filter((binding) => binding.project_id !== projectId)
    const nextDefaults = { ...config.session_defaults_by_project }
    delete nextDefaults[projectId]
    const next: ProjectHubConfig = {
      ...config,
      projects: nextProjects,
      session_bindings: nextBindings,
      session_defaults_by_project: nextDefaults,
      active_project_id:
        config.active_project_id === projectId
          ? nextProjects[0]?.id || null
          : config.active_project_id
    }
    setConfig(next)
    return next
  })

  ipcMain.handle('project-hub:set-active', (_, projectId: string) => {
    const config = getConfig()
    const exists = config.projects.some((p) => p.id === projectId)
    if (!exists) throw new Error('Project not found')
    const next = { ...config, active_project_id: projectId }
    setConfig(next)
    return next
  })

  ipcMain.handle('project-hub:get-activity', async () => {
    const config = getConfig()
    return await buildBindingActivity(config)
  })

  ipcMain.handle('project-hub:get-runtime-map', async () => {
    const config = getConfig()
    return await buildBindingRuntimeMap(config)
  })

  ipcMain.handle('project-hub:get-runtime-debug', async () => {
    const config = getConfig()
    return {
      runtime: await buildBindingRuntimeMap(config),
      debug: {
        terminal_pid_assignments: [],
        terminal_window_assignments: []
      }
    }
  })

  ipcMain.handle('project-hub:get-terminal-content-debug', async () => {
    const config = getConfig()
    return {
      projects: [],
      focused_project_id: (await buildBindingRuntimeMap(config)).focused_project_id
    }
  })

  ipcMain.handle('project-hub:get-runtime-map-llm', async () => {
    const config = getConfig()
    return await buildBindingRuntimeMap(config)
  })

  ipcMain.handle('project-hub:discover-projects', async () => {
    const config = getConfig()
    const discovered = await discoverProjectProfiles()
    if (discovered.length === 0) {
      return {
        ok: false,
        message: 'No repositories found from active tools or common folders.',
        added: 0,
        config
      }
    }

    let next = config
    let added = 0
    const existingRoots = new Set(config.projects.map((p) => p.root_path.toLowerCase()))

    for (const project of discovered) {
      const root = project.root_path.toLowerCase()
      if (existingRoots.has(root)) continue
      const id = randomUUID()
      next = upsertProject(next, {
        id,
        ...project
      })
      existingRoots.add(root)
      added += 1
    }

    if (!next.active_project_id && next.projects.length > 0) {
      next.active_project_id = next.projects[0].id
    }

    setConfig(next)
    return {
      ok: true,
      message: `Discovered ${added} project(s).`,
      added,
      config: next
    }
  })

  ipcMain.handle(
    'project-hub:boost-init',
    async (_, payload?: { projectId?: string; rootPath?: string }) => {
      const config = getConfig()
      const fromId = payload?.projectId
        ? config.projects.find((p) => p.id === payload.projectId)?.root_path
        : null
      const activeRoot = getActiveProject(config)?.root_path || null
      const rootPath = (payload?.rootPath || fromId || activeRoot || process.cwd()).trim()

      const initResult = await runBoostInit(rootPath)
      if (!initResult.ok) {
        return { ok: false, message: initResult.message, config }
      }

      const tracked = ensureProjectTracked(config, rootPath)
      const next = tracked.config
      const project = tracked.project
      setConfig(next)
      return {
        ok: true,
        message: `Initialized and tracked: ${project.name}`,
        config: next,
        project_id: project.id,
        root_path: project.root_path
      }
    }
  )

  ipcMain.handle('project-hub:auto-classify', async (_, projectId?: string) => {
    const config = getConfig()
    const targets = projectId
      ? config.projects.filter((p) => p.id === projectId)
      : config.projects

    if (targets.length === 0) {
      return {
        ok: false,
        message: projectId ? 'Project not found.' : 'No projects configured.',
        updated: 0
      }
    }

    const classified = await classifyProjectsWithLLM(targets)
    let next = config
    let updated = 0
    const details: Array<{ id: string; confidence?: number; reason?: string }> = []

    for (const item of classified.projects) {
      const existing = next.projects.find((p) => p.id === item.id)
      if (!existing) continue

      next = upsertProject(next, {
        ...existing,
        ide_command: item.ide_command?.trim() || existing.ide_command,
        agent_command: item.agent_command?.trim() || existing.agent_command,
        dev_url: item.dev_url?.trim() || existing.dev_url,
        ide_hint: item.ide_hint?.trim() || existing.ide_hint,
        agent_hint: item.agent_hint?.trim() || existing.agent_hint,
        browser_hint: item.browser_hint?.trim() || existing.browser_hint
      })
      updated += 1
      details.push({ id: existing.id, confidence: item.confidence, reason: item.reason })
    }

    setConfig(next)
    return {
      ok: true,
      message: `Auto-classified ${updated} project(s).`,
      updated,
      details,
      config: next
    }
  })

  ipcMain.handle(
    'project-hub:record-runtime-feedback',
    (
      _,
      payload: {
        scope: RuntimeFeedbackScope
        surface: RuntimeSurface
        key: number
        project_id: string | null
      }
    ) => {
      const config = getConfig()
      if (payload.project_id && !config.projects.some((p) => p.id === payload.project_id)) {
        return {
          ok: false,
          message: 'Project not found.',
          config
        }
      }
      if (!Number.isFinite(payload.key) || payload.key <= 0) {
        return {
          ok: false,
          message: 'Feedback key must be a positive number.',
          config
        }
      }

      const next = recordRuntimeFeedback(config, payload)
      setConfig(next)
      return {
        ok: true,
        message: payload.project_id ? 'Runtime feedback recorded.' : 'Runtime feedback removed.',
        config: next
      }
    }
  )

  ipcMain.handle(
    'project-hub:clear-runtime-feedback',
    (_, payload?: { scope?: RuntimeFeedbackScope; surface?: RuntimeSurface }) => {
      const config = getConfig()
      const next = clearRuntimeFeedback(config, payload)
      setConfig(next)
      return {
        ok: true,
        message: 'Runtime feedback cleared.',
        config: next
      }
    }
  )

  ipcMain.handle('project-hub:open-surface', async (_, surface: 'ide' | 'browser' | 'agent') => {
    return await openSurfaceForActive(surface)
  })

  ipcMain.handle('project-hub:update-shortcuts', (_, shortcuts: Partial<ProjectHubConfig['shortcuts']>) => {
    const config = getConfig()
    const next = {
      ...config,
      shortcuts: {
        ...config.shortcuts,
        ...shortcuts
      }
    }
    setConfig(next)
    registerShortcuts()
    return next
  })

  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close()
      overlayWindow = null
    }
  })

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.close()
  })
}

app.whenReady().then(() => {
  console.log('[Boost v2] App ready: starting services')
  setupIpc()
  commandServer = new CommandServer(executeCommandServerInput, 45700)
  void commandServer.start().catch((error) => {
    console.error('[Boost v2] Failed to start command server:', error)
  })
  createTray()
  createWindow(false)
  registerShortcuts()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true)
    }
  })
})

app.on('before-quit', () => {
  isQuittingApp = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (commandServer) {
    void commandServer.stop()
    commandServer = null
  }
})

app.on('window-all-closed', () => {
  // Keep tray-first behavior on all platforms.
})
