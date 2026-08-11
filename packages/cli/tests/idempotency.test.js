'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  KEY_PREFIX,
  MCP_KEY_PREFIX,
  MAX_KEY_LENGTH,
  generateIdempotencyKey,
  assertIdempotencyKey,
  isAmbiguousTransportError,
} = require('../src/idempotency');

describe('idempotency key generation', () => {
  it('generates one valid key per call with CLI prefix', () => {
    const key = generateIdempotencyKey();
    assert.ok(key.startsWith(KEY_PREFIX));
    assert.ok(key.length > KEY_PREFIX.length);
    assert.ok(key.length <= MAX_KEY_LENGTH);
    assert.doesNotThrow(() => assertIdempotencyKey(key));
  });

  it('generates MCP-prefixed keys when requested', () => {
    const key = generateIdempotencyKey(MCP_KEY_PREFIX);
    assert.ok(key.startsWith(MCP_KEY_PREFIX));
    assert.doesNotThrow(() => assertIdempotencyKey(key));
  });

  it('generates different keys for separate invocations', () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    assert.notStrictEqual(a, b);
  });

  it('rejects invalid keys at the call boundary', () => {
    assert.throws(() => assertIdempotencyKey(null), /missing idempotency key/i);
    assert.throws(() => assertIdempotencyKey('bad-prefix'), /invalid idempotency key format/i);
  });
});

describe('ambiguous transport detection', () => {
  it('detects common network failures', () => {
    assert.equal(isAmbiguousTransportError(new Error('fetch failed')), true);
    assert.equal(isAmbiguousTransportError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
    assert.equal(isAmbiguousTransportError(new Error('bad request')), false);
  });
});
