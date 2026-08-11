'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { URL } = require('url');

const API_KEY = 'wpc_live_test_key_000000000000000000000000';
const IDEM_HEADER = 'idempotency-key';

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        Promise.resolve(handler(req, res, body))
          .catch((err) => {
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

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

function loadFreshApi() {
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/idempotency')];
  delete require.cache[require.resolve('../src/api')];
  return require('../src/api');
}

describe('CLI API idempotency wiring', () => {
  /** @type {import('http').IncomingMessage[]} */
  let requests;
  let mock;
  let api;
  let prevEnv;

  beforeEach(async () => {
    requests = [];
    prevEnv = {
      WPCONVERT_API_KEY: process.env.WPCONVERT_API_KEY,
      WPCONVERT_API_BASE: process.env.WPCONVERT_API_BASE,
    };
    process.env.WPCONVERT_API_KEY = API_KEY;
    mock = await startMockServer((req, res, body) => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
        ),
        body,
      });
      if (req.url === '/api/convert/quota') {
        return json(res, 200, { effectivePlan: 'starter', current: 0, max: 3, remaining: 3 });
      }
      if (req.url === '/api/convert/upload-url' && req.method === 'POST') {
        return json(res, 200, {
          jobId: '11111111-1111-4111-8111-111111111111',
          signedUrl: `${mock.baseUrl}/signed-upload`,
          maxSizeMB: 100,
          plan: 'starter',
        });
      }
      if (req.url === '/signed-upload' && req.method === 'PUT') {
        res.statusCode = 200;
        res.end('');
        return;
      }
      if (req.url === '/api/convert' && req.method === 'POST') {
        return json(res, 200, { jobId: '22222222-2222-4222-8222-222222222222', status: 'queued', idempotent_replay: false });
      }
      if (req.url === '/api/convert/from-storage' && req.method === 'POST') {
        return json(res, 200, { jobId: '33333333-3333-4333-8333-333333333333', status: 'queued', idempotent_replay: false });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing route' } });
    });
    process.env.WPCONVERT_API_BASE = mock.baseUrl;
    api = loadFreshApi();
  });

  afterEach(async () => {
    if (mock) await mock.close();
    process.env.WPCONVERT_API_KEY = prevEnv.WPCONVERT_API_KEY;
    process.env.WPCONVERT_API_BASE = prevEnv.WPCONVERT_API_BASE;
  });

  it('sends Idempotency-Key on multipart convert only', async () => {
    const key = 'wpconvert-cli-11111111-1111-4111-8111-111111111111';
    await api.convertMultipart(Buffer.from('zip'), { projectName: 'p', exportType: 'theme', idempotencyKey: key });

    const convertReq = requests.find((r) => r.path === '/api/convert');
    const quotaReq = requests.find((r) => r.path === '/api/convert/quota');
    assert.ok(convertReq);
    assert.equal(convertReq.headers[IDEM_HEADER], key);
    assert.ok(convertReq.headers['x-wpconvert-client'].startsWith('cli/'));
    assert.ok(!quotaReq);
  });

  it('does not send Idempotency-Key on upload-url or signed PUT', async () => {
    const key = 'wpconvert-cli-22222222-2222-4222-8222-222222222222';
    const up = await api.getUploadUrl();
    await api.putToSignedUrl(up.signedUrl, Buffer.from('zip'));
    await api.createJobFromStorage(up.jobId, { projectName: 'p', exportType: 'theme', idempotencyKey: key });

    const uploadUrlReq = requests.find((r) => r.path === '/api/convert/upload-url');
    const putReq = requests.find((r) => r.path === '/signed-upload');
    const fromStorageReq = requests.find((r) => r.path === '/api/convert/from-storage');
    assert.ok(uploadUrlReq);
    assert.ok(putReq);
    assert.ok(fromStorageReq);
    assert.equal(uploadUrlReq.headers[IDEM_HEADER], undefined);
    assert.equal(putReq.headers[IDEM_HEADER], undefined);
    assert.equal(fromStorageReq.headers[IDEM_HEADER], key);
  });

  it('reuses the same key when submission transport retry succeeds', async () => {
    let convertCalls = 0;
    await mock.close();
    mock = await startMockServer((req, res, body) => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
        ),
        body,
      });
      if (req.url === '/api/convert' && req.method === 'POST') {
        convertCalls += 1;
        if (convertCalls === 1) {
          res.destroy(new Error('socket hang up'));
          return;
        }
        return json(res, 200, { jobId: '44444444-4444-4444-8444-444444444444', status: 'queued', idempotent_replay: false });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing route' } });
    });
    process.env.WPCONVERT_API_BASE = mock.baseUrl;
    api = loadFreshApi();

    const key = 'wpconvert-cli-33333333-3333-4333-8333-333333333333';
    const body = await api.convertMultipart(Buffer.from('zip'), { projectName: 'p', exportType: 'theme', idempotencyKey: key });
    assert.equal(convertCalls, 2);
    const convertReqs = requests.filter((r) => r.path === '/api/convert');
    assert.equal(convertReqs.length, 2);
    assert.equal(convertReqs[0].headers[IDEM_HEADER], key);
    assert.equal(convertReqs[1].headers[IDEM_HEADER], key);
    assert.equal(body._hadTransportRetry, true);
  });
});

describe('CLI API idempotency response handling', () => {
  let mock;
  let api;
  let prevEnv;

  beforeEach(async () => {
    prevEnv = {
      WPCONVERT_API_KEY: process.env.WPCONVERT_API_KEY,
      WPCONVERT_API_BASE: process.env.WPCONVERT_API_BASE,
    };
    process.env.WPCONVERT_API_KEY = API_KEY;
    mock = await startMockServer((req, res) => {
      if (req.url === '/api/convert' && req.method === 'POST') {
        const mode = req.headers['x-test-mode'];
        if (mode === 'replay-200') {
          return json(res, 200, { jobId: 'job-replay', status: 'queued', idempotent_replay: true });
        }
        if (mode === 'replay-202') {
          return json(res, 202, { jobId: 'job-replay', status: 'queued', idempotent_replay: true });
        }
        if (mode === 'in-progress') {
          return json(res, 409, { error: { code: 'idempotency_request_in_progress', message: 'in progress' } });
        }
        if (mode === 'mismatch') {
          return json(res, 409, { error: { code: 'idempotency_payload_mismatch', message: 'mismatch' } });
        }
        if (mode === 'previous-failed') {
          return json(res, 409, { error: { code: 'idempotency_previous_failed', message: 'failed before' } });
        }
        if (mode === 'invalid-key') {
          return json(res, 400, { error: { code: 'invalid_idempotency_key', message: 'bad key' } });
        }
        return json(res, 200, { jobId: 'job-new', status: 'queued', idempotent_replay: false });
      }
      return json(res, 404, { error: { code: 'not_found', message: 'missing route' } });
    });
    process.env.WPCONVERT_API_BASE = mock.baseUrl;
    api = loadFreshApi();
  });

  afterEach(async () => {
    if (mock) await mock.close();
    process.env.WPCONVERT_API_KEY = prevEnv.WPCONVERT_API_KEY;
    process.env.WPCONVERT_API_BASE = prevEnv.WPCONVERT_API_BASE;
  });

  const key = 'wpconvert-cli-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  async function convertWithMode(mode) {
    const originalFetch = global.fetch;
    global.fetch = async (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      headers.set('X-Test-Mode', mode);
      return originalFetch(input, { ...init, headers });
    };
    try {
      return await api.convertMultipart(Buffer.from('zip'), {
        projectName: 'p',
        exportType: 'theme',
        idempotencyKey: key,
      });
    } finally {
      global.fetch = originalFetch;
    }
  }

  it('accepts HTTP 200 initial success', async () => {
    const body = await convertWithMode('initial');
    assert.equal(body.jobId, 'job-new');
    assert.equal(body.idempotent_replay, false);
  });

  it('accepts HTTP 200 replay', async () => {
    const body = await convertWithMode('replay-200');
    assert.equal(body.jobId, 'job-replay');
    assert.equal(body.idempotent_replay, true);
  });

  it('accepts HTTP 202 replay with job ID', async () => {
    const body = await convertWithMode('replay-202');
    assert.equal(body.jobId, 'job-replay');
    assert.equal(body.idempotent_replay, true);
  });

  it('surfaces idempotency_request_in_progress without auto-resubmit', async () => {
    await assert.rejects(
      () => convertWithMode('in-progress'),
      (err) => err.code === 'idempotency_request_in_progress'
    );
  });

  it('surfaces idempotency_payload_mismatch', async () => {
    await assert.rejects(
      () => convertWithMode('mismatch'),
      (err) => err.code === 'idempotency_payload_mismatch'
    );
  });

  it('surfaces idempotency_previous_failed', async () => {
    await assert.rejects(
      () => convertWithMode('previous-failed'),
      (err) => err.code === 'idempotency_previous_failed'
    );
  });

  it('surfaces invalid_idempotency_key', async () => {
    await assert.rejects(
      () => convertWithMode('invalid-key'),
      (err) => err.code === 'invalid_idempotency_key'
    );
  });
});

describe('security: idempotency key is not leaked', () => {
  it('generateIdempotencyKey output is not written by config helpers', () => {
    const { readFileConfig } = require('../src/config');
    const key = 'wpconvert-cli-99999999-9999-4999-8999-999999999999';
    const cfg = readFileConfig();
    assert.equal(cfg.idempotencyKey, undefined);
    assert.equal(JSON.stringify(cfg).includes(key), false);
  });
});
