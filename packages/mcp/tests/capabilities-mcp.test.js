'use strict';

/**
 * TDD tests for MCP capability projections and structured tool responses.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function sampleQuota(overrides = {}) {
  const conversion = {
    can_start: true,
    mode: 'full',
    consumes: 'subscription_quota',
    reason: 'subscription_quota_available',
    ...overrides.conversion,
  };
  return {
    effectivePlan: overrides.effectivePlan || 'pro',
    current: overrides.current ?? 2,
    max: overrides.max ?? 20,
    remaining: overrides.remaining ?? 18,
    payg_credits: overrides.payg_credits ?? 2,
    conversion_credits: overrides.conversion_credits ?? 0,
    api_conversion_mode: overrides.api_conversion_mode || 'full',
    dev_preview_remaining: overrides.dev_preview_remaining ?? 3,
    dev_preview_limit: overrides.dev_preview_limit ?? 3,
    future_backend_field: 'preserve_me',
    capabilities: {
      conversion,
      usage: {
        plan: overrides.effectivePlan || 'pro',
        subscription: { limit: 20, used: 2, remaining: 18 },
        payg_credits: overrides.payg_credits ?? 2,
        starter_credits: 0,
        free_previews: {
          limit: overrides.dev_preview_limit ?? 3,
          used: 0,
          remaining: overrides.dev_preview_remaining ?? 3,
        },
      },
      outputs: {
        download: {
          available: conversion.mode === 'full' && conversion.can_start,
          reason: conversion.mode === 'preview_only' ? 'download_requires_upgrade' : null,
        },
      },
      recommended_action: overrides.recommended_action || 'convert_full',
      reasons: [conversion.reason],
      ...overrides.capabilitiesExtra,
    },
    ...overrides.top,
  };
}

describe('MCP capabilities helper (pure)', () => {
  it('loads from packages/mcp/src/capabilities.mjs', async () => {
    const mod = await import('../src/capabilities.mjs');
    assert.equal(typeof mod.projectQuotaResponse, 'function');
    assert.equal(typeof mod.projectStatusResponse, 'function');
    assert.equal(typeof mod.buildConversionDenial, 'function');
    assert.equal(typeof mod.recommendedNextForQuota, 'function');
    assert.equal(typeof mod.recommendedNextForStatus, 'function');
  });

  it('preserves complete quota including unknown fields', async () => {
    const { projectQuotaResponse } = await import('../src/capabilities.mjs');
    const quota = sampleQuota();
    const out = projectQuotaResponse(quota);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.quota.future_backend_field, 'preserve_me');
    assert.deepStrictEqual(out.quota.capabilities, quota.capabilities);
    assert.strictEqual(out.capabilities_available, true);
    assert.strictEqual(out.summary.can_start, true);
    assert.strictEqual(out.summary.mode, 'full');
    assert.strictEqual(out.summary.consumes, 'subscription_quota');
    assert.strictEqual(out.summary.download_available, true);
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_convert_folder');
  });

  it('preview-only quota summary and next action', async () => {
    const { projectQuotaResponse } = await import('../src/capabilities.mjs');
    const quota = sampleQuota({
      effectivePlan: 'starter',
      api_conversion_mode: 'preview_only',
      conversion: {
        can_start: true,
        mode: 'preview_only',
        consumes: 'free_preview',
        reason: 'free_preview_available',
      },
      recommended_action: 'convert_preview',
    });
    quota.capabilities.outputs.download = { available: false, reason: 'download_requires_upgrade' };
    const out = projectQuotaResponse(quota);
    assert.strictEqual(out.summary.mode, 'preview_only');
    assert.strictEqual(out.summary.download_available, false);
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_convert_folder');
  });

  it('blocked quota recommends review', async () => {
    const { projectQuotaResponse } = await import('../src/capabilities.mjs');
    const quota = sampleQuota({
      conversion: {
        can_start: false,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_exhausted',
      },
      recommended_action: 'buy_payg_or_wait_renewal',
    });
    quota.capabilities.outputs.download = { available: false, reason: null };
    const out = projectQuotaResponse(quota);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.summary.can_start, false);
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_quota');
  });

  it('missing capabilities legacy fallback', async () => {
    const { projectQuotaResponse } = await import('../src/capabilities.mjs');
    const out = projectQuotaResponse({
      effectivePlan: 'pro',
      current: 1,
      max: 20,
      remaining: 19,
    });
    assert.strictEqual(out.capabilities_available, false);
    assert.strictEqual(out.summary, undefined);
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_convert_folder');
    assert.match(out.recommended_next.reason, /server/i);
  });

  it('buildConversionDenial uses backend reason without inventing entitlement', async () => {
    const { buildConversionDenial } = await import('../src/capabilities.mjs');
    const quota = sampleQuota({
      conversion: {
        can_start: false,
        mode: 'preview_only',
        consumes: 'none',
        reason: 'free_previews_exhausted',
      },
      recommended_action: 'upgrade_or_buy_payg',
    });
    const denial = buildConversionDenial(quota);
    assert.strictEqual(denial.ok, false);
    assert.strictEqual(denial.error.code, 'conversion_not_available');
    assert.strictEqual(denial.error.reason, 'free_previews_exhausted');
    assert.strictEqual(denial.error.recommended_action, 'upgrade_or_buy_payg');
    assert.strictEqual(denial.error.retry_safe, false);
    assert.strictEqual(denial.recommended_next.tool, 'wpconvert_quota');
  });

  it('status processing recommends polling', async () => {
    const { projectStatusResponse } = await import('../src/capabilities.mjs');
    const out = projectStatusResponse({
      jobId: 'job-1',
      project_id: 'job-1',
      status: 'processing',
      progress: 42,
    });
    assert.strictEqual(out.status, 'processing');
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_check_status');
    assert.equal(typeof out.recommended_next.retry_after_seconds, 'number');
  });

  it('status done downloadable recommends download', async () => {
    const { projectStatusResponse } = await import('../src/capabilities.mjs');
    const out = projectStatusResponse({
      jobId: 'job-2',
      project_id: 'job-2',
      status: 'done',
      download_available: true,
      preview_only: false,
    });
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_download_result');
  });

  it('status done preview-only recommends preview not download', async () => {
    const { projectStatusResponse } = await import('../src/capabilities.mjs');
    const out = projectStatusResponse({
      jobId: 'job-3',
      project_id: 'job-3',
      status: 'done',
      preview_only: true,
      conversion_mode: 'preview_only',
      download_available: false,
    });
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_create_preview');
    assert.notStrictEqual(out.recommended_next.tool, 'wpconvert_download_result');
  });

  it('status failed recommends explain_failure', async () => {
    const { projectStatusResponse } = await import('../src/capabilities.mjs');
    const out = projectStatusResponse({
      jobId: 'job-4',
      status: 'failed',
      error: 'boom',
    });
    assert.strictEqual(out.recommended_next.tool, 'wpconvert_explain_failure');
  });

  it('unknown reason codes do not crash', async () => {
    const { projectQuotaResponse } = await import('../src/capabilities.mjs');
    const quota = sampleQuota({
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'some_future_consume',
        reason: 'some_future_reason',
      },
      recommended_action: 'brand_new_action',
    });
    const out = projectQuotaResponse(quota);
    assert.strictEqual(out.summary.reason, 'some_future_reason');
    assert.strictEqual(out.summary.recommended_action, 'brand_new_action');
  });
});

describe('MCP server capability integration', () => {
  const apiPath = require.resolve('wpconvert/src/api');
  const zipPath = require.resolve('wpconvert/src/zip');

  function parseStructured(result) {
    const text = result.content?.[0]?.text || '';
    const idx = text.lastIndexOf('\n\n{');
    if (idx < 0) return { text, data: null };
    return { text, data: JSON.parse(text.slice(idx + 2)) };
  }

  function makeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-mcp-cap-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><body>cap</body></html>');
    return dir;
  }

  function baseApiMock(overrides = {}) {
    const calls = { convertMultipart: [], getQuota: [], getStatus: [], getDownload: [], createPlaygroundSession: [] };
    class ApiError extends Error {
      constructor(message, { code, status, details } = {}) {
        super(message || 'Request failed');
        this.name = 'ApiError';
        this.code = code || 'error';
        this.status = status || 0;
        this.details = details || {};
      }
    }
    return {
      ApiError,
      setRequestExtras() {},
      async convertMultipart(zipBuffer, opts = {}) {
        calls.convertMultipart.push({ zipBuffer, opts });
        if (overrides.convertMultipart) return overrides.convertMultipart(zipBuffer, opts, calls);
        return { jobId: '11111111-1111-4111-8111-111111111111', status: 'queued', idempotent_replay: false };
      },
      async getUploadUrl() {
        throw new Error('not used');
      },
      async putToSignedUrl() {},
      async createJobFromStorage() {
        throw new Error('not used');
      },
      async getStatus(jobId) {
        calls.getStatus.push(jobId);
        return overrides.getStatus ? overrides.getStatus(jobId) : { status: 'queued', jobId };
      },
      async getQuota() {
        calls.getQuota.push({});
        return overrides.getQuota ? overrides.getQuota() : sampleQuota();
      },
      async getDownload() {
        calls.getDownload.push({});
        throw new ApiError('locked', { code: 'upgrade_required', status: 403, details: { preview_only: true } });
      },
      async createPlaygroundSession(jobId) {
        calls.createPlaygroundSession.push(jobId);
        return {
          playground_url: 'https://playground.example/p',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        };
      },
      async fetchBinary() {
        return Buffer.from('zip');
      },
      _calls: calls,
    };
  }

  async function loadServer(apiMock) {
    delete require.cache[apiPath];
    delete require.cache[zipPath];
    require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: apiMock, children: [], paths: [] };
    require(zipPath);
    const serverUrl = new URL('../src/server.mjs', import.meta.url).href;
    return import(`${serverUrl}?t=${Date.now()}-${Math.random()}`);
  }

  it('wpconvert_quota returns structured quota + summary', async () => {
    const apiMock = baseApiMock();
    const server = await loadServer(apiMock);
    const result = await server.handleCall('wpconvert_quota', {});
    const { data } = parseStructured(result);
    assert.ok(data.quota);
    assert.ok(data.quota.capabilities);
    assert.strictEqual(data.capabilities_available, true);
    assert.ok(data.summary);
    assert.ok(data.recommended_next);
    assert.strictEqual(apiMock._calls.getQuota.length, 1);
  });

  it('preflight deny stops before zip and does not generate key', async () => {
    const fixture = makeFixture();
    const apiMock = baseApiMock({
      getQuota: () => sampleQuota({
        conversion: {
          can_start: false,
          mode: 'full',
          consumes: 'none',
          reason: 'subscription_quota_exhausted',
        },
        recommended_action: 'buy_payg_or_wait_renewal',
      }),
    });
    const server = await loadServer(apiMock);
    const result = await server.handleCall('wpconvert_convert_folder', { path: fixture });
    assert.strictEqual(result.isError, true);
    const { data } = parseStructured(result);
    assert.strictEqual(data.error.code, 'conversion_not_available');
    assert.strictEqual(apiMock._calls.getQuota.length, 1);
    assert.strictEqual(apiMock._calls.convertMultipart.length, 0);
    assert.ok(!data.idempotency_key);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('convert success keeps string next_action and adds recommended_next', async () => {
    const fixture = makeFixture();
    const apiMock = baseApiMock();
    const server = await loadServer(apiMock);
    const result = await server.handleCall('wpconvert_convert_folder', { path: fixture });
    const { data } = parseStructured(result);
    assert.equal(typeof data.next_action, 'string');
    assert.ok(data.recommended_next);
    assert.strictEqual(data.recommended_next.tool, 'wpconvert_check_status');
    assert.strictEqual(apiMock._calls.getQuota.length, 1);
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('check_status structured response never recommends download when locked', async () => {
    const apiMock = baseApiMock({
      getStatus: () => ({
        jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        project_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        status: 'done',
        preview_only: true,
        conversion_mode: 'preview_only',
        download_available: false,
      }),
    });
    const server = await loadServer(apiMock);
    const result = await server.handleCall('wpconvert_check_status', { jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    const { data } = parseStructured(result);
    assert.strictEqual(data.recommended_next.tool, 'wpconvert_create_preview');
    assert.notStrictEqual(data.recommended_next.tool, 'wpconvert_download_result');
  });
});

describe('MCP dependency pin', () => {
  it('resolves wpconvert@0.3.1 exactly', () => {
    const pkg = require('wpconvert/package.json');
    assert.strictEqual(pkg.version, '0.3.1');
    const mcpPkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.strictEqual(mcpPkg.dependencies.wpconvert, '0.3.1');
  });
});
