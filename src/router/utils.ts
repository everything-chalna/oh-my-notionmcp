import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export const APP_DISPLAY_NAME = 'oh-my-NotionMCP'
export const APP_BIN_NAME = 'oh-my-notionmcp'
export const APP_VERSION = '0.1.0'

export const OFFICIAL_MCP_URL = 'https://mcp.notion.com/mcp'
export const DEFAULT_ROUTER_SERVER_NAME = 'notion'

export const SAFE_CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TERM',
  'SYSTEMROOT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'MCP_REMOTE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

export const READ_HINT_PATTERNS = ['fetch', 'search', 'query', 'retrieve', 'read', 'get', 'list']
export const WRITE_HINT_PATTERNS = ['create', 'update', 'delete', 'move', 'patch', 'append', 'insert', 'comment']

export interface ParsedOptions {
  [key: string]: string | boolean
}

export function parseArgs(argv: string[]): ParsedOptions {
  const options: ParsedOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      options[key] = next
      i += 1
      continue
    }
    options[key] = true
  }
  return options
}

export function resolveProjectDir(options: ParsedOptions): string {
  const requested = typeof options.project === 'string' ? options.project : process.cwd()
  return path.resolve(requested)
}

export function resolveMcpPath(projectDir: string): string {
  return path.join(projectDir, '.mcp.json')
}

export function parseJsonObject(value: string | undefined, label: string): Record<string, string> {
  if (value === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error instanceof Error && error.message) || String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    out[k] = String(v)
  }
  return out
}

export function parseJsonStringArray(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error instanceof Error && error.message) || String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`)
  }
  return parsed.map((entry) => String(entry))
}

export function parseBool(value: string): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

export function npxFallbackAllowed(): boolean {
  return parseBool(String(process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK || '').toLowerCase())
}

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/^notion[-_:]/, '')
}

export function looksReadTool(name: string): boolean {
  const normalized = normalizeToolName(name)
  return READ_HINT_PATTERNS.some((pattern) => normalized.includes(pattern))
}

export function looksWriteTool(name: string): boolean {
  const normalized = normalizeToolName(name)
  return WRITE_HINT_PATTERNS.some((pattern) => normalized.includes(pattern))
}

export interface ToolResult {
  [key: string]: unknown
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

export function isErrorToolResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as ToolResult).isError === true)
}

export function toToolError(message: string, data: Record<string, unknown> = {}): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ status: 'error', message, ...data }),
      },
    ],
    isError: true,
  }
}

export function maybeParseResultJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const r = result as ToolResult
  if (!Array.isArray(r.content)) return null
  for (const item of r.content) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue
    try {
      return JSON.parse(item.text) as Record<string, unknown>
    } catch {
      // not JSON
    }
  }
  return null
}

export function looksEmptyReadResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || (result as ToolResult).isError === true) {
    return false
  }
  const parsed = maybeParseResultJson(result)
  if (!parsed || typeof parsed !== 'object') return false

  if (Array.isArray(parsed.results) && parsed.results.length === 0) return true
  if (Array.isArray(parsed.users) && parsed.users.length === 0) return true
  if (Array.isArray(parsed.items) && parsed.items.length === 0) return true
  return false
}

export function extractUuidish(idOrUrl: string): string {
  const input = String(idOrUrl)
  const noDash = input.match(/[0-9a-fA-F]{32}/)
  if (noDash) return noDash[0]
  const withDash = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (withDash) return withDash[0]
  return input
}

export interface McpConfig {
  mcpServers: Record<string, unknown>
  [key: string]: unknown
}

export function loadMcpConfig(mcpPath: string): McpConfig {
  if (!fs.existsSync(mcpPath)) {
    return { mcpServers: {} }
  }
  const raw = fs.readFileSync(mcpPath, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${mcpPath}: ${(error instanceof Error && error.message) || String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid .mcp.json at ${mcpPath}: root must be an object`)
  }
  const config = parsed as McpConfig
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {}
  }
  return config
}

export function saveMcpConfig(mcpPath: string, config: McpConfig): void {
  fs.writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export function resolveBinPath(): string {
  return fileURLToPath(import.meta.url)
}

export function resolvePackageRoot(): string {
  return path.resolve(path.dirname(resolveBinPath()), '..')
}

export function childBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      out[key] = String(process.env[key])
    }
  }
  return out
}

export function buildChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...childBaseEnv(),
    ...extra,
  }
}

export function sensitiveEnvKey(key: string): boolean {
  const normalized = String(key || '').toUpperCase()
  return (
    normalized.includes('TOKEN') ||
    normalized.includes('SECRET') ||
    normalized.includes('PASSWORD') ||
    normalized.includes('AUTH') ||
    normalized.endsWith('_KEY') ||
    normalized.includes('PRIVATE')
  )
}

export function sanitizePersistedEnv(envObj: Record<string, string> | undefined): {
  sanitized: Record<string, string>
  redactedKeys: string[]
} {
  const sanitized: Record<string, string> = {}
  const redactedKeys: string[] = []
  for (const [key, value] of Object.entries(envObj || {})) {
    if (sensitiveEnvKey(key)) {
      redactedKeys.push(key)
      continue
    }
    sanitized[key] = String(value)
  }
  return { sanitized, redactedKeys }
}

export interface RunCommandOptions {
  cwd?: string
  stdio?: 'pipe' | 'inherit'
  env?: Record<string, string>
}

export function runCommand(
  command: string,
  args: string[],
  opts: RunCommandOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: opts.stdio || 'pipe',
    encoding: 'utf8',
    env: opts.env || buildChildEnv(),
  })
}

export function printHelp(): void {
  console.log(`${APP_DISPLAY_NAME}

Usage:
  ${APP_BIN_NAME} serve
  ${APP_BIN_NAME} install [--project <dir>] [--name <mcp-server-name>]
  ${APP_BIN_NAME} login
  ${APP_BIN_NAME} doctor [--project <dir>] [--name <mcp-server-name>] [--allow-missing-auth]

Commands:
  serve    Start router MCP server (stdio)
           read: local notion cache -> official MCP fallback
           write: official MCP

  install  Add/update router entry in project .mcp.json
           default server name: ${DEFAULT_ROUTER_SERVER_NAME}

  login    Start official MCP OAuth flow via mcp-remote
           Complete browser auth, then Ctrl+C after "Proxy established"

  doctor   Validate config and auth readiness

Environment Overrides:
  OHMY_NOTION_ALLOW_NPX_FALLBACK

  OHMY_NOTION_OFFICIAL_COMMAND
  OHMY_NOTION_OFFICIAL_ARGS_JSON
  OHMY_NOTION_OFFICIAL_ENV_JSON
  OHMY_NOTION_OFFICIAL_CWD

Examples:
  ${APP_BIN_NAME} install --project /path/to/project --name notion
  ${APP_BIN_NAME} login
  ${APP_BIN_NAME} serve
  ${APP_BIN_NAME} doctor --project /path/to/project
`)
}
