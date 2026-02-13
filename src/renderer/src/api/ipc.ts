export const api = {
  projectHub: {
    getConfig: () => window.api.projectHub.getConfig(),
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
    }) => window.api.projectHub.saveProject(project),
    deleteProject: (projectId: string) => window.api.projectHub.deleteProject(projectId),
    setActive: (projectId: string) => window.api.projectHub.setActive(projectId),
    getActivity: () => window.api.projectHub.getActivity(),
    getRuntimeMap: () => window.api.projectHub.getRuntimeMap(),
    getRuntimeDebug: () => window.api.projectHub.getRuntimeDebug(),
    getTerminalContentDebug: () => window.api.projectHub.getTerminalContentDebug(),
    getRuntimeMapLlm: () => window.api.projectHub.getRuntimeMapLlm(),
    discoverProjects: () => window.api.projectHub.discoverProjects(),
    boostInit: (payload?: { projectId?: string; rootPath?: string }) =>
      window.api.projectHub.boostInit(payload),
    autoClassify: (projectId?: string) => window.api.projectHub.autoClassify(projectId),
    recordRuntimeFeedback: (payload: {
      scope: 'pid' | 'window' | 'port'
      surface: 'ide' | 'terminal' | 'browser'
      key: number
      project_id: string | null
    }) => window.api.projectHub.recordRuntimeFeedback(payload),
    clearRuntimeFeedback: (payload?: {
      scope?: 'pid' | 'window' | 'port'
      surface?: 'ide' | 'terminal' | 'browser'
    }) => window.api.projectHub.clearRuntimeFeedback(payload),
    openSurface: (surface: 'ide' | 'browser' | 'agent') => window.api.projectHub.openSurface(surface),
    updateShortcuts: (
      shortcuts: Partial<{
        switcher: string
        open_ide: string
        open_browser: string
        open_agent: string
        cycle_agent: string
      }>
    ) => window.api.projectHub.updateShortcuts(shortcuts)
  },
  overlay: {
    close: () => window.api.overlay.close()
  },
  windowControls: {
    minimize: () => window.api.windowControls.minimize(),
    close: () => window.api.windowControls.close()
  }
}
