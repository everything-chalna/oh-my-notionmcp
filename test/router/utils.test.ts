import { describe, it, expect } from 'vitest'

import {
  parseArgs,
  sensitiveEnvKey,
  sanitizePersistedEnv,
  extractUuidish,
  looksAuthError,
  normalizeToolName,
  looksReadTool,
  looksWriteTool,
  parseBool,
  parseJsonObject,
  parseJsonStringArray,
} from '../../src/router/utils'

describe('parseArgs', () => {
  it('parses --key value pairs', () => {
    const result = parseArgs(['--name', 'hello', '--project', '/tmp'])
    expect(result).toEqual({ name: 'hello', project: '/tmp' })
  })

  it('parses boolean flags (--flag with no value)', () => {
    const result = parseArgs(['--verbose', '--debug'])
    expect(result).toEqual({ verbose: true, debug: true })
  })

  it('returns empty object for no args', () => {
    expect(parseArgs([])).toEqual({})
  })

  it('handles mixed flags and key-value pairs', () => {
    const result = parseArgs(['--name', 'test', '--verbose', '--project', '/tmp'])
    expect(result).toEqual({ name: 'test', verbose: true, project: '/tmp' })
  })

  it('skips non-flag arguments', () => {
    const result = parseArgs(['serve', '--name', 'test'])
    expect(result).toEqual({ name: 'test' })
  })
})

describe('sensitiveEnvKey', () => {
  it('detects TOKEN keys', () => {
    expect(sensitiveEnvKey('API_TOKEN')).toBe(true)
    expect(sensitiveEnvKey('NOTION_TOKEN')).toBe(true)
  })

  it('detects SECRET keys', () => {
    expect(sensitiveEnvKey('CLIENT_SECRET')).toBe(true)
  })

  it('detects PASSWORD keys', () => {
    expect(sensitiveEnvKey('DB_PASSWORD')).toBe(true)
  })

  it('detects AUTH keys', () => {
    expect(sensitiveEnvKey('OAUTH_CLIENT')).toBe(true)
    expect(sensitiveEnvKey('AUTH_HEADER')).toBe(true)
  })

  it('detects _KEY suffix', () => {
    expect(sensitiveEnvKey('API_KEY')).toBe(true)
    expect(sensitiveEnvKey('ENCRYPTION_KEY')).toBe(true)
  })

  it('detects PRIVATE keys', () => {
    expect(sensitiveEnvKey('PRIVATE_DATA')).toBe(true)
  })

  it('allows safe keys', () => {
    expect(sensitiveEnvKey('PATH')).toBe(false)
    expect(sensitiveEnvKey('HOME')).toBe(false)
    expect(sensitiveEnvKey('NODE_ENV')).toBe(false)
    expect(sensitiveEnvKey('LANG')).toBe(false)
  })
})

describe('sanitizePersistedEnv', () => {
  it('redacts sensitive keys and keeps safe keys', () => {
    const input = { PATH: '/usr/bin', API_TOKEN: 'secret123', HOME: '/home/user' }
    const { sanitized, redactedKeys } = sanitizePersistedEnv(input)
    expect(sanitized).toEqual({ PATH: '/usr/bin', HOME: '/home/user' })
    expect(redactedKeys).toEqual(['API_TOKEN'])
  })

  it('handles empty/undefined input', () => {
    const { sanitized, redactedKeys } = sanitizePersistedEnv(undefined)
    expect(sanitized).toEqual({})
    expect(redactedKeys).toEqual([])
  })
})

describe('extractUuidish', () => {
  it('extracts 32-char hex string', () => {
    expect(extractUuidish('abcdef01234567890abcdef012345678')).toBe('abcdef01234567890abcdef012345678')
  })

  it('extracts UUID with dashes', () => {
    expect(extractUuidish('abcdef01-2345-6789-0abc-def012345678')).toBe(
      'abcdef01-2345-6789-0abc-def012345678',
    )
  })

  it('extracts UUID from URL', () => {
    const url = 'https://notion.so/My-Page-abcdef01234567890abcdef012345678'
    expect(extractUuidish(url)).toBe('abcdef01234567890abcdef012345678')
  })

  it('returns plain string unchanged when no UUID found', () => {
    expect(extractUuidish('hello-world')).toBe('hello-world')
  })
})

describe('looksAuthError', () => {
  it('detects 401 in message', () => {
    expect(looksAuthError('HTTP 401 Unauthorized')).toBe(true)
  })

  it('detects "unauthorized"', () => {
    expect(looksAuthError('Unauthorized access denied')).toBe(true)
  })

  it('detects "token expired"', () => {
    expect(looksAuthError('your token has expired')).toBe(true)
  })

  it('detects "token invalid"', () => {
    expect(looksAuthError('token invalid or revoked')).toBe(true)
  })

  it('detects "authentication"', () => {
    expect(looksAuthError('Authentication required')).toBe(true)
  })

  it('does not flag normal errors', () => {
    expect(looksAuthError('network timeout')).toBe(false)
    expect(looksAuthError('page not found')).toBe(false)
  })
})

describe('normalizeToolName', () => {
  it('removes notion- prefix and lowercases', () => {
    expect(normalizeToolName('notion-search')).toBe('search')
  })

  it('removes notion_ prefix', () => {
    expect(normalizeToolName('notion_create-page')).toBe('create-page')
  })

  it('removes notion: prefix', () => {
    expect(normalizeToolName('Notion:Search')).toBe('search')
  })

  it('lowercases without prefix', () => {
    expect(normalizeToolName('SearchPages')).toBe('searchpages')
  })
})

describe('looksReadTool', () => {
  it('identifies read-like tools', () => {
    expect(looksReadTool('notion-search')).toBe(true)
    expect(looksReadTool('fetch-page')).toBe(true)
    expect(looksReadTool('retrieve-database')).toBe(true)
    expect(looksReadTool('list-users')).toBe(true)
    expect(looksReadTool('get-page')).toBe(true)
    expect(looksReadTool('query-database')).toBe(true)
  })

  it('does not flag write tools as read', () => {
    expect(looksReadTool('create-page')).toBe(false)
    expect(looksReadTool('delete-block')).toBe(false)
  })
})

describe('looksWriteTool', () => {
  it('identifies write-like tools', () => {
    expect(looksWriteTool('create-page')).toBe(true)
    expect(looksWriteTool('update-database')).toBe(true)
    expect(looksWriteTool('delete-block')).toBe(true)
    expect(looksWriteTool('move-page')).toBe(true)
    expect(looksWriteTool('append-blocks')).toBe(true)
    expect(looksWriteTool('notion-comment')).toBe(true)
  })

  it('does not flag read tools as write', () => {
    expect(looksWriteTool('search')).toBe(false)
    expect(looksWriteTool('fetch-page')).toBe(false)
  })
})

describe('parseBool', () => {
  it('parses truthy values', () => {
    expect(parseBool('true')).toBe(true)
    expect(parseBool('1')).toBe(true)
    expect(parseBool('yes')).toBe(true)
    expect(parseBool('on')).toBe(true)
  })

  it('parses falsy values', () => {
    expect(parseBool('false')).toBe(false)
    expect(parseBool('0')).toBe(false)
    expect(parseBool('no')).toBe(false)
    expect(parseBool('')).toBe(false)
  })
})

describe('parseJsonObject', () => {
  it('parses valid JSON object', () => {
    expect(parseJsonObject('{"key":"val"}', 'TEST')).toEqual({ key: 'val' })
  })

  it('returns empty object for undefined', () => {
    expect(parseJsonObject(undefined, 'TEST')).toEqual({})
  })

  it('throws on invalid JSON', () => {
    expect(() => parseJsonObject('{bad', 'TEST')).toThrow('TEST must be valid JSON')
  })

  it('throws on non-object (array)', () => {
    expect(() => parseJsonObject('[1,2]', 'TEST')).toThrow('TEST must be a JSON object')
  })
})

describe('parseJsonStringArray', () => {
  it('parses valid JSON array', () => {
    expect(parseJsonStringArray('["a","b"]', 'TEST')).toEqual(['a', 'b'])
  })

  it('returns undefined for undefined input', () => {
    expect(parseJsonStringArray(undefined, 'TEST')).toBeUndefined()
  })

  it('throws on non-array JSON', () => {
    expect(() => parseJsonStringArray('{"a":1}', 'TEST')).toThrow('TEST must be a JSON array')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseJsonStringArray('[bad', 'TEST')).toThrow('TEST must be valid JSON')
  })
})
