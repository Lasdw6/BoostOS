import { useEffect, useMemo, useState } from 'react'
import { api } from './api/ipc'
import logoSvg from './assets/logo.svg'

type Surface = 'ide' | 'browser' | 'agent'

type Project = {
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

type Config = {
  active_project_id: string | null
  projects: Project[]
  session_bindings: Array<{
    id: string
    project_id: string
    type: 'agent' | 'devserver'
  }>
  shortcuts: {
    switcher: string
    open_ide: string
    open_browser: string
    open_agent: string
    cycle_agent: string
  }
}

type ProjectActivity = {
  project_id: string
  ide_windows: number
  terminal_windows: number
  browser_windows: number
  total_windows: number
  focused: boolean
}

type ProjectRuntime = {
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

type TerminalContentDebugProject = {
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

type Draft = {
  name: string
  root_path: string
  ide_command: string
  agent_command: string
  dev_url: string
  browser_hint: string
  agent_hint: string
  ide_hint: string
}

const isProjectSwitcherOverlay = window.location.hash === '#project-switcher'

const emptyDraft: Draft = {
  name: '',
  root_path: '',
  ide_command: 'cursor',
  agent_command: 'codex',
  dev_url: 'http://localhost:3000',
  browser_hint: '',
  agent_hint: '',
  ide_hint: ''
}

function formatShortcut(shortcut: string): string {
  return shortcut
    .replace(/CommandOrControl/gi, 'Ctrl')
    .replace(/Super/gi, 'Win')
    .replace(/\+/g, ' + ')
}

function ShortcutRow({ label, shortcut }: { label: string; shortcut: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-txt-2">{label}</span>
      <span className="key-badge">{formatShortcut(shortcut)}</span>
    </div>
  )
}

function ProjectSwitcherOverlay() {
  const [config, setConfig] = useState<Config | null>(null)

  useEffect(() => {
    void api.projectHub.getConfig().then(setConfig)
  }, [])

  const projects = useMemo(() => {
    const all = config?.projects || []
    const bindings = config?.session_bindings || []
    const hasAgentByProject = new Set(
      bindings.filter((binding) => binding.type === 'agent').map((binding) => binding.project_id)
    )
    return all.filter((project) => hasAgentByProject.has(project.id))
  }, [config])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div className="absolute inset-0 drawer-backdrop" onClick={() => api.overlay.close()} />
      <div className="relative w-full max-w-2xl bg-ink-900 border border-border-subtle rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <h2 className="text-sm font-semibold text-txt-1">Project Switcher</h2>
          <button
            onClick={() => api.overlay.close()}
            className="px-2 py-1 text-xs border border-border-subtle rounded hover:border-accent-700/40"
          >
            Close
          </button>
        </div>
        <div className="p-3 max-h-[420px] overflow-y-auto space-y-2">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={async () => {
                await api.projectHub.setActive(project.id)
                await api.overlay.close()
              }}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                config?.active_project_id === project.id
                  ? 'border-accent-700/40 bg-accent-500/10'
                  : 'border-border-subtle hover:border-accent-700/40 hover:bg-ink-800'
              }`}
            >
              <div className="text-sm text-txt-1">{project.name}</div>
              <div className="text-xs text-txt-3 font-mono truncate mt-1">{project.root_path}</div>
            </button>
          ))}

          {projects.length === 0 && (
            <div className="p-8 text-center text-xs text-txt-3">
              No projects with configured agent sessions yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function MainApp() {
  const [config, setConfig] = useState<Config | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [message, setMessage] = useState<string>('Ready.')
  const [isDiscovering, setIsDiscovering] = useState(false)
  const [hasAutoDiscovered, setHasAutoDiscovered] = useState(false)
  const [initPath, setInitPath] = useState('')
  const [activityByProjectId, setActivityByProjectId] = useState<Record<string, ProjectActivity>>({})
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null)
  const [runtimeByProjectId, setRuntimeByProjectId] = useState<Record<string, ProjectRuntime>>({})
  const [showDebugMap, setShowDebugMap] = useState(false)
  const [llmResolvingMap, setLlmResolvingMap] = useState(false)
  const [showTerminalContentDebug, setShowTerminalContentDebug] = useState(false)
  const [terminalDebugLoading, setTerminalDebugLoading] = useState(false)
  const [terminalDebugProjects, setTerminalDebugProjects] = useState<TerminalContentDebugProject[]>([])

  const refresh = async () => {
    const next = await api.projectHub.getConfig()
    setConfig(next)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const refreshActivity = async () => {
    try {
      const activity = await api.projectHub.getActivity()
      const byId: Record<string, ProjectActivity> = {}
      for (const row of activity.projects || []) {
        byId[row.project_id] = row
      }
      setActivityByProjectId(byId)
      setFocusedProjectId(activity.focused_project_id || null)
    } catch {
      // Keep UI usable even if activity probing fails.
    }
  }

  const refreshRuntimeMap = async () => {
    try {
      const runtime = await api.projectHub.getRuntimeMap()
      const byId: Record<string, ProjectRuntime> = {}
      for (const row of runtime.projects || []) {
        byId[row.project_id] = row
      }
      setRuntimeByProjectId(byId)
    } catch {
      // Optional diagnostic UI; ignore failures.
    }
  }

  const resolveRuntimeMapWithLlm = async () => {
    setLlmResolvingMap(true)
    setMessage('Resolving window relations with LLM...')
    try {
      const runtime = await api.projectHub.getRuntimeMapLlm()
      const byId: Record<string, ProjectRuntime> = {}
      for (const row of runtime.projects || []) {
        byId[row.project_id] = row
      }
      setRuntimeByProjectId(byId)
      setMessage('LLM relation resolution complete.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'LLM relation resolution failed.')
    } finally {
      setLlmResolvingMap(false)
    }
  }

  const refreshTerminalContentDebug = async () => {
    setTerminalDebugLoading(true)
    try {
      const data = await api.projectHub.getTerminalContentDebug()
      setTerminalDebugProjects(data.projects || [])
    } catch {
      // Keep debug UI non-blocking.
    } finally {
      setTerminalDebugLoading(false)
    }
  }

  useEffect(() => {
    void refreshActivity()
    void refreshRuntimeMap()
    const timer = window.setInterval(() => {
      void refreshActivity()
      void refreshRuntimeMap()
    }, 2000)
    return () => {
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (!config || hasAutoDiscovered || isDiscovering) return
    if (config.projects.length > 0) return
    setHasAutoDiscovered(true)
    void discoverProjects()
  }, [config, hasAutoDiscovered, isDiscovering])

  const active = useMemo(
    () => config?.projects.find((project) => project.id === config.active_project_id) || null,
    [config]
  )
  const shortcuts = config?.shortcuts

  const openCreate = () => {
    setEditingId(null)
    setDraft(emptyDraft)
    setShowEditor(true)
  }

  const openEdit = (project: Project) => {
    setEditingId(project.id)
    setDraft({
      name: project.name,
      root_path: project.root_path,
      ide_command: project.ide_command,
      agent_command: project.agent_command,
      dev_url: project.dev_url,
      browser_hint: project.browser_hint || '',
      agent_hint: project.agent_hint || '',
      ide_hint: project.ide_hint || ''
    })
    setShowEditor(true)
  }

  const saveProject = async () => {
    if (!draft.name.trim() || !draft.root_path.trim()) {
      setMessage('Project name and root path are required.')
      return
    }

    await api.projectHub.saveProject({
      id: editingId || undefined,
      name: draft.name.trim(),
      root_path: draft.root_path.trim(),
      ide_command: draft.ide_command.trim() || 'cursor',
      agent_command: draft.agent_command.trim() || 'codex',
      dev_url: draft.dev_url.trim() || 'http://localhost:3000',
      browser_hint: draft.browser_hint.trim() || undefined,
      agent_hint: draft.agent_hint.trim() || undefined,
      ide_hint: draft.ide_hint.trim() || undefined
    })

    setShowEditor(false)
    setEditingId(null)
    setDraft(emptyDraft)
    setMessage('Project saved.')
    await refresh()
  }

  const autoFillProject = async (projectId?: string) => {
    setMessage('Detecting settings from running tools...')
    try {
      const result = await api.projectHub.autoClassify(projectId)
      setMessage(result.message || 'Project settings updated.')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Auto-detect failed.')
    }
  }

  const discoverProjects = async () => {
    setIsDiscovering(true)
    setMessage('Scanning device for repositories from IDE and terminal activity...')
    try {
      const result = await api.projectHub.discoverProjects()
      setMessage(result.message || 'Project discovery finished.')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Project discovery failed.')
    } finally {
      setIsDiscovering(false)
    }
  }

  const boostInit = async (payload?: { projectId?: string; rootPath?: string }) => {
    setMessage('Running boost init...')
    try {
      const result = await api.projectHub.boostInit(payload)
      setMessage(result.message || 'boost init completed.')
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'boost init failed.')
    }
  }

  const openSurface = async (surface: Surface) => {
    const result = await api.projectHub.openSurface(surface)
    setMessage(result.message)
    void refreshActivity()
  }

  const deleteProject = async (projectId: string) => {
    await api.projectHub.deleteProject(projectId)
    setMessage('Project removed.')
    if (editingId === projectId) {
      setEditingId(null)
      setDraft(emptyDraft)
      setShowEditor(false)
    }
    await refresh()
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-ink-950">
      <header className="app-drag-region flex items-center justify-between px-7 py-4 border-b border-border-subtle">
        <div className="flex items-center gap-3">
          <img src={logoSvg} alt="Boost" className="w-7 h-7" />
          <div>
            <h1 className="font-display text-[17px] font-bold tracking-tight text-txt-1">Boost</h1>
            <p className="text-[11px] text-txt-3">Project Switcher</p>
          </div>
        </div>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 text-xs font-semibold bg-accent-500 text-ink-900 rounded hover:bg-accent-600"
        >
          Add Project
        </button>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-6">
          <section className="space-y-4">
            <div className="dash-card p-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="font-display text-[15px] font-bold text-txt-1">Projects</h2>
                <span className="text-[11px] font-mono text-txt-4">
                  {(config?.projects || []).length} total
                </span>
              </div>

              <div className="space-y-2">
                {(config?.projects || []).map((project) => (
                  <div
                    key={project.id}
                    className={`p-3 rounded-lg border ${
                      config?.active_project_id === project.id
                        ? 'border-accent-700/40 bg-accent-500/10'
                        : 'border-border-subtle bg-ink-800/60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        onClick={async () => {
                          await api.projectHub.setActive(project.id)
                          setMessage(`Active project: ${project.name}`)
                          await refresh()
                          void refreshActivity()
                        }}
                        className="text-left min-w-0 flex-1"
                      >
                        <div className="text-sm font-semibold text-txt-1 truncate flex items-center gap-2">
                          <span className="truncate">{project.name}</span>
                          {focusedProjectId === project.id && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-500/20 text-accent-400 border border-accent-700/40">
                              Focused now
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-txt-3 font-mono truncate mt-1">{project.root_path}</div>
                        <div className="text-[11px] text-txt-4 mt-1">{project.dev_url}</div>
                        {activityByProjectId[project.id] && (
                          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle text-txt-3">
                              IDE {activityByProjectId[project.id].ide_windows}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle text-txt-3">
                              Terminal {activityByProjectId[project.id].terminal_windows}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-border-subtle text-txt-3">
                              Browser {activityByProjectId[project.id].browser_windows}
                            </span>
                          </div>
                        )}
                      </button>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => openEdit(project)}
                          className="px-2 py-1 text-[11px] border border-border-subtle rounded hover:border-accent-700/40"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => void autoFillProject(project.id)}
                          className="px-2 py-1 text-[11px] border border-border-subtle rounded hover:border-accent-700/40"
                        >
                          Auto
                        </button>
                        <button
                          onClick={() => void boostInit({ projectId: project.id })}
                          className="px-2 py-1 text-[11px] border border-border-subtle rounded hover:border-accent-700/40"
                        >
                          Boost Init
                        </button>
                        <button
                          onClick={() => void deleteProject(project.id)}
                          className="px-2 py-1 text-[11px] border border-red-700/40 rounded text-red-300 hover:bg-red-500/10"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {(config?.projects || []).length === 0 && (
                  <div className="p-8 text-center text-sm text-txt-3 border border-border-subtle rounded-lg">
                    <div>No projects found yet.</div>
                    <div className="mt-3">
                      <button
                        onClick={() => void discoverProjects()}
                        disabled={isDiscovering}
                        className="px-3 py-1.5 text-xs font-semibold bg-accent-500 text-ink-900 rounded hover:bg-accent-600 disabled:opacity-60"
                      >
                        {isDiscovering ? 'Scanning...' : 'Scan Device for Projects'}
                      </button>
                    </div>
                    <div className="mt-2 text-[11px] text-txt-4">
                      Looks at active IDE/terminal processes and common repo folders.
                    </div>
                    <div className="mt-4 border-t border-border-subtle pt-3">
                      <div className="text-[11px] text-txt-4 mb-2">
                        Or run <span className="text-txt-2">boost init</span> in a folder:
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          value={initPath}
                          onChange={(event) => setInitPath(event.target.value)}
                          placeholder="C:\\path\\to\\project"
                          className="flex-1 px-2.5 py-1.5 bg-ink-800 border border-border-subtle rounded text-xs font-mono"
                        />
                        <button
                          onClick={() => void boostInit({ rootPath: initPath || undefined })}
                          className="px-3 py-1.5 text-xs font-semibold border border-border-subtle rounded hover:border-accent-700/40"
                        >
                          Boost Init
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {showEditor && (
              <div className="dash-card p-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-display text-[14px] font-semibold text-txt-1">
                    {editingId ? 'Edit Project' : 'Add Project'}
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void autoFillProject(editingId || undefined)}
                      className="px-2.5 py-1.5 text-xs border border-border-subtle rounded hover:border-accent-700/40"
                    >
                      Auto-fill from running apps
                    </button>
                    <button
                      onClick={() => setShowEditor(false)}
                      className="px-2.5 py-1.5 text-xs border border-border-subtle rounded hover:border-accent-700/40"
                    >
                      Close
                    </button>
                  </div>
                </div>

                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                  placeholder="Project name"
                  className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                />
                <input
                  value={draft.root_path}
                  onChange={(event) => setDraft((prev) => ({ ...prev, root_path: event.target.value }))}
                  placeholder="Project root path"
                  className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm font-mono"
                />
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <input
                    value={draft.ide_command}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, ide_command: event.target.value }))
                    }
                    placeholder="IDE command (cursor, code, zed)"
                    className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                  />
                  <input
                    value={draft.agent_command}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, agent_command: event.target.value }))
                    }
                    placeholder="Agent command (codex, claude, opencode)"
                    className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                  />
                </div>
                <input
                  value={draft.dev_url}
                  onChange={(event) => setDraft((prev) => ({ ...prev, dev_url: event.target.value }))}
                  placeholder="Dev URL (http://localhost:3000)"
                  className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm font-mono"
                />
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                  <input
                    value={draft.ide_hint}
                    onChange={(event) => setDraft((prev) => ({ ...prev, ide_hint: event.target.value }))}
                    placeholder="IDE title hint (optional)"
                    className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                  />
                  <input
                    value={draft.browser_hint}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, browser_hint: event.target.value }))
                    }
                    placeholder="Browser title hint (optional)"
                    className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                  />
                  <input
                    value={draft.agent_hint}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, agent_hint: event.target.value }))
                    }
                    placeholder="Terminal title hint (optional)"
                    className="w-full px-3 py-2 bg-ink-800 border border-border-subtle rounded text-sm"
                  />
                </div>

                <button
                  onClick={() => void saveProject()}
                  className="w-full px-3 py-2 text-sm font-semibold bg-accent-500 text-ink-900 rounded hover:bg-accent-600"
                >
                  {editingId ? 'Save Changes' : 'Create Project'}
                </button>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div className="dash-card p-4 space-y-3">
              <h2 className="font-display text-[15px] font-bold text-txt-1">Quick Actions</h2>
              <p className="text-xs text-txt-3">
                Active project: <span className="text-txt-1 font-semibold">{active?.name || 'None selected'}</span>
              </p>
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={() => void openSurface('ide')}
                  className="w-full px-3 py-2 text-sm border border-border-subtle rounded hover:border-accent-700/40"
                >
                  Open IDE
                </button>
                <button
                  onClick={() => void openSurface('browser')}
                  className="w-full px-3 py-2 text-sm border border-border-subtle rounded hover:border-accent-700/40"
                >
                  Open Dev Server (Browser)
                </button>
                <button
                  onClick={() => void openSurface('agent')}
                  className="w-full px-3 py-2 text-sm border border-border-subtle rounded hover:border-accent-700/40"
                >
                  Open Agent Chat (Terminal)
                </button>
              </div>
            </div>

            <div className="dash-card p-4 space-y-2">
              <h3 className="font-display text-[14px] font-semibold text-txt-1">Keyboard Shortcuts</h3>
              <ShortcutRow
                label="Project switcher"
                shortcut={shortcuts?.switcher || 'CommandOrControl+Shift+S'}
              />
              <ShortcutRow
                label="Open IDE"
                shortcut={shortcuts?.open_ide || 'CommandOrControl+Shift+I'}
              />
              <ShortcutRow
                label="Open browser"
                shortcut={shortcuts?.open_browser || 'CommandOrControl+Shift+B'}
              />
              <ShortcutRow
                label="Open agent terminal"
                shortcut={shortcuts?.open_agent || 'CommandOrControl+Shift+A'}
              />
              <ShortcutRow
                label="Cycle agent pair"
                shortcut={shortcuts?.cycle_agent || 'CommandOrControl+Tab'}
              />
            </div>

            <div className="dash-card p-4">
              <button
                onClick={() => void discoverProjects()}
                disabled={isDiscovering}
                className="w-full px-3 py-2 text-sm border border-border-subtle rounded hover:border-accent-700/40"
              >
                {isDiscovering ? 'Scanning device...' : 'Discover projects from device'}
              </button>
              <p className="text-[11px] text-txt-4 mt-2">
                Finds repo roots from live IDE/terminal tools and common local dev folders.
              </p>
              <button
                onClick={() => void boostInit({ rootPath: initPath || undefined })}
                className="w-full mt-3 px-3 py-2 text-sm border border-border-subtle rounded hover:border-accent-700/40"
              >
                Run boost init and track project
              </button>
            </div>

            <div className="dash-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-[14px] font-semibold text-txt-1">Debug Map</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void resolveRuntimeMapWithLlm()}
                    disabled={llmResolvingMap}
                    className="px-2.5 py-1 text-xs border border-border-subtle rounded hover:border-accent-700/40 disabled:opacity-60"
                  >
                    {llmResolvingMap ? 'Resolving...' : 'Resolve with LLM'}
                  </button>
                  <button
                    onClick={() => setShowDebugMap((v) => !v)}
                    className="px-2.5 py-1 text-xs border border-border-subtle rounded hover:border-accent-700/40"
                  >
                    {showDebugMap ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              {showDebugMap && (
                <div className="mt-3 max-h-72 overflow-auto space-y-2">
                  {(config?.projects || []).map((project) => {
                    const runtime = runtimeByProjectId[project.id]
                    return (
                      <div key={`debug-${project.id}`} className="p-2 border border-border-subtle rounded text-[11px]">
                        <div className="text-txt-1 font-semibold">{project.name}</div>
                        <div className="text-txt-4 mt-1">
                          IDE windows: {(runtime?.ide_window_ids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Terminal windows: {(runtime?.terminal_window_ids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Browser windows: {(runtime?.browser_window_ids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4 mt-1">
                          IDE pids: {(runtime?.ide_pids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Terminal pids: {(runtime?.terminal_pids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Browser pids: {(runtime?.browser_pids || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Localhost ports: {(runtime?.localhost_ports || []).join(', ') || '-'}
                        </div>
                        <div className="text-txt-4">
                          Focused: {runtime?.focused ? 'yes' : 'no'}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="dash-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-[14px] font-semibold text-txt-1">Terminal Content Debug</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void refreshTerminalContentDebug()}
                    disabled={terminalDebugLoading}
                    className="px-2.5 py-1 text-xs border border-border-subtle rounded hover:border-accent-700/40 disabled:opacity-60"
                  >
                    {terminalDebugLoading ? 'Refreshing...' : 'Refresh'}
                  </button>
                  <button
                    onClick={() => {
                      const next = !showTerminalContentDebug
                      setShowTerminalContentDebug(next)
                      if (next && terminalDebugProjects.length === 0) {
                        void refreshTerminalContentDebug()
                      }
                    }}
                    className="px-2.5 py-1 text-xs border border-border-subtle rounded hover:border-accent-700/40"
                  >
                    {showTerminalContentDebug ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-txt-4 mt-2">
                Shows terminal process command/cwd, linked terminal window titles, and child command lines.
              </p>
              {showTerminalContentDebug && (
                <div className="mt-3 max-h-80 overflow-auto space-y-2">
                  {terminalDebugProjects.map((project) => (
                    <div key={`terminal-debug-${project.project_id}`} className="p-2 border border-border-subtle rounded">
                      <div className="text-[12px] font-semibold text-txt-1">{project.project_name}</div>
                      {project.sessions.length === 0 && (
                        <div className="text-[11px] text-txt-4 mt-1">No detected terminal sessions.</div>
                      )}
                      {project.sessions.map((session) => (
                        <div key={`terminal-session-${project.project_id}-${session.pid}`} className="mt-2 p-2 bg-ink-800/60 rounded border border-border-subtle">
                          <div className="text-[11px] text-txt-2">PID {session.pid} - {session.name || 'unknown'}</div>
                          <div className="text-[11px] text-txt-4 mt-1 font-mono break-all">
                            cwd: {session.cwd || '-'}
                          </div>
                          <div className="text-[11px] text-txt-4 mt-1 font-mono break-all">
                            cmd: {session.command || '-'}
                          </div>
                          <div className="text-[11px] text-txt-4 mt-1">
                            windows: {session.window_ids.join(', ') || '-'}
                          </div>
                          <div className="text-[11px] text-txt-4 mt-1">
                            titles: {session.window_titles.join(' | ') || '-'}
                          </div>
                          <div className="text-[11px] text-txt-4 mt-1">child commands:</div>
                          <div className="mt-1 space-y-1">
                            {(session.child_commands.length ? session.child_commands : ['-']).map((line, idx) => (
                              <div key={`terminal-child-${session.pid}-${idx}`} className="text-[11px] text-txt-4 font-mono break-all">
                                {line}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      <footer className="px-6 py-3 border-t border-border-subtle text-xs text-txt-3">
        {message}
      </footer>
    </div>
  )
}

export default function App() {
  if (isProjectSwitcherOverlay) return <ProjectSwitcherOverlay />
  return <MainApp />
}
