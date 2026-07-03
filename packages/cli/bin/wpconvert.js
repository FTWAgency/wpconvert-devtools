#!/usr/bin/env node
'use strict';

/**
 * wpconvert — convert a website/codebase folder into a WordPress theme from your
 * terminal. Wraps the same API the dashboard uses; auth via an API key.
 *
 *   wpconvert login
 *   wpconvert convert ./site --type theme
 *   wpconvert status <jobId>
 *   wpconvert download <jobId>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Command } = require('commander');

const config = require('../src/config');
const api = require('../src/api');
const { planZip, buildZipBuffer, formatBytes } = require('../src/zip');
const { detectSiteRoot, BUILD_DIRS } = require('../src/detect');

const MULTIPART_CAP_MB = 50; // server in-memory multer cap on POST /api/convert
const VALID_TYPES = ['theme']; // only "theme" is supported via the CLI for now
const COMING_SOON_TYPES = ['elementor', 'gutenberg']; // not available via CLI/API yet

const program = new Command();

// ----------------------------- output helpers ------------------------------
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const log = (...a) => console.log(...a);
const errOut = (...a) => console.error(...a);

function die(message, code = 1) {
  errOut(c.red('✖ ') + message);
  process.exit(code);
}

/** Render an ApiError with friendly, code-specific guidance. Never echoes the key. */
function renderApiError(e) {
  const d = e.details || {};
  switch (e.code) {
    case 'missing_credentials':
      return `${e.message}\nRun ${c.cyan('wpconvert login')} or set ${c.cyan('WPCONVERT_API_KEY')}.`;
    case 'invalid_api_key':
      return `Invalid or revoked API key. Create a new one in your dashboard, then ${c.cyan('wpconvert login')}.`;
    case 'email_not_verified':
      return 'Your account email is not verified. Verify it in the dashboard and try again.';
    case 'insufficient_credits':
      return `You're out of credits for this conversion.\n${d.buy_credits_url ? 'Buy credits / upgrade: ' + c.cyan(d.buy_credits_url) : ''}`;
    case 'quota_exceeded':
      return `Monthly quota exceeded.${d.buy_credits_url ? '\nBuy credits or wait for reset: ' + c.cyan(d.buy_credits_url) : ''}`;
    case 'upgrade_required':
      return `${e.message}${d.plan_needed ? ` (needs: ${d.plan_needed})` : ''}`;
    case 'rate_limited':
      return `Rate limited.${d.retry_after ? ` Retry in ~${d.retry_after}s.` : ' Please slow down.'}`;
    case 'too_many_active_jobs':
      return `You already have ${d.current ?? '?'}/${d.cap ?? '?'} conversions in progress. Wait for one to finish, then retry.`;
    case 'conversion_not_ready':
      return `Conversion is not ready yet (status: ${d.status || 'pending'}). Try again shortly.`;
    case 'not_found':
      return 'Conversion not found. Check the job ID.';
    case 'theme_expired':
      return 'This theme has expired and is no longer available for preview. Re-run the conversion to preview it again.';
    case 'theme_too_large_for_preview':
      return 'This theme is too large for in-browser preview (over 30MB). Download it and test on a WordPress install instead.';
    default:
      return e.message || 'Request failed.';
  }
}

function withErrorHandling(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e && e.name === 'ApiError') die(renderApiError(e));
      die(e && e.message ? e.message : String(e));
    }
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open a URL in the user's default browser (best-effort, cross-platform). */
function openInBrowser(targetUrl) {
  const { spawn } = require('child_process');
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', targetUrl] : [targetUrl];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* non-fatal — URL is already printed */ });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// ------------------------------- login --------------------------------------

/** Prompt for a secret without echoing keystrokes. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const stdout = process.stdout;
    rl.question(question, (answer) => {
      rl.close();
      stdout.write('\n');
      resolve(answer.trim());
    });
    // Mute echo.
    rl._writeToOutput = function (str) {
      if (str.includes(question)) stdout.write(question);
    };
  });
}

program
  .name('wpconvert')
  .description('Convert a website/codebase folder into a WordPress theme from your terminal.')
  .version(require('../package.json').version);

program
  .command('login')
  .description('Store your WPConvert API key locally (~/.wpconvert/config.json, mode 0600).')
  .option('--key <key>', 'API key (otherwise you will be prompted)')
  .option('--api-base <url>', 'Override API base URL (advanced)')
  .action(withErrorHandling(async (opts) => {
    let key = opts.key || process.env.WPCONVERT_API_KEY;
    if (!key) {
      key = await promptHidden('Paste your WPConvert API key (input hidden): ');
    }
    if (!key || !key.startsWith('wpc_live_')) {
      die('That does not look like a valid WPConvert API key (expected to start with "wpc_live_").');
    }
    const next = { apiKey: key };
    if (opts.apiBase) next.apiBase = opts.apiBase.replace(/\/+$/, '');
    const p = config.writeFileConfig(next);
    log(c.green('✔ ') + `API key saved to ${c.dim(p)} (mode 0600).`);
    log(c.dim('Tip: in CI, prefer the WPCONVERT_API_KEY env var instead of storing the key.'));
  }));

// ------------------------------- convert ------------------------------------

program
  .command('convert')
  .description('Convert a folder (default) or a URL (coming soon) into a WordPress theme.')
  .argument('<target>', 'path to a folder, or a URL (URL conversion not available yet)')
  .option('--type <type>', `export type: ${VALID_TYPES.join(' | ')} (Elementor/Gutenberg coming soon)`, 'theme')
  .option('--name <name>', 'project name (defaults to the folder name)')
  .option('--root <dir>', 'force a subdirectory to zip and skip auto-detection (e.g. --root dist)')
  .option('--dry-run', 'list the files that would be uploaded, then exit (no upload, no credit)')
  .option('--ignore <glob>', 'additional ignore glob (repeatable)', (v, acc) => { acc.push(v); return acc; }, [])
  .option('--no-default-ignores', 'do not apply the built-in build/junk ignores')
  .option('--include-node-modules', 'include node_modules (not recommended)')
  .option('--include-env', 'include .env / secret files (DANGER: uploads secrets)')
  .option('--no-gitignore', 'do not honor the folder\'s .gitignore')
  .option('--max-asset-size <mb>', 'exclude individual files larger than N MB (they won\'t render)')
  .option('--no-download', 'do not auto-download the result on success')
  .option('--out <dir>', 'directory to save the downloaded theme (default: cwd)')
  .action(withErrorHandling(async (target, opts) => {
    // URL conversion is wired server-side but unsupported in production yet.
    if (/^https?:\/\//i.test(target)) {
      die('URL conversion is not available yet. Point wpconvert at a folder instead, e.g. `wpconvert convert ./site`.');
    }

    const type = String(opts.type || 'theme').toLowerCase();
    if (COMING_SOON_TYPES.includes(type)) {
      die(`--type ${type} isn't available via the CLI yet — only "theme" is supported right now. Elementor and Gutenberg are coming soon.`);
    }
    if (!VALID_TYPES.includes(type)) {
      die(`Invalid --type "${type}". Use: ${VALID_TYPES.join(', ')}.`);
    }

    // Resolve the folder to zip.
    let root = path.resolve(process.cwd(), target);
    if (opts.root) root = path.resolve(root, opts.root);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      die(`Not a directory: ${root}`);
    }

    // Project name comes from what the user pointed at (not a build dir like "dist").
    let nameBase = path.basename(root.replace(/\/+$/, '')) || 'project';
    if (BUILD_DIRS.includes(nameBase)) {
      nameBase = path.basename(path.dirname(root)) || nameBase;
    }

    // Auto-detect the real site root (root vs dist/build/...) unless --root was
    // given explicitly, in which case we trust the user.
    if (!opts.root) {
      const detected = detectSiteRoot(root);
      if (!detected.root) die(detected.message);
      if (detected.note) log(c.cyan('› ') + detected.note);
      root = detected.root;
    }

    const projectName = opts.name || nameBase;
    const maxAssetSizeBytes = opts.maxAssetSize ? Math.round(parseFloat(opts.maxAssetSize) * 1024 * 1024) : undefined;

    // Plan the manifest (no bytes written yet).
    log(c.dim(`Scanning ${root} ...`));
    const { files, excludedLarge, totalBytes } = planZip(root, {
      defaultIgnores: opts.defaultIgnores !== false,
      includeNodeModules: !!opts.includeNodeModules,
      includeEnv: !!opts.includeEnv,
      extraIgnores: opts.ignore || [],
      honorGitignore: opts.gitignore !== false,
      maxAssetSizeBytes,
    });

    if (files.length === 0) {
      die('No files to upload after applying ignore rules. Check --no-default-ignores / --ignore.');
    }

    if (opts.includeEnv) {
      log(c.yellow('⚠ --include-env is set: secret files (.env, keys, credentials) WILL be uploaded.'));
    }
    if (excludedLarge.length) {
      log(c.yellow(`⚠ Excluding ${excludedLarge.length} file(s) larger than ${opts.maxAssetSize}MB (they will NOT render):`));
      for (const f of excludedLarge.slice(0, 10)) log(c.yellow(`    ${f.relPath} (${formatBytes(f.size)})`));
    }

    // --dry-run: disclose exactly what would be uploaded, then stop.
    if (opts.dryRun) {
      const top = [...files].sort((a, b) => b.size - a.size).slice(0, 25);
      log(c.bold(`\nWould upload ${files.length} files, ${formatBytes(totalBytes)} (uncompressed):`));
      for (const f of top) log(`  ${formatBytes(f.size).padStart(9)}  ${f.relPath}`);
      if (files.length > top.length) log(c.dim(`  ... and ${files.length - top.length} more`));
      log(c.dim('\nDry run only — nothing was uploaded and no credit was used.'));
      return;
    }

    // Build the zip.
    log(c.dim('Packaging zip ...'));
    const zipBuffer = buildZipBuffer(files);
    const zipMB = zipBuffer.length / (1024 * 1024);
    log(c.dim(`Zip built: ${formatBytes(zipBuffer.length)} compressed.`));

    // Elementor/Gutenberg aren't available via the CLI yet (guarded above), so
    // no Elementor options are sent.
    const elementor = undefined;

    // Route by size. Small -> multipart; large -> direct-to-storage.
    let submit;
    if (zipMB <= MULTIPART_CAP_MB) {
      log(c.dim('Uploading (multipart) and starting conversion ...'));
      submit = await api.convertMultipart(zipBuffer, { projectName, exportType: type, elementor });
    } else {
      log(c.dim('Large upload: requesting a direct upload URL ...'));
      const up = await api.getUploadUrl(); // { jobId, signedUrl, maxSizeMB, plan }
      if (up.maxSizeMB && zipMB > up.maxSizeMB) {
        die(
          `Your zip is ${zipMB.toFixed(1)}MB but your plan (${up.plan || 'current'}) allows up to ${up.maxSizeMB}MB.\n` +
          'Upgrade your plan, host large media on a CDN, or use --max-asset-size to drop the biggest files.\n' +
          c.dim('No credit was used.')
        );
      }
      log(c.dim('Uploading zip directly to storage (idempotent) ...'));
      await api.putToSignedUrl(up.signedUrl, zipBuffer);
      log(c.dim('Starting conversion ...'));
      submit = await api.createJobFromStorage(up.jobId, { projectName, exportType: type, elementor });
    }

    const jobId = submit.jobId || submit.project_id || submit.id;
    if (!jobId) die('Conversion started but no job ID was returned. Check the dashboard.');
    log(c.green('✔ ') + `Conversion queued: ${c.bold(jobId)}`);

    // Poll to completion with exponential backoff (cap 5s).
    const final = await pollUntilDone(jobId);

    if (final.status === 'failed') {
      die(`Conversion failed: ${final.error || 'unknown error'}`);
    }

    log(c.green('✔ ') + 'Conversion complete.');

    if (opts.download === false) {
      log(c.dim(`Skipping download (--no-download). Run: wpconvert download ${jobId}`));
      log(c.dim(`Preview in a browser:            wpconvert preview ${jobId} --open`));
      return;
    }
    await downloadResult(jobId, opts.out);
    log(c.dim(`Preview in a browser: wpconvert preview ${jobId} --open`));
  }));

/** Poll status until done/failed (or timeout). Returns the final status payload. */
async function pollUntilDone(jobId) {
  const start = Date.now();
  const maxMs = 25 * 60 * 1000; // a touch beyond the 20-min worker timeout
  let delay = 2000;
  let lastLine = '';
  while (true) {
    let s;
    try {
      s = await api.getStatus(jobId);
    } catch (e) {
      // Transient status errors (e.g. brief rate-limit) shouldn't abort polling.
      if (e.name === 'ApiError' && (e.code === 'rate_limited' || e.status >= 500)) {
        await sleep(Math.max(delay, (e.details && e.details.retry_after ? e.details.retry_after * 1000 : delay)));
        continue;
      }
      throw e;
    }

    const status = s.status || 'queued';
    if (status === 'done') { process.stdout.write('\n'); return s; }
    if (status === 'failed') { process.stdout.write('\n'); return s; }

    const pct = (s.progress != null) ? ` ${s.progress}%` : '';
    const line = `  ${c.dim('…')} ${status}${pct}`;
    if (line !== lastLine) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); process.stdout.write(line); lastLine = line; }

    if (Date.now() - start > maxMs) {
      process.stdout.write('\n');
      die(`Timed out waiting for conversion. Check later with: wpconvert status ${jobId}`);
    }
    await sleep(delay);
    delay = Math.min(delay + 1000, 5000);
  }
}

/** Resolve a download URL and save the theme zip to disk. */
async function downloadResult(jobId, outDir) {
  log(c.dim('Fetching download URL ...'));
  const info = await api.getDownload(jobId); // { download_url, name, ... }
  if (!info.download_url) die('No download URL available yet. Try again shortly.');

  const dir = outDir ? path.resolve(process.cwd(), outDir) : process.cwd();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fileName = info.name || `${jobId}-theme.zip`;
  const outPath = path.join(dir, fileName);

  const bytes = await api.fetchBinary(info.download_url);
  fs.writeFileSync(outPath, bytes);
  log(c.green('✔ ') + `Saved ${c.bold(fileName)} (${formatBytes(bytes.length)}) to ${c.dim(dir)}`);
}

// ------------------------------- status -------------------------------------

program
  .command('status')
  .description('Check the status of a conversion job.')
  .argument('<jobId>', 'job/project ID returned by `convert`')
  .action(withErrorHandling(async (jobId) => {
    const s = await api.getStatus(jobId);
    log(`${c.bold('Job')}      ${s.jobId || jobId}`);
    log(`${c.bold('Status')}   ${s.status}${s.progress != null ? ` (${s.progress}%)` : ''}`);
    if (s.project_name) log(`${c.bold('Project')}  ${s.project_name}`);
    if (s.status === 'done') log(`${c.bold('Download')} run: ${c.cyan(`wpconvert download ${s.project_id || jobId}`)}`);
    if (s.status === 'done' && s.preview_available) log(`${c.bold('Preview')}  run: ${c.cyan(`wpconvert preview ${s.project_id || jobId} --open`)}`);
    if (s.status === 'failed' && s.error) log(`${c.bold('Error')}    ${c.red(s.error)}`);
  }));

// ------------------------------ download ------------------------------------

program
  .command('download')
  .description('Download the result of a completed conversion.')
  .argument('<jobId>', 'job/project ID')
  .option('--out <dir>', 'directory to save the theme (default: cwd)')
  .action(withErrorHandling(async (jobId, opts) => {
    await downloadResult(jobId, opts.out);
  }));

// ------------------------------- preview ------------------------------------

program
  .command('preview')
  .description('Create a WordPress Playground preview of a completed conversion.')
  .argument('<jobId>', 'job/project ID returned by `convert`')
  .option('--open', 'open the preview URL in your default browser')
  .action(withErrorHandling(async (jobId, opts) => {
    // Confirm the job is finished before spending a preview session.
    const s = await api.getStatus(jobId);
    if (s.status === 'failed') die(`Conversion failed: ${s.error || 'unknown error'}`);
    if (s.status !== 'done') {
      die(`Conversion is not ready yet (status: ${s.status}). Wait until it is "done", then retry.`);
    }

    const session = await api.createPlaygroundSession(jobId);
    if (session.warning) log(c.yellow('! ') + session.warning);
    log(c.green('✔ ') + 'Preview ready (opens in WordPress Playground):');
    log('  ' + c.cyan(session.playground_url));
    if (session.expires_at) log(c.dim(`  Link expires ${new Date(session.expires_at).toLocaleString()} and is single-use limited.`));
    log(c.dim('  Anyone with this URL can view the theme until it expires — treat it as sensitive (avoid CI logs).'));

    if (opts.open) {
      const opened = openInBrowser(session.playground_url);
      if (opened) log(c.dim('  Opening in your default browser ...'));
    }
  }));

// ------------------------------- quota --------------------------------------

program
  .command('quota')
  .description('Show your available conversions / credits.')
  .action(withErrorHandling(async () => {
    const q = await api.getQuota();
    log(`${c.bold('Plan')}       ${q.effectivePlan || 'unknown'}`);
    log(`${c.bold('Used')}       ${q.current ?? '?'} / ${q.max ?? '?'}`);
    log(`${c.bold('Remaining')}  ${q.remaining ?? '?'}`);
    if (q.payg_credits != null) log(`${c.bold('PAYG')}       ${q.payg_credits} credit(s)`);
    if (q.unused_delta_entitlements) log(c.dim(`You have ${q.unused_delta_entitlements} unused upgrade reconversion(s).`));
  }));

program.parseAsync(process.argv);
