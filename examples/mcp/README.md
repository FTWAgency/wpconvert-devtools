# MCP configuration examples

Example MCP server entries for WPConvert. Copy the relevant block into your host config.

| File | Host |
| --- | --- |
| [cursor.json](cursor.json) | Cursor (`.cursor/mcp.json` or MCP settings) |
| [claude-desktop.json](claude-desktop.json) | Claude Desktop |

## API key

Replace `wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY` with your real key from **Settings → API & CLI**.

- **Do not commit** a config file containing a live key
- Use a literal placeholder — do not rely on `${WPCONVERT_API_KEY}` string interpolation (host support varies; a literal `${...}` string is a common silent failure)

Optional: `WPCONVERT_API_BASE` for non-production API hosts (testing only).

See [docs/mcp.md](../../docs/mcp.md) and [docs/agents.md](../../docs/agents.md).
