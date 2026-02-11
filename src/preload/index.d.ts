import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      projectHub: {
        getConfig: () => Promise<{
          active_project_id: string | null
          projects: Array<{
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
          }>
          shortcuts: {
            switcher: string
            open_ide: string
            open_browser: string
            open_agent: string
          }
        }>
        saveProject: (project: {
          id?: string
          name: string
          root_path: string
          ide_command: string
          agent_command: string
          dev_url: string
          browser_hint?: string
          agent_hint?: string
          ide_hint?: string
        }) => Promise<any>
        deleteProject: (projectId: string) => Promise<any>
        setActive: (projectId: string) => Promise<any>
        openSurface: (surface: 'ide' | 'browser' | 'agent') => Promise<{ ok: boolean; message: string }>
        updateShortcuts: (shortcuts: Partial<{
          switcher: string
          open_ide: string
          open_browser: string
          open_agent: string
        }>) => Promise<any>
      }
      overlay: {
        close: () => Promise<void>
      }
      windowControls: {
        minimize: () => Promise<void>
        close: () => Promise<void>
      }
    }
  }
}

export {}
