import os from 'os'
import path from 'path'
import { existsSync, statSync } from 'fs'
import { readdir } from 'fs/promises'
import type { ProjectProfile } from '../shared/project-hub'
import { getPsListFn } from './ps-list-loader'

type DiscoveryProfile = Omit<ProjectProfile, 'id' | 'created_at' | 'updated_at'>

type RootEvidence = {
  ideCounts: Record<string, number>
  agentCounts: Record<string, number>
  devPortCounts: Record<string, number>
}

const IDE_HINTS = [
  { token: 'cursor', cmd: 'cursor' },
  { token: 'code', cmd: 'code' },
  { token: 'zed', cmd: 'zed' }
]

const AGENT_HINTS = [
  { token: 'codex', cmd: 'codex' },
  { token: 'claude', cmd: 'claude' },
  { token: 'opencode', cmd: 'opencode' }
]

const COMMON_SCAN_DIRS = ['Desktop', 'Documents', 'Projects', 'repos', 'source', 'dev', 'code']

function normalize(p: string): string {
  return path.resolve(p).toLowerCase()
}

function safeStat(dir: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(dir)
  } catch {
    return null
  }
}

function isDirectory(dir: string): boolean {
  const stat = safeStat(dir)
  return Boolean(stat?.isDirectory())
}

function findGitRoot(start: string): string | null {
  const resolved = path.resolve(start)
  let current = isDirectory(resolved) ? resolved : path.dirname(resolved)
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

function extractWindowsPaths(raw: string): string[] {
  const out = new Set<string>()
  const quoted = raw.matchAll(/["']([A-Za-z]:\\[^"']+)["']/g)
  for (const match of quoted) {
    if (match[1]) out.add(match[1])
  }

  const unquoted = raw.matchAll(/\b[A-Za-z]:\\[^\s"']+/g)
  for (const match of unquoted) {
    if (match[0]) out.add(match[0])
  }
  return [...out]
}

function parsePortFromText(raw: string): string | null {
  const url = raw.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/i)
  if (url?.[1]) return url[1]

  const explicit = raw.match(/(?:--port|-p|PORT=)\s*([0-9]{2,5})/i)
  if (explicit?.[1]) return explicit[1]

  return null
}

function topCount(counts: Record<string, number>, fallback: string): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return fallback
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
}

async function scanForRepos(roots: string[], maxDepth = 3, maxRepos = 80): Promise<string[]> {
  const found = new Set<string>()
  const visited = new Set<string>()
  const queue: Array<{ dir: string; depth: number }> = []

  for (const root of roots) {
    if (isDirectory(root)) queue.push({ dir: root, depth: 0 })
  }

  while (queue.length > 0 && found.size < maxRepos) {
    const current = queue.shift()
    if (!current) break
    const norm = normalize(current.dir)
    if (visited.has(norm)) continue
    visited.add(norm)

    if (existsSync(path.join(current.dir, '.git'))) {
      found.add(path.resolve(current.dir))
      continue
    }

    if (current.depth >= maxDepth) continue

    let entries: Array<{ name: string; isDirectory: () => boolean }>
    try {
      entries = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (name === 'node_modules' || name === '.next' || name === 'dist' || name === 'build' || name === '.git') {
        continue
      }
      queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }

  return [...found]
}

function buildScanRoots(): string[] {
  const roots = new Set<string>()
  const home = os.homedir()
  const userProfile = process.env.USERPROFILE || ''
  const cwd = process.cwd()

  const addCommon = (base: string) => {
    if (!base) return
    roots.add(base)
    for (const dir of COMMON_SCAN_DIRS) {
      roots.add(path.join(base, dir))
    }
  }

  addCommon(home)
  addCommon(userProfile)

  // Support non-standard layouts like C:\Desktop\...
  const driveRoot = path.parse(cwd).root
  if (driveRoot) {
    addCommon(driveRoot)
    roots.add(path.join(driveRoot, 'Desktop'))
  }

  // Add cwd and a few ancestors so current workspace is always discoverable.
  let cursor = path.resolve(cwd)
  for (let i = 0; i < 6; i += 1) {
    roots.add(cursor)
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  return [...roots].filter((dir) => isDirectory(dir))
}

export async function discoverProjectProfiles(): Promise<DiscoveryProfile[]> {
  const evidenceByRoot = new Map<string, RootEvidence>()
  const roots = new Set<string>()
  const psListFn = getPsListFn()
  const processes = await psListFn()

  for (const proc of processes) {
    const cmd = String((proc as any).cmd || '')
    const cwd = String((proc as any).cwd || '')
    const haystack = `${proc.name} ${cmd} ${cwd}`.toLowerCase()

    const candidates = new Set<string>()
    if (cwd) candidates.add(cwd)
    for (const extracted of extractWindowsPaths(cmd)) candidates.add(extracted)

    const gitRoots = new Set<string>()
    for (const candidate of candidates) {
      const repo = findGitRoot(candidate)
      if (repo) {
        gitRoots.add(repo)
        roots.add(repo)
      }
    }

    if (gitRoots.size === 0) continue

    for (const repo of gitRoots) {
      const existing = evidenceByRoot.get(repo) || {
        ideCounts: {},
        agentCounts: {},
        devPortCounts: {}
      }

      for (const hint of IDE_HINTS) {
        if (haystack.includes(hint.token)) {
          existing.ideCounts[hint.cmd] = (existing.ideCounts[hint.cmd] || 0) + 1
        }
      }
      for (const hint of AGENT_HINTS) {
        if (haystack.includes(hint.token)) {
          existing.agentCounts[hint.cmd] = (existing.agentCounts[hint.cmd] || 0) + 1
        }
      }

      const port = parsePortFromText(haystack)
      if (port) {
        existing.devPortCounts[port] = (existing.devPortCounts[port] || 0) + 1
      }

      evidenceByRoot.set(repo, existing)
    }
  }

  const baseScanDirs = buildScanRoots()
  const scannedRoots = await scanForRepos(baseScanDirs, 4, 140)
  for (const repo of scannedRoots) {
    roots.add(repo)
    if (!evidenceByRoot.has(repo)) {
      evidenceByRoot.set(repo, { ideCounts: {}, agentCounts: {}, devPortCounts: {} })
    }
  }

  const profiles: DiscoveryProfile[] = []
  for (const repo of roots) {
    const ev = evidenceByRoot.get(repo) || { ideCounts: {}, agentCounts: {}, devPortCounts: {} }
    const ide = topCount(ev.ideCounts, 'cursor')
    const agent = topCount(ev.agentCounts, 'codex')
    const port = topCount(ev.devPortCounts, '3000')
    const name = path.basename(repo)

    profiles.push({
      name: name || repo,
      root_path: repo,
      ide_command: ide,
      agent_command: agent,
      dev_url: `http://localhost:${port}`,
      ide_hint: name || undefined,
      agent_hint: name || undefined,
      browser_hint: port ? `localhost:${port}` : undefined
    })
  }

  profiles.sort((a, b) => a.name.localeCompare(b.name))
  return profiles
}
