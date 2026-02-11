import { useEffect, useMemo, useState } from 'react'
import { api } from './api/ipc'

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
  shortcuts: {
    switcher: string
    open_ide: string
    open_browser: string
    open_agent: string
  }
}

const isProjectSwitcherOverlay = window.location.hash === '#project-switcher'

const emptyDraft = {
  name: '',
  root_path: '',
  ide_command: 'cursor',
  agent_command: 'codex',
  dev_url: 'http://localhost:3000',
  browser_hint: '',
  agent_hint: '',
  ide_hint: ''
}

function ProjectSwitcherOverlay() {
  const [config, setConfig] = useState<Config | null>(null)

  useEffect(() => {
    void api.projectHub.getConfig().then(setConfig)
  }, [])

  const projects = config?.projects || []

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0c0c0d] shadow-2xl">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-white">Project Switcher</h1>
          <button onClick={() => api.overlay.close()} className="text-xs text-gray-400 hover:text-white">Close</button>
        </div>
        <div className="p-3 max-h-[420px] overflow-y-auto space-y-2">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={async () => {
                await api.projectHub.setActive(p.id)
                await api.overlay.close()
              }}
              className="w-full text-left px-3 py-2 rounded-lg border border-white/10 hover:border-cyan-700/50 hover:bg-white/5"
            >
              <div className="text-sm text-white">{p.name}</div>
              <div className="text-xs text-gray-400 font-mono">{p.root_path}</div>
            </button>
          ))}
          {projects.length === 0 && <div className="text-xs text-gray-500 px-2 py-8 text-center">No projects configured.</div>}
        </div>
      </div>
    </div>
  )
}

function MainApp() {
  const [config, setConfig] = useState<Config | null>(null)
  const [draft, setDraft] = useState(emptyDraft)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState<string>('')

  const refresh = async () => {
    const next = await api.projectHub.getConfig()
    setConfig(next)
  }

  useEffect(() => {
    void refresh()
  }, [])

  const active = useMemo(
    () => config?.projects.find((p) => p.id === config.active_project_id) || null,
    [config]
  )

  const onSaveProject = async () => {
    if (!draft.name.trim() || !draft.root_path.trim()) {
      setMessage('Name and root path are required.')
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

    setDraft(emptyDraft)
    setEditingId(null)
    setMessage('Project saved.')
    await refresh()
  }

  const openSurface = async (surface: Surface) => {
    const result = await api.projectHub.openSurface(surface)
    setMessage(result.message)
  }

  return (
    <div className="h-screen bg-[#080809] text-white flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/10">
        <div>
          <h1 className="text-base font-semibold">Boost v2</h1>
          <p className="text-xs text-gray-400">Project-scoped surface switching</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400">Active project</div>
          <div className="text-sm font-medium">{active?.name || 'None selected'}</div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Projects</h2>
            <button
              onClick={() => {
                setEditingId(null)
                setDraft(emptyDraft)
              }}
              className="text-xs px-2 py-1 border border-white/15 rounded hover:border-cyan-700/40"
            >
              New
            </button>
          </div>

          <div className="space-y-2">
            {(config?.projects || []).map((project) => (
              <div key={project.id} className="rounded-xl border border-white/10 p-3 bg-white/[0.02]">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{project.name}</div>
                    <div className="text-xs text-gray-400 font-mono truncate">{project.root_path}</div>
                    <div className="text-xs text-gray-500 mt-1">{project.dev_url}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        await api.projectHub.setActive(project.id)
                        await refresh()
                      }}
                      className="text-xs px-2 py-1 border border-white/15 rounded hover:border-cyan-700/40"
                    >
                      {config?.active_project_id === project.id ? 'Active' : 'Switch'}
                    </button>
                    <button
                      onClick={() => {
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
                      }}
                      className="text-xs px-2 py-1 border border-white/15 rounded hover:border-cyan-700/40"
                    >
                      Edit
                    </button>
                    <button
                      onClick={async () => {
                        await api.projectHub.deleteProject(project.id)
                        await refresh()
                      }}
                      className="text-xs px-2 py-1 border border-red-700/50 rounded text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-4">
          <div className="rounded-xl border border-white/10 p-4 bg-white/[0.02] space-y-3">
            <h3 className="text-sm font-semibold">Surface Actions</h3>
            <p className="text-xs text-gray-400">These always target the current active project.</p>
            <div className="grid grid-cols-1 gap-2">
              <button onClick={() => void openSurface('ide')} className="px-3 py-2 text-xs border border-white/15 rounded hover:border-cyan-700/40">Open / Focus IDE</button>
              <button onClick={() => void openSurface('browser')} className="px-3 py-2 text-xs border border-white/15 rounded hover:border-cyan-700/40">Open / Focus Browser</button>
              <button onClick={() => void openSurface('agent')} className="px-3 py-2 text-xs border border-white/15 rounded hover:border-cyan-700/40">Open / Focus Agent</button>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 p-4 bg-white/[0.02] space-y-2">
            <h3 className="text-sm font-semibold">Project Editor</h3>
            <input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Project name" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <input value={draft.root_path} onChange={(e) => setDraft((d) => ({ ...d, root_path: e.target.value }))} placeholder="Root path" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs font-mono" />
            <input value={draft.ide_command} onChange={(e) => setDraft((d) => ({ ...d, ide_command: e.target.value }))} placeholder="IDE command" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <input value={draft.agent_command} onChange={(e) => setDraft((d) => ({ ...d, agent_command: e.target.value }))} placeholder="Agent command" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <input value={draft.dev_url} onChange={(e) => setDraft((d) => ({ ...d, dev_url: e.target.value }))} placeholder="Dev URL" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs font-mono" />
            <input value={draft.ide_hint} onChange={(e) => setDraft((d) => ({ ...d, ide_hint: e.target.value }))} placeholder="IDE window title hint (optional)" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <input value={draft.browser_hint} onChange={(e) => setDraft((d) => ({ ...d, browser_hint: e.target.value }))} placeholder="Browser window title hint (optional)" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <input value={draft.agent_hint} onChange={(e) => setDraft((d) => ({ ...d, agent_hint: e.target.value }))} placeholder="Agent terminal title hint (optional)" className="w-full bg-[#101114] border border-white/10 rounded px-2 py-1.5 text-xs" />
            <button onClick={() => void onSaveProject()} className="w-full px-3 py-2 text-xs bg-cyan-400 text-black rounded font-semibold hover:bg-cyan-300">{editingId ? 'Update Project' : 'Save Project'}</button>
          </div>
        </section>
      </main>

      <footer className="px-6 py-3 border-t border-white/10 text-xs text-gray-400 flex items-center justify-between">
        <div>{message || 'Ready.'}</div>
        <div className="font-mono">Switch: Ctrl+Shift+S | IDE: Ctrl+Shift+I | Browser: Ctrl+Shift+B | Agent: Ctrl+Shift+A</div>
      </footer>
    </div>
  )
}

export default function App() {
  if (isProjectSwitcherOverlay) {
    return <ProjectSwitcherOverlay />
  }

  return <MainApp />
}
