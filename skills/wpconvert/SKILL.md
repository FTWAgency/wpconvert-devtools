---
name: wpconvert
description: >-
  Convert AI-built frontend projects (HTML, React, Vite, Next, Lovable, v0, Cursor exports)
  into WordPress themes via WPConvert MCP tools. Use when the user asks to convert a site or
  codebase to WordPress, create a WordPress theme from a frontend repo, preview a theme in
  WordPress Playground, buy a theme or plan, or check WPConvert conversion quota before
  submitting. Works without an API key (wpconvert_connect gives the user a link for free
  guest previews or sign-in). Always call wpconvert_quota first; follow recommended_next;
  confirm before consuming payg_credit or starter_credit; never download when preview_only
  or download_available is false; for purchases show every wpconvert_plans option and call
  wpconvert_checkout only for the option the user picks.
license: MIT
compatibility: Requires Node.js 18+ and @wpconvert/mcp; WPCONVERT_API_KEY is optional. Works in Cursor, Claude Code, Claude Desktop, and other MCP stdio hosts.
metadata:
  author: WPConvert.ai
  version: "0.4.0"
allowed-tools: wpconvert_quota wpconvert_convert_folder wpconvert_check_status wpconvert_download_result wpconvert_create_preview wpconvert_explain_failure wpconvert_connect wpconvert_connect_status wpconvert_plans wpconvert_checkout
---

# WPConvert conversion skill

Read [references/workflow.md](references/workflow.md) for the step-by-step flow and [references/troubleshooting.md](references/troubleshooting.md) for failures.

**Canonical hub:** [docs/agents.md](../../docs/agents.md)

## Policy (must follow)

1. **Quota first** — `wpconvert_quota` before any conversion
2. **Credit confirmation** — disclose `consumes`; confirm `payg_credit` and `starter_credit` unless already authorized
3. **No false download promises** — when `preview_only` or `download_available === false`, use `wpconvert_create_preview` only
4. **Idempotency** — on ambiguous submit errors, reuse the returned `idempotency_key`; new intentional conversion → omit key
5. **No secrets** — never set `includeEnv` without explicit user approval
6. **No source edits** — do not change the frontend repo just to satisfy WPConvert
7. **Follow `recommended_next`** — do not invent polling intervals; honor `retry_after_seconds`
8. **Links are for the user** — show `wpconvert_connect` and checkout links with their code; never open them, sign in, or pay on the user's behalf
9. **The user chooses** — show every `wpconvert_plans` option; call `wpconvert_checkout` with the chosen `checkout_arguments` only after the user picks. There is no free trial through the MCP
10. **Guest uploads are not retried** — each guest upload uses a preview; ask before retrying after an ambiguous error

## MCP config

No key is needed (`claude mcp add wpconvert --scope user -- npx -y @wpconvert/mcp`). To use an existing key, see [examples/mcp/](../../examples/mcp/) — use a literal API key placeholder; do not commit real keys.
