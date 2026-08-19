# MCP Server Reference

The `@wpconvert/mcp` package is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents convert workspace folders into WordPress themes.

Current release: **@wpconvert/mcp@0.3.0** (pins `wpconvert@0.3.0`).

## Install / run

```bash
npx -y @wpconvert/mcp
# deterministic pin:
npx -y @wpconvert/mcp@0.3.0
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

## Recommended agent workflow

```text
wpconvert_quota
        ↓
wpconvert_convert_folder
        ↓
wpconvert_check_status
        ↓
wpconvert_download_result  OR  wpconvert_create_preview
        ↓
wpconvert_explain_failure (when failed)
```

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_quota` | Quota, capabilities, `recommended_next`. Call before converting. |
| `wpconvert_convert_folder` | Zip a folder and start conversion. Returns `jobId` + `idempotency_key`. |
| `wpconvert_check_status` | Poll job status. Persisted values follow OpenAPI `ConversionStatus`; tool-layer `processing` means still in progress. |
| `wpconvert_download_result` | Download when status shows downloadable. |
| `wpconvert_create_preview` | Playground URL (~10 minutes, sensitive). |
| `wpconvert_explain_failure` | Failure reason and recovery guidance. |

## Structured responses

Tools return human-readable prose plus a trailing JSON block. Key fields:

| Field | Meaning |
| --- | --- |
| `quota` / `summary` | Full backend quota + projected capability summary |
| `recommended_next` | `{ tool, reason, retry_after_seconds? }` — next MCP tool to call |
| `next_action` | String guidance on convert success (unchanged) |
| `idempotency_key` | Omitted on preflight denial; required for ambiguous retry recovery |

**Status `recommended_next` rules:**

- `queued`, pipeline stages, or tool-layer `processing` → poll `wpconvert_check_status`
- Done + downloadable → `wpconvert_download_result`
- Done + preview-only / download locked → `wpconvert_create_preview` (never download)
- Failed → `wpconvert_explain_failure`

## Conversion preflight

`wpconvert_convert_folder` calls read-only quota preflight **after** path validation but **before** ZIP build and idempotency-key generation. Explicit `can_start: false` returns structured denial without uploading.

## Idempotency

- Leave `idempotency_key` blank for a new intentional conversion.
- On ambiguous network errors, retry with the **exact** key from the prior response.
- Do not reuse a key for changed files or a deliberate new conversion.

## Safety

- Secrets excluded from zip by default (`includeEnv: true` only if truly needed)
- Same credit system as dashboard and CLI
- Preview URLs are capability URLs (~10 minutes) — treat as sensitive

See [docs/agents.md](agents.md) for the full agent integration guide and [SECURITY.md](../SECURITY.md) for more.
