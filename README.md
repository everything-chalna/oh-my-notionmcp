# oh-my-notionmcp

You ask your AI agent to look up a Notion page. The official Notion MCP fires an API call, waits for the response, and hands back the full payload. Two seconds later you ask for the same page's children. Another API call. Same latency. Same bloated response. Repeat this fifty times during a coding session and you've burned through tokens, rate limits, and patience.

oh-my-notionmcp puts a local-first read layer in front of the official Notion MCP. Reads cascade through up to four levels before hitting the network, and when they do hit the network, the response gets cached so the next call doesn't have to.

```
Request flow:

1. Response cache (in-memory + disk)  -- hit? done. <1ms.
2. Local Notion desktop SQLite        -- hit? done. <10ms.
3. Notion API (via fast backend)      -- response cached for next time.
4. Official Notion MCP (fallback)     -- full compatibility, always available.
```

Writes always go through the official MCP. No shortcuts there.

## How It Works

Two backends run behind a single MCP server alias:

```
oh-my-notionmcp (router)
|
|-- Fast backend (in-process, no subprocess overhead)
|   |-- OpenAPI-generated read tools
|   |-- Response cache (30s TTL, 300 entries, LRU eviction)
|   |-- Notion desktop SQLite fast-path (optional)
|   '-- Notion API client (Axios)
|
'-- Official backend (child process via mcp-remote)
    '-- https://mcp.notion.com/mcp
```

The fast backend runs in-process -- no child process, no IPC overhead. The official backend runs as a separate child process only when needed (writes, fallback reads).

### OpenAPI-Driven Tool Generation

Tools aren't hardcoded. The fast backend reads `scripts/notion-openapi.json` at startup and generates MCP tools from the OpenAPI spec automatically. Adding a new Notion API endpoint means updating the JSON file and restarting. No code changes.

### The Local SQLite Fast-Path

Notion desktop (the Electron app) keeps a local SQLite database at `~/Library/Application Support/Notion/notion.db`. When enabled, oh-my-notionmcp queries this database directly for `retrieve-a-page`, `retrieve-a-block`, and `get-block-children`. The result gets transformed into the official API response format, so downstream consumers can't tell the difference.

## Quick Start

```bash
# 1. Install
npm install -g oh-my-notionmcp

# 2. Add to your project
oh-my-notionmcp install --project /path/to/project --name notion

# 3. Authenticate with official Notion MCP
oh-my-notionmcp login
# Complete browser auth, then Ctrl+C after "Proxy established"

# 4. Verify everything works
oh-my-notionmcp doctor --project /path/to/project --name notion
```

## Requirements

- macOS (Notion desktop cache path is macOS-specific)
- Node.js >= 20
- Notion desktop app installed and opened at least once (for local SQLite fast-path)
- Official Notion MCP OAuth session for writes and fallback reads (`login` command)

## Routing Policy

| Operation | Route |
|---|---|
| Read (tool exists in both backends) | Fast backend first, official fallback on error |
| Read (official only) | Try fast equivalent, then official |
| Write | Official MCP only |
| Official unavailable | Degraded read-only mode from fast backend |

## Commands

```bash
oh-my-notionmcp serve                                    # Router mode (reads + writes)
oh-my-notionmcp serve-fast [--transport <stdio|http>]    # Standalone fast read-only server
oh-my-notionmcp install [--project <dir>] [--name <name>]
oh-my-notionmcp login
oh-my-notionmcp doctor [--project <dir>] [--name <name>] [--allow-missing-auth]
```

### serve-fast (standalone)

Run just the fast read-only server without the router or official backend:

```bash
export NOTION_TOKEN="ntn_****"
oh-my-notionmcp serve-fast

# or with HTTP transport
oh-my-notionmcp serve-fast --transport http --port 3000
```

## Read-Only Tools

Auto-generated from the OpenAPI spec. Currently 13 read operations:

| Tool | Description |
|---|---|
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

## Response Cache

- 30-second TTL, max 300 entries, LRU eviction
- Cache key = operation + params + auth fingerprint + base URL
- Only successful responses are cached
- Pass `__mcpFastForceRefresh: true` in tool arguments to bypass cache for a single request
- Persisted to disk at `~/.cache/oh-my-notionmcp/read-cache-v1.json`

## Notion Desktop SQLite Fast-Path

Disabled by default. Enable it if you run Notion desktop on the same machine:

```bash
export NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED=true
export NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED=true
```

Supported: `retrieve-a-page`, `retrieve-a-block`, `get-block-children`.
Freshness depends on Notion desktop sync state. Incomplete snapshots fall back to the API.

## Example `.mcp.json`

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

## Environment Variables

### Router

| Variable | Purpose |
|---|---|
| `OHMY_NOTION_ALLOW_NPX_FALLBACK` | Allow `npx` fallback for official backend |
| `OHMY_NOTION_OFFICIAL_COMMAND` | Official backend command |
| `OHMY_NOTION_OFFICIAL_ARGS_JSON` | JSON array of official backend args |
| `OHMY_NOTION_OFFICIAL_ENV_JSON` | JSON object env for official backend |
| `OHMY_NOTION_OFFICIAL_CWD` | Working directory for official backend |

### Fast Backend

| Variable | Default | Purpose |
|---|---|---|
| `NOTION_TOKEN` | | Integration token (for standalone `serve-fast`) |
| `OPENAPI_MCP_HEADERS` | | JSON string with Notion API headers |
| `NOTION_MCP_FAST_CACHE_ENABLED` | `true` | Enable/disable response cache |
| `NOTION_MCP_FAST_CACHE_TTL_MS` | `30000` | Cache TTL in milliseconds |
| `NOTION_MCP_FAST_CACHE_MAX_ENTRIES` | `300` | Max cache entries |
| `NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED` | `false` | SQLite fast-path gate |
| `NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED` | `false` | SQLite trust gate |

## Security

- `--fast-token` blocked to prevent secret persistence in `.mcp.json`
- Sensitive keys redacted from env JSON before `install` persists config
- Child processes run with restricted env allowlist
- `npx` fallback disabled by default
- HTTP transport requires bearer token auth by default

## Troubleshooting

`npx fallback for official backend is disabled` -- Configure `OHMY_NOTION_OFFICIAL_COMMAND` + `OHMY_NOTION_OFFICIAL_ARGS_JSON`, or set `OHMY_NOTION_ALLOW_NPX_FALLBACK=true`.

`FAIL: missing .mcp.json` -- Run `install --project /your/project`.

`FAIL: OAuth token cache not found` -- Run `oh-my-notionmcp login`, complete browser auth, then rerun `doctor`.

`Reads seem stale` -- Open Notion desktop to refresh local cache. Empty/error local reads fall back to official MCP automatically.

## Development

```bash
npm ci
npm run build
npm test
node bin/cli.mjs --help
```

Release notes: [CHANGELOG.md](./CHANGELOG.md)

## License

MIT
