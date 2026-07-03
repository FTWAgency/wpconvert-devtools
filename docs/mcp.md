# MCP Server Reference

The `@wpconvert/mcp` package is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents convert workspace folders into WordPress themes.

## Install / run

```bash
npx -y @wpconvert/mcp
```

Requires `WPCONVERT_API_KEY` in the environment.

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

Optional: `WPCONVERT_API_BASE` for non-default API host (testing).

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_convert_folder` | Zip a folder and start conversion. Returns `jobId`. |
| `wpconvert_check_status` | Poll job status (`queued` / `processing` / `done` / `failed`). |
| `wpconvert_download_result` | Download completed conversion to disk. |
| `wpconvert_create_preview` | Get a WordPress Playground preview URL. |
| `wpconvert_explain_failure` | Return failure reason for a failed job. |
| `wpconvert_quota` | Show remaining conversions / credits. |

## Typical agent flow

1. `wpconvert_convert_folder` with `{ "path": "./my-site", "type": "theme" }` → `jobId`
2. `wpconvert_check_status` with `{ "jobId": "..." }` — repeat until `done`
3. `wpconvert_download_result` with `{ "jobId": "..." }` → saved theme `.zip`
4. Optional: `wpconvert_create_preview` with `{ "jobId": "..." }` → Playground URL

Conversions can take several minutes. Poll status rather than blocking.

## Safety

- Secrets excluded from zip by default (`includeEnv: true` only if truly needed)
- Same credit system as dashboard and CLI
- Preview URLs are capability URLs — treat as sensitive

See [SECURITY.md](../SECURITY.md) for more.
