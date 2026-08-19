'use strict';

/**
 * Package metadata and agent-facing claim guards for the MCP server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const serverSrc = fs.readFileSync(path.join(pkgRoot, 'src', 'server.mjs'), 'utf8');
const readme = fs.readFileSync(path.join(pkgRoot, 'README.md'), 'utf8');

describe('MCP package metadata', () => {
  it('advertises serverInfo.version from package.json', () => {
    assert.match(serverSrc, new RegExp(`version:\\s*pkg\\.version`));
    assert.doesNotMatch(serverSrc, /0\.1\.0-beta\.0/);
    assert.strictEqual(pkg.version, '0.3.1');
  });

  it('includes mcpName for MCP Registry verification', () => {
    assert.strictEqual(pkg.mcpName, 'ai.wpconvert/mcp');
  });

  it('ships LICENSE in the files array and on disk', () => {
    assert.ok(pkg.files.includes('LICENSE'));
    assert.ok(fs.existsSync(path.join(pkgRoot, 'LICENSE')));
  });

  it('documents Playground expiry as about ten minutes, not thirty', () => {
    assert.match(serverSrc, /about ten minutes/i);
    assert.doesNotMatch(serverSrc, /30\s*min/i);
    assert.doesNotMatch(readme, /30\s*min/i);
    assert.match(readme, /about ten minutes/i);
  });

  it('does not claim MCP package version remains 0.2.0', () => {
    assert.doesNotMatch(readme, /0\.2\.0/);
  });

  it('README dependency pin matches package.json wpconvert version', () => {
    const expected = pkg.dependencies.wpconvert;
    assert.ok(expected, 'package.json must pin wpconvert');
    const pinMatch = readme.match(/wpconvert@(\d+\.\d+\.\d+)/);
    assert.ok(pinMatch, 'README must document wpconvert@X.Y.Z in Dependency pin section');
    assert.strictEqual(
      pinMatch[1],
      expected,
      `README documents wpconvert@${pinMatch[1]} but package.json pins ${expected}`,
    );
  });
});
