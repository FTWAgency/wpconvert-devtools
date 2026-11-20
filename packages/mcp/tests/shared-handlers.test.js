/**
 * src/shared/ is the part of the MCP server the hosted server reuses
 * (docs/HOSTED_MCP_PLAN.md §2, §7.3): tool definitions and API-only handlers
 * that are handed their API client and account check, and touch no local
 * files, config or environment. The stdio server passes wpconvert/src/api,
 * which reads WPCONVERT_API_KEY or ~/.wpconvert/config.json; the hosted server
 * will pass a client bound to the signed-in user's token.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SHARED_DIR = fileURLToPath(new URL('../src/shared/', import.meta.url));
const JOB = '55555555-5555-4555-8555-555555555555';

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const dataOf = (result) => {
  const text = textOf(result);
  const start = text.indexOf('\n\n{');
  return start === -1 ? null : JSON.parse(text.slice(start + 2));
};

class ApiError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status || 0;
    this.details = details || {};
  }
}

/** A client with only `methods`; reaching for anything else fails the test. */
function strictApi(methods) {
  const calls = [];
  const api = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      if (!Object.hasOwn(methods, prop)) throw new Error(`a shared handler used api.${String(prop)}`);
      return async (...args) => {
        calls.push([prop, ...args]);
        return methods[prop](...args);
      };
    },
  });
  return { api, calls };
}

describe('shared module boundary', () => {
  const files = fs.readdirSync(SHARED_DIR).filter((f) => f.endsWith('.mjs')).sort();

  it('holds the tool definitions, handlers and result shaping', () => {
    for (const file of ['tools.mjs', 'handlers.mjs', 'capabilities.mjs', 'result.mjs']) assert.ok(files.includes(file), file);
  });

  it('imports only other shared modules and pure CLI helpers, and never reads the environment', () => {
    const allowed = new Set(['module', 'wpconvert/src/capabilities', 'wpconvert/src/purchase']);
    for (const file of files) {
      const source = fs.readFileSync(path.join(SHARED_DIR, file), 'utf8');
      const specs = [
        ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
        ...[...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ];
      for (const spec of specs) {
        if (spec.startsWith('.')) {
          assert.ok(path.resolve(SHARED_DIR, spec).startsWith(SHARED_DIR), `${file} imports ${spec} from outside src/shared`);
        } else {
          assert.ok(allowed.has(spec), `${file} imports ${spec}`);
        }
      }
      assert.doesNotMatch(source, /\bprocess\./, `${file} reads process state`);
    }
  });
});

describe('shared handlers', async () => {
  const { createSharedHandlers, describeApiError } = await import('../src/shared/handlers.mjs');
  const { SHARED_TOOLS } = await import('../src/shared/tools.mjs');

  it('answer every shared tool definition, and nothing else', async () => {
    const { api } = strictApi({
      getStatus: async () => ({ jobId: JOB, status: 'done' }),
      createPlaygroundSession: async () => ({ playground_url: 'https://playground.example/p' }),
      getQuota: async () => ({ effectivePlan: 'pro', current: 1, max: 20, remaining: 19 }),
      getCheckoutOptions: async () => ({ currency: 'usd', options: [] }),
      createCheckout: async () => ({ checkout_url: 'https://checkout.example/c' }),
    });
    const shared = createSharedHandlers({ api, hasAccount: () => true });
    const args = { jobId: JOB, kind: 'payg', packSize: 5 };
    assert.deepStrictEqual(SHARED_TOOLS.map((t) => t.name), [
      'wpconvert_check_status',
      'wpconvert_create_preview',
      'wpconvert_explain_failure',
      'wpconvert_quota',
      'wpconvert_plans',
      'wpconvert_checkout',
    ]);
    for (const tool of SHARED_TOOLS) {
      const result = await shared.handleSharedCall(tool.name, args);
      assert.ok(result && Array.isArray(result.content), tool.name);
    }
    for (const local of ['wpconvert_convert_folder', 'wpconvert_download_result', 'wpconvert_connect', 'wpconvert_connect_status']) {
      assert.strictEqual(await shared.handleSharedCall(local, args), null, local);
    }
  });

  it('send each request through the injected client only', async () => {
    const { api, calls } = strictApi({
      getStatus: async () => ({ jobId: JOB, status: 'done', download_available: true }),
      createPlaygroundSession: async () => ({ playground_url: 'https://playground.example/p', expires_at: '2099-01-01T00:00:00Z' }),
      getQuota: async () => ({ effectivePlan: 'pro', current: 1, max: 20, remaining: 19 }),
      getCheckoutOptions: async () => ({ currency: 'usd', options: [] }),
      createCheckout: async () => ({ checkout_url: 'https://checkout.example/c', claimed: [JOB] }),
    });
    const shared = createSharedHandlers({ api, hasAccount: () => true });

    assert.match(textOf(await shared.checkStatus({ jobId: JOB })), /^status=done/);
    assert.strictEqual(dataOf(await shared.createPreview({ jobId: JOB })).playground_url, 'https://playground.example/p');
    assert.match(textOf(await shared.explainFailure({ jobId: JOB })), /not failed/);
    assert.strictEqual(dataOf(await shared.quota()).quota.effectivePlan, 'pro');
    assert.strictEqual(dataOf(await shared.plans({ jobId: JOB })).personalized, true);
    const bought = await shared.checkout({ kind: 'starter', jobId: JOB, promo: 'dropped' });
    assert.strictEqual(dataOf(bought).checkout_url, 'https://checkout.example/c');

    assert.deepStrictEqual(calls, [
      ['getStatus', JOB],
      ['getStatus', JOB],
      ['createPlaygroundSession', JOB],
      ['getStatus', JOB],
      ['getQuota'],
      ['getCheckoutOptions', JOB],
      ['createCheckout', { kind: 'starter', jobId: JOB }],
    ]);
  });

  it('ask the injected account check, per call, before buying', async () => {
    let signedIn = false;
    const { api, calls } = strictApi({
      getCatalog: async () => ({ currency: 'usd', price_source: 'stripe', options: [] }),
      getCheckoutOptions: async () => ({ currency: 'usd', options: [] }),
      createCheckout: async () => ({ checkout_url: 'https://checkout.example/c' }),
    });
    const shared = createSharedHandlers({ api, hasAccount: () => signedIn });

    assert.strictEqual(dataOf(await shared.plans({})).personalized, false);
    const refused = await shared.checkout({ kind: 'payg', packSize: 5 });
    assert.strictEqual(refused.isError, true);
    assert.strictEqual(dataOf(refused).error.code, 'missing_credentials');

    signedIn = true;
    assert.strictEqual(dataOf(await shared.plans({})).personalized, true);
    assert.ok(!(await shared.checkout({ kind: 'payg', packSize: 5 })).isError);
    assert.deepStrictEqual(calls.map(([method]) => method), ['getCatalog', 'getCheckoutOptions', 'createCheckout']);
  });

  it('keep separate clients apart, as a hosted server needs one per signed-in user', async () => {
    const forUser = (user) => strictApi({ getStatus: async () => ({ jobId: JOB, status: 'queued', progress: user === 'a' ? 10 : 90 }) });
    const a = forUser('a');
    const b = forUser('b');
    const sharedA = createSharedHandlers({ api: a.api, hasAccount: () => true });
    const sharedB = createSharedHandlers({ api: b.api, hasAccount: () => true });
    assert.strictEqual(dataOf(await sharedB.checkStatus({ jobId: JOB })).progress, 90);
    assert.strictEqual(dataOf(await sharedA.checkStatus({ jobId: JOB })).progress, 10);
    assert.strictEqual(a.calls.length, 1);
    assert.strictEqual(b.calls.length, 1);
  });

  it('download: ask the API, then hand a ready download to the caller to deliver', async () => {
    const delivered = [];
    const deliver = async (info) => {
      delivered.push(info);
      return { content: [{ type: 'text', text: `link ${info.download_url}` }] };
    };
    const answers = {
      ready: async () => ({ download_url: 'https://storage.example/signed', name: 'theme.zip' }),
      notReady: async () => ({ name: 'theme.zip' }),
      locked: async () => { throw new ApiError('locked', { code: 'upgrade_required', status: 403, details: { preview_only: true } }); },
      missing: async () => { throw new ApiError('gone', { code: 'not_found', status: 404 }); },
    };
    const run = async (answer, options = {}) => {
      const { api } = strictApi({ getDownload: answers[answer] });
      return createSharedHandlers({ api, hasAccount: () => true }).downloadResult(JOB, { deliver, ...options });
    };

    assert.strictEqual(textOf(await run('ready')), 'link https://storage.example/signed');
    assert.deepStrictEqual(delivered, [{ download_url: 'https://storage.example/signed', name: 'theme.zip' }]);

    const notReady = await run('notReady');
    assert.strictEqual(dataOf(notReady).error.code, 'conversion_not_ready');
    const locked = await run('locked');
    assert.strictEqual(dataOf(locked).error.code, 'upgrade_required');
    assert.strictEqual(dataOf(locked).recommended_next.tool, 'wpconvert_quota');
    await assert.rejects(run('missing'), (e) => e.code === 'not_found');
    const claimed = await run('missing', { onError: (e) => (e.status === 404 ? { content: [{ type: 'text', text: 'claimed' }] } : null) });
    assert.strictEqual(textOf(claimed), 'claimed');
    assert.strictEqual(delivered.length, 1);
  });

  it('word API errors without naming local-only tools or settings', () => {
    const codes = [
      'already_subscribed', 'insufficient_credits', 'quota_exceeded', 'upgrade_required', 'too_many_active_jobs',
      'rate_limited', 'conversion_not_ready', 'theme_expired', 'theme_too_large_for_preview',
    ];
    for (const code of codes) {
      const text = describeApiError({ name: 'ApiError', code, details: {} });
      assert.ok(text, code);
      assert.doesNotMatch(text, /wpconvert_connect|convert_folder|WPCONVERT_API_KEY|idempotency/, code);
    }
    assert.strictEqual(describeApiError({ name: 'ApiError', code: 'brand_new', message: 'From the server.' }), 'From the server.');
    assert.strictEqual(describeApiError(null), 'Request failed.');
  });
});
