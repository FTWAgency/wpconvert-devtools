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
 *   wpconvert plans | unlock <jobId> | upgrade
 *
 * With no API key, `convert` offers a free guest preview: one browser check,
 * a few previews, no account. Buying happens with `unlock` / `upgrade`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Command } = require('commander');

const config = require('../src/config');
const api = require('../src/api');
const { generateIdempotencyKey, assertIdempotencyKey } = require('../src/idempotency');
const { planZip, buildZipBuffer, formatBytes } = require('../src/zip');
const { detectSiteRoot, BUILD_DIRS } = require('../src/detect');
const capabilities = require('../src/capabilities');
const device = require('../src/device');
const purchase = require('../src/purchase');

const MULTIPART_CAP_MB = 50; // server in-memory multer cap on POST /api/convert
const GUEST_UPLOAD_CAP_MB = 50; // Starter upload cap on POST /api/convert/cli-guest
const PAYMENT_WAIT_MS = 15 * 60 * 1000;
const PAYMENT_POLL_MS = 3000;
const EXIT_NEEDS_CHOICE = 2;
const VALID_TYPES = ['theme']; // only "theme" is supported via the CLI for now
const COMING_SOON_TYPES = ['elementor', 'gutenberg']; // not available via CLI/API yet
const PREVIEW_LOCKED_DOWNLOAD_COPY =
  'Download locked. Upgrade to PRO or add PAYG credits, then re-run this conversion to download theme.zip.';
/** Explicit capability denial (capabilities.conversion.can_start === false). */
const EXIT_ENTITLEMENT_DENIED = capabilities.EXIT_ENTITLEMENT_DENIED;

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
      if (d.preview_only || d.reason === 'dev_preview_limit' || d.reason === 'preview_only_job') {
        return PREVIEW_LOCKED_DOWNLOAD_COPY + (d.buy_credits_url ? `\nUpgrade / credits: ${c.cyan(d.buy_credits_url)}` : '');
      }
      return `${e.message}${d.plan_needed ? ` (needs: ${d.plan_needed})` : ''}`;
    case 'rate_limited':
      return `Rate limited.${d.retry_after ? ` Retry in ~${d.retry_after}s.` : ' Please slow down.'}`;
    case 'too_many_active_jobs':
      return `You already have ${d.current ?? '?'}/${d.cap ?? '?'} conversions in progress. Wait for one to finish, then retry.`;
    case 'idempotency_request_in_progress':
      return (
        'The conversion request was accepted but its job ID is not available yet. ' +
        'Retry this command shortly only if necessary.' +
        (d.retry_after ? ` (retry after ~${d.retry_after}s)` : '')
      );
    case 'idempotency_payload_mismatch':
      return 'Internal consistency error: this conversion reused an idempotency key with different request data. Please report this to WPConvert support.';
    case 'idempotency_previous_failed':
      return e.message || 'A previous conversion attempt with this idempotency key failed. Run a new `wpconvert convert` to try again.';
    case 'invalid_idempotency_key':
      return 'Internal CLI error: invalid idempotency key. Please update the WPConvert CLI and try again.';
    case 'network_error':
      if (d.hadTransportRetry) {
        return (
          `${e.message}\n` +
          'The server may have accepted the request. Do not rerun this command repeatedly — ' +
          'check recent projects in WPConvert or run `wpconvert status <jobId>` if you have a job ID.'
        );
      }
      return e.message || 'Network request failed.';
    case 'conversion_not_ready':
      return `Conversion is not ready yet (status: ${d.status || 'pending'}). Try again shortly.`;
    case 'not_found':
      return 'Conversion not found. Check the job ID.';
    case 'theme_expired':
      return 'This theme has expired and is no longer available for preview. Re-run the conversion to preview it again.';
    case 'theme_too_large_for_preview':
      return e.message || 'This theme is too large for in-browser preview. Download it and test on a WordPress install instead.';
    case 'guest_previews_used':
    case 'guest_token_expired':
    case 'guest_capacity':
    case 'guest_token_invalid':
      return e.message || `Guest previews are not available right now. Run ${c.cyan('wpconvert login')} to keep converting.`;
    case 'link_expired':
      return e.message;
    case 'key_limit_reached':
      return e.message || 'Your account has the maximum number of API keys. Revoke one in the dashboard, then run login again.';
    case 'already_subscribed':
      return `${e.message}${d.portal_url ? `\nManage your plan: ${c.cyan(d.portal_url)}` : ''}`;
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

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function confirm(question, defaultYes) {
  const answer = (await prompt(question)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** A person at a real terminal, who can answer prompts and use a browser. */
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

const deviceCtx = () => ({ log, isTTY: interactive(), env: process.env, open: openInBrowser });

function warnIfEnvKeyOverrides() {
  if (process.env.WPCONVERT_API_KEY) {
    log(c.yellow('! WPCONVERT_API_KEY is set in your environment and is used instead of the saved key. Unset it to use the key from this sign-in.'));
  }
}

/** Browser sign-in; the new key goes to the config file and is never printed. */
async function signInWithBrowser(reason) {
  if (process.env.CI) {
    die(`${reason}\nSet ${c.cyan('WPCONVERT_API_KEY')} in CI; browser sign-in needs a person.`);
  }
  if (reason) log(reason);
  const result = await device.loginWithBrowser(deviceCtx());
  log(c.green('✔ ') + `Signed in${result.email ? ` as ${c.bold(result.email)}` : ''}. API key saved to ${c.dim(config.configPath())} (mode 0600).`);
  if (result.previewScoped) {
    log(c.dim('Free account: conversions are previews until you buy. See `wpconvert plans`.'));
  }
  warnIfEnvKeyOverrides();
  return result;
}

program
  .name('wpconvert')
  .description('Convert a website/codebase folder into a WordPress theme from your terminal.')
  .version(require('../package.json').version);

program
  .command('login')
  .description('Sign in with your browser and save an API key locally (~/.wpconvert/config.json, mode 0600).')
  .option('--key <key>', 'save this API key instead of signing in with the browser')
  .option('--paste', 'paste an API key (input hidden) instead of signing in with the browser')
  .option('--api-base <url>', 'Override API base URL (advanced)')
  .action(withErrorHandling(async (opts) => {
    if (opts.apiBase) config.writeFileConfig({ apiBase: opts.apiBase.replace(/\/+$/, '') });
    let key = opts.key || process.env.WPCONVERT_API_KEY;
    if (!key && !opts.paste) {
      await signInWithBrowser();
      return;
    }
    if (!key) {
      key = await promptHidden('Paste your WPConvert API key (input hidden): ');
    }
    if (!key || !key.startsWith('wpc_live_')) {
      die('That does not look like a valid WPConvert API key (expected to start with "wpc_live_").');
    }
    const p = config.writeFileConfig({ apiKey: key, email: undefined });
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
  .option('--dry-run', 'list the files that would be uploaded, then exit (no upload, no credit, no quota check)')
  .option('--ignore <glob>', 'additional ignore glob (repeatable)', (v, acc) => { acc.push(v); return acc; }, [])
  .option('--no-default-ignores', 'do not apply the built-in build/junk ignores')
  .option('--include-node-modules', 'include node_modules (not recommended)')
  .option('--include-env', 'include .env / secret files (DANGER: uploads secrets)')
  .option('--no-gitignore', 'do not honor the folder\'s .gitignore')
  .option('--max-asset-size <mb>', 'exclude individual files larger than N MB (they won\'t render)')
  .option('--no-download', 'do not auto-download the result on success')
  .option('--no-preview', 'do not auto-create a Playground preview on success')
  .option('--open', 'open the Playground preview in your browser (paid users; preview-only jobs open by default)')
  .option('--no-open', 'do not auto-open the browser (preview-only jobs only; use in CI/headless)')
  .option('--out <dir>', 'directory to save the downloaded theme (default: cwd)')
  .option('--guest', 'with no API key, start a free guest preview without asking')
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
    // Local-only: no quota preflight, no auth, no idempotency key.
    if (opts.dryRun) {
      const top = [...files].sort((a, b) => b.size - a.size).slice(0, 25);
      log(c.bold(`\nWould upload ${files.length} files, ${formatBytes(totalBytes)} (uncompressed):`));
      for (const f of top) log(`  ${formatBytes(f.size).padStart(9)}  ${f.relPath}`);
      if (files.length > top.length) log(c.dim(`  ... and ${files.length - top.length} more`));
      log(c.dim('\nDry run only — nothing was uploaded and no credit was used.'));
      return;
    }

    if (!api.hasApiKey()) {
      await convertAsGuest(files, projectName, opts);
      return;
    }

    // Quota preflight (read-only). Trusts backend capabilities; never invents entitlement.
    // Inserted after dry-run and before ZIP build / idempotency-key generation.
    const preflight = await capabilities.resolveConvertPreflight(() => api.getQuota());
    if (preflight.outcome === 'auth_error') {
      throw preflight.error;
    }
    if (preflight.outcome === 'deny') {
      for (const line of capabilities.formatDenialMessage(preflight.quota)) {
        errOut(c.red('✖ ') + line);
      }
      process.exit(EXIT_ENTITLEMENT_DENIED);
    }
    if (preflight.outcome === 'warn_continue' && preflight.warning) {
      errOut(c.yellow('! ') + preflight.warning);
    }
    if (preflight.outcome === 'allow' && preflight.quota) {
      const summary = capabilities.formatPreflightSummary(preflight.quota);
      if (summary) log(c.dim(summary));
      const conv = capabilities.getConversionCapability(preflight.quota);
      if (conv && conv.mode === 'preview_only') {
        log(c.yellow(
          'This conversion will create a preview-only result. Download requires an upgrade or paid entitlement.'
        ));
      }
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
    const idempotencyKey = assertIdempotencyKey(generateIdempotencyKey());
    const conversionOpts = { projectName, exportType: type, elementor, idempotencyKey };
    let submit;
    if (zipMB <= MULTIPART_CAP_MB) {
      log(c.dim('Uploading (multipart) and starting conversion ...'));
      submit = await api.convertMultipart(zipBuffer, conversionOpts);
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
      submit = await api.createJobFromStorage(up.jobId, conversionOpts);
    }

    if (submit._hadTransportRetry) {
      log(c.yellow(
        '! Ambiguous network error during submission; retried once with the same idempotency key. ' +
        'If unsure whether the conversion started, check your WPConvert dashboard before rerunning.'
      ));
    }
    if (submit.idempotent_replay) {
      log(c.dim('Recovered existing conversion request.'));
    }

    const jobId = submit.jobId || submit.project_id || submit.id;
    if (!jobId) die('Conversion started but no job ID was returned. Check the dashboard.');
    log(c.green('✔ ') + `Conversion queued: ${c.bold(jobId)}`);

    if (submit.preview_only || submit.conversion_mode === 'preview_only') {
      const n = submit.free_dev_preview?.number;
      const lim = submit.free_dev_preview?.limit ?? 3;
      if (n != null) log(c.yellow(`Free developer preview ${n} of ${lim}.`));
      log(c.yellow(PREVIEW_LOCKED_DOWNLOAD_COPY));
    }

    // Poll to completion with exponential backoff (cap 5s).
    const final = await pollUntilDone(jobId);

    if (final.status === 'failed') {
      die(`Conversion failed: ${final.error || 'unknown error'}`);
    }

    log(c.green('✔ ') + 'Conversion complete.');

    await finishConversion(jobId, final, opts, {
      previewOnly: !!(submit.preview_only || submit.conversion_mode === 'preview_only'),
    });
  }));

/** A guest session that can still convert, activating one in the browser if needed. */
async function ensureGuestSession(opts) {
  const session = config.getGuestSession();
  if (config.guestCanConvert(session)) return session;
  const noKey = `No API key found. Run ${c.cyan('wpconvert login')} or set ${c.cyan('WPCONVERT_API_KEY')}`;
  if (process.env.CI) die(`${noKey}.`);
  if (!opts.guest) {
    if (!interactive()) die(`${noKey}, or add ${c.cyan('--guest')} for a free guest preview.`);
    const yes = await confirm('No API key found. Try a free guest preview (no account, a quick browser check)? [Y/n] ', true);
    if (!yes) die(`${noKey}.`);
  }
  const activated = await device.activateGuest(deviceCtx());
  const until = activated.convertUntil ? ` until ${new Date(activated.convertUntil).toLocaleString()}` : '';
  log(c.green('✔ ') + `Guest session ready: ${activated.budget ?? 'a few'} free previews${until}.`);
  return config.getGuestSession();
}

/** Guest path: preview only, no download; buying happens with `wpconvert unlock`. */
async function convertAsGuest(files, projectName, opts) {
  await ensureGuestSession(opts);

  log(c.dim('Packaging zip ...'));
  const zipBuffer = buildZipBuffer(files);
  const zipMB = zipBuffer.length / (1024 * 1024);
  log(c.dim(`Zip built: ${formatBytes(zipBuffer.length)} compressed.`));
  if (zipMB > GUEST_UPLOAD_CAP_MB) {
    die(
      `Your zip is ${zipMB.toFixed(1)}MB; guest previews accept up to ${GUEST_UPLOAD_CAP_MB}MB.\n` +
      `Sign in with ${c.cyan('wpconvert login')} for larger uploads, or use --max-asset-size to drop the biggest files.`
    );
  }

  log(c.dim('Uploading and starting your guest preview ...'));
  const submit = await api.convertGuest(zipBuffer, { projectName });
  const jobId = submit.jobId;
  if (!jobId) die('Conversion started but no job ID was returned.');
  log(c.green('✔ ') + `Guest conversion queued: ${c.bold(jobId)}`);
  if (submit.remaining_previews != null) {
    log(c.dim(`${submit.remaining_previews} guest preview${submit.remaining_previews === 1 ? '' : 's'} left.`));
  }

  const final = await pollUntilDone(jobId);
  if (final.status === 'failed') die(`Conversion failed: ${final.error || 'unknown error'}`);
  log(c.green('✔ ') + 'Conversion complete.');

  if (opts.preview !== false) {
    const open = !process.env.CI && opts.open !== false && interactive();
    await showPlaygroundPreview(jobId, { open });
    if (!open) log(c.dim(`Open in browser: ${c.cyan(`wpconvert preview ${jobId} --open`)}`));
  }
  log(c.yellow('Guest previews cannot be downloaded.'));
  log(`Like it? Buy this theme or pick a plan: ${c.cyan(`wpconvert unlock ${jobId}`)}`);
  log(c.dim('Guest conversions are kept for 7 days.'));
}

/** True for errors that are often transient during status polling (deploy restarts, local nodemon, etc.). */
function isTransientPollError(e) {
  if (!e) return false;
  if (e.name === 'ApiError') {
    if (e.code === 'rate_limited' || e.code === 'network_error') return true;
    if (e.code === 'invalid_api_key') return true;
    if (e.status >= 500) return true;
    return false;
  }
  const msg = String(e.message || e);
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(msg);
}

/** Poll status until done/failed (or timeout). Returns the final status payload. */
async function pollUntilDone(jobId) {
  const start = Date.now();
  const maxMs = 25 * 60 * 1000; // a touch beyond the 20-min worker timeout
  let delay = 2000;
  let lastLine = '';
  let transientRetries = 0;
  const maxTransientRetries = 8; // deploy restarts, local nodemon, brief API unavailability
  while (true) {
    let s;
    try {
      s = await api.getStatus(jobId);
      transientRetries = 0;
    } catch (e) {
      if (isTransientPollError(e) && transientRetries < maxTransientRetries) {
        transientRetries += 1;
        const retryAfter =
          e.name === 'ApiError' && e.details?.retry_after
            ? e.details.retry_after * 1000
            : Math.min(delay * transientRetries, 8000);
        await sleep(Math.max(delay, retryAfter));
        continue;
      }
      if (isTransientPollError(e)) {
        process.stdout.write('\n');
        die(
          'Lost connection to the API while polling (the conversion may still be running).\n' +
          `Check status: ${c.cyan(`wpconvert status ${jobId}`)}`
        );
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

/** Create a Playground session and print the preview URL (optionally open the browser). */
async function showPlaygroundPreview(jobId, { open = false } = {}) {
  log(c.dim('Creating Playground preview ...'));
  const session = await api.createPlaygroundSession(jobId);
  if (session.warning) log(c.yellow('! ') + session.warning);
  log(c.green('✔ ') + 'Preview ready (WordPress Playground):');
  log('  ' + c.cyan(session.playground_url));
  if (session.expires_at) {
    log(c.dim(`  Link expires ${new Date(session.expires_at).toLocaleString()} and is single-use limited.`));
  }
  log(c.dim('  Anyone with this URL can view the theme until it expires — treat it as sensitive (avoid CI logs).'));
  if (open) {
    const opened = openInBrowser(session.playground_url);
    if (opened) log(c.dim('  Opening in your default browser ...'));
  }
  return session;
}

/**
 * True when the job is a free developer preview-only API conversion.
 * Uses the final status payload, with submit-time hint as fallback (worker
 * completion used to overwrite metadata and drop preview_only before merge fix).
 */
function isPreviewOnlyJob(final, ctx = {}) {
  if (final.preview_only === true || final.conversion_mode === 'preview_only') return true;
  if (ctx.previewOnly === true) return true;
  return false;
}

/**
 * Preview-only API jobs auto-open the browser (the preview is the deliverable).
 * Paid/downloadable jobs print the URL only unless --open is passed.
 * Never auto-open in CI or when --no-open is set.
 */
function shouldOpenPlaygroundBrowser(final, opts, ctx = {}) {
  if (process.env.CI) return false;
  if (opts.noOpen) return false;
  if (opts.open) return true;
  return isPreviewOnlyJob(final, ctx);
}

/**
 * Post-conversion UX: preview-first when download is locked; otherwise download then preview.
 */
async function finishConversion(jobId, final, opts, ctx = {}) {
  const isPreviewOnly = isPreviewOnlyJob(final, ctx);
  const canDownload = final.download_available === true && !isPreviewOnly;

  if (isPreviewOnly) {
    log(c.yellow(PREVIEW_LOCKED_DOWNLOAD_COPY));
  } else if (!canDownload) {
    log(c.yellow('Download is locked on this plan. Use the Playground preview below.'));
  }

  if (canDownload && opts.download !== false) {
    await downloadResult(jobId, opts.out);
  }

  if (opts.preview !== false) {
    const openBrowser = shouldOpenPlaygroundBrowser(final, opts, ctx);
    await showPlaygroundPreview(jobId, { open: openBrowser });
    if (!openBrowser) {
      log(c.dim(`Open in browser: ${c.cyan(`wpconvert preview ${jobId} --open`)}`));
    }
  }

  if (isPreviewOnly) {
    log(c.dim('Upgrade to Pro/Agency or buy PAYG credits, then re-run convert to download theme.zip.'));
  }
}

// ------------------------------- status -------------------------------------

program
  .command('status')
  .description('Check the status of a conversion job.')
  .argument('<jobId>', 'job/project ID returned by `convert`')
  .action(withErrorHandling(async (jobId) => {
    const s = await api.getStatus(jobId);
    const id = s.project_id || s.jobId || jobId;
    const previewOnly = !!(s.preview_only || s.conversion_mode === 'preview_only');
    const canDownload = capabilities.jobIsDownloadable(s);

    log(`${c.bold('Job')}      ${s.jobId || jobId}`);
    log(`${c.bold('Status')}   ${s.status}${s.progress != null ? ` (${s.progress}%)` : ''}`);
    if (s.project_name) log(`${c.bold('Project')}  ${s.project_name}`);
    if (previewOnly) {
      log(`${c.bold('Mode')}     preview-only (download locked)`);
      log(c.yellow(PREVIEW_LOCKED_DOWNLOAD_COPY));
    } else if (s.download_available === false) {
      log(`${c.bold('Download')} unavailable for this result`);
    }
    // Prefer server job flags over any earlier preflight hint.
    if (s.status === 'done' && canDownload) {
      log(`${c.bold('Download')} run: ${c.cyan(`wpconvert download ${id}`)}`);
    }
    if (s.status === 'done') {
      log(`${c.bold('Preview')}  run: ${c.cyan(`wpconvert preview ${id} --open`)}`);
    }
    if (s.remaining_previews !== undefined) {
      log(`${c.bold('Guest')}    ${s.remaining_previews} preview${s.remaining_previews === 1 ? '' : 's'} left in this guest session`);
      if (s.status === 'done') log(`${c.bold('Unlock')}   run: ${c.cyan(`wpconvert unlock ${id}`)}`);
    }
    if (s.status === 'failed' && s.error) log(`${c.bold('Error')}    ${c.red(s.error)}`);
  }));

// ------------------------------ download ------------------------------------

program
  .command('download')
  .description('Download the result of a completed conversion.')
  .argument('<jobId>', 'job/project ID')
  .option('--out <dir>', 'directory to save the theme (default: cwd)')
  .action(withErrorHandling(async (jobId, opts) => {
    if (!api.hasApiKey() && config.getGuestSession()) {
      die(`Guest previews cannot be downloaded. Buy this theme or pick a plan: ${c.cyan(`wpconvert unlock ${jobId}`)}`);
    }
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

    await showPlaygroundPreview(jobId, { open: !!opts.open });
  }));

// ------------------------------- quota --------------------------------------

program
  .command('quota')
  .description('Show your available conversions / credits and next-conversion capabilities.')
  .option('--json', 'print the complete backend quota JSON response (no labels or colors)')
  .action(withErrorHandling(async (opts) => {
    const q = await api.getQuota();
    if (opts.json) {
      // Success path: stdout is JSON only. Failures go to stderr via withErrorHandling.
      process.stdout.write(`${JSON.stringify(q, null, 2)}\n`);
      return;
    }
    for (const line of capabilities.formatQuotaHuman(q)) {
      log(line);
    }
  }));

// ---------------------------- plans / buying --------------------------------

program
  .command('plans')
  .description('Show every paid option, what it includes, and today\'s price (no sign-in needed).')
  .action(withErrorHandling(async () => {
    const catalog = await api.getCatalog();
    for (const line of purchase.formatPlans(catalog)) log(line);
    log(c.dim(`Buy for a theme: ${c.cyan('wpconvert unlock <jobId>')}   Change plan or buy credits: ${c.cyan('wpconvert upgrade')}`));
  }));

const UNLOCK_BLOCKED = {
  not_ready: (id) => `This conversion has not finished yet. Check it with ${c.cyan(`wpconvert status ${id}`)}.`,
  already_unlocked: (id) => `This theme is already unlocked. Download it with ${c.cyan(`wpconvert download ${id}`)}.`,
  preview_only: () => `Free developer previews cannot be unlocked. Run ${c.cyan('wpconvert upgrade')}, then convert again for a downloadable theme.`,
  theme_missing: () => 'The theme file is no longer available. Run the conversion again.',
};

async function chooseOption(menu, opts) {
  const picked = purchase.pickFromFlags(menu, opts);
  if (picked.error) die(picked.error);
  if (picked.entry) return picked.entry;

  menu.forEach((e, i) => {
    log(`  ${c.bold(String(i + 1).padStart(2))}. ${e.label}  ${c.cyan(e.price)}`);
    if (e.note) log(`      ${c.dim(e.note)}`);
  });
  if (!interactive()) {
    errOut(`Choose with ${c.cyan('--starter')}, ${c.cyan('--pro')}, ${c.cyan('--agency')} or ${c.cyan('--payg <1|5|10|30>')} (add ${c.cyan('--yearly')} for yearly plans).`);
    errOut(c.dim(`See what each includes: ${c.cyan('wpconvert plans')}`));
    process.exit(EXIT_NEEDS_CHOICE);
  }
  const answer = await prompt(`Choose an option [1-${menu.length}]: `);
  const entry = menu[Number(answer) - 1];
  if (!entry) die('No option chosen. Nothing was charged.');
  return entry;
}

/** Wait for the existing Stripe webhook to land, then finish (download or summary). */
async function waitForPayment(jobId, beforeFingerprint, opts) {
  log(c.dim('Waiting for your payment (up to 15 minutes; Ctrl+C stops waiting, not the purchase) ...'));
  const deadline = Date.now() + PAYMENT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(PAYMENT_POLL_MS);
    try {
      if (jobId) {
        const s = await api.getStatus(jobId);
        if (s.download_available === true) {
          log(c.green('✔ ') + 'Payment received. Theme unlocked.');
          if (opts.download !== false) await downloadResult(jobId, opts.out);
          else log(`Download it with ${c.cyan(`wpconvert download ${jobId}`)}`);
          return;
        }
      } else {
        const q = await api.getQuota();
        if (purchase.quotaFingerprint(q) !== beforeFingerprint) {
          log(c.green('✔ ') + 'Payment received.');
          for (const line of capabilities.formatQuotaHuman(q)) log(line);
          return;
        }
      }
    } catch (e) {
      if (!isTransientPollError(e)) throw e;
    }
  }
  die(jobId
    ? `Didn't see a payment yet. Run ${c.cyan(`wpconvert status ${jobId}`)} after paying.`
    : `Didn't see a payment yet. Run ${c.cyan('wpconvert quota')} after paying.`);
}

async function runPurchase(jobId, opts) {
  if (!api.hasApiKey()) {
    await signInWithBrowser(jobId
      ? 'Buying needs a WPConvert account. Sign in or create one in your browser; your guest themes stay yours.'
      : 'Upgrading needs a WPConvert account. Sign in or create one in your browser.');
  }

  const options = await api.getCheckoutOptions(jobId);
  if (jobId && options.job && options.job.unlockable === false) {
    const explain = UNLOCK_BLOCKED[options.job.reason];
    die(explain ? explain(jobId) : 'This theme cannot be unlocked.');
  }
  const menu = purchase.buildMenu(options, { jobId });
  if (menu.length === 0) die('There is nothing to buy here right now.');

  const entry = await chooseOption(menu, opts);
  if (!opts.yes) {
    if (!interactive()) die(`Add ${c.cyan('--yes')} to confirm in a non-interactive shell.`);
    const ok = await confirm(`${purchase.confirmQuestion(entry)} [y/N] `, false);
    if (!ok) { log('Canceled. Nothing was charged.'); return; }
  }

  const before = jobId ? null : purchase.quotaFingerprint(await api.getQuota());
  const result = await api.createCheckout({ ...entry.request, ...(jobId ? { jobId } : {}) });
  const openLinks = interactive() && !process.env.CI && opts.open !== false;

  if (result.portal_url) {
    log(result.message || 'Manage your subscription in the billing portal:');
    log(`  ${c.cyan(result.portal_url)}`);
    if (openLinks) openInBrowser(result.portal_url);
    return;
  }
  if (Array.isArray(result.claimed) && result.claimed.length > 1) {
    log(c.dim(`Moved ${result.claimed.length} guest themes to your account.`));
  }
  log('Complete your payment in the browser:');
  log(`  ${c.cyan(result.checkout_url)}`);
  if (openLinks) {
    openInBrowser(result.checkout_url);
    log(c.dim('  Opening Stripe Checkout ...'));
  }
  await waitForPayment(jobId, before, opts);
}

const purchaseOptions = (cmd) => cmd
  .option('--starter', 'Starter: download this one theme (one-time)')
  .option('--pro', 'Pro plan (monthly unless --yearly)')
  .option('--agency', 'Agency plan (monthly unless --yearly)')
  .option('--payg <size>', 'pay-as-you-go credits: 1, 5, 10 or 30')
  .option('--yearly', 'yearly billing for --pro / --agency')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--no-open', 'print the checkout link instead of opening the browser')
  .option('--no-download', 'do not download the theme after payment')
  .option('--out <dir>', 'directory to save the theme after payment (default: cwd)');

purchaseOptions(program
  .command('unlock')
  .description('Buy this theme (Starter or credits) or a plan that unlocks it, then download it.')
  .argument('<jobId>', 'job/project ID returned by `convert`'))
  .action(withErrorHandling(async (jobId, opts) => {
    await runPurchase(jobId, opts);
  }));

purchaseOptions(program
  .command('upgrade')
  .description('Start a Pro or Agency plan, or buy pay-as-you-go credits.'))
  .action(withErrorHandling(async (opts) => {
    if (opts.starter) die(`Starter is for one theme. Use ${c.cyan('wpconvert unlock <jobId> --starter')}.`);
    await runPurchase(null, opts);
  }));

program.parseAsync(process.argv);
