#!/usr/bin/env node
/**
 * Structural drift checks for the Agent Discovery Pack.
 *
 * Blocking locally: tool names, CLI commands, versions, Playground duration claims,
 * capability paths, Skill frontmatter, referenced files.
 * Blocking network (WPConvert-owned): /openapi.yaml MIME + body, /llms.txt presence.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

function fail(message) {
  errors.push(message);
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

function globMarkdownFiles() {
  const dirs = ['docs', 'skills', 'examples'];
  const files = ['README.md', 'AGENTS.md'];
  for (const dir of dirs) {
    const full = path.join(ROOT, dir);
    if (!existsSync(full)) continue;
    walk(full, files);
  }
  return files.map((f) => path.relative(ROOT, f));

  function walk(dir, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, out);
      else if (/\.(md|MD)$/.test(entry.name) || entry.name === 'SKILL.md') out.push(p);
    }
  }
}

// --- MCP tools from source of truth ---
const serverSrc = read('packages/mcp/src/server.mjs');
const mcpTools = [...serverSrc.matchAll(/name:\s*'(wpconvert_[a-z_]+)'/g)].map((m) => m[1]);
const expectedTools = new Set(mcpTools);
if (expectedTools.size !== 6) {
  fail(`expected 6 MCP tools in server.mjs, found ${expectedTools.size}`);
}

// --- CLI commands ---
const cliSrc = read('packages/cli/bin/wpconvert.js');
const cliCommands = [...cliSrc.matchAll(/\.command\('([a-z]+)'/g)].map((m) => m[1]);
const expectedCommands = new Set(cliCommands);

// --- Docs / skill references ---
const docFiles = globMarkdownFiles();
const toolMention = /`?(wpconvert_[a-z_]+)`?/g;
const cliMention = /wpconvert\s+([a-z]+)/g;

for (const rel of docFiles) {
  const text = read(rel);
  for (const match of text.matchAll(toolMention)) {
    const tool = match[1];
    if (!expectedTools.has(tool)) {
      fail(`${rel}: documents unknown MCP tool ${tool}`);
    }
  }
  for (const match of text.matchAll(cliMention)) {
    const verb = match[1];
    if (verb === 'ai' || verb === 'js') continue;
    if (!expectedCommands.has(verb) && !['npx', 'install', 'run'].includes(verb)) {
      // Allow "wpconvert quota" in prose; skip npm install -g wpconvert false positives
      if (['login', 'convert', 'status', 'download', 'preview', 'quota'].includes(verb) && !expectedCommands.has(verb)) {
        fail(`${rel}: documents unknown CLI command wpconvert ${verb}`);
      }
    }
  }
}

// Stricter CLI check for backticked commands in docs/agents.md and docs/cli.md
for (const rel of ['docs/agents.md', 'docs/cli.md', 'README.md']) {
  if (!existsSync(path.join(ROOT, rel))) continue;
  const text = read(rel);
  for (const match of text.matchAll(/`wpconvert ([a-z]+)/g)) {
    const verb = match[1];
    if (!expectedCommands.has(verb)) {
      fail(`${rel}: backticked unknown CLI command wpconvert ${verb}`);
    }
  }
}

// --- Version consistency ---
const mcpPkg = JSON.parse(read('packages/mcp/package.json'));
const cliPkg = JSON.parse(read('packages/cli/package.json'));
if (!serverSrc.includes('version: pkg.version')) {
  fail('packages/mcp/src/server.mjs must use pkg.version for serverInfo');
}
if (/0\.1\.0-beta\.0/.test(serverSrc)) {
  fail('server.mjs still references 0.1.0-beta.0');
}
for (const rel of docFiles) {
  const text = read(rel);
  if (/MCP package version remains.*0\.2\.0/i.test(text)) {
    fail(`${rel}: stale 0.2.0 release copy`);
  }
}
if (mcpPkg.mcpName !== 'ai.wpconvert/mcp') {
  fail('packages/mcp/package.json missing mcpName ai.wpconvert/mcp');
}

// --- Playground duration (must not claim 30 minutes) ---
const durationScanPaths = [
  'packages/cli/README.md',
  'packages/mcp/README.md',
  'packages/mcp/src/server.mjs',
  'docs/agents.md',
  'docs/mcp.md',
  'skills/wpconvert/SKILL.md',
  'skills/wpconvert/references/workflow.md',
  'skills/wpconvert/references/troubleshooting.md',
];
for (const rel of durationScanPaths) {
  const text = read(rel);
  if (/30\s*min/i.test(text)) {
    fail(`${rel}: stale ~30 minute Playground claim (production is ~10 minutes)`);
  }
}

// --- Capability paths vs OpenAPI ---
const openapi = YAML.parse(read('openapi.yaml'));
const devCaps = openapi?.components?.schemas?.DeveloperCapabilities?.properties || {};
const conversionProps = openapi?.components?.schemas?.CapabilityConversion?.properties || {};
const requiredCapabilityPaths = [
  'capabilities.conversion.can_start',
  'capabilities.conversion.mode',
  'capabilities.conversion.consumes',
  'capabilities.conversion.reason',
  'capabilities.outputs.download.available',
  'capabilities.recommended_action',
  'capabilities.reasons',
];
const agentsMd = read('docs/agents.md');
for (const p of requiredCapabilityPaths) {
  if (!agentsMd.includes(p)) {
    fail(`docs/agents.md missing capability path: ${p}`);
  }
}
const consumesEnum = conversionProps.consumes?.enum || [];
for (const value of ['subscription_quota', 'payg_credit', 'starter_credit', 'free_preview', 'none']) {
  if (!consumesEnum.includes(value)) {
    fail(`openapi.yaml CapabilityConversion.consumes missing enum value: ${value}`);
  }
}
if (!devCaps.recommended_action) {
  fail('openapi.yaml missing DeveloperCapabilities.recommended_action');
}

// --- Skill validation ---
const SKILL_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const skillPath = 'skills/wpconvert/SKILL.md';
const skillRaw = read(skillPath);
const fmMatch = skillRaw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) {
  fail('skills/wpconvert/SKILL.md missing YAML frontmatter');
} else {
  let frontmatter;
  try {
    frontmatter = YAML.parse(fmMatch[1]);
  } catch (e) {
    fail(`skills/wpconvert/SKILL.md invalid frontmatter: ${e.message}`);
    frontmatter = null;
  }
  if (frontmatter) {
    for (const key of Object.keys(frontmatter)) {
      if (!SKILL_FIELDS.has(key)) {
        fail(`skills/wpconvert/SKILL.md frontmatter has disallowed field: ${key}`);
      }
    }
    for (const req of ['name', 'description']) {
      if (!frontmatter[req]) fail(`skills/wpconvert/SKILL.md missing frontmatter.${req}`);
    }
    if (String(frontmatter.description).length > 1536) {
      fail('skills/wpconvert/SKILL.md description exceeds 1536 characters');
    }
  }
}
for (const ref of ['skills/wpconvert/references/workflow.md', 'skills/wpconvert/references/troubleshooting.md']) {
  if (!existsSync(path.join(ROOT, ref))) {
    fail(`missing Skill reference: ${ref}`);
  }
}

// --- LICENSE in package manifests ---
for (const pkgRel of ['packages/cli/package.json', 'packages/mcp/package.json']) {
  const pkg = JSON.parse(read(pkgRel));
  if (!pkg.files?.includes('LICENSE')) {
    fail(`${pkgRel}: files array must include LICENSE`);
  }
  const licensePath = path.join(ROOT, path.dirname(pkgRel), 'LICENSE');
  if (!existsSync(licensePath)) {
    fail(`${pkgRel}: LICENSE file missing on disk`);
  }
}

// --- WPConvert-owned network surfaces (blocking) ---
async function checkOwnedSurfaces() {
  const openapiRes = await fetch('https://wpconvert.ai/openapi.yaml', {
    headers: { Accept: 'text/yaml, application/yaml, */*' },
    signal: AbortSignal.timeout(15000),
  });
  if (!openapiRes.ok) {
    fail(`https://wpconvert.ai/openapi.yaml returned HTTP ${openapiRes.status}`);
  } else {
    const ct = (openapiRes.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('yaml') && !ct.includes('text/plain')) {
      fail(`https://wpconvert.ai/openapi.yaml unexpected content-type: ${ct || '(none)'}`);
    }
    const body = await openapiRes.text();
    if (!body.startsWith('openapi: 3.1')) {
      fail('https://wpconvert.ai/openapi.yaml body does not start with openapi: 3.1');
    }
  }

  const llmsRes = await fetch('https://wpconvert.ai/llms.txt', { signal: AbortSignal.timeout(15000) });
  if (!llmsRes.ok) {
    fail(`https://wpconvert.ai/llms.txt returned HTTP ${llmsRes.status}`);
  } else {
    const body = await llmsRes.text();
    if (!body.includes('# WPConvert')) {
      fail('https://wpconvert.ai/llms.txt missing expected H1 content');
    }
  }
}

await checkOwnedSurfaces();

if (errors.length) {
  console.error('[check-agent-discovery] FAIL');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log('[check-agent-discovery] OK');
console.log(`  MCP tools: ${[...expectedTools].join(', ')}`);
console.log(`  CLI commands: ${[...expectedCommands].join(', ')}`);
console.log(`  packages: wpconvert@${cliPkg.version}, @wpconvert/mcp@${mcpPkg.version}`);
