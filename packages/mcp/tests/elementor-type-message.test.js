'use strict';

/**
 * type "elementor" in the stdio MCP server (Elementor public launch, 2026-11-11). It makes
 * WordPress themes; Elementor exports are made in the dashboard. It must not tell the
 * agent Elementor is "coming soon" any more, and must point to the dashboard's Elementor
 * flow. Gutenberg is still coming soon.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'server.mjs'), 'utf8');

describe('MCP type "elementor"', () => {
  it('no longer says Elementor is coming soon', () => {
    assert.doesNotMatch(src, /Elementor\s*(and|\/)\s*Gutenberg\s*(are\s*)?coming soon/i);
    assert.doesNotMatch(src, /Elementor[^\n]{0,40}coming soon/i);
  });

  it('sends Elementor to the dashboard and keeps Gutenberg as coming soon', () => {
    assert.match(src, /https:\/\/app\.wpconvert\.ai\/dashboard\?convert=elementor/);
    assert.match(src, /Elementor exports are made in the WPConvert dashboard/);
    assert.match(src, /Gutenberg (export )?is coming soon/);
  });
});
