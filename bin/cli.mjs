#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const APP_DISPLAY_NAME = 'oh-my-NotionMCP'
const APP_BIN_NAME = 'oh-my-notionmcp'
const APP_VERSION = '0.1.0'

const OFFICIAL_MCP_URL = 'https://mcp.notion.com/mcp'
const DEFAULT_ROUTER_SERVER_NAME = 'notion'

const DEFAULT_FAST_LOCAL_ENV = {
  NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED: 'true',
  NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED: 'true',
}

const SAFE_CHILD_ENV_KEYS = [
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
]

const READ_HINT_PATTERNS = ['fetch', 'search', 'query', 'retrieve', 'read', 'get', 'list']
const WRITE_HINT_PATTERNS = ['create', 'update', 'delete', 'move', 'patch', 'append', 'insert', 'comment']

function printHelp() {
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

  OHMY_NOTION_FAST_COMMAND
  OHMY_NOTION_FAST_ARGS_JSON
  OHMY_NOTION_FAST_ENV_JSON
  OHMY_NOTION_FAST_CWD

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

function parseArgs(argv) {
  const options = {}
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

function resolveProjectDir(options) {
  const requested = typeof options.project === 'string' ? options.project : process.cwd()
  return path.resolve(requested)
}

function resolveMcpPath(projectDir) {
  return path.join(projectDir, '.mcp.json')
}

function parseJsonObject(value, label) {
  if (value === undefined) return {}
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${(error instanceof Error && error.message) || String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`)
  }
  const out = {}
  for (const [k, v] of Object.entries(parsed)) {
    out[k] = String(v)
  }
  return out
}

function parseJsonStringArray(value, label) {
  if (value === undefined) return undefined
  let parsed
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

function parseBool(value) {
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function npxFallbackAllowed() {
  return parseBool(String(process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK || '').toLowerCase())
}

function normalizeToolName(name) {
  return name.toLowerCase().replace(/^notion[-_:]/, '')
}

function looksReadTool(name) {
  const normalized = normalizeToolName(name)
  return READ_HINT_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function looksWriteTool(name) {
  const normalized = normalizeToolName(name)
  return WRITE_HINT_PATTERNS.some((pattern) => normalized.includes(pattern))
}

function isErrorToolResult(result) {
  return Boolean(result && typeof result === 'object' && result.isError === true)
}

function toToolError(message, data = {}) {
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

function maybeParseResultJson(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return null
  for (const item of result.content) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue
    try {
      return JSON.parse(item.text)
    } catch {
      // not JSON
    }
  }
  return null
}

function looksEmptyReadResult(result) {
  if (!result || typeof result !== 'object' || result.isError === true) {
    return false
  }
  const parsed = maybeParseResultJson(result)
  if (!parsed || typeof parsed !== 'object') return false

  if (Array.isArray(parsed.results) && parsed.results.length === 0) return true
  if (Array.isArray(parsed.users) && parsed.users.length === 0) return true
  if (Array.isArray(parsed.items) && parsed.items.length === 0) return true
  return false
}

function extractUuidish(idOrUrl) {
  const input = String(idOrUrl)
  const noDash = input.match(/[0-9a-fA-F]{32}/)
  if (noDash) return noDash[0]
  const withDash = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (withDash) return withDash[0]
  return input
}

function loadMcpConfig(mcpPath) {
  if (!fs.existsSync(mcpPath)) {
    return { mcpServers: {} }
  }
  const raw = fs.readFileSync(mcpPath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in ${mcpPath}: ${(error instanceof Error && error.message) || String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid .mcp.json at ${mcpPath}: root must be an object`)
  }
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    parsed.mcpServers = {}
  }
  return parsed
}

function saveMcpConfig(mcpPath, config) {
  fs.writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function resolveBinPath() {
  return fileURLToPath(import.meta.url)
}

function resolvePackageRoot() {
  return path.resolve(path.dirname(resolveBinPath()), '..')
}

function resolveFastBinPath() {
  const packageRoot = resolvePackageRoot()
  const bundledFastBin = path.resolve(packageRoot, 'node_modules/notion-mcp-fast/bin/cli.mjs')
  if (fs.existsSync(bundledFastBin)) {
    return bundledFastBin
  }
  const siblingFastBin = path.resolve(packageRoot, '../notion-mcp-fast/bin/cli.mjs')
  if (fs.existsSync(siblingFastBin)) {
    return siblingFastBin
  }
  return null
}

function resolveMcpRemoteProxyPath() {
  const packageRoot = resolvePackageRoot()
  const localProxy = path.resolve(packageRoot, 'node_modules/mcp-remote/dist/proxy.js')
  if (fs.existsSync(localProxy)) {
    return localProxy
  }
  return null
}

function childBaseEnv() {
  const out = {}
  for (const key of SAFE_CHILD_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      out[key] = String(process.env[key])
    }
  }
  return out
}

function buildChildEnv(extra = {}) {
  return {
    ...childBaseEnv(),
    ...extra,
  }
}

function resolveFastBackendConfig(options = {}) {
  const fastCommand =
    process.env.OHMY_NOTION_FAST_COMMAND ||
    (() => {
      const localFastBin = resolveFastBinPath()
      return localFastBin ? 'node' : 'npx'
    })()

  const fastArgsFromEnv = parseJsonStringArray(process.env.OHMY_NOTION_FAST_ARGS_JSON, 'OHMY_NOTION_FAST_ARGS_JSON')
  const fastArgs =
    fastArgsFromEnv ||
    (() => {
      const localFastBin = resolveFastBinPath()
      if (localFastBin) return [localFastBin]
      return ['-y', 'notion-mcp-fast']
    })()

  const extraFastEnv = parseJsonObject(process.env.OHMY_NOTION_FAST_ENV_JSON, 'OHMY_NOTION_FAST_ENV_JSON')
  const combinedFastEnv = {
    ...DEFAULT_FAST_LOCAL_ENV,
    ...extraFastEnv,
  }

  if (typeof options.fastToken === 'string' && options.fastToken.length > 0) {
    combinedFastEnv.NOTION_TOKEN = options.fastToken
  }

  if (fastCommand === 'npx' && !npxFallbackAllowed()) {
    throw new Error(
      'npx fallback for fast backend is disabled. Install notion-mcp-fast locally or set OHMY_NOTION_ALLOW_NPX_FALLBACK=true',
    )
  }

  return {
    command: fastCommand,
    args: fastArgs,
    cwd: process.env.OHMY_NOTION_FAST_CWD,
    env: combinedFastEnv,
  }
}

function resolveOfficialBackendConfig() {
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

function sensitiveEnvKey(key) {
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

function sanitizePersistedEnv(envObj) {
  const sanitized = {}
  const redactedKeys = []
  for (const [key, value] of Object.entries(envObj || {})) {
    if (sensitiveEnvKey(key)) {
      redactedKeys.push(key)
      continue
    }
    sanitized[key] = String(value)
  }
  return { sanitized, redactedKeys }
}

function runCommand(command, args, opts = {}) {
  return spawnSync(command, args, {
    cwd: opts.cwd,
    stdio: opts.stdio || 'pipe',
    encoding: 'utf8',
    env: opts.env || buildChildEnv(),
  })
}

class BackendClient {
  constructor(name, spec) {
    this.name = name
    this.spec = spec
    this.client = new Client({ name: `${APP_DISPLAY_NAME}-${name}-client`, version: APP_VERSION }, { capabilities: {} })
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

  async connect() {
    await this.client.connect(this.transport)
    const listed = await this.client.listTools()
    this.tools = listed.tools || []
    this.toolMap = new Map(this.tools.map((tool) => [tool.name, tool]))
  }

  hasTool(name) {
    return this.toolMap.has(name)
  }

  findToolName(candidates) {
    for (const candidate of candidates) {
      if (this.toolMap.has(candidate)) {
        return candidate
      }
    }
    return undefined
  }

  async callTool(name, args = {}) {
    return this.client.callTool({ name, arguments: args })
  }

  async close() {
    try {
      await this.transport.close()
    } catch {
      // ignore close errors
    }
  }
}

class OhMyNotionRouter {
  constructor({ fastBackend, officialBackend }) {
    this.fastSpec = fastBackend
    this.officialSpec = officialBackend
    this.server = new Server({ name: APP_DISPLAY_NAME, version: APP_VERSION }, { capabilities: { tools: {} } })

    this.fast = null
    this.official = null
    this.exposedTools = []
    this.routes = new Map()
  }

  async start() {
    const backendErrors = []

    const [fastResult, officialResult] = await Promise.allSettled([this.connectFast(), this.connectOfficial()])

    if (fastResult.status === 'rejected') {
      backendErrors.push(`fast backend unavailable: ${fastResult.reason instanceof Error ? fastResult.reason.message : String(fastResult.reason)}`)
      this.fast = null
    } else {
      this.fast = fastResult.value
    }

    if (officialResult.status === 'rejected') {
      backendErrors.push(`official backend unavailable: ${officialResult.reason instanceof Error ? officialResult.reason.message : String(officialResult.reason)}`)
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

  async shutdown() {
    await Promise.all([this.fast?.close(), this.official?.close()])
  }

  async connectFast() {
    const client = new BackendClient('fast', this.fastSpec)
    await client.connect()
    return client
  }

  async connectOfficial() {
    const client = new BackendClient('official', this.officialSpec)
    await client.connect()
    return client
  }

  buildRoutingTable() {
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
    const exposed = []

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

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.exposedTools }
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name
      const args = request.params.arguments || {}
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

  async callFastOrError(toolName, args) {
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

  async callOfficialOrError(toolName, args) {
    if (!this.official) {
      return toToolError('official backend is unavailable')
    }
    try {
      return await this.official.callTool(toolName, args)
    } catch (error) {
      return toToolError('official backend call failed', {
        tool: toolName,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async tryOfficialReadBoost(toolName, args) {
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

  async tryFastSearch(args) {
    const toolName = this.fast.findToolName(['API-post-search', 'post-search'])
    if (!toolName) return null
    return this.callFastOrError(toolName, args)
  }

  async tryFastGetUsers(args) {
    const safeArgs = typeof args === 'object' && args !== null ? args : {}

    if (typeof safeArgs.user_id === 'string' && safeArgs.user_id.length > 0) {
      const single = this.fast.findToolName(['API-get-user', 'get-user'])
      if (!single) return null
      return this.callFastOrError(single, safeArgs)
    }

    const many = this.fast.findToolName(['API-get-users', 'get-users'])
    if (!many) return null
    return this.callFastOrError(many, safeArgs)
  }

  async tryFastFetch(args) {
    if (!args || typeof args !== 'object' || typeof args.id !== 'string') {
      return null
    }

    const extraKeys = Object.keys(args).filter((key) => key !== 'id')
    if (extraKeys.length > 0) {
      // Preserve official fetch semantics for advanced options.
      return null
    }

    const rawId = args.id
    const normalizedId = rawId.startsWith('collection://') ? rawId.slice('collection://'.length) : extractUuidish(rawId)

    const candidates = [
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

    let lastError = null
    for (const candidate of candidates) {
      const found = this.fast.findToolName(candidate.toolNames)
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

function commandInstall(options) {
  const projectDir = resolveProjectDir(options)
  const mcpPath = resolveMcpPath(projectDir)
  const serverName = typeof options.name === 'string' ? options.name : DEFAULT_ROUTER_SERVER_NAME

  if (options['fast-token']) {
    throw new Error(
      '--fast-token is disabled for security. Use OHMY_NOTION_FAST_ENV_JSON at runtime instead of persisting secrets in .mcp.json',
    )
  }

  const config = loadMcpConfig(mcpPath)

  const selfBin = resolveBinPath()
  const fastBackend = resolveFastBackendConfig()
  const officialBackend = resolveOfficialBackendConfig()
  const { sanitized: persistedFastEnv, redactedKeys: redactedFastKeys } = sanitizePersistedEnv(fastBackend.env)
  const { sanitized: persistedOfficialEnv, redactedKeys: redactedOfficialKeys } = sanitizePersistedEnv(officialBackend.env)

  const entry = {
    command: 'node',
    args: [selfBin, 'serve'],
    env: {
      OHMY_NOTION_FAST_COMMAND: fastBackend.command,
      OHMY_NOTION_FAST_ARGS_JSON: JSON.stringify(fastBackend.args),
      OHMY_NOTION_FAST_ENV_JSON: JSON.stringify(persistedFastEnv),
      OHMY_NOTION_OFFICIAL_COMMAND: officialBackend.command,
      OHMY_NOTION_OFFICIAL_ARGS_JSON: JSON.stringify(officialBackend.args),
      OHMY_NOTION_OFFICIAL_ENV_JSON: JSON.stringify(persistedOfficialEnv),
    },
  }

  if (fastBackend.cwd) {
    entry.env.OHMY_NOTION_FAST_CWD = fastBackend.cwd
  }
  if (officialBackend.cwd) {
    entry.env.OHMY_NOTION_OFFICIAL_CWD = officialBackend.cwd
  }

  config.mcpServers[serverName] = entry
  saveMcpConfig(mcpPath, config)

  console.log(`Updated ${mcpPath}`)
  console.log(`- Added/updated router server: ${serverName}`)
  console.log(`- Command: node ${selfBin} serve`)
  if (redactedFastKeys.length > 0 || redactedOfficialKeys.length > 0) {
    const all = [...redactedFastKeys, ...redactedOfficialKeys]
    console.log(`- Security: redacted sensitive env keys from persisted config: ${all.join(', ')}`)
  }
  console.log('')
  console.log('Next steps:')
  console.log(`1) ${APP_BIN_NAME} login`)
  console.log(`2) ${APP_BIN_NAME} doctor --project ${projectDir} --name ${serverName}`)
}

function commandLogin() {
  const official = resolveOfficialBackendConfig()
  console.log('Starting official MCP OAuth bootstrap via mcp-remote...')
  console.log('Complete browser authentication, then press Ctrl+C after "Proxy established".')
  const result = runCommand(official.command, official.args, {
    cwd: official.cwd,
    stdio: 'inherit',
    env: buildChildEnv(official.env),
  })

  if (result.error) {
    throw new Error(`login failed: ${(result.error && result.error.message) || String(result.error)}`)
  }

  const interrupted = result.signal === 'SIGINT' || result.status === 130
  if (result.status !== 0 && !interrupted) {
    const signalSuffix = result.signal ? ` signal=${result.signal}` : ''
    throw new Error(`login failed: exit=${result.status}${signalSuffix}`)
  }
}

function getMcpRemoteServerHash() {
  return crypto.createHash('md5').update(OFFICIAL_MCP_URL).digest('hex')
}

function looksLikeTokenPayload(raw) {
  if (!raw || typeof raw !== 'object') return false
  return (
    typeof raw.access_token === 'string' &&
    raw.access_token.length > 0 &&
    (typeof raw.refresh_token === 'string' || typeof raw.expires_in === 'number')
  )
}

function tokenFileIsUsable(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return looksLikeTokenPayload(raw)
  } catch {
    return false
  }
}

function hashForMcpRemoteContext(serverUrl, authorizeResource = '', headers = []) {
  return crypto.createHash('md5').update(`${serverUrl}${authorizeResource}${JSON.stringify(headers)}`).digest('hex')
}

function extractMcpRemoteHashContext(command, args = []) {
  const list = Array.isArray(args) ? args : []
  let url = OFFICIAL_MCP_URL
  if (command === 'node' && list.length >= 2) {
    url = list[1] || url
  } else if (command === 'npx') {
    const pkgIndex = list.findIndex((entry) => entry === 'mcp-remote')
    if (pkgIndex >= 0 && typeof list[pkgIndex + 1] === 'string') {
      url = list[pkgIndex + 1]
    }
  }

  let authorizeResource = ''
  const headers = []
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '--authorize-resource' && typeof list[i + 1] === 'string') {
      authorizeResource = list[i + 1]
      i += 1
      continue
    }
    if (list[i] === '--header' && typeof list[i + 1] === 'string') {
      headers.push(list[i + 1])
      i += 1
    }
  }

  return { serverUrl: url, authorizeResource, headers }
}

function findMcpRemoteTokenFile(serverHash) {
  const baseDir = process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth')
  if (!fs.existsSync(baseDir)) {
    return null
  }

  const candidates = []
  const directPath = path.join(baseDir, serverHash, 'tokens.json')
  candidates.push(directPath)

  let versionDirs = []
  try {
    versionDirs = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('mcp-remote-'))
      .map((entry) => path.join(baseDir, entry.name))
  } catch {
    return null
  }

  for (const dir of versionDirs) {
    candidates.push(path.join(dir, `${serverHash}_tokens.json`))
    candidates.push(path.join(dir, serverHash, 'tokens.json'))
  }

  const existingValid = candidates
    .filter((candidate) => fs.existsSync(candidate))
    .filter((candidate) => tokenFileIsUsable(candidate))
    .sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
      } catch {
        return 0
      }
    })

  if (existingValid.length > 0) {
    return existingValid[0]
  }

  return null
}

function commandDoctor(options) {
  const projectDir = resolveProjectDir(options)
  const mcpPath = resolveMcpPath(projectDir)
  const serverName = typeof options.name === 'string' ? options.name : DEFAULT_ROUTER_SERVER_NAME
  const allowMissingAuth = parseBool(String(options['allow-missing-auth'] || '').toLowerCase())
  const allowNpx = npxFallbackAllowed()

  let failed = false

  if (!fs.existsSync(mcpPath)) {
    console.log(`FAIL: missing .mcp.json at ${mcpPath}`)
    process.exit(1)
  }

  const config = loadMcpConfig(mcpPath)
  if (!config.mcpServers[serverName]) {
    console.log(`FAIL: '${serverName}' is not configured in ${mcpPath}`)
    failed = true
  } else {
    console.log(`OK: '${serverName}' exists in ${mcpPath}`)
  }

  const fastBin = resolveFastBinPath()
  if (fastBin) {
    console.log(`OK: found local notion-mcp-fast bin at ${fastBin}`)
  } else {
    if (allowNpx) {
      console.log('WARN: local notion-mcp-fast bin not found (using npx fallback)')
    } else {
      console.log('FAIL: local notion-mcp-fast bin not found and npx fallback is disabled')
      console.log('      install notion-mcp-fast locally or set OHMY_NOTION_ALLOW_NPX_FALLBACK=true')
      failed = true
    }
  }

  const localMcpRemote = resolveMcpRemoteProxyPath()
  if (localMcpRemote) {
    console.log(`OK: local mcp-remote proxy found at ${localMcpRemote}`)
  } else {
    if (allowNpx) {
      console.log('WARN: local mcp-remote dependency not found (using npx fallback)')
    } else {
      console.log('FAIL: local mcp-remote dependency not found and npx fallback is disabled')
      console.log('      install mcp-remote locally or set OHMY_NOTION_ALLOW_NPX_FALLBACK=true')
      failed = true
    }
  }

  const officialBackend = resolveOfficialBackendConfig()
  const defaultHash = getMcpRemoteServerHash()
  const ctx = extractMcpRemoteHashContext(officialBackend.command, officialBackend.args)
  const contextHash = hashForMcpRemoteContext(ctx.serverUrl, ctx.authorizeResource, ctx.headers)
  const candidateHashes = [...new Set([defaultHash, contextHash])]

  let tokenPath = null
  for (const hash of candidateHashes) {
    tokenPath = findMcpRemoteTokenFile(hash)
    if (tokenPath) break
  }

  if (tokenPath) {
    console.log(`OK: OAuth token cache exists (${tokenPath})`)
  } else {
    const baseDir = process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth')
    if (allowMissingAuth) {
      console.log(`WARN: OAuth token cache not found under ${baseDir} for hashes ${candidateHashes.join(', ')}`)
      console.log(`      run '${APP_BIN_NAME} login' to initialize official OAuth cache`)
    } else {
      console.log(`FAIL: OAuth token cache not found under ${baseDir} for hashes ${candidateHashes.join(', ')}`)
      console.log(`      run '${APP_BIN_NAME} login' to initialize official OAuth cache`)
      console.log("      if this is intentional, rerun doctor with '--allow-missing-auth'")
      failed = true
    }
  }

  if (failed) {
    process.exit(1)
  }
}

async function commandServe() {
  const fastBackend = resolveFastBackendConfig()
  const officialBackend = resolveOfficialBackendConfig()

  const router = new OhMyNotionRouter({
    fastBackend,
    officialBackend,
  })

  await router.start()
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }

  const options = parseArgs(rest)

  if (command === 'install') {
    commandInstall(options)
    return
  }

  if (command === 'login') {
    commandLogin(options)
    return
  }

  if (command === 'doctor') {
    commandDoctor(options)
    return
  }

  if (command === 'serve') {
    await commandServe(options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    return path.resolve(process.argv[1]) === path.resolve(resolveBinPath())
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}

export {
  OhMyNotionRouter,
  buildChildEnv,
  commandDoctor,
  commandInstall,
  commandLogin,
  extractUuidish,
  findMcpRemoteTokenFile,
  looksEmptyReadResult,
  looksReadTool,
  looksWriteTool,
  npxFallbackAllowed,
  normalizeToolName,
  resolveFastBackendConfig,
  resolveOfficialBackendConfig,
}
