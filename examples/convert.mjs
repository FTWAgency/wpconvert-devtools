#!/usr/bin/env node
/**
 * WPConvert API example — convert a zip file to a WordPress theme.
 *
 * Usage:
 *   export WPCONVERT_API_KEY=wpc_live_xxx
 *   node convert.mjs ./my-site.zip my-site
 *
 * Requires Node >= 18 (global fetch / FormData / Blob).
 */

import fs from 'fs';
import path from 'path';

const API_BASE = (process.env.WPCONVERT_API_BASE || 'https://api.wpconvert.ai').replace(/\/+$/, '');
const API_KEY = process.env.WPCONVERT_API_KEY;
if (!API_KEY) {
  console.error('Set WPCONVERT_API_KEY');
  process.exit(1);
}

const zipPath = process.argv[2];
if (!zipPath) {
  console.error('Usage: node convert.mjs <zip-file> [project-name]');
  process.exit(1);
}

const projectName = process.argv[3] || path.basename(zipPath, '.zip');

function authHeaders(extra = {}) {
  return { 'X-API-Key': API_KEY, ...extra };
}

async function parseResponse(res) {
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Step 1: Start conversion (multipart upload)
  console.log(`Uploading ${zipPath} as '${projectName}' ...`);

  const zipBuffer = fs.readFileSync(zipPath);
  const fd = new FormData();
  const blob = new Blob([zipBuffer], { type: 'application/zip' });
  fd.append('file', blob, `${projectName.replace(/[^a-z0-9-_]+/gi, '-')}.zip`);
  fd.append('project_name', projectName);
  fd.append('export_type', 'theme');

  const submitRes = await fetch(`${API_BASE}/api/convert`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  const submit = await parseResponse(submitRes);
  const jobId = submit.jobId || submit.project_id || submit.id;
  if (!jobId) throw new Error('No jobId returned');

  console.log(`Conversion queued: jobId=${jobId}`);
  console.log('Polling status ...');

  // Step 2: Poll until done
  while (true) {
    const statusRes = await fetch(`${API_BASE}/api/convert/${encodeURIComponent(jobId)}/status`, {
      headers: authHeaders(),
    });
    const status = await parseResponse(statusRes);

    if (status.status === 'done') {
      console.log('Conversion complete.');
      break;
    }
    if (status.status === 'failed') {
      throw new Error(`Conversion failed: ${status.error || 'unknown error'}`);
    }

    const pct = status.progress != null ? ` progress=${status.progress}%` : '';
    console.log(`  status=${status.status}${pct}`);
    await sleep(3000);
  }

  // Step 3: Get download URL and follow server-returned download_url
  const downloadRes = await fetch(`${API_BASE}/api/download/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  });
  const downloadInfo = await parseResponse(downloadRes);

  if (!downloadInfo.download_url) {
    throw new Error('No download_url returned');
  }

  const fileName = downloadInfo.name || `${jobId}-theme.zip`;
  console.log(`Downloading ${fileName} ...`);

  const fileRes = await fetch(downloadInfo.download_url);
  if (!fileRes.ok) throw new Error(`Download failed: HTTP ${fileRes.status}`);

  const bytes = Buffer.from(await fileRes.arrayBuffer());
  fs.writeFileSync(fileName, bytes);
  console.log(`Saved ${fileName} (${bytes.length} bytes)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
