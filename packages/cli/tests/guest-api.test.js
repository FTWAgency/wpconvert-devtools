'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const GUEST = 'wpcg_' + 'g'.repeat(43);
const KEY = 'wpc_live_' + 'k'.repeat(40);
const JOB = '11111111-1111-4111-8111-111111111111';

describe('API client: guest token, device links, terminal billing', () => {
  let server;
  let requests;
  let routes;
  let tmpHome;
  let saved;
  let api;
  let config;

  before(async () => {
    saved = { HOME: process.env.HOME, KEY: process.env.WPCONVERT_API_KEY, BASE: process.env.WPCONVERT_API_BASE };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-guest-api-'));
    process.env.HOME = tmpHome;
    delete process.env.WPCONVERT_API_KEY;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const entry = { method: req.method, url: req.url, headers: req.headers, raw };
        requests.push(entry);
        const handler = routes[`${req.method} ${req.url.split('?')[0]}`];
        const [status, body] = handler ? handler(entry) : [404, { error: { code: 'not_found', message: 'Conversion not found.' } }];
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.WPCONVERT_API_BASE = `http://127.0.0.1:${server.address().port}`;
    for (const m of ['../src/config', '../src/api']) delete require.cache[require.resolve(m)];
    config = require('../src/config');
    api = require('../src/api');
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    process.env.HOME = saved.HOME;
    if (saved.KEY === undefined) delete process.env.WPCONVERT_API_KEY; else process.env.WPCONVERT_API_KEY = saved.KEY;
    if (saved.BASE === undefined) delete process.env.WPCONVERT_API_BASE; else process.env.WPCONVERT_API_BASE = saved.BASE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    routes = {};
    fs.rmSync(path.join(tmpHome, '.wpconvert'), { recursive: true, force: true });
    delete process.env.WPCONVERT_API_KEY;
  });

  const saveGuest = () => config.saveGuestSession({ token: GUEST, convertUntil: '2099-01-01T00:00:00Z', claimUntil: '2099-01-07T00:00:00Z' });

  it('device link creation and polling send no credentials and map RFC 8628 errors', async () => {
    saveGuest();
    process.env.WPCONVERT_API_KEY = KEY;
    routes['POST /api/cli/device'] = () => [201, { device_code: 'wpcd_x', user_code: 'BCDF-GHJK', verification_url: 'u', interval: 5, expires_in: 600 }];
    routes['POST /api/cli/device/token'] = (r) => (JSON.parse(r.raw).device_code === 'wpcd_x'
      ? [400, { error: 'authorization_pending' }]
      : [400, { error: 'invalid_grant' }]);
    const link = await api.createDeviceLink('guest');
    assert.strictEqual(link.user_code, 'BCDF-GHJK');
    assert.deepStrictEqual(JSON.parse(requests[0].raw), { kind: 'guest', client: requests[0].headers['x-wpconvert-client'] });
    assert.deepStrictEqual(await api.pollDeviceToken('wpcd_x'), { status: 'authorization_pending', interval: undefined });
    assert.strictEqual((await api.pollDeviceToken('wpcd_other')).status, 'invalid_grant');
    for (const r of requests) {
      assert.strictEqual(r.headers['x-api-key'], undefined);
      assert.strictEqual(r.headers['x-wpconvert-guest-token'], undefined);
    }
  });

  it('a successful poll returns the body, and account errors become ApiErrors', async () => {
    routes['POST /api/cli/device/token'] = () => [200, { kind: 'login', api_key: KEY, email: 'o***@example.com' }];
    assert.deepStrictEqual(await api.pollDeviceToken('wpcd_x'), { status: 'ok', body: { kind: 'login', api_key: KEY, email: 'o***@example.com' } });
    routes['POST /api/cli/device/token'] = () => [409, { error: 'key_limit_reached', message: 'Revoke one.' }];
    await assert.rejects(api.pollDeviceToken('wpcd_x'), (e) => e.code === 'key_limit_reached' && e.status === 409);
  });

  it('guest convert sends only the guest token, multipart, and never retries', async () => {
    saveGuest();
    routes['POST /api/convert/cli-guest'] = () => [200, { jobId: JOB, status: 'queued', progress: 0, remaining_previews: 2 }];
    const out = await api.convertGuest(Buffer.from('PK'), { projectName: 'site' });
    assert.strictEqual(out.remaining_previews, 2);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].headers['x-wpconvert-guest-token'], GUEST);
    assert.strictEqual(requests[0].headers['x-api-key'], undefined);
    assert.match(requests[0].headers['content-type'], /multipart\/form-data/);
    assert.match(requests[0].raw, /name="project_name"\r\n\r\nsite/);
    assert.strictEqual(config.getGuestSession().remaining, 2);
  });

  it('guest convert without a session is missing_credentials', async () => {
    await assert.rejects(api.convertGuest(Buffer.from('PK'), {}), (e) => e.code === 'missing_credentials');
  });

  it('status and preview fall back to the guest routes when there is no key', async () => {
    saveGuest();
    routes[`GET /api/convert/cli-guest/${JOB}/status`] = () => [200, { jobId: JOB, status: 'done', download_available: false, remaining_previews: 2 }];
    routes['POST /api/playground/cli-guest'] = (r) => [200, { playground_url: 'https://playground.example/x', conversion: JSON.parse(r.raw).conversionId }];
    assert.strictEqual((await api.getStatus(JOB)).remaining_previews, 2);
    const session = await api.createPlaygroundSession(JOB);
    assert.strictEqual(session.playground_url, 'https://playground.example/x');
    assert.strictEqual(session.conversion, JOB);
    assert.ok(requests.every((r) => r.headers['x-wpconvert-guest-token'] === GUEST && !r.headers['x-api-key']));
  });

  it('with a key, a guest job not yet in the account still resolves through the guest token', async () => {
    saveGuest();
    process.env.WPCONVERT_API_KEY = KEY;
    routes[`GET /api/convert/cli-guest/${JOB}/status`] = () => [200, { jobId: JOB, status: 'done', remaining_previews: 1 }];
    const s = await api.getStatus(JOB);
    assert.strictEqual(s.remaining_previews, 1);
    assert.strictEqual(requests[0].headers['x-api-key'], KEY);
    assert.strictEqual(requests[1].headers['x-wpconvert-guest-token'], GUEST);
    assert.strictEqual(requests[1].headers['x-api-key'], undefined);
  });

  it('with a key and no guest session, a 404 stays a 404', async () => {
    process.env.WPCONVERT_API_KEY = KEY;
    await assert.rejects(api.getStatus(JOB), (e) => e.code === 'not_found');
    assert.strictEqual(requests.length, 1);
  });

  it('catalog is public; options and checkout send the key plus the guest token when present', async () => {
    saveGuest();
    process.env.WPCONVERT_API_KEY = KEY;
    routes['GET /api/billing/catalog'] = () => [200, { options: [] }];
    routes['GET /api/billing/cli-options'] = (r) => [200, { url: r.url }];
    routes['POST /api/billing/cli-checkout'] = (r) => [200, { checkout_url: 'https://checkout.stripe.com/c/pay/x', session_id: 'cs_x', body: JSON.parse(r.raw) }];
    await api.getCatalog();
    assert.strictEqual(requests[0].headers['x-api-key'], undefined);
    const opts = await api.getCheckoutOptions(JOB);
    assert.strictEqual(opts.url, `/api/billing/cli-options?jobId=${JOB}`);
    const out = await api.createCheckout({ kind: 'pro', interval: 'year', jobId: JOB });
    assert.deepStrictEqual(out.body, { kind: 'pro', interval: 'year', jobId: JOB });
    for (const r of requests.slice(1)) {
      assert.strictEqual(r.headers['x-api-key'], KEY);
      assert.strictEqual(r.headers['x-wpconvert-guest-token'], GUEST);
    }
  });

  it('checkout without a key is missing_credentials and sends nothing', async () => {
    saveGuest();
    await assert.rejects(api.createCheckout({ kind: 'starter', jobId: JOB }), (e) => e.code === 'missing_credentials');
    assert.strictEqual(requests.length, 0);
  });

  it('an invalid guest token clears the stored session', async () => {
    saveGuest();
    routes[`GET /api/convert/cli-guest/${JOB}/status`] = () => [401, { error: { code: 'guest_token_invalid', message: 'This guest session has ended.' } }];
    await assert.rejects(api.getStatus(JOB), (e) => e.code === 'guest_token_invalid');
    assert.strictEqual(config.getGuestSession(), null);
  });
});
