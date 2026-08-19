'use strict';

/**
 * Package metadata guards for the wpconvert CLI.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(pkgRoot, 'README.md'), 'utf8');

describe('CLI package metadata', () => {
  it('ships LICENSE in the files array and on disk', () => {
    assert.ok(pkg.files.includes('LICENSE'));
    assert.ok(fs.existsSync(path.join(pkgRoot, 'LICENSE')));
  });

  it('documents Playground expiry as about ten minutes, not thirty', () => {
    assert.doesNotMatch(readme, /30\s*min/i);
    assert.match(readme, /about ten minutes/i);
  });

  it('points repository metadata at the public devtools mirror', () => {
    assert.strictEqual(pkg.repository.directory, 'packages/cli');
    assert.match(pkg.repository.url, /wpconvert-devtools/);
  });
});
