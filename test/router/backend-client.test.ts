import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const spec: BackendSpec = {
  command: 'node',
  args: ['test.js'],
  env: {},
}

describe('BackendClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset default mocks
    vi.mocked(Client.prototype.connect).mockResolvedValue(undefined)
    vi.mocked(Client.prototype.listTools).mockResolvedValue({
      tools: [{ name: 'notion-fetch', inputSchema: { type: 'object' } }],
    })
    vi.mocked(Client.prototype.callTool).mockResolvedValue({
      content: [{ type: 'text', text: '{"ok":true}' }],
    })
    vi.mocked(StdioClientTransport.prototype.close).mockResolvedValue(undefined)
  })

  it('callTool succeeds on first attempt', async () => {
    const client = new BackendClient('official', spec)
    await client.connect()

    const result = await client.callTool('notion-fetch', { id: '123' })
    expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] })
    expect(Client.prototype.callTool).toHaveBeenCalledTimes(1)
  })

  it('callTool failure triggers reconnect and retry', async () => {
    const client = new BackendClient('official', spec)
    await client.connect()

    // First call fails, second (retry after reconnect) succeeds
    vi.mocked(Client.prototype.callTool)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"retried":true}' }] })

    const result = await client.callTool('notion-fetch', { id: '123' })
    expect(result).toEqual({ content: [{ type: 'text', text: '{"retried":true}' }] })
    // callTool called twice: first attempt + retry
    expect(Client.prototype.callTool).toHaveBeenCalledTimes(2)
    // New transport and client were created during reconnect
    expect(StdioClientTransport).toHaveBeenCalledTimes(2) // constructor: initial + reconnect
    expect(Client).toHaveBeenCalledTimes(2) // constructor: initial + reconnect
  })

  it('reconnect failure gives clear error', async () => {
    const client = new BackendClient('official', spec)
    await client.connect()

    // callTool fails
    vi.mocked(Client.prototype.callTool).mockRejectedValue(new Error('connection lost'))
    // reconnect's connect() also fails
    // Initial connect() already happened, so the next connect() call is during reconnect
    vi.mocked(Client.prototype.connect).mockRejectedValue(new Error('cannot reconnect'))

    await expect(client.callTool('notion-fetch')).rejects.toThrow(
      'official backend call failed and reconnect also failed: cannot reconnect',
    )
  })

  it('reconnect timeout (10s)', async () => {
    vi.useFakeTimers()

    const client = new BackendClient('official', spec)
    await client.connect()

    // callTool fails
    vi.mocked(Client.prototype.callTool).mockRejectedValue(new Error('connection lost'))
    // reconnect's connect() hangs forever
    vi.mocked(Client.prototype.connect).mockImplementation(() => new Promise(() => {}))

    // Set up the assertion before advancing timers to avoid unhandled rejection
    const assertion = client.callTool('notion-fetch').catch((err: Error) => err)

    // Advance past the 10s reconnect timeout
    await vi.advanceTimersByTimeAsync(11_000)

    const error = await assertion
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('reconnect timed out after 10s')

    vi.useRealTimers()
  })
})
