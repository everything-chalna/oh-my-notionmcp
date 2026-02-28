import { describe, expect, it } from 'vitest'

import { createCacheKey, type CacheKeyOperation } from '../../../src/fast/openapi-mcp-server/cache/cache-key'

describe('createCacheKey', () => {
  const baseOperation: CacheKeyOperation = {
    method: 'post',
    path: '/search',
    operationId: 'post-search',
  }

  it('returns the same key for objects with different property order', () => {
    const paramsA = {
      pageSize: 10,
      filter: {
        status: 'active',
        tags: ['notion', 'api'],
      },
    }
    const paramsB = {
      filter: {
        tags: ['notion', 'api'],
        status: 'active',
      },
      pageSize: 10,
    }

    const keyA = createCacheKey(baseOperation, paramsA)
    const keyB = createCacheKey(baseOperation, paramsB)

    expect(keyA).toBe(keyB)
  })

  it('returns a different key when parameter values differ', () => {
    const keyA = createCacheKey(baseOperation, { pageSize: 10, query: 'docs' })
    const keyB = createCacheKey(baseOperation, { pageSize: 20, query: 'docs' })

    expect(keyA).not.toBe(keyB)
  })

  it('returns a different key when operation changes', () => {
    const changedOperation: CacheKeyOperation = {
      ...baseOperation,
      operationId: 'query-data-source',
    }

    const keyA = createCacheKey(baseOperation, { query: 'docs' })
    const keyB = createCacheKey(changedOperation, { query: 'docs' })

    expect(keyA).not.toBe(keyB)
  })
})
