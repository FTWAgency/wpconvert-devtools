# CLI Reference

The `wpconvert` CLI converts a local folder into a WordPress theme by calling the hosted WPConvert API.

Current release: **wpconvert@0.4.0**

## Install

```bash
npm install -g wpconvert
# or per-invocation:
npx wpconvert
```

## Authenticate

```bash
wpconvert login            # sign in through your browser and type the code shown
wpconvert login --paste    # or paste an existing key (input hidden)
# or for CI:
export WPCONVERT_API_KEY=wpc_live_xxx
```

Keys and guest sessions are stored at `~/.wpconvert/config.json` (mode 0600). `WPCONVERT_API_KEY` takes priority over a saved key.

No key at all? `wpconvert convert .` offers a **free guest preview**: a link and code, one browser check, then a few Playground previews for 24 hours (no account). Guest previews can't be downloaded until bought; they are kept for 7 days. `--guest` skips the question in scripts; CI never starts a guest session.

## Recommended workflow

```text
Quota / capabilities  →  Convert  →  Status  →  Download OR Preview
```

```bash
wpconvert quota
wpconvert quota --json
wpconvert convert ./site
wpconvert status <job-id>
wpconvert download <job-id>
wpconvert preview <job-id>
```

Before a real conversion, the CLI performs a **read-only capability preflight** (same contract as `wpconvert quota`). Explicit entitlement denial exits with code **3**. Temporary preflight/network failures warn and defer to server enforcement. Legacy backends without `capabilities` continue to work.

`--dry-run` remains **local only** — no upload, no quota call, no credit.

Preview-only conversions may complete with a Playground preview but **no `theme.zip` download** until you upgrade and re-convert.

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
| `--open` | Open Playground preview in browser when ready |
| `--no-open` | Do not auto-open browser (CI/headless) |
| `--no-preview` | Skip Playground preview entirely |

Submissions use a durable **idempotency key** so ambiguous network retries do not double-charge or duplicate jobs.

### `wpconvert status <jobId>`

Check conversion status.

### `wpconvert download <jobId>`

Download a completed conversion. Preview-only jobs return a locked-download message — upgrade and re-convert instead.

### `wpconvert preview <jobId> [--open]`

Create a WordPress Playground preview URL.

### `wpconvert quota`

Show plan, credits, and the developer **capabilities** contract (conversion mode, `can_start`, download availability).

```bash
wpconvert quota --json
```

Returns the full backend quota body plus projected `summary` and `recommended_action` when capabilities are available.

### `wpconvert login [--paste | --key <key>]`

Sign in through your browser (default) and save a new API key, or store an existing key.

### `wpconvert plans`

Every paid option, what it includes, and today's price. No sign-in needed.

### `wpconvert unlock <jobId>` / `wpconvert upgrade`

Buy this theme (Starter or PAYG credits) or a plan that unlocks it, then download it; `upgrade` buys a plan or credits without a theme. Shows a numbered menu, or pick with `--starter`, `--pro`, `--agency`, `--payg <1|5|10|30>`, plus `--yearly`. Every purchase confirms the amount first (`--yes` skips it), opens Stripe Checkout in your browser, and waits up to 15 minutes for the payment. Signs you in first if needed. No free trial through the terminal. Exit code **2** when a choice is needed but there is no terminal to ask.

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
