# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-24

### Added

- Panel UI for **start / stop / restart** of managed database containers, with color-coded status tags and auto-refresh while containers are in a transitional state.
- `POST /api/installations/:name/start|stop|restart` API endpoints, restricted to containers carrying the `database-panel.managed=true` label.
- Modal accessibility: focus on open, Escape-to-close, focus restore.
- GitHub Actions CI running the test suite on Node 20 and 22 for pushes and pull requests to `main`.
- `SECURITY.md` with responsible-disclosure guidance and a deployment baseline (HTTPS, trusted network, restricted database ports, strong panel key).
- Tests for security headers, HEAD requests, 413/400 body handling, container lifecycle actions, auth rate limiting, corrupt-config fail-closed startup, and Docker port-conflict → HTTP 409 mapping.

### Changed

- API responses now carry a Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Cross-Origin-Opener-Policy`; API responses are `no-store`.
- Rate limiting: `/api/setup` at 5 attempts/min per IP; failed authenticated `/api/*` requests at 30/min per IP with 429 + `Retry-After`.
- Docker errors are mapped to meaningful statuses: 400 invalid input, 404 unknown container/route, 409 name/port conflicts, 502 daemon/timeout errors.
- Docker output capped at 1 MB; command timeouts now reliably terminate the child process.
- A corrupt or unreadable `state/panel-config.json` fails closed (exit 1) with an actionable message instead of an uncaught exception.
- Graceful shutdown on `SIGTERM`/`SIGINT`; HTTP server timeouts set; `PORT` validated at startup.
- Dockerfile `HEALTHCHECK` probing `/api/health`.

### Fixed

- Oversized request bodies no longer destroy the socket mid-request; clients receive a proper 413.
- Malformed JSON bodies now return 400 instead of hanging the connection.

## [1.0.0]

Initial release: one-command VPS installer, five supported engines (MySQL, PostgreSQL, MariaDB, MongoDB, Redis), persistent labeled volumes, first-run setup with scrypt-hashed access key, and a web panel for catalog browsing and deployment.
