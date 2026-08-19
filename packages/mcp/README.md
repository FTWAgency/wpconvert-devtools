# @wpconvert/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [WPConvert.ai](https://wpconvert.ai). It lets an AI agent (Cursor, Claude Desktop, etc.) convert the current workspace folder into a WordPress theme — no manual zipping required.

It's a thin wrapper over the same HTTP API and smart-zip logic as the `wpconvert` CLI.

> Requires Node.js >= 18 and a WPConvert API key. Full downloadable conversions require Pro/Agency or PAYG credits. Free verified accounts may also use preview-only keys (up to 3 lifetime Playground previews) when enabled on the server.

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_convert_folder` | Zip a folder (excluding `node_modules`, build output, secrets) and start a conversion. Returns a `jobId`. |
| `wpconvert_check_status` | Poll a job's status. Persisted values follow the OpenAPI `ConversionStatus` enum (`queued`, pipeline stages, `done`, `failed`). The tool-layer bucket `processing` means still in progress — not a persisted API value. |
| `wpconvert_download_result` | Download a completed conversion to disk. |
| `wpconvert_create_preview` | Get a WordPress Playground URL to view the theme in a live in-browser WordPress. The link expires after about ten minutes and is sensitive — open it in a browser. |
| `wpconvert_explain_failure` | Return the failure reason for a failed job. |
| `wpconvert_quota` | Show quota, capabilities, and `recommended_next`. Call before converting. |

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

**Quota-first (recommended):**

1. `wpconvert_quota` → review `capabilities` (conversion mode, `can_start`, download availability) and `recommended_next`
2. `wpconvert_convert_folder { "path": "./my-site", "type": "theme" }` → `jobId` + `idempotency_key` + `recommended_next`
3. `wpconvert_check_status { "jobId": "..." }` (repeat until `done`; follow `recommended_next` — usually poll every ~15s)
4. When `recommended_next.tool` is `wpconvert_download_result` → download the theme `.zip`
5. When preview-only or download locked → `wpconvert_create_preview` for a WordPress Playground URL (no ZIP)

If conversion is blocked (`can_start: false`), `wpconvert_convert_folder` returns a structured denial **before** zipping or submitting. Call `wpconvert_quota` to review `recommended_action`.

## Capabilities and structured responses

Tools return human-readable prose plus a trailing JSON block (same `ok()` / `fail()` pattern as before). Key fields:

| Field | Where | Meaning |
| --- | --- | --- |
| `quota` | `wpconvert_quota` | Full backend quota body (unknown future fields preserved) |
| `summary` | quota, denials | Projected `can_start`, `mode`, `consumes`, `download_available` |
| `capabilities_available` | quota | `false` on legacy backends without `capabilities.conversion` |
| `recommended_next` | all tools | `{ tool, reason, retry_after_seconds? }` — which MCP tool to call next |
| `next_action` | convert success | **String** (unchanged) — human guidance for agents |
| `idempotency_key` | convert | Omitted on preflight denial (no key generated) |

**Status `recommended_next` rules:**

- `queued`, pipeline stages, or tool-layer `processing` → `wpconvert_check_status` (poll)
- `done` + downloadable → `wpconvert_download_result`
- `done` + preview-only / download locked → `wpconvert_create_preview` (never download)
- `failed` → `wpconvert_explain_failure`

## Idempotency recovery

- Leave `idempotency_key` blank for a **new intentional** conversion.
- If a prior `wpconvert_convert_folder` call timed out or returned an ambiguous network error, retry with the **exact** `idempotency_key` from that call — do not omit it and do not invent a new one.
- Do **not** reuse a key for changed files, options, or a deliberate new conversion.
- Preflight runs **after** path/plan validation but **before** key generation (when omitted), ZIP build, and submit — so blocked accounts never upload.

## Preview-only / download locked

Free developer previews are preview-only (Playground, no ZIP download). When `download_available` is `false` or `preview_only` is `true`, status and download tools recommend `wpconvert_create_preview` or `wpconvert_quota` — not download retry.

## Dependency pin

This package pins `wpconvert@0.3.1` exactly for shared capability helpers (`resolveConvertPreflight`, quota formatters).
