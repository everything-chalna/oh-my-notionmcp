import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReadResponseCache } from '../../../src/fast/openapi-mcp-server/cache/read-response-cache'

const TEST_TTL_MS = 1_000

describe('ReadResponseCache', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'read-response-cache-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('set/get hit: stores and returns cached value', () => {
    let now = 10_000
    const cache = new ReadResponseCache<{ status: number; data: { id: string } }>({
      path: path.join(tempDir, 'hit.json'),
      ttlMs: TEST_TTL_MS,
      maxEntries: 10,
      now: () => now,
    })

    const key = 'GET:/v1/pages/page_123'
    const value = { status: 200, data: { id: 'page_123' } }

    cache.set(key, value)

    expect(cache.get(key)).toEqual(value)
  })

  it('ttl 만료 miss: entry expires after ttl', () => {
    let now = 5_000
    const cache = new ReadResponseCache<{ status: number }>({
      path: path.join(tempDir, 'ttl.json'),
      ttlMs: TEST_TTL_MS,
      maxEntries: 10,
      now: () => now,
    })

    const key = 'GET:/v1/users/me'
    cache.set(key, { status: 200 })

    expect(cache.get(key)).toEqual({ status: 200 })

    now += TEST_TTL_MS + 1

    expect(cache.get(key)).toBeUndefined()
  })

  it('max entries pruning: removes least-recently-used entries over limit', () => {
    let now = 1_000
    const cache = new ReadResponseCache<{ value: number }>({
      path: path.join(tempDir, 'prune.json'),
      ttlMs: 60_000,
      maxEntries: 2,
      now: () => now,
    })

    cache.set('k1', { value: 1 })
    now += 1
    cache.set('k2', { value: 2 })
    now += 1
    cache.set('k3', { value: 3 })

    expect(cache.get('k1')).toBeUndefined()
    expect(cache.get('k2')).toEqual({ value: 2 })
    expect(cache.get('k3')).toEqual({ value: 3 })
  })

  it('file load/save: persists cache and restores in new instance', async () => {
    let now = 20_000
    const cachePath = path.join(tempDir, 'persisted-cache.json')
    const key = 'POST:/v1/search:{"query":"docs"}'
    const value = {
      status: 200,
      data: { results: [{ id: 'page_1' }] },
    }

    const writer = new ReadResponseCache<typeof value>({
      path: cachePath,
      ttlMs: 60_000,
      maxEntries: 10,
      now: () => now,
    })

    writer.set(key, value)
    await writer.save()

    const raw = await readFile(cachePath, 'utf-8')
    expect(raw.length).toBeGreaterThan(0)

    const reader = new ReadResponseCache<typeof value>({
      path: cachePath,
      ttlMs: 60_000,
      maxEntries: 10,
      now: () => now,
    })

    await reader.load()

    expect(reader.get(key)).toEqual(value)
  })
})
