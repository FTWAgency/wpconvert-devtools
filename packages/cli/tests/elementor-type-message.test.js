'use strict';

/**
 * --type elementor in the CLI (Elementor public launch, 2026-11-11). The CLI makes
 * WordPress themes; Elementor exports are made in the dashboard. The CLI must not
 * say Elementor is "coming soon" any more, and must send people to the dashboard's
 * Elementor flow. Gutenberg is still coming soon.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '..', 'bin', 'wpconvert.js'), 'utf8');

describe('CLI --type elementor', () => {
  it('no longer says Elementor is coming soon', () => {
    assert.doesNotMatch(src, /Elementor\s*(and|\/)\s*Gutenberg\s*(are\s*)?coming soon/i);
    assert.doesNotMatch(src, /Elementor[^\n]{0,40}coming soon/i);
  });

  it('sends Elementor to the dashboard and keeps Gutenberg as coming soon', () => {
    assert.match(src, /https:\/\/app\.wpconvert\.ai\/dashboard\?convert=elementor/);
    assert.match(src, /Elementor exports are made in the WPConvert dashboard/);
    assert.match(src, /Gutenberg (export )?is coming soon/);
  });

  it('still accepts only "theme"', () => {
    assert.match(src, /const VALID_TYPES = \['theme'\];/);
  });
});
