import os from 'node:os'
import path from 'node:path'

const CACHE_ENABLED_ENV = 'NOTION_MCP_FAST_CACHE_ENABLED'
const CACHE_TTL_MS_ENV = 'NOTION_MCP_FAST_CACHE_TTL_MS'
const CACHE_MAX_ENTRIES_ENV = 'NOTION_MCP_FAST_CACHE_MAX_ENTRIES'
const CACHE_PATH_ENV = 'NOTION_MCP_FAST_CACHE_PATH'

const TRUE_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])
const FALSE_ENV_VALUES = new Set(['0', 'false', 'no', 'off'])

export type CacheConfig = {
  enabled: boolean
  ttlMs: number
  maxEntries: number
  path: string
}

const DEFAULT_CACHE_PATH = path.join(os.homedir(), '.cache', 'oh-my-notionmcp', 'read-cache-v1.json')

export const DEFAULT_CACHE_CONFIG: Readonly<CacheConfig> = {
  enabled: true,
  ttlMs: 30_000,
  maxEntries: 300,
  path: DEFAULT_CACHE_PATH,
}

export function parseCacheConfig(env: NodeJS.ProcessEnv = process.env): CacheConfig {
  return {
    enabled: parseBooleanEnv(CACHE_ENABLED_ENV, env[CACHE_ENABLED_ENV], DEFAULT_CACHE_CONFIG.enabled),
    ttlMs: parsePositiveIntegerEnv(CACHE_TTL_MS_ENV, env[CACHE_TTL_MS_ENV], DEFAULT_CACHE_CONFIG.ttlMs),
    maxEntries: parsePositiveIntegerEnv(
      CACHE_MAX_ENTRIES_ENV,
      env[CACHE_MAX_ENTRIES_ENV],
      DEFAULT_CACHE_CONFIG.maxEntries,
    ),
    path: parseOptionalPathEnv(CACHE_PATH_ENV, env[CACHE_PATH_ENV]) ?? DEFAULT_CACHE_CONFIG.path,
  }
}

function parseBooleanEnv(name: string, rawValue: string | undefined, defaultValue: boolean): boolean {
  if (rawValue === undefined) {
    return defaultValue
  }

  const normalized = rawValue.trim().toLowerCase()
  if (normalized.length === 0) {
    return defaultValue
  }

  if (TRUE_ENV_VALUES.has(normalized)) {
    return true
  }

  if (FALSE_ENV_VALUES.has(normalized)) {
    return false
  }

  throw new Error(
    `${name} must be one of: ${[...TRUE_ENV_VALUES, ...FALSE_ENV_VALUES].join(', ')}. Received "${rawValue}".`,
  )
}

function parsePositiveIntegerEnv(name: string, rawValue: string | undefined, defaultValue: number): number {
  if (rawValue === undefined) {
    return defaultValue
  }

  const trimmed = rawValue.trim()
  if (trimmed.length === 0) {
    return defaultValue
  }

  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer. Received "${rawValue}".`)
  }

  return parsed
}

function parseOptionalPathEnv(name: string, rawValue: string | undefined): string | undefined {
  if (rawValue === undefined) {
    return undefined
  }

  const trimmed = rawValue.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  if (trimmed.includes('\u0000')) {
    throw new Error(`${name} must not contain a null byte.`)
  }

  return trimmed
}
