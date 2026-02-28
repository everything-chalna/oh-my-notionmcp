import { afterEach, describe, expect, it } from 'vitest'

import { startServer } from '../../scripts/start-server'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('start-server HTTP safety guards', () => {
  it('refuses disable-auth when trusted local fast-path is enabled', async () => {
    process.env.NOTION_MCP_FAST_CACHE_ENABLED = 'true'
    process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED = 'true'
    process.env.NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED = 'true'

    await expect(
      startServer(['node', 'scripts/start-server.ts', '--transport', 'http', '--disable-auth']),
    ).rejects.toThrow('Refusing to start HTTP transport with --disable-auth')

    expect(process.env.NOTION_MCP_FAST_CACHE_ENABLED).toBe('false')
  })
})
