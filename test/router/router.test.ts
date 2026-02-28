import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { OhMyNotionRouter } from '../../src/router/router'
import { buildChildEnv, looksEmptyReadResult } from '../../src/router/utils'
import { findMcpRemoteTokenFile } from '../../src/router/doctor'

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('OhMyNotionRouter', () => {
  it('buildRoutingTable exposes official tool surface when official backend exists', () => {
    const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

    router.fast = {
      tools: [{ name: 'search' }, { name: 'retrieve-a-page' }, { name: 'fast-only-tool' }],
    } as any
    router.official = {
      tools: [{ name: 'search' }, { name: 'fetch' }, { name: 'notion-create-pages' }],
    } as any

    router.buildRoutingTable()

    const exposedNames = router.exposedTools.map((tool: { name: string }) => tool.name).sort()
    expect(exposedNames).toEqual(['fetch', 'notion-create-pages', 'search'])
    expect(router.routes.has('fast-only-tool')).toBe(false)
    expect(router.routes.get('search')!.mode).toBe('fast-then-official-same-name')
    expect(router.routes.get('fetch')!.mode).toBe('official-with-fast-boost')
  })

  it('buildRoutingTable blocks write tools when official backend is unavailable', () => {
    const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })
    router.fast = {
      tools: [{ name: 'search' }, { name: 'create-page' }, { name: 'get-users' }],
    } as any
    router.official = null

    router.buildRoutingTable()

    const exposedNames = router.exposedTools.map((tool: { name: string }) => tool.name).sort()
    expect(exposedNames).toEqual(['get-users', 'search'])
    expect(router.routes.has('create-page')).toBe(false)
  })

  it('tryFastGetUsers forwards caller arguments to fast tool', async () => {
    const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

    let call: { toolName: string; args: Record<string, unknown> } | null = null
    router.fast = {
      findToolName(candidates: string[]) {
        if (candidates.includes('API-get-users')) return 'API-get-users'
        return undefined
      },
    } as any
    router.callFastOrError = async (toolName: string, args: Record<string, unknown>) => {
      call = { toolName, args }
      return { content: [], isError: false }
    }

    await router.tryFastGetUsers({ query: 'john', page_size: 3 })

    expect(call).toEqual({
      toolName: 'API-get-users',
      args: { query: 'john', page_size: 3 },
    })
  })

  it('tryFastFetch skips boost when extra fetch args are present', async () => {
    const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

    let called = false
    router.fast = {
      findToolName() {
        return 'API-retrieve-a-page'
      },
    } as any
    router.callFastOrError = async () => {
      called = true
      return { content: [], isError: false }
    }

    const result = await router.tryFastFetch({ id: 'abc123', include_discussions: true })

    expect(result).toBe(null)
    expect(called).toBe(false)
  })
})

describe('buildChildEnv', () => {
  it('allowlists environment variables', () => {
    const snapshot = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MY_SECRET: process.env.MY_SECRET,
    }

    try {
      process.env.PATH = '/usr/bin'
      process.env.HOME = '/tmp/home'
      process.env.MY_SECRET = 'should-not-leak'
      const env = buildChildEnv({ EXTRA_KEY: 'ok' })

      expect(env.PATH).toBe('/usr/bin')
      expect(env.HOME).toBe('/tmp/home')
      expect(env.EXTRA_KEY).toBe('ok')
      expect(env.MY_SECRET).toBe(undefined)
    } finally {
      restoreEnv(snapshot)
    }
  })
})

describe('findMcpRemoteTokenFile', () => {
  it('selects a valid token payload', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohmy-notionmcp-auth-'))
    const hash = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const snapshot = {
      MCP_REMOTE_CONFIG_DIR: process.env.MCP_REMOTE_CONFIG_DIR,
    }

    try {
      const v1 = path.join(baseDir, 'mcp-remote-0.1.0')
      const v2 = path.join(baseDir, 'mcp-remote-0.2.0')
      fs.mkdirSync(v1, { recursive: true })
      fs.mkdirSync(v2, { recursive: true })

      fs.writeFileSync(path.join(v1, `${hash}_tokens.json`), '{"bad_json":true}', 'utf8')
      const expected = path.join(v2, `${hash}_tokens.json`)
      fs.writeFileSync(
        expected,
        JSON.stringify({
          access_token: 'token',
          refresh_token: 'refresh',
          token_type: 'bearer',
        }),
        'utf8',
      )

      process.env.MCP_REMOTE_CONFIG_DIR = baseDir
      const found = findMcpRemoteTokenFile(hash)
      expect(found).toBe(expected)
    } finally {
      restoreEnv(snapshot)
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})

describe('looksEmptyReadResult', () => {
  it('identifies structured empty payloads', () => {
    expect(
      looksEmptyReadResult({
        content: [{ type: 'text', text: '{"results":[]}' }],
        isError: false,
      }),
    ).toBe(true)

    expect(
      looksEmptyReadResult({
        content: [{ type: 'text', text: '{"results":[{"id":"1"}]}' }],
        isError: false,
      }),
    ).toBe(false)
  })
})
