'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { presentLink, waitForApproval, storeApproval } = require('../src/device');
const { ApiError } = require('../src/api');

const LINK = {
  device_code: 'wpcd_' + 's'.repeat(43),
  user_code: 'BCDF-GHJK',
  verification_url: 'https://app.wpconvert.ai/cli/activate?code=BCDF-GHJK',
  interval: 5,
  expires_in: 600,
};

function fakeClock() {
  let now = 0;
  const slept = [];
  return {
    now: () => now,
    sleep: async (ms) => { slept.push(ms); now += ms; },
    slept,
  };
}

describe('presentLink', () => {
  it('prints the link and code, opens the browser only in a real terminal', () => {
    const lines = [];
    const opened = [];
    presentLink(LINK, { log: (s) => lines.push(s), isTTY: true, env: {}, open: (u) => opened.push(u) });
    const out = lines.join('\n');
    assert.match(out, /https:\/\/app\.wpconvert\.ai\/cli\/activate\?code=BCDF-GHJK/);
    assert.match(out, /BCDF-GHJK/);
    assert.deepStrictEqual(opened, [LINK.verification_url]);
    assert.doesNotMatch(out, /wpcd_/);
  });

  it('never opens a browser without a TTY or in CI', () => {
    for (const ctx of [{ isTTY: false, env: {} }, { isTTY: true, env: { CI: 'true' } }]) {
      const opened = [];
      presentLink(LINK, { log: () => {}, open: (u) => opened.push(u), ...ctx });
      assert.deepStrictEqual(opened, []);
    }
  });
});

describe('waitForApproval', () => {
  it('waits at the server interval, backs off on slow_down, and returns the secret once', async () => {
    const clock = fakeClock();
    const replies = [
      { status: 'authorization_pending' },
      { status: 'slow_down', interval: 10 },
      { status: 'authorization_pending' },
      { status: 'ok', body: { kind: 'guest', guest_token: 'wpcg_' + 'x'.repeat(43) } },
    ];
    const seen = [];
    const body = await waitForApproval(LINK, {
      poll: async (code) => { seen.push(code); return replies.shift(); },
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.strictEqual(body.guest_token, 'wpcg_' + 'x'.repeat(43));
    assert.ok(seen.every((c) => c === LINK.device_code));
    assert.deepStrictEqual(clock.slept, [5000, 5000, 10000, 10000]);
  });

  it('stops with a clear error when the link expires or is refused', async () => {
    for (const status of ['expired_token', 'invalid_grant']) {
      await assert.rejects(
        waitForApproval(LINK, { poll: async () => ({ status }), sleep: async () => {}, now: () => 0 }),
        (err) => err instanceof ApiError && err.code === 'link_expired' && /Run the command again/.test(err.message),
      );
    }
  });

  it('gives up at expires_in', async () => {
    const clock = fakeClock();
    await assert.rejects(
      waitForApproval({ ...LINK, expires_in: 12 }, { poll: async () => ({ status: 'authorization_pending' }), sleep: clock.sleep, now: clock.now }),
      (err) => err.code === 'link_expired',
    );
    assert.ok(clock.now() <= 15000);
  });

  it('keeps waiting through transient network and 5xx errors', async () => {
    const clock = fakeClock();
    const replies = [
      () => { throw new ApiError('fetch failed', { code: 'network_error' }); },
      () => { throw new ApiError('Please keep waiting', { code: 'server_error', status: 500 }); },
      () => ({ status: 'ok', body: { kind: 'login', api_key: 'wpc_live_k', email: 'o***@example.com' } }),
    ];
    const body = await waitForApproval(LINK, { poll: async () => replies.shift()(), sleep: clock.sleep, now: clock.now });
    assert.strictEqual(body.kind, 'login');
  });

  it('storeApproval saves only the secret that was asked for and returns nothing secret', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const config = require('../src/config');
    const savedHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-store-'));
    process.env.HOME = tmpHome;
    try {
      const login = { kind: 'login', api_key: 'wpc_live_' + 'k'.repeat(40), email: 'o***@example.com', preview_scoped: true };
      assert.throws(() => storeApproval(login, 'guest'), (e) => e.code === 'server_error');
      assert.deepStrictEqual(config.readFileConfig(), {});
      const shown = storeApproval(login, 'login');
      assert.deepStrictEqual(shown, { kind: 'login', email: 'o***@example.com', previewScoped: true });
      assert.strictEqual(config.readFileConfig().apiKey, login.api_key);

      const guest = { kind: 'guest', guest_token: 'wpcg_' + 'g'.repeat(43), budget: 3, convert_until: '2099-01-01T00:00:00Z', claim_until: '2099-01-07T00:00:00Z' };
      assert.ok(!JSON.stringify(storeApproval(guest, 'guest')).includes(guest.guest_token));
      assert.strictEqual(config.getGuestSession().remaining, 3);
    } finally {
      process.env.HOME = savedHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('surfaces account problems from the server instead of waiting', async () => {
    await assert.rejects(
      waitForApproval(LINK, {
        poll: async () => { throw new ApiError('Your account already has 10 active API keys.', { code: 'key_limit_reached', status: 409 }); },
        sleep: async () => {},
        now: () => 0,
      }),
      (err) => err.code === 'key_limit_reached',
    );
  });
});
