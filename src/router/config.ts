import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  OFFICIAL_MCP_URL,
  npxFallbackAllowed,
  parseJsonObject,
  parseJsonStringArray,
  resolvePackageRoot,
} from './utils.js'

export interface BackendSpec {
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

export function resolveMcpRemoteProxyPath(): string | null {
  const packageRoot = resolvePackageRoot()
  const localProxy = path.resolve(packageRoot, 'node_modules/mcp-remote/dist/proxy.js')
  if (fs.existsSync(localProxy)) {
    return localProxy
  }
  return null
}

export function resolveOfficialBackendConfig(): BackendSpec {
  const localMcpRemoteProxy = resolveMcpRemoteProxyPath()
  const officialCommand = process.env.OHMY_NOTION_OFFICIAL_COMMAND || (localMcpRemoteProxy ? 'node' : 'npx')
  const officialArgsFromEnv = parseJsonStringArray(
    process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON,
    'OHMY_NOTION_OFFICIAL_ARGS_JSON',
  )
  const officialArgs =
    officialArgsFromEnv ||
    (localMcpRemoteProxy
      ? [localMcpRemoteProxy, OFFICIAL_MCP_URL, '--transport', 'http-first']
      : ['-y', 'mcp-remote', OFFICIAL_MCP_URL, '--transport', 'http-first'])
  const extraOfficialEnv = parseJsonObject(process.env.OHMY_NOTION_OFFICIAL_ENV_JSON, 'OHMY_NOTION_OFFICIAL_ENV_JSON')

  if (officialCommand === 'npx' && !npxFallbackAllowed()) {
    throw new Error(
      'npx fallback for official backend is disabled. Install mcp-remote locally or set OHMY_NOTION_ALLOW_NPX_FALLBACK=true',
    )
  }

  return {
    command: officialCommand,
    args: officialArgs,
    cwd: process.env.OHMY_NOTION_OFFICIAL_CWD,
    env: extraOfficialEnv,
  }
}
