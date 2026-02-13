import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

const api = {
  projectHub: {
    getConfig: () => ipcRenderer.invoke('project-hub:get-config'),
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
    }) => ipcRenderer.invoke('project-hub:save-project', project),
    deleteProject: (projectId: string) => ipcRenderer.invoke('project-hub:delete-project', projectId),
    setActive: (projectId: string) => ipcRenderer.invoke('project-hub:set-active', projectId),
    getActivity: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:get-activity')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:get-activity'")) {
          return { projects: [], focused_project_id: null }
        }
        throw error
      }
    },
    getRuntimeMap: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:get-runtime-map')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:get-runtime-map'")) {
          return { projects: [], focused_project_id: null }
        }
        throw error
      }
    },
    getRuntimeDebug: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:get-runtime-debug')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:get-runtime-debug'")) {
          return {
            runtime: { projects: [], focused_project_id: null },
            debug: { terminal_pid_assignments: [], terminal_window_assignments: [] }
          }
        }
        throw error
      }
    },
    getTerminalContentDebug: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:get-terminal-content-debug')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:get-terminal-content-debug'")) {
          return { projects: [], focused_project_id: null }
        }
        throw error
      }
    },
    getRuntimeMapLlm: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:get-runtime-map-llm')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:get-runtime-map-llm'")) {
          return { projects: [], focused_project_id: null }
        }
        throw error
      }
    },
    discoverProjects: async () => {
      try {
        return await ipcRenderer.invoke('project-hub:discover-projects')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:discover-projects'")) {
          return {
            ok: false,
            message:
              "Project discovery is unavailable in the running main process. Restart with 'bun run dev:v2'.",
            added: 0
          }
        }
        throw error
      }
    },
    boostInit: async (payload?: { projectId?: string; rootPath?: string }) => {
      try {
        return await ipcRenderer.invoke('project-hub:boost-init', payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:boost-init'")) {
          return {
            ok: false,
            message: "Boost init action is unavailable in the running main process. Restart with 'bun run dev:v2'."
          }
        }
        throw error
      }
    },
    autoClassify: async (projectId?: string) => {
      try {
        return await ipcRenderer.invoke('project-hub:auto-classify', projectId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes("No handler registered for 'project-hub:auto-classify'")) {
          return {
            ok: false,
            message:
              "Auto-detect is unavailable in the running main process. Restart with 'bun run dev:v2' to load the latest handlers.",
            updated: 0
          }
        }
        throw error
      }
    },
    recordRuntimeFeedback: (payload: {
      scope: 'pid' | 'window' | 'port'
      surface: 'ide' | 'terminal' | 'browser'
      key: number
      project_id: string | null
    }) => ipcRenderer.invoke('project-hub:record-runtime-feedback', payload),
    clearRuntimeFeedback: (payload?: {
      scope?: 'pid' | 'window' | 'port'
      surface?: 'ide' | 'terminal' | 'browser'
    }) => ipcRenderer.invoke('project-hub:clear-runtime-feedback', payload),
    openSurface: (surface: 'ide' | 'browser' | 'agent') =>
      ipcRenderer.invoke('project-hub:open-surface', surface),
    updateShortcuts: (shortcuts: Partial<{
      switcher: string
      open_ide: string
      open_browser: string
      open_agent: string
      cycle_agent: string
    }>) => ipcRenderer.invoke('project-hub:update-shortcuts', shortcuts)
  },
  overlay: {
    close: () => ipcRenderer.invoke('overlay:close')
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    close: () => ipcRenderer.invoke('window:close')
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-ignore
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}
