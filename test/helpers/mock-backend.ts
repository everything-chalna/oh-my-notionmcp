import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { BackendAdapter } from '../../src/router/router.js'
import type { ToolResult } from '../../src/router/utils.js'

export interface MockBackendOptions {
  tools?: Array<{ name: string; [key: string]: unknown }>
  callToolImpl?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

export function createMockBackend(options: MockBackendOptions = {}): BackendAdapter {
  const tools = (options.tools || []) as Tool[]
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  return {
    tools,
    hasTool(name: string) {
      return toolMap.has(name)
    },
    findToolName(candidates: string[]) {
      for (const c of candidates) {
        if (toolMap.has(c)) return c
      }
      return undefined
    },
    callTool: options.callToolImpl ?? (async () => ({ content: [], isError: false })),
    close: async () => {},
  }
}
