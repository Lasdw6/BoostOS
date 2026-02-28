export interface ProjectProfile {
  id: string
  name: string
  root_path: string
  ide_command: string
  agent_command: string
  dev_url: string
  browser_hint?: string
  agent_hint?: string
  ide_hint?: string
  created_at: string
  updated_at: string
}

export type RuntimeSurface = 'ide' | 'terminal' | 'browser'
export type RuntimeFeedbackScope = 'pid' | 'window' | 'port'

export interface RuntimeFeedbackStore {
  pid: Partial<Record<RuntimeSurface, Record<string, string>>>
  window: Partial<Record<RuntimeSurface, Record<string, string>>>
  port: Partial<Record<RuntimeSurface, Record<string, string>>>
  updated_at: string | null
}

export type SessionBindingType = 'agent' | 'devserver'

export interface SessionBinding {
  id: string
  project_id: string
  type: SessionBindingType
  label?: string
  integrated_terminal?: boolean
  integrated_terminal_index?: number
  terminal_session_id?: string
  terminal_session_tag?: string
  pid?: number
  window_id?: number
  cwd_hint?: string
  cmd_hint?: string
  port_hint?: number
  created_at: string
  updated_at: string
  last_seen_at: string | null
}

export interface SessionDefaultsByProject {
  [projectId: string]: {
    agent?: string
    devserver?: string
  }
}

export interface ProjectHubConfig {
  active_project_id: string | null
  projects: ProjectProfile[]
  shortcuts: {
    switcher: string
    open_ide: string
    open_browser: string
    open_agent: string
    cycle_agent: string
  }
  runtime_feedback: RuntimeFeedbackStore
  session_bindings: SessionBinding[]
  session_defaults_by_project: SessionDefaultsByProject
}

export const DEFAULT_RUNTIME_FEEDBACK: RuntimeFeedbackStore = {
  pid: {},
  window: {},
  port: {},
  updated_at: null
}

export const DEFAULT_PROJECT_HUB_CONFIG: ProjectHubConfig = {
  active_project_id: null,
  projects: [],
  shortcuts: {
    switcher: 'CommandOrControl+Shift+S',
    open_ide: 'CommandOrControl+Shift+I',
    open_browser: 'CommandOrControl+Shift+B',
    open_agent: 'CommandOrControl+Shift+A',
    cycle_agent: 'CommandOrControl+Tab'
  },
  runtime_feedback: DEFAULT_RUNTIME_FEEDBACK,
  session_bindings: [],
  session_defaults_by_project: {}
}
