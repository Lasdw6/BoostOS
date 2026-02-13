import { generateObject } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { resolveOpenAIKey } from './convex-bootstrap'
import { getPsListFn } from './ps-list-loader'
import { windowManager } from './window-manager'
import type { ProjectHubConfig } from '../shared/project-hub'
import type { ProjectRuntimeMap } from './project-activity'

const schema = z.object({
  terminal_pid_assignments: z.array(
    z.object({
      pid: z.number(),
      project_id: z.string().nullable(),
      confidence: z.number().min(0).max(1).optional()
    })
  ),
  terminal_window_assignments: z.array(
    z.object({
      window_id: z.number(),
      project_id: z.string().nullable(),
      confidence: z.number().min(0).max(1).optional()
    })
  ),
  browser_window_assignments: z.array(
    z.object({
      window_id: z.number(),
      project_id: z.string().nullable(),
      confidence: z.number().min(0).max(1).optional()
    })
  ),
  browser_port_assignments: z.array(
    z.object({
      port: z.number(),
      project_id: z.string().nullable(),
      confidence: z.number().min(0).max(1).optional()
    })
  )
})

function isRelevantProcessName(name: string): boolean {
  const n = name.toLowerCase()
  return (
    n.includes('cursor') ||
    n.includes('code') ||
    n.includes('zed') ||
    n.includes('pwsh') ||
    n.includes('powershell') ||
    n.includes('cmd') ||
    n.includes('windowsterminal') ||
    n.includes('wezterm') ||
    n.includes('chrome') ||
    n.includes('msedge') ||
    n.includes('brave') ||
    n.includes('firefox') ||
    n.includes('codex') ||
    n.includes('claude') ||
    n.includes('opencode')
  )
}

function feedbackProjectId(
  config: ProjectHubConfig,
  scope: 'pid' | 'window' | 'port',
  surface: 'ide' | 'terminal' | 'browser',
  key: number
): string | null {
  const id = config.runtime_feedback?.[scope]?.[surface]?.[String(key)] || null
  if (!id) return null
  return config.projects.some((p) => p.id === id) ? id : null
}

export async function resolveRuntimeMapWithLLM(
  config: ProjectHubConfig,
  runtimeMap: ProjectRuntimeMap
): Promise<ProjectRuntimeMap> {
  const apiKey = await resolveOpenAIKey()
  if (!apiKey) return runtimeMap

  const openai = createOpenAI({ apiKey })
  const projectIds = new Set(config.projects.map((p) => p.id))
  const psList = getPsListFn()
  const processes = await psList()
  const windows = windowManager.getAllWindows()
    .map((w: any) => ({
      id: Number(w.id || 0),
      pid: Number(w.processId || 0),
      path: String(w.path || ''),
      title: String(w.getTitle?.() || '')
    }))
    .filter((w) => w.id > 0 && w.pid > 0)
    .slice(0, 300)

  const processRows = processes
    .map((p: any) => ({
      pid: Number(p.pid || 0),
      ppid: Number(p.ppid || 0),
      name: String(p.name || ''),
      cmd: String(p.cmd || ''),
      cwd: String(p.cwd || '')
    }))
    .filter((p) => p.pid > 0 && isRelevantProcessName(p.name))
    .slice(0, 300)

  const prompt = JSON.stringify(
    {
      projects: config.projects.map((p) => ({
        id: p.id,
        name: p.name,
        root_path: p.root_path,
        dev_url: p.dev_url
      })),
      current_runtime_map: runtimeMap,
      open_windows: windows,
      processes: processRows
    },
    null,
    2
  )

  const { object } = await generateObject({
    model: openai(process.env.OPENAI_MODEL || 'gpt-4o-mini'),
    schema,
    system: [
      'You resolve project runtime relations from open windows and processes.',
      'Only assign a window/pid/port when evidence is strong.',
      'project_id must be one of provided projects or null.',
      'Prefer root_path/cwd/title locality and localhost port relations.',
      'Do not assign everything to a generic project name.'
    ].join('\n'),
    prompt
  })

  const byId = new Map(runtimeMap.projects.map((p) => [p.project_id, { ...p }]))
  const clearSets = () => {
    for (const row of byId.values()) {
      row.terminal_pids = []
      row.terminal_window_ids = []
      row.browser_window_ids = []
      row.localhost_ports = []
    }
  }
  clearSets()

  for (const row of object.terminal_pid_assignments) {
    if (!row.project_id || !projectIds.has(row.project_id)) continue
    byId.get(row.project_id)?.terminal_pids.push(row.pid)
  }
  for (const row of object.terminal_window_assignments) {
    if (!row.project_id || !projectIds.has(row.project_id)) continue
    byId.get(row.project_id)?.terminal_window_ids.push(row.window_id)
  }
  for (const row of object.browser_window_assignments) {
    if (!row.project_id || !projectIds.has(row.project_id)) continue
    byId.get(row.project_id)?.browser_window_ids.push(row.window_id)
  }
  for (const row of object.browser_port_assignments) {
    if (!row.project_id || !projectIds.has(row.project_id)) continue
    byId.get(row.project_id)?.localhost_ports.push(row.port)
  }

  // Hard overrides from user feedback are applied after LLM output.
  const enforceSingleOwner = (
    field: 'ide_window_ids' | 'terminal_window_ids' | 'browser_window_ids' | 'ide_pids' | 'terminal_pids' | 'browser_pids' | 'localhost_ports',
    key: number,
    targetProjectId: string
  ) => {
    for (const row of byId.values()) {
      row[field] = row[field].filter((v) => v !== key)
    }
    byId.get(targetProjectId)?.[field].push(key)
  }

  for (const w of windows) {
    const ideWindowProject = feedbackProjectId(config, 'window', 'ide', w.id)
    if (ideWindowProject) {
      enforceSingleOwner('ide_window_ids', w.id, ideWindowProject)
      enforceSingleOwner('ide_pids', w.pid, ideWindowProject)
    }

    const terminalWindowProject = feedbackProjectId(config, 'window', 'terminal', w.id)
    if (terminalWindowProject) {
      enforceSingleOwner('terminal_window_ids', w.id, terminalWindowProject)
      enforceSingleOwner('terminal_pids', w.pid, terminalWindowProject)
    }

    const browserWindowProject = feedbackProjectId(config, 'window', 'browser', w.id)
    if (browserWindowProject) {
      enforceSingleOwner('browser_window_ids', w.id, browserWindowProject)
      enforceSingleOwner('browser_pids', w.pid, browserWindowProject)
    }
  }

  for (const p of processRows) {
    const idePidProject = feedbackProjectId(config, 'pid', 'ide', p.pid)
    if (idePidProject) enforceSingleOwner('ide_pids', p.pid, idePidProject)

    const terminalPidProject = feedbackProjectId(config, 'pid', 'terminal', p.pid)
    if (terminalPidProject) enforceSingleOwner('terminal_pids', p.pid, terminalPidProject)

    const browserPidProject = feedbackProjectId(config, 'pid', 'browser', p.pid)
    if (browserPidProject) enforceSingleOwner('browser_pids', p.pid, browserPidProject)
  }

  const observedPorts = new Set<number>()
  for (const row of byId.values()) {
    for (const port of row.localhost_ports) observedPorts.add(port)
  }
  for (const port of observedPorts) {
    const feedbackPortProject = feedbackProjectId(config, 'port', 'browser', port)
    if (feedbackPortProject) {
      enforceSingleOwner('localhost_ports', port, feedbackPortProject)
    }
  }

  return {
    focused_project_id: runtimeMap.focused_project_id,
    projects: [...byId.values()].map((p) => ({
      ...p,
      terminal_pids: [...new Set(p.terminal_pids)],
      terminal_window_ids: [...new Set(p.terminal_window_ids)],
      browser_window_ids: [...new Set(p.browser_window_ids)],
      localhost_ports: [...new Set(p.localhost_ports)]
    }))
  }
}
