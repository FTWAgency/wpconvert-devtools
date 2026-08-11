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
const { assertIdempotencyKey, isAmbiguousTransportError, sleep } = require('./idempotency');

const CLI_VERSION = require('../package.json').version;
const IDEMPOTENCY_HEADER = 'Idempotency-Key';
const SUBMISSION_TRANSPORT_RETRY_MS = 500;

/** Optional per-request extras (e.g. MCP tool name). Set via setRequestExtras(). */
let requestExtras = {};

function setRequestExtras(extras = {}) {
  requestExtras = extras && typeof extras === 'object' ? extras : {};
}

function clientHeaderValue() {
  if (process.env.WPCONVERT_CLIENT) return process.env.WPCONVERT_CLIENT;
  return `cli/${CLI_VERSION}`;
}

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
  const headers = {
    'X-API-Key': requireKey(),
    'X-WPConvert-Client': clientHeaderValue(),
    ...extra,
  };
  if (requestExtras.tool) headers['X-WPConvert-Tool'] = String(requestExtras.tool);
  return headers;
}

function submissionHeaders(idempotencyKey, extra = {}) {
  const headers = authHeaders(extra);
  if (idempotencyKey) {
    headers[IDEMPOTENCY_HEADER] = assertIdempotencyKey(idempotencyKey);
  }
  return headers;
}

/** Parse a response, throwing ApiError on non-2xx (handles clean + legacy shapes). */
async function parseResponse(res) {
  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  }

  if (res.ok) return body;

  throw apiErrorFromResponse(res.status, body);
}

/**
 * Parse conversion submission responses (200/202 success; structured 409 conflicts).
 * @returns {Promise<object>}
 */
async function parseSubmissionResponse(res, { hadTransportRetry = false } = {}) {
  let body = null;
  const text = await res.text();
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }
  }

  if (res.status === 200 || res.status === 202) {
    if (!body || typeof body !== 'object') {
      throw new ApiError('Conversion started but the server returned an empty response.', {
        code: 'http_error',
        status: res.status,
        details: { hadTransportRetry },
      });
    }
    if (hadTransportRetry) body._hadTransportRetry = true;
    return body;
  }

  const err = apiErrorFromResponse(res.status, body);
  if (hadTransportRetry) err.details = { ...err.details, hadTransportRetry: true };
  throw err;
}

function apiErrorFromResponse(status, body) {
  if (body && body.error && typeof body.error === 'object') {
    const { code, message, ...rest } = body.error;
    return new ApiError(message, { code, status, details: rest });
  }
  if (body && typeof body.error === 'string') {
    return new ApiError(body.message || body.error, {
      code: body.code || body.error,
      status,
      details: body,
    });
  }
  return new ApiError(`Request failed with status ${status}`, {
    code: 'http_error',
    status,
    details: body || {},
  });
}

function isNonRetryableSubmissionError(err) {
  if (!(err instanceof ApiError)) return false;
  if ([400, 401, 403, 409, 422, 429].includes(err.status)) return true;
  if (err.code === 'invalid_idempotency_key') return true;
  return false;
}

/**
 * Perform one conversion submission with optional bounded transport retry.
 * @param {(headers: Record<string, string>) => Promise<Response>} performRequest
 * @param {{ idempotencyKey?: string }} opts
 */
async function submitConversionRequest(performRequest, { idempotencyKey } = {}) {
  const key = idempotencyKey ? assertIdempotencyKey(idempotencyKey) : null;
  let hadTransportRetry = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await performRequest(submissionHeaders(key));
    } catch (e) {
      if (attempt === 0 && isAmbiguousTransportError(e)) {
        hadTransportRetry = true;
        await sleep(SUBMISSION_TRANSPORT_RETRY_MS);
        continue;
      }
      throw new ApiError(e.message || 'Network request failed', {
        code: 'network_error',
        status: 0,
        details: {
          cause: e.cause?.code || null,
          hadTransportRetry,
        },
      });
    }

    try {
      return await parseSubmissionResponse(res, { hadTransportRetry });
    } catch (e) {
      if (e instanceof ApiError && isNonRetryableSubmissionError(e)) throw e;
      if (attempt === 0 && isAmbiguousTransportError(e)) {
        hadTransportRetry = true;
        await sleep(SUBMISSION_TRANSPORT_RETRY_MS);
        continue;
      }
      throw e;
    }
  }

  throw new ApiError('Network request failed after retry.', {
    code: 'network_error',
    status: 0,
    details: { hadTransportRetry: true },
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

function buildMultipartFormData(zipBuffer, { projectName, exportType, elementor } = {}) {
  const fd = new FormData();
  const blob = new Blob([zipBuffer], { type: 'application/zip' });
  fd.append('file', blob, `${(projectName || 'project').replace(/[^a-z0-9-_]+/gi, '-')}.zip`);
  applyConversionFields((k, v) => fd.append(k, v), { projectName, exportType, elementor });
  return fd;
}

/** GET /api/convert/quota */
async function getQuota() {
  const res = await fetch(url('/api/convert/quota'), { headers: authHeaders() });
  return parseResponse(res);
}

/**
 * Small-zip path: POST /api/convert (multipart). Returns the submit payload
 * (includes jobId/project_id/status).
 */
async function convertMultipart(zipBuffer, { projectName, exportType, elementor, idempotencyKey } = {}) {
  const fields = { projectName, exportType, elementor };
  return submitConversionRequest(
    (headers) => fetch(url('/api/convert'), {
      method: 'POST',
      headers, // do NOT set content-type; fetch sets the multipart boundary
      body: buildMultipartFormData(zipBuffer, fields),
    }),
    { idempotencyKey }
  );
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

/** Large-zip step 3: POST /api/convert/from-storage */
async function createJobFromStorage(jobId, { projectName, exportType, elementor, idempotencyKey } = {}) {
  const body = { jobId };
  applyConversionFields((k, v) => { body[k] = v; }, { projectName, exportType, elementor });
  if (body.force_free_safe === 'true') body.force_free_safe = true;
  const payload = JSON.stringify(body);

  return submitConversionRequest(
    (headers) => fetch(url('/api/convert/from-storage'), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: payload,
    }),
    { idempotencyKey }
  );
}

/** GET /api/convert/:jobId/status */
async function getStatus(jobId) {
  let res;
  try {
    res = await fetch(url(`/api/convert/${encodeURIComponent(jobId)}/status`), {
      headers: authHeaders(),
    });
  } catch (e) {
    throw new ApiError(e.message || 'Network request failed', {
      code: 'network_error',
      status: 0,
      details: { cause: e.cause?.code || null },
    });
  }
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
  IDEMPOTENCY_HEADER,
  setRequestExtras,
  getQuota,
  convertMultipart,
  getUploadUrl,
  putToSignedUrl,
  createJobFromStorage,
  getStatus,
  getDownload,
  createPlaygroundSession,
  fetchBinary,
  // exported for tests
  _internals: {
    parseSubmissionResponse,
    submitConversionRequest,
    submissionHeaders,
    buildMultipartFormData,
  },
};
