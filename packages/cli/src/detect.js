'use strict';

/**
 * Site-root detection for `wpconvert convert`.
 *
 * Most customers (especially AI-generated sites) don't know whether to point at
 * their project root or a built `dist/` folder. This figures it out:
 *
 *   1. index.html directly in the target            -> static site, use it
 *   2. a build-output dir (dist/build/out/...) with  -> use that automatically
 *      an index.html
 *   3. an un-built framework project (package.json   -> stop, tell them to build
 *      build script / framework config, no html)
 *   4. nothing resembling a site                     -> stop, ask for the right dir
 *
 * Pure filesystem inspection — no network, no writes.
 */

const fs = require('fs');
const path = require('path');

// Common static-output directories, in priority order.
const BUILD_DIRS = ['dist', 'build', 'out', 'public', '_site', path.join('.output', 'public')];

// Files that signal "this is a framework project that must be built first".
const FRAMEWORK_CONFIGS = [
  'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'astro.config.mjs', 'astro.config.js', 'astro.config.ts',
  'svelte.config.js', 'nuxt.config.js', 'nuxt.config.ts',
  'gatsby-config.js', 'gatsby-config.ts', 'remix.config.js',
  'angular.json',
];

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function hasIndexHtml(dir) {
  try { return fs.existsSync(path.join(dir, 'index.html')); } catch (_) { return false; }
}

/** Friendly framework label from a config filename (e.g. 'vite.config.ts' -> 'Vite'). */
function frameworkLabel(configFile) {
  if (!configFile) return 'JavaScript';
  const base = path.basename(configFile).split('.')[0];
  const map = { vite: 'Vite', next: 'Next.js', astro: 'Astro', svelte: 'SvelteKit', nuxt: 'Nuxt', gatsby: 'Gatsby', remix: 'Remix', angular: 'Angular' };
  return map[base] || base;
}

/**
 * Inspect `target` and decide which folder to zip.
 *
 * @param {string} target Absolute path the user pointed at.
 * @returns {{root: string|null, kind: string, note?: string, message?: string, candidates?: string[]}}
 *   - root set     -> zip this folder (note is an optional info line to print)
 *   - root null    -> cannot proceed; `message` explains what the user should do
 */
function detectSiteRoot(target) {
  // 1. index.html right here — the normal static-site case.
  if (hasIndexHtml(target)) {
    return { root: target, kind: 'static' };
  }

  // 2. a build-output directory that already contains an index.html.
  const found = [];
  for (const d of BUILD_DIRS) {
    const p = path.join(target, d);
    if (isDir(p) && hasIndexHtml(p)) found.push({ dir: d, path: p });
  }
  if (found.length === 1) {
    return { root: found[0].path, kind: 'built', note: `Detected built site in ./${found[0].dir} — packaging that.` };
  }
  if (found.length > 1) {
    const dirs = found.map((f) => f.dir);
    return {
      root: null,
      kind: 'ambiguous',
      candidates: dirs,
      message:
        `Found more than one build folder with an index.html: ${dirs.join(', ')}.\n` +
        `Re-run and pick one with --root, e.g. ${'wpconvert convert . --root ' + dirs[0]}.`,
    };
  }

  // 3. un-built framework project: has a build script or a framework config,
  //    but no index.html was produced yet.
  let hasBuildScript = false;
  const pkgPath = path.join(target, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      hasBuildScript = !!(pkg && pkg.scripts && pkg.scripts.build);
    } catch (_) { /* malformed package.json — ignore */ }
  }
  const frameworkConfig = FRAMEWORK_CONFIGS.find((f) => fs.existsSync(path.join(target, f)));
  if (hasBuildScript || frameworkConfig) {
    const label = frameworkLabel(frameworkConfig);
    return {
      root: null,
      kind: 'needs-build',
      message:
        `This looks like a ${label} project that needs to be built first.\n\n` +
        `  1) Build it:   npm install && npm run build\n` +
        `  2) Re-run:     wpconvert convert .        (we'll detect the output folder)\n\n` +
        `Or point straight at your build output:  wpconvert convert . --root dist`,
    };
  }

  // 4. nothing that looks like a website.
  return {
    root: null,
    kind: 'no-index',
    message:
      `Couldn't find an index.html in this folder (or a dist/build/out/public subfolder).\n` +
      `Point wpconvert at the folder that contains your site's index.html — e.g. ` +
      `wpconvert convert ./site, or use --root <dir>.`,
  };
}

module.exports = { detectSiteRoot, BUILD_DIRS, FRAMEWORK_CONFIGS };
