import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  getMcpRemoteServerHash,
  hashForMcpRemoteContext,
  extractMcpRemoteHashContext,
  findMcpRemoteTokenFile,
} from '../../src/router/doctor'
import { OFFICIAL_MCP_URL } from '../../src/router/utils'

describe('getMcpRemoteServerHash', () => {
  it('returns deterministic MD5 hash of OFFICIAL_MCP_URL', () => {
    const expected = crypto.createHash('md5').update(OFFICIAL_MCP_URL).digest('hex')
    expect(getMcpRemoteServerHash()).toBe(expected)
    // Calling again returns same value
    expect(getMcpRemoteServerHash()).toBe(expected)
  })
})

describe('hashForMcpRemoteContext', () => {
  it('same inputs produce same hash', () => {
    const h1 = hashForMcpRemoteContext('https://example.com', 'res', ['h1'])
    const h2 = hashForMcpRemoteContext('https://example.com', 'res', ['h1'])
    expect(h1).toBe(h2)
  })

  it('different inputs produce different hashes', () => {
    const h1 = hashForMcpRemoteContext('https://a.com', '', [])
    const h2 = hashForMcpRemoteContext('https://b.com', '', [])
    expect(h1).not.toBe(h2)
  })

  it('different authorizeResource produces different hash', () => {
    const h1 = hashForMcpRemoteContext('https://a.com', 'res1', [])
    const h2 = hashForMcpRemoteContext('https://a.com', 'res2', [])
    expect(h1).not.toBe(h2)
  })

  it('different headers produce different hash', () => {
    const h1 = hashForMcpRemoteContext('https://a.com', '', ['header1'])
    const h2 = hashForMcpRemoteContext('https://a.com', '', ['header2'])
    expect(h1).not.toBe(h2)
  })
})

describe('extractMcpRemoteHashContext', () => {
  it('extracts URL from node command (list[1])', () => {
    const ctx = extractMcpRemoteHashContext('node', ['/path/to/proxy.js', 'https://my-url.com'])
    expect(ctx.serverUrl).toBe('https://my-url.com')
    expect(ctx.authorizeResource).toBe('')
    expect(ctx.headers).toEqual([])
  })

  it('extracts URL from npx command after mcp-remote', () => {
    const ctx = extractMcpRemoteHashContext('npx', ['-y', 'mcp-remote', 'https://my-url.com'])
    expect(ctx.serverUrl).toBe('https://my-url.com')
  })

  it('extracts --authorize-resource flag', () => {
    const ctx = extractMcpRemoteHashContext('node', [
      '/proxy.js',
      'https://url.com',
      '--authorize-resource',
      'my-resource',
    ])
    expect(ctx.authorizeResource).toBe('my-resource')
  })

  it('extracts --header flags', () => {
    const ctx = extractMcpRemoteHashContext('node', [
      '/proxy.js',
      'https://url.com',
      '--header',
      'X-Custom: val1',
      '--header',
      'X-Other: val2',
    ])
    expect(ctx.headers).toEqual(['X-Custom: val1', 'X-Other: val2'])
  })

  it('falls back to OFFICIAL_MCP_URL for unknown command', () => {
    const ctx = extractMcpRemoteHashContext('unknown', [])
    expect(ctx.serverUrl).toBe(OFFICIAL_MCP_URL)
  })
})

describe('findMcpRemoteTokenFile', () => {
  let baseDir: string
  const hash = 'deadbeefdeadbeefdeadbeefdeadbeef'
  let savedConfigDir: string | undefined

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohmy-doctor-test-'))
    savedConfigDir = process.env.MCP_REMOTE_CONFIG_DIR
    process.env.MCP_REMOTE_CONFIG_DIR = baseDir
  })

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.MCP_REMOTE_CONFIG_DIR
    } else {
      process.env.MCP_REMOTE_CONFIG_DIR = savedConfigDir
    }
    fs.rmSync(baseDir, { recursive: true, force: true })
  })

  it('finds valid token file', () => {
    const versionDir = path.join(baseDir, 'mcp-remote-0.1.0')
    fs.mkdirSync(versionDir, { recursive: true })
    const tokenPath = path.join(versionDir, `${hash}_tokens.json`)
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({ access_token: 'tok', refresh_token: 'ref' }),
      'utf8',
    )

    const result = findMcpRemoteTokenFile(hash)
    expect(result).toBe(tokenPath)
  })

  it('skips invalid token payload', () => {
    const versionDir = path.join(baseDir, 'mcp-remote-0.1.0')
    fs.mkdirSync(versionDir, { recursive: true })
    fs.writeFileSync(
      path.join(versionDir, `${hash}_tokens.json`),
      JSON.stringify({ bad: true }),
      'utf8',
    )

    const result = findMcpRemoteTokenFile(hash)
    expect(result).toBeNull()
  })

  it('returns null for non-existent base dir', () => {
    process.env.MCP_REMOTE_CONFIG_DIR = '/nonexistent/dir/nowhere'
    const result = findMcpRemoteTokenFile(hash)
    expect(result).toBeNull()
  })

  it('finds token in direct hash directory', () => {
    const hashDir = path.join(baseDir, hash)
    fs.mkdirSync(hashDir, { recursive: true })
    const tokenPath = path.join(hashDir, 'tokens.json')
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({ access_token: 'tok', expires_in: 3600 }),
      'utf8',
    )

    const result = findMcpRemoteTokenFile(hash)
    expect(result).toBe(tokenPath)
  })
})
