# Security Policy

## Reporting a Vulnerability

If you discover a security issue in the WPConvert CLI, MCP server, or API client examples, please report it privately:

- Email: **security@wpconvert.ai** (or contact via [wpconvert.ai](https://wpconvert.ai))
- Do **not** open a public GitHub issue for security vulnerabilities

We will acknowledge receipt and work to address confirmed issues promptly.

## Uploading Code Safely

The WPConvert CLI and MCP server zip local folders and upload them to the hosted WPConvert API. Follow these practices:

1. **Secrets are excluded by default.** The CLI excludes `.env`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.ssh/`, `credentials*.json`, and similar files unless you explicitly pass `--include-env` (CLI) or `includeEnv: true` (MCP).

2. **Always run `--dry-run` first** if you are unsure what will be uploaded:
   ```bash
   wpconvert convert . --dry-run
   ```

3. **Never paste API keys** into GitHub issues, pull requests, chat logs, or CI output. Use `wpconvert login` (stored at `~/.wpconvert/config.json`, mode 0600) or the `WPCONVERT_API_KEY` environment variable.

4. **Revoke exposed keys immediately** from your WPConvert dashboard (**Settings → API & CLI**) if a key is leaked.

5. **Preview links are capability URLs.** Anyone with a WordPress Playground preview URL can view the theme until it expires. Do not share preview URLs in public logs.

## What This Repo Does Not Contain

This repository contains only client tooling. The conversion engine, backend workers, and billing logic run on WPConvert.ai servers and are not part of this codebase.
