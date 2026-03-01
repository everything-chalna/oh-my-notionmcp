import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/router/config.js', () => ({
  resolveOfficialBackendConfig: vi.fn(() => ({
    command: 'node',
    args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp'],
    cwd: '/test/cwd',
    env: { EXTRA: 'val' },
  })),
}))

vi.mock('../../src/router/utils.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/router/utils')>('../../src/router/utils.js')
  return {
    ...actual,
    runCommand: vi.fn(() => ({ status: 0, signal: null, error: null })),
    buildChildEnv: vi.fn((extra: Record<string, string> = {}) => ({ PATH: '/usr/bin', ...extra })),
  }
})

import { commandLogin } from '../../src/router/login'
import { runCommand } from '../../src/router/utils'
import { resolveOfficialBackendConfig } from '../../src/router/config'

const mockedRunCommand = vi.mocked(runCommand)

beforeEach(() => {
  vi.restoreAllMocks()
  vi.mocked(resolveOfficialBackendConfig).mockReturnValue({
    command: 'node',
    args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp'],
    cwd: '/test/cwd',
    env: { EXTRA: 'val' },
  })
  mockedRunCommand.mockReturnValue({ status: 0, signal: null, error: null } as any)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('commandLogin', () => {
  it('calls runCommand with correct args from official config', () => {
    commandLogin()

    expect(mockedRunCommand).toHaveBeenCalledOnce()
    const [cmd, args, opts] = mockedRunCommand.mock.calls[0]
    expect(cmd).toBe('node')
    expect(args).toEqual(['/path/to/proxy.js', 'https://mcp.notion.com/mcp'])
    expect(opts!.cwd).toBe('/test/cwd')
    expect(opts!.stdio).toBe('inherit')
  })

  it('allows SIGINT (exit code 130)', () => {
    mockedRunCommand.mockReturnValue({ status: 130, signal: null, error: null } as any)
    expect(() => commandLogin()).not.toThrow()
  })

  it('allows signal SIGINT', () => {
    mockedRunCommand.mockReturnValue({ status: null, signal: 'SIGINT', error: null } as any)
    expect(() => commandLogin()).not.toThrow()
  })

  it('throws on non-zero non-SIGINT exit', () => {
    mockedRunCommand.mockReturnValue({ status: 1, signal: null, error: null } as any)
    expect(() => commandLogin()).toThrow('login failed')
  })

  it('throws when runCommand returns an error', () => {
    mockedRunCommand.mockReturnValue({
      status: null,
      signal: null,
      error: new Error('ENOENT'),
    } as any)
    expect(() => commandLogin()).toThrow('login failed')
    expect(() => commandLogin()).toThrow('ENOENT')
  })
})
