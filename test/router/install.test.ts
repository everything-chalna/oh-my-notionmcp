import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => '{"mcpServers":{}}'),
      writeFileSync: vi.fn(),
    },
  }
})

vi.mock('../../src/router/config.js', () => ({
  resolveOfficialBackendConfig: vi.fn(() => ({
    command: 'node',
    args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp', '--transport', 'http-first'],
    cwd: undefined,
    env: { SAFE_VAR: 'ok', API_TOKEN: 'secret' },
  })),
}))

import fs from 'node:fs'
import { commandInstall } from '../../src/router/install'
import { resolveOfficialBackendConfig } from '../../src/router/config'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fs.existsSync).mockReturnValue(false)
  vi.mocked(fs.readFileSync).mockReturnValue('{"mcpServers":{}}')
  vi.mocked(fs.writeFileSync).mockImplementation(() => {})
  vi.mocked(resolveOfficialBackendConfig).mockReturnValue({
    command: 'node',
    args: ['/path/to/proxy.js', 'https://mcp.notion.com/mcp', '--transport', 'http-first'],
    cwd: undefined,
    env: { SAFE_VAR: 'ok', API_TOKEN: 'secret' },
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('commandInstall', () => {
  it('writes correct .mcp.json structure', () => {
    commandInstall({ project: '/tmp/test-project', name: 'my-notion' })

    expect(fs.writeFileSync).toHaveBeenCalledOnce()
    const [writePath, content] = vi.mocked(fs.writeFileSync).mock.calls[0]
    expect(writePath).toContain('.mcp.json')

    const parsed = JSON.parse(content as string)
    expect(parsed.mcpServers['my-notion']).toBeDefined()
    const entry = parsed.mcpServers['my-notion']
    expect(entry.command).toBe('node')
    expect(entry.args).toContain('serve')
    expect(entry.env.OHMY_NOTION_OFFICIAL_COMMAND).toBe('node')
    expect(entry.env.OHMY_NOTION_OFFICIAL_ARGS_JSON).toBeDefined()
  })

  it('sanitizes sensitive env keys from persisted config', () => {
    commandInstall({ project: '/tmp/test-project' })

    expect(fs.writeFileSync).toHaveBeenCalledOnce()
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0]
    const parsed = JSON.parse(content as string)
    const entry = parsed.mcpServers['notion']
    const envJson = JSON.parse(entry.env.OHMY_NOTION_OFFICIAL_ENV_JSON)

    // API_TOKEN should be redacted, SAFE_VAR should remain
    expect(envJson.SAFE_VAR).toBe('ok')
    expect(envJson.API_TOKEN).toBeUndefined()
  })

  it('includes cwd when officialBackend provides it', () => {
    vi.mocked(resolveOfficialBackendConfig).mockReturnValue({
      command: 'node',
      args: ['/path/proxy.js', 'https://mcp.notion.com/mcp'],
      cwd: '/custom/cwd',
      env: {},
    })

    commandInstall({ project: '/tmp/test-project' })

    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0]
    const parsed = JSON.parse(content as string)
    const entry = parsed.mcpServers['notion']
    expect(entry.env.OHMY_NOTION_OFFICIAL_CWD).toBe('/custom/cwd')
  })
})
