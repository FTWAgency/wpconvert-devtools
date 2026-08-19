#!/usr/bin/env node
/**
 * Ensure the official mcp-publisher CLI is available for local/CI validation.
 * Downloads a pinned release binary when missing from PATH (no Registry auth).
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const VERSION = '1.8.1';
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'mcp-publisher');
const BIN_PATH = path.join(CACHE_DIR, 'mcp-publisher');

function platformAsset() {
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : process.arch;
  return `mcp-publisher_${os}_${arch}.tar.gz`;
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

function resolvePublisher() {
  const fromPath = spawnSync('sh', ['-c', 'command -v mcp-publisher'], { encoding: 'utf8' });
  if (fromPath.status === 0 && fromPath.stdout.trim()) {
    return fromPath.stdout.trim();
  }
  if (fs.existsSync(BIN_PATH)) {
    return BIN_PATH;
  }
  return null;
}

async function ensurePublisher() {
  const existing = resolvePublisher();
  if (existing) return existing;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const asset = platformAsset();
  const url = `https://github.com/modelcontextprotocol/registry/releases/download/v${VERSION}/${asset}`;
  const archive = path.join(CACHE_DIR, asset);
  await download(url, archive);
  execFileSync('tar', ['-xzf', archive, '-C', CACHE_DIR, 'mcp-publisher'], { stdio: 'inherit' });
  fs.chmodSync(BIN_PATH, 0o755);
  return BIN_PATH;
}

async function main() {
  const publisher = await ensurePublisher();
  const args = process.argv.slice(2);
  const result = spawnSync(publisher, args, { stdio: 'inherit', cwd: ROOT });
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
