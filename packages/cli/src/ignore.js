'use strict';

/**
 * Ignore rules for the smart folder->zip step.
 *
 * Three layers, all defaults-on:
 *   1. Build/junk ignores (node_modules, .git, dist, build, *.log, .DS_Store, ...)
 *      — keeps uploads small; the worker reinstalls/builds server-side.
 *   2. Secret denylist (.env, *.pem, *.key, id_rsa*, .npmrc, .netrc, .aws, .ssh,
 *      credentials*.json) — SECURITY: prevents auto-zipping a working dir from
 *      sweeping up credentials. Only disabled per-pattern via --include-env.
 *   3. The repo's own .gitignore (honored when present) + user --ignore globs.
 *
 * Symlinks are never followed (handled in zip.js), so a symlink to ~/.ssh can't
 * leak files from outside the target folder.
 */

const path = require('path');

const DEFAULT_DIR_IGNORES = [
  'node_modules', '.git', 'dist', 'build', '.next', 'out',
  '.cache', '.turbo', '.vercel', 'coverage', '__MACOSX',
];

const DEFAULT_GLOB_IGNORES = ['*.log', '.DS_Store', 'Thumbs.db'];

// SECURITY: always excluded unless --include-env is passed.
const SECRET_GLOBS = [
  '.env', '.env.*', '*.pem', '*.key', '*.keystore', '*.p12',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '.npmrc', '.netrc', '.pypirc', 'credentials*.json', '*.pfx',
];
const SECRET_DIR_IGNORES = ['.aws', '.ssh', '.gnupg'];

/**
 * Convert a simple glob to a RegExp. Supports `*` (any chars except `/`),
 * `**` (any chars incl. `/`), and `?`.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** Parse a .gitignore file body into a list of usable patterns (subset). */
function parseGitignore(body) {
  const out = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Negation is not supported in this subset; skip to avoid wrongly including.
    if (line.startsWith('!')) continue;
    out.push(line.replace(/\/+$/, '')); // drop trailing slash (treat dir as name)
  }
  return out;
}

/**
 * Build a matcher: matcher(relPath) -> true if the path should be IGNORED.
 * relPath uses forward slashes and is relative to the zip root.
 *
 * @param {object} opts
 * @param {boolean} [opts.defaultIgnores=true]
 * @param {boolean} [opts.includeNodeModules=false]
 * @param {boolean} [opts.includeEnv=false]
 * @param {string[]} [opts.extraIgnores=[]]   user --ignore globs
 * @param {string[]} [opts.gitignorePatterns=[]]
 */
function createMatcher(opts = {}) {
  const {
    defaultIgnores = true,
    includeNodeModules = false,
    includeEnv = false,
    extraIgnores = [],
    gitignorePatterns = [],
  } = opts;

  const dirIgnores = new Set();
  const globIgnores = [];

  if (defaultIgnores) {
    for (const d of DEFAULT_DIR_IGNORES) dirIgnores.add(d);
    for (const g of DEFAULT_GLOB_IGNORES) globIgnores.push(g);
  }
  if (includeNodeModules) dirIgnores.delete('node_modules');

  // Secret layer (independent of defaultIgnores; only --include-env disables it).
  const secretDirs = new Set();
  const secretGlobs = [];
  if (!includeEnv) {
    for (const d of SECRET_DIR_IGNORES) secretDirs.add(d);
    for (const g of SECRET_GLOBS) secretGlobs.push(g);
  }

  // User + gitignore patterns: classify as path-globs (contain '/') vs name-globs.
  const pathGlobs = [];
  const nameGlobs = [];
  for (const p of [...extraIgnores, ...gitignorePatterns]) {
    if (!p) continue;
    const clean = p.replace(/^\.\//, '').replace(/^\/+/, '');
    if (clean.includes('/')) pathGlobs.push(globToRegExp(clean));
    else nameGlobs.push(globToRegExp(clean));
  }

  const allGlobRes = globIgnores.map(globToRegExp);
  const secretGlobRes = secretGlobs.map(globToRegExp);

  return function isIgnored(relPath) {
    const segments = relPath.split('/');
    const base = segments[segments.length - 1];

    // Any path segment matching a dir ignore (build junk or secret dir).
    for (const seg of segments) {
      if (dirIgnores.has(seg) || secretDirs.has(seg)) return true;
    }

    // Basename glob matches (junk + secrets + user/gitignore name globs).
    for (const re of allGlobRes) if (re.test(base)) return true;
    for (const re of secretGlobRes) if (re.test(base)) return true;
    for (const re of nameGlobs) if (re.test(base)) return true;

    // Full-path glob matches (user/gitignore patterns containing '/').
    for (const re of pathGlobs) if (re.test(relPath)) return true;

    return false;
  };
}

/** Best-effort: is this basename a likely secret (used for post-zip warnings)? */
function looksSecret(relPath) {
  const base = path.basename(relPath);
  return SECRET_GLOBS.map(globToRegExp).some((re) => re.test(base));
}

module.exports = {
  DEFAULT_DIR_IGNORES,
  DEFAULT_GLOB_IGNORES,
  SECRET_GLOBS,
  SECRET_DIR_IGNORES,
  globToRegExp,
  parseGitignore,
  createMatcher,
  looksSecret,
};
