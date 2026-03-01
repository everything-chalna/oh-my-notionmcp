import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { findAndClearTokenCache } from '../../src/router/utils.js'
import { OhMyNotionRouter } from '../../src/router/router.js'
import { createMockBackend } from '../helpers/mock-backend.js'
import { withEnvSnapshot } from '../helpers/env-snapshot.js'

// ─── findAndClearTokenCache ───────────────────────────────────────────────────

describe('findAndClearTokenCache', () => {
  it('deletes matching token files in mcp-remote-* dirs', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const versionDir = path.join(baseDir, 'mcp-remote-0.1.37')
        fs.mkdirSync(versionDir, { recursive: true })

        const hash = 'abc123def456'
        fs.writeFileSync(path.join(versionDir, `${hash}_tokens.json`), '{}')
        fs.writeFileSync(path.join(versionDir, `${hash}_client_info.json`), '{}')
        fs.writeFileSync(path.join(versionDir, `${hash}_code_verifier.txt`), 'verifier')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache(hash)

        expect(result.deletedFiles).toBe(3)
        expect(result.searchedDirs).toEqual([versionDir])
        expect(fs.existsSync(path.join(versionDir, `${hash}_tokens.json`))).toBe(false)
        expect(fs.existsSync(path.join(versionDir, `${hash}_client_info.json`))).toBe(false)
        expect(fs.existsSync(path.join(versionDir, `${hash}_code_verifier.txt`))).toBe(false)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('does not delete non-matching files', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const versionDir = path.join(baseDir, 'mcp-remote-0.1.37')
        fs.mkdirSync(versionDir, { recursive: true })

        const hash = 'abc123def456'
        const otherHash = 'zzz999other'
        fs.writeFileSync(path.join(versionDir, `${hash}_tokens.json`), '{}')
        fs.writeFileSync(path.join(versionDir, `${otherHash}_tokens.json`), '{}')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache(hash)

        expect(result.deletedFiles).toBe(1)
        expect(fs.existsSync(path.join(versionDir, `${otherHash}_tokens.json`))).toBe(true)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('returns 0 when no cache dir exists', async () => {
    await withEnvSnapshot(async () => {
      process.env.MCP_REMOTE_CONFIG_DIR = path.join(os.tmpdir(), 'nonexistent-dir-' + Date.now())
      const result = findAndClearTokenCache('somehash')

      expect(result.deletedFiles).toBe(0)
      expect(result.searchedDirs).toEqual([])
    })
  })

  it('returns 0 when no matching files exist', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const versionDir = path.join(baseDir, 'mcp-remote-0.1.37')
        fs.mkdirSync(versionDir, { recursive: true })

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache('nomatch')

        expect(result.deletedFiles).toBe(0)
        expect(result.searchedDirs).toEqual([versionDir])
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('handles hash subdirectory pattern', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const hash = 'abc123def456'
        const versionDir = path.join(baseDir, 'mcp-remote-0.1.37')
        const hashSubDir = path.join(versionDir, hash)
        fs.mkdirSync(hashSubDir, { recursive: true })

        const tokensFile = path.join(hashSubDir, 'tokens.json')
        fs.writeFileSync(tokensFile, '{"access_token":"old"}')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache(hash)

        expect(result.deletedFiles).toBe(1)
        expect(fs.existsSync(tokensFile)).toBe(false)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('handles multiple version dirs', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const hash = 'abc123def456'
        const v1 = path.join(baseDir, 'mcp-remote-0.1.37')
        const v2 = path.join(baseDir, 'mcp-remote-0.2.0')
        fs.mkdirSync(v1, { recursive: true })
        fs.mkdirSync(v2, { recursive: true })

        fs.writeFileSync(path.join(v1, `${hash}_tokens.json`), '{}')
        fs.writeFileSync(path.join(v2, `${hash}_tokens.json`), '{}')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache(hash)

        expect(result.deletedFiles).toBe(2)
        expect(result.searchedDirs.length).toBe(2)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('ignores non-mcp-remote directories', async () => {
    await withEnvSnapshot(async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-test-'))
      try {
        const hash = 'abc123def456'
        const unrelatedDir = path.join(baseDir, 'other-dir')
        fs.mkdirSync(unrelatedDir, { recursive: true })
        fs.writeFileSync(path.join(unrelatedDir, `${hash}_tokens.json`), '{}')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir
        const result = findAndClearTokenCache(hash)

        expect(result.deletedFiles).toBe(0)
        // unrelated dir should not be searched
        expect(result.searchedDirs).toEqual([])
        // file should still exist
        expect(fs.existsSync(path.join(unrelatedDir, `${hash}_tokens.json`))).toBe(true)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })
})

// ─── Router reauth meta tool ─────────────────────────────────────────────────

describe('router reauth meta tool', () => {
  it('handleReauth returns error when official is null and lazy connect fails', async () => {
    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = null
    // Patch connectOfficial to fail (simulates no auth / network error)
    ;(router as any).connectOfficial = () => Promise.reject(new Error('connect failed'))

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('oh-my-notionmcp login')
  })

  it('handleReauth returns error when backend has no reauth method', async () => {
    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = createMockBackend({ tools: [{ name: 'notion-fetch' }] })

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('does not support reauth')
  })

  it('handleReauth succeeds with BackendClient that has reauth', async () => {
    const mockOfficial = createMockBackend({ tools: [{ name: 'notion-fetch' }] })
    ;(mockOfficial as any).reauth = async () => ({
      status: 'reauth_triggered',
      message: 'OAuth tokens cleared (2 files). Backend reconnected.',
      deletedFiles: 2,
      searchedDirs: ['/tmp/.mcp-auth/mcp-remote-0.1.37'],
    })

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial
    router.buildRoutingTable()

    const result = await (router as any).handleReauth()

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.status).toBe('reauth_triggered')
    expect(parsed.deletedFiles).toBe(2)
    expect(parsed.message).toContain('OAuth tokens cleared')
    expect(parsed.searchedDirs).toEqual(['/tmp/.mcp-auth/mcp-remote-0.1.37'])
  })

  it('handleReauth includes toolCount after rebuild', async () => {
    const mockOfficial = createMockBackend({
      tools: [{ name: 'notion-fetch' }, { name: 'notion-search' }],
    })
    ;(mockOfficial as any).reauth = async () => ({
      status: 'reauth_triggered',
      message: 'OK',
      deletedFiles: 1,
      searchedDirs: [],
    })

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial
    router.buildRoutingTable()

    const result = await (router as any).handleReauth()

    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.toolCount).toBe(2)
  })

  it('handleReauth catches reauth errors', async () => {
    const mockOfficial = createMockBackend({ tools: [{ name: 'notion-fetch' }] })
    ;(mockOfficial as any).reauth = async () => {
      throw new Error('reconnect timed out after 10s')
    }

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Reauth failed')
    expect(result.content[0].text).toContain('reconnect timed out after 10s')
  })

  it('handleReauth with auth error includes login hint', async () => {
    const mockOfficial = createMockBackend({ tools: [{ name: 'notion-fetch' }] })
    ;(mockOfficial as any).reauth = async () => {
      throw new Error('401 Unauthorized')
    }

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('oh-my-notionmcp login')
  })

  it('handleReauth with "token expired" error includes login hint', async () => {
    const mockOfficial = createMockBackend({ tools: [{ name: 'notion-fetch' }] })
    ;(mockOfficial as any).reauth = async () => {
      throw new Error('token expired or revoked')
    }

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('oh-my-notionmcp login')
  })

  it('handleReauth with non-auth error does not include login hint', async () => {
    const mockOfficial = createMockBackend({ tools: [{ name: 'notion-fetch' }] })
    ;(mockOfficial as any).reauth = async () => {
      throw new Error('network timeout')
    }

    const router = new OhMyNotionRouter({ officialBackend: {} })
    router.official = mockOfficial

    const result = await (router as any).handleReauth()

    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain('oh-my-notionmcp login')
    expect(result.content[0].text).toContain('Reauth failed')
  })
})

// ─── BackendClient.reauth ─────────────────────────────────────────────────────

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const MockClient = vi.fn()
  MockClient.prototype.connect = vi.fn().mockResolvedValue(undefined)
  MockClient.prototype.listTools = vi.fn().mockResolvedValue({ tools: [] })
  MockClient.prototype.callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
  return { Client: MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  const MockTransport = vi.fn()
  MockTransport.prototype.close = vi.fn().mockResolvedValue(undefined)
  return { StdioClientTransport: MockTransport }
})

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { BackendClient } from '../../src/router/backend-client.js'
import type { BackendSpec } from '../../src/router/config.js'

describe('BackendClient.extractServerUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Client.prototype.connect).mockResolvedValue(undefined)
    vi.mocked(Client.prototype.listTools).mockResolvedValue({ tools: [] })
    vi.mocked(StdioClientTransport.prototype.close).mockResolvedValue(undefined)
  })

  it('returns URL from node command args', () => {
    const client = new BackendClient('official', {
      command: 'node',
      args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp'],
      env: {},
    })
    expect((client as any).extractServerUrl()).toBe('https://mcp.notion.com/mcp')
  })

  it('returns URL from npx command args', () => {
    const client = new BackendClient('official', {
      command: 'npx',
      args: ['-y', 'mcp-remote', 'https://custom.notion.com/mcp'],
      env: {},
    })
    expect((client as any).extractServerUrl()).toBe('https://custom.notion.com/mcp')
  })

  it('returns default URL when node args are too short', () => {
    const client = new BackendClient('official', {
      command: 'node',
      args: ['/path/to/proxy.js'],
      env: {},
    })
    // args[1] is undefined, should fall back to OFFICIAL_MCP_URL
    expect((client as any).extractServerUrl()).toBe('https://mcp.notion.com/mcp')
  })

  it('returns default URL for unknown command', () => {
    const client = new BackendClient('official', {
      command: 'python',
      args: ['server.py'],
      env: {},
    })
    expect((client as any).extractServerUrl()).toBe('https://mcp.notion.com/mcp')
  })

  it('returns default URL when npx has no mcp-remote arg', () => {
    const client = new BackendClient('official', {
      command: 'npx',
      args: ['-y', 'some-other-package'],
      env: {},
    })
    expect((client as any).extractServerUrl()).toBe('https://mcp.notion.com/mcp')
  })
})

describe('BackendClient.reauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(Client.prototype.connect).mockResolvedValue(undefined)
    vi.mocked(Client.prototype.listTools).mockResolvedValue({
      tools: [{ name: 'notion-fetch', inputSchema: { type: 'object' } }],
    })
    vi.mocked(StdioClientTransport.prototype.close).mockResolvedValue(undefined)
  })

  it('closes transport, clears cache, and reconnects', async () => {
    await withEnvSnapshot(async () => {
      // Set up a temp cache dir with token files
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reauth-backend-'))
      try {
        const versionDir = path.join(baseDir, 'mcp-remote-0.1.37')
        fs.mkdirSync(versionDir, { recursive: true })

        // The hash is md5 of the server URL
        const crypto = await import('node:crypto')
        const urlHash = crypto.createHash('md5').update('https://mcp.notion.com/mcp').digest('hex')
        fs.writeFileSync(path.join(versionDir, `${urlHash}_tokens.json`), '{}')
        fs.writeFileSync(path.join(versionDir, `${urlHash}_client_info.json`), '{}')

        process.env.MCP_REMOTE_CONFIG_DIR = baseDir

        const spec: BackendSpec = {
          command: 'node',
          args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp'],
          env: {},
        }
        const client = new BackendClient('official', spec)
        await client.connect()

        const result = await client.reauth()

        expect(result.status).toBe('reauth_triggered')
        expect(result.deletedFiles).toBe(2)
        expect(result.message).toContain('OAuth tokens cleared')
        // Transport close was called (initial close during reauth)
        expect(StdioClientTransport.prototype.close).toHaveBeenCalled()
        // Reconnect creates new Client + Transport (initial + reconnect)
        expect(Client).toHaveBeenCalledTimes(2)
        // Token files should be deleted
        expect(fs.existsSync(path.join(versionDir, `${urlHash}_tokens.json`))).toBe(false)
        expect(fs.existsSync(path.join(versionDir, `${urlHash}_client_info.json`))).toBe(false)
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true })
      }
    })
  })

  it('reauth propagates reconnect errors', async () => {
    const spec: BackendSpec = {
      command: 'node',
      args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp'],
      env: {},
    }
    const client = new BackendClient('official', spec)
    await client.connect()

    // Make reconnect fail by having connect() reject after the initial call
    vi.mocked(Client.prototype.connect).mockRejectedValue(new Error('reconnect failed'))

    await expect(client.reauth()).rejects.toThrow()
  })
})
