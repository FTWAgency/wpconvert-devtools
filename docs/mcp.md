# MCP Server Reference

The `@wpconvert/mcp` package is a [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents convert workspace folders into WordPress themes.

Current release: **@wpconvert/mcp@0.4.0** (pins `wpconvert@0.4.0`).

## Install / run

```bash
npx -y @wpconvert/mcp
# deterministic pin:
npx -y @wpconvert/mcp@0.4.0
```

No API key is required. Without one, the agent calls `wpconvert_connect` and shows the user a link: `guest` for a few free previews after one browser check, or `login` to sign in (a new key is saved to `~/.wpconvert/config.json`, mode 0600, shared with the CLI). `WPCONVERT_API_KEY`, when set, takes priority over a saved key.

## Configure (Claude Code)

```bash
claude mcp add wpconvert --scope user -- npx -y @wpconvert/mcp
```

- `--scope user` makes the server available in every project. Without it, Claude Code's default `local` scope applies only to the folder you ran the command in.
- To use an existing key: `claude mcp add wpconvert --scope user -e WPCONVERT_API_KEY=wpc_live_xxx -- npx -y @wpconvert/mcp`. Put the server name before `-e`; `-e` accepts several values, so `claude mcp add -e KEY=value wpconvert …` reads `wpconvert` as another variable and fails.
- Confirm with `claude mcp list` (`wpconvert … ✔ Connected`) or `/mcp` inside a session. Remove with `claude mcp remove wpconvert -s user`.

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

Optional `env`: `WPCONVERT_API_KEY` (an existing key) and `WPCONVERT_API_BASE` (non-default API host, testing).

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

No key yet:

```text
wpconvert_connect { kind: "guest" }  →  user opens the link  →  wpconvert_connect_status
```

Buying (download a guest or preview-only theme, or start a plan):

```text
wpconvert_plans { jobId }  →  show every option, the user picks  →  wpconvert_checkout  →  user pays  →  wpconvert_check_status
```

`wpconvert_checkout` needs a signed-in account (`wpconvert_connect { kind: "login" }`). Agents must not choose an option for the user, open links, or pay. There is no free trial through the MCP.

## Tools

| Tool | Purpose |
| --- | --- |
| `wpconvert_quota` | Quota, capabilities, `recommended_next`. Call before converting. |
| `wpconvert_convert_folder` | Zip a folder and start conversion. Returns `jobId` + `idempotency_key`. |
| `wpconvert_check_status` | Poll job status. Persisted values follow OpenAPI `ConversionStatus`; tool-layer `processing` means still in progress. |
| `wpconvert_download_result` | Download when status shows downloadable. |
| `wpconvert_create_preview` | Playground URL (~10 minutes, sensitive). |
| `wpconvert_explain_failure` | Failure reason and recovery guidance. |
| `wpconvert_connect` | Start a browser link: `guest` (free previews, no account) or `login` (sign in, saves a key). Returns a link and code for the user. |
| `wpconvert_connect_status` | Waits ~20s for the user to finish the link; reports guest previews left or the masked account email. |
| `wpconvert_plans` | Starter, Pro, Agency (monthly/yearly) and PAYG packs with features and today's price. With `jobId`, each choice carries exact `checkout_arguments`. |
| `wpconvert_checkout` | Stripe Checkout (or billing portal for subscribers) for the user's choice. |

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
- Done + preview-only / download locked → `wpconvert_create_preview` (never download); `wpconvert_plans` to unlock
- Done + guest (`guest: true`) → `wpconvert_create_preview`, then `wpconvert_plans`
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
- Tool results never include the API key, guest token, or the link's device code
- Guest uploads are never retried automatically (each upload uses a preview)

See [docs/agents.md](agents.md) for the full agent integration guide and [SECURITY.md](../SECURITY.md) for more.
