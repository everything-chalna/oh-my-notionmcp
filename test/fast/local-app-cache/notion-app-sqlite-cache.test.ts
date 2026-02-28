import { describe, expect, it, vi } from 'vitest'
import { NotionAppSqliteCache } from '../../../src/fast/openapi-mcp-server/local-app-cache/notion-app-sqlite-cache'
import type { LocalAppCacheConfig } from '../../../src/fast/openapi-mcp-server/local-app-cache/config'

const ENABLED_CONFIG: LocalAppCacheConfig = {
  enabled: true,
  requestedEnabled: true,
  trustEnabled: true,
  dbPath: '/tmp/notion.db',
  maxPageSize: 100,
}

describe('NotionAppSqliteCache', () => {
  it('returns page payload for retrieve-a-page', async () => {
    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.includes("type='page'")) {
        return [
          {
            id: '312c9946-d64a-80cc-a398-fda09577bfc4',
            type: 'page',
            parent_table: 'block',
            parent_id: '3c063b09-16c5-4750-ae06-e1be835e45ba',
            created_time: 1772049600000,
            last_edited_time: 1772049673187,
            alive: 1,
            properties: '{"title":[["매대 인식 AI"]]}',
          },
        ]
      }
      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('retrieve-a-page', {
      page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
    })

    expect(response).toMatchObject({
      object: 'page',
      id: '312c9946-d64a-80cc-a398-fda09577bfc4',
      properties: {
        title: {
          type: 'title',
        },
      },
    })
  })

  it('returns paginated children for get-block-children', async () => {
    const parentId = '312c9946-d64a-80cc-a398-fda09577bfc4'
    const child1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const child2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    const child3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.startsWith('SELECT content FROM block')) {
        return [
          {
            content: JSON.stringify([child1, child2, child3]),
          },
        ]
      }

      if (sql.startsWith('SELECT id, type, created_time')) {
        return [
          {
            id: child1,
            type: 'header',
            created_time: 1772049600000,
            last_edited_time: 1772049600000,
            alive: 1,
            properties: '{"title":[["헤더"]]}',
            content: '[]',
            meta_last_access_timestamp: 10,
          },
          {
            id: child2,
            type: 'text',
            created_time: 1772049601000,
            last_edited_time: 1772049601000,
            alive: 1,
            properties: '{"title":[["문단"]]}',
            content: '[]',
            meta_last_access_timestamp: 10,
          },
        ]
      }

      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('get-block-children', {
      block_id: parentId,
      page_size: 2,
    })

    expect(response).toMatchObject({
      object: 'list',
      has_more: true,
      next_cursor: child2,
      results: [
        {
          id: child1,
          type: 'heading_1',
        },
        {
          id: child2,
          type: 'paragraph',
        },
      ],
    })
  })

  it('returns null for retrieve-a-page when title property is missing', async () => {
    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.includes("type='page'")) {
        return [
          {
            id: '312c9946-d64a-80cc-a398-fda09577bfc4',
            type: 'page',
            parent_table: 'block',
            parent_id: '3c063b09-16c5-4750-ae06-e1be835e45ba',
            created_time: 1772049600000,
            last_edited_time: 1772049673187,
            alive: 1,
            properties: '{"status":[["draft"]]}',
          },
        ]
      }
      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('retrieve-a-page', {
      page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
    })

    expect(response).toBeNull()
  })

  it('returns null for retrieve-a-page when properties are invalid json', async () => {
    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.includes("type='page'")) {
        return [
          {
            id: '312c9946-d64a-80cc-a398-fda09577bfc4',
            type: 'page',
            parent_table: 'block',
            parent_id: '3c063b09-16c5-4750-ae06-e1be835e45ba',
            created_time: 1772049600000,
            last_edited_time: 1772049673187,
            alive: 1,
            properties: '{"title":[["invalid"]]',
          },
        ]
      }
      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('retrieve-a-page', {
      page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
    })

    expect(response).toBeNull()
  })

  it('returns null for get-block-children when parent content is invalid', async () => {
    const parentId = '312c9946-d64a-80cc-a398-fda09577bfc4'

    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.startsWith('SELECT content FROM block')) {
        return [
          {
            content: '{"children":"invalid"}',
          },
        ]
      }
      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('get-block-children', {
      block_id: parentId,
    })

    expect(response).toBeNull()
  })

  it('returns null for get-block-children when child rows are missing', async () => {
    const parentId = '312c9946-d64a-80cc-a398-fda09577bfc4'
    const childId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.startsWith('SELECT content FROM block')) {
        return [
          {
            content: JSON.stringify([childId]),
          },
        ]
      }

      if (sql.startsWith('SELECT id, type, created_time')) {
        return []
      }

      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('get-block-children', {
      block_id: parentId,
    })

    expect(response).toBeNull()
  })

  it('returns null for get-block-children when start_cursor is unknown', async () => {
    const parentId = '312c9946-d64a-80cc-a398-fda09577bfc4'
    const childId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const unknownCursor = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

    const runSql = vi.fn(async (_dbPath: string, sql: string) => {
      if (sql.startsWith('SELECT content FROM block')) {
        return [
          {
            content: JSON.stringify([childId]),
          },
        ]
      }

      if (sql.startsWith('SELECT id, type, created_time')) {
        return [
          {
            id: childId,
            type: 'text',
            created_time: 1772049601000,
            last_edited_time: 1772049601000,
            alive: 1,
            properties: '{"title":[["문단"]]}',
            content: '[]',
            meta_last_access_timestamp: 10,
          },
        ]
      }

      return []
    })

    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)
    const response = await cache.query('get-block-children', {
      block_id: parentId,
      start_cursor: unknownCursor,
    })

    expect(response).toBeNull()
  })

  it('returns null for invalid ids', async () => {
    const runSql = vi.fn(async () => [])
    const cache = new NotionAppSqliteCache(ENABLED_CONFIG, runSql)

    const response = await cache.query('retrieve-a-page', {
      page_id: 'not-a-valid-id',
    })

    expect(response).toBeNull()
    expect(runSql).not.toHaveBeenCalled()
  })

  it('returns null when disabled', async () => {
    const runSql = vi.fn(async () => [])
    const cache = new NotionAppSqliteCache(
      {
        ...ENABLED_CONFIG,
        enabled: false,
      },
      runSql,
    )

    const response = await cache.query('retrieve-a-page', {
      page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
    })

    expect(response).toBeNull()
    expect(runSql).not.toHaveBeenCalled()
  })
})
