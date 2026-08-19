'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, afterEach } = require('node:test');
const {
  RELEASE_ASSET_SHA256,
  resolvePlatformAsset,
  verifyArchiveChecksum,
  ensurePublisher,
} = require('./ensure-mcp-publisher.cjs');

const EXPECTED_LINUX_AMD64 = RELEASE_ASSET_SHA256['mcp-publisher_linux_amd64.tar.gz'];

function makeTempCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-publisher-cache-'));
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('ensure-mcp-publisher checksum verification', () => {
  /** @type {string[]} */
  let tempDirs = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it('accepts archive with correct pinned checksum', () => {
    const cacheDir = makeTempCacheDir();
    tempDirs.push(cacheDir);
    const payload = Buffer.from('mcp-publisher-checksum-fixture');
    const archive = path.join(cacheDir, 'sample.tar.gz');
    fs.writeFileSync(archive, payload);
    const expected = sha256Buffer(payload);
    assert.equal(verifyArchiveChecksum(archive, expected), true);
  });

  it('rejects archive with wrong checksum before extraction', async () => {
    const cacheDir = makeTempCacheDir();
    tempDirs.push(cacheDir);
    const asset = 'mcp-publisher_linux_amd64.tar.gz';
    const archive = path.join(cacheDir, asset);
    const goodPayload = Buffer.from('good-archive-bytes');
    fs.writeFileSync(archive, goodPayload);

    await assert.rejects(
      () =>
        ensurePublisher({
          cacheDir,
          platform: 'linux',
          arch: 'x64',
          skipPathLookup: true,
          downloadFn: async (_url, dest) => {
            fs.writeFileSync(dest, Buffer.from('tampered-download'));
          },
        }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(path.join(cacheDir, 'mcp-publisher')), false);
    assert.equal(fs.existsSync(archive), false);
  });

  it('rejects unsupported platform/architecture combinations', async () => {
    const cacheDir = makeTempCacheDir();
    tempDirs.push(cacheDir);
    assert.equal(resolvePlatformAsset('win32', 'x64'), null);
    await assert.rejects(
      () =>
        ensurePublisher({
          cacheDir,
          platform: 'win32',
          arch: 'x64',
          skipPathLookup: true,
        }),
      /not supported on win32\/x64/,
    );
  });

  it('rejects cached binary when archive checksum is wrong and re-download fails closed', async () => {
    const cacheDir = makeTempCacheDir();
    tempDirs.push(cacheDir);
    const asset = 'mcp-publisher_linux_amd64.tar.gz';
    const archive = path.join(cacheDir, asset);
    const binPath = path.join(cacheDir, 'mcp-publisher');

    fs.writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(archive, 'not-a-valid-archive');

    let downloadAttempts = 0;
    await assert.rejects(
      () =>
        ensurePublisher({
          cacheDir,
          platform: 'linux',
          arch: 'x64',
          skipPathLookup: true,
          downloadFn: async (_url, dest) => {
            downloadAttempts += 1;
            fs.writeFileSync(dest, 'still-not-valid');
          },
        }),
      /checksum mismatch/,
    );

    assert.equal(downloadAttempts, 1, 'should attempt one verified re-download');
    assert.equal(fs.existsSync(binPath), false, 'untrusted cached binary must be removed');
    assert.equal(fs.existsSync(archive), false, 'failed archive must be removed');
  });

  it('accepts official linux_amd64 release archive against pinned digest', () => {
    const fixture = path.join(os.tmpdir(), 'mcp-publisher_linux_amd64.tar.gz');
    if (!fs.existsSync(fixture)) {
      return;
    }
    assert.equal(verifyArchiveChecksum(fixture, EXPECTED_LINUX_AMD64), true);
  });
});
