import os from 'node:os'
import path from 'node:path'

const LOCAL_APP_CACHE_ENABLED_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED'
const LOCAL_APP_CACHE_TRUST_ENABLED_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED'
const LOCAL_APP_CACHE_DB_PATH_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH'
const LOCAL_APP_CACHE_MAX_PAGE_SIZE_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_MAX_PAGE_SIZE'

export type LocalAppCacheConfig = {
  enabled: boolean
  requestedEnabled: boolean
  trustEnabled: boolean
  dbPath: string
  maxPageSize: number
}

const DEFAULT_LOCAL_APP_CACHE_MAX_PAGE_SIZE = 100

export function defaultNotionDbPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Notion', 'notion.db')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Notion', 'notion.db')
  }
  return path.join(os.homedir(), '.config', 'Notion', 'notion.db')
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false
  }
  return defaultValue
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue
  const normalized = value.trim()
  if (!/^\+?\d+$/.test(normalized)) {
    return defaultValue
  }
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue
  }
  return parsed
}

function parseDbPath(value: string | undefined): string {
  if (value === undefined) {
    return defaultNotionDbPath()
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return defaultNotionDbPath()
  }
  return trimmed
}

export function parseLocalAppCacheConfig(): LocalAppCacheConfig {
  const requestedEnabled = parseBoolean(process.env[LOCAL_APP_CACHE_ENABLED_ENV], false)
  const trustEnabled = parseBoolean(process.env[LOCAL_APP_CACHE_TRUST_ENABLED_ENV], false)
  return {
    enabled: requestedEnabled && trustEnabled,
    requestedEnabled,
    trustEnabled,
    dbPath: parseDbPath(process.env[LOCAL_APP_CACHE_DB_PATH_ENV]),
    maxPageSize: parsePositiveInt(
      process.env[LOCAL_APP_CACHE_MAX_PAGE_SIZE_ENV],
      DEFAULT_LOCAL_APP_CACHE_MAX_PAGE_SIZE,
    ),
  }
}
