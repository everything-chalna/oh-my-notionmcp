import { describe, it, expect } from 'vitest'
import { parseCacheConfig, DEFAULT_CACHE_CONFIG } from '../../../src/fast/openapi-mcp-server/cache/cache-config'

describe('parseCacheConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = parseCacheConfig({})
    expect(config).toEqual(DEFAULT_CACHE_CONFIG)
  })

  it('respects NOTION_MCP_FAST_CACHE_ENABLED=false', () => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_ENABLED: 'false' })
    expect(config.enabled).toBe(false)
  })

  it('respects NOTION_MCP_FAST_CACHE_ENABLED=true', () => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_ENABLED: 'true' })
    expect(config.enabled).toBe(true)
  })

  it.each([
    ['1', true],
    ['0', false],
    ['yes', true],
    ['no', false],
    ['on', true],
    ['off', false],
  ])('respects boolean variant %s -> %s', (input, expected) => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_ENABLED: input })
    expect(config.enabled).toBe(expected)
  })

  it('respects NOTION_MCP_FAST_CACHE_TTL_MS override', () => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_TTL_MS: '60000' })
    expect(config.ttlMs).toBe(60000)
  })

  it('respects NOTION_MCP_FAST_CACHE_MAX_ENTRIES override', () => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_MAX_ENTRIES: '500' })
    expect(config.maxEntries).toBe(500)
  })

  it('respects NOTION_MCP_FAST_CACHE_PATH override', () => {
    const config = parseCacheConfig({ NOTION_MCP_FAST_CACHE_PATH: '/tmp/my-cache.json' })
    expect(config.path).toBe('/tmp/my-cache.json')
  })

  it('throws on invalid boolean value', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_ENABLED: 'maybe' })).toThrow(
      /NOTION_MCP_FAST_CACHE_ENABLED must be one of/,
    )
  })

  it('throws on non-positive TTL (0)', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_TTL_MS: '0' })).toThrow(
      /NOTION_MCP_FAST_CACHE_TTL_MS must be a positive integer/,
    )
  })

  it('throws on negative TTL (-1)', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_TTL_MS: '-1' })).toThrow(
      /NOTION_MCP_FAST_CACHE_TTL_MS must be a positive integer/,
    )
  })

  it('throws on non-integer TTL (1.5)', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_TTL_MS: '1.5' })).toThrow(
      /NOTION_MCP_FAST_CACHE_TTL_MS must be a positive integer/,
    )
  })

  it('throws on non-positive maxEntries', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_MAX_ENTRIES: '0' })).toThrow(
      /NOTION_MCP_FAST_CACHE_MAX_ENTRIES must be a positive integer/,
    )
  })

  it('throws on path with null byte', () => {
    expect(() => parseCacheConfig({ NOTION_MCP_FAST_CACHE_PATH: '/tmp/cache\0evil' })).toThrow(
      /NOTION_MCP_FAST_CACHE_PATH must not contain a null byte/,
    )
  })

  it('uses defaults for empty string env values', () => {
    const config = parseCacheConfig({
      NOTION_MCP_FAST_CACHE_ENABLED: '',
      NOTION_MCP_FAST_CACHE_TTL_MS: '',
      NOTION_MCP_FAST_CACHE_MAX_ENTRIES: '',
      NOTION_MCP_FAST_CACHE_PATH: '',
    })
    expect(config).toEqual(DEFAULT_CACHE_CONFIG)
  })

  it('DEFAULT_CACHE_CONFIG has expected defaults', () => {
    expect(DEFAULT_CACHE_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CACHE_CONFIG.ttlMs).toBe(30_000)
    expect(DEFAULT_CACHE_CONFIG.maxEntries).toBe(300)
    expect(DEFAULT_CACHE_CONFIG.path).toContain('oh-my-notionmcp')
    expect(DEFAULT_CACHE_CONFIG.path).toContain('read-cache-v1.json')
  })
})
