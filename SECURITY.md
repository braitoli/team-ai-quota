# Security Policy

## Supported Versions

We provide security updates and patches for the current major release:

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

We take the security of **AI Quota Monitor** seriously. If you discover a security vulnerability, please do **NOT** open a public GitHub issue.

Instead, please report it responsibly through one of the following channels:
1. **GitHub Security Advisory**: Open a private advisory under the repository's "Security" -> "Advisories" tab (recommended).
2. **Email**: Contact our maintainers at `security@example.com` with:
   - A detailed description of the vulnerability.
   - Steps to reproduce or proof-of-concept (PoC) code.
   - The potential impact and affected components.
   - Any suggested mitigations.

You will receive an initial response within 48 hours acknowledging receipt of your report. We will coordinate a fix and release a patched version before disclosing the issue publicly.

## Security Architecture & Best Practices

AI Quota Monitor is designed with security and zero-trust isolation in mind:

### 1. Zero Credential Extraction
- **No Token Inspection**: The client daemons (`client/report_quota.py`, `client/report_codex.py`, `client/report_agy.py`) never read, inspect, store, or transmit OAuth tokens, OS keychains, or session files.
- **Local CLI Introspection**: Quota is determined strictly by querying the installed CLI tools directly via local processes (e.g., `claude -p "/usage"` or local stdio RPCs).
- **Zero API Quota Burn**: Usage checks consume 0 API tokens during normal polling.

### 2. Edge & Server Authentication
- **Constant-Time Verification**: Server endpoints authenticate requests via `timingSafeEqual`, preventing timing side-channel attacks against the shared `API_SECRET_KEY`.
- **Private Cache Control**: All sensitive snapshot endpoints and dashboards emit `Cache-Control: private, no-store` to prevent caching by intermediary proxies or CDNs.
- **Strict Input Validation**: Payloads are strictly sanitized and bounded (`validateReport`) before executing any SQLite transaction.

### 3. Client Self-Update Security
- **Commit Verification**: When self-updating, client daemons verify that GitHub release commits are cryptographically signed (**Verified**) by maintainers before replacement.
- **Kill-Switch**: Self-update can be disabled system-wide at any time by setting `CLAUDE_QUOTA_NO_UPDATE=1` or creating a local `no_update` marker file.

### 4. Secret Management
- Never commit `.dev.vars`, `.env`, or production secret keys to version control.
- In Cloudflare Workers deployments, use `npx wrangler secret put API_SECRET_KEY` rather than plaintext configuration files.
- In Docker or bare-metal deployments, inject `API_SECRET_KEY` via secured environment variables or container secret mounts.
- `wrangler.jsonc` (local config with `account_id` and KV namespace IDs) is excluded from git tracking via `.gitignore`. Use `wrangler.jsonc.example` as the committed template.

## Known Historical Disclosures

| Item | Status | Notes |
|------|--------|-------|
| Cloudflare `account_id` in git history (prior to v1.0.0) | Addressed | The `account_id` has been removed from `wrangler.jsonc` and that file is now gitignored. Per [Cloudflare's public documentation](https://developers.cloudflare.com/fundamentals/setup/find-account-and-zone-ids/), an `account_id` is not a secret and cannot be used to authenticate API requests without an API token. No sensitive credentials were exposed. |
