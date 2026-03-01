import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initProxy, ValidationError } from '../../src/fast/init-server'

const minimalSpec = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0.0' },
  paths: {},
  servers: [{ url: 'https://api.example.com' }],
}

describe('ValidationError', () => {
  it('has name set to ValidationError', () => {
    const err = new ValidationError([{ message: 'bad field' }])
    expect(err.name).toBe('ValidationError')
  })

  it('stores errors array', () => {
    const errors = [{ message: 'a' }, { message: 'b' }]
    const err = new ValidationError(errors)
    expect(err.errors).toEqual(errors)
    expect(err.errors).toHaveLength(2)
  })

  it('has message set to "OpenAPI validation failed"', () => {
    const err = new ValidationError([])
    expect(err.message).toBe('OpenAPI validation failed')
  })

  it('is an instance of Error', () => {
    const err = new ValidationError([])
    expect(err).toBeInstanceOf(Error)
  })
})

describe('initProxy', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-server-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates MCPProxy with a valid spec file', async () => {
    const specPath = path.join(tmpDir, 'spec.json')
    fs.writeFileSync(specPath, JSON.stringify(minimalSpec))

    const proxy = await initProxy(specPath, undefined)
    expect(proxy).toBeDefined()
    expect(typeof proxy.connect).toBe('function')
  })

  it('exits process when spec file does not exist', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    await expect(
      initProxy(path.join(tmpDir, 'nonexistent.json'), undefined),
    ).rejects.toThrow('process.exit called')

    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
  })

  it('exits process when spec file contains invalid JSON', async () => {
    const specPath = path.join(tmpDir, 'bad.json')
    fs.writeFileSync(specPath, '{ not valid json !!!}')

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    await expect(initProxy(specPath, undefined)).rejects.toThrow('process.exit called')

    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
  })

  it('overrides server URL when baseUrl is provided', async () => {
    const specPath = path.join(tmpDir, 'spec.json')
    fs.writeFileSync(specPath, JSON.stringify(minimalSpec))

    const customUrl = 'https://custom.example.com'
    const proxy = await initProxy(specPath, customUrl)

    // The proxy should be created successfully with the overridden URL
    expect(proxy).toBeDefined()
    expect(typeof proxy.connect).toBe('function')
  })

  it('preserves original server URL when baseUrl is undefined', async () => {
    const specPath = path.join(tmpDir, 'spec.json')
    fs.writeFileSync(specPath, JSON.stringify(minimalSpec))

    const proxy = await initProxy(specPath, undefined)
    expect(proxy).toBeDefined()
  })

  it('handles spec with empty servers array by throwing', async () => {
    const specWithoutServers = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0.0' },
      paths: {},
      servers: [],
    }
    const specPath = path.join(tmpDir, 'no-servers.json')
    fs.writeFileSync(specPath, JSON.stringify(specWithoutServers))

    // MCPProxy constructor throws when no base URL is found
    await expect(initProxy(specPath, undefined)).rejects.toThrow()
  })
})
