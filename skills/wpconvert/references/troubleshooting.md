# WPConvert troubleshooting

## Blocked before submit

| Symptom | Cause | Fix |
| --- | --- | --- |
| `can_start: false` | Entitlement exhausted or account blocked | Follow `recommended_action`; do not retry submit |
| Preflight denial from `wpconvert_convert_folder` | Same as quota block | Call `wpconvert_quota`; no upload occurred |
| Auth error | Missing/invalid `WPCONVERT_API_KEY` | Configure MCP env; never log the key |

## Idempotency

| Error | Action |
| --- | --- |
| `idempotency_request_in_progress` | Wait; retry with **same** key |
| `idempotency_payload_mismatch` | New key — files or options changed |
| `idempotency_previous_failed` | New key — prior attempt failed (e.g. credits) |
| Ambiguous timeout after submit | Retry with **same** key from prior response |

## Status / output

| Symptom | Action |
| --- | --- |
| Stuck in queued / pipeline stages | Keep polling `wpconvert_check_status`; honor `retry_after_seconds` |
| `failed` status | `wpconvert_explain_failure`; fix root cause; new conversion with new key |
| Download rejected / locked | Use `wpconvert_create_preview` or upgrade; do not retry download |
| User expected ZIP but got preview | `mode` was `preview_only` — explain; re-convert after upgrade |

## Upload / packaging

| Symptom | Action |
| --- | --- |
| Framework not built | Run `npm run build`; convert again |
| Missing assets | Check `--max-asset-size`; large files may be dropped |
| Secrets concern | Default zip excludes `.env`; never use `includeEnv` without user OK |

## Playground

- Sessions expire after **about ten minutes**
- URLs grant temporary theme access — treat as sensitive
- `theme_expired` → re-run conversion for a fresh preview
