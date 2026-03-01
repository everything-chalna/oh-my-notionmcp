import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { initProxy } from '../fast/init-server.js'
import { BackendClient } from './backend-client.js'
import type { BackendSpec } from './config.js'
import {
  APP_DISPLAY_NAME,
  APP_VERSION,
  extractUuidish,
  isErrorToolResult,
  looksAuthError,
  looksEmptyReadResult,
  looksReadTool,
  looksWriteTool,
  normalizeToolName,
  toToolError,
  type ToolResult,
} from './utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const REAUTH_TOOL_NAME = 'oh-my-notionmcp-reauth'

const META_TOOLS: Tool[] = [
  {
    name: REAUTH_TOOL_NAME,
    description:
      'Force re-authentication of the official Notion MCP OAuth token. ' +
      'Clears cached OAuth tokens, disconnects, and reconnects with fresh credentials. ' +
      'Use when: token expired, need to switch accounts, or getting persistent auth errors.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

/** Common interface for both fast (in-process) and official (child-process) backends. */
export interface BackendAdapter {
  tools: Tool[]
  hasTool(name: string): boolean
  findToolName(candidates: string[]): string | undefined
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
}

/** In-process adapter wrapping MCPProxy via an in-memory MCP transport pair. */
export class FastBackendAdapter implements BackendAdapter {
  private client: Client
  private clientTransport: InMemoryTransport
  private serverTransport: InMemoryTransport
  tools: Tool[]
  private toolMap: Map<string, Tool>

  private constructor(
    client: Client,
    clientTransport: InMemoryTransport,
    serverTransport: InMemoryTransport,
  ) {
    this.client = client
    this.clientTransport = clientTransport
    this.serverTransport = serverTransport
    this.tools = []
    this.toolMap = new Map()
  }

  static async create(specPath: string): Promise<FastBackendAdapter> {
    const proxy = await initProxy(specPath, undefined)
    const server = proxy.getServer()

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    const client = new Client(
      { name: `${APP_DISPLAY_NAME}-fast-inproc-client`, version: APP_VERSION },
      { capabilities: {} },
    )

    // Connect server side first, then client side
    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const adapter = new FastBackendAdapter(client, clientTransport, serverTransport)
    const listed = await client.listTools()
    adapter.tools = listed.tools || []
    adapter.toolMap = new Map(adapter.tools.map((tool) => [tool.name, tool]))

    return adapter
  }

  hasTool(name: string): boolean {
    return this.toolMap.has(name)
  }

  findToolName(candidates: string[]): string | undefined {
    for (const candidate of candidates) {
      if (this.toolMap.has(candidate)) {
        return candidate
      }
    }
    return undefined
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.client.callTool({ name, arguments: args }) as Promise<ToolResult>
  }

  async close(): Promise<void> {
    try {
      await this.clientTransport.close()
    } catch {
      // ignore
    }
    try {
      await this.serverTransport.close()
    } catch {
      // ignore
    }
  }
}

export interface RouteEntry {
  mode: 'official' | 'fast-only' | 'official-with-fast-boost' | 'fast-then-official-same-name'
  toolName: string
}

/** Main router that merges fast (in-process) and official (child-process) backends behind a single MCP server. */
export class OhMyNotionRouter {
  private officialSpec: BackendSpec
  private server: Server
  fast: BackendAdapter | null
  official: BackendAdapter | null
  exposedTools: Tool[]
  routes: Map<string, RouteEntry>

  constructor({ fastBackend: _fastBackend, officialBackend }: { fastBackend?: Partial<BackendSpec>; officialBackend: Partial<BackendSpec> }) {
    this.officialSpec = officialBackend as BackendSpec
    this.server = new Server({ name: APP_DISPLAY_NAME, version: APP_VERSION }, { capabilities: { tools: {} } })

    this.fast = null
    this.official = null
    this.exposedTools = []
    this.routes = new Map()
  }

  /** Connect both backends, build routing table, and begin serving over stdio. */
  async start(): Promise<void> {
    const backendErrors: string[] = []

    const [fastResult, officialResult] = await Promise.allSettled([this.connectFast(), this.connectOfficial()])

    if (fastResult.status === 'rejected') {
      backendErrors.push(
        `fast backend unavailable: ${fastResult.reason instanceof Error ? fastResult.reason.message : String(fastResult.reason)}`,
      )
      this.fast = null
    } else {
      this.fast = fastResult.value
    }

    if (officialResult.status === 'rejected') {
      backendErrors.push(
        `official backend unavailable: ${officialResult.reason instanceof Error ? officialResult.reason.message : String(officialResult.reason)}`,
      )
      this.official = null
    } else {
      this.official = officialResult.value
    }

    if (!this.fast && !this.official) {
      throw new Error(`No backend available. ${backendErrors.join(' | ')}`)
    }

    if (backendErrors.length > 0) {
      console.error(`[${APP_DISPLAY_NAME}] WARN: running in degraded mode`)
      for (const line of backendErrors) {
        console.error(`[${APP_DISPLAY_NAME}] WARN: ${line}`)
      }
    }

    this.buildRoutingTable()
    this.setupHandlers()

    const transport = new StdioServerTransport()
    await this.server.connect(transport)

    process.on('SIGINT', async () => {
      await this.shutdown()
      process.exit(0)
    })
    process.on('SIGTERM', async () => {
      await this.shutdown()
      process.exit(0)
    })
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.fast?.close(), this.official?.close()])
  }

  private async connectFast(): Promise<FastBackendAdapter> {
    const specPath = path.resolve(__dirname, '../scripts/notion-openapi.json')
    return FastBackendAdapter.create(specPath)
  }

  private async connectOfficial(): Promise<BackendClient> {
    const client = new BackendClient('official', this.officialSpec)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('official backend connect timed out after 30s')), 30_000),
    )
    await Promise.race([client.connect(), timeout])
    return client
  }

  /** Build the tool routing table from the union of fast and official tool sets. */
  buildRoutingTable(): void {
    const officialTools = this.official ? this.official.tools : []
    const fastTools = this.fast ? this.fast.tools : []

    const officialByName = new Map(officialTools.map((tool) => [tool.name, tool]))
    const fastByName = new Map(fastTools.map((tool) => [tool.name, tool]))

    // Contract-first routing:
    // - when official backend exists, only expose official tools
    // - fast backend can accelerate reads for official tools, but does not add extra tool surface
    // - when official backend is unavailable, degrade to fast-only tool surface
    const allNames = this.official
      ? new Set(officialByName.keys())
      : new Set([...fastByName.keys()].filter((toolName) => looksReadTool(toolName) && !looksWriteTool(toolName)))
    const exposed: Tool[] = []

    for (const toolName of allNames) {
      const officialTool = officialByName.get(toolName)
      const fastTool = fastByName.get(toolName)

      if (officialTool) {
        exposed.push(officialTool)
      } else if (fastTool) {
        exposed.push(fastTool)
      }

      const normalized = normalizeToolName(toolName)
      const boostableOfficialRead = normalized === 'fetch' || normalized === 'search' || normalized === 'get-users'

      if (officialTool && !fastTool) {
        this.routes.set(toolName, {
          mode: boostableOfficialRead ? 'official-with-fast-boost' : 'official',
          toolName,
        })
        continue
      }

      if (!officialTool && fastTool) {
        this.routes.set(toolName, {
          mode: 'fast-only',
          toolName,
        })
        continue
      }

      if (officialTool && fastTool) {
        if (looksReadTool(toolName) && !looksWriteTool(toolName)) {
          this.routes.set(toolName, {
            mode: 'fast-then-official-same-name',
            toolName,
          })
        } else {
          this.routes.set(toolName, {
            mode: 'official',
            toolName,
          })
        }
      }
    }

    this.exposedTools = exposed
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: [...this.exposedTools, ...META_TOOLS] }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      const args = (request.params.arguments || {}) as Record<string, unknown>

      // Handle meta tools first
      if (toolName === REAUTH_TOOL_NAME) {
        return this.handleReauth()
      }

      const route = this.routes.get(toolName)

      if (!route) {
        return toToolError(`Unknown tool: ${toolName}`)
      }

      if (route.mode === 'official') {
        return this.callOfficialOrError(toolName, args)
      }

      if (route.mode === 'fast-only') {
        return this.callFastOrError(toolName, args)
      }

      if (route.mode === 'official-with-fast-boost') {
        const boosted = await this.tryOfficialReadBoost(toolName, args)
        if (boosted && !isErrorToolResult(boosted) && !looksEmptyReadResult(boosted)) {
          return boosted
        }
        return this.callOfficialOrError(toolName, args)
      }

      if (route.mode === 'fast-then-official-same-name') {
        const fastResult = await this.callFastOrError(toolName, args)
        if (!isErrorToolResult(fastResult) && !looksEmptyReadResult(fastResult)) {
          return fastResult
        }
        if (this.official && this.official.hasTool(toolName)) {
          const officialResult = await this.callOfficialOrError(toolName, args)
          return officialResult
        }
        return fastResult
      }

      return toToolError(`Unhandled route mode for tool: ${toolName}`)
    })
  }

  async callFastOrError(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.fast) {
      return toToolError('fast backend is unavailable')
    }
    try {
      return await this.fast.callTool(toolName, args)
    } catch (error) {
      return toToolError('fast backend call failed', {
        tool: toolName,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async callOfficialOrError(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.official) {
      return toToolError('official backend is unavailable')
    }
    try {
      return await this.official.callTool(toolName, args)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const hint = looksAuthError(reason) ? '. Token may be expired — try `oh-my-notionmcp login`' : ''
      return toToolError('official backend call failed' + hint, {
        tool: toolName,
        reason,
      })
    }
  }

  private async handleReauth(): Promise<ToolResult> {
    if (!this.official) {
      return toToolError('Cannot reauth: official backend is not connected. Run `oh-my-notionmcp login` first.')
    }

    try {
      // BackendClient (not BackendAdapter) has reauth()
      if (!('reauth' in this.official)) {
        return toToolError('Cannot reauth: official backend does not support reauth')
      }
      const result = await (this.official as BackendClient).reauth()

      // Rebuild routing table with potentially refreshed tools
      this.buildRoutingTable()

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: result.status,
              message: result.message,
              deletedFiles: result.deletedFiles,
              searchedDirs: result.searchedDirs,
              toolCount: this.official.tools.length,
            }),
          },
        ],
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const hint = looksAuthError(reason) ? ' You may need to run `oh-my-notionmcp login` to complete OAuth.' : ''
      return toToolError(`Reauth failed: ${reason}${hint}`)
    }
  }

  private async tryOfficialReadBoost(toolName: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    if (!this.fast) return null

    const normalized = normalizeToolName(toolName)
    if (normalized === 'search') {
      return this.tryFastSearch(args)
    }
    if (normalized === 'get-users') {
      return this.tryFastGetUsers(args)
    }
    if (normalized === 'fetch') {
      return this.tryFastFetch(args)
    }

    return null
  }

  private async tryFastSearch(args: Record<string, unknown>): Promise<ToolResult | null> {
    const toolName = this.fast!.findToolName(['API-post-search', 'post-search'])
    if (!toolName) return null
    return this.callFastOrError(toolName, args)
  }

  async tryFastGetUsers(args: Record<string, unknown>): Promise<ToolResult | null> {
    const safeArgs = typeof args === 'object' && args !== null ? args : {}

    if (typeof safeArgs.user_id === 'string' && (safeArgs.user_id as string).length > 0) {
      const single = this.fast!.findToolName(['API-get-user', 'get-user'])
      if (!single) return null
      return this.callFastOrError(single, safeArgs)
    }

    const many = this.fast!.findToolName(['API-get-users', 'get-users'])
    if (!many) return null
    return this.callFastOrError(many, safeArgs)
  }

  async tryFastFetch(args: Record<string, unknown>): Promise<ToolResult | null> {
    if (!args || typeof args !== 'object' || typeof args.id !== 'string') {
      return null
    }

    const extraKeys = Object.keys(args).filter((key) => key !== 'id')
    if (extraKeys.length > 0) {
      // Preserve official fetch semantics for advanced options.
      return null
    }

    const rawId = args.id as string
    const normalizedId = rawId.startsWith('collection://') ? rawId.slice('collection://'.length) : extractUuidish(rawId)

    const candidates: Array<{ toolNames: string[]; toolArgs: Record<string, string> }> = [
      {
        toolNames: ['API-retrieve-a-page', 'retrieve-a-page'],
        toolArgs: { page_id: normalizedId },
      },
      {
        toolNames: ['API-retrieve-a-database', 'retrieve-a-database'],
        toolArgs: { database_id: normalizedId },
      },
      {
        toolNames: ['API-retrieve-a-data-source', 'retrieve-a-data-source'],
        toolArgs: { data_source_id: normalizedId },
      },
      {
        toolNames: ['API-retrieve-a-block', 'retrieve-a-block'],
        toolArgs: { block_id: normalizedId },
      },
      {
        toolNames: ['API-retrieve-a-comment', 'retrieve-a-comment'],
        toolArgs: { comment_id: normalizedId },
      },
    ]

    let lastError: ToolResult | null = null
    for (const candidate of candidates) {
      const found = this.fast!.findToolName(candidate.toolNames)
      if (!found) continue
      const result = await this.callFastOrError(found, candidate.toolArgs)
      if (!isErrorToolResult(result)) {
        return result
      }
      lastError = result
    }

    return lastError
  }
}
