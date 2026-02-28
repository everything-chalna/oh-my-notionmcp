# oh-my-notionmcp

Unified Notion MCP server for macOS.

- Read: local Notion desktop cache first, then Notion API with response caching
- Fallback: official Notion MCP on local read miss/error
- Write: official Notion MCP only

Release notes: [CHANGELOG.md](./CHANGELOG.md)

## Why This Exists

The official Notion MCP is great for correctness and write flows, but read-heavy exploration can feel slower than local cache access.

`oh-my-notionmcp` keeps one MCP server alias (default: `notion`) and routes calls to the right backend:

- cache-first for reads (in-process fast backend with response caching and optional Notion desktop SQLite fast-path)
- official MCP for writes (child process via `mcp-remote`)

You get fast local reads without giving up official write compatibility.

## Routing Policy

| Operation | Route |
| --- | --- |
| Read tool | fast backend first (in-process), then official Notion MCP fallback |
| Write tool | official Notion MCP only |
| Official unavailable | degraded read-only mode from fast backend |

Notes:

- Tool surface is official-first when official backend is available.
- Fast-only write tools are not exposed.

## Requirements

- macOS (Notion desktop cache path is macOS-specific)
- Node.js `>=20`
- Notion desktop app installed and opened at least once (for local cache fast-path)
- Official Notion MCP OAuth session for fallback/write path (`login` command)

## Quick Start

1. Install CLI

```bash
npm install -g oh-my-notionmcp
```

2. Install router entry into your project `.mcp.json`

```bash
oh-my-notionmcp install --project /path/to/project --name notion
```

3. Run official OAuth bootstrap

```bash
oh-my-notionmcp login
```

Complete browser auth, then press `Ctrl+C` after `Proxy established`.

4. Validate setup

```bash
oh-my-notionmcp doctor --project /path/to/project --name notion
```

## Commands

```bash
oh-my-notionmcp serve                                    # Start the router
oh-my-notionmcp serve-fast [--transport <stdio|http>]    # Start standalone fast read-only server
oh-my-notionmcp install [--project <dir>] [--name <name>]
oh-my-notionmcp login
oh-my-notionmcp doctor [--project <dir>] [--name <name>] [--allow-missing-auth]
```

### serve

Starts the unified router MCP server. The fast read-only backend runs in-process; the official backend runs as a child process.

### serve-fast

Starts only the fast read-only MCP server as a standalone process. Useful when you want read-only Notion access without the router or official backend.

```bash
# stdio transport (default, for MCP clients like Claude Desktop)
oh-my-notionmcp serve-fast

# HTTP transport
oh-my-notionmcp serve-fast --transport http --port 3000
oh-my-notionmcp serve-fast --transport http --auth-token "your-secret-token"
```

The standalone fast server requires a Notion integration token:

```bash
export NOTION_TOKEN="ntn_****"
oh-my-notionmcp serve-fast
```

### install defaults

- `--project`: current working directory
- `--name`: `notion`

### doctor

- fails when auth token cache is missing
- use `--allow-missing-auth` to downgrade missing auth to warning

## Read-Only Tools

The fast backend exposes the following read-only tools (auto-generated from the OpenAPI spec):

| Tool | Description |
| --- | --- |
| `get-block-children` | Retrieve block children |
| `get-self` | Retrieve your token's bot user |
| `get-user` | Retrieve a user |
| `get-users` | List all users |
| `list-data-source-templates` | List templates in a data source |
| `post-search` | Search by title |
| `query-data-source` | Query a data source |
| `retrieve-a-block` | Retrieve a block |
| `retrieve-a-comment` | Retrieve comments |
| `retrieve-a-data-source` | Retrieve a data source |
| `retrieve-a-database` | Retrieve a database |
| `retrieve-a-page` | Retrieve a page |
| `retrieve-a-page-property` | Retrieve a page property item |

## Example `.mcp.json` Result

`install` writes/updates one server entry under `mcpServers.<name>`:

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["/abs/path/to/oh-my-notionmcp/bin/cli.mjs", "serve"],
      "env": {
        "OHMY_NOTION_OFFICIAL_COMMAND": "node",
        "OHMY_NOTION_OFFICIAL_ARGS_JSON": "[\"/abs/path/to/mcp-remote/dist/proxy.js\",\"https://mcp.notion.com/mcp\",\"--transport\",\"http-first\"]",
        "OHMY_NOTION_OFFICIAL_ENV_JSON": "{}"
      }
    }
  }
}
```

Actual paths/args vary by your environment. The fast read-only backend runs in-process and does not require separate configuration.

## Environment Overrides

### Router (official backend)

| Variable | Purpose |
| --- | --- |
| `OHMY_NOTION_ALLOW_NPX_FALLBACK` | Allow `npx` fallback for official backend (`true`/`1`/`yes`/`on`) |
| `OHMY_NOTION_OFFICIAL_COMMAND` | Official backend command |
| `OHMY_NOTION_OFFICIAL_ARGS_JSON` | JSON array of official backend args |
| `OHMY_NOTION_OFFICIAL_ENV_JSON` | JSON object env for official backend |
| `OHMY_NOTION_OFFICIAL_CWD` | Working directory for official backend |

### Fast Backend (in-process and standalone serve-fast)

| Variable | Purpose |
| --- | --- |
| `NOTION_TOKEN` | Notion integration token (for standalone `serve-fast`) |
| `OPENAPI_MCP_HEADERS` | JSON string with Notion API headers (alternative to `NOTION_TOKEN`) |
| `NOTION_MCP_FAST_CACHE_ENABLED` | Enable/disable response cache (default: `true`) |
| `NOTION_MCP_FAST_CACHE_TTL_MS` | Cache TTL in milliseconds (default: `30000`) |
| `NOTION_MCP_FAST_CACHE_MAX_ENTRIES` | Maximum cache entries (default: `300`) |
| `NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED` | Local DB fast-path gate (default: `false`) |
| `NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED` | Local DB trust gate (default: `false`) |

## Response Cache

The fast backend includes a local response cache for read operations.

- Cache key scope includes operation + params + base URL + auth/version fingerprint.
- Only successful responses are cached. Error responses are not cached.
- Add `__mcpFastForceRefresh: true` in tool arguments to bypass cache for a single request.

Request flow:

1. Response cache hit -> cached response returned.
2. Response cache miss -> local DB fast-path (if enabled).
3. Local DB miss -> Notion API call -> success response cached.
4. `__mcpFastForceRefresh: true` -> bypasses cache + local DB -> Notion API.

## Notion Desktop Local Fast-Path

If you use Notion desktop on the same machine, enable the local DB fast-path for very fast reads of recently synced content:

```bash
export NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED=true
export NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED=true
```

Supported operations: `retrieve-a-page`, `retrieve-a-block`, `get-block-children`.

Notes:

- Data freshness depends on Notion desktop sync state.
- Incomplete or unvisited local snapshots fall back to Notion API.

## Security Defaults

- `--fast-token` is intentionally blocked to avoid secret persistence in `.mcp.json`
- sensitive keys from `OHMY_NOTION_*_ENV_JSON` are redacted before `install` persists config
- child processes run with a restricted env allowlist
- `npx` fallback is disabled by default
- HTTP transport (`serve-fast --transport http`) requires bearer token auth by default

## Troubleshooting

`npx fallback for official backend is disabled`

- either configure `OHMY_NOTION_OFFICIAL_COMMAND` + `OHMY_NOTION_OFFICIAL_ARGS_JSON`
- or set `OHMY_NOTION_ALLOW_NPX_FALLBACK=true`

`FAIL: missing .mcp.json`

- run `install --project /your/project`
- `doctor` checks project `.mcp.json`, not this repository root by default

`FAIL: OAuth token cache not found`

- run `oh-my-notionmcp login` and complete browser auth
- rerun `doctor`

Reads seem stale

- open Notion desktop to refresh local cache
- if local read result is empty/error, router falls back to official MCP automatically

## Development

```bash
npm ci
npm run build
npm test
node bin/cli.mjs --help
```

## License

MIT
