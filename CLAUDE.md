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

## API Version

Uses Notion API version `2025-09-03` (Data Source Edition).
