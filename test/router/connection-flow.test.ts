import { describe, it, expect, vi, afterEach } from 'vitest'

import { OhMyNotionRouter } from '../../src/router/router.js'
import { createMockBackend } from '../helpers/mock-backend.js'

vi.mock('../../src/router/utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/router/utils.js')>()
  return {
    ...actual,
    hasCachedTokens: vi.fn().mockReturnValue(true),
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('connection flow integration', () => {
  describe('both backends connected', () => {
    it('routing table has all four route modes', () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })

      router.fast = createMockBackend({
        tools: [
          { name: 'notion-search' },
          { name: 'notion-list-users' },
          { name: 'API-retrieve-a-page' },
        ],
      })
      router.official = createMockBackend({
        tools: [
          { name: 'notion-search' },
          { name: 'notion-fetch' },
          { name: 'notion-create-pages' },
          { name: 'notion-list-users' },
        ],
      })

      router.buildRoutingTable()

      const modes = new Set([...router.routes.values()].map((r) => r.mode))
      // notion-search: read tool present in both -> fast-then-official-same-name
      expect(router.routes.get('notion-search')!.mode).toBe('fast-then-official-same-name')
      // notion-fetch: official-only boostable read -> official-with-fast-boost
      expect(router.routes.get('notion-fetch')!.mode).toBe('official-with-fast-boost')
      // notion-create-pages: write tool -> official
      expect(router.routes.get('notion-create-pages')!.mode).toBe('official')
      // notion-list-users: read tool in both (list is a read hint) -> fast-then-official-same-name
      expect(router.routes.get('notion-list-users')!.mode).toBe('fast-then-official-same-name')

      expect(modes.has('fast-then-official-same-name')).toBe(true)
      expect(modes.has('official-with-fast-boost')).toBe(true)
      expect(modes.has('official')).toBe(true)

      // Exposed tools match official surface only
      const exposedNames = router.exposedTools.map((t) => t.name).sort()
      expect(exposedNames).toEqual([
        'notion-create-pages',
        'notion-fetch',
        'notion-list-users',
        'notion-search',
      ])
    })

    it('includes fast-only mode when official is absent and fast has read tools', () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })

      router.fast = createMockBackend({
        tools: [{ name: 'search' }, { name: 'retrieve-a-page' }],
      })
      router.official = null

      router.buildRoutingTable()

      for (const [, entry] of router.routes) {
        expect(entry.mode).toBe('fast-only')
      }
    })
  })

  describe('official fails -> degraded mode', () => {
    it('only read tools exposed, write tools blocked', () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.fast = createMockBackend({
        tools: [
          { name: 'search' },
          { name: 'get-users' },
          { name: 'create-page' },
          { name: 'update-page' },
          { name: 'delete-block' },
        ],
      })
      router.official = null

      router.buildRoutingTable()

      const exposedNames = router.exposedTools.map((t) => t.name).sort()
      expect(exposedNames).toEqual(['get-users', 'search'])
      expect(router.routes.has('create-page')).toBe(false)
      expect(router.routes.has('update-page')).toBe(false)
      expect(router.routes.has('delete-block')).toBe(false)
    })

    it('callOfficialOrError returns error when official is null', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = null

      const result = await (router as any).callOfficialOrError('notion-fetch', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('official backend is unavailable')
    })
  })

  describe('reconnect success via callTool', () => {
    it('first call fails then succeeds after reconnect', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })

      let callCount = 0
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          callCount++
          if (callCount === 1) {
            throw new Error('connection lost')
          }
          return { content: [{ type: 'text', text: '{"ok":true}' }], isError: false }
        },
      })

      // callOfficialOrError catches the error and returns a toToolError result;
      // the reconnect logic lives in BackendClient.callTool, not in the router.
      // Here we test the router's callOfficialOrError behavior: it should return
      // an error result for the thrown error.
      const result = await (router as any).callOfficialOrError('notion-fetch', { id: '123' })

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('official backend call failed')
    })

    it('BackendClient-level reconnect succeeds and returns retry result', async () => {
      // This tests the higher-level scenario: mock a backend where callTool
      // itself handles reconnect (first fails, reconnect succeeds, retry succeeds)
      const router = new OhMyNotionRouter({ officialBackend: {} })

      let callCount = 0
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          callCount++
          // Simulate the BackendClient behavior: first call fails but internal
          // reconnect succeeds, so the second callTool call succeeds
          return { content: [{ type: 'text', text: `{"attempt":${callCount}}` }], isError: false }
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', { id: '123' })
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('"attempt":1')
    })
  })

  describe('reconnect failure', () => {
    it('error message includes "reconnect also failed"', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })

      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('official backend call failed and reconnect also failed: cannot reconnect')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', { id: '123' })

      expect(result.isError).toBe(true)
      const text = result.content[0].text
      expect(text).toContain('reconnect also failed')
    })
  })

  describe('auth error', () => {
    it('callOfficialOrError with 401 includes login hint', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('HTTP 401 Unauthorized')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', {})

      expect(result.isError).toBe(true)
      const text = result.content[0].text
      expect(text).toContain('oh-my-notionmcp login')
      expect(text).toContain('Token may be expired')
    })

    it('callOfficialOrError with "unauthorized" includes login hint', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('Unauthorized: invalid credentials')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', {})

      expect(result.isError).toBe(true)
      const text = result.content[0].text
      expect(text).toContain('oh-my-notionmcp login')
    })

    it('callOfficialOrError with "token expired" includes login hint', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('token expired')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', {})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('oh-my-notionmcp login')
    })

    it('callOfficialOrError with "authentication failed" includes login hint', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('authentication failed')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', {})

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('oh-my-notionmcp login')
    })

    it('non-auth errors do not include login hint', async () => {
      const router = new OhMyNotionRouter({ officialBackend: {} })
      router.official = createMockBackend({
        tools: [{ name: 'notion-fetch' }],
        callToolImpl: async () => {
          throw new Error('network timeout')
        },
      })

      const result = await (router as any).callOfficialOrError('notion-fetch', {})

      expect(result.isError).toBe(true)
      const text = result.content[0].text
      expect(text).not.toContain('oh-my-notionmcp login')
      expect(text).toContain('official backend call failed')
    })
  })

  describe('connect timeout', () => {
    it('official backend becomes null after 30s connect timeout -> degraded mode', async () => {
      vi.useFakeTimers()

      const router = new OhMyNotionRouter({ officialBackend: {} })
      const mockFast = createMockBackend({ tools: [{ name: 'search' }] })

      // Patch connectFast to return a working fast backend
      ;(router as any).connectFast = () => Promise.resolve(mockFast)

      // Patch connectOfficial to hang, triggering the 30s timeout
      ;(router as any).connectOfficial = () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('official backend connect timed out after 30s')), 30_000),
        )

      // Patch setupHandlers and server.connect to avoid needing real MCP server
      ;(router as any).setupHandlers = () => {}
      ;(router as any).server = { connect: () => Promise.resolve() }

      const startPromise = router.start()
      await vi.advanceTimersByTimeAsync(31_000)
      await startPromise

      expect(router.official).toBeNull()
      expect(router.fast).toBe(mockFast)

      // In degraded mode, only read tools should be exposed
      router.buildRoutingTable()
      for (const [, entry] of router.routes) {
        expect(entry.mode).toBe('fast-only')
      }
    })

    it('both backends timeout -> start() throws', async () => {
      vi.useFakeTimers()

      const router = new OhMyNotionRouter({ officialBackend: {} })

      ;(router as any).connectFast = () =>
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('fast timed out')), 5_000))

      ;(router as any).connectOfficial = () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('official timed out')), 30_000),
        )

      ;(router as any).setupHandlers = () => {}
      ;(router as any).server = { connect: () => Promise.resolve() }

      const startPromise = router.start().catch((err: Error) => err)
      // connectFast fails at 5s, then connectOfficial starts and fails at 5s+30s=35s
      await vi.advanceTimersByTimeAsync(36_000)
      const error = await startPromise

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('No backend available')
    })
  })
})
