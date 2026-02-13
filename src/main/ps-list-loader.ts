import * as psListModule from 'ps-list'

type PsListFn = () => Promise<Array<{ name: string; pid: number; cmd?: string; cwd?: string }>>

export function getPsListFn(): PsListFn {
  const mod: any = psListModule as any

  if (typeof mod === 'function') return mod as PsListFn
  if (typeof mod?.default === 'function') return mod.default as PsListFn
  if (typeof mod?.default?.default === 'function') return mod.default.default as PsListFn

  throw new Error('Unable to resolve ps-list function export')
}

