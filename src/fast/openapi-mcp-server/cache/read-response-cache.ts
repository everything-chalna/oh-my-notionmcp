import fs from 'node:fs/promises'
import path from 'node:path'

const CACHE_FORMAT_VERSION = 1

type CacheEntry<T> = {
  value: T
  createdAt: number
  updatedAt: number
  accessedAt: number
}

type PersistedCacheEntry<T> = CacheEntry<T> & {
  key: string
}

type PersistedCacheFile<T> = {
  version: number
  entries: PersistedCacheEntry<T>[]
}

export type ReadResponseCacheOptions = {
  cacheFilePath?: string
  path?: string
  ttlMs: number
  maxEntries: number
  now?: () => number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export class ReadResponseCache<T> {
  private readonly cacheFilePath: string
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private entries = new Map<string, CacheEntry<T>>()

  constructor(options: ReadResponseCacheOptions) {
    const cacheFilePath = options.cacheFilePath ?? options.path
    if (!cacheFilePath || cacheFilePath.trim().length === 0) {
      throw new Error('cacheFilePath (or path) is required')
    }
    if (!isFiniteNumber(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('ttlMs must be a positive number')
    }
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
      throw new Error('maxEntries must be a positive integer')
    }

    this.cacheFilePath = cacheFilePath
    this.ttlMs = options.ttlMs
    this.maxEntries = options.maxEntries
    this.now = options.now ?? Date.now
  }

  get size(): number {
    return this.entries.size
  }

  has(key: string): boolean {
    return this.getEntryIfFresh(key) !== undefined
  }

  get(key: string): T | undefined {
    const entry = this.getEntryIfFresh(key)
    if (!entry) {
      return undefined
    }

    entry.accessedAt = this.now()
    return entry.value
  }

  set(key: string, value: T): void {
    const now = this.now()
    const current = this.entries.get(key)
    this.entries.set(key, {
      value,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      accessedAt: now,
    })

    // Combined pruning: first remove expired, then check max entries
    this.pruneExpired(now)
    if (this.entries.size > this.maxEntries) {
      this.pruneMaxEntries()
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  pruneExpired(now = this.now()): number {
    let removed = 0
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key)
        removed += 1
      }
    }

    return removed
  }

  pruneMaxEntries(): number {
    if (this.entries.size <= this.maxEntries) {
      return 0
    }

    const overflow = this.entries.size - this.maxEntries
    const sortedEntries = [...this.entries.entries()].sort((a, b) => {
      const byAccessedAt = a[1].accessedAt - b[1].accessedAt
      if (byAccessedAt !== 0) {
        return byAccessedAt
      }

      const byUpdatedAt = a[1].updatedAt - b[1].updatedAt
      if (byUpdatedAt !== 0) {
        return byUpdatedAt
      }

      return a[1].createdAt - b[1].createdAt
    })

    for (const [key] of sortedEntries.slice(0, overflow)) {
      this.entries.delete(key)
    }

    return overflow
  }

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.cacheFilePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.entries.clear()
      return
    }

    this.entries = this.deserialize(parsed)
    this.pruneExpired()
    this.pruneMaxEntries()
  }

  async save(): Promise<void> {
    this.pruneExpired()
    this.pruneMaxEntries()

    await fs.mkdir(path.dirname(this.cacheFilePath), { recursive: true, mode: 0o700 })
    const payload = this.serialize()
    const tempPath = `${this.cacheFilePath}.${process.pid}.tmp`
    await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, this.cacheFilePath)
    await fs.chmod(this.cacheFilePath, 0o600).catch(() => {})
  }

  private isExpired(entry: CacheEntry<T>, now: number): boolean {
    return entry.updatedAt + this.ttlMs <= now
  }

  private getEntryIfFresh(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key)
    if (!entry) {
      return undefined
    }

    if (this.isExpired(entry, this.now())) {
      this.entries.delete(key)
      return undefined
    }

    return entry
  }

  private serialize(): PersistedCacheFile<T> {
    const serializedEntries: PersistedCacheEntry<T>[] = []
    for (const [key, entry] of this.entries.entries()) {
      serializedEntries.push({
        key,
        value: entry.value,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        accessedAt: entry.accessedAt,
      })
    }

    return {
      version: CACHE_FORMAT_VERSION,
      entries: serializedEntries,
    }
  }

  private deserialize(value: unknown): Map<string, CacheEntry<T>> {
    if (!isObject(value)) {
      return new Map()
    }

    if (value.version !== CACHE_FORMAT_VERSION) {
      return new Map()
    }

    if (!Array.isArray(value.entries)) {
      return new Map()
    }

    const nextEntries = new Map<string, CacheEntry<T>>()
    for (const rawEntry of value.entries) {
      if (!isObject(rawEntry)) {
        continue
      }

      const key = rawEntry.key
      const createdAt = rawEntry.createdAt
      const updatedAt = rawEntry.updatedAt
      const accessedAt = rawEntry.accessedAt
      if (
        typeof key !== 'string' ||
        !isFiniteNumber(createdAt) ||
        !isFiniteNumber(updatedAt) ||
        !isFiniteNumber(accessedAt)
      ) {
        continue
      }

      nextEntries.set(key, {
        value: rawEntry.value as T,
        createdAt,
        updatedAt,
        accessedAt,
      })
    }

    return nextEntries
  }
}
