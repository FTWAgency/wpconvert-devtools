---
name: wpconvert
description: >-
  Convert AI-built frontend projects (HTML, React, Vite, Next, Lovable, v0, Cursor exports)
  into WordPress themes via WPConvert MCP tools. Use when the user asks to convert a site or
  codebase to WordPress, create a WordPress theme from a frontend repo, preview a theme in
  WordPress Playground, or check WPConvert conversion quota before submitting. Requires
  WPCONVERT_API_KEY. Always call wpconvert_quota first; follow recommended_next; confirm
  before consuming payg_credit or starter_credit; never download when preview_only or
  download_available is false.
license: MIT
compatibility: Requires Node.js 18+, @wpconvert/mcp, and WPCONVERT_API_KEY. Works in Cursor, Claude Desktop, and other MCP stdio hosts.
metadata:
  author: WPConvert.ai
  version: "0.3.1"
allowed-tools: wpconvert_quota wpconvert_convert_folder wpconvert_check_status wpconvert_download_result wpconvert_create_preview wpconvert_explain_failure
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

## MCP config

See [examples/mcp/](../../examples/mcp/) — use a literal API key placeholder; do not commit real keys.
