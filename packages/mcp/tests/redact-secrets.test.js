import { describe, it } from 'node:test';
import assert from 'node:assert';
import { redactSecrets, renderApiError } from '../src/server.mjs';

describe('redactSecrets', () => {
  it('leaves the missing-key guidance readable', () => {
    const text = renderApiError({ name: 'ApiError', code: 'missing_credentials' });
    assert.strictEqual(redactSecrets(text), text);
    assert.match(redactSecrets(text), /Set WPCONVERT_API_KEY in the MCP server environment/);
  });

  it('redacts an assigned key value', () => {
    assert.strictEqual(
      redactSecrets('env WPCONVERT_API_KEY=abc123secret failed'),
      'env WPCONVERT_API_KEY=[redacted] failed'
    );
    assert.strictEqual(
      redactSecrets('WPCONVERT_API_KEY: abc123secret'),
      'WPCONVERT_API_KEY=[redacted]'
    );
  });

  it('redacts raw live keys anywhere', () => {
    assert.strictEqual(redactSecrets('key wpc_live_AbC_123-x leaked'), 'key [redacted-api-key] leaked');
  });
});
