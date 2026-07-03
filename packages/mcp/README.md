# @wpconvert/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [WPConvert.ai](https://wpconvert.ai). It lets an AI agent (Cursor, Claude Desktop, etc.) convert the current workspace folder into a WordPress theme — no manual zipping required.

It's a thin wrapper over the same HTTP API and smart-zip logic as the `wpconvert` CLI.

> Requires Node.js >= 18 and a WPConvert API key (Pro/Agency or PAYG credits).

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_convert_folder` | Zip a folder (excluding `node_modules`, build output, secrets) and start a conversion. Returns a `jobId`. |
| `wpconvert_check_status` | Poll a job's status (`queued` / `processing` / `done` / `failed`). |
| `wpconvert_download_result` | Download a completed conversion to disk. |
| `wpconvert_create_preview` | Get a WordPress Playground URL to view the theme in a live in-browser WordPress. The link expires (~30 min) and is sensitive — open it in a browser. |
| `wpconvert_explain_failure` | Return the failure reason for a failed job. |
| `wpconvert_quota` | Show remaining conversions / credits. |

## Configure (Cursor / Claude Desktop)

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

Optional: set `WPCONVERT_API_BASE` to point at a non-default API host (testing).

## Typical agent flow

1. `wpconvert_convert_folder { "path": "./my-site", "type": "theme" }` → `jobId`
2. `wpconvert_check_status { "jobId": "..." }` (repeat until `done`; conversions take a few minutes)
3. `wpconvert_download_result { "jobId": "..." }` → saved theme `.zip`
4. Optional: `wpconvert_create_preview { "jobId": "..." }` → a WordPress Playground URL to view the theme live

Billing, quotas, and refunds are identical to the dashboard and CLI. Secrets are excluded from the zip by default (set `includeEnv: true` only if you truly need them).
