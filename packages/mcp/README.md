# @wpconvert/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [WPConvert.ai](https://wpconvert.ai). It lets an AI agent (Cursor, Claude Code, Claude Desktop, etc.) convert the current workspace folder into a WordPress theme — no manual zipping required.

It's a thin wrapper over the same HTTP API and smart-zip logic as the `wpconvert` CLI.

> Requires Node.js >= 18. No API key is needed to start: the agent can give you a link for a few free guest previews (one quick human check in the browser, no account), or for signing in. Downloads need Starter, Pro, Agency or pay-as-you-go credits, which you can buy from the same conversation.

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_convert_folder` | Zip a folder (excluding `node_modules`, build output, secrets) and start a conversion. Returns a `jobId`. |
| `wpconvert_check_status` | Poll a job's status. Persisted values follow the OpenAPI `ConversionStatus` enum (`queued`, pipeline stages, `done`, `failed`). The tool-layer bucket `processing` means still in progress — not a persisted API value. |
| `wpconvert_download_result` | Download a completed conversion to disk. |
| `wpconvert_create_preview` | Get a WordPress Playground URL to view the theme in a live in-browser WordPress. The link expires after about ten minutes and is sensitive — open it in a browser. |
| `wpconvert_explain_failure` | Return the failure reason for a failed job. |
| `wpconvert_quota` | Show quota, capabilities, and `recommended_next`. Call before converting. For a guest session, shows free previews left. |
| `wpconvert_connect` | Start a browser link: `kind: "guest"` (free previews, no account) or `kind: "login"` (sign in; saves a new API key locally). Returns a link and code for you to open — the agent never opens it. |
| `wpconvert_connect_status` | Check whether you finished the link (waits ~20s), and how WPConvert is connected now. |
| `wpconvert_plans` | Every option with what it includes and today's price: Starter (one theme), Pro, Agency (monthly/yearly), pay-as-you-go packs. Pass `jobId` for options to unlock that conversion. |
| `wpconvert_checkout` | A Stripe checkout link for the option you picked. Needs a signed-in account. You open and pay; the agent never pays. |

## Configure (Claude Code)

```bash
claude mcp add wpconvert --scope user -- npx -y @wpconvert/mcp
```

`--scope user` makes the server available in every project. Confirm with `claude mcp list` (`wpconvert … ✔ Connected`) or `/mcp` inside a session. Then ask the agent to convert a folder; it will offer a guest link or a sign-in link.

To use an existing API key instead, add it before the `--`, after the server name: `claude mcp add wpconvert --scope user -e WPCONVERT_API_KEY=wpc_live_xxx -- npx -y @wpconvert/mcp` (`-e` accepts several values, so put the name first).

## Configure (Cursor / Claude Desktop)

```json
{
  "mcpServers": {
    "wpconvert": {
      "command": "npx",
      "args": ["-y", "@wpconvert/mcp"]
    }
  }
}
```

Optional `env`: `WPCONVERT_API_KEY` (an existing key; it takes precedence over a key saved by sign-in) and `WPCONVERT_API_BASE` (a non-default API host, for testing).

Sign-in and guest sessions are saved in `~/.wpconvert/config.json` (mode 0600), shared with the `wpconvert` CLI. Tool results never include the key, the guest token or the link's device code.

## Typical agent flow

**Quota-first (recommended):**

1. `wpconvert_quota` → review `capabilities` (conversion mode, `can_start`, download availability) and `recommended_next`
2. `wpconvert_convert_folder { "path": "./my-site", "type": "theme" }` → `jobId` + `idempotency_key` + `recommended_next`
3. `wpconvert_check_status { "jobId": "..." }` (repeat until `done`; follow `recommended_next` — usually poll every ~15s)
4. When `recommended_next.tool` is `wpconvert_download_result` → download the theme `.zip`
5. When preview-only or download locked → `wpconvert_create_preview` for a WordPress Playground URL (no ZIP)

If conversion is blocked (`can_start: false`), `wpconvert_convert_folder` returns a structured denial **before** zipping or submitting. Call `wpconvert_quota` to review `recommended_action`.

**No key yet (guest):**

1. `wpconvert_convert_folder` → `recommended_next: wpconvert_connect { "kind": "guest" }`
2. `wpconvert_connect { "kind": "guest" }` → the agent shows you a link and code; you open it and confirm you're human
3. `wpconvert_connect_status` → `connected`, with free previews left
4. `wpconvert_convert_folder`, `wpconvert_check_status`, then `wpconvert_create_preview` to see it in WordPress Playground (guest uploads up to 50MB zipped; never retried automatically, since each upload uses a preview)

**Buying (download a theme, or a plan):**

1. `wpconvert_plans { "jobId": "..." }` → every option and price; the agent asks you which one
2. Not signed in? `wpconvert_connect { "kind": "login" }`, then `wpconvert_connect_status`, then `wpconvert_plans` again
3. `wpconvert_checkout` with your choice's `checkout_arguments` → a Stripe link you open and pay
4. `wpconvert_check_status` → once paid, `recommended_next` is `wpconvert_download_result`. Guest themes you buy move to your account.

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
- `done` + preview-only / download locked → `wpconvert_create_preview` (never download); the reason names `wpconvert_plans` for unlocking
- `done` + guest (`guest: true`, `remaining_previews`) → `wpconvert_create_preview`, then `wpconvert_plans` to buy
- `failed` → `wpconvert_explain_failure`

## Idempotency recovery

- Leave `idempotency_key` blank for a **new intentional** conversion.
- If a prior `wpconvert_convert_folder` call timed out or returned an ambiguous network error, retry with the **exact** `idempotency_key` from that call — do not omit it and do not invent a new one.
- Do **not** reuse a key for changed files, options, or a deliberate new conversion.
- Preflight runs **after** path/plan validation but **before** key generation (when omitted), ZIP build, and submit — so blocked accounts never upload.

## Preview-only / download locked

Free developer previews and guest previews are preview-only (Playground, no ZIP download). When `download_available` is `false` or `preview_only` is `true`, status and download tools recommend `wpconvert_create_preview`, `wpconvert_plans` or `wpconvert_quota` — not download retry.

## Dependency pin

This package pins `wpconvert@0.4.0` exactly for shared capability helpers (`resolveConvertPreflight`, quota formatters).
