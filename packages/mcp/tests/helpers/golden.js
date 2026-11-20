/**
 * Golden files: committed JSON that a test's output must match byte for byte.
 * Re-record after an intended change, then review the diff:
 *   WPCONVERT_MCP_UPDATE_GOLDEN=1 node scripts/run-tests.cjs
 */

import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PKG_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const UPDATE_GOLDEN = process.env.WPCONVERT_MCP_UPDATE_GOLDEN === '1';
const HOW = 'WPCONVERT_MCP_UPDATE_GOLDEN=1 node scripts/run-tests.cjs';

export function assertMatchesGolden(file, actual) {
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  const shown = path.relative(PKG_ROOT, file);
  if (UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `Missing ${shown}. Record it with ${HOW}.`);
  const golden = fs.readFileSync(file, 'utf8');
  const hint = `Output differs from ${shown}. If the change is intended, re-record with ${HOW} and review the diff.`;
  assert.deepStrictEqual(actual, JSON.parse(golden), hint);
  assert.strictEqual(text, golden, hint);
}
