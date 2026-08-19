#!/usr/bin/env node
/**
 * Ensure the official mcp-publisher CLI is available for local/CI validation.
 * Downloads a pinned release binary when missing from PATH (no Registry auth).
 * Every auto-downloaded archive is SHA-256 verified before extraction/execution.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const VERSION = '1.8.1';
const ROOT = path.resolve(__dirname, '..');

/** Pinned SHA-256 digests for mcp-publisher v1.8.1 release archives (review trust boundary). */
const RELEASE_ASSET_SHA256 = {
  'mcp-publisher_linux_amd64.tar.gz': 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc',
  'mcp-publisher_linux_arm64.tar.gz': '8dd75a6cf6845688b5d4e46df58d3ca26d5c8d233bb0626606e1db82c5e883e4',
  'mcp-publisher_darwin_amd64.tar.gz': '88126981225e7714fcc6b7a10cdba4a80ae5901e9740a8c06d0d5195c8bc294c',
  'mcp-publisher_darwin_arm64.tar.gz': 'e45e520892460732a4bdf37255576415d4a53ec171f8b913faf15bb1aef7cb77',
};

function defaultCacheDir() {
  return process.env.MCP_PUBLISHER_CACHE_DIR || path.join(ROOT, '.cache', 'mcp-publisher');
}

function resolvePlatformAsset(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  if (!os) return null;
  const mappedArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!mappedArch) return null;
  const asset = `mcp-publisher_${os}_${mappedArch}.tar.gz`;
  return RELEASE_ASSET_SHA256[asset] ? asset : null;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function verifyArchiveChecksum(filePath, expectedHex) {
  if (!expectedHex || typeof expectedHex !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHex)) {
    return false;
  }
  const actualHex = sha256File(filePath);
  const actual = Buffer.from(actualHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function resolvePublisherFromPath() {
  const fromPath = spawnSync('sh', ['-c', 'command -v mcp-publisher'], { encoding: 'utf8' });
  if (fromPath.status === 0 && fromPath.stdout.trim()) {
    return fromPath.stdout.trim();
  }
  return null;
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

async function ensurePublisher({
  cacheDir = defaultCacheDir(),
  platform = process.platform,
  arch = process.arch,
  skipPathLookup = false,
  downloadFn = download,
} = {}) {
  if (!skipPathLookup) {
    const fromPath = resolvePublisherFromPath();
    if (fromPath) return fromPath;
  }

  const asset = resolvePlatformAsset(platform, arch);
  if (!asset) {
    throw new Error(
      `mcp-publisher auto-download is not supported on ${platform}/${arch}. Install mcp-publisher manually or use Linux/macOS amd64/arm64.`,
    );
  }

  const expectedSha256 = RELEASE_ASSET_SHA256[asset];
  const archive = path.join(cacheDir, asset);
  const binPath = path.join(cacheDir, 'mcp-publisher');

  fs.mkdirSync(cacheDir, { recursive: true });

  const archiveValid = fs.existsSync(archive) && verifyArchiveChecksum(archive, expectedSha256);
  if (fs.existsSync(binPath)) {
    if (archiveValid) {
      return binPath;
    }
    removeIfExists(binPath);
    removeIfExists(archive);
  } else if (fs.existsSync(archive) && !archiveValid) {
    removeIfExists(archive);
  }

  if (!archiveValid) {
    const url = `https://github.com/modelcontextprotocol/registry/releases/download/v${VERSION}/${asset}`;
    await downloadFn(url, archive);
    if (!verifyArchiveChecksum(archive, expectedSha256)) {
      removeIfExists(archive);
      throw new Error(`mcp-publisher archive checksum mismatch for ${asset}`);
    }
  }

  execFileSync('tar', ['-xzf', archive, '-C', cacheDir, 'mcp-publisher'], { stdio: 'inherit' });
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

async function main() {
  const publisher = await ensurePublisher();
  const args = process.argv.slice(2);
  const result = spawnSync(publisher, args, { stdio: 'inherit', cwd: ROOT });
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  VERSION,
  RELEASE_ASSET_SHA256,
  defaultCacheDir,
  resolvePlatformAsset,
  sha256File,
  verifyArchiveChecksum,
  ensurePublisher,
};
