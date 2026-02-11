import { spawn } from 'child_process'

// Lazy-load windowManager to avoid initialization issues
let _windowManager: any = null
function getWindowManager() {
  if (!_windowManager) {
    try {
      const { windowManager } = require('node-window-manager')
      _windowManager = windowManager
    } catch (error) {
      console.error('[WindowManager] Failed to load node-window-manager:', error)
      _windowManager = null
    }
  }
  return _windowManager
}

export interface WindowInfo {
  id: number
  title: string
  processId: number
}

export interface ScreenSize {
  width: number
  height: number
}

export class DesktopWindowManager {
  private getWindows(): any[] {
    const wm = getWindowManager()
    if (!wm) {
      console.error('[WindowManager] windowManager not available')
      return []
    }

    const windows = wm.getWindows()
    return windows as any[]
  }

  private getMonitors(): any[] {
    const wm = getWindowManager()
    if (!wm) {
      console.error('[WindowManager] windowManager not available')
      return []
    }

    console.log('[WindowManager] Calling getMonitors()...')
    console.log('[WindowManager] windowManager type:', typeof wm)
    console.log('[WindowManager] getMonitors type:', typeof wm.getMonitors)

    try {
      const monitors = wm.getMonitors()
      console.log('[WindowManager] getMonitors() returned:', monitors)
      console.log('[WindowManager] Monitor count:', monitors?.length || 0)
      return monitors as any[]
    } catch (error) {
      console.error('[WindowManager] Error calling getMonitors():', error)
      return []
    }
  }

  /** Find window by application name or title pattern */
  findWindow(pattern: string): any | null {
    const windows = this.getWindows()

    const lowerPattern = pattern.toLowerCase()
    let window = windows.find((w) => w.getTitle().toLowerCase().includes(lowerPattern))

    if (!window) {
      window = windows.find((w) => w.path?.toLowerCase().includes(lowerPattern))
    }

    return window || null
  }

  /** Find window by exact process path */
  findWindowByProcessPath(processPath: string): any | null {
    const windows = this.getWindows()
    const normalizedPath = processPath.toLowerCase()

    // Try exact match first
    let window = windows.find((w) => w.path?.toLowerCase() === normalizedPath)

    // Fall back to partial match (basename)
    if (!window) {
      const basename = normalizedPath.split(/[\\/]/).pop() || ''
      window = windows.find((w) => {
        const winBasename = (w.path || '').toLowerCase().split(/[\\/]/).pop() || ''
        return winBasename === basename
      })
    }

    return window || null
  }

  /** Find all windows matching a process name */
  findWindowsByProcessName(processName: string): any[] {
    const windows = this.getWindows()
    const lowerName = processName.toLowerCase()

    return windows.filter((w) => {
      const winBasename = (w.path || '').toLowerCase().split(/[\\/]/).pop() || ''
      return winBasename === lowerName || winBasename.startsWith(lowerName.replace('.exe', ''))
    })
  }

  /** Launch application and optionally wait for its window */
  async launchApp(
    appPath: string,
    args: string[] = [],
    waitForWindow: boolean = true,
    maxWaitMs: number = 5000,
    workingDirectory?: string
  ): Promise<any | null> {
    // Use spawn to launch application
    return new Promise((resolve, reject) => {
      const spawnOptions: any = {
        detached: true,
        stdio: 'ignore',
        shell: true
      }

      // Add working directory if provided
      if (workingDirectory) {
        spawnOptions.cwd = workingDirectory
      }

      const proc = spawn(appPath, args, spawnOptions)

      proc.unref()

      if (!waitForWindow) {
        resolve(null)
        return
      }

      const startTime = Date.now()
      const checkInterval = setInterval(() => {
        const window = this.findWindow(appPath)

        if (window) {
          clearInterval(checkInterval)
          resolve(window)
        } else if (Date.now() - startTime > maxWaitMs) {
          clearInterval(checkInterval)
          resolve(null)
        }
      }, 200)

      proc.on('error', (err) => {
        clearInterval(checkInterval)
        reject(err)
      })
    })
  }

  setPosition(window: any, x: number, y: number): void {
    if (!window) throw new Error('Window is null or undefined')
    window.setBounds({ x, y })
  }

  setSize(window: any, width: number, height: number): void {
    if (!window) throw new Error('Window is null or undefined')
    window.setBounds({ width, height })
  }

  setBounds(window: any, x: number, y: number, width: number, height: number): void {
    if (!window) throw new Error('Window is null or undefined')
    window.setBounds({ x, y, width, height })
  }

  focusWindow(window: any): void {
    if (!window) throw new Error('Window is null or undefined')
    window.bringToTop()
  }

  maximize(window: any): void {
    if (!window) throw new Error('Window is null or undefined')
    window.maximize()
  }

  minimize(window: any): void {
    if (!window) throw new Error('Window is null or undefined')
    window.minimize()
  }

  restore(window: any): void {
    if (!window) throw new Error('Window is null or undefined')
    window.restore()
  }

  getScreenSize(): ScreenSize {
    const monitors = this.getMonitors()
    const primary = monitors[0]?.bounds || { width: 0, height: 0 }
    return {
      width: primary.width,
      height: primary.height
    }
  }

  splitVertical50_50(win1: any, win2: any): void {
    const screen = this.getScreenSize()
    const halfWidth = Math.floor(screen.width / 2)

    this.setBounds(win1, 0, 0, halfWidth, screen.height)
    this.focusWindow(win1)

    this.setBounds(win2, halfWidth, 0, halfWidth, screen.height)
    this.focusWindow(win2)
  }

  splitHorizontal50_50(win1: any, win2: any): void {
    const screen = this.getScreenSize()
    const halfHeight = Math.floor(screen.height / 2)

    this.setBounds(win1, 0, 0, screen.width, halfHeight)
    this.focusWindow(win1)

    this.setBounds(win2, 0, halfHeight, screen.width, halfHeight)
    this.focusWindow(win2)
  }

  splitQuadrants(win1: any, win2: any, win3: any, win4: any): void {
    const screen = this.getScreenSize()
    const halfWidth = Math.floor(screen.width / 2)
    const halfHeight = Math.floor(screen.height / 2)

    this.setBounds(win1, 0, 0, halfWidth, halfHeight)
    this.setBounds(win2, halfWidth, 0, halfWidth, halfHeight)
    this.setBounds(win3, 0, halfHeight, halfWidth, halfHeight)
    this.setBounds(win4, halfWidth, halfHeight, halfWidth, halfHeight)
  }

  tileWindows(windows: any[], cols?: number): void {
    if (windows.length === 0) return

    const screen = this.getScreenSize()
    const count = windows.length
    const columns = cols || Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / columns)
    const windowWidth = Math.floor(screen.width / columns)
    const windowHeight = Math.floor(screen.height / rows)

    windows.forEach((window, index) => {
      const row = Math.floor(index / columns)
      const col = index % columns
      this.setBounds(window, col * windowWidth, row * windowHeight, windowWidth, windowHeight)
    })
  }

  getAllWindows(): any[] {
    // Return raw Window objects with all methods (getBounds, getTitle, etc.)
    return this.getWindows()
  }

  getWindowById(id: number): any | null {
    const windows = this.getWindows()
    return windows.find((w) => w.id === id) || null
  }

  closeWindow(window: any): void {
    if (!window) throw new Error('Window is null or undefined')
    try {
      window.close()
    } catch (err) {
      console.error('Failed to close window:', err)
      throw err
    }
  }

  getBounds(window: any): { x: number; y: number; width: number; height: number } {
    if (!window) throw new Error('Window is null or undefined')
    return window.getBounds()
  }

  isWindowValid(window: any): boolean {
    if (!window) return false
    try {
      window.getTitle()
      return true
    } catch {
      return false
    }
  }
}

export const windowManager = new DesktopWindowManager()
