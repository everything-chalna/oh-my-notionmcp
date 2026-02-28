import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { resolveOfficialBackendConfig, resolveMcpRemoteProxyPath } from './config.js'
import {
  APP_BIN_NAME,
  DEFAULT_ROUTER_SERVER_NAME,
  OFFICIAL_MCP_URL,
  loadMcpConfig,
  npxFallbackAllowed,
  parseBool,
  resolveMcpPath,
  resolveProjectDir,
  type ParsedOptions,
} from './utils.js'

export function getMcpRemoteServerHash(): string {
  return crypto.createHash('md5').update(OFFICIAL_MCP_URL).digest('hex')
}

function looksLikeTokenPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const obj = raw as Record<string, unknown>
  return (
    typeof obj.access_token === 'string' &&
    (obj.access_token as string).length > 0 &&
    (typeof obj.refresh_token === 'string' || typeof obj.expires_in === 'number')
  )
}

function tokenFileIsUsable(filePath: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return looksLikeTokenPayload(raw)
  } catch {
    return false
  }
}

export function hashForMcpRemoteContext(
  serverUrl: string,
  authorizeResource: string = '',
  headers: string[] = [],
): string {
  return crypto.createHash('md5').update(`${serverUrl}${authorizeResource}${JSON.stringify(headers)}`).digest('hex')
}

export function extractMcpRemoteHashContext(
  command: string,
  args: string[] = [],
): { serverUrl: string; authorizeResource: string; headers: string[] } {
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
  const headers: string[] = []
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

export function findMcpRemoteTokenFile(serverHash: string): string | null {
  const baseDir = process.env.MCP_REMOTE_CONFIG_DIR || path.join(os.homedir(), '.mcp-auth')
  if (!fs.existsSync(baseDir)) {
    return null
  }

  const candidates: string[] = []
  const directPath = path.join(baseDir, serverHash, 'tokens.json')
  candidates.push(directPath)

  let versionDirs: string[] = []
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

export function commandDoctor(options: ParsedOptions): void {
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

  console.log('OK: fast read-only backend is bundled in-process')

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

  let tokenPath: string | null = null
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
