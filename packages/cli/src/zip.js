'use strict';

/**
 * Smart folder -> zip. This is the core CLI capability: the user is in a codebase
 * and hasn't made a zip, so we build one for them with safe defaults.
 *
 * Guarantees:
 *   - NEVER follows symlinks (uses lstat) — a symlink to ~/.ssh can't leak files
 *     from outside the target folder.
 *   - Applies the default + secret + .gitignore ignore layers (see ignore.js).
 *   - Returns the full file manifest so `--dry-run` can disclose exactly what
 *     would be uploaded before any bytes leave the machine.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { createMatcher, parseGitignore } = require('./ignore');

/**
 * Recursively walk `root`, returning files relative to root. Skips symlinks and
 * ignored paths.
 * @returns {{ relPath: string, absPath: string, size: number }[]}
 */
function walk(root, isIgnored) {
  const results = [];

  function recurse(absDir, relDir) {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      return; // unreadable dir — skip
    }
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      // No symlink following (security).
      let lst;
      try { lst = fs.lstatSync(absPath); } catch (e) { continue; }
      if (lst.isSymbolicLink()) continue;

      if (isIgnored(relPath)) continue;

      if (lst.isDirectory()) {
        recurse(absPath, relPath);
      } else if (lst.isFile()) {
        results.push({ relPath, absPath, size: lst.size });
      }
      // ignore sockets/fifos/devices
    }
  }

  recurse(root, '');
  return results;
}

/**
 * Plan the zip: resolve the file manifest given options, WITHOUT writing anything.
 *
 * @param {string} root - absolute path to the folder to zip
 * @param {object} opts
 * @param {boolean} [opts.defaultIgnores=true]
 * @param {boolean} [opts.includeNodeModules=false]
 * @param {boolean} [opts.includeEnv=false]
 * @param {string[]} [opts.extraIgnores=[]]
 * @param {boolean} [opts.honorGitignore=true]
 * @param {number} [opts.maxAssetSizeBytes] - exclude individual files larger than this
 * @returns {{ files: {relPath,absPath,size}[], excludedLarge: {relPath,size}[], totalBytes: number }}
 */
function planZip(root, opts = {}) {
  const {
    defaultIgnores = true,
    includeNodeModules = false,
    includeEnv = false,
    extraIgnores = [],
    honorGitignore = true,
    maxAssetSizeBytes,
  } = opts;

  let gitignorePatterns = [];
  if (honorGitignore) {
    const giPath = path.join(root, '.gitignore');
    try {
      if (fs.existsSync(giPath)) {
        gitignorePatterns = parseGitignore(fs.readFileSync(giPath, 'utf8'));
      }
    } catch (_) { /* ignore unreadable .gitignore */ }
  }

  const isIgnored = createMatcher({
    defaultIgnores,
    includeNodeModules,
    includeEnv,
    extraIgnores,
    gitignorePatterns,
  });

  let files = walk(root, isIgnored);

  const excludedLarge = [];
  if (maxAssetSizeBytes && maxAssetSizeBytes > 0) {
    files = files.filter((f) => {
      if (f.size > maxAssetSizeBytes) {
        excludedLarge.push({ relPath: f.relPath, size: f.size });
        return false;
      }
      return true;
    });
  }

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  return { files, excludedLarge, totalBytes };
}

/**
 * Build the zip in-memory from a manifest.
 * @param {{relPath,absPath}[]} files
 * @returns {Buffer}
 */
function buildZipBuffer(files) {
  const zip = new AdmZip();
  for (const f of files) {
    // Preserve relative directory structure inside the zip.
    const dir = path.posix.dirname(f.relPath);
    zip.addLocalFile(f.absPath, dir === '.' ? '' : dir);
  }
  return zip.toBuffer();
}

/** Human-readable byte size. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

module.exports = { walk, planZip, buildZipBuffer, formatBytes };
