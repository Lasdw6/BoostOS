import { spawnSync } from 'child_process'
import type { ProjectHubConfig, ProjectProfile } from '../shared/project-hub'
import { getPsListFn } from './ps-list-loader'
import { windowManager } from './window-manager'

type Surface = 'ide' | 'terminal' | 'browser'

type ProcessRow = {
  pid: number
  ppid: number
  name: string
  cmd: string
  cwd: string
}

type WindowRow = {
  id: number
  pid: number
  path: string
  title: string
}

type ProjectMatchers = {
  id: string
  root: string
  rootBasename: string
  name: string
  hints: string[]
}

export type ProjectRuntime = {
  project_id: string
  ide_window_ids: number[]
  terminal_window_ids: number[]
  browser_window_ids: number[]
  ide_pids: number[]
  terminal_pids: number[]
  browser_pids: number[]
  localhost_ports: number[]
  focused: boolean
}

export type ProjectRuntimeMap = {
  projects: ProjectRuntime[]
  focused_project_id: string | null
}

export type RuntimeDebug = {
  terminal_pid_assignments: Array<{
    pid: number
    project_id: string
    name: string
    cwd: string
    cmd: string
    reasons: string[]
  }>
  terminal_window_assignments: Array<{
    window_id: number
    pid: number
    project_id: string
    title: string
    path: string
    reasons: string[]
  }>
}

export type ProjectRuntimeDebug = {
  runtime: ProjectRuntimeMap
  debug: RuntimeDebug
}

export type TerminalContentDebug = {
  project_id: string
  project_name: string
  sessions: Array<{
    pid: number
    name: string
    cwd: string
    command: string
    window_ids: number[]
    window_titles: string[]
    child_commands: string[]
  }>
}

export type ProjectActivity = {
  project_id: string
  ide_windows: number
  terminal_windows: number
  browser_windows: number
  total_windows: number
  focused: boolean
}

function low(value: string): string {
  return (value || '').toLowerCase()
}

function normalizePath(value: string): string {
  return low(value).replace(/[\\/]+$/, '')
}

function isWeakHint(value: string): boolean {
  const v = low(value).trim()
  if (!v) return true
  if (v.length < 4) return true
  return [
    'app',
    'apps',
    'project',
    'projects',
    'repo',
    'repos',
    'web',
    'site',
    'test',
    'demo'
  ].includes(v)
}

function uniqNumbers(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))]
}

function feedbackProjectId(
  config: ProjectHubConfig,
  scope: 'pid' | 'window' | 'port',
  surface: Surface,
  key: number
): string | null {
  const raw = config.runtime_feedback?.[scope]?.[surface]?.[String(key)] || null
  if (!raw) return null
  return config.projects.some((p) => p.id === raw) ? raw : null
}

function getSurfaceFromProcessName(name: string): Surface | null {
  const n = low(name)
  if (n.includes('cursor') || n.includes('code') || n.includes('zed')) return 'ide'
  if (
    n.includes('windowsterminal') ||
    n.includes('openconsole') ||
    n.includes('conhost') ||
    n === 'wsl.exe' ||
    n === 'wslhost.exe' ||
    n.includes('wezterm') ||
    n.includes('pwsh') ||
    n.includes('powershell') ||
    n === 'cmd.exe' ||
    n === 'cmd' ||
    n === 'bash' ||
    n === 'zsh' ||
    n === 'fish'
  ) return 'terminal'
  if (n.includes('chrome') || n.includes('msedge') || n.includes('brave') || n.includes('firefox')) return 'browser'
  return null
}

function isLikelyCliWorkerProcess(process: ProcessRow): boolean {
  const name = low(process.name)
  const cmd = low(process.cmd)
  return (
    name === 'node.exe' ||
    name === 'node' ||
    name === 'npm.cmd' ||
    name === 'npm.exe' ||
    name === 'pnpm.exe' ||
    name === 'pnpm.cmd' ||
    name === 'yarn.cmd' ||
    name === 'yarn.exe' ||
    name === 'bun.exe' ||
    name === 'bun' ||
    name === 'python.exe' ||
    name === 'python' ||
    name === 'deno.exe' ||
    name === 'deno' ||
    name === 'go.exe' ||
    name === 'cargo.exe' ||
    name === 'dotnet.exe' ||
    cmd.includes('npm run') ||
    cmd.includes('pnpm ') ||
    cmd.includes('yarn ') ||
    cmd.includes('bun ') ||
    cmd.includes('python ') ||
    cmd.includes('node ') ||
    cmd.includes('vite') ||
    cmd.includes('next dev') ||
    cmd.includes('webpack') ||
    cmd.includes('turbo') ||
    cmd.includes('nx ')
  )
}

function looksLikeTerminalCommand(cmd: string): boolean {
  const c = low(cmd)
  return (
    c.includes(' codex') ||
    c.includes(' claude') ||
    c.includes(' opencode') ||
    c.includes('vite') ||
    c.includes('next dev') ||
    c.includes('webpack') ||
    c.includes('npm run dev') ||
    c.includes('pnpm dev') ||
    c.includes('bun run dev')
  )
}

function buildMatchers(project: ProjectProfile): ProjectMatchers {
  const root = normalizePath(project.root_path)
  const rootBasename = normalizePath(project.root_path.split(/[\\/]/).pop() || '')
  const name = low(project.name || rootBasename)

  const hints = [
    isWeakHint(name) ? '' : name,
    low(project.ide_hint || ''),
    low(project.agent_hint || ''),
    low(project.browser_hint || ''),
    isWeakHint(rootBasename) ? '' : rootBasename
  ].filter((h) => h && !isWeakHint(h))

  try {
    const url = new URL(project.dev_url)
    if (url.hostname) hints.push(low(url.hostname))
    if (url.port) hints.push(low(url.port))
  } catch {}

  return {
    id: project.id,
    root,
    rootBasename,
    name,
    hints: [...new Set(hints)]
  }
}

function matchProjectIdByText(projects: ProjectMatchers[], text: string): string | null {
  const hay = low(text)
  let best: { id: string; score: number } | null = null

  for (const project of projects) {
    let score = 0
    let hintMatches = 0

    if (project.root && hay.includes(project.root)) score += 20
    if (project.rootBasename && !isWeakHint(project.rootBasename) && hay.includes(project.rootBasename)) {
      score += 6
      hintMatches += 1
    }
    for (const hint of project.hints) {
      if (hint && hay.includes(hint)) score += hint.length >= 4 ? 2 : 1
      if (hint && hay.includes(hint)) hintMatches += 1
    }

    // Avoid weak false positives (e.g., project name "app" matching AppData).
    const hasStrongRoot = project.root && hay.includes(project.root)
    if (!hasStrongRoot && hintMatches < 2) {
      continue
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { id: project.id, score }
    }
  }

  return best?.id || null
}

function parsePortFromText(text: string): number | null {
  const t = low(text)
  const fromUrl = t.match(/(?:localhost|127\.0\.0\.1):(\d{2,5})/)
  if (fromUrl?.[1]) return Number(fromUrl[1])

  const fromFlag = t.match(/(?:--port|-p|port=)\s*([0-9]{2,5})/)
  if (fromFlag?.[1]) return Number(fromFlag[1])

  return null
}

function parseListeningPortsByPid(): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>()

  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout) return out

  const lines = String(result.stdout).split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!/LISTENING/i.test(trimmed)) continue

    const parts = trimmed.split(/\s+/)
    if (parts.length < 5) continue
    const localAddress = parts[1] || ''
    const state = parts[3] || ''
    const pidRaw = parts[4] || ''
    if (!/LISTENING/i.test(state)) continue

    const portMatch = localAddress.match(/:(\d{2,5})$/)
    const port = portMatch ? Number(portMatch[1]) : NaN
    const pid = Number(pidRaw)
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue

    if (!out.has(pid)) out.set(pid, new Set<number>())
    out.get(pid)?.add(port)
  }

  return out
}

function makeWindowRows(): WindowRow[] {
  const raw = windowManager.getAllWindows()
  return raw
    .map((win: any) => {
      const title = String(win.getTitle?.() || '')
      const path = String(win.path || '')
      const pid = typeof win.processId === 'number' ? win.processId : 0
      const id = typeof win.id === 'number' ? win.id : 0
      return { id, pid, path, title }
    })
    .filter((w) => w.id > 0)
}

function buildProcessIndexes(processes: ProcessRow[]): {
  byPid: Map<number, ProcessRow>
  childrenByPid: Map<number, number[]>
} {
  const byPid = new Map<number, ProcessRow>()
  const childrenByPid = new Map<number, number[]>()

  for (const process of processes) {
    byPid.set(process.pid, process)
    if (!childrenByPid.has(process.ppid)) childrenByPid.set(process.ppid, [])
    childrenByPid.get(process.ppid)?.push(process.pid)
  }

  return { byPid, childrenByPid }
}

function ancestorsOf(pid: number, byPid: Map<number, ProcessRow>, maxDepth = 8): number[] {
  const out: number[] = []
  let cursor = pid
  for (let i = 0; i < maxDepth; i += 1) {
    const row = byPid.get(cursor)
    if (!row || !row.ppid || row.ppid === cursor) break
    out.push(row.ppid)
    cursor = row.ppid
  }
  return out
}

function processTreePids(rootPid: number, childrenByPid: Map<number, number[]>, maxDepth = 3): number[] {
  const out: number[] = []
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
  const seen = new Set<number>()

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    if (seen.has(next.pid)) continue
    seen.add(next.pid)
    out.push(next.pid)
    if (next.depth >= maxDepth) continue
    for (const child of childrenByPid.get(next.pid) || []) {
      queue.push({ pid: child, depth: next.depth + 1 })
    }
  }

  return out
}

function isNoisySystemWindowTitle(title: string): boolean {
  const t = low(title).trim()
  if (!t) return true
  return (
    t === 'default ime' ||
    t === 'msctfime ui' ||
    t === 'task switching' ||
    t === 'program manager' ||
    t === 'battery meter' ||
    t.includes('desktopwindowxamlsource') ||
    t.includes('system tray overflow window') ||
    t.includes('bluetoothnotificationareaiconwindowclass')
  )
}

function isUsefulTerminalContentSession(session: {
  name: string
  cwd: string
  command: string
  window_titles: string[]
  child_commands: string[]
}): boolean {
  const hasContent = Boolean(
    session.command.trim() ||
    session.cwd.trim() ||
    session.child_commands.length > 0 ||
    session.window_titles.length > 0
  )
  if (!hasContent) return false
  const name = low(session.name)
  if ((name === 'conhost.exe' || name === 'openconsole.exe') && !session.command.trim() && session.child_commands.length === 0) {
    return session.window_titles.length > 0
  }
  return true
}

type MutableRuntimeDebugCollector = {
  pidReasons: Map<string, { pid: number; project_id: string; name: string; cwd: string; cmd: string; reasons: Set<string> }>
  windowReasons: Map<
    string,
    { window_id: number; pid: number; project_id: string; title: string; path: string; reasons: Set<string> }
  >
}

function createRuntimeDebugCollector(): MutableRuntimeDebugCollector {
  return {
    pidReasons: new Map(),
    windowReasons: new Map()
  }
}

function finalizeRuntimeDebug(collector: MutableRuntimeDebugCollector): RuntimeDebug {
  return {
    terminal_pid_assignments: [...collector.pidReasons.values()]
      .map((row) => ({ ...row, reasons: [...row.reasons] }))
      .sort((a, b) => a.project_id.localeCompare(b.project_id) || a.pid - b.pid),
    terminal_window_assignments: [...collector.windowReasons.values()]
      .map((row) => ({ ...row, reasons: [...row.reasons] }))
      .sort((a, b) => a.project_id.localeCompare(b.project_id) || a.window_id - b.window_id)
  }
}

export async function computeProjectRuntimeMap(
  config: ProjectHubConfig,
  debugCollector?: MutableRuntimeDebugCollector
): Promise<ProjectRuntimeMap> {
  const projects = config.projects.map(buildMatchers)
  const psList = getPsListFn()
  const rawProcesses = await psList()
  const processes: ProcessRow[] = rawProcesses.map((row: any) => ({
    pid: Number(row.pid) || 0,
    ppid: Number(row.ppid) || 0,
    name: String(row.name || ''),
    cmd: String(row.cmd || ''),
    cwd: String(row.cwd || '')
  }))

  const windows = makeWindowRows()
  const { byPid, childrenByPid } = buildProcessIndexes(processes)
  const listeningPortsByPid = parseListeningPortsByPid()

  const runtimeById = new Map<string, ProjectRuntime>()
  for (const project of config.projects) {
    runtimeById.set(project.id, {
      project_id: project.id,
      ide_window_ids: [],
      terminal_window_ids: [],
      browser_window_ids: [],
      ide_pids: [],
      terminal_pids: [],
      browser_pids: [],
      localhost_ports: [],
      focused: false
    })
  }

  const projectIdsByIdePid = new Map<number, Set<string>>()
  const projectByTerminalPid = new Map<number, string>()
  const projectByPort = new Map<number, string>()
  const projectById = new Map(config.projects.map((p) => [p.id, p]))
  const windowById = new Map(windows.map((w) => [w.id, w]))

  const addTerminalPidReason = (pid: number, projectId: string, reason: string): void => {
    if (!debugCollector) return
    const key = `${projectId}:${pid}`
    const process = byPid.get(pid)
    const existing = debugCollector.pidReasons.get(key) || {
      pid,
      project_id: projectId,
      name: process?.name || '',
      cwd: process?.cwd || '',
      cmd: process?.cmd || '',
      reasons: new Set<string>()
    }
    existing.reasons.add(reason)
    debugCollector.pidReasons.set(key, existing)
  }

  const addTerminalWindowReason = (windowId: number, pid: number, projectId: string, reason: string): void => {
    if (!debugCollector) return
    const key = `${projectId}:${windowId}`
    const win = windowById.get(windowId)
    const existing = debugCollector.windowReasons.get(key) || {
      window_id: windowId,
      pid,
      project_id: projectId,
      title: win?.title || '',
      path: win?.path || '',
      reasons: new Set<string>()
    }
    existing.reasons.add(reason)
    debugCollector.windowReasons.set(key, existing)
  }

  const attachTerminalProcess = (pid: number, projectId: string, reason: string): void => {
    projectByTerminalPid.set(pid, projectId)
    const runtime = runtimeById.get(projectId)
    if (!runtime) return
    runtime.terminal_pids.push(pid)
    addTerminalPidReason(pid, projectId, reason)

    for (const treePid of processTreePids(pid, childrenByPid, 2)) {
      const ownPorts = listeningPortsByPid.get(treePid)
      if (!ownPorts) continue
      for (const port of ownPorts) {
        runtime.localhost_ports.push(port)
        projectByPort.set(port, projectId)
      }
    }

    const row = byPid.get(pid)
    const cmdPort = row ? parsePortFromText(row.cmd) : null
    if (cmdPort) {
      runtime.localhost_ports.push(cmdPort)
      projectByPort.set(cmdPort, projectId)
    }
  }

  // 1) IDE windows/processes -> project by title/path match
  for (const window of windows) {
    const processName = window.path.split(/[\\/]/).pop() || ''
    if (getSurfaceFromProcessName(processName) !== 'ide') continue

    const projectId =
      feedbackProjectId(config, 'window', 'ide', window.id) ||
      feedbackProjectId(config, 'pid', 'ide', window.pid) ||
      matchProjectIdByText(projects, `${window.title} ${window.path}`)
    if (!projectId) continue
    const runtime = runtimeById.get(projectId)
    if (!runtime) continue

    runtime.ide_window_ids.push(window.id)
    runtime.ide_pids.push(window.pid)
    if (!projectIdsByIdePid.has(window.pid)) projectIdsByIdePid.set(window.pid, new Set<string>())
    projectIdsByIdePid.get(window.pid)?.add(projectId)
  }

  // 1b) IDE processes -> project by cwd/cmd/name text match.
  for (const process of processes) {
    if (getSurfaceFromProcessName(process.name) !== 'ide') continue
    const projectId = matchProjectIdByText(projects, `${process.cwd} ${process.cmd} ${process.name}`)
    if (!projectId) continue
    if (!projectIdsByIdePid.has(process.pid)) projectIdsByIdePid.set(process.pid, new Set<string>())
    projectIdsByIdePid.get(process.pid)?.add(projectId)
    const runtime = runtimeById.get(projectId)
    if (!runtime) continue
    runtime.ide_pids.push(process.pid)
  }

  // 2) Terminal processes -> project by cwd/cmd, then IDE ancestry
  for (const process of processes) {
    const surface = getSurfaceFromProcessName(process.name) || (looksLikeTerminalCommand(process.cmd) ? 'terminal' : null)
    if (surface !== 'terminal') continue

    let terminalReason = ''
    let projectId =
      feedbackProjectId(config, 'pid', 'terminal', process.pid) ||
      matchProjectIdByText(projects, `${process.cwd} ${process.cmd}`)
    if (projectId && feedbackProjectId(config, 'pid', 'terminal', process.pid) === projectId) {
      terminalReason = 'feedback:pid:terminal'
    } else if (projectId) {
      terminalReason = 'terminal:text-match(cwd/cmd)'
    }

    if (!projectId) {
      const chain = ancestorsOf(process.pid, byPid, 10)
      for (const ancestorPid of chain) {
        const ids = projectIdsByIdePid.get(ancestorPid)
        if (!ids || ids.size !== 1) continue
        projectId = [...ids][0]
        terminalReason = `terminal:ide-ancestor:${ancestorPid}`
        break
      }
    }

    if (!projectId) continue
    attachTerminalProcess(process.pid, projectId, terminalReason || 'terminal:direct')
  }

  // 2b) Integrated terminal descendants:
  // If a process descends from a known terminal PID, inherit its project assignment.
  for (const process of processes) {
    if (projectByTerminalPid.has(process.pid)) continue
    const chain = ancestorsOf(process.pid, byPid, 12)
    let inherited: string | null = null
    for (const ancestorPid of chain) {
      const byTerminal = projectByTerminalPid.get(ancestorPid)
      if (byTerminal) {
        inherited = byTerminal
        addTerminalPidReason(process.pid, inherited, `terminal:descendant-of-terminal:${ancestorPid}`)
        break
      }
    }
    if (!inherited) continue
    attachTerminalProcess(process.pid, inherited, 'terminal:inherited-from-terminal-ancestor')
  }

  // 2c) IDE-hosted integrated terminals without explicit shell names.
  for (const process of processes) {
    if (projectByTerminalPid.has(process.pid)) continue
    if (!isLikelyCliWorkerProcess(process)) continue

    const chain = ancestorsOf(process.pid, byPid, 12)
    let ideProjectId: string | null = null
    for (const ancestorPid of chain) {
      const ids = projectIdsByIdePid.get(ancestorPid)
      if (!ids || ids.size !== 1) continue
      ideProjectId = [...ids][0]
      break
    }
    if (!ideProjectId) continue

    const projectRoot = normalizePath(projectById.get(ideProjectId)?.root_path || '')
    const cwd = normalizePath(process.cwd || '')
    const cwdMatchesRoot = Boolean(projectRoot && cwd && (cwd === projectRoot || cwd.startsWith(`${projectRoot}\\`)))
    if (!cwdMatchesRoot) continue

    attachTerminalProcess(process.pid, ideProjectId, 'terminal:ide-integrated(cwd+ide-ancestor)')
  }

  // 3) Terminal windows -> map by pid or ancestry
  for (const window of windows) {
    const processName = window.path.split(/[\\/]/).pop() || ''
    if (getSurfaceFromProcessName(processName) !== 'terminal') continue

    let windowReason = ''
    let projectId = feedbackProjectId(config, 'window', 'terminal', window.id)
    if (projectId) windowReason = 'feedback:window:terminal'
    if (!projectId) {
      projectId = feedbackProjectId(config, 'pid', 'terminal', window.pid)
      if (projectId) windowReason = 'feedback:pid:terminal'
    }
    if (!projectId) {
      projectId = projectByTerminalPid.get(window.pid) || null
      if (projectId) windowReason = 'terminal-window:pid-mapped'
    }
    if (!projectId) {
      const chain = ancestorsOf(window.pid, byPid, 8)
      for (const ancestorPid of chain) {
        const fromTerminal = projectByTerminalPid.get(ancestorPid)
        if (fromTerminal) {
          projectId = fromTerminal
          windowReason = `terminal-window:terminal-ancestor:${ancestorPid}`
          break
        }
        const ids = projectIdsByIdePid.get(ancestorPid)
        if (ids && ids.size === 1) {
          projectId = [...ids][0]
          windowReason = `terminal-window:ide-ancestor:${ancestorPid}`
          break
        }
      }
    }
    if (!projectId) {
      projectId = matchProjectIdByText(projects, `${window.title} ${window.path}`)
      if (projectId) windowReason = 'terminal-window:text-match(title/path)'
    }
    if (!projectId) continue

    const runtime = runtimeById.get(projectId)
    if (!runtime) continue
    runtime.terminal_window_ids.push(window.id)
    addTerminalWindowReason(window.id, window.pid, projectId, windowReason || 'terminal-window:assigned')
  }

  // 4) Browser localhost windows -> map by port first; text fallback only if strong match.
  for (const window of windows) {
    const processName = window.path.split(/[\\/]/).pop() || ''
    if (getSurfaceFromProcessName(processName) !== 'browser') continue

    const port = parsePortFromText(window.title)
    let projectId =
      feedbackProjectId(config, 'window', 'browser', window.id) ||
      feedbackProjectId(config, 'pid', 'browser', window.pid) ||
      (port ? feedbackProjectId(config, 'port', 'browser', port) : null) ||
      (port ? projectByPort.get(port) || null : null)
    if (!projectId) {
      // Browser text matching is noisy; require stronger evidence from title only.
      projectId = matchProjectIdByText(projects, window.title)
    }
    if (!projectId) continue

    const runtime = runtimeById.get(projectId)
    if (!runtime) continue
    runtime.browser_window_ids.push(window.id)
    runtime.browser_pids.push(window.pid)
    if (port) runtime.localhost_ports.push(port)
  }

  let focusedProjectId: string | null = null
  const active = windowManager.getActiveWindow()
  if (active) {
    const activePid = typeof active.processId === 'number' ? active.processId : 0
    const title = String(active.getTitle?.() || '')
    const processPath = String(active.path || '')
    const activeWindowId = typeof active.id === 'number' ? active.id : 0

    focusedProjectId =
      feedbackProjectId(config, 'window', 'terminal', activeWindowId) ||
      feedbackProjectId(config, 'pid', 'terminal', activePid) ||
      feedbackProjectId(config, 'window', 'ide', activeWindowId) ||
      feedbackProjectId(config, 'pid', 'ide', activePid) ||
      feedbackProjectId(config, 'window', 'browser', activeWindowId) ||
      feedbackProjectId(config, 'pid', 'browser', activePid) ||
      projectByTerminalPid.get(activePid) ||
      (() => {
        const ids = projectIdsByIdePid.get(activePid)
        if (!ids || ids.size !== 1) return null
        return [...ids][0]
      })() ||
      matchProjectIdByText(projects, `${title} ${processPath}`)
  }

  const runtimeProjects = [...runtimeById.values()].map((row) => {
    const focused = focusedProjectId === row.project_id
    return {
      ...row,
      ide_window_ids: uniqNumbers(row.ide_window_ids),
      terminal_window_ids: uniqNumbers(row.terminal_window_ids),
      browser_window_ids: uniqNumbers(row.browser_window_ids),
      ide_pids: uniqNumbers(row.ide_pids),
      terminal_pids: uniqNumbers(row.terminal_pids),
      browser_pids: uniqNumbers(row.browser_pids),
      localhost_ports: uniqNumbers(row.localhost_ports),
      focused
    }
  })

  return {
    projects: runtimeProjects,
    focused_project_id: focusedProjectId || null
  }
}

export async function computeProjectRuntimeDebug(config: ProjectHubConfig): Promise<ProjectRuntimeDebug> {
  const collector = createRuntimeDebugCollector()
  const runtime = await computeProjectRuntimeMap(config, collector)
  return {
    runtime,
    debug: finalizeRuntimeDebug(collector)
  }
}

export async function computeProjectActivity(config: ProjectHubConfig): Promise<{
  projects: ProjectActivity[]
  focused_project_id: string | null
}> {
  const runtime = await computeProjectRuntimeMap(config)
  return {
    projects: runtime.projects.map((row) => ({
      project_id: row.project_id,
      ide_windows: Math.max(row.ide_window_ids.length, row.ide_pids.length > 0 ? 1 : 0),
      terminal_windows: Math.max(row.terminal_window_ids.length, row.terminal_pids.length > 0 ? 1 : 0),
      browser_windows: Math.max(row.browser_window_ids.length, row.localhost_ports.length > 0 ? 1 : 0),
      total_windows:
        Math.max(row.ide_window_ids.length, row.ide_pids.length > 0 ? 1 : 0) +
        Math.max(row.terminal_window_ids.length, row.terminal_pids.length > 0 ? 1 : 0) +
        Math.max(row.browser_window_ids.length, row.localhost_ports.length > 0 ? 1 : 0),
      focused: row.focused
    })),
    focused_project_id: runtime.focused_project_id
  }
}

export function applyTerminalHeartbeat(
  activity: { projects: ProjectActivity[]; focused_project_id: string | null },
  terminalProjectIds: Set<string>
): { projects: ProjectActivity[]; focused_project_id: string | null } {
  if (terminalProjectIds.size === 0) return activity

  const projects = activity.projects.map((row) => {
    if (!terminalProjectIds.has(row.project_id)) return row
    const terminal_windows = Math.max(row.terminal_windows, 1)
    const total_windows = Math.max(row.total_windows, row.ide_windows + row.browser_windows + terminal_windows)
    return { ...row, terminal_windows, total_windows }
  })

  return { ...activity, projects }
}

export async function computeTerminalContentDebug(config: ProjectHubConfig): Promise<{
  projects: TerminalContentDebug[]
  focused_project_id: string | null
}> {
  const runtime = await computeProjectRuntimeMap(config)
  const psList = getPsListFn()
  const rows = await psList()
  const processes: ProcessRow[] = rows.map((row: any) => ({
    pid: Number(row.pid) || 0,
    ppid: Number(row.ppid) || 0,
    name: String(row.name || ''),
    cmd: String(row.cmd || ''),
    cwd: String(row.cwd || '')
  }))
  const { byPid, childrenByPid } = buildProcessIndexes(processes)
  const windows = makeWindowRows()
  const windowsByPid = new Map<number, WindowRow[]>()
  for (const window of windows) {
    if (!windowsByPid.has(window.pid)) windowsByPid.set(window.pid, [])
    windowsByPid.get(window.pid)?.push(window)
  }
  const allTerminalCandidatePids = new Set<number>()
  for (const process of processes) {
    const isTerminalSurface = getSurfaceFromProcessName(process.name) === 'terminal'
    const isTerminalLike = looksLikeTerminalCommand(process.cmd) || isLikelyCliWorkerProcess(process)
    if (process.pid > 0 && (isTerminalSurface || isTerminalLike)) {
      allTerminalCandidatePids.add(process.pid)
    }
  }

  const projectById = new Map(config.projects.map((p) => [p.id, p]))
  const shouldIncludeWindowForPid = (pid: number): boolean => {
    const process = byPid.get(pid)
    if (!process) return false
    const surface = getSurfaceFromProcessName(process.name)
    if (surface === 'terminal' || surface === 'ide') return true
    return isLikelyCliWorkerProcess(process)
  }

  const collectRelatedWindows = (pid: number): WindowRow[] => {
    const out = new Map<number, WindowRow>()
    if (shouldIncludeWindowForPid(pid)) {
      for (const win of windowsByPid.get(pid) || []) out.set(win.id, win)
    }
    for (const childPid of processTreePids(pid, childrenByPid, 1)) {
      if (!shouldIncludeWindowForPid(childPid)) continue
      for (const win of windowsByPid.get(childPid) || []) out.set(win.id, win)
    }
    for (const ancestorPid of ancestorsOf(pid, byPid, 4)) {
      if (!shouldIncludeWindowForPid(ancestorPid)) continue
      for (const win of windowsByPid.get(ancestorPid) || []) out.set(win.id, win)
    }
    return [...out.values()].filter((win) => !isNoisySystemWindowTitle(win.title))
  }
  const makeSession = (pid: number) => {
    const process = byPid.get(pid)
    const matchingWindows = collectRelatedWindows(pid)
    const childPids = processTreePids(pid, childrenByPid, 2).filter((childPid) => childPid !== pid)

    const childCommands = [...new Set(
      childPids
        .map((childPid) => byPid.get(childPid))
        .filter((child): child is ProcessRow => Boolean(child))
        .map((child) => `${child.name} ${child.cmd}`.trim())
        .filter((line) => line.length > 0)
    )].slice(0, 20)

    return {
      pid,
      name: process?.name || '',
      cwd: process?.cwd || '',
      command: process?.cmd || '',
      window_ids: matchingWindows.map((w) => w.id),
      window_titles: matchingWindows.map((w) => w.title).filter((title) => title.trim().length > 0),
      child_commands: childCommands
    }
  }

  const projects: TerminalContentDebug[] = runtime.projects.map((runtimeProject) => {
    const project = projectById.get(runtimeProject.project_id)
    const sessions = runtimeProject.terminal_pids.map((pid) => makeSession(pid)).filter(isUsefulTerminalContentSession)

    return {
      project_id: runtimeProject.project_id,
      project_name: project?.name || runtimeProject.project_id,
      sessions
    }
  })
  const assignedTerminalPids = new Set<number>(
    runtime.projects.flatMap((project) => project.terminal_pids || []).filter((pid) => pid > 0)
  )
  const unassignedSessions = [...allTerminalCandidatePids]
    .filter((pid) => !assignedTerminalPids.has(pid))
    .map((pid) => makeSession(pid))
    .filter(isUsefulTerminalContentSession)
    .sort((a, b) => a.pid - b.pid)
  if (unassignedSessions.length > 0) {
    projects.push({
      project_id: '__unassigned__',
      project_name: 'Unassigned terminal processes',
      sessions: unassignedSessions
    })
  }

  return {
    projects,
    focused_project_id: runtime.focused_project_id
  }
}
