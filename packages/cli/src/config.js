'use strict';

/**
 * CLI configuration: resolves the API key + base URL.
 *
 * Key resolution order (first wins):
 *   1. WPCONVERT_API_KEY env var (preferred for CI / ephemeral use).
 *   2. ~/.wpconvert/config.json (written by `wpconvert login`, mode 0600).
 *
 * The key is a secret. We store it with restrictive permissions and never echo
 * it back in command output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_API_BASE = 'https://api.wpconvert.ai';

function configDir() {
  return path.join(os.homedir(), '.wpconvert');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

/** Read the on-disk config file, or {} if absent/unreadable. */
function readFileConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

/** Persist config (api key, optional apiBase) with 0600 perms. */
function writeFileConfig(next) {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const merged = { ...readFileConfig(), ...next };
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  // Re-assert perms in case the file pre-existed with looser bits.
  try { fs.chmodSync(configPath(), 0o600); } catch (_) { /* best-effort */ }
  return configPath();
}

/**
 * Resolve the active API base URL.
 * Env override (WPCONVERT_API_BASE) > config file > default.
 */
function getApiBase() {
  const fromEnv = process.env.WPCONVERT_API_BASE && process.env.WPCONVERT_API_BASE.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const file = readFileConfig();
  if (file.apiBase) return String(file.apiBase).replace(/\/+$/, '');
  return DEFAULT_API_BASE;
}

/**
 * Resolve the active API key, or null if none is configured.
 */
function getApiKey() {
  const fromEnv = process.env.WPCONVERT_API_KEY && process.env.WPCONVERT_API_KEY.trim();
  if (fromEnv) return fromEnv;
  const file = readFileConfig();
  return file.apiKey || null;
}

module.exports = {
  DEFAULT_API_BASE,
  configPath,
  readFileConfig,
  writeFileConfig,
  getApiBase,
  getApiKey,
};
