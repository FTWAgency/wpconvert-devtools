# WPConvert agent instructions (copy into your frontend repo)

> Copy this file into **your project** as agent guidance. Do not name it `AGENTS.md` at the repo root unless you intend it to apply to all contributor sessions.
>
> Full guide: [WPConvert docs/agents.md](https://github.com/FTWAgency/wpconvert-devtools/blob/main/docs/agents.md)

## Scope

Convert this frontend project to a WordPress theme with WPConvert. WPConvert does **not** modify this repository and does **not** require WordPress credentials.

## Before converting

1. Configure `@wpconvert/mcp` with `WPCONVERT_API_KEY` ([MCP examples](https://github.com/FTWAgency/wpconvert-devtools/tree/main/examples/mcp))
2. Call `wpconvert_quota` — if `can_start === false`, stop
3. Confirm before consuming `payg_credit` or `starter_credit`
4. Build framework projects first (`npm run build`) when needed

## Convert

1. `wpconvert_convert_folder` from the project root (`path: "./"`)
2. Poll `wpconvert_check_status` until done; follow `recommended_next`
3. Download ZIP only when downloadable; otherwise `wpconvert_create_preview`

## Rules

- Reuse `idempotency_key` only when retrying the same ambiguous submit
- Never download when preview-only or `download_available === false`
- Never upload `.env` or secrets without explicit approval
- Treat Playground URLs as sensitive (~10 minutes)
