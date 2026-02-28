# OhMyNotionMCP

Fast, unified MCP server for Notion on macOS:

- local-cache-first reads for speed
- official MCP fallback for uncached/degraded reads
- official MCP passthrough for writes

Release notes: see [CHANGELOG.md](./CHANGELOG.md)

## Description

OhMyNotionMCP combines `notion-mcp-fast` and official Notion MCP behind one server alias (`notion`) so reads are fast by default and writes stay fully compatible.

## Why I Built This

When using the official Notion MCP with Claude Code, read workflows often felt slow and context-heavy.

The problem:

- official MCP uses network/API calls for reads
- repeated exploration adds latency and token/context cost
- reads may include more metadata than needed for quick iteration

My solution: read from Notion desktop's local cache first, then fallback to official MCP when needed.

`oh-my-notionmcp` routes requests like this:

- Read: local cache (`notion.db`) via `notion-mcp-fast` -> official Notion MCP fallback
- Write: official Notion MCP only

This keeps one MCP alias (`notion`) while combining speed and compatibility.

## Why It Is Fast

- zero network round-trip on local cache hits
- smaller/faster iteration for frequent read workflows
- automatic fallback to official MCP on miss/error

## Why `notion.db` (Not IndexedDB)

Notion desktop cache for this flow is read from local database files (`notion.db`) via `notion-mcp-fast`.

## Requirements

- macOS (Notion desktop cache path expected by `notion-mcp-fast`)
- Notion desktop app installed and opened at least once
- official Notion MCP OAuth login for fallback/write path

## Install

```bash
oh-my-notionmcp install --project /path/to/project --name notion
oh-my-notionmcp login
oh-my-notionmcp doctor --project /path/to/project --name notion
```

## Commands

- `oh-my-notionmcp serve`
- `oh-my-notionmcp install [--project <dir>] [--name <mcp-server-name>]`
- `oh-my-notionmcp login`
- `oh-my-notionmcp doctor [--project <dir>] [--name <mcp-server-name>] [--allow-missing-auth]`

## Security Defaults

- `--fast-token` is blocked to prevent secrets in `.mcp.json`
- sensitive keys from `OHMY_NOTION_*_ENV_JSON` are redacted on install
- child backend processes use a safe env allowlist
- `npx` fallback is off by default (`OHMY_NOTION_ALLOW_NPX_FALLBACK=true` to enable)

## Environment Overrides

- `OHMY_NOTION_ALLOW_NPX_FALLBACK`
- `OHMY_NOTION_FAST_COMMAND`
- `OHMY_NOTION_FAST_ARGS_JSON`
- `OHMY_NOTION_FAST_ENV_JSON`
- `OHMY_NOTION_FAST_CWD`
- `OHMY_NOTION_OFFICIAL_COMMAND`
- `OHMY_NOTION_OFFICIAL_ARGS_JSON`
- `OHMY_NOTION_OFFICIAL_ENV_JSON`
- `OHMY_NOTION_OFFICIAL_CWD`
