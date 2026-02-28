import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { OhMyNotionRouter, buildChildEnv, findMcpRemoteTokenFile, resolveFastBackendConfig } from '../bin/cli.mjs'

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

test('buildRoutingTable exposes official tool surface when official backend exists', () => {
  const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

  router.fast = {
    tools: [{ name: 'search' }, { name: 'retrieve-a-page' }, { name: 'fast-only-tool' }],
  }
  router.official = {
    tools: [{ name: 'search' }, { name: 'fetch' }, { name: 'notion-create-pages' }],
  }

  router.buildRoutingTable()

  const exposedNames = router.exposedTools.map((tool) => tool.name).sort()
  assert.deepEqual(exposedNames, ['fetch', 'notion-create-pages', 'search'])
  assert.equal(router.routes.has('fast-only-tool'), false)
  assert.equal(router.routes.get('search').mode, 'fast-then-official-same-name')
  assert.equal(router.routes.get('fetch').mode, 'official-with-fast-boost')
})

test('tryFastGetUsers forwards caller arguments to fast tool', async () => {
  const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

  let call = null
  router.fast = {
    findToolName(candidates) {
      if (candidates.includes('API-get-users')) return 'API-get-users'
      return undefined
    },
  }
  router.callFastOrError = async (toolName, args) => {
    call = { toolName, args }
    return { content: [], isError: false }
  }

  await router.tryFastGetUsers({ query: 'john', page_size: 3 })

  assert.deepEqual(call, {
    toolName: 'API-get-users',
    args: { query: 'john', page_size: 3 },
  })
})

test('tryFastFetch skips boost when extra fetch args are present', async () => {
  const router = new OhMyNotionRouter({ fastBackend: {}, officialBackend: {} })

  let called = false
  router.fast = {
    findToolName() {
      return 'API-retrieve-a-page'
    },
  }
  router.callFastOrError = async () => {
    called = true
    return { content: [], isError: false }
  }

  const result = await router.tryFastFetch({ id: 'abc123', include_discussions: true })

  assert.equal(result, null)
  assert.equal(called, false)
})

test('buildChildEnv allowlists environment variables', () => {
  const snapshot = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MY_SECRET: process.env.MY_SECRET,
  }

  try {
    process.env.PATH = '/usr/bin'
    process.env.HOME = '/tmp/home'
    process.env.MY_SECRET = 'should-not-leak'
    const env = buildChildEnv({ EXTRA_KEY: 'ok' })

    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.HOME, '/tmp/home')
    assert.equal(env.EXTRA_KEY, 'ok')
    assert.equal(env.MY_SECRET, undefined)
  } finally {
    restoreEnv(snapshot)
  }
})

test('resolveFastBackendConfig blocks npx fallback by default', () => {
  const snapshot = {
    OHMY_NOTION_FAST_COMMAND: process.env.OHMY_NOTION_FAST_COMMAND,
    OHMY_NOTION_FAST_ARGS_JSON: process.env.OHMY_NOTION_FAST_ARGS_JSON,
    OHMY_NOTION_ALLOW_NPX_FALLBACK: process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK,
  }

  try {
    process.env.OHMY_NOTION_FAST_COMMAND = 'npx'
    process.env.OHMY_NOTION_FAST_ARGS_JSON = '["-y","notion-mcp-fast"]'
    delete process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK

    assert.throws(() => resolveFastBackendConfig(), /npx fallback.*disabled/i)

    process.env.OHMY_NOTION_ALLOW_NPX_FALLBACK = 'true'
    const cfg = resolveFastBackendConfig()
    assert.equal(cfg.command, 'npx')
  } finally {
    restoreEnv(snapshot)
  }
})

test('findMcpRemoteTokenFile selects a valid token payload', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohmy-notionmcp-auth-'))
  const hash = 'deadbeefdeadbeefdeadbeefdeadbeef'
  const snapshot = {
    MCP_REMOTE_CONFIG_DIR: process.env.MCP_REMOTE_CONFIG_DIR,
  }

  try {
    const v1 = path.join(baseDir, 'mcp-remote-0.1.0')
    const v2 = path.join(baseDir, 'mcp-remote-0.2.0')
    fs.mkdirSync(v1, { recursive: true })
    fs.mkdirSync(v2, { recursive: true })

    fs.writeFileSync(path.join(v1, `${hash}_tokens.json`), '{"bad_json":true}', 'utf8')
    const expected = path.join(v2, `${hash}_tokens.json`)
    fs.writeFileSync(
      expected,
      JSON.stringify({
        access_token: 'token',
        refresh_token: 'refresh',
        token_type: 'bearer',
      }),
      'utf8',
    )

    process.env.MCP_REMOTE_CONFIG_DIR = baseDir
    const found = findMcpRemoteTokenFile(hash)
    assert.equal(found, expected)
  } finally {
    restoreEnv(snapshot)
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})
