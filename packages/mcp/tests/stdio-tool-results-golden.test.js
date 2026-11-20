/**
 * Every result of the stdio server's API-backed tools, locked
 * (docs/HOSTED_MCP_PLAN.md §7.3).
 *
 * Status, preview, explain-failure, quota, plans, checkout and the API half of
 * download are shared with the hosted server. This runs the real server over
 * stdio against a scripted API and records, per scenario, the tool result and
 * the API requests behind it (route, which credential was sent, tool header,
 * body), plus the text of each API error code. The golden file was recorded
 * before the shared split; the split must leave it byte-identical.
 */

import { describe, it, before, after } from 'node:test';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { startStdioServer } from './helpers/stdio-session.js';
import { assertMatchesGolden } from './helpers/golden.js';
import { renderApiError } from '../src/server.mjs';

const GOLDEN = fileURLToPath(new URL('./fixtures/stdio-tool-results.golden.json', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const JOB = '44444444-4444-4444-8444-444444444444';
const KEY = `wpc_live_${'K'.repeat(40)}`;
const GUEST = {
  token: `wpcg_${'G'.repeat(43)}`,
  convertUntil: '2099-01-01T00:00:00Z',
  claimUntil: '2099-01-08T00:00:00Z',
  remaining: 2,
};
const ACCOUNTS = {
  key: { apiKey: KEY },
  key_and_guest: { apiKey: KEY, guest: GUEST },
  guest: { guest: GUEST },
  guest_window_ended: { guest: { ...GUEST, convertUntil: '2020-01-01T00:00:00Z' } },
  none: {},
};

const QUOTA = {
  effectivePlan: 'pro',
  current: 2,
  max: 20,
  remaining: 18,
  payg_credits: 1,
  conversion_credits: 0,
  api_conversion_mode: 'full',
  dev_preview_remaining: 3,
  dev_preview_limit: 3,
  capabilities: {
    conversion: { can_start: true, mode: 'full', consumes: 'subscription_quota', reason: 'subscription_quota_available' },
    usage: {
      plan: 'pro',
      subscription: { limit: 20, used: 2, remaining: 18 },
      payg_credits: 1,
      starter_credits: 0,
      free_previews: { limit: 3, used: 0, remaining: 3 },
    },
    outputs: { download: { available: true, reason: null } },
    recommended_action: 'convert_full',
    reasons: ['subscription_quota_available'],
  },
};
const BLOCKED_QUOTA = {
  ...QUOTA,
  remaining: 0,
  payg_credits: 0,
  capabilities: {
    ...QUOTA.capabilities,
    conversion: { can_start: false, mode: 'full', consumes: 'none', reason: 'subscription_quota_exhausted' },
    outputs: { download: { available: false, reason: null } },
    recommended_action: 'buy_payg_or_wait_renewal',
    reasons: ['subscription_quota_exhausted'],
  },
};

const CATALOG_OPTIONS = [
  { kind: 'starter', name: 'Starter', billing: 'one_time', summary: 'Unlock and download this one theme.', features: ['Standard WordPress theme export (.zip)'], price_cents: 1900, pro_delta_cents: 600 },
  { kind: 'pro', name: 'Pro', billing: 'subscription', summary: 'Monthly plan.', features: ['20 conversions per month'], price_cents: { month: 4900, year: 49000 }, starter_credit_cents: 1900 },
  { kind: 'agency', name: 'Agency', billing: 'subscription', summary: 'Teams.', features: ['Unlimited conversions'], price_cents: { month: 24900, year: 249000 } },
  { kind: 'payg', name: 'Pay-as-you-go credits', billing: 'one_time', summary: 'Credits.', features: ['No expiry.'], packs: [{ size: 1, price_cents: 2500 }, { size: 5, price_cents: 9900 }] },
];
const CLI_OPTIONS = {
  currency: 'usd',
  trial_available: false,
  existing_subscriber: false,
  job: null,
  options: [
    { ...CATALOG_OPTIONS[0], available: false, today_cents: 1900, pro_delta_available: false },
    { ...CATALOG_OPTIONS[1], action: 'checkout', starter_credit_applies: true, today_cents: { month: 3000, year: 49000 } },
    { ...CATALOG_OPTIONS[2], action: 'checkout', today_cents: { month: 24900, year: 249000 } },
    { ...CATALOG_OPTIONS[3], available: true },
  ],
};

const status = (body) => ({ [`GET /api/convert/${JOB}/status`]: [200, { jobId: JOB, project_id: JOB, ...body }] });
const guestStatus = (body) => ({ [`GET /api/convert/cli-guest/${JOB}/status`]: [200, { jobId: JOB, ...body }] });
const apiError = (code, message, extra = {}) => ({ error: { code, message, ...extra } });

const SCENARIOS = [
  { name: 'check_status: queued with progress', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: status({ status: 'queued', progress: 5 }) },
  { name: 'check_status: done, downloadable, preview available', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: status({ status: 'done', progress: 100, preview_only: false, conversion_mode: 'full', download_available: true, preview_available: true }) },
  { name: 'check_status: done, preview only', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: status({ status: 'done', progress: 100, preview_only: true, conversion_mode: 'preview_only', download_available: false, preview_available: true }) },
  { name: 'check_status: failed', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: status({ status: 'failed', error: 'Build step crashed.' }) },
  { name: 'check_status: guest preview done', account: 'guest', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: guestStatus({ status: 'done', progress: 100, download_available: false, preview_available: true, remaining_previews: 1, convert_until: GUEST.convertUntil, claim_until: GUEST.claimUntil }) },
  { name: 'check_status: rate limited', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: { [`GET /api/convert/${JOB}/status`]: [429, apiError('rate_limited', 'Slow down.', { retry_after: 30 })] } },
  { name: 'check_status: revoked key', account: 'key', tool: 'wpconvert_check_status', args: { jobId: JOB },
    routes: { [`GET /api/convert/${JOB}/status`]: [401, apiError('invalid_api_key', 'Key revoked.')] } },

  { name: 'create_preview: job failed', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: status({ status: 'failed', error: 'Build step crashed.' }) },
  { name: 'create_preview: job failed without a reason', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: status({ status: 'failed' }) },
  { name: 'create_preview: not ready', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: status({ status: 'rendering', progress: 60 }) },
  { name: 'create_preview: ready, with expiry and warning', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: { ...status({ status: 'done' }), 'POST /api/playground/sessions': [200, { playground_url: 'https://playground.wordpress.net/#golden', expires_at: '2099-01-01T00:10:00Z', session_id: 's1', warning: 'Large theme: the first load is slow.' }] } },
  { name: 'create_preview: ready, no expiry', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: { ...status({ status: 'done' }), 'POST /api/playground/sessions': [200, { playground_url: 'https://playground.wordpress.net/#golden' }] } },
  { name: 'create_preview: guest', account: 'guest', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: { ...guestStatus({ status: 'done', remaining_previews: 1 }), 'POST /api/playground/cli-guest': [200, { playground_url: 'https://playground.wordpress.net/#guest', expires_at: '2099-01-01T00:10:00Z' }] } },
  { name: 'create_preview: theme expired', account: 'key', tool: 'wpconvert_create_preview', args: { jobId: JOB },
    routes: { ...status({ status: 'done' }), 'POST /api/playground/sessions': [410, apiError('theme_expired', 'Expired.')] } },

  { name: 'explain_failure: not failed', account: 'key', tool: 'wpconvert_explain_failure', args: { jobId: JOB },
    routes: status({ status: 'building' }) },
  { name: 'explain_failure: failed with a reason', account: 'key', tool: 'wpconvert_explain_failure', args: { jobId: JOB },
    routes: status({ status: 'failed', error: 'Build step crashed.' }) },
  { name: 'explain_failure: failed without a reason', account: 'key', tool: 'wpconvert_explain_failure', args: { jobId: JOB },
    routes: status({ status: 'failed' }) },

  { name: 'quota: account', account: 'key', tool: 'wpconvert_quota', args: {},
    routes: { 'GET /api/convert/quota': [200, QUOTA] } },
  { name: 'quota: account, conversions blocked', account: 'key', tool: 'wpconvert_quota', args: {},
    routes: { 'GET /api/convert/quota': [200, BLOCKED_QUOTA] } },
  { name: 'quota: account, no capabilities (older API)', account: 'key', tool: 'wpconvert_quota', args: {},
    routes: { 'GET /api/convert/quota': [200, { effectivePlan: 'pro', current: 1, max: 20, remaining: 19 }] } },
  { name: 'quota: guest with previews left', account: 'guest', tool: 'wpconvert_quota', args: {}, routes: {} },
  { name: 'quota: guest whose convert window ended', account: 'guest_window_ended', tool: 'wpconvert_quota', args: {}, routes: {} },
  { name: 'quota: not connected', account: 'none', tool: 'wpconvert_quota', args: {}, routes: {} },

  { name: 'plans: not signed in', account: 'none', tool: 'wpconvert_plans', args: {},
    routes: { 'GET /api/billing/catalog': [200, { currency: 'usd', price_source: 'published', trial_available: false, options: CATALOG_OPTIONS }] } },
  { name: 'plans: not signed in, for a job', account: 'guest', tool: 'wpconvert_plans', args: { jobId: JOB },
    routes: { 'GET /api/billing/catalog': [200, { currency: 'usd', price_source: 'stripe', trial_available: false, options: CATALOG_OPTIONS }] } },
  { name: 'plans: signed in', account: 'key', tool: 'wpconvert_plans', args: {},
    routes: { 'GET /api/billing/cli-options': [200, CLI_OPTIONS] } },
  { name: 'plans: signed in subscriber, job that cannot be unlocked', account: 'key_and_guest', tool: 'wpconvert_plans', args: { jobId: JOB },
    routes: { [`GET /api/billing/cli-options?jobId=${JOB}`]: [200, { ...CLI_OPTIONS, existing_subscriber: true, job: { id: JOB, unlockable: false, reason: 'converted before Starter existed' } }] } },
  { name: 'plans: invalid jobId', account: 'key', tool: 'wpconvert_plans', args: { jobId: 'not-a-job' }, routes: {} },

  { name: 'checkout: invalid kind', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'trial' }, routes: {} },
  { name: 'checkout: starter without a jobId', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'starter' }, routes: {} },
  { name: 'checkout: payg with an unknown pack', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'payg', packSize: 7 }, routes: {} },
  { name: 'checkout: not signed in', account: 'none', tool: 'wpconvert_checkout', args: { kind: 'payg', packSize: 5 }, routes: {} },
  { name: 'checkout: starter for a job', account: 'key_and_guest', tool: 'wpconvert_checkout', args: { kind: 'starter', jobId: JOB, promo: 'IGNORED' },
    routes: { 'POST /api/billing/cli-checkout': [200, { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_golden', session_id: 'cs_test_golden', claimed: [JOB] }] } },
  { name: 'checkout: payg pack', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'payg', packSize: 5 },
    routes: { 'POST /api/billing/cli-checkout': [200, { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_payg' }] } },
  { name: 'checkout: subscriber is sent to the billing portal', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'agency', interval: 'year' },
    routes: { 'POST /api/billing/cli-checkout': [200, { portal_url: 'https://billing.stripe.com/p/session/test_golden', message: 'This account already has a Pro subscription.' }] } },
  { name: 'checkout: already subscribed', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'pro', interval: 'month' },
    routes: { 'POST /api/billing/cli-checkout': [409, apiError('already_subscribed', 'Already subscribed to Pro.', { portal_url: 'https://billing.stripe.com/p/session/test_golden' })] } },
  { name: 'checkout: server error', account: 'key', tool: 'wpconvert_checkout', args: { kind: 'pro', interval: 'month' },
    routes: { 'POST /api/billing/cli-checkout': [500, apiError('server_error', 'Stripe is unavailable.')] } },

  { name: 'download: guest session without a key', account: 'guest', tool: 'wpconvert_download_result', args: { jobId: JOB }, routes: {} },
  { name: 'download: not ready', account: 'key', tool: 'wpconvert_download_result', args: { jobId: JOB },
    routes: { [`GET /api/download/${JOB}`]: [200, { name: 'acme-theme.zip' }] } },
  { name: 'download: locked to previews', account: 'key', tool: 'wpconvert_download_result', args: { jobId: JOB },
    routes: { [`GET /api/download/${JOB}`]: [403, apiError('upgrade_required', 'Download locked.', { preview_only: true, reason: 'preview_only_job' })] } },
  { name: 'download: unbought guest job seen with a key', account: 'key_and_guest', tool: 'wpconvert_download_result', args: { jobId: JOB },
    routes: { [`GET /api/download/${JOB}`]: [404, apiError('not_found', 'No such conversion.')] } },
  { name: 'download: saved to disk', account: 'key', tool: 'wpconvert_download_result', args: { jobId: JOB, outDir: '<home>/downloads' },
    routes: { [`GET /api/download/${JOB}`]: [200, { download_url: '<api>/files/acme-theme.zip', name: 'acme-theme.zip' }], 'GET /files/acme-theme.zip': [200, Buffer.from('PK golden theme bytes')] } },
  { name: 'download: saved under the job id when unnamed', account: 'key', tool: 'wpconvert_download_result', args: { jobId: JOB, outDir: '<home>/downloads' },
    routes: { [`GET /api/download/${JOB}`]: [200, { download_url: '<api>/files/theme.zip' }], 'GET /files/theme.zip': [200, Buffer.from('PK')] } },
  { name: 'download: storage fetch fails', account: 'key', tool: 'wpconvert_download_result', args: { jobId: JOB, outDir: '<home>/downloads' },
    routes: { [`GET /api/download/${JOB}`]: [200, { download_url: '<api>/files/missing.zip', name: 'missing.zip' }] } },
];

const ERROR_CASES = [
  { code: 'missing_credentials' },
  { code: 'guest_previews_used', message: 'All free previews are used.' },
  { code: 'guest_token_expired' },
  { code: 'guest_capacity', message: 'Guest previews are busy.' },
  { code: 'guest_token_invalid' },
  { code: 'link_expired' },
  { code: 'key_limit_reached' },
  { code: 'key_limit_reached', message: 'Ten keys already.' },
  { code: 'already_subscribed' },
  { code: 'already_subscribed', message: 'Already on Pro.', details: { portal_url: 'https://billing.stripe.com/p/session/x' } },
  { code: 'invalid_api_key', message: 'ignored' },
  { code: 'insufficient_credits' },
  { code: 'insufficient_credits', details: { buy_credits_url: 'https://wpconvert.ai/pricing' } },
  { code: 'quota_exceeded' },
  { code: 'upgrade_required' },
  { code: 'upgrade_required', message: 'Agency only.' },
  { code: 'upgrade_required', details: { preview_only: true } },
  { code: 'upgrade_required', details: { reason: 'dev_preview_limit' } },
  { code: 'upgrade_required', details: { reason: 'preview_only_job' } },
  { code: 'too_many_active_jobs' },
  { code: 'too_many_active_jobs', details: { current: 3, cap: 3 } },
  { code: 'rate_limited' },
  { code: 'rate_limited', details: { retry_after: 12 } },
  { code: 'conversion_not_ready' },
  { code: 'conversion_not_ready', details: { status: 'building' } },
  { code: 'theme_expired' },
  { code: 'theme_too_large_for_preview' },
  { code: 'theme_too_large_for_preview', message: 'Over 100MB.' },
  { code: 'idempotency_request_in_progress' },
  { code: 'idempotency_payload_mismatch' },
  { code: 'idempotency_previous_failed' },
  { code: 'invalid_idempotency_key' },
  { code: 'network_error' },
  { code: 'some_future_code', message: 'A message from the server.' },
  { code: 'some_future_code' },
];

function credentialSent(headers) {
  const sent = [headers['x-api-key'] && 'api_key', headers['x-wpconvert-guest-token'] && 'guest_token'].filter(Boolean);
  return sent.length ? sent.join('+') : 'none';
}

describe('stdio API-backed tool results', () => {
  let api;
  let base;
  let session;
  let routes = {};
  let requests = [];

  const scrub = (value, home) => JSON.parse(
    JSON.stringify(value).split(base).join('<api>').split(home).join('<home>'),
  );
  const fill = (value, home) => JSON.parse(
    JSON.stringify(value).split('<api>').join(base).split('<home>').join(home),
  );

  before(async () => {
    api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const route = `${req.method} ${req.url}`;
        requests.push({
          route,
          credential: credentialSent(req.headers),
          tool: req.headers['x-wpconvert-tool'] || null,
          client: req.headers['x-wpconvert-client'] ? req.headers['x-wpconvert-client'].replace(pkg.version, '<version>') : null,
          ...(raw ? { body: JSON.parse(raw) } : {}),
        });
        const [code, body] = routes[route] || [404, apiError('not_found', `No route ${route}`)];
        if (Buffer.isBuffer(body)) {
          res.writeHead(code, { 'content-type': 'application/zip' });
          res.end(body);
          return;
        }
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fill(body, session.home)));
      });
    });
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${api.address().port}`;
    session = await startStdioServer({ env: { WPCONVERT_API_BASE: base } });
  });

  after(async () => {
    if (session) await session.close();
    if (api) await new Promise((resolve) => api.close(resolve));
  });

  it('match the golden file', async () => {
    const results = [];
    for (const scenario of SCENARIOS) {
      const configDir = path.join(session.home, '.wpconvert');
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(ACCOUNTS[scenario.account]));
      fs.rmSync(path.join(session.home, 'downloads'), { recursive: true, force: true });
      routes = scenario.routes;
      requests = [];

      const result = await session.callTool(scenario.tool, fill(scenario.args, session.home));
      const saved = path.join(session.home, 'downloads');
      results.push(scrub({
        name: scenario.name,
        account: scenario.account,
        tool: scenario.tool,
        args: scenario.args,
        result,
        requests,
        ...(fs.existsSync(saved) ? {
          saved: Object.fromEntries(fs.readdirSync(saved).sort().map((f) => [f, fs.readFileSync(path.join(saved, f), 'utf8')])),
        } : {}),
      }, session.home));
    }

    const errors = ERROR_CASES.map(({ code, message, details }) => ({
      code,
      ...(message ? { message } : {}),
      ...(details ? { details } : {}),
      text: renderApiError({ name: 'ApiError', code, message, details }),
    }));

    assertMatchesGolden(GOLDEN, { tools: results, api_errors: errors });
  });
});
