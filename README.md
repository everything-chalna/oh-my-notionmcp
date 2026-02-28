# oh-my-NotionMCP

`oh-my-NotionMCP` is a single Notion MCP router with a cache-first read path:

- Read:
  - 1st: local Notion desktop cache (`notion.db`) via `notion-mcp-fast`
  - 2nd: official Notion MCP fallback (OAuth)
- Write:
  - official Notion MCP only (OAuth)

`oh-my-notionmcp` keeps fast+official behavior under one MCP server contract (`notion`) so clients do not need separate fast/offical aliases.

## Why It Is Fast

For many reads, local SQLite cache access is faster than remote API round-trips.

- cached/visited content: fast local hit
- fast miss/error (including empty structured results): automatic official fallback

## Why `notion.db` (Not IndexedDB)

This project targets the local cache used by the Notion desktop app, which is stored in local database files (`notion.db`), not browser IndexedDB.  
So "fast read" here means local `notion.db` query path.

## Single Server Contract

Expose and use one alias only (recommended: `notion`).

- use `notion` for all Notion prompts
- do not call separate `notion-fast` / `notion-official` aliases

## Install

```bash
oh-my-notionmcp install --project /path/to/project --name notion
```

Then bootstrap OAuth:

```bash
oh-my-notionmcp login
```

Then verify:

```bash
oh-my-notionmcp doctor --project /path/to/project --name notion
```

## Commands

- `oh-my-notionmcp serve`
- `oh-my-notionmcp install [--project <dir>] [--name <mcp-server-name>]`
- `oh-my-notionmcp login`
- `oh-my-notionmcp doctor [--project <dir>] [--name <mcp-server-name>] [--allow-missing-auth]`

## Security Defaults

- `--fast-token` is blocked to prevent writing secrets into `.mcp.json`.
- Sensitive env keys from `OHMY_NOTION_*_ENV_JSON` are redacted before being persisted by `install`.
- Child backend processes receive a minimal allowlisted environment.
- `npx` runtime fallback is disabled by default.
  - To allow it explicitly: `OHMY_NOTION_ALLOW_NPX_FALLBACK=true`

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

Default fast env:

- `NOTION_MCP_FAST_LOCAL_APP_CACHE_ENABLED=true`
- `NOTION_MCP_FAST_LOCAL_APP_CACHE_TRUST_ENABLED=true`
