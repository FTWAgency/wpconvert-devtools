#!/usr/bin/env node
/**
 * WPConvert MCP server.
 *
 * A thin Model Context Protocol wrapper around the SAME HTTP API + smart-zip
 * logic the `wpconvert` CLI uses. It lets an agent in Cursor/Claude convert the
 * current workspace folder into a WordPress theme without the user ever making a
 * zip.
 *
 * Auth: WPCONVERT_API_KEY env, or the key / guest session saved in
 * ~/.wpconvert/config.json (by `wpconvert login` or wpconvert_connect).
 * Optional WPCONVERT_API_BASE override.
 *
 * This file is the stdio shell: the transport, the tools that need this
 * machine, and credentials from the environment and config file. The API-only
 * tools are in shared/, which the hosted server (mcp.wpconvert.ai) reuses with
 * its own API client (docs/HOSTED_MCP_PLAN.md §2).
 *
 * Tools:
 *   - wpconvert_convert_folder   zip a folder + start a conversion (returns jobId)
 *   - wpconvert_check_status     poll a job's status (shared)
 *   - wpconvert_download_result  download a completed conversion to disk (API half shared)
 *   - wpconvert_create_preview   Playground link; expires after about ten minutes (shared)
 *   - wpconvert_explain_failure  return the failure reason for a failed job (shared)
 *   - wpconvert_quota            show remaining conversions / credits (shared; guest sessions here)
 *   - wpconvert_connect(_status) guest previews or browser sign-in, no key needed (account.mjs)
 *   - wpconvert_plans / wpconvert_checkout  show options, then pay for the user's choice (shared)
 *
 * NOTE: convert returns a jobId immediately rather than blocking; the agent should
 * poll wpconvert_check_status until status is "done", then download. (Conversions
 * can take several minutes.)
 */

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Attribute MCP requests before loading the shared API client.
process.env.WPCONVERT_CLIENT = `mcp/${pkg.version}`;

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Reuse the CLI's CJS modules (api client, smart-zip, ignore rules, idempotency).
const require = createRequire(import.meta.url);
const api = require('wpconvert/src/api');
const config = require('wpconvert/src/config');
const { planZip, buildZipBuffer, formatBytes } = require('wpconvert/src/zip');
const { detectSiteRoot, BUILD_DIRS } = require('wpconvert/src/detect');
const {
  MCP_KEY_PREFIX,
  KEY_PREFIX,
  MAX_KEY_LENGTH,
  generateIdempotencyKey,
  assertIdempotencyKey,
} = require('wpconvert/src/idempotency');
const { resolveConvertPreflight } = require('wpconvert/src/capabilities');
import {
  buildConversionDenial,
  formatAllowSummary,
  TOOL_STATUS,
  STATUS_POLL_SECONDS,
} from './shared/capabilities.mjs';
import { ok, fail, redactSecrets } from './shared/result.mjs';
import {
  CHECK_STATUS_TOOL,
  CREATE_PREVIEW_TOOL,
  EXPLAIN_FAILURE_TOOL,
  QUOTA_TOOL,
  PLANS_TOOL,
  CHECKOUT_TOOL,
} from './shared/tools.mjs';
import {
  createSharedHandlers,
  describeApiError,
  PREVIEW_LOCKED_DOWNLOAD_COPY,
  GUEST_DOWNLOAD_COPY,
} from './shared/handlers.mjs';
import { CONNECT_TOOLS, handleConnectCall, connectionSummary, _internals as accountInternals } from './account.mjs';

const MULTIPART_CAP_MB = 50;
const GUEST_CAP_MB = 50;
const VALID_TYPES = ['theme'];
const COMING_SOON_TYPES = ['elementor', 'gutenberg'];
// Elementor exports are a dashboard feature; Gutenberg is not available anywhere yet.
const ELEMENTOR_DASHBOARD_URL = 'https://app.wpconvert.ai/dashboard?convert=elementor';
function unavailableTypeMessage(type) {
  return type === 'elementor'
    ? `"elementor" isn't available through MCP, which makes WordPress themes. Elementor exports are made in the WPConvert dashboard: ${ELEMENTOR_DASHBOARD_URL}`
    : `"${type}" conversions aren't available yet — only "theme" is supported. Gutenberg export is coming soon.`;
}

// The API client and account check the shared handlers use: here, the key or
// guest session from WPCONVERT_API_KEY / ~/.wpconvert/config.json.
const shared = createSharedHandlers({ api, hasAccount: () => api.hasApiKey() });

const TOOLS = [
  {
    name: 'wpconvert_convert_folder',
    description:
      'Zip a local folder (excluding node_modules, build output, and secrets by default) and start a WordPress theme conversion. Call wpconvert_quota first to review capabilities (mode, credits, download availability). Returns a jobId and an idempotency_key. Leave idempotency_key blank for a new intentional conversion. If a prior call may have timed out or returned an ambiguous network error, retry with the exact idempotency_key returned by that prior call — do not omit it and do not invent a new one. Do not reuse a key for changed files, options, or a deliberate new conversion. Once you have a jobId, poll wpconvert_check_status until "done", then follow recommended_next for download or preview. Without an API key it uses the guest session from wpconvert_connect (free previews, up to 50MB zipped); with neither it returns recommended_next wpconvert_connect.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the folder to convert.' },
        type: { type: 'string', enum: VALID_TYPES, description: 'Export type. Only "theme" is supported right now.' },
        name: { type: 'string', description: 'Project name (defaults to folder name).' },
        maxAssetSizeMB: { type: 'number', description: 'Exclude individual files larger than this many MB.' },
        includeEnv: { type: 'boolean', description: 'DANGER: include .env / secret files (default false).' },
        idempotency_key: {
          type: 'string',
          maxLength: MAX_KEY_LENGTH,
          description:
            'Leave blank for a new intentional conversion. If a prior call may have timed out or returned an ambiguous network error, retry with the exact idempotency_key returned by that prior call. Do not reuse a key for changed files, options, or a deliberate new conversion.',
        },
      },
      required: ['path'],
    },
  },
  CHECK_STATUS_TOOL,
  {
    name: 'wpconvert_download_result',
    description:
      'Download a completed conversion to disk. Only use when wpconvert_check_status shows download_available and recommended_next is wpconvert_download_result. Returns the saved file path. For preview-only jobs, use wpconvert_create_preview or upgrade and re-convert instead.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        outDir: { type: 'string', description: 'Directory to save into (default: current directory).' },
      },
      required: ['jobId'],
    },
  },
  CREATE_PREVIEW_TOOL,
  EXPLAIN_FAILURE_TOOL,
  QUOTA_TOOL,
  ...CONNECT_TOOLS,
  PLANS_TOOL,
  CHECKOUT_TOOL,
];

/**
 * Validate a caller-supplied idempotency key without generating one.
 */
function validateSuppliedIdempotencyKey(args) {
  const raw = args && args.idempotency_key;
  if (raw == null || String(raw).trim() === '') return null;
  return assertIdempotencyKey(String(raw), {
    allowedPrefixes: [MCP_KEY_PREFIX, KEY_PREFIX],
  });
}

/**
 * Resolve the idempotency key for one convert_folder invocation.
 * Caller-provided keys are used unchanged; otherwise generate once.
 */
function resolveIdempotencyKey(args) {
  const raw = args && args.idempotency_key;
  if (raw != null && String(raw).trim() !== '') {
    return {
      key: assertIdempotencyKey(String(raw), {
        allowedPrefixes: [MCP_KEY_PREFIX, KEY_PREFIX],
      }),
      generated: false,
    };
  }
  return {
    key: generateIdempotencyKey(MCP_KEY_PREFIX),
    generated: true,
  };
}

function successPayload({ jobId, projectId, status, idempotencyKey, replay, nextAction, recommendedNext, extras = {} }) {
  return {
    job_id: jobId,
    project_id: projectId || jobId,
    status: status || 'queued',
    idempotency_key: idempotencyKey,
    idempotent_replay: !!replay,
    next_action: nextAction,
    recommended_next: recommendedNext,
    ...extras,
  };
}

function errorPayload({ code, message, retrySafe, reuseKey, idempotencyKey, extras = {} }) {
  return {
    error: {
      code,
      message,
      retry_safe: !!retrySafe,
      reuse_idempotency_key: !!reuseKey,
      ...extras,
    },
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
}

function convertSubmissionError(e, idempotencyKey) {
  const code = e && e.code;
  const msg = redactSecrets((e && e.message) || 'Request failed.');
  const d = (e && e.details) || {};

  switch (code) {
    case 'idempotency_request_in_progress':
      return fail(
        'The conversion request was accepted but its job ID is not available yet. ' +
          'Retry wpconvert_convert_folder with the exact same idempotency_key after a short interval. ' +
          'Do not omit the key and do not generate a new one.',
        errorPayload({
          code: 'idempotency_request_in_progress',
          message: msg,
          retrySafe: true,
          reuseKey: true,
          idempotencyKey,
          extras: d.retry_after != null ? { retry_after: d.retry_after } : {},
        })
      );

    case 'idempotency_payload_mismatch':
      return fail(
        'This idempotency_key was already used for different request material (files or options). ' +
          'Do not reuse it for changed inputs. For a deliberate new conversion, call wpconvert_convert_folder without the old key.',
        errorPayload({
          code: 'idempotency_payload_mismatch',
          message: msg,
          retrySafe: false,
          reuseKey: false,
          idempotencyKey,
        })
      );

    case 'idempotency_previous_failed':
      return fail(
        'A previous conversion attempt with this idempotency_key failed. ' +
          'That key permanently identifies the failed attempt. ' +
          'For a deliberate new conversion, call wpconvert_convert_folder without that key.',
        errorPayload({
          code: 'idempotency_previous_failed',
          message: msg,
          retrySafe: false,
          reuseKey: false,
          idempotencyKey,
        })
      );

    case 'invalid_idempotency_key':
      return fail(
        'Invalid idempotency_key. Provide a valid key from a prior convert result, or omit the field for a new conversion.',
        errorPayload({
          code: 'invalid_idempotency_key',
          message: msg,
          retrySafe: false,
          reuseKey: false,
          idempotencyKey,
        })
      );

    case 'network_error':
      return fail(
        'Ambiguous network error during conversion submission. The backend may have accepted the request. ' +
          'Retry wpconvert_convert_folder with the exact same idempotency_key and unchanged parameters. ' +
          'Do not create a new conversion with a different key.',
        errorPayload({
          code: 'network_error',
          message: msg,
          retrySafe: true,
          reuseKey: true,
          idempotencyKey,
        })
      );

    default:
      return fail(redactSecrets(renderApiError(e)), errorPayload({
        code: code || 'error',
        message: msg,
        retrySafe: false,
        reuseKey: false,
        idempotencyKey,
      }));
  }
}

async function convertFolder(args) {
  const target = args.path;
  if (!target) return fail('A folder "path" is required.');
  let root = path.resolve(process.cwd(), target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return fail(`Not a directory: ${root}`);
  }
  const type = (args.type || 'theme').toLowerCase();
  if (COMING_SOON_TYPES.includes(type)) {
    return fail(unavailableTypeMessage(type));
  }
  if (!VALID_TYPES.includes(type)) return fail(`Invalid type "${type}". Use: ${VALID_TYPES.join(', ')}.`);

  let validatedKey;
  try {
    validatedKey = validateSuppliedIdempotencyKey(args);
  } catch (e) {
    const supplied = args.idempotency_key != null ? String(args.idempotency_key).slice(0, MAX_KEY_LENGTH) : undefined;
    return fail(
      'Invalid idempotency_key. Provide a valid key from a prior convert result (max 128 printable ASCII characters), or omit the field for a new conversion.',
      errorPayload({
        code: 'invalid_idempotency_key',
        message: 'invalid_idempotency_key',
        retrySafe: false,
        reuseKey: false,
        idempotencyKey: supplied,
      })
    );
  }

  // Project name from what was pointed at (not a build dir like "dist").
  let nameBase = path.basename(root.replace(/\/+$/, '')) || 'project';
  if (BUILD_DIRS.includes(nameBase)) nameBase = path.basename(path.dirname(root)) || nameBase;

  // Auto-detect the real site root (root vs dist/build/...). On a project that
  // needs building (or has no site), return a clear message so the agent can
  // relay it to the user instead of uploading the wrong thing.
  const detected = detectSiteRoot(root);
  if (!detected.root) return fail(detected.message);
  const detectNote = detected.note ? `${detected.note}\n` : '';
  root = detected.root;

  const projectName = args.name || nameBase;
  const maxAssetSizeBytes = args.maxAssetSizeMB ? Math.round(args.maxAssetSizeMB * 1024 * 1024) : undefined;

  const { files, excludedLarge, totalBytes } = planZip(root, {
    includeEnv: !!args.includeEnv,
    maxAssetSizeBytes,
  });
  if (files.length === 0) return fail('No files to upload after applying ignore rules.');

  if (!api.hasApiKey()) {
    return convertAsGuest({ files, totalBytes, excludedLarge, projectName, detectNote });
  }

  const preflight = await resolveConvertPreflight(() => api.getQuota());

  if (preflight.outcome === 'auth_error') {
    return fail(redactSecrets(renderApiError(preflight.error)), errorPayload({
      code: (preflight.error && preflight.error.code) || 'auth_error',
      message: redactSecrets((preflight.error && preflight.error.message) || 'Authentication failed.'),
      retrySafe: false,
      reuseKey: false,
      idempotencyKey: validatedKey || undefined,
    }));
  }

  if (preflight.outcome === 'deny') {
    const denial = buildConversionDenial(preflight.quota);
    return fail(
      denial.error.message + '\nCall wpconvert_quota to review capabilities and recommended action.',
      denial
    );
  }

  const preflightNote = preflight.outcome === 'allow'
    ? (formatAllowSummary(preflight.quota) ? `${formatAllowSummary(preflight.quota)}\n` : '')
    : '';
  const preflightWarning = preflight.warning ? `${preflight.warning}\n` : '';

  const idempotencyKey = validatedKey ?? generateIdempotencyKey(MCP_KEY_PREFIX);

  const zipBuffer = buildZipBuffer(files);
  const zipMB = zipBuffer.length / (1024 * 1024);
  const elementor = undefined; // Elementor/Gutenberg not available via MCP yet (guarded above)
  const conversionOpts = { projectName, exportType: type, elementor, idempotencyKey };

  let submit;
  try {
    if (zipMB <= MULTIPART_CAP_MB) {
      submit = await api.convertMultipart(zipBuffer, conversionOpts);
    } else {
      const up = await api.getUploadUrl();
      if (up.maxSizeMB && zipMB > up.maxSizeMB) {
        return fail(`Zip is ${zipMB.toFixed(1)}MB but your plan (${up.plan || 'current'}) allows up to ${up.maxSizeMB}MB. No credit was used.`);
      }
      await api.putToSignedUrl(up.signedUrl, zipBuffer);
      submit = await api.createJobFromStorage(up.jobId, conversionOpts);
    }
  } catch (e) {
    if (e && e.name === 'ApiError') return convertSubmissionError(e, idempotencyKey);
    throw e;
  }

  const jobId = submit.jobId || submit.project_id || submit.id;
  if (!jobId) {
    return fail(
      'Conversion started but no job ID was returned. Retry wpconvert_convert_folder with the exact same idempotency_key.',
      errorPayload({
        code: 'missing_job_id',
        message: 'Conversion started but no job ID was returned.',
        retrySafe: true,
        reuseKey: true,
        idempotencyKey,
      })
    );
  }

  const replay = !!submit.idempotent_replay;
  const warn = excludedLarge.length ? ` (excluded ${excludedLarge.length} large file(s))` : '';
  const previewOnly = !!(submit.preview_only || submit.conversion_mode === 'preview_only');
  const previewNote = previewOnly
    ? `\nFree developer preview${submit.free_dev_preview?.number != null ? ` ${submit.free_dev_preview.number} of ${submit.free_dev_preview.limit ?? 3}` : ''}.\n${PREVIEW_LOCKED_DOWNLOAD_COPY}\nWhen done, call wpconvert_create_preview (download requires upgrade + re-convert).`
    : '';

  const nextAction = replay
    ? 'Continue checking the existing job; do not submit another conversion.'
    : 'Call wpconvert_check_status with the job ID.';

  const recommendedNext = {
    tool: TOOL_STATUS,
    reason: 'Conversion submitted. Poll wpconvert_check_status until done.',
    retry_after_seconds: STATUS_POLL_SECONDS,
  };

  const text =
    detectNote +
    preflightWarning +
    preflightNote +
    (replay
      ? `Recovered existing conversion request. jobId=${jobId}\n`
      : `Conversion queued. jobId=${jobId}\n`) +
    `Zipped ${files.length} files (${formatBytes(totalBytes)} uncompressed)${warn}.\n` +
    (replay
      ? 'Continue with wpconvert_check_status for this jobId — do not submit another conversion.'
      : 'Poll wpconvert_check_status with this jobId until status is "done", then follow recommended_next for download or preview.') +
    previewNote;

  return ok(
    text,
    successPayload({
      jobId,
      projectId: submit.project_id || jobId,
      status: submit.status || 'queued',
      idempotencyKey,
      replay,
      nextAction,
      recommendedNext,
      extras: previewOnly
        ? {
            preview_only: true,
            conversion_mode: 'preview_only',
            free_dev_preview: submit.free_dev_preview || null,
          }
        : {},
    })
  );
}

const MISSING_CREDENTIALS_COPY =
  'No API key or guest session. Call wpconvert_connect with kind "guest" for free previews without an account, or "login" to sign in to WPConvert. ' +
  'Set WPCONVERT_API_KEY in the MCP server environment to use an existing key instead.';

/**
 * Guest conversion: one free preview per upload, so it is never retried
 * (a retry after an ambiguous failure could spend two).
 */
async function convertAsGuest({ files, totalBytes, excludedLarge, projectName, detectNote }) {
  const session = config.getGuestSession();
  if (!session) {
    return fail(MISSING_CREDENTIALS_COPY, {
      ok: false,
      error: { code: 'missing_credentials', message: 'No API key or guest session.', retry_safe: false },
      recommended_next: { tool: 'wpconvert_connect', arguments: { kind: 'guest' }, reason: 'Start a free guest preview (the user confirms once in the browser).' },
    });
  }
  if (!config.guestCanConvert(session)) {
    return fail('This guest session can no longer start conversions. Earlier guest previews can still be bought with wpconvert_plans; to keep converting, sign in with wpconvert_connect kind "login".', {
      ok: false,
      error: { code: 'guest_token_expired', message: 'Guest convert window ended.', retry_safe: false },
      recommended_next: { tool: 'wpconvert_connect', arguments: { kind: 'login' }, reason: 'Sign in to keep converting.' },
    });
  }

  const zipBuffer = buildZipBuffer(files);
  const zipMB = zipBuffer.length / (1024 * 1024);
  if (zipMB > GUEST_CAP_MB) {
    return fail(`Zip is ${zipMB.toFixed(1)}MB; guest previews accept up to ${GUEST_CAP_MB}MB. No preview was used. Exclude large files (maxAssetSizeMB) or sign in with wpconvert_connect kind "login".`);
  }

  let submit;
  try {
    submit = await api.convertGuest(zipBuffer, { projectName });
  } catch (e) {
    if (e && e.name === 'ApiError') {
      const message = redactSecrets(renderApiError(e));
      const ambiguous = e.code === 'network_error';
      return fail(
        ambiguous
          ? `${message}\nThe upload may have been accepted. Do not retry automatically, since each guest upload uses a preview; ask the user first.`
          : message,
        {
          ok: false,
          error: { code: e.code || 'error', message, retry_safe: false },
          recommended_next: e.code && e.code.startsWith('guest_')
            ? { tool: 'wpconvert_connect', arguments: { kind: 'login' }, reason: 'Sign in to keep converting.' }
            : undefined,
        }
      );
    }
    throw e;
  }

  const jobId = submit.jobId || submit.project_id || submit.id;
  const remaining = Number.isInteger(submit.remaining_previews) ? submit.remaining_previews : null;
  const warn = excludedLarge.length ? ` (excluded ${excludedLarge.length} large file(s))` : '';
  const text =
    detectNote +
    `Guest preview queued. jobId=${jobId}\n` +
    `Zipped ${files.length} files (${formatBytes(totalBytes)} uncompressed)${warn}.\n` +
    `${remaining != null ? `${remaining} free preview(s) left. ` : ''}Guest conversions can be previewed, not downloaded, until bought.\n` +
    'Poll wpconvert_check_status with this jobId until status is "done", then call wpconvert_create_preview.';
  return ok(text, {
    job_id: jobId,
    project_id: jobId,
    status: submit.status || 'queued',
    guest: true,
    preview_only: true,
    remaining_previews: remaining,
    next_action: 'Call wpconvert_check_status with the job ID.',
    recommended_next: { tool: TOOL_STATUS, reason: 'Guest preview submitted. Poll wpconvert_check_status until done.', retry_after_seconds: STATUS_POLL_SECONDS },
  });
}

function guestDownloadDenied(jobId) {
  return fail(GUEST_DOWNLOAD_COPY, {
    ok: false,
    error: { code: 'upgrade_required', message: GUEST_DOWNLOAD_COPY, reason: 'guest_preview', retry_safe: false },
    recommended_next: { tool: 'wpconvert_plans', arguments: { jobId }, reason: 'Show the user the ways to unlock this theme.' },
  });
}

/** Local wording for credential, guest and submission errors; shared wording for the rest. */
function renderApiError(e) {
  switch (e && e.code) {
    case 'missing_credentials':
      return MISSING_CREDENTIALS_COPY;
    case 'guest_previews_used':
    case 'guest_token_expired':
    case 'guest_capacity':
    case 'guest_token_invalid':
      return `${e.message || 'Guest previews are not available right now.'} To keep converting, sign in with wpconvert_connect kind "login".`;
    case 'link_expired':
      return 'The link expired. Call wpconvert_connect again for a new one.';
    case 'key_limit_reached':
      return e.message || 'This account has the maximum number of API keys. Revoke one in the WPConvert dashboard, then connect again.';
    case 'invalid_api_key':
      return 'Invalid or revoked API key.';
    case 'idempotency_request_in_progress':
      return 'The conversion request was accepted but its job ID is not available yet. Retry wpconvert_convert_folder with the same idempotency_key.';
    case 'idempotency_payload_mismatch':
      return 'This idempotency_key was already used for different request material. Omit the key for a deliberate new conversion.';
    case 'idempotency_previous_failed':
      return 'A previous conversion attempt with this idempotency_key failed. Omit the key for a deliberate new conversion.';
    case 'invalid_idempotency_key':
      return 'Invalid idempotency_key. Provide a prior convert result key, or omit the field for a new conversion.';
    case 'network_error':
      return 'Ambiguous network error. Retry wpconvert_convert_folder with the same idempotency_key if one was returned.';
    default:
      return describeApiError(e);
  }
}

/** Save a ready download to disk; the API half (not ready, locked to previews) is shared. */
async function downloadResult(args) {
  if (!api.hasApiKey() && config.getGuestSession()) return guestDownloadDenied(args.jobId);
  return shared.downloadResult(args.jobId, {
    async deliver(info) {
      const dir = args.outDir ? path.resolve(process.cwd(), args.outDir) : process.cwd();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = info.name || `${args.jobId}-theme.zip`;
      const outPath = path.join(dir, fileName);
      const bytes = await api.fetchBinary(info.download_url);
      fs.writeFileSync(outPath, bytes);
      return ok(`Saved ${fileName} (${formatBytes(bytes.length)}) to ${outPath}`, {
        ok: true,
        job_id: args.jobId,
        path: outPath,
        size_bytes: bytes.length,
      });
    },
    onError(e) {
      if (e && e.name === 'ApiError' && e.status === 404 && config.getGuestSession()) return guestDownloadDenied(args.jobId);
      return null;
    },
  });
}

/** A guest session's quota is in the config file; an account's comes from the API. */
async function quota() {
  if (!api.hasApiKey()) {
    const summary = connectionSummary();
    if (summary.mode === 'guest') {
      const left = summary.remaining_previews != null ? `${summary.remaining_previews} free preview(s) left` : 'free previews';
      return ok(
        `Guest session: ${left}${summary.can_convert ? `, converting until ${summary.convert_until}` : '; the convert window has ended'}. ` +
          'Guest conversions can be previewed, not downloaded, until bought (wpconvert_plans).',
        {
          ok: true,
          ...summary,
          recommended_next: summary.can_convert && summary.remaining_previews !== 0
            ? { tool: 'wpconvert_convert_folder', reason: 'Guest previews available.' }
            : { tool: 'wpconvert_connect', arguments: { kind: 'login' }, reason: 'Sign in to keep converting.' },
        }
      );
    }
  }
  return shared.quota();
}

async function handleCall(name, args) {
  api.setRequestExtras({ tool: name });
  const connect = await handleConnectCall(name, args);
  if (connect) return connect;
  switch (name) {
    case 'wpconvert_convert_folder':
      return convertFolder(args);

    case 'wpconvert_download_result':
      return downloadResult(args);

    case 'wpconvert_quota':
      return quota();

    default:
      return (await shared.handleSharedCall(name, args)) || fail(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: 'wpconvert-mcp', version: pkg.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleCall(name, args || {});
    } catch (e) {
      if (e && e.name === 'ApiError') return fail(redactSecrets(renderApiError(e)));
      return fail(redactSecrets(e && e.message ? e.message : String(e)));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr is safe for logs (stdout is the MCP transport). Never log idempotency keys or API keys.
  console.error('wpconvert-mcp server running on stdio');
}

export {
  TOOLS,
  convertFolder,
  handleCall,
  resolveIdempotencyKey,
  renderApiError,
  redactSecrets,
  convertSubmissionError,
  successPayload,
  errorPayload,
  ok,
  fail,
  accountInternals as _internals,
};

// npx runs node_modules/.bin/wpconvert-mcp, a symlink, so compare real paths.
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((e) => {
    console.error('Fatal:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
