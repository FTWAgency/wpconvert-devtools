'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildZipBuffer } = require('../src/zip');

describe('buildZipBuffer determinism', () => {
  it('produces identical bytes for the same files regardless of input order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpconvert-zip-'));
    try {
      fs.writeFileSync(path.join(dir, 'b.txt'), 'bbb');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'aaa');
      const a = [
        { relPath: 'b.txt', absPath: path.join(dir, 'b.txt') },
        { relPath: 'a.txt', absPath: path.join(dir, 'a.txt') },
      ];
      const b = [
        { relPath: 'a.txt', absPath: path.join(dir, 'a.txt') },
        { relPath: 'b.txt', absPath: path.join(dir, 'b.txt') },
      ];
      const zip1 = buildZipBuffer(a);
      const zip2 = buildZipBuffer(b);
      assert.equal(zip1.equals(zip2), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
