import crypto from 'node:crypto'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { APP_DISPLAY_NAME, APP_VERSION, OFFICIAL_MCP_URL, buildChildEnv, findAndClearTokenCache, type ToolResult } from './utils.js'
import type { BackendSpec } from './config.js'

/** Child-process adapter for the official Notion MCP backend, with automatic reconnect on failure. */
export class BackendClient {
  readonly name: string
  readonly spec: BackendSpec
  private client: Client
  private transport: StdioClientTransport
  tools: Tool[]
  private toolMap: Map<string, Tool>

  constructor(name: string, spec: BackendSpec) {
    this.name = name
    this.spec = spec
    this.client = new Client(
      { name: `${APP_DISPLAY_NAME}-${name}-client`, version: APP_VERSION },
      { capabilities: {} },
    )
    this.transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      stderr: 'inherit',
      env: buildChildEnv(spec.env),
    })
    this.tools = []
    this.toolMap = new Map()
  }

  /** Spawn the child process, connect via stdio, and discover available tools. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport)
    const listed = await this.client.listTools()
    this.tools = listed.tools || []
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]))
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

  /** Tear down the existing transport and re-establish the connection. */
  async reconnect(timeoutMs = 10_000): Promise<void> {
    console.error(`[${APP_DISPLAY_NAME}] reconnecting ${this.name} backend (timeout ${timeoutMs / 1000}s)...`)

    try {
      await this.transport.close()
    } catch {
      // ignore close errors
    }

    this.client = new Client(
      { name: `${APP_DISPLAY_NAME}-${this.name}-client`, version: APP_VERSION },
      { capabilities: {} },
    )
    this.transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args,
      cwd: this.spec.cwd,
      stderr: 'inherit',
      env: buildChildEnv(this.spec.env),
    })

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`reconnect timed out after ${timeoutMs / 1000}s`)), timeoutMs),
    )
    await Promise.race([this.client.connect(this.transport), timeout])

    const listed = await this.client.listTools()
    this.tools = listed.tools || []
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]))

    console.error(`[${APP_DISPLAY_NAME}] ${this.name} backend reconnected (${this.tools.length} tools)`)
  }

  /** Call a tool on the official backend; automatically reconnects once on failure. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    try {
      return await (this.client.callTool({ name, arguments: args }) as Promise<ToolResult>)
    } catch (firstError) {
      console.error(`[${APP_DISPLAY_NAME}] ${this.name} callTool failed, attempting reconnect...`)
      try {
        await this.reconnect()
      } catch (reconnectError) {
        throw new Error(
          `${this.name} backend call failed and reconnect also failed: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`,
        )
      }
      return this.client.callTool({ name, arguments: args }) as Promise<ToolResult>
    }
  }

  /** Force re-authentication: disconnect, clear token cache, reconnect. */
  async reauth(): Promise<{
    status: string
    message: string
    deletedFiles: number
    searchedDirs: string[]
  }> {
    console.error(`[${APP_DISPLAY_NAME}] reauth: disconnecting ${this.name} backend...`)

    // 1. Disconnect
    try {
      await this.transport.close()
    } catch {
      // ignore close errors
    }

    // 2. Compute URL hash from spec args (same logic as doctor.ts extractMcpRemoteHashContext)
    const serverUrl = this.extractServerUrl()
    const urlHash = crypto.createHash('md5').update(serverUrl).digest('hex')

    // 3. Clear token cache
    const cacheResult = findAndClearTokenCache(urlHash)
    console.error(
      `[${APP_DISPLAY_NAME}] reauth: cleared ${cacheResult.deletedFiles} token cache files for hash ${urlHash}`,
    )

    // 4. Reconnect with extended timeout for OAuth browser flow
    console.error(`[${APP_DISPLAY_NAME}] reauth: reconnecting (120s timeout for OAuth browser flow)...`)
    await this.reconnect(120_000)

    return {
      status: 'reauth_triggered',
      message: `OAuth tokens cleared (${cacheResult.deletedFiles} files). Backend reconnected with fresh credentials.`,
      ...cacheResult,
    }
  }

  private extractServerUrl(): string {
    // Extract the MCP URL from args, matching doctor.ts extractMcpRemoteHashContext logic
    const args = this.spec.args
    if (this.spec.command === 'node' && args.length >= 2) {
      return args[1] || OFFICIAL_MCP_URL
    }
    if (this.spec.command === 'npx') {
      const pkgIndex = args.findIndex((a) => a === 'mcp-remote')
      if (pkgIndex >= 0 && args[pkgIndex + 1]) {
        return args[pkgIndex + 1]
      }
    }
    return OFFICIAL_MCP_URL
  }

  async close(): Promise<void> {
    try {
      await this.transport.close()
    } catch {
      // ignore close errors
    }
  }
}
