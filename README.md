# WPConvert Devtools

[![npm version](https://img.shields.io/npm/v/wpconvert.svg)](https://www.npmjs.com/package/wpconvert)
[![MCP package](https://img.shields.io/npm/v/@wpconvert/mcp.svg)](https://www.npmjs.com/package/@wpconvert/mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Open-source developer tools for turning AI-built websites into WordPress themes from your terminal, API, or AI assistant.**

> The CLI and MCP server are open source. The WPConvert conversion engine runs on [WPConvert.ai](https://wpconvert.ai) and requires an API key.

This repository contains the open-source [WPConvert](https://wpconvert.ai) developer tools:

| Package | Description |
| --- | --- |
| [`wpconvert`](packages/cli) | CLI — convert a local folder to a WordPress theme |
| [`@wpconvert/mcp`](packages/mcp) | MCP server — convert from Cursor, Claude Desktop, or other MCP clients |
| [`examples/`](examples) | API usage examples (curl + Node.js) |
| [`docs/`](docs) | CLI, MCP, and API reference |

These tools are thin clients that call the hosted API over HTTPS.

## What this repo is NOT

This repository does **not** include the WPConvert conversion engine, backend workers, AI prompts, parser/mapper logic, billing/quota logic, or theme generation system. Those run on WPConvert.ai servers.

## Requirements

- **Node.js >= 18**
- A **WPConvert API key** (`wpc_live_...`) from your dashboard (**Settings → API & CLI**)
- **Pro/Agency** plans include developer access; **PAYG** works with available credits
- CLI, API, and MCP use the **same credits** as dashboard conversions (1 credit per successful conversion; failed conversions are refunded)

## Quickstart (CLI)

```bash
npm install -g wpconvert
wpconvert login
wpconvert convert . --type theme
```

The CLI smart-zips your folder, uploads it, polls until done, and downloads the theme `.zip`.

### Preview before uploading

```bash
wpconvert convert . --dry-run
```

`--dry-run` lists exactly what would be uploaded — no upload, no credit used.

### Safety defaults

By default the CLI excludes:

- `.env` and secret files (`*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.ssh/`, `credentials*.json`, …)
- `node_modules`, `.git`, build output (`dist/`, `build/`, …)
- Your project's `.gitignore` patterns

Symlinks are never followed. Use `--include-env` only if you truly intend to upload secrets (not recommended).

> **Only upload projects you own or have permission to process through WPConvert.**

## MCP setup (Cursor / Claude Desktop)

Add to your MCP config:

```json
{
  "mcpServers": {
    "wpconvert": {
      "command": "npx",
      "args": ["-y", "@wpconvert/mcp"],
      "env": {
        "WPCONVERT_API_KEY": "wpc_live_xxx"
      }
    }
  }
}
```

Optional: set `WPCONVERT_API_BASE` to point at a non-default API host (testing only).

See [docs/mcp.md](docs/mcp.md) for tool reference and typical agent flow.

## API overview

All requests require the `X-API-Key` header. Base URL: `https://api.wpconvert.ai`

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/convert` | Upload a zip and start conversion (multipart) |
| `GET` | `/api/convert/:jobId/status` | Poll conversion status |
| `GET` | `/api/download/:projectId` | Get download URL for a completed conversion |

### Start a conversion

```bash
curl -X POST https://api.wpconvert.ai/api/convert \
  -H "X-API-Key: wpc_live_xxx" \
  -F "file=@my-site.zip" \
  -F "project_name=my-site" \
  -F "export_type=theme"
```

Returns `{ "jobId": "...", "status": "queued", ... }`.

### Check status

```bash
curl https://api.wpconvert.ai/api/convert/JOB_ID/status \
  -H "X-API-Key: wpc_live_xxx"
```

### Download result

```bash
curl https://api.wpconvert.ai/api/download/PROJECT_ID \
  -H "X-API-Key: wpc_live_xxx"
```

Returns `{ "download_url": "https://...", "name": "my-site-theme.zip" }`. Follow the `download_url` to fetch the theme zip — do not hard-code storage paths.

See [docs/api.md](docs/api.md) and [examples/](examples/) for full examples.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WPCONVERT_API_KEY` | API key (overrides stored config) |
| `WPCONVERT_API_BASE` | Override API base URL (advanced/testing) |

See [.env.example](.env.example) for a safe template with fake values.

## Development

```bash
git clone https://github.com/FTWAgency/wpconvert-devtools.git
cd wpconvert-devtools
npm install
npm run check
```

## License

MIT — Copyright (c) 2026 FTW Agency, operating WPConvert.ai. See [LICENSE](LICENSE).

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities and upload safety guidance.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
