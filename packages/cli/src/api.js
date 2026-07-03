'use strict';

/**
 * Thin HTTP client around the WPConvert API (API-key authenticated).
 *
 * Mirrors the web client's flows:
 *   - small zips  -> POST /api/convert            (multipart, field name "file")
 *   - large zips  -> POST /api/convert/upload-url -> PUT signedUrl -> POST /from-storage
 *   - status      -> GET  /api/convert/:jobId/status
 *   - download    -> GET  /api/download/:project_id  (then follow download_url)
 *   - quota       -> GET  /api/convert/quota
 *
 * All errors are surfaced as ApiError with a stable `.code` (from the server's
 * { error: { code, message, ... } } envelope) so the CLI can render clean output.
 *
 * Requires Node >= 18 (global fetch / FormData / Blob).
 */

const { getApiBase, getApiKey } = require('./config');

class ApiError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.code = code || 'error';
    this.status = status || 0;
    this.details = details || {};
  }
}

function requireKey() {
  const key = getApiKey();
  if (!key) {
    throw new ApiError(
      'No API key found. Run `wpconvert login` or set WPCONVERT_API_KEY.',
      { code: 'missing_credentials' }
    );
  }
  return key;
}

function authHeaders(extra = {}) {
  return { 'X-API-Key': requireKey(), ...extra };
}

/** Parse a response, throwing ApiError on non-2xx (handles clean + legacy shapes). */
async function parseResponse(res) {
  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  }

  if (res.ok) return body;

  // Clean envelope: { error: { code, message, ... } }
  if (body && body.error && typeof body.error === 'object') {
    const { code, message, ...rest } = body.error;
    throw new ApiError(message, { code, status: res.status, details: rest });
  }
  // Legacy shape: { error: 'string', message?, ... }
  if (body && typeof body.error === 'string') {
    throw new ApiError(body.message || body.error, {
      code: body.code || body.error,
      status: res.status,
      details: body,
    });
  }
  throw new ApiError(`Request failed with status ${res.status}`, {
    code: 'http_error',
    status: res.status,
    details: body || {},
  });
}

function url(p) {
  return `${getApiBase()}${p}`;
}

/** Append optional conversion params (export type, elementor config, name). */
function applyConversionFields(append, { projectName, exportType, elementor }) {
  if (projectName) append('project_name', projectName);
  if (exportType) append('export_type', exportType);
  if (exportType === 'elementor' && elementor) {
    append('elementor_version', elementor.version || 'free');
    if (elementor.versionNumber) append('elementor_version_number', elementor.versionNumber);
    if (elementor.forceFreeSafe) append('force_free_safe', 'true');
  }
}

/** GET /api/convert/quota */
async function getQuota() {
  const res = await fetch(url('/api/convert/quota'), { headers: authHeaders() });
  return parseResponse(res);
}

/**
 * Small-zip path: POST /api/convert (multipart). Returns the submit payload
 * (includes jobId/project_id/status).
 * NOTE: not idempotent — never auto-retry once the request has been sent.
 */
async function convertMultipart(zipBuffer, { projectName, exportType, elementor } = {}) {
  const fd = new FormData();
  const blob = new Blob([zipBuffer], { type: 'application/zip' });
  // Field name MUST be "file"; filename MUST end in .zip (server fileFilter).
  fd.append('file', blob, `${(projectName || 'project').replace(/[^a-z0-9-_]+/gi, '-')}.zip`);
  applyConversionFields((k, v) => fd.append(k, v), { projectName, exportType, elementor });

  const res = await fetch(url('/api/convert'), {
    method: 'POST',
    headers: authHeaders(), // do NOT set content-type; fetch sets the multipart boundary
    body: fd,
  });
  return parseResponse(res);
}

/** Large-zip step 1: POST /api/convert/upload-url */
async function getUploadUrl() {
  const res = await fetch(url('/api/convert/upload-url'), {
    method: 'POST',
    headers: authHeaders(),
  });
  return parseResponse(res); // { jobId, bucket, path, token, signedUrl, maxSizeMB, plan }
}

/**
 * Large-zip step 2: PUT the zip bytes to the signed upload URL.
 * Idempotent (same path/token), so this step is safe to retry.
 */
async function putToSignedUrl(signedUrl, zipBuffer) {
  const res = await fetch(signedUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/zip', 'x-upsert': 'true' },
    body: zipBuffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`Direct upload failed (HTTP ${res.status}). ${text}`.trim(), {
      code: 'upload_failed',
      status: res.status,
    });
  }
}

/** Large-zip step 3: POST /api/convert/from-storage. Not idempotent — don't auto-retry. */
async function createJobFromStorage(jobId, { projectName, exportType, elementor } = {}) {
  const body = { jobId };
  applyConversionFields((k, v) => { body[k] = v; }, { projectName, exportType, elementor });
  if (body.force_free_safe === 'true') body.force_free_safe = true;

  const res = await fetch(url('/api/convert/from-storage'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return parseResponse(res);
}

/** GET /api/convert/:jobId/status */
async function getStatus(jobId) {
  const res = await fetch(url(`/api/convert/${encodeURIComponent(jobId)}/status`), {
    headers: authHeaders(),
  });
  return parseResponse(res);
}

/** GET /api/download/:project_id -> { download_url, name, ... } */
async function getDownload(projectId) {
  const res = await fetch(url(`/api/download/${encodeURIComponent(projectId)}`), {
    headers: authHeaders(),
  });
  return parseResponse(res);
}

/**
 * POST /api/playground/sessions -> { playground_url, expires_at, session_id, ... }
 * Creates an on-demand WordPress Playground preview session for a completed job.
 */
async function createPlaygroundSession(projectId) {
  const res = await fetch(url('/api/playground/sessions'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ projectId }),
  });
  return parseResponse(res);
}

/** Fetch raw bytes from a (signed) download URL. */
async function fetchBinary(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    throw new ApiError(`Failed to download theme (HTTP ${res.status}).`, {
      code: 'download_failed',
      status: res.status,
    });
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  ApiError,
  getQuota,
  convertMultipart,
  getUploadUrl,
  putToSignedUrl,
  createJobFromStorage,
  getStatus,
  getDownload,
  createPlaygroundSession,
  fetchBinary,
};
