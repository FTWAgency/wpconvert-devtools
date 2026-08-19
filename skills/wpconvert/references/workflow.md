# WPConvert agent workflow

## Prerequisites

- `@wpconvert/mcp` configured with `WPCONVERT_API_KEY`
- User's frontend project path (run from project root when possible)
- Framework sites built (`npm run build`) when detection requires it

## Steps

### 1. Quota / capabilities

Call `wpconvert_quota`. Inspect:

- `capabilities.conversion.can_start`
- `capabilities.conversion.mode` (`full` vs `preview_only`)
- `capabilities.conversion.consumes`
- `capabilities.outputs.download.available`
- `recommended_next`

If `can_start === false`, stop and explain `capabilities.recommended_action` / reasons.

### 2. Credit confirmation

| `consumes` | Action |
| --- | --- |
| `payg_credit` | Confirm paid credit unless user already authorized spending |
| `starter_credit` | Disclose finite Starter credit; do not claim it was purchased |
| `subscription_quota` | Disclose; usually proceed |
| `free_preview` | Disclose preview-only — no ZIP |
| `none` | Proceed |

### 3. Convert

`wpconvert_convert_folder` with `{ "path": "./", "type": "theme" }` (adjust path).

- Leave `idempotency_key` blank for a new conversion
- On ambiguous network error after submit may have succeeded, retry with the **exact** returned key

### 4. Poll

`wpconvert_check_status` until `done` or `failed`. Follow `recommended_next` and `retry_after_seconds`.

### 5. Result

| Outcome | Tool |
| --- | --- |
| Done + downloadable | `wpconvert_download_result` |
| Done + preview-only / download locked | `wpconvert_create_preview` |
| Failed | `wpconvert_explain_failure` |

### 6. Playground URLs

Open in the user's browser. Treat URLs as sensitive (~10 minutes, use-limited). Do not log in CI output.

## Build / folder hints

- Plain HTML at repo root → convert `.`
- Vite/React/Next → build first, then convert `.` (detection finds `dist/`, `build/`, `out/`, `public/`)
- Uncertain → ask user or use CLI `wpconvert convert . --dry-run` in a shell only when MCP is unavailable
