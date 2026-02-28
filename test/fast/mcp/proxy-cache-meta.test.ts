import { describe, expect, it } from 'vitest'
import { MCP_FAST_FORCE_REFRESH_FIELD, splitProxyCacheParams } from '../../../src/fast/openapi-mcp-server/mcp/proxy-cache-params'

describe('splitProxyCacheParams', () => {
  it('separates forceRefresh=true from request params', () => {
    const params = {
      query: 'database',
      [MCP_FAST_FORCE_REFRESH_FIELD]: true,
    }

    const result = splitProxyCacheParams(params)

    expect(result.forceRefresh).toBe(true)
    expect(result.sanitizedParams).toEqual({ query: 'database' })
    expect(result.sanitizedParams).not.toHaveProperty(MCP_FAST_FORCE_REFRESH_FIELD)
  })

  it('treats forceRefresh=false and unspecified forceRefresh as false', () => {
    const withFalse = splitProxyCacheParams({
      pageId: 'page-1',
      [MCP_FAST_FORCE_REFRESH_FIELD]: false,
    })
    const withoutMeta = splitProxyCacheParams({
      pageId: 'page-1',
    })

    expect(withFalse.forceRefresh).toBe(false)
    expect(withFalse.sanitizedParams).toEqual({ pageId: 'page-1' })

    expect(withoutMeta.forceRefresh).toBe(false)
    expect(withoutMeta.sanitizedParams).toEqual({ pageId: 'page-1' })
  })

  it('does not mutate the original params object', () => {
    const params = {
      filter: { status: 'open' },
      [MCP_FAST_FORCE_REFRESH_FIELD]: true,
    }
    const snapshot = structuredClone(params)

    const result = splitProxyCacheParams(params)

    expect(params).toEqual(snapshot)
    expect(params).toHaveProperty(MCP_FAST_FORCE_REFRESH_FIELD, true)
    expect(result.sanitizedParams).not.toBe(params)
  })
})
