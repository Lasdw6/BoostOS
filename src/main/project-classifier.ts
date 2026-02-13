import { generateObject } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { windowManager } from './window-manager'
import { resolveOpenAIKey } from './convex-bootstrap'
import { getPsListFn } from './ps-list-loader'
import type { ProjectProfile } from '../shared/project-hub'

const classificationSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      ide_command: z.string(),
      agent_command: z.string(),
      dev_url: z.string(),
      ide_hint: z.string().optional(),
      agent_hint: z.string().optional(),
      browser_hint: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      reason: z.string().optional()
    })
  )
})

function normalizePath(value: string): string {
  return value.toLowerCase().replace(/[\\/]+$/, '')
}

function trimValue(value: string, max = 220): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...`
}

export async function classifyProjectsWithLLM(
  projects: ProjectProfile[]
): Promise<z.infer<typeof classificationSchema>> {
  const apiKey = await resolveOpenAIKey()
  if (!apiKey) {
    throw new Error(
      'OpenAI API key not available. Sign in so /client/bootstrap returns apiKeys.openaiApiKey, or set OPENAI_API_KEY/BOOST_API_TOKEN.'
    )
  }

  const projectRoots = projects.map((p) => ({
    id: p.id,
    name: p.name,
    root_path: p.root_path,
    normalized_root: normalizePath(p.root_path)
  }))

  const windows = windowManager
    .getAllWindows()
    .slice(0, 140)
    .map((win: any) => {
      let title = ''
      try {
        title = String(win.getTitle?.() || '')
      } catch {
        title = ''
      }
      const fullPath = String(win.path || '')
      return {
        title: trimValue(title, 180),
        path: trimValue(fullPath, 180),
        process: fullPath.split(/[\\/]/).pop() || '',
        pid: typeof win.processId === 'number' ? win.processId : null
      }
    })
    .filter((w) => w.title || w.path)

  const psList = getPsListFn()
  const allProcesses = await psList()
  const processRows = allProcesses
    .map((proc) => ({
      name: proc.name || '',
      pid: proc.pid,
      cmd: trimValue(String((proc as any).cmd || ''), 240),
      cwd: trimValue(String((proc as any).cwd || ''), 180)
    }))
    .filter((proc) => {
      const source = `${proc.name} ${proc.cmd} ${proc.cwd}`.toLowerCase()
      const relevantProcess =
        /(codex|claude|opencode|cursor|code|zed|chrome|msedge|brave|node|bun|npm|pnpm|vite|next|webpack|dev server|localhost|127\.0\.0\.1)/.test(
          source
        )
      const relatedProject = projectRoots.some((project) =>
        source.includes(project.normalized_root)
      )
      return relevantProcess || relatedProject
    })
    .slice(0, 220)

  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const openai = createOpenAI({ apiKey })
  const system = [
    'You classify local development projects by assigning best defaults for IDE, agent command, and dev URL.',
    'Use only strong evidence from running windows and process command lines.',
    'Do not invent project IDs. Return one object per provided project ID.',
    'Allowed ide_command values should usually be one of: cursor, code, zed.',
    'Allowed agent_command values should usually be one of: codex, claude, opencode.',
    'dev_url should be a local URL like http://localhost:3000 when known, otherwise keep the project existing URL by inference from context.',
    'Hints should be short window-title hints that improve focus targeting.'
  ].join('\n')

  const prompt = JSON.stringify(
    {
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        root_path: p.root_path,
        existing: {
          ide_command: p.ide_command,
          agent_command: p.agent_command,
          dev_url: p.dev_url,
          ide_hint: p.ide_hint || '',
          agent_hint: p.agent_hint || '',
          browser_hint: p.browser_hint || ''
        }
      })),
      observations: {
        windows,
        processes: processRows
      }
    },
    null,
    2
  )

  const { object } = await generateObject({
    model: openai(modelName),
    schema: classificationSchema,
    system,
    prompt
  })

  return object
}
