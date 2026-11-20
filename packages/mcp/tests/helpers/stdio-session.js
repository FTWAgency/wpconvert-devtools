/**
 * Drive src/server.mjs over stdio the way an MCP host does: newline-delimited
 * JSON-RPC on stdin/stdout, initialize first. HOME is a throwaway directory so
 * ~/.wpconvert/config.json is whatever the test writes there, and
 * WPCONVERT_API_KEY is never inherited.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const SERVER = fileURLToPath(new URL('../../src/server.mjs', import.meta.url));

export async function startStdioServer({ env = {}, timeoutMs = 10000 } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-mcp-stdio-'));
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete childEnv.WPCONVERT_API_KEY;
  delete childEnv.WPCONVERT_API_BASE;
  Object.assign(childEnv, env);

  const child = spawn(process.execPath, [SERVER], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const waiting = new Map();
  let stdout = '';
  let stderr = '';
  let nextId = 1;

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, end).trim();
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const settle = waiting.get(message.id);
      if (settle) settle(message);
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method}: no answer within ${timeoutMs}ms. stderr:\n${stderr}`));
      }, timeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      });
      send({ id, method, params });
    });
  }

  let init;
  try {
    init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wpconvert-mcp-tests', version: '0' },
    });
    send({ method: 'notifications/initialized' });
  } catch (error) {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
    throw error;
  }

  return {
    home,
    init,
    listTools: () => request('tools/list', {}),
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    async close() {
      child.kill();
      await exited;
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
