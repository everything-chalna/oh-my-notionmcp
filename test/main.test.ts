import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock dependencies before importing the module under test
const mockInitProxy = vi.fn()
const mockConnect = vi.fn()
const mockStdioTransport = vi.fn()
const mockResolveOfficialBackendConfig = vi.fn()

vi.mock('../src/fast/init-server.js', () => ({
  initProxy: mockInitProxy,
  ValidationError: class ValidationError extends Error {
    constructor(public errors: any[]) {
      super('OpenAPI validation failed')
      this.name = 'ValidationError'
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: mockStdioTransport,
}))

vi.mock('../src/router/config.js', () => ({
  resolveOfficialBackendConfig: mockResolveOfficialBackendConfig,
}))

// We need to access parseServeFastArgs and commandServeFast.
// parseServeFastArgs is not exported but commandServeFast is.
// We test parseServeFastArgs behavior indirectly through commandServeFast.

describe('main.ts', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    mockInitProxy.mockResolvedValue({ connect: mockConnect })
    mockConnect.mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  describe('commandServeFast', () => {
    // We dynamically import to get fresh module state
    let commandServeFast: (argv: string[]) => Promise<void>

    beforeEach(async () => {
      const mod = await import('../src/main.js')
      commandServeFast = mod.commandServeFast
    })

    it('uses stdio transport by default (no args)', async () => {
      await commandServeFast([])

      expect(mockInitProxy).toHaveBeenCalledTimes(1)
      expect(mockStdioTransport).toHaveBeenCalledTimes(1)
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })

    it('uses stdio transport with explicit --transport stdio', async () => {
      await commandServeFast(['--transport', 'stdio'])

      expect(mockInitProxy).toHaveBeenCalledTimes(1)
      expect(mockStdioTransport).toHaveBeenCalledTimes(1)
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })

    it('throws on unsupported transport type', async () => {
      await expect(commandServeFast(['--transport', 'websocket'])).rejects.toThrow(
        "Unsupported transport: websocket. Use 'stdio' or 'http'.",
      )
    })

    it('passes BASE_URL env to initProxy when set', async () => {
      process.env.BASE_URL = 'https://custom.example.com'

      await commandServeFast([])

      expect(mockInitProxy).toHaveBeenCalledWith(
        expect.any(String),
        'https://custom.example.com',
      )
    })

    it('passes undefined baseUrl when BASE_URL env is not set', async () => {
      delete process.env.BASE_URL

      await commandServeFast([])

      expect(mockInitProxy).toHaveBeenCalledWith(expect.any(String), undefined)
    })

    it('resolves spec path ending with notion-openapi.json', async () => {
      await commandServeFast([])

      const specPath = mockInitProxy.mock.calls[0][0] as string
      expect(specPath).toMatch(/scripts\/notion-openapi\.json$/)
    })

    it('handles transport flag case-insensitively', async () => {
      await commandServeFast(['--transport', 'STDIO'])

      expect(mockStdioTransport).toHaveBeenCalledTimes(1)
      expect(mockConnect).toHaveBeenCalledTimes(1)
    })
  })

  describe('parseServeFastArgs (tested via commandServeFast behavior)', () => {
    let commandServeFast: (argv: string[]) => Promise<void>

    beforeEach(async () => {
      const mod = await import('../src/main.js')
      commandServeFast = mod.commandServeFast
    })

    it('defaults to port 3000 (no error when --port is not specified)', async () => {
      // Default port 3000 is used for http transport. With stdio, port is irrelevant.
      // We verify that no error occurs with default settings.
      await commandServeFast([])
      expect(mockInitProxy).toHaveBeenCalledTimes(1)
    })

    it('parses --port flag correctly', async () => {
      // With stdio transport, port isn't used but parsing should still work
      await commandServeFast(['--port', '8080'])
      expect(mockInitProxy).toHaveBeenCalledTimes(1)
    })

    it('parses --auth-token flag correctly', async () => {
      // With stdio transport, auth-token isn't used but parsing should still work
      await commandServeFast(['--auth-token', 'mytoken123'])
      expect(mockInitProxy).toHaveBeenCalledTimes(1)
    })

    it('parses --disable-auth flag correctly', async () => {
      await commandServeFast(['--disable-auth'])
      expect(mockInitProxy).toHaveBeenCalledTimes(1)
    })

    it('parses combined options correctly', async () => {
      await commandServeFast([
        '--transport',
        'stdio',
        '--port',
        '9999',
        '--auth-token',
        'secret',
        '--disable-auth',
      ])
      expect(mockInitProxy).toHaveBeenCalledTimes(1)
      expect(mockStdioTransport).toHaveBeenCalledTimes(1)
    })
  })
})
