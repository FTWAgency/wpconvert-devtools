/**
 * What the published npx server lists and ships, locked (docs/HOSTED_MCP_PLAN.md §7.3).
 *
 * Tool definitions are shared with the hosted server. The stdio server must
 * keep answering tools/list with exactly the same names, descriptions, input
 * schemas and annotations, and keep its package shape: name, bin, files,
 * mcpName, and every module it imports inside `files`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startStdioServer } from './helpers/stdio-session.js';
import { assertMatchesGolden } from './helpers/golden.js';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const GOLDEN = fileURLToPath(new URL('./fixtures/stdio-tools-list.golden.json', import.meta.url));

describe('stdio tools/list', () => {
  let session;

  before(async () => {
    session = await startStdioServer();
  });

  after(() => session && session.close());

  it('matches the golden file byte for byte', async () => {
    assertMatchesGolden(GOLDEN, await session.listTools());
  });

  it('initializes as wpconvert-mcp with the tools capability only', () => {
    assert.strictEqual(session.init.serverInfo.name, 'wpconvert-mcp');
    assert.strictEqual(session.init.serverInfo.version, pkg.version);
    assert.deepStrictEqual(session.init.capabilities, { tools: {} });
  });
});

describe('published package', () => {
  it('keeps its name, bin, files and mcpName', () => {
    assert.strictEqual(pkg.name, '@wpconvert/mcp');
    assert.deepStrictEqual(pkg.bin, { 'wpconvert-mcp': 'src/server.mjs' });
    assert.deepStrictEqual(pkg.files, ['src/', 'README.md', 'LICENSE']);
    assert.strictEqual(pkg.mcpName, 'ai.wpconvert/mcp');
  });

  it('ships every module the stdio server imports', () => {
    const shipped = (rel) => pkg.files.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));
    const reached = new Set();
    const visit = (rel) => {
      if (reached.has(rel)) return;
      reached.add(rel);
      const source = fs.readFileSync(path.join(pkgRoot, rel), 'utf8');
      for (const [, spec] of source.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
      }
    };
    visit(pkg.bin['wpconvert-mcp']);
    assert.ok(reached.size > 1, 'found no relative imports');
    assert.deepStrictEqual([...reached].filter((rel) => !shipped(rel)), []);
  });
});
