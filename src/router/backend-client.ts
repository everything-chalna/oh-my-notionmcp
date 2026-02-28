import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

import { APP_DISPLAY_NAME, APP_VERSION, buildChildEnv, type ToolResult } from './utils.js'
import type { BackendSpec } from './config.js'

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

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.client.callTool({ name, arguments: args }) as Promise<ToolResult>
  }

  async close(): Promise<void> {
    try {
      await this.transport.close()
    } catch {
      // ignore close errors
    }
  }
}
