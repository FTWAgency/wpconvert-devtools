# MCP configuration examples

Example MCP server entries for WPConvert. Copy the relevant block into your host config.

| File | Host |
| --- | --- |
| [cursor.json](cursor.json) | Cursor (`.cursor/mcp.json` or MCP settings) |
| [claude-desktop.json](claude-desktop.json) | Claude Desktop |
| No file needed | Claude Code: `claude mcp add wpconvert --scope user -- npx -y @wpconvert/mcp` ([docs/mcp.md](../../docs/mcp.md#configure-claude-code)) |

## API key (optional)

Without a key, the agent offers a link for free guest previews or browser sign-in. To use an existing key, keep the `env` block and replace `wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY` with your real key from **Settings → API & CLI**; for Claude Code add `-e WPCONVERT_API_KEY=…` after `--scope user`.

- **Do not commit** a config file containing a live key
- Use a literal placeholder — do not rely on `${WPCONVERT_API_KEY}` string interpolation (host support varies; a literal `${...}` string is a common silent failure)

Optional: `WPCONVERT_API_BASE` for non-production API hosts (testing only).

See [docs/mcp.md](../../docs/mcp.md) and [docs/agents.md](../../docs/agents.md).
