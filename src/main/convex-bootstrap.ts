import { readFile } from 'fs/promises'
import { getSharedAuthPath } from '@boostos/boost-auth'

type BootstrapResponse = {
  apiKeys?: {
    openaiApiKey?: string | null
  }
}

type PersistedAuthState = {
  session?: {
    sessionToken?: string
  }
}

function getBackendUrl(): string {
  return (process.env.BOOST_API_URL || 'https://sleek-mockingbird-162.convex.site').replace(/\/$/, '')
}

async function readSharedSessionToken(): Promise<string | null> {
  try {
    const raw = await readFile(getSharedAuthPath(), 'utf-8')
    const parsed = JSON.parse(raw) as PersistedAuthState
    const token = parsed?.session?.sessionToken?.trim()
    return token || null
  } catch {
    return null
  }
}

export async function resolveOpenAIKeyFromConvex(): Promise<string | null> {
  const token = (process.env.BOOST_API_TOKEN || '').trim() || (await readSharedSessionToken())
  if (!token) return null

  const response = await fetch(`${getBackendUrl()}/client/bootstrap`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`
    }
  })

  if (!response.ok) return null
  const payload = (await response.json()) as BootstrapResponse
  return payload?.apiKeys?.openaiApiKey?.trim() || null
}

export async function resolveOpenAIKey(): Promise<string | null> {
  const fromConvex = await resolveOpenAIKeyFromConvex()
  if (fromConvex) return fromConvex
  return process.env.OPENAI_API_KEY?.trim() || null
}

