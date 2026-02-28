import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultNotionDbPath, parseLocalAppCacheConfig } from '../../../src/fast/openapi-mcp-server/local-app-cache/config'

const ENABLED_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED'
const TRUST_ENABLED_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED'
const DB_PATH_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH'
const MAX_PAGE_SIZE_ENV = 'NOTION_MCP_FAST_LOCAL_APP_CACHE_MAX_PAGE_SIZE'
const originalEnv = process.env

function setTrustEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[TRUST_ENABLED_ENV]
  } else {
    process.env[TRUST_ENABLED_ENV] = value
  }
}

describe('parseLocalAppCacheConfig', () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('enabled boolean parsing', () => {
    it('defaults to false when env var is missing', () => {
      delete process.env[ENABLED_ENV]
      setTrustEnv(undefined)

      const config = parseLocalAppCacheConfig()

      expect(config.enabled).toBe(false)
      expect(config.requestedEnabled).toBe(false)
      expect(config.trustEnabled).toBe(false)
    })

    it('parses "true" and "false" string values', () => {
      process.env[ENABLED_ENV] = 'true'
      setTrustEnv('true')
      expect(parseLocalAppCacheConfig().enabled).toBe(true)

      process.env[ENABLED_ENV] = 'false'
      expect(parseLocalAppCacheConfig().enabled).toBe(false)
    })

    it('falls back to false for unsupported strings', () => {
      process.env[ENABLED_ENV] = 'maybe'
      setTrustEnv('true')

      const config = parseLocalAppCacheConfig()

      expect(config.enabled).toBe(false)
    })
  })

  describe('trust env gate', () => {
    it('defaults trust to false when local cache is otherwise enabled', () => {
      process.env[ENABLED_ENV] = 'true'
      setTrustEnv(undefined)

      const config = parseLocalAppCacheConfig()

      expect(config.enabled).toBe(false)
      expect(config.requestedEnabled).toBe(true)
      expect(config.trustEnabled).toBe(false)
    })

    it('keeps local cache disabled when enabled=true but trust=false', () => {
      process.env[ENABLED_ENV] = 'true'
      setTrustEnv('false')

      const config = parseLocalAppCacheConfig()

      expect(config.enabled).toBe(false)
    })

    it('enables local cache only when enabled=true and trust=true', () => {
      process.env[ENABLED_ENV] = 'true'
      setTrustEnv('true')

      const config = parseLocalAppCacheConfig()

      expect(config.enabled).toBe(true)
      expect(config.requestedEnabled).toBe(true)
      expect(config.trustEnabled).toBe(true)
    })

    it('accepts truthy aliases (case-insensitive, trimmed) for trust flag', () => {
      process.env[ENABLED_ENV] = 'true'

      for (const value of [' true ', '1', 'YES', ' On ']) {
        setTrustEnv(value)
        expect(parseLocalAppCacheConfig().enabled).toBe(true)
      }
    })

    it('accepts falsy aliases (case-insensitive, trimmed) for trust flag', () => {
      process.env[ENABLED_ENV] = 'true'

      for (const value of [' false ', '0', 'NO', ' Off ']) {
        setTrustEnv(value)
        expect(parseLocalAppCacheConfig().enabled).toBe(false)
      }
    })
  })

  describe('maxPageSize parsing', () => {
    it('defaults to 100 when env var is missing', () => {
      delete process.env[MAX_PAGE_SIZE_ENV]

      const config = parseLocalAppCacheConfig()

      expect(config.maxPageSize).toBe(100)
    })

    it('parses a positive integer value', () => {
      process.env[MAX_PAGE_SIZE_ENV] = '250'

      const config = parseLocalAppCacheConfig()

      expect(config.maxPageSize).toBe(250)
    })

    it('keeps valid integer compatibility for trimmed and plus-prefixed values', () => {
      for (const [value, expected] of [
        [' 250 ', 250],
        ['+250', 250],
        ['00250', 250],
      ] as Array<[string, number]>) {
        process.env[MAX_PAGE_SIZE_ENV] = value
        expect(parseLocalAppCacheConfig().maxPageSize).toBe(expected)
      }
    })

    it('falls back to 100 for invalid values', () => {
      for (const value of ['0', '-5', 'abc', '100abc', '10.5']) {
        process.env[MAX_PAGE_SIZE_ENV] = value
        expect(parseLocalAppCacheConfig().maxPageSize).toBe(100)
      }
    })
  })

  describe('dbPath parsing', () => {
    it('falls back to default path when env var is missing', () => {
      delete process.env[DB_PATH_ENV]

      const config = parseLocalAppCacheConfig()

      expect(config.dbPath).toBe(defaultNotionDbPath())
    })

    it('falls back to default path when env var is empty or whitespace', () => {
      process.env[DB_PATH_ENV] = '   '

      const config = parseLocalAppCacheConfig()

      expect(config.dbPath).toBe(defaultNotionDbPath())
    })
  })
})
