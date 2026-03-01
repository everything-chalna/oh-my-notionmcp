# CLAUDE.md

## Project Overview

oh-my-NotionMCP -- a unified Notion MCP server that combines:

- **Router layer** (`src/router/`): merges two backends behind a single MCP server alias. Reads go local-cache-first via the fast backend (in-process), writes go to the official Notion MCP (child process via `mcp-remote`).
- **Fast read-only backend** (`src/fast/`): OpenAPI-driven MCP engine that auto-generates tools from `scripts/notion-openapi.json`, with response caching and optional Notion desktop SQLite fast-path.

## Architecture

```
src/main.ts                        # CLI entry point (serve, serve-fast, install, login, doctor)
src/router/
├── router.ts                      # OhMyNotionRouter + FastBackendAdapter (in-process fast, child-process official)
├── backend-client.ts              # BackendClient -- child-process adapter for the official MCP
├── config.ts                      # resolveOfficialBackendConfig, BackendSpec
├── install.ts                     # commandInstall -- writes .mcp.json
├── login.ts                       # commandLogin -- OAuth bootstrap
├── doctor.ts                      # commandDoctor -- config validation
└── utils.ts                       # parseArgs, constants, tool-name helpers
src/fast/
├── init-server.ts                 # Loads OpenAPI spec, validates, creates MCPProxy
└── openapi-mcp-server/
    ├── openapi/parser.ts          # OpenAPI -> MCP tool conversion
    ├── mcp/proxy.ts               # MCPProxy (registers tools with MCP SDK)
    ├── mcp/read-only-allowlist.ts  # Read-only tool enforcement
    ├── mcp/proxy-cache-params.ts   # Per-tool cache configuration
    ├── client/http-client.ts       # Axios-based Notion API client
    ├── cache/                      # Response cache (TTL, disk persistence)
    ├── local-app-cache/            # Notion desktop SQLite fast-path
    ├── auth/                       # Auth template rendering
    └── openapi/file-upload.ts      # Multipart file upload support
scripts/
└── notion-openapi.json            # OpenAPI 3.1 spec -- source of truth for all Notion API tools
```

## Key Commands

```bash
npm run build        # tsc --build + esbuild -> bin/cli.mjs
npm test             # vitest (all tests under test/)
npm run dev          # tsx watch src/main.ts serve
npm run serve        # node bin/cli.mjs serve (router mode)
```

## CLI Commands

```bash
oh-my-notionmcp serve          # Start the router (reads + writes via two backends)
oh-my-notionmcp serve-fast     # Start standalone fast read-only server
oh-my-notionmcp install        # Add/update router entry in .mcp.json
oh-my-notionmcp login          # OAuth bootstrap for official backend
oh-my-notionmcp doctor         # Config validation
oh-my-notionmcp reauth         # Clear OAuth token cache (run login again after)
```

## Adding New Notion API Endpoints

Only modify `scripts/notion-openapi.json`. Tools are auto-generated from the spec at startup -- no code changes needed.

### Tool Generation Flow

1. `OpenAPIToMCPConverter.convertToMCPTools()` iterates all paths/operations
2. Each operation becomes an MCP tool (name = `operationId`)
3. Parameters + requestBody -> `inputSchema`; response schema -> `returnSchema`
4. `MCPProxy.setupHandlers()` registers tools with the MCP SDK
5. Read-only allowlist filters which tools are exposed

## Routing Policy

| Operation | Route |
| --- | --- |
| Read tool (same name in both backends) | fast in-process first, then official fallback |
| Read tool (official only, boostable) | try fast equivalent, then official |
| Write tool | official only |
| Official unavailable | degraded read-only mode from fast backend |

The fast backend runs **in-process** via `FastBackendAdapter` (using `InMemoryTransport`), while the official backend runs as a **child process** via `BackendClient`.

## Testing

```bash
npm test                         # Run all tests
npx vitest run test/fast/        # Fast backend tests only
npx vitest run test/router/      # Router tests only
```

Tests are under `test/fast/` and `test/router/`, mirroring the source structure.

## Connection Flow

### Install → Login → Doctor → Serve

1. `oh-my-notionmcp install` — writes MCP server entry to `.mcp.json`
2. `oh-my-notionmcp login` — OAuth bootstrap via mcp-remote (complete in browser, Ctrl+C after "Proxy established")
3. `oh-my-notionmcp doctor` — validates config + auth readiness
4. `oh-my-notionmcp serve` — starts router server

### Reconnect Behavior

When the official backend (child process) crashes or becomes unresponsive:

1. `callTool()` fails → automatic reconnect attempt (1 retry only)
2. Reconnect: close old transport → create new Client + StdioClientTransport → connect → listTools
3. Reconnect timeout: 10 seconds
4. If reconnect succeeds: retry the original tool call
5. If reconnect fails: return clear error with both original + reconnect failure reasons

### Connect Timeout

- `connectOfficial()` has a 30-second timeout
- If timeout expires, router enters degraded mode (fast-only, read-only tools)
- Warning logged to stderr

### Auth Error Detection

- When official backend returns 401/unauthorized/token expired errors
- Error response includes hint: "Token may be expired — try `oh-my-notionmcp login`"

### Re-authentication (reauth)

When OAuth tokens become invalid or need to be refreshed:

**Via MCP tool** (during a live session):
- Tool name: `oh-my-notionmcp-reauth`
- Clears cached OAuth tokens from `~/.mcp-auth/mcp-remote-*/`
- Disconnects the official backend
- Reconnects with fresh credentials (triggers new OAuth flow)
- Rebuilds the routing table

**Via CLI** (standalone):
- Command: `oh-my-notionmcp reauth`
- Clears cached token files only (no reconnect)
- Follow with `oh-my-notionmcp login` to re-authenticate

Token cache files cleared:
- `{hash}_tokens.json`
- `{hash}_client_info.json`
- `{hash}_code_verifier.txt`

Where `{hash}` is MD5 of the MCP server URL.

## Security

### File Path Validation

`prepareFileUpload()` in `http-client.ts` validates file paths to prevent path traversal:
- Paths containing `..` components are rejected
- Error: "Path traversal detected in file path: <path>"

### Token Handling

- Generated auth tokens for HTTP transport are output to stderr (not stdout)
- Prevents token leakage through MCP stdio transport
- Sensitive env keys (TOKEN, SECRET, PASSWORD, AUTH, _KEY, PRIVATE) are redacted from persisted .mcp.json config

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| OHMY_NOTION_OFFICIAL_COMMAND | Override official backend command | `node` (local) / `npx` (fallback) |
| OHMY_NOTION_OFFICIAL_ARGS_JSON | Override official backend args (JSON array) | auto-detected |
| OHMY_NOTION_OFFICIAL_ENV_JSON | Extra env vars for official backend (JSON object) | `{}` |
| OHMY_NOTION_OFFICIAL_CWD | Working directory for official backend | undefined |
| OHMY_NOTION_ALLOW_NPX_FALLBACK | Allow npx when local mcp-remote not found | `false` |
| NOTION_MCP_FAST_CACHE_ENABLED | Enable read response cache | `true` |
| NOTION_MCP_FAST_CACHE_TTL_MS | Cache TTL in milliseconds | `30000` |
| NOTION_MCP_FAST_CACHE_MAX_ENTRIES | Maximum cache entries | `300` |
| NOTION_MCP_FAST_CACHE_PATH | Custom cache file path | `~/.cache/oh-my-notionmcp/read-cache-v1.json` |
| MCP_REMOTE_CONFIG_DIR | Override mcp-remote config directory | `~/.mcp-auth` |

## API Version

Uses Notion API version `2025-09-03` (Data Source Edition).
