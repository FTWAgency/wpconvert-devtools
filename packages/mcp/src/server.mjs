#!/usr/bin/env node
/**
 * WPConvert MCP server.
 *
 * A thin Model Context Protocol wrapper around the SAME HTTP API + smart-zip
 * logic the `wpconvert` CLI uses. It lets an agent in Cursor/Claude convert the
 * current workspace folder into a WordPress theme without the user ever making a
 * zip.
 *
 * Auth: WPCONVERT_API_KEY env (required). Optional WPCONVERT_API_BASE override.
 *
 * Tools:
 *   - wpconvert_convert_folder   zip a folder + start a conversion (returns jobId)
 *   - wpconvert_check_status     poll a job's status
 *   - wpconvert_download_result  download a completed conversion to disk
 *   - wpconvert_explain_failure  return the failure reason for a failed job
 *   - wpconvert_quota            show remaining conversions / credits
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
  projectQuotaResponse,
  projectStatusResponse,
  buildConversionDenial,
  formatQuotaText,
  formatAllowSummary,
  recommendedNextForStatus,
  TOOL_STATUS,
  STATUS_POLL_SECONDS,
} from './capabilities.mjs';

const MULTIPART_CAP_MB = 50;
const VALID_TYPES = ['theme'];
const COMING_SOON_TYPES = ['elementor', 'gutenberg'];
const PREVIEW_LOCKED_DOWNLOAD_COPY =
  'Download locked. Upgrade to PRO or add PAYG credits, then re-run this conversion to download theme.zip.';

function ok(text, data) {
  const body = data ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: 'text', text: body }] };
}

function fail(text, data) {
  const body = data ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text;
  return { content: [{ type: 'text', text: body }], isError: true };
}

function redactSecrets(text) {
  if (!text) return text;
  return String(text)
    .replace(/wpc_live_[A-Za-z0-9_-]+/g, '[redacted-api-key]')
    .replace(/WPCONVERT_API_KEY[=:\s]+\S+/gi, 'WPCONVERT_API_KEY=[redacted]');
}

const TOOLS = [
  {
    name: 'wpconvert_convert_folder',
    description:
      'Zip a local folder (excluding node_modules, build output, and secrets by default) and start a WordPress theme conversion. Call wpconvert_quota first to review capabilities (mode, credits, download availability). Returns a jobId and an idempotency_key. Leave idempotency_key blank for a new intentional conversion. If a prior call may have timed out or returned an ambiguous network error, retry with the exact idempotency_key returned by that prior call — do not omit it and do not invent a new one. Do not reuse a key for changed files, options, or a deliberate new conversion. Once you have a jobId, poll wpconvert_check_status until "done", then follow recommended_next for download or preview.',
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
  {
    name: 'wpconvert_check_status',
    description:
      'Check the status of a conversion job. Returns persisted status per the OpenAPI ConversionStatus enum (queued, analyzing, building, rendering, labeling, generating, validating, uploading, done, failed). The tool-layer bucket `processing` means still in progress — it is not a persisted API value. Also returns progress, download/preview availability, and recommended_next (which tool to call next). When done and downloadable, recommended_next points to wpconvert_download_result; for preview-only jobs it points to wpconvert_create_preview instead.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
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
  {
    name: 'wpconvert_create_preview',
    description:
      'Create a WordPress Playground preview link for a completed conversion so the user can view the theme running in a live, in-browser WordPress (no local install). Returns a URL the user must open in a browser — you cannot embed or render it yourself. The link expires after about ten minutes and grants temporary access to the theme, so treat it as sensitive.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'wpconvert_explain_failure',
    description:
      'Return the failure reason for a failed conversion job. Distinguishes status retries, recovering a submission with the same idempotency_key via wpconvert_convert_folder, and starting a deliberate new conversion without that key.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'wpconvert_quota',
    description:
      'Show account quota, capabilities (conversion mode, can_start, download availability), and recommended_next. Call this before wpconvert_convert_folder to understand what the next conversion will consume.',
    inputSchema: { type: 'object', properties: {} },
  },
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
    return fail(`"${type}" conversions aren't available yet — only "theme" is supported right now. Elementor and Gutenberg are coming soon.`);
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

function renderApiError(e) {
  const d = (e && e.details) || {};
  switch (e && e.code) {
    case 'missing_credentials':
      return 'No API key configured. Set WPCONVERT_API_KEY in the MCP server environment.';
    case 'invalid_api_key':
      return 'Invalid or revoked API key.';
    case 'insufficient_credits':
      return `Out of credits.${d.buy_credits_url ? ' Buy credits: ' + d.buy_credits_url : ''}`;
    case 'quota_exceeded':
      return 'Monthly quota exceeded. Buy credits or wait for reset.';
    case 'upgrade_required':
      if (d.preview_only || d.reason === 'dev_preview_limit' || d.reason === 'preview_only_job') {
        return PREVIEW_LOCKED_DOWNLOAD_COPY;
      }
      return e.message || 'This feature requires the Pro plan or credits.';
    case 'too_many_active_jobs':
      return `Too many conversions in progress (${d.current ?? '?'}/${d.cap ?? '?'}). Wait and retry.`;
    case 'rate_limited':
      return `Rate limited.${d.retry_after ? ` Retry in ~${d.retry_after}s.` : ''}`;
    case 'conversion_not_ready':
      return `Conversion is not ready yet (status: ${d.status || 'pending'}). Poll status until done.`;
    case 'theme_expired':
      return 'This theme has expired and can no longer be previewed. Re-run the conversion.';
    case 'theme_too_large_for_preview':
      return e.message || 'This theme is too large for in-browser preview. Download it and test on a WordPress install instead.';
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
      return (e && e.message) || 'Request failed.';
  }
}

async function handleCall(name, args) {
  api.setRequestExtras({ tool: name });
  switch (name) {
    case 'wpconvert_convert_folder':
      return convertFolder(args);

    case 'wpconvert_check_status': {
      const s = await api.getStatus(args.jobId);
      const projected = projectStatusResponse(s);
      const previewOnly = s.preview_only || s.conversion_mode === 'preview_only';
      const text =
        `status=${s.status}${s.progress != null ? ` progress=${s.progress}%` : ''}` +
        `${s.status === 'done' && s.preview_available ? '\npreview: available (call wpconvert_create_preview)' : ''}` +
        `${previewOnly && s.status === 'done' ? `\n${PREVIEW_LOCKED_DOWNLOAD_COPY}` : ''}` +
        `${s.status === 'failed' && s.error ? `\nerror: ${s.error}` : ''}` +
        `\nNext: ${projected.recommended_next.tool} — ${projected.recommended_next.reason}`;
      return ok(text, projected);
    }

    case 'wpconvert_download_result': {
      try {
        const info = await api.getDownload(args.jobId);
        if (!info.download_url) {
          return fail(
            'No download URL available yet. Poll status until done.',
            {
              ok: false,
              error: { code: 'conversion_not_ready', message: 'No download URL available yet.' },
              recommended_next: recommendedNextForStatus({ status: 'processing' }),
            }
          );
        }
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
      } catch (e) {
        if (e && e.name === 'ApiError' && (e.code === 'upgrade_required' || e.details?.preview_only)) {
          return fail(
            PREVIEW_LOCKED_DOWNLOAD_COPY + '\nCall wpconvert_quota to review upgrade options.',
            {
              ok: false,
              error: {
                code: e.code || 'upgrade_required',
                message: PREVIEW_LOCKED_DOWNLOAD_COPY,
                reason: e.details?.reason || 'download_requires_upgrade',
                retry_safe: false,
              },
              recommended_next: {
                tool: 'wpconvert_quota',
                reason: 'Download locked for preview-only job. Review quota and upgrade before re-converting.',
              },
            }
          );
        }
        throw e;
      }
    }

    case 'wpconvert_create_preview': {
      const s = await api.getStatus(args.jobId);
      if (s.status === 'failed') {
        return fail(`Conversion failed: ${s.error || 'unknown error'}`, {
          ok: false,
          error: { code: 'conversion_failed', message: s.error || 'unknown error' },
          recommended_next: recommendedNextForStatus(s),
        });
      }
      if (s.status !== 'done') {
        return fail(`Conversion is not ready yet (status=${s.status}). Poll status until "done", then retry.`, {
          ok: false,
          error: { code: 'conversion_not_ready', message: `status=${s.status}` },
          recommended_next: recommendedNextForStatus(s),
        });
      }
      const session = await api.createPlaygroundSession(args.jobId);
      const expires = session.expires_at ? new Date(session.expires_at).toISOString() : null;
      const text =
        `Preview ready. Open this URL in a browser to view the theme in WordPress Playground:\n` +
        `${session.playground_url}\n` +
        `${expires ? `Link expires ${expires} and is use-limited. ` : ''}` +
        `Anyone with this URL can view the theme until it expires — treat it as sensitive.` +
        `${session.warning ? `\nNote: ${session.warning}` : ''}`;
      return ok(text, {
        ok: true,
        job_id: args.jobId,
        playground_url: session.playground_url,
        expires_at: expires,
        warning: session.warning || null,
      });
    }

    case 'wpconvert_explain_failure': {
      const s = await api.getStatus(args.jobId);
      if (s.status !== 'failed') {
        return ok(
          `Job is not failed (status=${s.status}).\n` +
            'If the conversion is still running, keep polling wpconvert_check_status. ' +
            'If submission itself may have timed out before a job ID was returned, retry ' +
            'wpconvert_convert_folder with the exact same idempotency_key from that prior call. ' +
            'For a deliberate new conversion of changed source, omit the old key.'
        );
      }
      return ok(
        `Conversion failed: ${s.error || 'unknown error'}\n` +
          'Polling status again will not restart the conversion. ' +
          'For a deliberate new conversion, call wpconvert_convert_folder without the previous idempotency_key. ' +
          'Do not reuse a failed attempt\'s key.'
      );
    }

    case 'wpconvert_quota': {
      const q = await api.getQuota();
      const projected = projectQuotaResponse(q);
      const text = formatQuotaText(q);
      return ok(text, projected);
    }

    default:
      return fail(`Unknown tool: ${name}`);
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
  convertSubmissionError,
  successPayload,
  errorPayload,
  ok,
  fail,
};

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((e) => {
    console.error('Fatal:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
