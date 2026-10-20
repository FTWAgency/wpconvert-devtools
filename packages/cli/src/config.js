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

/**
 * Persist config (api key, optional apiBase, guest session) with 0600 perms.
 * Written to a temp file and renamed, so a crash never leaves a half-written
 * file and the secret is never readable at looser permissions.
 */
function writeFileConfig(next) {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const merged = { ...readFileConfig(), ...next };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, configPath());
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* renamed */ }
  }
  // Re-assert perms in case the platform ignored the mode on create.
  try { fs.chmodSync(configPath(), 0o600); } catch (_) { /* best-effort */ }
  return configPath();
}

const GUEST_TOKEN_RX = /^wpcg_[A-Za-z0-9_-]{40,64}$/;

/** The stored terminal guest session, or null when absent, malformed or past its claim window. */
function getGuestSession(now = Date.now()) {
  const guest = readFileConfig().guest;
  if (!guest || typeof guest !== 'object' || !GUEST_TOKEN_RX.test(String(guest.token || ''))) return null;
  if (guest.claimUntil && Date.parse(guest.claimUntil) <= now) return null;
  return {
    token: guest.token,
    convertUntil: guest.convertUntil || null,
    claimUntil: guest.claimUntil || null,
    remaining: Number.isInteger(guest.remaining) ? guest.remaining : null,
  };
}

function saveGuestSession({ token, convertUntil, claimUntil, remaining }) {
  return writeFileConfig({ guest: { token, convertUntil, claimUntil, remaining } });
}

/** Last preview count the server reported; display only, the server enforces it. */
function updateGuestRemaining(remaining) {
  const guest = readFileConfig().guest;
  if (!guest || typeof guest !== 'object' || !Number.isInteger(remaining)) return;
  writeFileConfig({ guest: { ...guest, remaining } });
}

function clearGuestSession() {
  if (readFileConfig().guest === undefined) return;
  writeFileConfig({ guest: undefined });
}

/** Guest conversions are only accepted inside the 24-hour convert window. */
function guestCanConvert(session, now = Date.now()) {
  return Boolean(session && session.convertUntil && Date.parse(session.convertUntil) > now);
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
  getGuestSession,
  saveGuestSession,
  updateGuestRemaining,
  clearGuestSession,
  guestCanConvert,
};
