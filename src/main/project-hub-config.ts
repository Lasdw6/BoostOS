import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import {
  DEFAULT_RUNTIME_FEEDBACK,
  DEFAULT_PROJECT_HUB_CONFIG,
  type SessionBinding,
  type SessionBindingType,
  type SessionDefaultsByProject,
  type RuntimeFeedbackScope,
  type RuntimeSurface,
  type ProjectHubConfig,
  type ProjectProfile
} from '../shared/project-hub'

const CONFIG_FILE = 'project-hub-v2.json'

function getConfigPath(): string {
  const userData = app.getPath('userData')
  return join(userData, CONFIG_FILE)
}

function cloneRuntimeFeedback(): ProjectHubConfig['runtime_feedback'] {
  return {
    pid: {},
    window: {},
    port: {},
    updated_at: DEFAULT_RUNTIME_FEEDBACK.updated_at
  }
}

function normalizeFeedbackScope(
  raw: unknown
): Partial<Record<RuntimeSurface, Record<string, string>>> {
  const out: Partial<Record<RuntimeSurface, Record<string, string>>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const surface of ['ide', 'terminal', 'browser'] as const) {
    const surfaceRaw = (raw as Record<string, unknown>)[surface]
    if (!surfaceRaw || typeof surfaceRaw !== 'object') continue
    const entries: Array<[string, string]> = Object.entries(surfaceRaw as Record<string, unknown>)
      .filter(([key, value]) => key && typeof value === 'string' && value.length > 0)
      .map(([key, value]) => [key, String(value)])
    if (entries.length === 0) continue
    out[surface] = Object.fromEntries(entries)
  }
  return out
}

function normalizeRuntimeFeedback(raw: unknown): ProjectHubConfig['runtime_feedback'] {
  if (!raw || typeof raw !== 'object') return cloneRuntimeFeedback()
  const obj = raw as Record<string, unknown>
  const updated_at =
    typeof obj.updated_at === 'string' && obj.updated_at.trim().length > 0
      ? obj.updated_at
      : null
  return {
    pid: normalizeFeedbackScope(obj.pid),
    window: normalizeFeedbackScope(obj.window),
    port: normalizeFeedbackScope(obj.port),
    updated_at
  }
}

function normalizeSessionBindings(raw: unknown): SessionBinding[] {
  if (!Array.isArray(raw)) return []
  const rows = raw
    .map<SessionBinding | null>((row) => {
      if (!row || typeof row !== 'object') return null
      const value = row as Record<string, unknown>
      const typeRaw = String(value.type || '').toLowerCase()
      const type: SessionBindingType | null =
        typeRaw === 'agent' ? 'agent' : typeRaw === 'devserver' ? 'devserver' : null
      if (!type) return null
      const id = String(value.id || '').trim()
      const project_id = String(value.project_id || '').trim()
      if (!id || !project_id) return null
      const parseNumber = (n: unknown): number | undefined => {
        const value = Number(n)
        return Number.isFinite(value) && value > 0 ? value : undefined
      }
      const created_at = String(value.created_at || '').trim() || new Date().toISOString()
      const updated_at = String(value.updated_at || '').trim() || created_at
      const last_seen_at = typeof value.last_seen_at === 'string' && value.last_seen_at.trim() ? value.last_seen_at : null
      const binding: SessionBinding = {
        id,
        project_id,
        type,
        label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : undefined,
        integrated_terminal: typeof value.integrated_terminal === 'boolean' ? value.integrated_terminal : undefined,
        integrated_terminal_index: parseNumber(value.integrated_terminal_index),
        terminal_session_id:
          typeof value.terminal_session_id === 'string' && value.terminal_session_id.trim()
            ? value.terminal_session_id.trim()
            : undefined,
        terminal_session_tag:
          typeof value.terminal_session_tag === 'string' && value.terminal_session_tag.trim()
            ? value.terminal_session_tag.trim()
            : undefined,
        pid: parseNumber(value.pid),
        window_id: parseNumber(value.window_id),
        cwd_hint: typeof value.cwd_hint === 'string' && value.cwd_hint.trim() ? value.cwd_hint.trim() : undefined,
        cmd_hint: typeof value.cmd_hint === 'string' && value.cmd_hint.trim() ? value.cmd_hint.trim() : undefined,
        port_hint: parseNumber(value.port_hint),
        created_at,
        updated_at,
        last_seen_at
      }
      return binding
    })
  return rows.filter((row): row is SessionBinding => Boolean(row))
}

function normalizeSessionDefaults(raw: unknown): SessionDefaultsByProject {
  const out: SessionDefaultsByProject = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const agent = typeof item.agent === 'string' && item.agent.trim() ? item.agent : undefined
    const devserver = typeof item.devserver === 'string' && item.devserver.trim() ? item.devserver : undefined
    if (!agent && !devserver) continue
    out[projectId] = { agent, devserver }
  }
  return out
}

export function loadProjectHubConfig(): ProjectHubConfig {
  const path = getConfigPath()
  if (!existsSync(path)) {
    return { ...DEFAULT_PROJECT_HUB_CONFIG, runtime_feedback: cloneRuntimeFeedback() }
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProjectHubConfig>
    return {
      active_project_id: raw.active_project_id || null,
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      shortcuts: {
        ...DEFAULT_PROJECT_HUB_CONFIG.shortcuts,
        ...(raw.shortcuts || {})
      },
      runtime_feedback: normalizeRuntimeFeedback((raw as Record<string, unknown>).runtime_feedback),
      session_bindings: normalizeSessionBindings((raw as Record<string, unknown>).session_bindings),
      session_defaults_by_project: normalizeSessionDefaults((raw as Record<string, unknown>).session_defaults_by_project)
    }
  } catch {
    return { ...DEFAULT_PROJECT_HUB_CONFIG, runtime_feedback: cloneRuntimeFeedback() }
  }
}

export function saveProjectHubConfig(config: ProjectHubConfig): void {
  const path = getConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}

export function upsertProject(
  config: ProjectHubConfig,
  input: Omit<ProjectProfile, 'created_at' | 'updated_at'> & {
    created_at?: string
    updated_at?: string
  }
): ProjectHubConfig {
  const now = new Date().toISOString()
  const existing = config.projects.find((p) => p.id === input.id)
  if (existing) {
    const next = config.projects.map((p) =>
      p.id === input.id
        ? {
            ...p,
            ...input,
            updated_at: now
          }
        : p
    )
    return { ...config, projects: next }
  }

  return {
    ...config,
    projects: [
      ...config.projects,
      {
        ...input,
        created_at: input.created_at || now,
        updated_at: input.updated_at || now
      }
    ]
  }
}

export function recordRuntimeFeedback(
  config: ProjectHubConfig,
  input: {
    scope: RuntimeFeedbackScope
    surface: RuntimeSurface
    key: number
    project_id: string | null
  }
): ProjectHubConfig {
  const key = String(input.key)
  const feedback = normalizeRuntimeFeedback(config.runtime_feedback)
  const scopeMap = { ...(feedback[input.scope][input.surface] || {}) }

  if (input.project_id) {
    scopeMap[key] = input.project_id
  } else {
    delete scopeMap[key]
  }

  feedback[input.scope] = {
    ...feedback[input.scope],
    [input.surface]: scopeMap
  }
  feedback.updated_at = new Date().toISOString()
  return { ...config, runtime_feedback: feedback }
}

export function clearRuntimeFeedback(
  config: ProjectHubConfig,
  input?: { scope?: RuntimeFeedbackScope; surface?: RuntimeSurface }
): ProjectHubConfig {
  if (!input?.scope) {
    return {
      ...config,
      runtime_feedback: {
        pid: {},
        window: {},
        port: {},
        updated_at: new Date().toISOString()
      }
    }
  }

  const feedback = normalizeRuntimeFeedback(config.runtime_feedback)
  if (!input.surface) {
    feedback[input.scope] = {}
  } else {
    feedback[input.scope] = {
      ...feedback[input.scope],
      [input.surface]: {}
    }
  }
  feedback.updated_at = new Date().toISOString()
  return { ...config, runtime_feedback: feedback }
}

export function upsertSessionBinding(
  config: ProjectHubConfig,
  input: Omit<SessionBinding, 'created_at' | 'updated_at' | 'last_seen_at'> & {
    created_at?: string
    updated_at?: string
    last_seen_at?: string | null
  }
): { config: ProjectHubConfig; binding: SessionBinding } {
  const now = new Date().toISOString()
  const existing = config.session_bindings.find((row) => row.id === input.id)
  const binding: SessionBinding = existing
    ? {
        ...existing,
        ...input,
        updated_at: now
      }
    : {
        ...input,
        created_at: input.created_at || now,
        updated_at: input.updated_at || now,
        last_seen_at: input.last_seen_at || now
      }

  const session_bindings = existing
    ? config.session_bindings.map((row) => (row.id === input.id ? binding : row))
    : [...config.session_bindings, binding]

  const defaults = { ...config.session_defaults_by_project }
  const current = { ...(defaults[binding.project_id] || {}) }
  if (!current[binding.type]) current[binding.type] = binding.id
  defaults[binding.project_id] = current

  return {
    config: { ...config, session_bindings, session_defaults_by_project: defaults },
    binding
  }
}

export function removeSessionBinding(
  config: ProjectHubConfig,
  bindingId: string
): { config: ProjectHubConfig; removed: SessionBinding | null } {
  const removed = config.session_bindings.find((row) => row.id === bindingId) || null
  if (!removed) return { config, removed: null }

  const session_bindings = config.session_bindings.filter((row) => row.id !== bindingId)
  const defaults = { ...config.session_defaults_by_project }
  const projectDefaults = { ...(defaults[removed.project_id] || {}) }
  if (projectDefaults[removed.type] === bindingId) {
    const replacement = session_bindings.find((row) => row.project_id === removed.project_id && row.type === removed.type)
    if (replacement) {
      projectDefaults[removed.type] = replacement.id
    } else {
      delete projectDefaults[removed.type]
    }
  }
  if (projectDefaults.agent || projectDefaults.devserver) {
    defaults[removed.project_id] = projectDefaults
  } else {
    delete defaults[removed.project_id]
  }

  return {
    config: { ...config, session_bindings, session_defaults_by_project: defaults },
    removed
  }
}

export function setDefaultSessionBinding(
  config: ProjectHubConfig,
  input: { project_id: string; type: SessionBindingType; binding_id: string }
): ProjectHubConfig {
  const exists = config.session_bindings.some(
    (row) => row.id === input.binding_id && row.project_id === input.project_id && row.type === input.type
  )
  if (!exists) return config
  const defaults = { ...config.session_defaults_by_project }
  defaults[input.project_id] = {
    ...(defaults[input.project_id] || {}),
    [input.type]: input.binding_id
  }
  return { ...config, session_defaults_by_project: defaults }
}
