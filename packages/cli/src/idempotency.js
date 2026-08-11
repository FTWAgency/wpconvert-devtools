'use strict';

/**
 * Conversion submission idempotency helpers for WPConvert CLI / MCP.
 * Keys are generated once per intentional conversion invocation.
 */

const crypto = require('crypto');

const KEY_PREFIX = 'wpconvert-cli-';
const MCP_KEY_PREFIX = 'wpconvert-mcp-';
const MAX_KEY_LENGTH = 128;
const ALLOWED_PREFIXES = [KEY_PREFIX, MCP_KEY_PREFIX];

/**
 * @param {string} [prefix]
 * @returns {string}
 */
function generateIdempotencyKey(prefix = KEY_PREFIX) {
  return `${prefix}${crypto.randomUUID()}`;
}

/**
 * @param {string | undefined | null} key
 * @param {{ allowedPrefixes?: string[] }} [opts]
 * @returns {string}
 */
function assertIdempotencyKey(key, { allowedPrefixes = ALLOWED_PREFIXES } = {}) {
  if (key == null || typeof key !== 'string') {
    throw new Error('Internal error: missing idempotency key for conversion submission.');
  }
  const normalized = key.trim();
  if (normalized.length === 0) {
    throw new Error('Internal error: missing idempotency key for conversion submission.');
  }
  if (normalized.length > MAX_KEY_LENGTH) {
    throw new Error('Internal error: idempotency key exceeds maximum length.');
  }
  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error('Internal error: idempotency key contains invalid characters.');
    }
  }
  if (Array.isArray(allowedPrefixes) && allowedPrefixes.length > 0) {
    const ok = allowedPrefixes.some((p) => normalized.startsWith(p));
    if (!ok) {
      throw new Error('Internal error: invalid idempotency key format.');
    }
  }
  return normalized;
}

/**
 * Ambiguous transport failures that may occur before a usable HTTP response.
 * @param {unknown} err
 * @returns {boolean}
 */
function isAmbiguousTransportError(err) {
  if (!err) return false;
  const code = err.cause?.code || err.code;
  if (code && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|ENETUNREACH|EAI_AGAIN/i.test(String(code))) {
    return true;
  }
  const msg = String(err.message || err);
  return /fetch failed|socket hang up|network|timed out|timeout/i.test(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  KEY_PREFIX,
  MCP_KEY_PREFIX,
  MAX_KEY_LENGTH,
  ALLOWED_PREFIXES,
  generateIdempotencyKey,
  assertIdempotencyKey,
  isAmbiguousTransportError,
  sleep,
};
