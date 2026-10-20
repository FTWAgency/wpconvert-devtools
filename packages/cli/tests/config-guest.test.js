'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('config file: atomic 0600 writes and the guest session', () => {
  let tmpHome;
  let savedHome;
  let config;

  beforeEach(() => {
    savedHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-config-'));
    process.env.HOME = tmpHome;
    delete require.cache[require.resolve('../src/config')];
    config = require('../src/config');
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes with mode 0600, merges, and leaves no temp file behind', () => {
    config.writeFileConfig({ apiKey: 'wpc_live_example' });
    config.writeFileConfig({ apiBase: 'https://api.example.test' });
    const file = config.configPath();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { apiKey: 'wpc_live_example', apiBase: 'https://api.example.test' });
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['config.json']);
  });

  it('tightens a pre-existing loose file', () => {
    fs.mkdirSync(path.join(tmpHome, '.wpconvert'), { recursive: true });
    fs.writeFileSync(config.configPath(), '{}', { mode: 0o644 });
    config.writeFileConfig({ apiKey: 'wpc_live_example' });
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(config.configPath()).mode & 0o777, 0o600);
  });

  it('stores, reads and clears the guest session without touching the API key', () => {
    config.writeFileConfig({ apiKey: 'wpc_live_example' });
    config.saveGuestSession({ token: 'wpcg_' + 'a'.repeat(43), convertUntil: '2030-01-01T00:00:00Z', claimUntil: '2030-01-07T00:00:00Z' });
    const session = config.getGuestSession();
    assert.strictEqual(session.token, 'wpcg_' + 'a'.repeat(43));
    assert.strictEqual(session.convertUntil, '2030-01-01T00:00:00Z');
    assert.strictEqual(config.readFileConfig().apiKey, 'wpc_live_example');
    config.clearGuestSession();
    assert.strictEqual(config.getGuestSession(), null);
    assert.strictEqual(config.readFileConfig().apiKey, 'wpc_live_example');
  });

  it('keeps the remaining preview count with the session', () => {
    config.saveGuestSession({ token: 'wpcg_' + 'a'.repeat(43), convertUntil: '2099-01-01T00:00:00Z', claimUntil: '2099-01-07T00:00:00Z', remaining: 3 });
    assert.strictEqual(config.getGuestSession().remaining, 3);
    config.updateGuestRemaining(1);
    assert.strictEqual(config.getGuestSession().remaining, 1);
    assert.strictEqual(config.getGuestSession().token, 'wpcg_' + 'a'.repeat(43));
  });

  it('ignores a malformed or ended guest session', () => {
    config.writeFileConfig({ guest: { token: 'not-a-token' } });
    assert.strictEqual(config.getGuestSession(), null);
    config.writeFileConfig({ guest: { token: 'wpcg_' + 'b'.repeat(43), convertUntil: '2000-01-01T00:00:00Z', claimUntil: '2000-01-02T00:00:00Z' } });
    assert.strictEqual(config.getGuestSession(), null, 'past the claim window the session is useless');
  });

  it('guestCanConvert follows the 24-hour window', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    assert.strictEqual(config.guestCanConvert({ convertUntil: '2030-01-01T01:00:00Z' }, now), true);
    assert.strictEqual(config.guestCanConvert({ convertUntil: '2029-12-31T23:00:00Z' }, now), false);
    assert.strictEqual(config.guestCanConvert(null, now), false);
  });
});
