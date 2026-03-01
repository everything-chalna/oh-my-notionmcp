import { describe, it, expect, vi, beforeEach } from 'vitest'

import { withEnvSnapshot } from '../helpers/env-snapshot'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(actual.existsSync),
    },
  }
})

import fs from 'node:fs'
import { resolveOfficialBackendConfig, resolveMcpRemoteProxyPath } from '../../src/router/config'
import { OFFICIAL_MCP_URL } from '../../src/router/utils'

const mockedExistsSync = vi.mocked(fs.existsSync)

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('resolveMcpRemoteProxyPath', () => {
  it('returns local mcp-remote path when available', () => {
    mockedExistsSync.mockReturnValue(true)
    const result = resolveMcpRemoteProxyPath()
    expect(result).toContain('mcp-remote/dist/proxy.js')
  })

  it('returns null when no local mcp-remote', () => {
    mockedExistsSync.mockReturnValue(false)
    const result = resolveMcpRemoteProxyPath()
    expect(result).toBeNull()
  })
})

describe('resolveOfficialBackendConfig', () => {
  it('uses node command when local mcp-remote exists', async () => {
    await withEnvSnapshot(() => {
      delete process.env.OHMY_NOTION_OFFICIAL_COMMAND
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_CWD

      mockedExistsSync.mockReturnValue(true)
      const config = resolveOfficialBackendConfig()
      expect(config.command).toBe('node')
      expect(config.args[0]).toContain('mcp-remote/dist/proxy.js')
      expect(config.args).toContain(OFFICIAL_MCP_URL)
      expect(config.args).toContain('--transport')
      expect(config.args).toContain('http-first')
    })
  })

  it('falls back to npx when no local mcp-remote and npx allowed', async () => {
    await withEnvSnapshot(() => {
      delete process.env.OHMY_NOTION_OFFICIAL_COMMAND
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_CWD
      process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK = 'true'

      mockedExistsSync.mockReturnValue(false)
      const config = resolveOfficialBackendConfig()
      expect(config.command).toBe('npx')
      expect(config.args).toContain('-y')
      expect(config.args).toContain('mcp-remote')
    })
  })

  it('throws when npx fallback disabled and no local mcp-remote', async () => {
    await withEnvSnapshot(() => {
      delete process.env.OHMY_NOTION_OFFICIAL_COMMAND
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_CWD
      delete process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK

      mockedExistsSync.mockReturnValue(false)
      expect(() => resolveOfficialBackendConfig()).toThrow('mcp-remote is not installed locally')
    })
  })

  it('respects OHMY_NOTION_OFFICIAL_COMMAND env override', async () => {
    await withEnvSnapshot(() => {
      process.env.OHMY_NOTION_OFFICIAL_COMMAND = '/custom/bin'
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_CWD

      mockedExistsSync.mockReturnValue(true)
      const config = resolveOfficialBackendConfig()
      expect(config.command).toBe('/custom/bin')
    })
  })

  it('respects OHMY_NOTION_OFFICIAL_ARGS_JSON env override', async () => {
    await withEnvSnapshot(() => {
      process.env.OHMY_NOTION_OFFICIAL_COMMAND = 'node'
      process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON = '["--custom","arg"]'
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_CWD

      mockedExistsSync.mockReturnValue(true)
      const config = resolveOfficialBackendConfig()
      expect(config.args).toEqual(['--custom', 'arg'])
    })
  })

  it('respects OHMY_NOTION_OFFICIAL_ENV_JSON env override', async () => {
    await withEnvSnapshot(() => {
      process.env.OHMY_NOTION_OFFICIAL_COMMAND = 'node'
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      process.env.OHMY_NOTION_OFFICIAL_ENV_JSON = '{"MY_VAR":"hello"}'
      delete process.env.OHMY_NOTION_OFFICIAL_CWD

      mockedExistsSync.mockReturnValue(true)
      const config = resolveOfficialBackendConfig()
      expect(config.env).toEqual({ MY_VAR: 'hello' })
    })
  })

  it('respects OHMY_NOTION_OFFICIAL_CWD env override', async () => {
    await withEnvSnapshot(() => {
      process.env.OHMY_NOTION_OFFICIAL_COMMAND = 'node'
      delete process.env.OHMY_NOTION_OFFICIAL_ARGS_JSON
      delete process.env.OHMY_NOTION_OFFICIAL_ENV_JSON
      process.env.OHMY_NOTION_OFFICIAL_CWD = '/custom/dir'

      mockedExistsSync.mockReturnValue(true)
      const config = resolveOfficialBackendConfig()
      expect(config.cwd).toBe('/custom/dir')
    })
  })
})
