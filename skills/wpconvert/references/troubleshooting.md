# WPConvert troubleshooting

## Blocked before submit

| Symptom | Cause | Fix |
| --- | --- | --- |
| `can_start: false` | Entitlement exhausted or account blocked | Follow `recommended_action`; do not retry submit |
| Preflight denial from `wpconvert_convert_folder` | Same as quota block | Call `wpconvert_quota`; no upload occurred |
| Auth error | No key or guest session, or an invalid `WPCONVERT_API_KEY` | Call `wpconvert_connect` (guest or login), or fix the MCP env; never log the key |
| Guest previews used or expired | `guest_previews_used` / `guest_token_expired` | `wpconvert_connect { "kind": "login" }` to keep converting; earlier guest previews can still be bought with `wpconvert_plans` for 7 days |
| Link expired | User didn't finish the connect link in 10 minutes | Call `wpconvert_connect` again |
| Env key overrides sign-in | `env_key_override: true` from `wpconvert_connect_status` | Remove `WPCONVERT_API_KEY` from the MCP config and restart the server |

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
