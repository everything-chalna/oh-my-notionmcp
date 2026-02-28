import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { HttpClient, HttpClientError } from '../client/http-client'
import { OpenAPIV3 } from 'openapi-types'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { isReadOnlyOperationAllowlisted } from './read-only-allowlist'
import { ReadResponseCache } from '../cache/read-response-cache'
import { parseCacheConfig } from '../cache/cache-config'
import { createCacheKey } from '../cache/cache-key'
import { splitProxyCacheParams } from './proxy-cache-params'
import { createHash } from 'node:crypto'
import { parseLocalAppCacheConfig } from '../local-app-cache/config'
import { NotionAppSqliteCache } from '../local-app-cache/notion-app-sqlite-cache'

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

/**
 * Recursively deserialize stringified JSON values in parameters.
 * This handles the case where MCP clients (like Cursor, Claude Code) double-serialize
 * nested object parameters, sending them as JSON strings instead of objects.
 *
 * @see https://github.com/makenotion/notion-mcp-server/issues/176
 */
function deserializeParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      // Check if the string looks like a JSON object or array
      const trimmed = value.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          const parsed = JSON.parse(value)
          // Only use parsed value if it's an object or array
          if (typeof parsed === 'object' && parsed !== null) {
            // Recursively deserialize nested objects
            result[key] = Array.isArray(parsed)
              ? parsed
              : deserializeParams(parsed as Record<string, unknown>)
            continue
          }
        } catch {
          // If parsing fails, keep the original string value
        }
      }
    }
    result[key] = value
  }

  return result
}

const READ_ONLY_BLOCK_MESSAGE = 'This MCP server is read-only and only supports allowlisted operations.'
const READ_ONLY_BLOCK_GUIDANCE = 'Use the official Notion MCP server for write operations.'
const CACHE_CONTEXT_KEY = '__mcpFastContext'

type CachedMcpToolResponse = {
  content: Array<{
    type: 'text'
    text: string
  }>
}

let hasLoggedLocalAppCacheTrustWarning = false

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private tools: Record<string, NewToolDefinition>
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>
  private toolNameAliases: Record<string, string | null>
  private responseCache: ReadResponseCache<CachedMcpToolResponse> | null
  private readonly authFingerprint: string
  private readonly baseUrl: string
  private readonly persistCacheToDisk: boolean
  private localAppCache: NotionAppSqliteCache | null

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.baseUrl = baseUrl
    const headers = this.parseHeadersFromEnv()
    this.authFingerprint = this.buildAuthFingerprint(headers)
    this.persistCacheToDisk = process.env.NODE_ENV !== 'test'
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers,
      },
      openApiSpec,
    )
    this.responseCache = this.initializeResponseCache()
    this.localAppCache = this.initializeLocalAppCache()

    // Convert OpenAPI spec to MCP tools
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { tools, openApiLookup } = converter.convertToMCPTools()
    this.openApiLookup = openApiLookup
    const allowlistedLookup = this.filterAllowlistedOperations(openApiLookup)
    this.tools = this.filterToolDefinitions(tools, allowlistedLookup)
    this.toolNameAliases = this.buildToolNameAliases(openApiLookup)

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = []

      // Add methods as separate tools to match the MCP format
      Object.entries(this.tools).forEach(([toolName, def]) => {
        def.methods.forEach(method => {
          const toolNameWithMethod = `${toolName}-${method.name}`
          const truncatedToolName = this.truncateToolName(toolNameWithMethod)

          tools.push({
            name: truncatedToolName,
            description: method.description,
            inputSchema: method.inputSchema as Tool['inputSchema'],
            annotations: {
              title: this.operationIdToTitle(method.name),
              readOnlyHint: true,
            },
          })
        })
      })

      return { tools }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      // Find the operation in OpenAPI spec
      const operation = this.findOperation(name)
      if (!operation) {
        throw new Error(`Method ${name} not found`)
      }

      if (!this.isOperationAllowlisted(operation)) {
        return this.createReadOnlyBlockedResponse(name, operation)
      }

      // Deserialize any stringified JSON parameters (fixes double-serialization bug)
      // See: https://github.com/makenotion/notion-mcp-server/issues/176
      const deserializedParams = params ? deserializeParams(params as Record<string, unknown>) : {}
      const { sanitizedParams, forceRefresh } = splitProxyCacheParams(deserializedParams)
      const cacheKey = this.buildResponseCacheKey(operation, sanitizedParams)

      if (!forceRefresh) {
        const cachedResponse = this.responseCache?.get(cacheKey)
        if (cachedResponse) {
          return cachedResponse
        }
      }

      if (!forceRefresh) {
        try {
          const localData = await this.localAppCache?.query(operation.operationId, sanitizedParams)
          // Contract: local app cache returns null on miss (fall through to Notion API).
          // Any non-null value is an authoritative local hit and should be returned as-is.
          if (localData !== null && localData !== undefined) {
            const mcpResponse = this.toMcpToolResponse(localData)
            this.responseCache?.set(cacheKey, mcpResponse)
            return mcpResponse
          }
        } catch (error) {
          console.warn('Failed to read from Notion app local cache. Falling back to Notion API.', error)
        }
      }

      try {
        // Execute the operation
        const response = await this.httpClient.executeOperation(operation, sanitizedParams)
        const mcpResponse = this.toMcpToolResponse(response.data)

        this.responseCache?.set(cacheKey, mcpResponse)
        if (this.persistCacheToDisk) {
          void this.responseCache?.save().catch((error) => {
            console.warn('Failed to persist response cache:', error)
          })
        }

        // Convert response to MCP format
        return mcpResponse
      } catch (error) {
        console.error('Error in tool call', error)
        if (error instanceof HttpClientError) {
          console.error('HttpClientError encountered, returning structured error', error)
          const data = error.data?.response?.data ?? error.data ?? {}
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error', // TODO: get this from http status code?
                  ...(typeof data === 'object' ? data : { data: data }),
                }),
              },
            ],
            isError: true,
          }
        }
        throw error
      }
    })
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    if (this.openApiLookup[operationId]) {
      return this.openApiLookup[operationId]
    }

    const canonicalName = this.toolNameAliases[operationId]
    if (!canonicalName) {
      return null
    }

    return this.openApiLookup[canonicalName] ?? null
  }

  private initializeResponseCache(): ReadResponseCache<CachedMcpToolResponse> | null {
    try {
      const cacheConfig = parseCacheConfig()
      if (!cacheConfig.enabled) {
        return null
      }

      const cache = new ReadResponseCache<CachedMcpToolResponse>({
        cacheFilePath: cacheConfig.path,
        ttlMs: cacheConfig.ttlMs,
        maxEntries: cacheConfig.maxEntries,
      })
      void cache.load().catch((error) => {
        console.warn('Failed to load response cache:', error)
      })
      return cache
    } catch (error) {
      console.warn('Failed to initialize response cache. Cache is disabled for this process.', error)
      return null
    }
  }

  private initializeLocalAppCache(): NotionAppSqliteCache | null {
    try {
      const config = parseLocalAppCacheConfig()
      if (!config.enabled) {
        if (config.requestedEnabled && !config.trustEnabled && !hasLoggedLocalAppCacheTrustWarning) {
          console.warn(
            'Local app cache requested but not trusted; set NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED=true to activate.',
          )
          hasLoggedLocalAppCacheTrustWarning = true
        }
        return null
      }
      return new NotionAppSqliteCache(config)
    } catch (error) {
      console.warn('Failed to initialize Notion app local cache. Local cache is disabled.', error)
      return null
    }
  }

  private buildAuthFingerprint(headers: Record<string, string>): string {
    const authorization = headers.Authorization ?? headers.authorization ?? ''
    const notionVersion = headers['Notion-Version'] ?? headers['notion-version'] ?? ''
    return createHash('sha256').update(`${authorization}|${notionVersion}`).digest('hex')
  }

  private buildResponseCacheKey(
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
    params: Record<string, unknown>,
  ): string {
    return createCacheKey(
      {
        method: operation.method,
        path: operation.path,
        operationId: operation.operationId,
      },
      {
        ...params,
        [CACHE_CONTEXT_KEY]: {
          authFingerprint: this.authFingerprint,
          baseUrl: this.baseUrl,
        },
      },
    )
  }

  private toMcpToolResponse(data: unknown): CachedMcpToolResponse {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(data),
        },
      ],
    }
  }

  private filterAllowlistedOperations(
    openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>,
  ): Record<string, OpenAPIV3.OperationObject & { method: string; path: string }> {
    return Object.fromEntries(
      Object.entries(openApiLookup).filter(([, operation]) => this.isOperationAllowlisted(operation)),
    )
  }

  private filterToolDefinitions(
    tools: Record<string, NewToolDefinition>,
    filteredLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>,
  ): Record<string, NewToolDefinition> {
    const filteredTools: Record<string, NewToolDefinition> = {}

    for (const [toolName, definition] of Object.entries(tools)) {
      const methods = definition.methods.filter((method) =>
        Object.prototype.hasOwnProperty.call(filteredLookup, `${toolName}-${method.name}`),
      )
      if (methods.length > 0) {
        filteredTools[toolName] = { methods }
      }
    }

    return filteredTools
  }

  private buildToolNameAliases(
    openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>,
  ): Record<string, string | null> {
    const aliases: Record<string, string | null> = {}

    for (const canonicalName of Object.keys(openApiLookup)) {
      const truncatedName = this.truncateToolName(canonicalName)
      if (!Object.prototype.hasOwnProperty.call(aliases, truncatedName)) {
        aliases[truncatedName] = canonicalName
        continue
      }

      if (aliases[truncatedName] !== canonicalName) {
        // Ambiguous truncated names are intentionally unresolvable.
        aliases[truncatedName] = null
      }
    }

    return aliases
  }

  private isOperationAllowlisted(operation: OpenAPIV3.OperationObject & { method: string; path: string }): boolean {
    return isReadOnlyOperationAllowlisted({
      method: operation.method,
      operationId: operation.operationId,
    })
  }

  private createReadOnlyBlockedResponse(
    toolName: string,
    operation: OpenAPIV3.OperationObject & { method: string; path: string },
  ) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            code: 'READ_ONLY_OPERATION_BLOCKED',
            message: READ_ONLY_BLOCK_MESSAGE,
            guidance: READ_ONLY_BLOCK_GUIDANCE,
            attemptedOperation: {
              toolName,
              operationId: operation.operationId ?? null,
              method: operation.method.toUpperCase(),
              path: operation.path,
            },
          }),
        },
      ],
      isError: true,
    }
  }

  private parseHeadersFromEnv(): Record<string, string> {
    // First try OPENAPI_MCP_HEADERS (existing behavior)
    const headersJson = process.env.OPENAPI_MCP_HEADERS
    if (headersJson) {
      try {
        const headers = JSON.parse(headersJson)
        if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
          const receivedType = Array.isArray(headers) ? 'array' : typeof headers
          console.warn('OPENAPI_MCP_HEADERS environment variable must be a JSON object, got:', receivedType)
        } else if (Object.keys(headers).length > 0) {
          const headerEntries = Object.entries(headers as Record<string, unknown>)
          const hasNonStringValue = headerEntries.some(([, value]) => typeof value !== 'string')
          if (hasNonStringValue) {
            console.warn('OPENAPI_MCP_HEADERS values must be strings.')
            // Fall through to try NOTION_TOKEN.
          } else {
            // Only use OPENAPI_MCP_HEADERS if it contains actual headers
            return headers as Record<string, string>
          }
        }
        // If OPENAPI_MCP_HEADERS is empty object, fall through to try NOTION_TOKEN
      } catch (error) {
        console.warn('Failed to parse OPENAPI_MCP_HEADERS environment variable:', error)
        // Fall through to try NOTION_TOKEN
      }
    }

    // Alternative: try NOTION_TOKEN
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      return {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2025-09-03'
      }
    }

    return {}
  }

  private getContentType(headers: Headers): 'text' | 'image' | 'binary' {
    const contentType = headers.get('content-type')
    if (!contentType) return 'binary'

    if (contentType.includes('text') || contentType.includes('json')) {
      return 'text'
    } else if (contentType.includes('image')) {
      return 'image'
    }
    return 'binary'
  }

  private truncateToolName(name: string): string {
    if (name.length <= 64) {
      return name;
    }
    return name.slice(0, 64);
  }

  /**
   * Convert an operationId like "createDatabase" to a human-readable title like "Create Database"
   */
  private operationIdToTitle(operationId: string): string {
    // Split on camelCase boundaries and capitalize each word
    return operationId
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_-]+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  async connect(transport: Transport) {
    // The SDK will handle stdio communication
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
