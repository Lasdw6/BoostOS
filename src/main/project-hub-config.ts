import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import {
  DEFAULT_PROJECT_HUB_CONFIG,
  type ProjectHubConfig,
  type ProjectProfile
} from '../shared/project-hub'

const CONFIG_FILE = 'project-hub-v2.json'

function getConfigPath(): string {
  const userData = app.getPath('userData')
  return join(userData, CONFIG_FILE)
}

export function loadProjectHubConfig(): ProjectHubConfig {
  const path = getConfigPath()
  if (!existsSync(path)) {
    return { ...DEFAULT_PROJECT_HUB_CONFIG }
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ProjectHubConfig>
    return {
      active_project_id: raw.active_project_id || null,
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      shortcuts: {
        ...DEFAULT_PROJECT_HUB_CONFIG.shortcuts,
        ...(raw.shortcuts || {})
      }
    }
  } catch {
    return { ...DEFAULT_PROJECT_HUB_CONFIG }
  }
}

export function saveProjectHubConfig(config: ProjectHubConfig): void {
  const path = getConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
}

export function upsertProject(
  config: ProjectHubConfig,
  input: Omit<ProjectProfile, 'created_at' | 'updated_at'> & {
    created_at?: string
    updated_at?: string
  }
): ProjectHubConfig {
  const now = new Date().toISOString()
  const existing = config.projects.find((p) => p.id === input.id)
  if (existing) {
    const next = config.projects.map((p) =>
      p.id === input.id
        ? {
            ...p,
            ...input,
            updated_at: now
          }
        : p
    )
    return { ...config, projects: next }
  }

  return {
    ...config,
    projects: [
      ...config.projects,
      {
        ...input,
        created_at: input.created_at || now,
        updated_at: input.updated_at || now
      }
    ]
  }
}
