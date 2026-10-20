/**
 * Connecting without a key (guest or browser sign-in), guest conversions, and
 * buying through the agent: plans first, checkout only for the user's choice.
 * Tools must never return a secret.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const JOB = '33333333-3333-4333-8333-333333333333';
const GUEST = 'wpcg_' + 'M'.repeat(43);
const KEY = 'wpc_live_' + 'Q'.repeat(40);
const DEVICE = { guest: 'wpcd_' + 'a'.repeat(43), login: 'wpcd_' + 'b'.repeat(43) };

const catalogOptions = [
  { kind: 'starter', name: 'Starter', billing: 'one_time', summary: 'Unlock and download this one theme.', features: ['Standard WordPress theme export (.zip)'], price_cents: 1900, pro_delta_cents: 600 },
  { kind: 'pro', name: 'Pro', billing: 'subscription', summary: 'Monthly plan.', features: ['20 conversions per month'], price_cents: { month: 4900, year: 49000 }, starter_credit_cents: 1900 },
  { kind: 'agency', name: 'Agency', billing: 'subscription', summary: 'Teams.', features: ['Unlimited conversions'], price_cents: { month: 24900, year: 249000 } },
  { kind: 'payg', name: 'Pay-as-you-go credits', billing: 'one_time', summary: 'Credits.', features: ['No expiry.'], packs: [{ size: 1, price_cents: 2500 }, { size: 5, price_cents: 9900 }, { size: 10, price_cents: 17900 }, { size: 30, price_cents: 39900 }] },
];

let server;
let state;
let home;
let site;
let mcp;

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const dataOf = (result) => {
  const text = textOf(result);
  const start = text.indexOf('\n\n{');
  return start === -1 ? null : JSON.parse(text.slice(start + 2));
};
const assertNoSecrets = (result) => {
  const text = textOf(result);
  for (const s of [GUEST, KEY, DEVICE.guest, DEVICE.login]) assert.ok(!text.includes(s), 'tool output contains a secret');
  assert.doesNotMatch(text, /wpcd_|wpcg_|wpc_live_/);
};
const configFile = () => path.join(home, '.wpconvert', 'config.json');
const readConfig = () => (fs.existsSync(configFile()) ? JSON.parse(fs.readFileSync(configFile(), 'utf8')) : {});

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const route = `${req.method} ${req.url.split('?')[0]}`;
      state.requests.push({ route, url: req.url, headers: req.headers, raw });
      const body = (() => { try { return JSON.parse(raw); } catch { return {}; } })();
      switch (route) {
        case 'POST /api/cli/device':
          return reply(res, 201, {
            device_code: DEVICE[body.kind],
            user_code: 'BCDF-GHJK',
            verification_url: `https://app.wpconvert.ai/cli/activate?${body.kind === 'guest' ? 'code=BCDF-GHJK' : 'kind=login'}`,
            interval: 1,
            expires_in: 600,
          });
        case 'POST /api/cli/device/token':
          if (state.pending) return reply(res, 400, { error: 'authorization_pending' });
          if (body.device_code === DEVICE.guest) return reply(res, 200, { kind: 'guest', guest_token: GUEST, budget: 3, convert_until: '2099-01-01T00:00:00Z', claim_until: '2099-01-07T00:00:00Z' });
          if (body.device_code === DEVICE.login) return reply(res, 200, { kind: 'login', api_key: KEY, email: 'o***@example.com', preview_scoped: false });
          return reply(res, 400, { error: 'invalid_grant' });
        case 'POST /api/convert/cli-guest':
          return reply(res, 200, { jobId: JOB, status: 'queued', progress: 0, remaining_previews: 2 });
        case `GET /api/convert/cli-guest/${JOB}/status`:
          return reply(res, 200, { jobId: JOB, status: 'done', progress: 100, download_available: false, remaining_previews: 2 });
        case 'GET /api/billing/catalog':
          return reply(res, 200, { currency: 'usd', price_source: 'stripe', trial_available: false, options: catalogOptions });
        case 'GET /api/billing/cli-options':
          return reply(res, 200, {
            currency: 'usd', trial_available: false, existing_subscriber: false,
            job: req.url.includes('jobId') ? { id: JOB, unlockable: true, reason: null } : null,
            options: [
              { ...catalogOptions[0], available: req.url.includes('jobId'), today_cents: 1900, pro_delta_available: false },
              { ...catalogOptions[1], action: 'checkout', starter_credit_applies: true, today_cents: { month: 3000, year: 49000 } },
              { ...catalogOptions[2], action: 'checkout', today_cents: { month: 24900, year: 249000 } },
              { ...catalogOptions[3], available: true },
            ],
          });
        case 'POST /api/billing/cli-checkout':
          state.checkout = { body, key: req.headers['x-api-key'], guest: req.headers['x-wpconvert-guest-token'] };
          return reply(res, 200, { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_mcp', session_id: 'cs_test_mcp', claimed: [JOB] });
        default:
          return reply(res, 404, { error: { code: 'not_found', message: `no route ${route}` } });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-mcp-home-'));
  site = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-mcp-site-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><body>hi</body></html>');
  process.env.HOME = home;
  process.env.WPCONVERT_API_BASE = `http://127.0.0.1:${server.address().port}`;
  delete process.env.WPCONVERT_API_KEY;
  mcp = await import('../src/server.mjs');
  mcp._internals.setConnectWaitMs(1500);
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(site, { recursive: true, force: true });
});

beforeEach(() => {
  state = { requests: [], pending: false, checkout: null };
  fs.rmSync(path.join(home, '.wpconvert'), { recursive: true, force: true });
  delete process.env.WPCONVERT_API_KEY;
  mcp._internals.resetConnect();
});

describe('tool list', () => {
  it('adds connect, connect_status, plans and checkout with user-in-the-loop descriptions', () => {
    const byName = Object.fromEntries(mcp.TOOLS.map((t) => [t.name, t]));
    for (const name of ['wpconvert_connect', 'wpconvert_connect_status', 'wpconvert_plans', 'wpconvert_checkout']) assert.ok(byName[name], name);
    assert.deepStrictEqual(byName.wpconvert_connect.inputSchema.properties.kind.enum, ['guest', 'login']);
    assert.match(byName.wpconvert_connect.description, /never open it yourself/i);
    assert.match(byName.wpconvert_plans.description, /show all options/i);
    assert.match(byName.wpconvert_plans.description, /let them choose/i);
    assert.match(byName.wpconvert_checkout.description, /only after the user/i);
    assert.deepStrictEqual(byName.wpconvert_checkout.inputSchema.properties.kind.enum, ['starter', 'pro', 'agency', 'payg']);
    assert.deepStrictEqual(byName.wpconvert_checkout.inputSchema.required, ['kind']);
    assert.doesNotMatch(JSON.stringify(mcp.TOOLS), /trial/i);
  });
});

describe('no key', () => {
  it('convert_folder points to wpconvert_connect guest, uploads nothing', async () => {
    const r = await mcp.handleCall('wpconvert_convert_folder', { path: site });
    assert.strictEqual(r.isError, true);
    const data = dataOf(r);
    assert.strictEqual(data.recommended_next.tool, 'wpconvert_connect');
    assert.deepStrictEqual(data.recommended_next.arguments, { kind: 'guest' });
    assert.ok(!state.requests.length);
  });

  it('the missing-key message names wpconvert_connect and still explains the env var', () => {
    const text = mcp.renderApiError({ name: 'ApiError', code: 'missing_credentials' });
    assert.match(text, /wpconvert_connect/);
    assert.match(text, /Set WPCONVERT_API_KEY in the MCP server environment/);
  });
});

describe('guest connect', () => {
  it('connect returns the link and code for the user, never the device code, opens nothing', async () => {
    const r = await mcp.handleCall('wpconvert_connect', { kind: 'guest' });
    assert.ok(!r.isError, textOf(r));
    assert.match(textOf(r), /https:\/\/app\.wpconvert\.ai\/cli\/activate\?code=BCDF-GHJK/);
    assert.match(textOf(r), /BCDF-GHJK/);
    assert.match(textOf(r), /wpconvert_connect_status/);
    assert.strictEqual(dataOf(r).recommended_next.tool, 'wpconvert_connect_status');
    assertNoSecrets(r);
  });

  it('connect_status while pending says to wait, then saves the guest session once approved', async () => {
    await mcp.handleCall('wpconvert_connect', { kind: 'guest' });
    state.pending = true;
    const waiting = await mcp.handleCall('wpconvert_connect_status', {});
    assert.strictEqual(dataOf(waiting).state, 'waiting');
    assert.match(textOf(waiting), /BCDF-GHJK/);
    state.pending = false;
    const done = await mcp.handleCall('wpconvert_connect_status', {});
    const data = dataOf(done);
    assert.strictEqual(data.state, 'connected');
    assert.strictEqual(data.mode, 'guest');
    assert.strictEqual(data.remaining_previews, 3);
    assertNoSecrets(done);
    assert.strictEqual(readConfig().guest.token, GUEST);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(configFile()).mode & 0o777, 0o600);
  });

  it('a guest session converts, reports status with remaining previews, and points to plans for buying', async () => {
    await mcp.handleCall('wpconvert_connect', { kind: 'guest' });
    await mcp.handleCall('wpconvert_connect_status', {});
    const submitted = await mcp.handleCall('wpconvert_convert_folder', { path: site });
    assert.ok(!submitted.isError, textOf(submitted));
    const sub = dataOf(submitted);
    assert.strictEqual(sub.job_id, JOB);
    assert.strictEqual(sub.guest, true);
    assert.strictEqual(sub.remaining_previews, 2);
    const upload = state.requests.find((q) => q.route === 'POST /api/convert/cli-guest');
    assert.strictEqual(upload.headers['x-wpconvert-guest-token'], GUEST);
    assert.match(upload.headers['x-wpconvert-client'], /^mcp\//);

    const status = await mcp.handleCall('wpconvert_check_status', { jobId: JOB });
    const s = dataOf(status);
    assert.strictEqual(s.guest, true);
    assert.strictEqual(s.remaining_previews, 2);
    assert.strictEqual(s.recommended_next.tool, 'wpconvert_create_preview');
    assert.match(s.recommended_next.reason, /wpconvert_plans/);
    assertNoSecrets(status);

    const dl = await mcp.handleCall('wpconvert_download_result', { jobId: JOB });
    assert.strictEqual(dl.isError, true);
    assert.strictEqual(dataOf(dl).recommended_next.tool, 'wpconvert_plans');
  });
});

describe('sign-in connect', () => {
  it('saves the key and masked email, reports only the masked email, warns when an env key overrides it', async () => {
    await mcp.handleCall('wpconvert_connect', { kind: 'login' });
    const r = await mcp.handleCall('wpconvert_connect_status', {});
    const data = dataOf(r);
    assert.strictEqual(data.mode, 'api_key');
    assert.strictEqual(data.email, 'o***@example.com');
    assert.strictEqual(data.env_key_override, false);
    assertNoSecrets(r);
    assert.strictEqual(readConfig().apiKey, KEY);

    process.env.WPCONVERT_API_KEY = 'wpc_live_placeholder';
    const overridden = await mcp.handleCall('wpconvert_connect_status', {});
    assert.strictEqual(dataOf(overridden).env_key_override, true);
    assert.match(textOf(overridden), /remove WPCONVERT_API_KEY/i);
    assertNoSecrets(overridden);
  });
});

describe('buying', () => {
  it('plans without a key lists every option from the public catalog and says buying needs sign-in', async () => {
    const r = await mcp.handleCall('wpconvert_plans', {});
    const text = textOf(r);
    for (const s of ['Starter', 'Pro', 'Agency', 'Pay-as-you-go', '$19.00', '$49.00/month', '$399.00', '20 conversions per month']) assert.ok(text.includes(s), s);
    assert.match(text, /wpconvert_connect/);
    assert.ok(!state.requests.some((q) => q.headers['x-api-key']));
  });

  it('plans with a key and jobId returns personalised choices with exact checkout arguments', async () => {
    process.env.WPCONVERT_API_KEY = KEY;
    const r = await mcp.handleCall('wpconvert_plans', { jobId: JOB });
    const data = dataOf(r);
    const ids = data.choices.map((c) => c.id);
    assert.deepStrictEqual(ids, ['starter', 'pro-month', 'pro-year', 'agency-month', 'agency-year', 'payg-1', 'payg-5', 'payg-10', 'payg-30']);
    assert.deepStrictEqual(data.choices.find((c) => c.id === 'pro-year').checkout_arguments, { kind: 'pro', interval: 'year', jobId: JOB });
    assert.match(data.choices.find((c) => c.id === 'pro-month').price, /\$30\.00 today/);
    assert.match(textOf(r), /let the user choose|Ask the user/i);
    assertNoSecrets(r);
  });

  it('checkout without a key points to sign-in and sends nothing', async () => {
    const r = await mcp.handleCall('wpconvert_checkout', { kind: 'starter', jobId: JOB });
    assert.strictEqual(r.isError, true);
    assert.deepStrictEqual(dataOf(r).recommended_next.arguments, { kind: 'login' });
    assert.strictEqual(state.checkout, null);
  });

  it('checkout validates locally and sends only kind, jobId, interval, packSize', async () => {
    process.env.WPCONVERT_API_KEY = KEY;
    for (const bad of [
      { kind: 'trial' },
      { kind: 'starter' },
      { kind: 'payg', packSize: 7 },
      { kind: 'pro', interval: 'week' },
      { kind: 'starter', jobId: JOB, interval: 'year' },
    ]) {
      const r = await mcp.handleCall('wpconvert_checkout', bad);
      assert.strictEqual(r.isError, true, JSON.stringify(bad));
    }
    assert.strictEqual(state.checkout, null);

    const r = await mcp.handleCall('wpconvert_checkout', { kind: 'pro', interval: 'year', jobId: JOB, promo: 'X', trial: true, withProDelta: true });
    assert.ok(!r.isError, textOf(r));
    assert.deepStrictEqual(state.checkout.body, { kind: 'pro', interval: 'year', jobId: JOB });
    assert.strictEqual(state.checkout.key, KEY);
    const data = dataOf(r);
    assert.strictEqual(data.checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_mcp');
    assert.match(textOf(r), /open this link/i);
    assert.strictEqual(data.recommended_next.tool, 'wpconvert_check_status');
    assertNoSecrets(r);
  });
});

describe('redaction', () => {
  it('masks guest tokens and device codes too', () => {
    assert.strictEqual(mcp.redactSecrets(`t ${GUEST} d ${DEVICE.guest}`), 't [redacted-guest-token] d [redacted-device-code]');
  });
});
