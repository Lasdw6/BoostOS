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

export interface ProjectHubConfig {
  active_project_id: string | null
  projects: ProjectProfile[]
  shortcuts: {
    switcher: string
    open_ide: string
    open_browser: string
    open_agent: string
  }
}

export const DEFAULT_PROJECT_HUB_CONFIG: ProjectHubConfig = {
  active_project_id: null,
  projects: [],
  shortcuts: {
    switcher: 'CommandOrControl+Shift+S',
    open_ide: 'CommandOrControl+Shift+I',
    open_browser: 'CommandOrControl+Shift+B',
    open_agent: 'CommandOrControl+Shift+A'
  }
}
