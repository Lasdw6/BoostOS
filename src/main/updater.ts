import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const DEFAULT_UPDATE_FEED_URL = 'https://downloads.boostos.ai/downloads'
const PERIODIC_UPDATE_CHECK_MS = 15 * 60 * 1000

export type AppUpdateStatus = {
  enabled: boolean
  checking: boolean
  updateAvailable: boolean
  downloadedVersion?: string
  lastError?: string
}

export class AppUpdater {
  private initialized = false
  private checking = false
  private updateAvailable = false
  private downloadedVersion: string | undefined
  private lastError: string | undefined

  getStatus(): AppUpdateStatus {
    return {
      enabled: app.isPackaged,
      checking: this.checking,
      updateAvailable: this.updateAvailable,
      downloadedVersion: this.downloadedVersion,
      lastError: this.lastError
    }
  }

  init(): void {
    if (this.initialized || !app.isPackaged) return
    this.initialized = true

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // Use product feed by default so installed clients update without OS env setup.
    // Env override is still supported for staging/testing.
    const feedUrl = process.env.BOOST_UPDATE_FEED_URL?.trim() || DEFAULT_UPDATE_FEED_URL
    if (feedUrl) {
      autoUpdater.setFeedURL({
        provider: 'generic',
        url: feedUrl
      })
    }

    autoUpdater.on('checking-for-update', () => {
      this.checking = true
      this.lastError = undefined
    })

    autoUpdater.on('update-available', () => {
      this.updateAvailable = true
    })

    autoUpdater.on('update-not-available', () => {
      this.checking = false
      this.updateAvailable = false
      this.downloadedVersion = undefined
    })

    autoUpdater.on('error', (error) => {
      this.checking = false
      this.lastError = error?.message || String(error)
      console.warn('[Updater] update check failed:', this.lastError)
    })

    autoUpdater.on('update-downloaded', async (event) => {
      this.checking = false
      this.updateAvailable = true
      this.downloadedVersion = event.version

      const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
      for (const window of windows) {
        window.webContents.send('app-update:downloaded', { version: event.version })
      }
    })

    // Re-check periodically so users don't need to restart the app to see update prompts.
    const timer = setInterval(() => {
      void this.checkForUpdates()
    }, PERIODIC_UPDATE_CHECK_MS)
    timer.unref()
  }

  async checkForUpdates(): Promise<AppUpdateStatus> {
    if (!app.isPackaged) {
      return this.getStatus()
    }

    this.init()
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn('[Updater] checkForUpdates failed:', this.lastError)
    } finally {
      this.checking = false
    }
    return this.getStatus()
  }

  installUpdateNow(): void {
    if (!app.isPackaged) return
    autoUpdater.quitAndInstall()
  }
}
