# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Texts the server puts in the snapshot (predictions, badges, auth labels, opportunity lines, machine intensity, placeholders for unnamed machines) are now English plus `<field>_key` / `<field>_params`, so the dashboard shows them in the selected language (English mode no longer shows Vietnamese). Old fields are kept; see `docs/api.md`.

## [1.0.0] - 2026-11-06

### Added

- Multi-provider CLI Coding Agent support: claude, codex, agy, gemini, copilot, cursor
- Smart team load balancing & routing (`GET /api/route`) with 7-day weighted priority over 5-hour
- Real-time quota burn rate velocity tracking and projected exhaustion detection
- Seat collision detection (multiple machines using same account simultaneously)
- Post-reset auto-recovery: stale `weekly_capped` accounts automatically transition to 100% ready when reset timestamp passes
- Settings & Labeling UI (⚙️ modal): enable/disable providers, configure quota windows (7d/5h/30d), assign friendly labels to machines & accounts
- 20-language i18n support with browser auto-detection
- Standalone Node.js 22+ server (`node:sqlite`, zero native dependencies)
- Docker support: `Dockerfile` (node:22-alpine), `docker-compose.yml`, persistent SQLite WAL via volume
- Multi-arch Docker image published to `ghcr.io` (linux/amd64, linux/arm64)
- Comprehensive documentation: README (EN) + 5 language translations (vi, zh-CN, ja, ko, es)
- Deployment guide: Cloudflare Workers, Docker Compose, VPS/systemd, Kubernetes
- GitHub Actions CI/CD: Node.js + Python + Docker smoke test on every push

[Unreleased]: https://github.com/braitoli/team-ai-quota/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/braitoli/team-ai-quota/releases/tag/v1.0.0
