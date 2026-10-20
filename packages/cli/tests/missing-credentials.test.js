'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('no API key configured', () => {
  let tmpHome;
  let saved;
  let api;

  before(() => {
    saved = { HOME: process.env.HOME, KEY: process.env.WPCONVERT_API_KEY, BASE: process.env.WPCONVERT_API_BASE };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wpc-nokey-'));
    process.env.HOME = tmpHome;
    delete process.env.WPCONVERT_API_KEY;
    // Unroutable base: a request that escapes the key check fails as a network error.
    process.env.WPCONVERT_API_BASE = 'http://127.0.0.1:9';
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/api')];
    api = require('../src/api');
  });

  after(() => {
    process.env.HOME = saved.HOME;
    if (saved.KEY === undefined) delete process.env.WPCONVERT_API_KEY; else process.env.WPCONVERT_API_KEY = saved.KEY;
    if (saved.BASE === undefined) delete process.env.WPCONVERT_API_BASE; else process.env.WPCONVERT_API_BASE = saved.BASE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const calls = {
    getQuota: (a) => a.getQuota(),
    getStatus: (a) => a.getStatus('00000000-0000-0000-0000-000000000001'),
    getDownload: (a) => a.getDownload('00000000-0000-0000-0000-000000000001'),
    createPlaygroundSession: (a) => a.createPlaygroundSession('00000000-0000-0000-0000-000000000001'),
    getUploadUrl: (a) => a.getUploadUrl(),
    convertMultipart: (a) => a.convertMultipart(Buffer.from('PK'), { projectName: 'x' }),
    createJobFromStorage: (a) => a.createJobFromStorage('00000000-0000-0000-0000-000000000001', {}),
  };

  for (const [name, call] of Object.entries(calls)) {
    it(`${name} reports missing_credentials, not a network error`, async () => {
      await assert.rejects(call(api), (err) => {
        assert.strictEqual(err.code, 'missing_credentials', `${name} returned code ${err.code}`);
        return true;
      });
    });
  }
});
