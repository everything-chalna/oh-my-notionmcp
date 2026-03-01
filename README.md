# oh-my-notionmcp

Ask your AI agent to read a Notion page. Here's what the official Notion MCP sends back for a paragraph that says "Hello world":

```json
{
  "object": "block",
  "id": "a1b2c3d4-...",
  "parent": { "type": "page_id", "page_id": "..." },
  "created_time": "2025-01-15T10:30:00.000Z",
  "last_edited_time": "2025-01-15T10:30:00.000Z",
  "created_by": { "object": "user", "id": "..." },
  "last_edited_by": { "object": "user", "id": "..." },
  "has_children": false,
  "archived": false,
  "in_trash": false,
  "type": "paragraph",
  "paragraph": {
    "rich_text": [{
      "type": "text",
      "text": { "content": "Hello world", "link": null },
      "annotations": {
        "bold": false, "italic": false, "strikethrough": false,
        "underline": false, "code": false, "color": "default"
      },
      "plain_text": "Hello world",
      "href": null
    }],
    "color": "default"
  }
}
```

That's ~500 bytes of JSON to say "Hello world". Not bold, not italic, not strikethrough, not underline, not code, not colored -- the API makes sure you know about every single formatting option this text _isn't_ using. Multiply this by 50 blocks on a page, and your agent just consumed 25KB of context to read what a human would scan in three seconds.

Now do that for every page, every block, every database query in a working session. Every call is a fresh API round-trip. No caching. The same page you read 10 seconds ago? Full network request, full metadata payload, all over again.

oh-my-notionmcp fixes both problems: it caches responses so repeated reads are instant, and when enabled, it reads directly from Notion desktop's local SQLite database -- skipping the network entirely.

## The Speedup

```
First read:    Notion API call, response cached.             ~200-500ms
Same read again (within 30s): cache hit.                     <1ms
With local SQLite enabled: Notion desktop DB query.          <10ms
```

No metadata stripping (Notion's API format is preserved for compatibility), but you stop paying the network tax over and over for the same data. In a typical AI coding session that hits the same pages repeatedly, most reads become cache hits after the first pass.

## How It Works

Two backends run behind a single MCP server alias:

```
oh-my-notionmcp (router)
|
|-- Fast backend (in-process, zero subprocess overhead)
|   |-- Response cache (30s TTL, 300 entries, LRU)
|   |-- Notion desktop SQLite fast-path (optional)
|   '-- Notion API client
|
'-- Official backend (child process, only when needed)
    '-- mcp-remote -> https://mcp.notion.com/mcp
```

Reads go through the fast backend first. Cache hit? Done. Cache miss? Try local SQLite. Still no? Hit the API and cache the result. Writes always go through the official backend.

The fast backend runs in-process -- not as a child process. No IPC serialization, no startup cost. The official backend only spins up for writes or when the fast backend can't handle a request.

### OpenAPI-Driven Tool Generation

Tools aren't hardcoded. The fast backend reads an OpenAPI spec at startup and generates MCP tools automatically. Adding a new Notion API endpoint means updating a JSON file and restarting -- no code changes.

### The Local SQLite Trick

Notion desktop is an Electron app. It keeps a SQLite database at `~/Library/Application Support/Notion/notion.db` with your synced workspace data. When enabled, oh-my-notionmcp queries this database directly and transforms the result into the official API response format. Downstream consumers can't tell the difference, but the read happened without touching the network.

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
oh-my-notionmcp reauth                                   # Clear OAuth token cache
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

### OAuth Token Not Found / Expired

```
FAIL: OAuth token cache not found
```

Run `oh-my-notionmcp login` to initialize or refresh the OAuth token. Complete browser authentication, then press Ctrl+C after seeing "Proxy established".

If the token exists but is expired, the server will hint: "Token may be expired — try `oh-my-notionmcp login`".

### mcp-remote Not Installed

```
npx fallback for official backend is disabled
```

Install mcp-remote as a local dependency:
```bash
npm install mcp-remote
```

Or enable npx fallback (not recommended for production):
```bash
export OHMY_NOTION_ALLOW_NPX_FALLBACK=true
```

### Connection Timeout

If the official backend takes more than 30 seconds to connect, the router enters degraded mode (read-only via fast backend). Check:

1. Network connectivity to `mcp.notion.com`
2. OAuth token validity (`oh-my-notionmcp doctor`)
3. mcp-remote installation (`oh-my-notionmcp doctor`)

### Re-authenticating (Token Refresh)

If you need to force a fresh OAuth login (expired tokens, wrong account, scope issues):

**Option 1: Via MCP tool** (while server is running)

Use the `oh-my-notionmcp-reauth` tool from your MCP client (e.g., Claude). This clears cached tokens and reconnects automatically.

**Option 2: Via CLI**

```bash
oh-my-notionmcp reauth   # Clear cached tokens
oh-my-notionmcp login     # Re-authenticate with Notion
oh-my-notionmcp doctor    # Verify everything works
```

### Backend Reconnection

If the official backend process crashes during operation, the router automatically attempts one reconnect (10-second timeout). If reconnect fails, subsequent calls return an error with both the original and reconnect failure reasons.

### Other Issues

`FAIL: missing .mcp.json` -- Run `install --project /your/project`.

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
