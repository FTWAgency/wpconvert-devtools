'use strict';

/**
 * CLI integration tests for quota --json / human output and convert preflight.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CLI = path.join(__dirname, '../bin/wpconvert.js');
const API_KEY = 'wpc_live_test_key_000000000000000000000000';

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        Promise.resolve(handler(req, res, Buffer.concat(chunks))).catch((err) => {
          res.statusCode = 500;
          res.end(String(err.message || err));
        });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function runCli(args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        ...env,
        // Avoid picking up a real user config key
        WPCONVERT_API_KEY: env.WPCONVERT_API_KEY !== undefined ? env.WPCONVERT_API_KEY : API_KEY,
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function sampleCapabilities(overrides = {}) {
  return {
    effectivePlan: 'pro',
    current: 2,
    max: 20,
    remaining: 18,
    payg_credits: 2,
    conversion_credits: 0,
    api_conversion_mode: 'full',
    capabilities: {
      developer_access: { enabled: true, authenticated: true },
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'subscription_quota',
        reason: 'subscription_quota_available',
      },
      usage: {
        plan: 'pro',
        subscription: { limit: 20, used: 2, remaining: 18 },
        payg_credits: 2,
        starter_credits: 0,
        free_previews: { limit: 3, used: 0, remaining: 3 },
      },
      outputs: {
        download: { available: true, reason: null },
      },
      recommended_action: 'convert_full',
      reasons: ['subscription_quota_available'],
      ...overrides.capabilities,
    },
    ...overrides,
  };
}

describe('wpconvert quota CLI', () => {
  let mock;
  let lastQuotaBody;
  let requests;

  beforeEach(async () => {
    requests = [];
    lastQuotaBody = sampleCapabilities();
    mock = await startMockServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      if (req.url === '/api/convert/quota') {
        return json(res, 200, lastQuotaBody);
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
  });

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it('quota --json prints valid complete JSON once on stdout', async () => {
    lastQuotaBody = sampleCapabilities();
    const r = await runCli(['quota', '--json'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(r.stderr.trim(), '');
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.capabilities);
    assert.ok(parsed.capabilities.conversion);
    assert.strictEqual(parsed.capabilities.conversion.mode, 'full');
    // Exactly one JSON document
    assert.strictEqual(r.stdout.trim().startsWith('{'), true);
    assert.doesNotThrow(() => JSON.parse(r.stdout));
    assert.ok(!/\x1b\[/.test(r.stdout), 'no ANSI colors');
    assert.ok(!/Plan\s+Pro/.test(r.stdout), 'no human labels');
  });

  it('quota human output includes capability summary', async () => {
    const r = await runCli(['quota'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /Conversion mode\s+Full/);
    assert.match(r.stdout, /Can start\s+Yes/);
    assert.match(r.stdout, /Next conversion\s+Subscription quota/);
  });

  it('quota --json failure writes only to stderr and leaves stdout empty', async () => {
    await mock.close();
    mock = await startMockServer((req, res) => {
      if (req.url === '/api/convert/quota') {
        return json(res, 401, { error: { code: 'invalid_api_key', message: 'bad key' } });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
    const r = await runCli(['quota', '--json'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(r.stdout, '');
    assert.ok(r.stderr.length > 0);
  });

  it('quota does not invent stripped privacy fields', async () => {
    lastQuotaBody = sampleCapabilities();
    delete lastQuotaBody.paused_subscription_id;
    delete lastQuotaBody.purchased_conversions;
    delete lastQuotaBody.free_preview_keys_enabled;
    const r = await runCli(['quota', '--json'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    const parsed = JSON.parse(r.stdout);
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'paused_subscription_id'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'purchased_conversions'));
    assert.ok(!Object.prototype.hasOwnProperty.call(parsed, 'free_preview_keys_enabled'));
  });
});

describe('wpconvert convert preflight', () => {
  let mock;
  let requests;
  let quotaHandler;
  let siteDir;
  let zipBuilt;

  function makeSite() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-cli-site-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><body>hi</body></html>');
    return dir;
  }

  beforeEach(async () => {
    requests = [];
    zipBuilt = false;
    siteDir = makeSite();
    quotaHandler = () => sampleCapabilities();

    // Monkey-patch: detect zip build via convert POST body arriving
    mock = await startMockServer((req, res, body) => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
        ),
        bodyLength: body.length,
      });
      if (req.url === '/api/convert/quota') {
        const payload = typeof quotaHandler === 'function' ? quotaHandler() : quotaHandler;
        if (payload && payload.__status) {
          return json(res, payload.__status, payload.__body);
        }
        if (payload && payload.__throwNetwork) {
          res.destroy();
          return;
        }
        return json(res, 200, payload);
      }
      if (req.url === '/api/convert' && req.method === 'POST') {
        zipBuilt = true;
        return json(res, 200, {
          jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          preview_only: false,
          conversion_mode: 'full',
        });
      }
      if (req.url && req.url.startsWith('/api/convert/') && req.url.endsWith('/status')) {
        return json(res, 200, {
          jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'done',
          progress: 100,
          download_available: true,
          preview_only: false,
        });
      }
      if (req.url && req.url.startsWith('/api/download/')) {
        return json(res, 200, { download_url: `${mock.baseUrl}/theme.bin`, name: 'theme.zip' });
      }
      if (req.url === '/theme.bin') {
        res.statusCode = 200;
        res.end('ZIPDATA');
        return;
      }
      if (req.url === '/api/playground/sessions') {
        return json(res, 200, {
          playground_url: 'https://playground.example/test',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
  });

  afterEach(async () => {
    if (mock) await mock.close();
    try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  it('can_start false exits 3 before upload and without idempotency key', async () => {
    quotaHandler = () => sampleCapabilities({
      capabilities: {
        conversion: {
          can_start: false,
          mode: 'full',
          consumes: 'none',
          reason: 'subscription_quota_exhausted',
        },
        usage: {
          plan: 'pro',
          subscription: { limit: 20, used: 20, remaining: 0 },
          payg_credits: 0,
          starter_credits: 0,
          free_previews: { limit: 3, used: 0, remaining: 3 },
        },
        outputs: { download: { available: false, reason: null } },
        recommended_action: 'buy_payg_or_wait_renewal',
        reasons: ['subscription_quota_exhausted'],
      },
      remaining: 0,
      current: 20,
      payg_credits: 0,
    });

    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 3, r.stderr + r.stdout);
    assert.match(r.stderr, /Subscription quota exhausted/);
    const convertReq = requests.find((x) => x.path === '/api/convert');
    const uploadReq = requests.find((x) => x.path === '/api/convert/upload-url');
    assert.ok(!convertReq, 'must not multipart submit');
    assert.ok(!uploadReq, 'must not request upload URL');
    assert.ok(!zipBuilt);
    assert.ok(!requests.some((x) => x.headers && x.headers['idempotency-key']));
    const quotaReqs = requests.filter((x) => x.path === '/api/convert/quota');
    assert.strictEqual(quotaReqs.length, 1);
  });

  it('can_start true continues and prints compact summary', async () => {
    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Mode: Full/);
    assert.match(r.stdout, /Uses: Subscription quota/);
    assert.ok(requests.some((x) => x.path === '/api/convert'));
    const convertReq = requests.find((x) => x.path === '/api/convert');
    assert.ok(convertReq.headers['idempotency-key']);
  });

  it('preview_only warns before submit', async () => {
    quotaHandler = () => sampleCapabilities({
      effectivePlan: 'starter',
      api_conversion_mode: 'preview_only',
      capabilities: {
        conversion: {
          can_start: true,
          mode: 'preview_only',
          consumes: 'free_preview',
          reason: 'free_preview_available',
        },
        usage: {
          plan: 'starter',
          subscription: { limit: 1, used: 0, remaining: 1 },
          payg_credits: 0,
          starter_credits: 0,
          free_previews: { limit: 3, used: 0, remaining: 3 },
        },
        outputs: { download: { available: false, reason: 'download_requires_upgrade' } },
        recommended_action: 'convert_preview',
        reasons: ['free_preview_available', 'download_requires_upgrade'],
      },
    });
    // status/download after submit: mark preview-only so finishConversion doesn't try download
    await mock.close();
    requests = [];
    mock = await startMockServer((req, res) => {
      requests.push({ method: req.method, path: req.url, headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ) });
      if (req.url === '/api/convert/quota') return json(res, 200, quotaHandler());
      if (req.url === '/api/convert' && req.method === 'POST') {
        return json(res, 200, {
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'queued',
          preview_only: true,
          conversion_mode: 'preview_only',
          free_dev_preview: { number: 1, limit: 3 },
        });
      }
      if (req.url && req.url.endsWith('/status')) {
        return json(res, 200, {
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'done',
          preview_only: true,
          conversion_mode: 'preview_only',
          download_available: false,
        });
      }
      if (req.url === '/api/playground/sessions') {
        return json(res, 200, { playground_url: 'https://playground.example/p', expires_at: new Date().toISOString() });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });

    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /preview-only result/i);
    assert.match(r.stdout, /Mode: Preview only/);
  });

  it('missing capabilities continues legacy flow', async () => {
    quotaHandler = () => ({
      effectivePlan: 'pro',
      current: 0,
      max: 20,
      remaining: 20,
      payg_credits: 0,
    });
    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.ok(requests.some((x) => x.path === '/api/convert'));
    assert.ok(!/Mode: Full/.test(r.stdout));
  });

  it('network failure on quota warns and continues', async () => {
    await mock.close();
    let n = 0;
    mock = await startMockServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      if (req.url === '/api/convert/quota') {
        n += 1;
        res.statusCode = 503;
        res.end('unavailable');
        return;
      }
      if (req.url === '/api/convert' && req.method === 'POST') {
        return json(res, 200, {
          jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          status: 'queued',
        });
      }
      if (req.url && req.url.endsWith('/status')) {
        return json(res, 200, {
          jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          status: 'done',
          download_available: true,
        });
      }
      if (req.url && req.url.startsWith('/api/download/')) {
        return json(res, 200, { download_url: `${mock.baseUrl}/theme.bin`, name: 'theme.zip' });
      }
      if (req.url === '/theme.bin') {
        res.statusCode = 200;
        res.end('ZIP');
        return;
      }
      if (req.url === '/api/playground/sessions') {
        return json(res, 200, { playground_url: 'https://playground.example/x', expires_at: new Date().toISOString() });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
    requests = [];

    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /Could not verify conversion availability/);
    assert.strictEqual(requests.filter((x) => x.path === '/api/convert/quota').length, 1);
    assert.ok(requests.some((x) => x.path === '/api/convert'));
  });

  it('auth failure on quota stops with exit 1 and no submit', async () => {
    quotaHandler = () => ({
      __status: 401,
      __body: { error: { code: 'invalid_api_key', message: 'bad' } },
    });
    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 1, r.stderr + r.stdout);
    assert.ok(!requests.some((x) => x.path === '/api/convert'));
  });

  it('dry-run performs no quota request and no idempotency key', async () => {
    const r = await runCli(['convert', siteDir, '--dry-run'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Dry run only/);
    assert.ok(!requests.some((x) => x.path === '/api/convert/quota'));
    assert.ok(!requests.some((x) => x.path === '/api/convert'));
  });

  it('submit-time 429 remains exit 1 not exit 3', async () => {
    await mock.close();
    mock = await startMockServer((req, res) => {
      requests.push({ method: req.method, path: req.url });
      if (req.url === '/api/convert/quota') {
        return json(res, 200, sampleCapabilities());
      }
      if (req.url === '/api/convert' && req.method === 'POST') {
        return json(res, 429, {
          error: { code: 'rate_limited', message: 'slow down', retry_after: 2 },
        });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
    requests = [];

    const r = await runCli(['convert', siteDir, '--no-download', '--no-preview', '--no-open'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY, CI: '1' },
      cwd: siteDir,
    });
    assert.strictEqual(r.code, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /Rate limited/i);
  });
});

describe('status download guidance', () => {
  let mock;

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it('preview-only job does not suggest download', async () => {
    mock = await startMockServer((req, res) => {
      if (req.url && req.url.endsWith('/status')) {
        return json(res, 200, {
          jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          project_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          status: 'done',
          preview_only: true,
          conversion_mode: 'preview_only',
          download_available: false,
        });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
    const r = await runCli(['status', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(!/Download\}?\s+run:/.test(r.stdout) && !/wpconvert download/.test(r.stdout));
    assert.match(r.stdout, /wpconvert preview/);
    assert.match(r.stdout, /preview-only/i);
  });

  it('downloadable job preserves download guidance', async () => {
    mock = await startMockServer((req, res) => {
      if (req.url && req.url.endsWith('/status')) {
        return json(res, 200, {
          jobId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          project_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          status: 'done',
          preview_only: false,
          download_available: true,
        });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing' } });
    });
    const r = await runCli(['status', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'], {
      env: { WPCONVERT_API_BASE: mock.baseUrl, WPCONVERT_API_KEY: API_KEY },
    });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.match(r.stdout, /wpconvert download/);
    assert.match(r.stdout, /wpconvert preview/);
  });
});
