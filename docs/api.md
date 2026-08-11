# WPConvert Developer API

The WPConvert Developer API converts a zipped frontend project into an installable WordPress theme. It is the same HTTPS surface used by the open-source [CLI](cli.md) and [MCP server](mcp.md).

**Base URL:** `https://api.wpconvert.ai`

> **Contract source:** [`openapi.yaml`](../openapi.yaml) in this repository is a **byte-identical mirror** of the canonical WPConvert API contract maintained in the private application repository. Do not independently modify API behavior or schemas here. Contract changes originate with the production API and are mirrored into this repository.

## Authentication

Primary developer authentication uses an API key in the header:

```http
X-API-Key: wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY
```

- Keys use the `wpc_live_…` family and are created in the WPConvert dashboard under **Settings → API & CLI**.
- Send the key in the `X-API-Key` header only. Never put keys in URLs, query strings, signed storage upload URLs, or source repositories.
- A separate **Bearer JWT** exists for dashboard session consumers. Programmatic integrations should use API keys, not session tokens.

Optional attribution headers (informational only; they do not change entitlement):

```http
X-WPConvert-Client: api/1.0
X-WPConvert-Tool: my_integration
```

## Recommended workflow

```text
1. GET  /api/convert/quota          — preflight capabilities
2. POST /api/convert                — submit ZIP (or use signed-upload flow for large archives)
3. GET  /api/convert/{jobId}/status — poll until done or failed
4. GET  /api/download/{projectId}   — get a signed theme URL (full conversions)
   OR
   POST /api/playground/sessions     — create an in-browser preview
```

## Capabilities / quota

```http
GET /api/convert/quota
```

Call this before submitting a conversion. The response includes legacy usage counters **and** an additive `capabilities` object that describes what the **next** submission would do.

Agents and integrations should inspect:

```text
capabilities.conversion.can_start
capabilities.conversion.mode
capabilities.conversion.consumes
capabilities.conversion.reason
capabilities.outputs.download.available
capabilities.recommended_action
capabilities.reasons
```

`recommended_action` and `reasons` are **top-level** fields inside `capabilities`. There is no `capabilities.guidance` wrapper.

### Effective mode vs legacy plan field

The flat `api_conversion_mode` field reflects plan-level entitlement only. The authoritative field for the next developer submission is:

```text
capabilities.conversion.mode
```

It accounts for authentication type and feature flags, so it can disagree with `api_conversion_mode`. Prefer the nested effective mode.

**Example (abbreviated):**

```json
{
  "effectivePlan": "starter",
  "api_conversion_mode": "preview_only",
  "capabilities": {
    "conversion": {
      "can_start": true,
      "mode": "preview_only",
      "consumes": "free_preview",
      "reason": "free_preview_available"
    },
    "outputs": {
      "download": { "available": false, "reason": "download_requires_upgrade" }
    },
    "recommended_action": "convert_preview",
    "reasons": ["free_preview_available", "download_requires_upgrade"]
  }
}
```

## Submit a ZIP

```http
POST /api/convert
Content-Type: multipart/form-data
```

| Field | Required | Description |
| --- | --- | --- |
| `file` | Yes | ZIP archive (filename should end in `.zip`) |
| `project_name` | No | Display name (default: `Untitled Project`) |
| `export_type` | No | `theme` (default; only type supported for API keys) |
| `platform` | No | Source-tool label for reporting |

API-key conversions currently support **`theme` only**. Elementor and Gutenberg are dashboard features and return `unsupported_export_type` when requested with an API key.

**Example:**

```bash
curl -X POST https://api.wpconvert.ai/api/convert \
  -H "X-API-Key: wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY" \
  -F "file=@my-site.zip" \
  -F "project_name=my-site" \
  -F "export_type=theme"
```

**Response (abbreviated):**

```json
{
  "jobId": "11111111-1111-4111-8111-111111111111",
  "status": "queued",
  "progress": 0,
  "conversion_mode": "full",
  "preview_only": false
}
```

Archive size limits are per-plan (currently 50 MB on Starter, 100 MB on paid modes). Larger inputs should use the [signed-upload flow](#large-uploads) below.

## Idempotency

Optional on submission endpoints for **API-key** requests:

```http
Idempotency-Key: wpconvert-client-11111111-2222-4333-8444-555555555555
```

Applies to:

- `POST /api/convert`
- `POST /api/convert/from-storage`

The open-source CLI and MCP server generate keys automatically (`wpconvert-cli-…` / `wpconvert-mcp-…`). Raw REST clients may supply their own.

**Rules:**

- 1–128 printable ASCII characters after trimming.
- Reuse the **same** key when retrying the **same** logical submission after an ambiguous transport failure.
- Use a **new** key for an intentionally different archive or request fields.

**Relevant error codes:**

| Code | Meaning |
| --- | --- |
| `invalid_idempotency_key` | Key failed format validation |
| `idempotency_request_in_progress` | Original attempt still resolving; retry shortly with the same key |
| `idempotency_previous_failed` | Original attempt failed; use a new key to retry |
| `idempotency_payload_mismatch` | Same key, different request; use a new key |

On replay, the server may return `Idempotent-Replay: true` and set `idempotent_replay: true` in the JSON body.

## Large uploads

For archives above the multipart ceiling, use the three-step signed-upload flow:

```text
1. POST /api/convert/upload-url
2. PUT  <signedUrl>            ← external storage URL, NOT api.wpconvert.ai
3. POST /api/convert/from-storage
```

**Step 1** returns `jobId`, `signedUrl`, `maxSizeMB`, and `plan`.

**Step 2** uploads the ZIP bytes to `signedUrl` with:

```http
Content-Type: application/zip
x-upsert: true
```

Do **not** send your WPConvert API key to the signed URL.

**Step 3** queues the conversion:

```json
{
  "jobId": "11111111-1111-4111-8111-111111111111",
  "project_name": "my-site",
  "export_type": "theme"
}
```

The same idempotency semantics apply to `POST /api/convert/from-storage`.

## Status

```http
GET /api/convert/{jobId}/status
```

**Persisted statuses** (pipeline stages until terminal):

```text
queued
analyzing
building
rendering
labeling
generating
validating
uploading
done
failed
```

Treat any non-terminal status as "still working." Only `done` and `failed` are terminal.

> **`processing` is not a persisted status.** It may appear in an idempotent **replay** response (`202`) as a synthetic replay-only value. Poll this endpoint for the real persisted state.

**Useful fields:**

```text
conversion_mode
preview_only
preview_available
download_available
download_url
error
progress
```

`download_url` may be populated when entitled, but `GET /api/download/{projectId}` is the supported way to mint a fresh signed link.

## Download

```http
GET /api/download/{projectId}
```

Returns **JSON** containing a short-lived signed `download_url`. It does **not** stream the ZIP directly — fetch `download_url` in a separate request.

`projectId` is the same value returned as `jobId` at submission.

**Preview-only conversions are never downloadable.** Upgrading later does **not** retroactively unlock a preview-only artifact. Run a new paid conversion to obtain a downloadable theme.

**Example response:**

```json
{
  "project_id": "11111111-1111-4111-8111-111111111111",
  "name": "my-site-theme.zip",
  "download_url": "https://storage.example.com/signed/my-site-theme.zip?token=EXAMPLE",
  "status": "done"
}
```

## Playground preview

```http
POST /api/playground/sessions
Content-Type: application/json
```

**Request:**

```json
{
  "projectId": "11111111-1111-4111-8111-111111111111"
}
```

**Response (abbreviated):**

```json
{
  "session_id": "44444444-4444-4444-8444-444444444444",
  "playground_url": "https://playground.wordpress.net/...",
  "expires_at": "2026-08-10T20:15:00.000Z"
}
```

Three related signals — do not conflate them:

| Signal | Scope |
| --- | --- |
| `capabilities.outputs.playground.supported` | Account-level product support |
| `capabilities.outputs.playground.available_after_conversion` | Expectation after a successful conversion |
| `preview_available` on status | Per-job hint that a session can probably be created |
| `POST /api/playground/sessions` | **Authority** — only a `200` here means a preview actually exists |

Account-level capability does not guarantee a preview for every job. Sessions are short-lived; call this endpoint again to reopen a preview later.

## Errors

The production API has **multiple historical error envelope shapes**. Clients should branch on HTTP status first, then on stable `error.code` when the nested object is present.

### Canonical API-key envelope

```json
{
  "error": {
    "code": "invalid_api_key",
    "message": "Invalid or revoked API key."
  }
}
```

### Legacy flat shape

```json
{
  "error": "rate_limited",
  "message": "Too many upload requests. Please wait a moment and try again.",
  "retryAfterSeconds": 42
}
```

On legacy flat bodies, `error` is a **string**, not an object — that is the quickest way to tell the shapes apart.

### Legacy `{ code, message }` (no `error` wrapper)

Used for some dashboard-oriented failures such as email verification.

Prefer stable `error.code` values where available. Do not assume every endpoint uses the same envelope.

**Common API-key codes:** `missing_credentials`, `invalid_api_key`, `insufficient_credits`, `upgrade_required`, `quota_exceeded`, `rate_limited`, `too_many_active_jobs`, `invalid_idempotency_key`, `idempotency_request_in_progress`, `idempotency_previous_failed`, `idempotency_payload_mismatch`, `conversion_not_ready`, `not_found`, `server_error`.

## Rate limits

Operational limits are environment-configurable. The values below are **current defaults**, not permanent SLA guarantees:

| Limit | Current default |
| --- | --- |
| Conversion submissions (standard API key) | 3/min, 20/hour |
| Conversion submissions (preview-only entitlement) | 2/min, 5/hour |
| Status polling | 30/min |
| Concurrent in-flight conversions | Agency 3, Pro 2, PAYG 1, preview-only 1 |
| Signed upload URL creation | 20 per 10 minutes |
| Playground sessions | 10/hour |

Exceeding a throttle returns `rate_limited`; exceeding the concurrency cap returns `too_many_active_jobs`.

## OpenAPI

**Machine-readable OpenAPI 3.1 specification:** [`openapi.yaml`](../openapi.yaml)

The OpenAPI file is the authoritative public machine-readable contract. This guide explains workflows and high-value fields; schemas, every response variant, and all examples live in the spec.

When the production API contract changes, the private canonical `openapi.yaml` is updated first and then mirrored here byte-for-identically.

## CLI and MCP

These tools are thin HTTPS clients over the same API. See their dedicated guides rather than duplicating them here:

- [CLI reference](cli.md) — `wpconvert quota`, `wpconvert quota --json`, `wpconvert convert ./site`
- [MCP reference](mcp.md) — `wpconvert_quota` → `wpconvert_convert_folder` → `wpconvert_check_status` → `wpconvert_download_result` or `wpconvert_create_preview`

**Examples:** [examples/convert.sh](../examples/convert.sh) and [examples/convert.mjs](../examples/convert.mjs).
