import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

export type AppMode = 'activity' | 'workflow' | 'both'

export interface HyperKeyBinding {
  key: string
  label: string
  command: string
}

export interface HyperKeyConfig {
  enabled: boolean
  ahkPath?: string
  bindings: HyperKeyBinding[]
}

export interface AppConfig {
  mode: AppMode // NEW: Run mode (activity collector, workflow automation, or both)
  retention_days: number
  max_file_size_mb: number
  privacy: {
    log_window_titles: boolean
    log_executable_paths: boolean
    excluded_apps: string[]
  }
  auto_launch: boolean
  notifications_enabled: boolean
  prediction_enabled: boolean
  prediction_confidence_threshold: number
  input_logging_enabled: boolean // NEW: Enable privacy-safe input logging
  openai_api_key?: string // OpenAI API key for LLM workflow generation
  shortcuts: Record<string, string> // Map of shortcut keys to workflow IDs
  shortcuts_updated_at?: string // Last cloud-sync timestamp for shortcut mappings
  built_in_shortcuts_disabled?: string[]
  hyper_key?: HyperKeyConfig
}

const HYPER_CHROME_FOCUS_OR_LAUNCH = 'focus-or-launch:chrome'
const HYPER_CURSOR_FOCUS_OR_LAUNCH = 'focus-or-launch:cursor'

const DEFAULT_CONFIG: AppConfig = {
  mode: 'both', // Run both activity collector and workflow automation
  retention_days: 90,
  max_file_size_mb: 50,
  privacy: {
    log_window_titles: true,
    log_executable_paths: true,
    excluded_apps: []
  },
  auto_launch: false,
  notifications_enabled: true,
  prediction_enabled: true,
  prediction_confidence_threshold: 0.65,
  input_logging_enabled: false, // Disabled by default for privacy
  openai_api_key: undefined,
  shortcuts: {},
  built_in_shortcuts_disabled: [],
  hyper_key: {
    enabled: false,
    bindings: [
      { key: '1', label: 'Chrome', command: HYPER_CHROME_FOCUS_OR_LAUNCH },
      { key: '2', label: 'Cursor', command: HYPER_CURSOR_FOCUS_OR_LAUNCH }
    ]
  }
}

let cachedConfig: AppConfig | null = null

export function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function getDataDir(): string {
  return join(app.getPath('userData'), 'data')
}

export function getActivityLogPath(): string {
  return join(getDataDir(), 'activity.jsonl')
}

export async function loadConfig(): Promise<AppConfig> {
  if (cachedConfig) return cachedConfig

  let config: AppConfig

  try {
    const configPath = getConfigPath()
    const data = await readFile(configPath, 'utf-8')
    const loaded = JSON.parse(data)
    config = { ...DEFAULT_CONFIG, ...loaded }
  } catch (error) {
    // Config doesn't exist or is invalid, use defaults
    config = { ...DEFAULT_CONFIG }
    await saveConfig(config)
  }

  const envApiKey = process.env.OPENAI_API_KEY
  if (!config.openai_api_key && envApiKey) {
    config.openai_api_key = envApiKey
  }

  // Migrate legacy Hyper defaults to native focus-or-launch behavior.
  if (!config.hyper_key) {
    config.hyper_key = {
      enabled: false,
      ahkPath: undefined,
      bindings: [...(DEFAULT_CONFIG.hyper_key?.bindings || [])]
    }
  }
  const hyper = config.hyper_key
  if (!Array.isArray(hyper.bindings)) {
    hyper.bindings = [...(DEFAULT_CONFIG.hyper_key?.bindings || [])]
  }

  let hyperChanged = false
  hyper.bindings = hyper.bindings.map((binding) => {
    const key = String(binding?.key || '')
    const command = String(binding?.command || '').trim().toLowerCase()

    if (
      key === '1' &&
      (command === 'start chrome' ||
        command.includes('start-process chrome') ||
        command.includes('get-process chrome'))
    ) {
      hyperChanged = true
      return { ...binding, command: HYPER_CHROME_FOCUS_OR_LAUNCH }
    }
    if (
      key === '2' &&
      (command === 'start cursor' ||
        command.includes('start-process cursor') ||
        command.includes('get-process cursor'))
    ) {
      hyperChanged = true
      return { ...binding, command: HYPER_CURSOR_FOCUS_OR_LAUNCH }
    }
    return binding
  })

  if (hyperChanged) {
    await saveConfig(config)
  }

  cachedConfig = config
  return config
}

export async function saveConfig(config: AppConfig): Promise<void> {
  cachedConfig = config
  const configPath = getConfigPath()
  await mkdir(join(configPath, '..'), { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

export async function updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig()
  const updated = { ...current, ...partial }
  await saveConfig(updated)
  return updated
}
