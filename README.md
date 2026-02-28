# oh-my-notionmcp

Unified Notion MCP router for macOS.

- Read: local Notion desktop cache first (`notion-mcp-fast`)
- Fallback: official Notion MCP on local read miss/error
- Write: official Notion MCP only

Release notes: [CHANGELOG.md](./CHANGELOG.md)

## Why This Exists

The official Notion MCP is great for correctness and write flows, but read-heavy exploration can feel slower than local cache access.

`oh-my-notionmcp` keeps one MCP server alias (default: `notion`) and routes calls to the right backend:

- cache-first for reads
- official MCP for writes

You get fast local reads without giving up official write compatibility.

## Routing Policy

| Operation | Route |
| --- | --- |
| Read tool | `notion-mcp-fast` first, then official Notion MCP fallback |
| Write tool | official Notion MCP only |
| Official unavailable | degraded read-only mode from fast backend |

Notes:

- Tool surface is official-first when official backend is available.
- Fast-only write tools are not exposed.

## Requirements

- macOS (Notion desktop cache path is macOS-specific)
- Node.js `>=20`
- Notion desktop app installed and opened at least once
- Official Notion MCP OAuth session for fallback/write path (`login` command)
- `notion-mcp-fast` availability:
  - recommended: local binary configured via env overrides
  - or allow `npx` fallback explicitly (`OHMY_NOTION_ALLOW_NPX_FALLBACK=true`)

## Quick Start

1. Install CLI

```bash
npm install -g oh-my-notionmcp
```

2. Choose fast backend mode

Recommended (no `npx` fallback):

```bash
export OHMY_NOTION_FAST_COMMAND=node
export OHMY_NOTION_FAST_ARGS_JSON='["/absolute/path/to/notion-mcp-fast/bin/cli.mjs"]'
```

Quick setup (uses `npx`, less strict):

```bash
export OHMY_NOTION_ALLOW_NPX_FALLBACK=true
```

3. Install router entry into your project `.mcp.json`

```bash
oh-my-notionmcp install --project /path/to/project --name notion
```

4. Run official OAuth bootstrap

```bash
oh-my-notionmcp login
```

Complete browser auth, then press `Ctrl+C` after `Proxy established`.

5. Validate setup

```bash
oh-my-notionmcp doctor --project /path/to/project --name notion
```

## Commands

```bash
oh-my-notionmcp serve
oh-my-notionmcp install [--project <dir>] [--name <mcp-server-name>]
oh-my-notionmcp login
oh-my-notionmcp doctor [--project <dir>] [--name <mcp-server-name>] [--allow-missing-auth]
```

`install` defaults:

- `--project`: current working directory
- `--name`: `notion`

`doctor`:

- fails when auth token cache is missing
- use `--allow-missing-auth` to downgrade missing auth to warning

## Example `.mcp.json` Result

`install` writes/updates one server entry under `mcpServers.<name>`:

```json
{
  "mcpServers": {
    "notion": {
      "command": "node",
      "args": ["/abs/path/to/oh-my-notionmcp/bin/cli.mjs", "serve"],
      "env": {
        "OHMY_NOTION_FAST_COMMAND": "node",
        "OHMY_NOTION_FAST_ARGS_JSON": "[\"/abs/path/to/notion-mcp-fast/bin/cli.mjs\"]",
        "OHMY_NOTION_FAST_ENV_JSON": "{\"NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED\":\"true\",\"NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED\":\"true\"}",
        "OHMY_NOTION_OFFICIAL_COMMAND": "node",
        "OHMY_NOTION_OFFICIAL_ARGS_JSON": "[\"/abs/path/to/mcp-remote/dist/proxy.js\",\"https://mcp.notion.com/mcp\",\"--transport\",\"http-first\"]",
        "OHMY_NOTION_OFFICIAL_ENV_JSON": "{}"
      }
    }
  }
}
```

Actual paths/args vary by your environment.

## Environment Overrides

| Variable | Purpose |
| --- | --- |
| `OHMY_NOTION_ALLOW_NPX_FALLBACK` | Allow `npx` fallback for backends (`true`/`1`/`yes`/`on`) |
| `OHMY_NOTION_FAST_COMMAND` | Fast backend command |
| `OHMY_NOTION_FAST_ARGS_JSON` | JSON array of fast backend args |
| `OHMY_NOTION_FAST_ENV_JSON` | JSON object env for fast backend |
| `OHMY_NOTION_FAST_CWD` | Working directory for fast backend |
| `OHMY_NOTION_OFFICIAL_COMMAND` | Official backend command |
| `OHMY_NOTION_OFFICIAL_ARGS_JSON` | JSON array of official backend args |
| `OHMY_NOTION_OFFICIAL_ENV_JSON` | JSON object env for official backend |
| `OHMY_NOTION_OFFICIAL_CWD` | Working directory for official backend |

## Security Defaults

- `--fast-token` is intentionally blocked to avoid secret persistence in `.mcp.json`
- sensitive keys from `OHMY_NOTION_*_ENV_JSON` are redacted before `install` persists config
- child processes run with a restricted env allowlist
- `npx` fallback is disabled by default

## Troubleshooting

`npx fallback for fast backend is disabled`

- either configure `OHMY_NOTION_FAST_COMMAND` + `OHMY_NOTION_FAST_ARGS_JSON`
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
npm test
node bin/cli.mjs --help
```

## License

MIT
