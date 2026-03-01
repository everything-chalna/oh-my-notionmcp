import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'

import { initProxy, ValidationError } from './fast/init-server.js'
import { parseLocalAppCacheConfig } from './fast/openapi-mcp-server/local-app-cache/config.js'
import { resolveOfficialBackendConfig } from './router/config.js'
import { commandDoctor, extractMcpRemoteHashContext, hashForMcpRemoteContext, getMcpRemoteServerHash } from './router/doctor.js'
import { commandInstall } from './router/install.js'
import { commandLogin } from './router/login.js'
import { OhMyNotionRouter } from './router/router.js'
import {
  APP_BIN_NAME,
  APP_DISPLAY_NAME,
  findAndClearTokenCache,
  parseArgs,
  printHelp,
  type ParsedOptions,
} from './router/utils.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function resolveSpecPath(): string {
  return path.resolve(__dirname, '../scripts/notion-openapi.json')
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function printUnifiedHelp(): void {
  printHelp()
  console.log(`  ${APP_BIN_NAME} reauth
  ${APP_BIN_NAME} serve-fast [--transport <stdio|http>] [--port <number>] [--auth-token <token>] [--disable-auth]

Commands (continued):
  reauth      Clear OAuth token cache for official MCP backend
              Removes cached tokens, run 'login' again to re-authenticate

  serve-fast  Start standalone fast read-only MCP server
              Supports stdio (default) and HTTP transports

serve-fast Options:
  --transport <type>     Transport type: 'stdio' or 'http' (default: stdio)
  --port <number>        Port for HTTP server (default: 3000)
  --auth-token <token>   Bearer token for HTTP transport authentication
  --disable-auth         Disable bearer token authentication (unsafe)

serve-fast Environment Variables:
  NOTION_TOKEN                                Notion integration token
  OPENAPI_MCP_HEADERS                         JSON string with Notion API headers
  AUTH_TOKEN                                  Bearer token for HTTP transport
  NOTION_MCP_FAST_CACHE_ENABLED               Enable/disable read response cache (default: true)
  NOTION_MCP_FAST_CACHE_TTL_MS                Cache TTL in milliseconds (default: 30000)
  NOTION_MCP_FAST_CACHE_MAX_ENTRIES           Maximum cache entries (default: 300)
  NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED     Local DB fast-path gate (default: false)
  NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED  Local DB trust gate (default: false)
`)
}

function commandReauth(_options?: ParsedOptions): void {
  const officialBackend = resolveOfficialBackendConfig()
  const ctx = extractMcpRemoteHashContext(officialBackend.command, officialBackend.args)
  const contextHash = hashForMcpRemoteContext(ctx.serverUrl, ctx.authorizeResource, ctx.headers)
  const defaultHash = getMcpRemoteServerHash()
  const candidateHashes = [...new Set([defaultHash, contextHash])]

  let totalDeleted = 0
  const allSearchedDirs: string[] = []

  for (const hash of candidateHashes) {
    const result = findAndClearTokenCache(hash)
    totalDeleted += result.deletedFiles
    allSearchedDirs.push(...result.searchedDirs)
  }

  if (totalDeleted > 0) {
    console.log(`Cleared ${totalDeleted} OAuth token cache file(s)`)
    console.log(`Searched directories: ${[...new Set(allSearchedDirs)].join(', ')}`)
  } else {
    console.log('No OAuth token cache files found to clear')
  }

  console.log('')
  console.log('Next steps:')
  console.log(`1) ${APP_BIN_NAME} login     (re-authenticate with Notion)`)
  console.log(`2) ${APP_BIN_NAME} doctor    (verify configuration)`)
}

async function commandServe(): Promise<void> {
  const officialBackend = resolveOfficialBackendConfig()

  const router = new OhMyNotionRouter({
    officialBackend,
  })

  await router.start()
}

interface ServeFastOptions {
  transport: string
  port: number
  authToken: string | undefined
  disableAuth: boolean
}

function parseServeFastArgs(argv: string[]): ServeFastOptions {
  let transport = 'stdio'
  let port = 3000
  let authToken: string | undefined
  let disableAuth = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--transport' && i + 1 < argv.length) {
      transport = argv[i + 1]
      i++
    } else if (argv[i] === '--port' && i + 1 < argv.length) {
      port = parseInt(argv[i + 1], 10)
      i++
    } else if (argv[i] === '--auth-token' && i + 1 < argv.length) {
      authToken = argv[i + 1]
      i++
    } else if (argv[i] === '--disable-auth') {
      disableAuth = true
    }
  }

  return { transport: transport.toLowerCase(), port, authToken, disableAuth }
}

async function commandServeFast(argv: string[]): Promise<void> {
  const specPath = resolveSpecPath()
  const baseUrl = process.env.BASE_URL ?? undefined
  const options = parseServeFastArgs(argv)

  if (options.transport === 'stdio') {
    const proxy = await initProxy(specPath, baseUrl)
    await proxy.connect(new StdioServerTransport())
    return
  }

  if (options.transport === 'http') {
    if (options.disableAuth) {
      process.env.NOTION_MCP_FAST_CACHE_ENABLED = 'false'
    }

    const localAppCacheConfig = parseLocalAppCacheConfig()
    if (options.disableAuth && localAppCacheConfig.enabled) {
      throw new Error(
        'Refusing to start HTTP transport with --disable-auth while local app fast-path is enabled (trusted local DB boundary). ' +
          'Either remove --disable-auth or set NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED=false.',
      )
    }

    const app = express()
    app.use(express.json())

    let authToken: string | undefined
    if (!options.disableAuth) {
      authToken = options.authToken || process.env.AUTH_TOKEN || randomBytes(32).toString('hex')
      if (!options.authToken && !process.env.AUTH_TOKEN) {
        console.error(`Generated auth token: ${authToken}`)
        console.error(`Use this token in the Authorization header: Bearer ${authToken}`)
      }
    }

    const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
      const authHeader = readSingleHeader(req.headers['authorization'])
      if (!authHeader) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: Missing bearer token' },
          id: null,
        })
        return
      }

      const parts = authHeader.trim().split(/\s+/)
      const scheme = parts[0]?.toLowerCase()
      const token = parts[1]
      if (scheme !== 'bearer' || !token) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized: Missing bearer token' },
          id: null,
        })
        return
      }

      if (token !== authToken) {
        res.status(403).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'Forbidden: Invalid bearer token' },
          id: null,
        })
        return
      }

      next()
    }

    app.get('/health', (_req, res) => {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        transport: 'http',
        port: options.port,
      })
    })

    if (!options.disableAuth) {
      app.use('/mcp', authenticateToken)
    }

    const transports = new Map<string, StreamableHTTPServerTransport>()

    app.post('/mcp', async (req, res) => {
      try {
        const sessionId = readSingleHeader(req.headers['mcp-session-id'])
        let transport: StreamableHTTPServerTransport

        if (sessionId && transports.has(sessionId)) {
          transport = transports.get(sessionId) as StreamableHTTPServerTransport
        } else if (!sessionId && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              transports.set(newSessionId, transport)
            },
          })

          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId)
            }
          }

          const proxy = await initProxy(specPath, baseUrl)
          await proxy.connect(transport)
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
          })
          return
        }

        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        }
      }
    })

    app.get('/mcp', async (req, res) => {
      try {
        const sessionId = readSingleHeader(req.headers['mcp-session-id'])
        if (!sessionId || !transports.has(sessionId)) {
          res.status(400).send('Invalid or missing session ID')
          return
        }

        const transport = transports.get(sessionId) as StreamableHTTPServerTransport
        await transport.handleRequest(req, res)
      } catch (error) {
        console.error('Error handling MCP GET request:', error)
        if (!res.headersSent) {
          res.status(500).send('Internal server error')
        }
      }
    })

    app.delete('/mcp', async (req, res) => {
      try {
        const sessionId = readSingleHeader(req.headers['mcp-session-id'])
        if (!sessionId || !transports.has(sessionId)) {
          res.status(400).send('Invalid or missing session ID')
          return
        }

        const transport = transports.get(sessionId) as StreamableHTTPServerTransport
        await transport.handleRequest(req, res)
      } catch (error) {
        console.error('Error handling MCP DELETE request:', error)
        if (!res.headersSent) {
          res.status(500).send('Internal server error')
        }
      }
    })

    app.listen(options.port, '0.0.0.0', () => {
      console.log(`MCP Server listening on port ${options.port}`)
      console.log(`Endpoint: http://0.0.0.0:${options.port}/mcp`)
      console.log(`Health check: http://0.0.0.0:${options.port}/health`)
      if (options.disableAuth) {
        console.log('Authentication: Disabled')
      } else {
        console.log('Authentication: Bearer token required')
        if (options.authToken) {
          console.log('Using provided auth token')
        }
      }
    })

    return
  }

  throw new Error(`Unsupported transport: ${options.transport}. Use 'stdio' or 'http'.`)
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUnifiedHelp()
    return
  }

  const options = parseArgs(rest)

  if (command === 'install') {
    commandInstall(options)
    return
  }

  if (command === 'login') {
    commandLogin(options)
    return
  }

  if (command === 'reauth') {
    commandReauth(options)
    return
  }

  if (command === 'doctor') {
    commandDoctor(options)
    return
  }

  if (command === 'serve') {
    await commandServe()
    return
  }

  if (command === 'serve-fast') {
    await commandServeFast(rest)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

function resolveBinPath(): string {
  return fileURLToPath(import.meta.url)
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false
  try {
    const argvPath = fs.realpathSync(process.argv[1])
    const binPath = fs.realpathSync(resolveBinPath())
    return argvPath === binPath
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((error) => {
    if (error instanceof ValidationError) {
      console.error('Invalid OpenAPI 3.1 specification:')
      error.errors.forEach((err: unknown) => console.error(err))
    } else {
      console.error(error instanceof Error ? error.message : String(error))
    }
    process.exit(1)
  })
}

export { main, commandServeFast }
