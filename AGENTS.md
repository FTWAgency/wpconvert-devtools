# Contributor instructions (wpconvert-devtools)

This public repository is a **mirror** of WPConvert developer tooling. The conversion engine, API implementation, and website live in the private `FTWAgency/wpconvert` application repository.

## Source of truth

| Artifact | Rule |
| --- | --- |
| `packages/cli`, `packages/mcp` | Mirrored from the private monorepo via `scripts/sync-wpconvert-devtools-packages.mjs` in the private repo — **do not edit package source here** except when applying a mirror sync PR |
| `openapi.yaml` | Byte-identical mirror of production — **never hand-edit** schemas or paths |
| `docs/agents.md`, Skill, examples | Owned here — agent discovery content is developed in this public repo |

Package changes originate privately → npm publish (private) → sync to this repo.

## Validation

```bash
npm install
npm run check
```

`npm run check` runs structural agent-discovery drift checks, OpenAPI mirror verification, syntax checks, and workspace tests.

## Secrets

- Never commit real API keys
- Use `wpc_live_EXAMPLE_ONLY_NOT_A_REAL_KEY` in docs and examples
- Do not add `.env` files with live credentials

## What does not belong here

- WPConvert backend / worker / billing code
- Conversion engine, AI prompts, or theme generation logic
- Private customer data or internal runbooks

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contribution policy.

## Agent documentation map

| File | Audience |
| --- | --- |
| [docs/agents.md](docs/agents.md) | Canonical agent integration hub |
| [skills/wpconvert/SKILL.md](skills/wpconvert/SKILL.md) | Portable Skill for MCP hosts |
| [examples/agent-instructions/wpconvert.agents.template.md](examples/agent-instructions/wpconvert.agents.template.md) | Copyable snippet for user frontend repos |
