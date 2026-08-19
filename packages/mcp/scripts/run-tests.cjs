'use strict';

const { readdirSync, statSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

function collectTests(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTests(full));
      continue;
    }
    if (entry.endsWith('.test.js')) files.push(full);
  }
  return files;
}

const tests = collectTests(join(__dirname, '..', 'tests'));
if (tests.length === 0) {
  console.error('No test files found under tests/');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
