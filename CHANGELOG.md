# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-02-28

### Added

- Single-router Notion MCP package (`oh-my-notionmcp`)
- Cache-first read path via local Notion desktop cache (`notion.db`) through in-process fast backend
- Official Notion MCP fallback for read misses/degraded reads
- Official Notion MCP passthrough for write operations
- CLI commands: `serve`, `install`, `login`, `doctor`
- Unit tests for routing and safety-critical helpers
- CI workflow (test + `npm pack --dry-run`)
- OSS baseline docs:
  - `LICENSE`
  - `SECURITY.md`
  - `CONTRIBUTING.md`
  - `CODE_OF_CONDUCT.md`

### Changed

- Hardened routing behavior and fallback logic
- Redacted sensitive env keys before persisting install config
- Added stricter security defaults for runtime command execution
- Reworked README with product-focused narrative and requirements

### Security

- Blocked `--fast-token` in install flow to reduce secret persistence risk
- Added child-process environment allowlist
- Added secret-focused `.gitignore` rules
