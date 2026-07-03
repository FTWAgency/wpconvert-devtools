# Contributing

Thank you for your interest in contributing to WPConvert developer tools!

## What Belongs Here

This repository contains **open-source client tooling only**:

- CLI (`packages/cli`)
- MCP server (`packages/mcp`)
- API examples (`examples/`)
- Documentation (`docs/`)

Contributions welcome:

- Documentation fixes and improvements
- CLI bug fixes and usability improvements
- MCP server bug fixes and tool improvements
- API example updates (must match the real hosted API)

## What Does Not Belong Here

- Conversion engine code
- Backend workers, AI prompts, parser/mapper logic
- Billing or quota implementation
- Supabase service-role or private API server code
- Secrets, API keys, `.env` files, or real credentials

If you need to change server-side behavior, that lives in the proprietary WPConvert platform — not in this repo.

## Before Submitting a PR

1. Do **not** include secrets, API keys, or real `.env` files.
2. Run the smoke check:
   ```bash
   npm install
   npm run check
   ```
3. Keep changes focused — one fix or feature per PR when possible.

## Code of Conduct

Be respectful and constructive. Do not submit projects you do not own or have permission to process through WPConvert.
