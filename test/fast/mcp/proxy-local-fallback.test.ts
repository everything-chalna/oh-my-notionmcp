import { MCPProxy } from '../../../src/fast/openapi-mcp-server/mcp/proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient } from '../../../src/fast/openapi-mcp-server/client/http-client'
import { NotionAppSqliteCache } from '../../../src/fast/openapi-mcp-server/local-app-cache/notion-app-sqlite-cache'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../../src/fast/openapi-mcp-server/client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

type CallToolHandler = (request: {
  params: {
    name: string
    arguments?: Record<string, unknown>
  }
}) => Promise<any>

function getCallToolHandler(proxy: MCPProxy): CallToolHandler {
  const server = (proxy as any).server
  const handlers = server.setRequestHandler.mock.calls
    .flatMap((entry: unknown[]) => entry)
    .filter((entry: unknown) => typeof entry === 'function')
  return handlers[1] as CallToolHandler
}

describe('MCPProxy local fast-path fallback', () => {
  const originalEnv = process.env
  let cacheDir: string
  let proxy: MCPProxy

  const mockOpenApiSpec: OpenAPIV3.Document = {
    openapi: '3.0.0',
    servers: [{ url: 'http://localhost:3000' }],
    info: {
      title: 'Test API',
      version: '1.0.0',
    },
    paths: {
      '/pages/{page_id}': {
        get: {
          operationId: 'retrieve-a-page',
          responses: {
            '200': {
              description: 'Success',
            },
          },
        },
      },
    },
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    cacheDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'notion-mcp-fast-local-fallback-test-'))
    const localDbPath = path.join(cacheDir, 'notion.db')
    await fsPromises.writeFile(localDbPath, '')

    process.env = {
      ...originalEnv,
      NOTION_MCP_FAST_CACHE_ENABLED: 'false',
      NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED: 'true',
      NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED: 'true',
      NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH: localDbPath,
    }
    delete process.env.NOTION_TOKEN

    proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
    ;(proxy as any).openApiLookup = {
      'API-retrieve-a-page': {
        operationId: 'retrieve-a-page',
        responses: { '200': { description: 'Success' } },
        method: 'get',
        path: '/pages/{page_id}',
      },
    }
  })

  afterEach(async () => {
    process.env = originalEnv
    await fsPromises.rm(cacheDir, { recursive: true, force: true })
  })

  it.each([undefined, 'false'] as const)(
    'uses HTTP path and skips local query when trust gate is %s',
    async (trustGateValue) => {
      if (trustGateValue === undefined) {
        delete process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED
      } else {
        process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = trustGateValue
      }
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const localQuerySpy = vi
        .spyOn(NotionAppSqliteCache.prototype, 'query')
        .mockResolvedValue({ source: 'local-fast-path' })
      const httpPayload = { source: 'http-api-trust-gated' }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: httpPayload,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })

      const callToolHandler = getCallToolHandler(proxy)
      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: { page_id: 'page-1' },
        },
      })

      expect(localQuerySpy).not.toHaveBeenCalled()
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
      expect(HttpClient.prototype.executeOperation).toHaveBeenNthCalledWith(
        1,
        (proxy as any).openApiLookup['API-retrieve-a-page'],
        { page_id: 'page-1' },
      )
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(httpPayload),
          },
        ],
      })

      localQuerySpy.mockRestore()
    },
  )

  it('uses local fast-path when both enabled and trust gate is true', async () => {
    const localPayload = { source: 'local-fast-path' }
    const localQuerySpy = vi.spyOn(NotionAppSqliteCache.prototype, 'query').mockResolvedValue(localPayload)
    const callToolHandler = getCallToolHandler(proxy)

    const result = await callToolHandler({
      params: {
        name: 'API-retrieve-a-page',
        arguments: { page_id: 'page-1' },
      },
    })

    expect(localQuerySpy).toHaveBeenCalledWith('retrieve-a-page', { page_id: 'page-1' })
    expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(localPayload),
        },
      ],
    })

    localQuerySpy.mockRestore()
  })

  it.each([null, undefined] as const)(
    'falls back to Notion API when local fast-path returns %s',
    async (localResult) => {
      const httpPayload = { source: 'http-api' }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: httpPayload,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      })

      const localQuerySpy = vi.spyOn(NotionAppSqliteCache.prototype, 'query').mockResolvedValue(localResult)
      const callToolHandler = getCallToolHandler(proxy)

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: { page_id: 'page-1' },
        },
      })

      expect(localQuerySpy).toHaveBeenCalledWith('retrieve-a-page', { page_id: 'page-1' })
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(httpPayload),
          },
        ],
      })

      localQuerySpy.mockRestore()
    },
  )

  it('falls back to Notion API when local fast-path throws', async () => {
    const httpPayload = { source: 'http-api-after-local-error' }
    ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: httpPayload,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    })

    const localError = new Error('sqlite read failed')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const localQuerySpy = vi.spyOn(NotionAppSqliteCache.prototype, 'query').mockRejectedValue(localError)
    const callToolHandler = getCallToolHandler(proxy)

    const result = await callToolHandler({
      params: {
        name: 'API-retrieve-a-page',
        arguments: { page_id: 'page-1' },
      },
    })

    expect(localQuerySpy).toHaveBeenCalledWith('retrieve-a-page', { page_id: 'page-1' })
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to read from Notion app local cache. Falling back to Notion API.',
      localError,
    )
    expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(httpPayload),
        },
      ],
    })

    warnSpy.mockRestore()
    localQuerySpy.mockRestore()
  })
})
