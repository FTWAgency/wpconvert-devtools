'use strict';

/**
 * MCP convert_folder idempotency tests.
 * Exercises the real registered tool handler with mocked shared API methods.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const apiPath = require.resolve('wpconvert/src/api');
const zipPath = require.resolve('wpconvert/src/zip');
const idemPath = require.resolve('wpconvert/src/idempotency');

const { MCP_KEY_PREFIX, MAX_KEY_LENGTH } = require(idemPath);

function parseStructured(result) {
  const text = result.content?.[0]?.text || '';
  const idx = text.lastIndexOf('\n\n{');
  if (idx < 0) {
    // try last JSON object
    const brace = text.lastIndexOf('{');
    if (brace < 0) return { text, data: null };
    try {
      return { text, data: JSON.parse(text.slice(brace)) };
    } catch {
      return { text, data: null };
    }
  }
  try {
    return { text, data: JSON.parse(text.slice(idx + 2)) };
  } catch {
    return { text, data: null };
  }
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-mcp-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><body>mcp-test</body></html>');
  return dir;
}

function baseApiMock(overrides = {}) {
  const calls = {
    convertMultipart: [],
    getUploadUrl: [],
    putToSignedUrl: [],
    createJobFromStorage: [],
    getStatus: [],
    getQuota: [],
    setRequestExtras: [],
  };

  class ApiError extends Error {
    constructor(message, { code, status, details } = {}) {
      super(message || 'Request failed');
      this.name = 'ApiError';
      this.code = code || 'error';
      this.status = status || 0;
      this.details = details || {};
    }
  }

  const apiMock = {
    ApiError,
    setRequestExtras(extras) {
      calls.setRequestExtras.push(extras);
    },
    async convertMultipart(zipBuffer, opts = {}) {
      calls.convertMultipart.push({ zipBuffer, opts });
      if (overrides.convertMultipart) return overrides.convertMultipart(zipBuffer, opts, calls);
      return {
        jobId: '11111111-1111-4111-8111-111111111111',
        status: 'queued',
        idempotent_replay: false,
      };
    },
    async getUploadUrl() {
      calls.getUploadUrl.push({});
      if (overrides.getUploadUrl) return overrides.getUploadUrl(calls);
      return {
        jobId: '22222222-2222-4222-8222-222222222222',
        signedUrl: 'https://example.test/signed',
        maxSizeMB: 100,
        plan: 'starter',
      };
    },
    async putToSignedUrl(signedUrl, zipBuffer) {
      calls.putToSignedUrl.push({ signedUrl, size: zipBuffer?.length });
      if (overrides.putToSignedUrl) return overrides.putToSignedUrl(signedUrl, zipBuffer, calls);
    },
    async createJobFromStorage(jobId, opts = {}) {
      calls.createJobFromStorage.push({ jobId, opts });
      if (overrides.createJobFromStorage) return overrides.createJobFromStorage(jobId, opts, calls);
      return {
        jobId,
        status: 'queued',
        idempotent_replay: false,
      };
    },
    async getStatus(jobId) {
      calls.getStatus.push(jobId);
      return overrides.getStatus
        ? overrides.getStatus(jobId)
        : { status: 'queued', progress: 0, jobId };
    },
    async getQuota() {
      calls.getQuota.push({});
      return { effectivePlan: 'starter', current: 0, max: 3, remaining: 3 };
    },
    async getDownload() {
      throw new Error('not used');
    },
    async createPlaygroundSession() {
      throw new Error('not used');
    },
    async fetchBinary() {
      throw new Error('not used');
    },
    _calls: calls,
  };

  return apiMock;
}

const realZip = require(zipPath);

async function loadServer({ apiMock, largeZip = false } = {}) {
  delete require.cache[apiPath];
  delete require.cache[zipPath];

  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: apiMock,
    children: [],
    paths: [],
  };

  if (largeZip) {
    require.cache[zipPath] = {
      id: zipPath,
      filename: zipPath,
      loaded: true,
      exports: {
        ...realZip,
        buildZipBuffer() {
          // >50MB to exercise storage path without writing huge fixtures
          return Buffer.alloc(51 * 1024 * 1024, 1);
        },
      },
      children: [],
      paths: [],
    };
  } else {
    // Ensure real zip module is loaded normally
    require(zipPath);
  }

  const serverUrl = new URL('../src/server.mjs', import.meta.url).href;
  return import(`${serverUrl}?t=${Date.now()}-${Math.random()}`);
}

describe('MCP convert_folder idempotency', () => {
  let fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    delete require.cache[apiPath];
    delete require.cache[zipPath];
  });

  it('schema accepts omitted idempotency_key and generates mcp-prefixed UUID', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    const tool = server.TOOLS.find((t) => t.name === 'wpconvert_convert_folder');
    assert.ok(tool.inputSchema.properties.idempotency_key);
    assert.equal(tool.inputSchema.properties.idempotency_key.maxLength, MAX_KEY_LENGTH);
    assert.ok(!tool.inputSchema.required.includes('idempotency_key'));

    const result = await server.handleCall('wpconvert_convert_folder', { path: fixture });
    assert.equal(result.isError, undefined);
    const { data } = parseStructured(result);
    assert.ok(data.idempotency_key.startsWith(MCP_KEY_PREFIX));
    assert.equal(data.idempotent_replay, false);
    assert.equal(data.job_id, '11111111-1111-4111-8111-111111111111');
    assert.match(data.next_action, /wpconvert_check_status/);
    assert.equal(apiMock._calls.convertMultipart[0].opts.idempotencyKey, data.idempotency_key);
  });

  it('uses caller-provided valid key unchanged', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    const { data } = parseStructured(result);
    assert.equal(data.idempotency_key, key);
    assert.equal(apiMock._calls.convertMultipart[0].opts.idempotencyKey, key);
  });

  it('rejects invalid or overlong keys before submission', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });

    const bad = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: 'not-a-valid-key',
    });
    assert.equal(bad.isError, true);
    assert.equal(apiMock._calls.convertMultipart.length, 0);
    const { data: badData } = parseStructured(bad);
    assert.equal(badData.error.code, 'invalid_idempotency_key');

    const overlong = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: `${MCP_KEY_PREFIX}${'a'.repeat(200)}`,
    });
    assert.equal(overlong.isError, true);
    assert.equal(apiMock._calls.convertMultipart.length, 0);
  });

  it('two separate new conversion calls generate different keys', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    const a = parseStructured(await server.handleCall('wpconvert_convert_folder', { path: fixture })).data;
    const b = parseStructured(await server.handleCall('wpconvert_convert_folder', { path: fixture })).data;
    assert.notStrictEqual(a.idempotency_key, b.idempotency_key);
  });

  it('retry as a separate tool call sends the identical key', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    const first = parseStructured(await server.handleCall('wpconvert_convert_folder', { path: fixture })).data;
    const second = parseStructured(
      await server.handleCall('wpconvert_convert_folder', {
        path: fixture,
        idempotency_key: first.idempotency_key,
      })
    ).data;
    assert.equal(second.idempotency_key, first.idempotency_key);
    assert.equal(apiMock._calls.convertMultipart[1].opts.idempotencyKey, first.idempotency_key);
  });

  it('HTTP 200 replay returns original job with replay true', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => ({
        jobId: '33333333-3333-4333-8333-333333333333',
        status: 'queued',
        idempotent_replay: true,
        project_id: '33333333-3333-4333-8333-333333333333',
      }),
    });
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    const { data, text } = parseStructured(result);
    assert.equal(data.idempotent_replay, true);
    assert.equal(data.job_id, '33333333-3333-4333-8333-333333333333');
    assert.equal(data.idempotency_key, key);
    assert.match(data.next_action, /existing job/i);
    assert.match(text, /Recovered existing/i);
  });

  it('HTTP 202-style replay body is treated as success with replay true', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => ({
        jobId: '44444444-4444-4444-8444-444444444444',
        status: 'queued',
        idempotent_replay: true,
      }),
    });
    const server = await loadServer({ apiMock });
    const { data } = parseStructured(
      await server.handleCall('wpconvert_convert_folder', { path: fixture })
    );
    assert.equal(data.idempotent_replay, true);
    assert.equal(data.job_id, '44444444-4444-4444-8444-444444444444');
  });

  it('storage flow: only from-storage receives the key', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock, largeZip: true });
    const key = `${MCP_KEY_PREFIX}cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    assert.equal(result.isError, undefined);
    assert.equal(apiMock._calls.convertMultipart.length, 0);
    assert.equal(apiMock._calls.getUploadUrl.length, 1);
    assert.equal(apiMock._calls.putToSignedUrl.length, 1);
    assert.equal(apiMock._calls.createJobFromStorage.length, 1);
    assert.equal(apiMock._calls.createJobFromStorage[0].opts.idempotencyKey, key);
    assert.deepEqual(apiMock._calls.getUploadUrl[0], {});
  });

  it('idempotency_request_in_progress returns isError with reuse guidance', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => {
        throw new apiMock.ApiError('in progress', {
          code: 'idempotency_request_in_progress',
          status: 409,
        });
      },
    });
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}dddddddd-dddd-4ddd-8ddd-dddddddddddd`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    assert.equal(result.isError, true);
    const { data, text } = parseStructured(result);
    assert.equal(data.error.code, 'idempotency_request_in_progress');
    assert.equal(data.error.reuse_idempotency_key, true);
    assert.equal(data.error.retry_safe, true);
    assert.equal(data.idempotency_key, key);
    assert.match(text, /exact same idempotency_key/i);
    assert.equal(apiMock._calls.convertMultipart.length, 1);
  });

  it('ambiguous transport failure returns same key and recovery guidance', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => {
        throw new apiMock.ApiError('fetch failed', {
          code: 'network_error',
          status: 0,
          details: { hadTransportRetry: true },
        });
      },
    });
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    assert.equal(result.isError, true);
    const { data } = parseStructured(result);
    assert.equal(data.error.code, 'network_error');
    assert.equal(data.error.reuse_idempotency_key, true);
    assert.equal(data.idempotency_key, key);
    assert.equal(apiMock._calls.convertMultipart.length, 1);
  });

  it('payload mismatch does not recommend reusing the key', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => {
        throw new apiMock.ApiError('mismatch', {
          code: 'idempotency_payload_mismatch',
          status: 409,
        });
      },
    });
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}ffffffff-ffff-4fff-8fff-ffffffffffff`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    assert.equal(result.isError, true);
    const { data } = parseStructured(result);
    assert.equal(data.error.code, 'idempotency_payload_mismatch');
    assert.equal(data.error.reuse_idempotency_key, false);
    assert.equal(data.idempotency_key, key);
  });

  it('previous_failed explains a new intentional conversion needs a new key', async () => {
    const apiMock = baseApiMock({
      convertMultipart: async () => {
        throw new apiMock.ApiError('failed before', {
          code: 'idempotency_previous_failed',
          status: 409,
        });
      },
    });
    const server = await loadServer({ apiMock });
    const key = `${MCP_KEY_PREFIX}12121212-1212-4121-8121-121212121212`;
    const result = await server.handleCall('wpconvert_convert_folder', {
      path: fixture,
      idempotency_key: key,
    });
    const { data, text } = parseStructured(result);
    assert.equal(result.isError, true);
    assert.equal(data.error.code, 'idempotency_previous_failed');
    assert.equal(data.error.reuse_idempotency_key, false);
    assert.match(text, /without that key/i);
  });

  it('API key never appears in tool results; status tool omits idempotency key', async () => {
    process.env.WPCONVERT_API_KEY = 'wpc_live_SHOULD_NOT_LEAK_IN_OUTPUT';
    const apiMock = baseApiMock({
      convertMultipart: async () => {
        throw new apiMock.ApiError('bad key wpc_live_SHOULD_NOT_LEAK_IN_OUTPUT', {
          code: 'invalid_api_key',
          status: 401,
        });
      },
      getStatus: async () => ({ status: 'queued', progress: 10, jobId: 'j1' }),
    });
    const server = await loadServer({ apiMock });
    const convertFail = await server.handleCall('wpconvert_convert_folder', { path: fixture });
    assert.equal(String(convertFail.content[0].text).includes('wpc_live_SHOULD_NOT_LEAK'), false);

    const status = await server.handleCall('wpconvert_check_status', { jobId: 'j1' });
    assert.equal(status.content[0].text.includes('idempotency'), false);
    assert.equal(status.content[0].text.includes('wpc_live_'), false);
  });

  it('sets X-WPConvert-Tool via setRequestExtras and leaves check_status unchanged', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    await server.handleCall('wpconvert_convert_folder', { path: fixture });
    await server.handleCall('wpconvert_check_status', { jobId: 'j1' });
    assert.deepEqual(apiMock._calls.setRequestExtras[0], { tool: 'wpconvert_convert_folder' });
    assert.deepEqual(apiMock._calls.setRequestExtras[1], { tool: 'wpconvert_check_status' });
    assert.equal(apiMock._calls.getStatus[0], 'j1');
  });

  it('explain_failure distinguishes status retry vs new conversion', async () => {
    const apiMock = baseApiMock({
      getStatus: async () => ({ status: 'failed', error: 'worker boom', jobId: 'j1' }),
    });
    const server = await loadServer({ apiMock });
    const result = await server.handleCall('wpconvert_explain_failure', { jobId: 'j1' });
    assert.match(result.content[0].text, /without the previous idempotency_key/i);
  });
});

describe('MCP resolveIdempotencyKey helper', () => {
  it('generates distinct mcp keys and validates caller keys', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer({ apiMock });
    const a = server.resolveIdempotencyKey({});
    const b = server.resolveIdempotencyKey({});
    assert.ok(a.key.startsWith(MCP_KEY_PREFIX));
    assert.notStrictEqual(a.key, b.key);
    const provided = `${MCP_KEY_PREFIX}99999999-9999-4999-8999-999999999999`;
    assert.equal(server.resolveIdempotencyKey({ idempotency_key: provided }).key, provided);
  });
});
