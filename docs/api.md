# API Reference

The WPConvert API is hosted at `https://api.wpconvert.ai`. All endpoints require the `X-API-Key` header.

> URL conversion is not available via the API yet. Upload a zip of your site folder.

## Authentication

```
X-API-Key: wpc_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

Create keys in your WPConvert dashboard (**Settings → API & CLI**). Pro/Agency plans include developer access; PAYG uses available credits.

## Endpoints

### POST /api/convert

Start a conversion by uploading a zip file.

**Request:** `multipart/form-data`

| Field | Required | Description |
| --- | --- | --- |
| `file` | Yes | Zip file (filename must end in `.zip`) |
| `project_name` | No | Project display name |
| `export_type` | No | `theme` (default; only type supported today) |

**Response (2xx):**

```json
{
  "jobId": "abc123",
  "status": "queued"
}
```

**Large uploads (>50 MB):** use the direct-upload flow:

1. `POST /api/convert/upload-url` → `{ jobId, signedUrl, maxSizeMB, plan }`
2. `PUT` zip bytes to `signedUrl`
3. `POST /api/convert/from-storage` with `{ jobId, project_name, export_type }`

### GET /api/convert/:jobId/status

Poll conversion status.

**Response:**

```json
{
  "jobId": "abc123",
  "status": "processing",
  "progress": 42,
  "project_name": "my-site",
  "preview_available": false
}
```

Status values: `queued`, `processing`, `done`, `failed`.

### GET /api/download/:projectId

Get a download URL for a completed conversion.

**Response:**

```json
{
  "download_url": "https://...",
  "name": "my-site-theme.zip"
}
```

Follow `download_url` to fetch the theme zip. The URL is signed and time-limited — do not hard-code storage or bucket paths.

### GET /api/convert/quota

Check remaining conversions and credits.

**Response:**

```json
{
  "effectivePlan": "pro",
  "current": 3,
  "max": 50,
  "remaining": 47,
  "payg_credits": 0
}
```

### POST /api/playground/sessions

Create a WordPress Playground preview for a completed conversion.

**Request:** `application/json`

```json
{ "projectId": "abc123" }
```

**Response:**

```json
{
  "playground_url": "https://...",
  "expires_at": "2026-07-03T16:00:00.000Z",
  "session_id": "..."
}
```

## Error format

```json
{
  "error": {
    "code": "insufficient_credits",
    "message": "You are out of credits.",
    "buy_credits_url": "https://wpconvert.ai/billing"
  }
}
```

Common codes: `missing_credentials`, `invalid_api_key`, `insufficient_credits`, `quota_exceeded`, `rate_limited`, `too_many_active_jobs`, `conversion_not_ready`, `not_found`.

## Examples

See [examples/convert.sh](../examples/convert.sh) and [examples/convert.mjs](../examples/convert.mjs).
