# WPConvert for coding agents

This page is the canonical guide for AI agents integrating with [WPConvert](https://wpconvert.ai): what the product does, how to choose a surface, and the rules that prevent wasted credits, broken uploads, or unsafe automation.

**Machine-readable contract:** [`openapi.yaml`](../openapi.yaml) (mirrored from production)  
**Live spec URL:** `https://wpconvert.ai/openapi.yaml`  
**Human surfaces:** [MCP](mcp.md) · [CLI](cli.md) · [REST API](api.md)

## What WPConvert does

WPConvert converts a **zipped frontend project** into an installable **WordPress theme** (`theme.zip`) or a **WordPress Playground preview URL**. Conversion runs on WPConvert.ai servers. The CLI, MCP server, and REST API are thin HTTPS clients.

WPConvert **does not**:

- Modify your source repository or frontend project
- Require WordPress admin credentials, database access, or hosting logins
- Run locally (no offline conversion engine in this repo)

**Output is one of:**

- `theme.zip` — full conversion with download available (paid entitlement)
- Playground preview URL — in-browser WordPress with the theme active (~10 minutes, use-limited; no ZIP for preview-only jobs)

## Choosing MCP, CLI, or REST

| Surface | Best for | Capability contract |
| --- | --- | --- |
| **MCP** (`@wpconvert/mcp`) | Cursor, Claude Desktop, other MCP hosts | Six tools with `recommended_next` JSON; prefer when the MCP server is already configured |
| **CLI** (`wpconvert`) | Shell, CI scripts, humans in a terminal | `wpconvert quota` preflight; exit code `3` when blocked |
| **REST** | Custom backends, language-agnostic integrations | Full OpenAPI contract; you implement polling and idempotency headers |

All three call `https://api.wpconvert.ai` with `X-API-Key`. Credits and quotas are shared with the dashboard.

**If MCP is configured, call MCP tools** — do not shell out to `wpconvert` from the same agent session. Shelling loses structured `recommended_next` and duplicates preflight logic.

## Authentication

1. Create an API key in the WPConvert dashboard (**Settings → API & CLI**).
2. Set `WPCONVERT_API_KEY` in the MCP server environment or shell — never commit it, never log it, never put it in URLs.
3. Example placeholder only: `wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY`

Optional: `WPCONVERT_API_BASE` for non-production testing.

## Folder and build selection

Point WPConvert at the **project root** and let detection run:

| Project type | What to do |
| --- | --- |
| Plain HTML (`index.html` at root) | Convert from project root — most AI exports (Lovable, v0, Framer, Webflow exports) |
| React/Vite/Next/Astro/etc. | `npm run build` first, then convert from project root |
| Unsure | `wpconvert convert . --dry-run` (CLI) or inspect detection output before submitting |

The CLI/MCP auto-detect build output folders: `dist/`, `build/`, `out/`, `public/`, and similar. Override with `--root <dir>` (CLI) or equivalent path argument (MCP).

**No WordPress credentials are required** for conversion.

By default, uploads **exclude** secrets (`.env`, `*.pem`, `*.key`, …), `node_modules`, `.git`, and build artifacts per `.gitignore`. Never enable `includeEnv` / `includeEnv: true` without explicit user approval.

## Capability gate (always first)

Before any conversion, inspect entitlements:

| Surface | Call |
| --- | --- |
| MCP | `wpconvert_quota` |
| CLI | `wpconvert quota` or `wpconvert quota --json` |
| REST | `GET /api/convert/quota` |

Read these fields from `capabilities` (see `DeveloperCapabilities` in OpenAPI):

```text
capabilities.conversion.can_start
capabilities.conversion.mode          # full | preview_only
capabilities.conversion.consumes
capabilities.conversion.reason
capabilities.outputs.download.available
capabilities.recommended_action
capabilities.reasons
```

`capabilities.conversion.mode` is authoritative for the **next** submission. It can disagree with the flat `api_conversion_mode` field.

### If `can_start === false`

**Stop.** Do not retry submit. Do not loop quota calls. Follow `capabilities.recommended_action` and surface the reason to the user.

### Finite-credit confirmation

Before submitting, report `capabilities.conversion.consumes` and branch:

| `consumes` | Agent requirement |
| --- | --- |
| `payg_credit` | Explicit paid consumption — require user confirmation unless the current instruction already authorized spending PAYG credits |
| `starter_credit` | Finite Starter credit will be consumed — disclose and confirm unless credits were already authorized. **Do not claim the credit was purchased** — the API cannot distinguish paid vs promotional Starter credits |
| `subscription_quota` | Renews on the billing cycle — may proceed after disclosure |
| `none` | No deduction (e.g. Agency allowance) — no confirmation gate |
| `free_preview` | Preview-only job — **do not promise** a `theme.zip` download |

### Follow machine guidance

- Use `recommended_next` (MCP) or equivalent status guidance — do not invent the next step
- Honor `retry_after_seconds` when polling — do not pick arbitrary intervals
- Never recommend download when `preview_only === true` or `download_available === false`

## Submit and poll

### MCP workflow

```text
wpconvert_quota
  → wpconvert_convert_folder
  → wpconvert_check_status (repeat until terminal)
  → wpconvert_download_result  OR  wpconvert_create_preview
  → wpconvert_explain_failure (on failed)
```

### CLI workflow

```bash
wpconvert quota
wpconvert convert . --type theme
wpconvert status <jobId>
wpconvert download <jobId>    # paid / downloadable only
wpconvert preview <jobId>     # preview-only or Playground
```

### REST workflow

See [api.md](api.md): quota → `POST /api/convert` → `GET /api/convert/{jobId}/status` → download or Playground session.

**Status vocabulary:** persisted values are in OpenAPI `ConversionStatus.status` (`queued`, pipeline stages, `done`, `failed`). The synthetic `processing` value can appear on idempotent replays. MCP/CLI may bucket in-flight jobs as `processing` — that is a tool-layer label, not a guaranteed persisted API value.

## Preview vs download

| Signal | Meaning |
| --- | --- |
| `capabilities.conversion.mode === preview_only` | Next job is preview-only |
| `capabilities.outputs.download.available === false` | No ZIP for this account/job path |
| `preview_only` on status | Playground only — use `wpconvert_create_preview` / `wpconvert preview`, not download |

Preview-only jobs are **never retroactively downloadable**. After upgrading, **re-run** the conversion.

Playground URLs are **capability URLs** (~10 minutes, use-limited). Do not paste them into shared CI logs or tickets.

## Idempotency (per surface)

### MCP and CLI

- Keys are generated automatically when omitted
- On ambiguous transport failure (timeout, connection reset), **retry with the exact `idempotency_key` returned** — do not omit it and do not mint a new one
- Do **not** reuse a key for changed files, options, or a deliberate new conversion
- Preflight denial does not generate a key (nothing was submitted)

### REST (`Idempotency-Key` header)

- Generate a **fresh unique key** (e.g. UUID) for each intentional new logical submission
- Reuse that **exact** key only when retrying the **same** request after an ambiguous transport outcome
- When the server records the prior attempt as **failed** (e.g. `insufficient_credits`), use a **new** key — see OpenAPI `previousFailed` example

## Failure taxonomy (common)

| Situation | Action |
| --- | --- |
| `can_start: false` on quota | Stop; do not submit |
| `idempotency_request_in_progress` | Wait and retry with same key |
| `idempotency_payload_mismatch` | New key required — payload changed |
| `idempotency_previous_failed` | New key required — prior attempt failed |
| Job `failed` | `wpconvert_explain_failure` / read error; fix cause; new conversion with new key |
| Download locked / preview-only | Playground or upgrade — never retry download |

## Security requirements

- Never expose or commit `WPCONVERT_API_KEY`
- Never upload `.env` or secrets without explicit user approval
- Do not modify the source frontend merely to make WPConvert work
- Only process projects the user owns or has rights to convert

## Further reading

- [MCP tool reference](mcp.md) — runtime tool descriptions and structured responses
- [CLI reference](cli.md) — flags, exit codes, dry-run
- [API reference](api.md) — REST workflows and signed-upload path
- [Agent Skill](../skills/wpconvert/SKILL.md) — portable decision policy for Skill-compatible hosts
- [MCP config examples](../examples/mcp/) — Cursor and Claude Desktop snippets
