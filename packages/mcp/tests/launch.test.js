'use strict';

/**
 * The server must start when launched the way MCP hosts launch it:
 * `npx -y @wpconvert/mcp` runs node_modules/.bin/wpconvert-mcp, a symlink.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '..', 'src', 'server.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-mcp-launch-'));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'launch-test', version: '0' },
  },
});

/** Resolves with the initialize response, or null if the process exits or stays silent. */
function initializeVia(entry, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, WPCONVERT_API_KEY: 'wpc_live_launch_test_key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) finish(msg);
        } catch {
          // partial line
        }
      }
    });
    child.on('exit', () => finish(null));
    child.stdin.write(`${INITIALIZE}\n`);
  });
}

describe('MCP server launch', () => {
  it('answers initialize when run by its real path', async () => {
    const res = await initializeVia(serverPath);
    assert.ok(res, 'no initialize response');
    assert.strictEqual(res.result.serverInfo.name, 'wpconvert-mcp');
  });

  it('answers initialize when run through a bin symlink, as npx does', async () => {
    const bin = path.join(tmp, 'wpconvert-mcp');
    fs.symlinkSync(serverPath, bin);
    const res = await initializeVia(bin);
    assert.ok(res, 'server exited without answering when launched through a symlink');
    assert.strictEqual(res.result.serverInfo.name, 'wpconvert-mcp');
  });

  it('does not start when argv[1] points at some other script', async () => {
    const other = path.join(tmp, 'other.mjs');
    fs.writeFileSync(other, `await import(${JSON.stringify(serverPath)});\n`);
    const res = await initializeVia(other, 3000);
    assert.strictEqual(res, null);
  });
});
