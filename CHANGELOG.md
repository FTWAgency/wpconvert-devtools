# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-19

### Added — `wpconvert@0.4.0` (CLI)

- **Free guest previews without an account**: with no key, `wpconvert convert` shows a link and code; one browser check gives a few WordPress Playground previews for 24 hours. `--guest` skips the question in scripts; CI never starts a guest session. Guest uploads are capped at 50MB and never retried automatically.
- **Browser sign-in**: `wpconvert login` opens a link, you sign in and type the code, and a new key is saved to `~/.wpconvert/config.json` (0600). `--paste` and `--key` still store an existing key.
- **Buying from the terminal**: `wpconvert plans` (every option, what it includes, today's price), `wpconvert unlock <jobId>` (Starter, Pro, Agency or PAYG for this theme, then download) and `wpconvert upgrade`. Flags `--starter`, `--pro`, `--agency`, `--payg <n>`, `--yearly`, `--yes`, `--no-open`, `--no-download`, `--out`. Every purchase confirms the amount first and pays in Stripe Checkout in your browser. No free trial through the terminal.
- Exit code `2` when a purchase needs a choice but there is no terminal to ask.

### Added — `@wpconvert/mcp@0.4.0` (MCP)

- `wpconvert_connect` / `wpconvert_connect_status`: guest previews or browser sign-in without `WPCONVERT_API_KEY`. The agent shows the link; it never opens it.
- `wpconvert_plans` / `wpconvert_checkout`: show every option, then a Stripe link for the option the user picked.
- Guest-aware `wpconvert_convert_folder`, `wpconvert_check_status`, `wpconvert_download_result` and `wpconvert_quota`; locked downloads point to `wpconvert_plans`.
- `WPCONVERT_API_KEY` is now optional (server.json `isRequired: false`).
- Depends exactly on `wpconvert@0.4.0`.

### Fixed (both)

- A missing API key is reported as `missing_credentials` instead of a network error.
- Secret redaction no longer garbles the MCP's no-key message, and now also masks guest tokens (`wpcg_…`) and device codes (`wpcd_…`).

### Changed

- `openapi.yaml` re-mirrored: adds `GET /api/billing/catalog`, `GET /api/billing/cli-options` and `POST /api/billing/cli-checkout`.

## [0.3.2] - 2026-10-19

### Fixed — `@wpconvert/mcp@0.3.2` (MCP)

- The server now starts when launched with the documented `npx -y @wpconvert/mcp` command. 0.3.1 compared the unresolved `node_modules/.bin/wpconvert-mcp` symlink against its own file path, never started, and exited silently with code 0.

### Unchanged in 0.3.2

- `wpconvert` stays at 0.3.1 (no CLI changes); `@wpconvert/mcp@0.3.2` still pins `wpconvert@0.3.1` exactly
- MCP tools, schemas, REST API, and conversion behavior

## [0.3.1] - 2026-08-19

### Changed — `wpconvert@0.3.1` (CLI)

- npm metadata: `homepage`, `repository`, `bugs`, expanded discovery keywords
- MIT `LICENSE` file now ships in the npm tarball (previously declared but missing)
- README: Playground session lifetime corrected to approximately ten minutes
- Cross-platform test runner (`scripts/run-tests.cjs`) for Linux CI — no command or conversion behavior changes

### Changed — `@wpconvert/mcp@0.3.1` (MCP)

- Depends exactly on `wpconvert@0.3.1`
- MCP `initialize` `serverInfo.version` now follows the package version (was stale `0.1.0-beta.0`)
- Playground tool description corrected to approximately ten minutes
- npm metadata: `homepage`, `repository`, `bugs`, `mcpName: ai.wpconvert/mcp`, expanded keywords
- MIT `LICENSE` file now ships in the npm tarball
- Status documentation clarifies `processing` as a tool-layer bucket, not a persisted REST `ConversionStatus` value
- Cross-platform test runner (`scripts/run-tests.cjs`) — no tool names, schemas, or conversion behavior changes

### Unchanged in 0.3.1

- CLI commands: `login`, `convert`, `status`, `download`, `preview`, `quota`
- MCP tools: `wpconvert_quota`, `wpconvert_convert_folder`, `wpconvert_check_status`, `wpconvert_download_result`, `wpconvert_create_preview`, `wpconvert_explain_failure`
- REST API, conversion engine, billing, and quota logic

## [0.3.0] - 2026-08-11

### Changed

- Synced `wpconvert@0.3.0` and `@wpconvert/mcp@0.3.0` with npm releases
- CLI: capability preflight, `quota --json`, idempotent submission, deterministic ZIP, exit code 3 on entitlement denial
- MCP: structured capabilities, `recommended_next`, status guidance, preflight before ZIP/key generation
- Updated developer docs for quota-first workflow

## [0.1.0] - 2026-07-03

### Added

- Initial open-source release of WPConvert developer tools
- `wpconvert` CLI — convert a local folder to a WordPress theme via the hosted API
- `@wpconvert/mcp` MCP server — convert from Cursor, Claude Desktop, or other MCP clients
- API examples (`examples/convert.sh`, `examples/convert.mjs`)
- Documentation (`docs/cli.md`, `docs/mcp.md`, `docs/api.md`)
- `SECURITY.md` and `CONTRIBUTING.md`

[0.3.2]: https://github.com/FTWAgency/wpconvert-devtools/releases/tag/v0.3.2
[0.3.1]: https://github.com/FTWAgency/wpconvert-devtools/releases/tag/v0.3.1
[0.3.0]: https://github.com/FTWAgency/wpconvert-devtools/releases/tag/v0.3.0
[0.1.0]: https://github.com/FTWAgency/wpconvert-devtools/releases/tag/v0.1.0
