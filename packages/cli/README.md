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

API keys require a **Pro/Agency** plan or available **PAYG credits**. Each successful conversion uses **1 credit** (Agency is unlimited up to its soft cap), exactly like the web app. Failed conversions are refunded.

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
- Polls until done, then downloads the theme `.zip` into the current directory.

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
wpconvert download <jobId>    # download a completed conversion
wpconvert preview <jobId>     # preview the theme in WordPress Playground
wpconvert quota               # show remaining conversions / credits
```

## Notes & safety

- **Secrets**: always run `--dry-run` first if you're unsure what will be uploaded. The secret denylist is on by default; `--include-env` is the only way to include those files.
- **Preview links are capability URLs**: anyone with a `wpconvert preview` URL can view the theme until the session expires. Avoid printing them in shared CI logs, and prefer omitting `--open` in headless environments.
- **Retries**: the CLI never auto-retries a submit after it's been sent (so you're never double-charged). The large-upload PUT step is idempotent and safe to retry.
- **URL conversion** is not available yet; point the CLI at a folder.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `WPCONVERT_API_KEY` | API key (overrides the stored config). |
| `WPCONVERT_API_BASE` | Override the API base URL (advanced/testing). |
