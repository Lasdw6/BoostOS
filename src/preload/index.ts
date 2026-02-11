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
    openSurface: (surface: 'ide' | 'browser' | 'agent') =>
      ipcRenderer.invoke('project-hub:open-surface', surface),
    updateShortcuts: (shortcuts: Partial<{
      switcher: string
      open_ide: string
      open_browser: string
      open_agent: string
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
