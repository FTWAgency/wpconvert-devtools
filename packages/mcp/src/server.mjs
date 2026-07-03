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
import path from 'path';
import fs from 'fs';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Reuse the CLI's CJS modules (api client, smart-zip, ignore rules).
const require = createRequire(import.meta.url);
const api = require('wpconvert/src/api');
const { planZip, buildZipBuffer, formatBytes } = require('wpconvert/src/zip');
const { detectSiteRoot, BUILD_DIRS } = require('wpconvert/src/detect');

const MULTIPART_CAP_MB = 50;
const VALID_TYPES = ['theme']; // only "theme" is supported for now
const COMING_SOON_TYPES = ['elementor', 'gutenberg']; // not available via API/MCP yet

function ok(text) {
  return { content: [{ type: 'text', text }] };
}
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

const TOOLS = [
  {
    name: 'wpconvert_convert_folder',
    description:
      'Zip a local folder (excluding node_modules, build output, and secrets by default) and start a WordPress theme conversion. Returns a jobId; poll wpconvert_check_status until "done", then call wpconvert_download_result. Uses 1 credit on success.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the folder to convert.' },
        type: { type: 'string', enum: VALID_TYPES, description: 'Export type. Only "theme" is supported right now.' },
        name: { type: 'string', description: 'Project name (defaults to folder name).' },
        maxAssetSizeMB: { type: 'number', description: 'Exclude individual files larger than this many MB.' },
        includeEnv: { type: 'boolean', description: 'DANGER: include .env / secret files (default false).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'wpconvert_check_status',
    description: 'Check the status of a conversion job. Returns status (queued/processing/done/failed), progress, and whether a live preview is available. When done, you can call wpconvert_download_result and/or wpconvert_create_preview.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'wpconvert_download_result',
    description: 'Download a completed conversion to disk. Returns the saved file path. Optionally, use wpconvert_create_preview to view the theme in a live WordPress before/after downloading.',
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
      'Create a WordPress Playground preview link for a completed conversion so the user can view the theme running in a live, in-browser WordPress (no local install). Returns a URL the user must open in a browser — you cannot embed or render it yourself. The link expires after ~30 minutes and grants temporary access to the theme, so treat it as sensitive.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'wpconvert_explain_failure',
    description: 'Return the failure reason for a failed conversion job.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'wpconvert_quota',
    description: 'Show the account\'s remaining conversions and PAYG credits.',
    inputSchema: { type: 'object', properties: {} },
  },
];

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

  const zipBuffer = buildZipBuffer(files);
  const zipMB = zipBuffer.length / (1024 * 1024);
  const elementor = undefined; // Elementor/Gutenberg not available via MCP yet (guarded above)

  let submit;
  if (zipMB <= MULTIPART_CAP_MB) {
    submit = await api.convertMultipart(zipBuffer, { projectName, exportType: type, elementor });
  } else {
    const up = await api.getUploadUrl();
    if (up.maxSizeMB && zipMB > up.maxSizeMB) {
      return fail(`Zip is ${zipMB.toFixed(1)}MB but your plan (${up.plan || 'current'}) allows up to ${up.maxSizeMB}MB. No credit was used.`);
    }
    await api.putToSignedUrl(up.signedUrl, zipBuffer);
    submit = await api.createJobFromStorage(up.jobId, { projectName, exportType: type, elementor });
  }

  const jobId = submit.jobId || submit.project_id || submit.id;
  const warn = excludedLarge.length ? ` (excluded ${excludedLarge.length} large file(s))` : '';
  return ok(
    detectNote +
    `Conversion queued. jobId=${jobId}\n` +
    `Zipped ${files.length} files (${formatBytes(totalBytes)} uncompressed)${warn}.\n` +
    `Poll wpconvert_check_status with this jobId until status is "done", then wpconvert_download_result.`
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
      return 'This theme is too large for in-browser preview (over 30MB). Download it and test on a WordPress install instead.';
    default:
      return (e && e.message) || 'Request failed.';
  }
}

async function handleCall(name, args) {
  switch (name) {
    case 'wpconvert_convert_folder':
      return convertFolder(args);

    case 'wpconvert_check_status': {
      const s = await api.getStatus(args.jobId);
      return ok(`status=${s.status}${s.progress != null ? ` progress=${s.progress}%` : ''}` +
        `${s.status === 'done' && s.preview_available ? '\npreview: available (call wpconvert_create_preview)' : ''}` +
        `${s.status === 'failed' && s.error ? `\nerror: ${s.error}` : ''}`);
    }

    case 'wpconvert_download_result': {
      const info = await api.getDownload(args.jobId);
      if (!info.download_url) return fail('No download URL available yet. Poll status until done.');
      const dir = args.outDir ? path.resolve(process.cwd(), args.outDir) : process.cwd();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const fileName = info.name || `${args.jobId}-theme.zip`;
      const outPath = path.join(dir, fileName);
      const bytes = await api.fetchBinary(info.download_url);
      fs.writeFileSync(outPath, bytes);
      return ok(`Saved ${fileName} (${formatBytes(bytes.length)}) to ${outPath}`);
    }

    case 'wpconvert_create_preview': {
      const s = await api.getStatus(args.jobId);
      if (s.status === 'failed') return fail(`Conversion failed: ${s.error || 'unknown error'}`);
      if (s.status !== 'done') return fail(`Conversion is not ready yet (status=${s.status}). Poll status until "done", then retry.`);
      const session = await api.createPlaygroundSession(args.jobId);
      const expires = session.expires_at ? new Date(session.expires_at).toISOString() : null;
      return ok(
        `Preview ready. Open this URL in a browser to view the theme in WordPress Playground:\n` +
        `${session.playground_url}\n` +
        `${expires ? `Link expires ${expires} and is use-limited. ` : ''}` +
        `Anyone with this URL can view the theme until it expires — treat it as sensitive.` +
        `${session.warning ? `\nNote: ${session.warning}` : ''}`
      );
    }

    case 'wpconvert_explain_failure': {
      const s = await api.getStatus(args.jobId);
      if (s.status !== 'failed') return ok(`Job is not failed (status=${s.status}).`);
      return ok(`Conversion failed: ${s.error || 'unknown error'}`);
    }

    case 'wpconvert_quota': {
      const q = await api.getQuota();
      return ok(
        `plan=${q.effectivePlan || 'unknown'} used=${q.current ?? '?'}/${q.max ?? '?'} ` +
        `remaining=${q.remaining ?? '?'}${q.payg_credits != null ? ` payg=${q.payg_credits}` : ''}`
      );
    }

    default:
      return fail(`Unknown tool: ${name}`);
  }
}

async function main() {
  const server = new Server(
    { name: 'wpconvert-mcp', version: '0.1.0-beta.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleCall(name, args || {});
    } catch (e) {
      if (e && e.name === 'ApiError') return fail(renderApiError(e));
      return fail(e && e.message ? e.message : String(e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stderr is safe for logs (stdout is the MCP transport).
  console.error('wpconvert-mcp server running on stdio');
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
