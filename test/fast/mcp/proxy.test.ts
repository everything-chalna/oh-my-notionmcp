import { MCPProxy } from '../../../src/fast/openapi-mcp-server/mcp/proxy'
import { OpenAPIV3 } from 'openapi-types'
import { HttpClient, HttpClientError } from '../../../src/fast/openapi-mcp-server/client/http-client'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { NotionAppSqliteCache } from '../../../src/fast/openapi-mcp-server/local-app-cache/notion-app-sqlite-cache'

// Mock the dependencies
vi.mock('../../../src/fast/openapi-mcp-server/client/http-client')
vi.mock('@modelcontextprotocol/sdk/server/index.js')

describe('MCPProxy', () => {
  let proxy: MCPProxy
  let mockOpenApiSpec: OpenAPIV3.Document
  const originalEnv = process.env
  let cacheDir: string

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks()
    cacheDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'notion-mcp-fast-proxy-test-'))
    process.env = {
      ...originalEnv,
      NOTION_MCP_FAST_CACHE_ENABLED: 'false',
      NOTION_MCP_FAST_CACHE_PATH: path.join(cacheDir, 'cache.json'),
      NOTION_MCP_FAST_CACHE_TTL_MS: '60000',
      NOTION_MCP_FAST_CACHE_MAX_ENTRIES: '100',
    }
    delete process.env.NOTION_TOKEN

    // Setup minimal OpenAPI spec for testing
    mockOpenApiSpec = {
      openapi: '3.0.0',
      servers: [{ url: 'http://localhost:3000' }],
      info: {
        title: 'Test API',
        version: '1.0.0',
      },
      paths: {
        '/test': {
          get: {
            operationId: 'getTest',
            responses: {
              '200': {
                description: 'Success',
              },
            },
          },
        },
      },
    }

    proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
  })

  afterEach(async () => {
    process.env = originalEnv
    await fsPromises.rm(cacheDir, { recursive: true, force: true })
  })

  describe('listTools handler', () => {
    it('should return converted tools from OpenAPI spec', async () => {
      const server = (proxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
      const result = await listToolsHandler()

      expect(result).toHaveProperty('tools')
      expect(Array.isArray(result.tools)).toBe(true)
    })

    it('should truncate tool names exceeding 64 characters', async () => {
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      // Force a very long tool name while keeping an allowlisted read operationId.
      const longToolPrefix = 'x'.repeat(60)
      const toolNameWithMethod = `${longToolPrefix}-retrieve-a-page`
      ;(proxy as any).tools = {
        [longToolPrefix]: {
          methods: [
            {
              name: 'retrieve-a-page',
              description: 'Notion | Retrieve a page',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
        },
      }
      ;(proxy as any).openApiLookup = {
        [toolNameWithMethod]: {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
      const result = await listToolsHandler()

      expect(result.tools).toHaveLength(1)
      expect(result.tools[0].name.length).toBeLessThanOrEqual(64)
      expect(result.tools[0].name).toBe(toolNameWithMethod.slice(0, 64))
    })

    it('should expose only allowlisted Notion read operations while preserving metadata', async () => {
      const notionOpenApiSpec = JSON.parse(
        fs.readFileSync(new URL('../../../scripts/notion-openapi.json', import.meta.url), 'utf-8'),
      ) as OpenAPIV3.Document

      const notionProxy = new MCPProxy('notion-proxy', notionOpenApiSpec)
      const server = (notionProxy as any).server
      const listToolsHandler = server.setRequestHandler.mock.calls[0].filter((x: unknown) => typeof x === 'function')[0]
      const result = await listToolsHandler()

      const readToolNames = [
        'API-get-user',
        'API-get-users',
        'API-get-self',
        'API-post-search',
        'API-get-block-children',
        'API-retrieve-a-block',
        'API-retrieve-a-page',
        'API-retrieve-a-page-property',
        'API-retrieve-a-comment',
        'API-query-data-source',
        'API-retrieve-a-data-source',
        'API-list-data-source-templates',
        'API-retrieve-a-database',
      ]

      const writeToolNames = [
        'API-patch-block-children',
        'API-update-a-block',
        'API-delete-a-block',
        'API-patch-page',
        'API-post-page',
        'API-create-a-comment',
        'API-update-a-data-source',
        'API-create-a-data-source',
        'API-move-page',
      ]

      const expectedToolNames = new Set(readToolNames)
      type ToolLike = {
        description: string
        annotations: {
          title: string
          readOnlyHint?: boolean
          destructiveHint?: boolean
        }
        inputSchema: {
          type: string
        }
      }
      const toolsByName = new Map<string, ToolLike>(
        result.tools.map((tool: any) => [tool.name, tool as ToolLike]),
      )

      expect(result.tools).toHaveLength(readToolNames.length)
      expect(new Set(result.tools.map((tool: any) => tool.name))).toEqual(expectedToolNames)

      for (const toolName of readToolNames) {
        const tool = toolsByName.get(toolName)
        expect(tool).toBeDefined()
        if (!tool) {
          continue
        }
        expect(typeof tool.description).toBe('string')
        expect(tool.description.length).toBeGreaterThan(0)
        expect(typeof tool.annotations.title).toBe('string')
        expect(tool.annotations.title.length).toBeGreaterThan(0)
        expect(tool.inputSchema).toBeDefined()
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.annotations.readOnlyHint).toBe(true)
        expect(tool.annotations.destructiveHint).toBeUndefined()
      }

      for (const toolName of writeToolNames) {
        const tool = toolsByName.get(toolName)
        expect(tool).toBeUndefined()
      }
    })
  })

  describe('callTool handler', () => {
    it('should block non-allowlisted write operations at call time', async () => {
      ;(proxy as any).openApiLookup = {
        'API-createPage': {
          operationId: 'create-page',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/pages',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-createPage',
          arguments: {
            title: 'New page',
          },
        },
      })

      expect(result.isError).toBe(true)
      expect(result.content).toHaveLength(1)
      expect(result.content[0]?.type).toBe('text')
      expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()

      const payload = JSON.parse(result.content[0]?.text ?? '{}')
      expect(payload).toMatchObject({
        status: 'error',
        code: 'READ_ONLY_OPERATION_BLOCKED',
        attemptedOperation: {
          toolName: 'API-createPage',
          operationId: 'create-page',
          method: 'POST',
          path: '/pages',
        },
      })
    })

    it('should allow allowlisted read operation at call time', async () => {
      const mockResponse = {
        data: { results: [] },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-post-search': {
          operationId: 'post-search',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/search',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-post-search',
          arguments: {
            query: 'docs',
          },
        },
      })

      expect(result.isError).toBeUndefined()
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ results: [] }),
          },
        ],
      })
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        (proxy as any).openApiLookup['API-post-search'],
        { query: 'docs' },
      )
    })

    it('should serve repeated allowlisted read operations from cache', async () => {
      process.env.NOTION_MCP_FAST_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_CACHE_PATH = path.join(cacheDir, 'cache-hit.json')
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      const mockResponse = {
        data: { message: 'cached-success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const first = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: { page_id: 'page-1' },
        },
      })
      const second = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: { page_id: 'page-1' },
        },
      })

      expect(first).toEqual(second)
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should bypass cache on __mcpFastForceRefresh=true and not forward control field', async () => {
      process.env.NOTION_MCP_FAST_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_CACHE_PATH = path.join(cacheDir, 'cache-refresh.json')
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          data: { message: 'v1' },
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        })
        .mockResolvedValueOnce({
          data: { message: 'v2' },
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
        })

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: { page_id: 'page-1' },
        },
      })
      const refreshed = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {
            page_id: 'page-1',
            __mcpFastForceRefresh: true,
          },
        },
      })

      expect(refreshed).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'v2' }),
          },
        ],
      })
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(2)
      expect(HttpClient.prototype.executeOperation).toHaveBeenLastCalledWith(
        (proxy as any).openApiLookup['API-retrieve-a-page'],
        { page_id: 'page-1' },
      )
    })

    it('should serve supported read operations from local app cache before HTTP client', async () => {
      const localDbPath = path.join(cacheDir, 'notion.db')
      await fsPromises.writeFile(localDbPath, '')
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH = localDbPath
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      const localPayload = {
        object: 'page',
        id: '312c9946-d64a-80cc-a398-fda09577bfc4',
        properties: {
          title: {
            id: 'title',
            type: 'title',
            title: [],
          },
        },
      }

      const localSpy = vi
        .spyOn(NotionAppSqliteCache.prototype, 'query')
        .mockResolvedValue(localPayload)

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {
            page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
          },
        },
      })

      expect(localSpy).toHaveBeenCalledTimes(1)
      expect(HttpClient.prototype.executeOperation).not.toHaveBeenCalled()
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(localPayload),
          },
        ],
      })

      localSpy.mockRestore()
    })

    it('should fall back to HTTP when local app cache returns null', async () => {
      const localDbPath = path.join(cacheDir, 'notion-null.db')
      await fsPromises.writeFile(localDbPath, '')
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH = localDbPath
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      const localSpy = vi.spyOn(NotionAppSqliteCache.prototype, 'query').mockResolvedValue(null)
      const mockResponse = {
        data: { message: 'http-fallback' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {
            page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
          },
        },
      })

      expect(localSpy).toHaveBeenCalledWith('retrieve-a-page', {
        page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
      })
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'http-fallback' }),
          },
        ],
      })

      localSpy.mockRestore()
    })

    it('should fall back to HTTP when local app cache query throws', async () => {
      const localDbPath = path.join(cacheDir, 'notion-throws.db')
      await fsPromises.writeFile(localDbPath, '')
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH = localDbPath
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      const localSpy = vi
        .spyOn(NotionAppSqliteCache.prototype, 'query')
        .mockRejectedValue(new Error('local cache read failed'))
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const mockResponse = {
        data: { message: 'http-after-local-error' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {
            page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
          },
        },
      })

      expect(localSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to read from Notion app local cache. Falling back to Notion API.',
        expect.any(Error),
      )
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'http-after-local-error' }),
          },
        ],
      })

      warnSpy.mockRestore()
      localSpy.mockRestore()
    })

    it('should bypass local app cache on __mcpFastForceRefresh=true', async () => {
      const localDbPath = path.join(cacheDir, 'notion-force-refresh.db')
      await fsPromises.writeFile(localDbPath, '')
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = 'true'
      process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH = localDbPath
      proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

      const localSpy = vi
        .spyOn(NotionAppSqliteCache.prototype, 'query')
        .mockResolvedValue({ message: 'local-should-not-be-used' })
      const mockResponse = {
        data: { message: 'forced-http' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {
            page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
            __mcpFastForceRefresh: true,
          },
        },
      })

      expect(localSpy).not.toHaveBeenCalled()
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        (proxy as any).openApiLookup['API-retrieve-a-page'],
        { page_id: '312c9946-d64a-80cc-a398-fda09577bfc4' },
      )
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'forced-http' }),
          },
        ],
      })

      localSpy.mockRestore()
    })

    it.each([undefined, 'false'] as const)(
      'should skip local app cache and use HTTP when trust gate is %s',
      async (trustGateValue) => {
        const localDbPath = path.join(cacheDir, `notion-untrusted-${trustGateValue ?? 'unset'}.db`)
        await fsPromises.writeFile(localDbPath, '')
        process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
        if (trustGateValue === undefined) {
          delete process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED
        } else {
          process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = trustGateValue
        }
        process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_DB_PATH = localDbPath
        proxy = new MCPProxy('test-proxy', mockOpenApiSpec)

        const localSpy = vi
          .spyOn(NotionAppSqliteCache.prototype, 'query')
          .mockResolvedValue({ message: 'local-should-not-run-when-untrusted' })
        const mockResponse = {
          data: { message: 'http-untrusted' },
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
          }),
        }
        ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

        ;(proxy as any).openApiLookup = {
          'API-retrieve-a-page': {
            operationId: 'retrieve-a-page',
            responses: { '200': { description: 'Success' } },
            method: 'get',
            path: '/pages/{page_id}',
          },
        }

        const server = (proxy as any).server
        const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
        const callToolHandler = handlers[1]

        const result = await callToolHandler({
          params: {
            name: 'API-retrieve-a-page',
            arguments: {
              page_id: '312c9946-d64a-80cc-a398-fda09577bfc4',
            },
          },
        })

        expect(localSpy).not.toHaveBeenCalled()
        expect(HttpClient.prototype.executeOperation).toHaveBeenCalledTimes(1)
        expect(HttpClient.prototype.executeOperation).toHaveBeenNthCalledWith(
          1,
          (proxy as any).openApiLookup['API-retrieve-a-page'],
          { page_id: '312c9946-d64a-80cc-a398-fda09577bfc4' },
        )
        expect(result).toEqual({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ message: 'http-untrusted' }),
            },
          ],
        })

        localSpy.mockRestore()
      },
    )

    it('should execute operation and return formatted response', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      // Set up the openApiLookup with our test operation
      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {},
        },
      })

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'success' }),
          },
        ],
      })
    })

    it('should throw error for non-existent operation', async () => {
      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await expect(
        callToolHandler({
          params: {
            name: 'nonExistentMethod',
            arguments: {},
          },
        }),
      ).rejects.toThrow('Method nonExistentMethod not found')
    })

    it('should handle tool names exceeding 64 characters', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json'
        })
      };
      (HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      // Set up the openApiLookup with a long tool name
      const longToolName = 'a'.repeat(65)
      const truncatedToolName = longToolName.slice(0, 64)
      ;(proxy as any).openApiLookup = {
        [longToolName]: {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/test'
        }
      }
      ;(proxy as any).toolNameAliases = {
        [truncatedToolName]: longToolName,
      }

      const server = (proxy as any).server;
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function');
      const callToolHandler = handlers[1];

      const result = await callToolHandler({
        params: {
          name: truncatedToolName,
          arguments: {}
        }
      })

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ message: 'success' })
          }
        ]
      })
    })

    it('should mark HttpClientError responses as MCP errors', async () => {
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new HttpClientError('Bad Request', 400, { code: 'bad_request' }, new Headers()),
      )

      ;(proxy as any).openApiLookup = {
        'API-retrieve-a-page': {
          operationId: 'retrieve-a-page',
          responses: { '200': { description: 'Success' } },
          method: 'get',
          path: '/pages/{page_id}',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      const result = await callToolHandler({
        params: {
          name: 'API-retrieve-a-page',
          arguments: {},
        },
      })

      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('"status":"error"')
    })
  })

  describe('getContentType', () => {
    it('should return correct content type for different headers', () => {
      const getContentType = (proxy as any).getContentType.bind(proxy)

      expect(getContentType(new Headers({ 'content-type': 'text/plain' }))).toBe('text')
      expect(getContentType(new Headers({ 'content-type': 'application/json' }))).toBe('text')
      expect(getContentType(new Headers({ 'content-type': 'image/jpeg' }))).toBe('image')
      expect(getContentType(new Headers({ 'content-type': 'application/octet-stream' }))).toBe('binary')
      expect(getContentType(new Headers())).toBe('binary')
    })
  })

  describe('parseHeadersFromEnv', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should parse valid JSON headers from env', () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: 'Bearer token123',
        'X-Custom-Header': 'test',
      })

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer token123',
            'X-Custom-Header': 'test',
          },
        }),
        expect.anything(),
      )
    })

    it('should return empty object when env var is not set', () => {
      delete process.env.OPENAPI_MCP_HEADERS

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
    })

    it('should return empty object and warn on invalid JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = 'invalid json'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('Failed to parse OPENAPI_MCP_HEADERS environment variable:', expect.any(Error))
      consoleSpy.mockRestore()
    })

    it('should return empty object and warn on non-object JSON', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = '"string"'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', 'string')
      consoleSpy.mockRestore()
    })

    it('should return empty object and warn on JSON array', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = '["header"]'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', 'array')
      consoleSpy.mockRestore()
    })

    it('should return empty object and warn when header values are not strings', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.OPENAPI_MCP_HEADERS = '{"Authorization":{"toString":null}}'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
      expect(consoleSpy).toHaveBeenCalledWith('OPENAPI_MCP_HEADERS values must be strings.')
      consoleSpy.mockRestore()
    })

    it('should use NOTION_TOKEN when OPENAPI_MCP_HEADERS is not set', () => {
      delete process.env.OPENAPI_MCP_HEADERS
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer ntn_test_token_123',
            'Notion-Version': '2025-09-03'
          },
        }),
        expect.anything(),
      )
    })

    it('should prioritize OPENAPI_MCP_HEADERS over NOTION_TOKEN when both are set', () => {
      process.env.OPENAPI_MCP_HEADERS = JSON.stringify({
        Authorization: 'Bearer custom_token',
        'Custom-Header': 'custom_value',
      })
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer custom_token',
            'Custom-Header': 'custom_value',
          },
        }),
        expect.anything(),
      )
    })

    it('should return empty object when neither OPENAPI_MCP_HEADERS nor NOTION_TOKEN are set', () => {
      delete process.env.OPENAPI_MCP_HEADERS
      delete process.env.NOTION_TOKEN

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {},
        }),
        expect.anything(),
      )
    })

    it('should use NOTION_TOKEN when OPENAPI_MCP_HEADERS is empty object', () => {
      process.env.OPENAPI_MCP_HEADERS = '{}'
      process.env.NOTION_TOKEN = 'ntn_test_token_123'

      const proxy = new MCPProxy('test-proxy', mockOpenApiSpec)
      expect(HttpClient).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer ntn_test_token_123',
            'Notion-Version': '2025-09-03'
          },
        }),
        expect.anything(),
      )
    })
  })
  describe('connect', () => {
    it('should connect to transport', async () => {
      const mockTransport = {} as Transport
      await proxy.connect(mockTransport)

      const server = (proxy as any).server
      expect(server.connect).toHaveBeenCalledWith(mockTransport)
    })
  })

  describe('double-serialization fix (issue #176)', () => {
    it('should deserialize stringified JSON object parameters', async () => {
      // Mock HttpClient response
      const mockResponse = {
        data: { message: 'success' },
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
        }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      // Set up the openApiLookup with our test operation
      ;(proxy as any).openApiLookup = {
        'API-query-data-source': {
          operationId: 'query-data-source',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/data-sources/{data_source_id}/query',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Simulate double-serialized parameters (the bug from issue #176)
      const stringifiedData = JSON.stringify({
        page_id: 'test-page-id',
        command: 'update_properties',
        properties: { Status: 'Done' },
      })

      await callToolHandler({
        params: {
          name: 'API-query-data-source',
          arguments: {
            data: stringifiedData, // This would normally fail with "Expected object, received string"
          },
        },
      })

      // Verify that the parameters were deserialized before being passed to executeOperation
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          data: {
            page_id: 'test-page-id',
            command: 'update_properties',
            properties: { Status: 'Done' },
          },
        },
      )
    })

    it('should handle nested stringified JSON parameters', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-query-data-source': {
          operationId: 'query-data-source',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/data-sources/{data_source_id}/query',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      // Nested stringified object
      const nestedData = JSON.stringify({
        parent: JSON.stringify({ page_id: 'parent-page-id' }),
      })

      await callToolHandler({
        params: {
          name: 'API-query-data-source',
          arguments: {
            data: nestedData,
          },
        },
      })

      // Verify nested objects were also deserialized
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          data: {
            parent: { page_id: 'parent-page-id' },
          },
        },
      )
    })

    it('should preserve non-JSON string parameters', async () => {
      const mockResponse = {
        data: { success: true },
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }
      ;(HttpClient.prototype.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse)

      ;(proxy as any).openApiLookup = {
        'API-post-search': {
          operationId: 'post-search',
          responses: { '200': { description: 'Success' } },
          method: 'post',
          path: '/search',
        },
      }

      const server = (proxy as any).server
      const handlers = server.setRequestHandler.mock.calls.flatMap((x: unknown[]) => x).filter((x: unknown) => typeof x === 'function')
      const callToolHandler = handlers[1]

      await callToolHandler({
        params: {
          name: 'API-post-search',
          arguments: {
            query: 'hello world', // Regular string, should NOT be parsed
            filter: '{ not valid json }', // Looks like JSON but isn't valid
          },
        },
      })

      // Verify that non-JSON strings are preserved as-is
      expect(HttpClient.prototype.executeOperation).toHaveBeenCalledWith(
        expect.anything(),
        {
          query: 'hello world',
          filter: '{ not valid json }',
        },
      )
    })
  })
})
