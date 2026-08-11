# wpconvert (CLI)

Convert a website or codebase **folder** into a WordPress theme without leaving your terminal. The CLI wraps the same conversion engine and credit system as the WPConvert dashboard.

> Requires Node.js >= 18.

## Install

```bash
npm install -g wpconvert
```

## Authenticate

Create an API key in your WPConvert dashboard (**Settings → API & CLI**), then:

```bash
wpconvert login            # paste the key (input hidden); stored at ~/.wpconvert/config.json (0600)
# or, for CI:
export WPCONVERT_API_KEY=wpc_live_xxx
```

API keys require a **Pro/Agency** plan or available **PAYG credits** for full downloadable conversions. Free verified accounts may also create preview-only keys (up to **3 lifetime** Playground previews — no theme ZIP download) when the server has developer previews enabled.

## Convert a folder

```bash
cd your-project
wpconvert convert . --type theme
```

- **Finds the right folder automatically.** Run it from your project folder and the CLI figures out what to package:
  - `index.html` in the folder → uses it as-is (plain HTML sites, most AI exports).
  - A build-output folder with an `index.html` (`dist/`, `build/`, `out/`, `public/`, …) → uses that and tells you.
  - An un-built framework project (React/Vite/Next/Astro/…) → stops and tells you to `npm run build` first.
  - Override anytime with `--root <dir>` (skips detection).
- Smart-zips the folder for you. By default it **excludes** `node_modules`, `.git`, build output, OS junk, and — for safety — secrets (`.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.ssh/`, `credentials*.json`). Your `.gitignore` is honored. Symlinks are never followed.
- Uploads small zips via multipart; large zips go directly to storage (up to your plan ceiling).
- Polls until done, then downloads the theme `.zip` into the current directory (paid conversions only; preview-only jobs open Playground instead).

### Where do I run it?

| Your project | Command |
|---|---|
| Plain HTML (has `index.html`) — most AI exports, Framer/Webflow | `wpconvert convert .` |
| React/Vite/Next/Astro (Lovable, Bolt, v0, Replit, Cursor…) | `npm run build`, then `wpconvert convert .` |
| Not sure | `wpconvert convert . --dry-run` (detects it or tells you to build) |

### Useful flags

```bash
wpconvert convert ./my-site --dry-run            # list what would be uploaded; no upload, no credit
wpconvert convert ./repo --root dist             # force a subdirectory; skip auto-detection
wpconvert convert ./site --max-asset-size 25     # drop individual files > 25MB (they won't render)
wpconvert convert ./site --ignore "*.psd" --ignore "design/**"
wpconvert convert ./site --include-env           # DANGER: uploads .env/secret files
wpconvert convert ./site --no-download           # don't auto-download on success
```

## Preview in WordPress Playground

Preview a finished conversion in a live, in-browser WordPress (no local install):

```bash
wpconvert preview <jobId>          # print a preview URL
wpconvert preview <jobId> --open   # also open it in your default browser
```

The URL boots WordPress Playground with your theme installed and activated — the same preview you get in the dashboard. Sessions expire after 30 minutes and are use-limited.

## Other commands

```bash
wpconvert status <jobId>      # check a job's status
wpconvert download <jobId>    # download a completed conversion (paid / full jobs only)
wpconvert preview <jobId>     # preview the theme in WordPress Playground
wpconvert quota               # show plan, usage, and next-conversion capabilities
wpconvert quota --json        # print the complete backend quota JSON (for scripts/agents)
```

### Quota and conversion preflight

`wpconvert quota` shows what the **next** developer conversion will do, using the server’s authoritative `capabilities` object (when present):

- Effective mode (`full` or `preview_only`)
- Whether a conversion can start
- What entitlement it would consume
- Remaining subscription / PAYG / Starter / free-preview usage
- Whether the next result is downloadable
- A recommended next action when blocked

`wpconvert quota --json` prints the **complete** backend response as pretty-printed JSON on stdout (no banners or colors). On failure, the error goes to stderr and stdout stays empty.

Real `wpconvert convert` commands call quota once **before** building the ZIP (after `--dry-run` exits). Behavior:

| Quota / capability result | CLI behavior |
| --- | --- |
| `capabilities.conversion.can_start === true` | Continues; prints a compact mode/uses/download summary |
| `can_start === false` | Stops before ZIP/upload; **exit code `3`** |
| No `capabilities` (older API) | Legacy path — continues; server enforces at submit |
| Network / timeout / 5xx on quota | Warns and continues; server remains authoritative |
| Auth failure on quota | Stops; **exit code `1`** |

`--dry-run` **skips** the quota check entirely (local-only).

Submit-time rate limits, in-flight caps, and worker errors are **not** modeled by preflight — they remain server errors (typically exit `1`).

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Generic failure (auth, validation, network, submit-time errors) |
| `3` | Authenticated capability response explicitly blocks conversion (`can_start: false`) |

## Notes & safety

- **Secrets**: always run `--dry-run` first if you're unsure what will be uploaded. The secret denylist is on by default; `--include-env` is the only way to include those files.
- **Preview links are capability URLs**: anyone with a `wpconvert preview` URL can view the theme until the session expires. Avoid printing them in shared CI logs, and prefer omitting `--open` in headless environments.

## Free developer previews (preview-only)

When enabled on the server, free verified accounts can create API keys that run **preview-only** conversions — WordPress Playground preview, **no theme ZIP download**. Try the CLI/MCP workflow before upgrading.

- **3 lifetime** preview-only conversions per account (separate from the dashboard free preview).
- **1 concurrent** job; stricter submit rate limits than paid keys.
- **Full exports require PRO, Agency, or PAYG credits** — a one-time Starter unlock does not grant programmatic download access.
- Preview-only jobs are **never retroactively downloadable**; after upgrading, **re-run** the conversion to get a ZIP.

On success, `wpconvert convert` **automatically creates a Playground preview URL**. Preview-only jobs **auto-open your browser** by default; paid users get the link only (pass `--open` to launch). Use `--no-open` in CI/headless, or `--no-preview` to skip Playground entirely.

Paid conversions use **1 credit** each (Agency is unlimited up to its soft cap), exactly like the web app. Failed conversions are refunded.
- **Retries**: the CLI never auto-retries a submit after it's been sent (so you're never double-charged). The large-upload PUT step is idempotent and safe to retry.
- **URL conversion** is not available yet; point the CLI at a folder.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WPCONVERT_API_KEY` | API key (overrides the stored config). |
| `WPCONVERT_API_BASE` | Override the API base URL (advanced/testing). |
