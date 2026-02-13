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
            cycle_agent: string
          }
          runtime_feedback: {
            pid: Partial<Record<'ide' | 'terminal' | 'browser', Record<string, string>>>
            window: Partial<Record<'ide' | 'terminal' | 'browser', Record<string, string>>>
            port: Partial<Record<'ide' | 'terminal' | 'browser', Record<string, string>>>
            updated_at: string | null
          }
          session_bindings: Array<{
            id: string
            project_id: string
            type: 'agent' | 'devserver'
            label?: string
            integrated_terminal?: boolean
            integrated_terminal_index?: number
            pid?: number
            window_id?: number
            cwd_hint?: string
            cmd_hint?: string
            port_hint?: number
            created_at: string
            updated_at: string
            last_seen_at: string | null
          }>
          session_defaults_by_project: Record<string, { agent?: string; devserver?: string }>
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
        getActivity: () => Promise<{
          projects: Array<{
            project_id: string
            ide_windows: number
            terminal_windows: number
            browser_windows: number
            total_windows: number
            focused: boolean
          }>
          focused_project_id: string | null
        }>
        getRuntimeMap: () => Promise<{
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
        }>
        getRuntimeDebug: () => Promise<{
          runtime: {
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
          }
          debug: {
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
        }>
        getTerminalContentDebug: () => Promise<{
          projects: Array<{
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
          }>
          focused_project_id: string | null
        }>
        getRuntimeMapLlm: () => Promise<{
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
        }>
        discoverProjects: () => Promise<{
          ok: boolean
          message: string
          added: number
          config?: any
        }>
        boostInit: (payload?: { projectId?: string; rootPath?: string }) => Promise<{
          ok: boolean
          message: string
          config?: any
          project_id?: string | null
          root_path?: string
        }>
        autoClassify: (projectId?: string) => Promise<{
          ok: boolean
          message: string
          updated: number
          details?: Array<{ id: string; confidence?: number; reason?: string }>
          config?: any
        }>
        recordRuntimeFeedback: (payload: {
          scope: 'pid' | 'window' | 'port'
          surface: 'ide' | 'terminal' | 'browser'
          key: number
          project_id: string | null
        }) => Promise<{ ok: boolean; message: string; config?: any }>
        clearRuntimeFeedback: (payload?: {
          scope?: 'pid' | 'window' | 'port'
          surface?: 'ide' | 'terminal' | 'browser'
        }) => Promise<{ ok: boolean; message: string; config?: any }>
        openSurface: (surface: 'ide' | 'browser' | 'agent') => Promise<{ ok: boolean; message: string }>
        updateShortcuts: (shortcuts: Partial<{
          switcher: string
          open_ide: string
          open_browser: string
          open_agent: string
          cycle_agent: string
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
