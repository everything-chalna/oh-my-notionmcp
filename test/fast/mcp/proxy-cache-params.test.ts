import { describe, expect, it } from 'vitest'

import {
  MCP_FAST_FORCE_REFRESH_FIELD,
  splitProxyCacheParams,
} from '../../../src/fast/openapi-mcp-server/mcp/proxy-cache-params'

describe('MCP_FAST_FORCE_REFRESH_FIELD constant', () => {
  it('equals __mcpFastForceRefresh', () => {
    expect(MCP_FAST_FORCE_REFRESH_FIELD).toBe('__mcpFastForceRefresh')
  })
})

describe('splitProxyCacheParams', () => {
  it('returns forceRefresh=false and empty params for null input', () => {
    const result = splitProxyCacheParams(null)
    expect(result.forceRefresh).toBe(false)
    expect(result.sanitizedParams).toEqual({})
  })

  it('returns forceRefresh=false and empty params for undefined input', () => {
    const result = splitProxyCacheParams(undefined)
    expect(result.forceRefresh).toBe(false)
    expect(result.sanitizedParams).toEqual({})
  })

  it('returns forceRefresh=true when __mcpFastForceRefresh=true', () => {
    const result = splitProxyCacheParams({ __mcpFastForceRefresh: true })
    expect(result.forceRefresh).toBe(true)
  })

  it('returns forceRefresh=false when __mcpFastForceRefresh=false', () => {
    const result = splitProxyCacheParams({ __mcpFastForceRefresh: false })
    expect(result.forceRefresh).toBe(false)
  })

  it('returns forceRefresh=false when __mcpFastForceRefresh is string "true"', () => {
    const result = splitProxyCacheParams({ __mcpFastForceRefresh: 'true' })
    expect(result.forceRefresh).toBe(false)
  })

  it('returns forceRefresh=false when __mcpFastForceRefresh is number 1', () => {
    const result = splitProxyCacheParams({ __mcpFastForceRefresh: 1 })
    expect(result.forceRefresh).toBe(false)
  })

  it('removes __mcpFastForceRefresh from sanitizedParams', () => {
    const result = splitProxyCacheParams({
      __mcpFastForceRefresh: true,
      page_id: 'abc123',
    })
    expect(result.sanitizedParams).toEqual({ page_id: 'abc123' })
    expect('__mcpFastForceRefresh' in result.sanitizedParams).toBe(false)
  })

  it('preserves other params in sanitizedParams', () => {
    const result = splitProxyCacheParams({
      __mcpFastForceRefresh: true,
      page_id: 'abc123',
      filter: { property: 'Status' },
      page_size: 100,
    })
    expect(result.sanitizedParams).toEqual({
      page_id: 'abc123',
      filter: { property: 'Status' },
      page_size: 100,
    })
  })

  it('returns empty sanitizedParams when only __mcpFastForceRefresh is present', () => {
    const result = splitProxyCacheParams({ __mcpFastForceRefresh: true })
    expect(result.sanitizedParams).toEqual({})
  })

  it('returns forceRefresh=false and all params for empty object', () => {
    const result = splitProxyCacheParams({})
    expect(result.forceRefresh).toBe(false)
    expect(result.sanitizedParams).toEqual({})
  })
})
