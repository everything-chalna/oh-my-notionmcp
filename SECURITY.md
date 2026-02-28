# Security Policy

## Reporting a Vulnerability

Please do not open public issues for security-sensitive reports.

1. Send a report to the maintainer through a private channel.
2. Include reproduction steps, impact, and affected versions.
3. If possible, include a minimal proof-of-concept.

We will acknowledge reports and provide remediation status updates.

## Hardening Notes

- Avoid storing secrets in `.mcp.json`.
- `install` redacts sensitive env keys before persisting config.
- Keep `OHMY_NOTION_ALLOW_NPX_FALLBACK` disabled unless explicitly needed.
