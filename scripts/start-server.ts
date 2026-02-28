/**
 * Backward-compatible entry point for the standalone fast server.
 * The actual implementation now lives in src/main.ts (commandServeFast).
 * This file exists so that test imports from `scripts/start-server` continue to work.
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'

import { initProxy } from '../src/fast/init-server.js'
import { parseLocalAppCacheConfig } from '../src/fast/openapi-mcp-server/local-app-cache/config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

interface StartServerOptions {
  transport: string
  port: number
  authToken: string | undefined
  disableAuth: boolean
}

function parseArgs(args: string[]): StartServerOptions {
  const cliArgs = args.slice(2)
  let transport = 'stdio'
  let port = 3000
  let authToken: string | undefined
  let disableAuth = false

  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '--transport' && i + 1 < cliArgs.length) {
      transport = cliArgs[i + 1]
      i++
    } else if (cliArgs[i] === '--port' && i + 1 < cliArgs.length) {
      port = parseInt(cliArgs[i + 1], 10)
      i++
    } else if (cliArgs[i] === '--auth-token' && i + 1 < cliArgs.length) {
      authToken = cliArgs[i + 1]
      i++
    } else if (cliArgs[i] === '--disable-auth') {
      disableAuth = true
    }
  }

  return { transport: transport.toLowerCase(), port, authToken, disableAuth }
}

export async function startServer(args: string[] = process.argv) {
  const specPath = path.resolve(__dirname, 'notion-openapi.json')
  const baseUrl = process.env.BASE_URL ?? undefined
  const options = parseArgs(args)

  if (options.transport === 'stdio') {
    const proxy = await initProxy(specPath, baseUrl)
    await proxy.connect(new StdioServerTransport())
    return proxy.getServer()
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
        console.log(`Generated auth token: ${authToken}`)
        console.log(`Use this token in the Authorization header: Bearer ${authToken}`)
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

    return { close: () => {} }
  }

  throw new Error(`Unsupported transport: ${options.transport}. Use 'stdio' or 'http'.`)
}
