import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'

type ExecutePayload = {
  input?: string
  cwd?: string
  resolution?: {
    picker?: string
    selectedId?: string
  }
  terminalContext?: {
    host?: string
    shell?: string
    termProgram?: string
    parentProcess?: string
    executeInCaller?: boolean
    currentPid?: string
  }
}

export type ExecuteResult = {
  ok: boolean
  command: string
  message: string
  data?: Record<string, unknown>
  requiresResolution?: boolean
  resolutionPicker?: string
  candidates?: Array<{
    id: string
    label: string
    command?: string
    cwd?: string
    source?: string
  }>
}

export class CommandServer {
  private server: Server | null = null

  constructor(
    private readonly onExecute: (
      input: string,
      cwd: string,
      context?: ExecutePayload['terminalContext'],
      resolution?: ExecutePayload['resolution']
    ) => Promise<ExecuteResult>,
    private readonly port = 45700
  ) {}

  async start(): Promise<void> {
    if (this.server) return

    this.server = createServer(async (req, res) => {
      await this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(this.port, '127.0.0.1', () => {
        this.server?.off('error', reject)
        console.log(`[Boost v2] Command server listening on http://127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const current = this.server
    this.server = null
    await new Promise<void>((resolve) => {
      current.close(() => resolve())
    })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/'
    if (req.method === 'GET' && url === '/health') {
      this.respondJson(res, 200, { ok: true, service: 'boost-v2-command-server' })
      return
    }

    if (req.method === 'POST' && url === '/execute') {
      const payload = await this.readJson<ExecutePayload>(req)
      const input = (payload?.input || '').trim()
      const cwd = (payload?.cwd || process.cwd()).trim()
      try {
        const result = await this.onExecute(input, cwd, payload?.terminalContext, payload?.resolution)
        this.respondJson(res, 200, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.respondJson(res, 500, {
          ok: false,
          command: 'unknown',
          message
        } satisfies ExecuteResult)
      }
      return
    }

    this.respondJson(res, 404, { ok: false, message: 'Not found' })
  }

  private async readJson<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => resolve())
      req.on('error', reject)
    })

    if (chunks.length === 0) return {} as T
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {} as T
    return JSON.parse(raw) as T
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }
}
