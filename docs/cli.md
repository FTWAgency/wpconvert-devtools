# CLI Reference

The `wpconvert` CLI converts a local folder into a WordPress theme by calling the hosted WPConvert API.

## Install

```bash
npm install -g wpconvert
```

## Authenticate

```bash
wpconvert login
# or for CI:
export WPCONVERT_API_KEY=wpc_live_xxx
```

Keys are stored at `~/.wpconvert/config.json` (mode 0600).

## Commands

### `wpconvert convert <target>`

Convert a folder to a WordPress theme.

```bash
wpconvert convert . --type theme
```

**Options:**

| Flag | Description |
| --- | --- |
| `--type theme` | Export type (only `theme` supported via CLI today) |
| `--name <name>` | Project name (defaults to folder name) |
| `--root <dir>` | Force a subdirectory (e.g. `--root dist`) |
| `--dry-run` | List files that would be uploaded; no upload, no credit |
| `--ignore <glob>` | Additional ignore glob (repeatable) |
| `--no-default-ignores` | Disable built-in build/junk ignores |
| `--include-node-modules` | Include `node_modules` (not recommended) |
| `--include-env` | Include `.env` / secret files (DANGER) |
| `--no-gitignore` | Do not honor `.gitignore` |
| `--max-asset-size <mb>` | Exclude files larger than N MB |
| `--no-download` | Do not auto-download on success |
| `--out <dir>` | Directory to save the downloaded theme |

### `wpconvert status <jobId>`

Check conversion status.

### `wpconvert download <jobId>`

Download a completed conversion.

### `wpconvert preview <jobId> [--open]`

Create a WordPress Playground preview URL.

### `wpconvert quota`

Show remaining conversions / credits.

### `wpconvert login`

Store your API key locally.

## Site root detection

When you run `wpconvert convert .`, the CLI automatically detects what to package:

1. `index.html` in the folder → uses it as-is
2. Build output (`dist/`, `build/`, `out/`, `public/`, …) with `index.html` → uses that
3. Un-built framework project → stops and tells you to `npm run build` first
4. Override with `--root <dir>`

## Safety

- Secrets excluded by default (`.env`, keys, credentials)
- Symlinks never followed
- Use `--dry-run` to preview uploads
- Only upload projects you own or have permission to process

See [SECURITY.md](../SECURITY.md) for more.
