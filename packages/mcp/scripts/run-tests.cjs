'use strict';

const { spawnSync } = require('child_process');

// Let Node's test runner expand globs — do not rely on shell globbing (breaks on Linux CI).
const result = spawnSync(process.execPath, ['--test', 'tests/**/*.test.js'], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
