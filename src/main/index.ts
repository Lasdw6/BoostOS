import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { loadProjectHubConfig, saveProjectHubConfig, upsertProject } from './project-hub-config'
import { windowManager } from './window-manager'
import type { ProjectHubConfig, ProjectProfile } from '../shared/project-hub'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuittingApp = false

const appIconPath = [
  isDev ? join(__dirname, '../../resources/icon.png') : '',
  join(process.resourcesPath, 'icon.png'),
  join(__dirname, '../../build/icon.png')
].find((p) => p && existsSync(p))

const appIcon = appIconPath ? nativeImage.createFromPath(appIconPath) : nativeImage.createEmpty()

function getConfig(): ProjectHubConfig {
  return loadProjectHubConfig()
}

function setConfig(config: ProjectHubConfig): void {
  saveProjectHubConfig(config)
}

function getActiveProject(config: ProjectHubConfig): ProjectProfile | null {
  if (!config.active_project_id) return null
  return config.projects.find((p) => p.id === config.active_project_id) || null
}

function focusBestWindow(processNames: string[], titleHints: string[]): boolean {
  const candidates: Array<{ win: any; score: number }> = []

  for (const processName of processNames) {
    const wins = windowManager.findWindowsByProcessName(processName)
    for (const win of wins) {
      const title = String(win.getTitle?.() || '').toLowerCase()
      let score = 1
      for (const hint of titleHints) {
        if (!hint) continue
        const lowHint = hint.toLowerCase()
        if (title.includes(lowHint)) score += 5
      }
      candidates.push({ win, score })
    }
  }

  if (candidates.length === 0) return false
  candidates.sort((a, b) => b.score - a.score)
  try {
    windowManager.focusWindow(candidates[0].win)
    return true
  } catch {
    return false
  }
}

function openIde(project: ProjectProfile): { ok: boolean; message: string } {
  const titleHints = [project.ide_hint || '', project.name, project.root_path.split(/[\\/]/).pop() || '']
  if (focusBestWindow(['cursor.exe', 'code.exe', 'zed.exe'], titleHints)) {
    return { ok: true, message: `Focused IDE for ${project.name}` }
  }

  const command = (project.ide_command || 'cursor').trim()
  const proc = spawn('cmd.exe', ['/c', 'start', '""', command, '--reuse-window', project.root_path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  proc.unref()
  return { ok: true, message: `Launched IDE for ${project.name}` }
}

function openBrowser(project: ProjectProfile): { ok: boolean; message: string } {
  const hint = project.browser_hint?.trim()
  const url = project.dev_url?.trim() || 'http://localhost:3000'
  const fromUrl = (() => {
    try {
      const u = new URL(url)
      return [u.host, u.hostname, u.port].filter(Boolean).join(' ')
    } catch {
      return ''
    }
  })()

  const hints = [hint || '', project.name, fromUrl]
  if (focusBestWindow(['chrome.exe', 'msedge.exe', 'brave.exe'], hints)) {
    return { ok: true, message: `Focused browser for ${project.name}` }
  }

  void shell.openExternal(url)
  return { ok: true, message: `Opened ${url}` }
}

function openAgent(project: ProjectProfile): { ok: boolean; message: string } {
  const titleHints = [project.agent_hint || '', project.name, project.root_path.split(/[\\/]/).pop() || '']
  if (
    focusBestWindow(
      ['windowsterminal.exe', 'windows terminal.exe', 'wezterm-gui.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe'],
      titleHints
    )
  ) {
    return { ok: true, message: `Focused agent terminal for ${project.name}` }
  }

  const command = (project.agent_command || 'codex').trim()
  const psCommand = `Set-Location -LiteralPath '${project.root_path.replace(/'/g, "''")}'; ${command}`
  const proc = spawn(
    'cmd.exe',
    ['/c', 'start', '""', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', psCommand],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  )
  proc.unref()
  return { ok: true, message: `Launched agent terminal for ${project.name}` }
}

function createWindow(showOnReady: boolean = true): BrowserWindow {
  if (mainWindow) {
    if (showOnReady) {
      mainWindow.show()
      mainWindow.focus()
    }
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#050505',
    titleBarStyle: 'hidden',
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (showOnReady) mainWindow?.show()
  })

  mainWindow.on('close', (event) => {
    if (!isQuittingApp) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function createOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.focus()
    return overlayWindow
  }

  overlayWindow = new BrowserWindow({
    width: 720,
    height: 520,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  overlayWindow.on('ready-to-show', () => {
    overlayWindow?.show()
    overlayWindow?.focus()
  })

  overlayWindow.on('blur', () => {
    overlayWindow?.close()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#project-switcher`)
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'project-switcher' })
  }

  return overlayWindow
}

function createTray(): void {
  tray = new Tray(appIcon.resize({ width: 24, height: 24 }))
  tray.setToolTip('Boost v2')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Boost v2', enabled: false },
      { type: 'separator' },
      { label: 'Open Dashboard', click: () => createWindow(true) },
      { label: 'Project Switcher', click: () => createOverlayWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )

  tray.on('double-click', () => createWindow(true))
}

function registerShortcuts(): void {
  const config = getConfig()
  globalShortcut.unregisterAll()

  globalShortcut.register(config.shortcuts.switcher, () => {
    createOverlayWindow()
  })

  globalShortcut.register(config.shortcuts.open_ide, () => {
    const active = getActiveProject(getConfig())
    if (active) void openIde(active)
  })

  globalShortcut.register(config.shortcuts.open_browser, () => {
    const active = getActiveProject(getConfig())
    if (active) void openBrowser(active)
  })

  globalShortcut.register(config.shortcuts.open_agent, () => {
    const active = getActiveProject(getConfig())
    if (active) void openAgent(active)
  })
}

function setupIpc(): void {
  ipcMain.handle('project-hub:get-config', () => {
    return getConfig()
  })

  ipcMain.handle(
    'project-hub:save-project',
    (
      _,
      project: Omit<ProjectProfile, 'id' | 'created_at' | 'updated_at'> & { id?: string }
    ) => {
      const config = getConfig()
      const id = project.id || randomUUID()
      const next = upsertProject(config, {
        id,
        name: project.name,
        root_path: project.root_path,
        ide_command: project.ide_command,
        agent_command: project.agent_command,
        dev_url: project.dev_url,
        browser_hint: project.browser_hint,
        agent_hint: project.agent_hint,
        ide_hint: project.ide_hint
      })

      if (!next.active_project_id) {
        next.active_project_id = id
      }

      setConfig(next)
      return next
    }
  )

  ipcMain.handle('project-hub:delete-project', (_, projectId: string) => {
    const config = getConfig()
    const nextProjects = config.projects.filter((p) => p.id !== projectId)
    const next: ProjectHubConfig = {
      ...config,
      projects: nextProjects,
      active_project_id:
        config.active_project_id === projectId
          ? nextProjects[0]?.id || null
          : config.active_project_id
    }
    setConfig(next)
    return next
  })

  ipcMain.handle('project-hub:set-active', (_, projectId: string) => {
    const config = getConfig()
    const exists = config.projects.some((p) => p.id === projectId)
    if (!exists) throw new Error('Project not found')
    const next = { ...config, active_project_id: projectId }
    setConfig(next)
    return next
  })

  ipcMain.handle('project-hub:open-surface', (_, surface: 'ide' | 'browser' | 'agent') => {
    const config = getConfig()
    const active = getActiveProject(config)
    if (!active) {
      return { ok: false, message: 'No active project selected.' }
    }

    if (surface === 'ide') return openIde(active)
    if (surface === 'browser') return openBrowser(active)
    return openAgent(active)
  })

  ipcMain.handle('project-hub:update-shortcuts', (_, shortcuts: Partial<ProjectHubConfig['shortcuts']>) => {
    const config = getConfig()
    const next = {
      ...config,
      shortcuts: {
        ...config.shortcuts,
        ...shortcuts
      }
    }
    setConfig(next)
    registerShortcuts()
    return next
  })

  ipcMain.handle('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close()
      overlayWindow = null
    }
  })

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.minimize()
  })

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.close()
  })
}

app.whenReady().then(() => {
  createTray()
  createWindow(false)
  registerShortcuts()
  setupIpc()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(true)
    }
  })
})

app.on('before-quit', () => {
  isQuittingApp = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  // Keep tray-first behavior on all platforms.
})
