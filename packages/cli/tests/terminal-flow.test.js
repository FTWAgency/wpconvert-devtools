'use strict';

/**
 * End to end against a fake API: guest convert, browser sign-in, plans, and
 * unlock through to the download. Runs the real binary without a TTY, so it
 * also pins the non-interactive behavior (no browser, no prompts).
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'wpconvert.js');
const JOB = '22222222-2222-4222-8222-222222222222';
const GUEST = 'wpcg_' + 'G'.repeat(43);
const KEY = 'wpc_live_' + 'K'.repeat(40);
const DEVICE = { guest: 'wpcd_' + 'g'.repeat(43), login: 'wpcd_' + 'l'.repeat(43) };

const catalogOptions = [
  { kind: 'starter', name: 'Starter', billing: 'one_time', summary: 'Unlock and download this one theme.', features: ['Standard WordPress theme export (.zip)'], price_cents: 1900, pro_delta_cents: 600 },
  { kind: 'pro', name: 'Pro', billing: 'subscription', summary: 'Monthly plan.', features: ['20 conversions per month'], price_cents: { month: 4900, year: 49000 }, starter_credit_cents: 1900 },
  { kind: 'agency', name: 'Agency', billing: 'subscription', summary: 'Teams.', features: ['Unlimited conversions'], price_cents: { month: 24900, year: 249000 } },
  { kind: 'payg', name: 'Pay-as-you-go credits', billing: 'one_time', summary: 'Credits.', features: ['No expiry.'], packs: [{ size: 1, price_cents: 2500 }, { size: 5, price_cents: 9900 }, { size: 10, price_cents: 17900 }, { size: 30, price_cents: 39900 }] },
];

describe('terminal flow (no TTY)', () => {
  let server;
  let base;
  let state;
  let home;
  let site;
  let outDir;

  function reply(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const route = `${req.method} ${req.url.split('?')[0]}`;
        state.requests.push({ route, headers: req.headers, raw });
        const json = () => { try { return JSON.parse(raw); } catch (_) { return {}; } };
        switch (route) {
          case 'POST /api/cli/device': {
            const kind = json().kind;
            return reply(res, 201, {
              device_code: DEVICE[kind],
              user_code: 'BCDF-GHJK',
              verification_url: kind === 'guest' ? `${base}/cli/activate?code=BCDF-GHJK` : `${base}/cli/activate?kind=login`,
              interval: 1,
              expires_in: 60,
            });
          }
          case 'POST /api/cli/device/token': {
            const code = json().device_code;
            state.polls[code] = (state.polls[code] || 0) + 1;
            if (state.polls[code] < 2) return reply(res, 400, { error: 'authorization_pending' });
            if (code === DEVICE.guest) return reply(res, 200, { kind: 'guest', guest_token: GUEST, budget: 3, convert_until: '2099-01-01T00:00:00Z', claim_until: '2099-01-07T00:00:00Z' });
            if (code === DEVICE.login) return reply(res, 200, { kind: 'login', api_key: KEY, email: 'o***@example.com', preview_scoped: true });
            return reply(res, 400, { error: 'invalid_grant' });
          }
          case 'POST /api/convert/cli-guest':
            if (req.headers['x-wpconvert-guest-token'] !== GUEST) return reply(res, 401, { error: { code: 'guest_token_invalid', message: 'bad' } });
            return reply(res, 200, { jobId: JOB, status: 'queued', progress: 0, remaining_previews: 2 });
          case `GET /api/convert/cli-guest/${JOB}/status`:
            return reply(res, 200, { jobId: JOB, status: 'done', progress: 100, download_available: false, remaining_previews: 2 });
          case 'POST /api/playground/cli-guest':
            return reply(res, 200, { playground_url: 'https://playground.wordpress.net/?blueprint-url=x', expires_at: '2099-01-01T00:00:00Z' });
          case 'GET /api/billing/catalog':
            return reply(res, 200, { currency: 'usd', price_source: 'stripe', trial_available: false, options: catalogOptions });
          case 'GET /api/billing/cli-options':
            if (req.headers['x-api-key'] !== KEY) return reply(res, 401, { error: { code: 'invalid_api_key', message: 'no' } });
            return reply(res, 200, {
              currency: 'usd', trial_available: false, existing_subscriber: false,
              job: { id: JOB, unlockable: true, reason: null },
              options: [
                { ...catalogOptions[0], available: true, today_cents: 1900, pro_delta_available: false },
                { ...catalogOptions[1], action: 'checkout', starter_credit_applies: false, today_cents: { month: 4900, year: 49000 } },
                { ...catalogOptions[2], action: 'checkout', today_cents: { month: 24900, year: 249000 } },
                { ...catalogOptions[3], available: true },
              ],
            });
          case 'POST /api/billing/cli-checkout':
            state.checkout = { body: json(), guestHeader: req.headers['x-wpconvert-guest-token'], key: req.headers['x-api-key'] };
            state.paidAt = Date.now();
            return reply(res, 200, { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_x', session_id: 'cs_test_x', claimed: [JOB] });
          case `GET /api/convert/${JOB}/status`:
            if (req.headers['x-api-key'] !== KEY) return reply(res, 404, { error: { code: 'not_found', message: 'nope' } });
            return reply(res, 200, { jobId: JOB, status: 'done', download_available: Boolean(state.paidAt) });
          case `GET /api/download/${JOB}`:
            return reply(res, 200, { download_url: `${base}/files/theme.zip`, name: 'site-theme.zip' });
          case 'GET /files/theme.zip':
            return reply(res, 200, 'PK-theme-bytes', 'application/zip');
          default:
            return reply(res, 404, { error: { code: 'not_found', message: `no route ${route}` } });
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  beforeEach(() => {
    state = { requests: [], polls: {}, checkout: null, paidAt: null };
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-flow-home-'));
    site = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-flow-site-'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-flow-out-'));
    fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>x</title></head><body>hi</body></html>');
  });

  function run(args, env = {}) {
    return new Promise((resolve) => {
      const childEnv = { ...process.env, HOME: home, USERPROFILE: home, WPCONVERT_API_BASE: base, ...env };
      delete childEnv.WPCONVERT_API_KEY;
      delete childEnv.CI;
      if (env.WPCONVERT_API_KEY) childEnv.WPCONVERT_API_KEY = env.WPCONVERT_API_KEY;
      if (env.CI) childEnv.CI = env.CI;
      const child = spawn(process.execPath, [BIN, ...args], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdin.end();
      child.on('close', (code) => {
        // eslint-disable-next-line no-control-regex
        const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
        resolve({ code, stdout: plain(stdout), stderr: plain(stderr), all: plain(stdout + stderr) });
      });
    });
  }

  const configFile = () => path.join(home, '.wpconvert', 'config.json');
  const assertNoSecrets = (text) => {
    for (const secret of [GUEST, KEY, DEVICE.guest, DEVICE.login]) assert.ok(!text.includes(secret), 'a secret was printed');
    assert.ok(!/wpcd_|wpcg_/.test(text));
  };

  it('convert with no key and no --guest refuses without a TTY and starts nothing', async () => {
    const r = await run(['convert', site, '--no-preview']);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.all, /wpconvert login/);
    assert.match(r.all, /--guest/);
    assert.ok(!state.requests.some((q) => q.route.startsWith('POST /api/cli')));
  });

  it('convert in CI with no key never starts a guest session', async () => {
    const r = await run(['convert', site, '--guest'], { CI: 'true' });
    assert.notStrictEqual(r.code, 0);
    assert.ok(!state.requests.some((q) => q.route.startsWith('POST /api/cli')));
  });

  it('convert --guest: link and code shown, token saved 0600, preview shown, unlock suggested, no secrets printed', async () => {
    const r = await run(['convert', site, '--guest']);
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /Open: http:\/\/127\.0\.0\.1:\d+\/cli\/activate\?code=BCDF-GHJK/);
    assert.match(r.stdout, /Code: BCDF-GHJK/);
    assert.match(r.stdout, /Guest session ready: 3 free previews/);
    assert.match(r.stdout, /2 guest previews left/);
    assert.match(r.stdout, /playground\.wordpress\.net/);
    assert.match(r.stdout, new RegExp(`wpconvert unlock ${JOB}`));
    assert.doesNotMatch(r.stdout, /Opening your browser/);
    assertNoSecrets(r.all);
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    assert.strictEqual(saved.guest.token, GUEST);
    assert.strictEqual(saved.guest.remaining, 2);
    assert.strictEqual(saved.apiKey, undefined);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(configFile()).mode & 0o777, 0o600);
    const upload = state.requests.find((q) => q.route === 'POST /api/convert/cli-guest');
    assert.strictEqual(upload.headers['x-api-key'], undefined);
    assert.match(upload.headers['x-wpconvert-client'], /^cli\/\d+\.\d+\.\d+/);
  });

  it('status on a guest job shows remaining previews and the unlock command', async () => {
    await run(['convert', site, '--guest', '--no-preview']);
    const r = await run(['status', JOB]);
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /2 previews left/);
    assert.match(r.stdout, new RegExp(`wpconvert unlock ${JOB}`));
  });

  it('download on a guest job explains how to buy instead of failing on credentials', async () => {
    await run(['convert', site, '--guest', '--no-preview']);
    const r = await run(['download', JOB]);
    assert.notStrictEqual(r.code, 0);
    assert.match(r.all, /cannot be downloaded/);
    assert.match(r.all, new RegExp(`wpconvert unlock ${JOB}`));
  });

  it('login with no flags signs in through the browser and saves the key without printing it', async () => {
    const r = await run(['login']);
    assert.strictEqual(r.code, 0, r.all);
    assert.match(r.stdout, /\/cli\/activate\?kind=login/);
    assert.match(r.stdout, /Code: BCDF-GHJK/);
    assert.match(r.stdout, /Signed in as o\*\*\*@example\.com/);
    assertNoSecrets(r.all);
    const saved = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    assert.strictEqual(saved.apiKey, KEY);
    assert.strictEqual(saved.email, 'o***@example.com');

    const pasted = await run(['login', '--key', 'wpc_live_' + 'P'.repeat(40)]);
    assert.strictEqual(pasted.code, 0, pasted.all);
    assert.strictEqual(JSON.parse(fs.readFileSync(configFile(), 'utf8')).email, undefined, 'a pasted key has no known email');
  });

  it('plans prints all four options with prices and no trial, without signing in', async () => {
    const r = await run(['plans']);
    assert.strictEqual(r.code, 0, r.all);
    for (const s of ['Starter', '$19.00 one-time', 'Pro', '$49.00/month or $490.00/year', 'Agency', '30 credits $399.00']) assert.ok(r.stdout.includes(s), s);
    assert.doesNotMatch(r.stdout, /trial/i);
    assert.strictEqual(state.requests[0].headers['x-api-key'], undefined);
  });

  it('unlock without a choice prints the menu and exits 2 without a TTY', async () => {
    const r = await run(['unlock', JOB], { WPCONVERT_API_KEY: KEY });
    assert.strictEqual(r.code, 2, r.all);
    assert.match(r.stdout, /1\. Starter: download this theme/);
    assert.match(r.stdout, /Pro \(yearly\)/);
    assert.match(r.all, /--starter/);
    assert.strictEqual(state.checkout, null);
  });

  it('unlock --starter without --yes refuses to buy without a TTY', async () => {
    const r = await run(['unlock', JOB, '--starter'], { WPCONVERT_API_KEY: KEY });
    assert.notStrictEqual(r.code, 0);
    assert.match(r.all, /--yes/);
    assert.strictEqual(state.checkout, null);
  });

  it('guest -> unlock --starter --yes: checkout carries key and guest token, waits for payment, downloads', async () => {
    await run(['convert', site, '--guest', '--no-preview']);
    const r = await run(['unlock', JOB, '--starter', '--yes', '--out', outDir], { WPCONVERT_API_KEY: KEY });
    assert.strictEqual(r.code, 0, r.all);
    assert.deepStrictEqual(state.checkout.body, { kind: 'starter', jobId: JOB });
    assert.strictEqual(state.checkout.key, KEY);
    assert.strictEqual(state.checkout.guestHeader, GUEST);
    assert.match(r.stdout, /checkout\.stripe\.com\/c\/pay\/cs_test_x/);
    assert.match(r.stdout, /Payment received\. Theme unlocked\./);
    assert.strictEqual(fs.readFileSync(path.join(outDir, 'site-theme.zip'), 'utf8'), 'PK-theme-bytes');
    assertNoSecrets(r.all);
  });

  it('unlock --pro --yearly sends exactly kind, interval and jobId', async () => {
    const r = await run(['unlock', JOB, '--pro', '--yearly', '--yes', '--no-download'], { WPCONVERT_API_KEY: KEY });
    assert.strictEqual(r.code, 0, r.all);
    assert.deepStrictEqual(state.checkout.body, { kind: 'pro', interval: 'year', jobId: JOB });
    assert.match(r.stdout, new RegExp(`wpconvert download ${JOB}`));
  });
});
