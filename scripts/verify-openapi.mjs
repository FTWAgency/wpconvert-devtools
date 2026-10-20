#!/usr/bin/env node
/**
 * Lightweight verification for the mirrored openapi.yaml in this repository.
 *
 * This is NOT the full private contract-drift suite (that lives with the
 * production API). It only checks that the public mirror:
 *   - parses as YAML
 *   - is OpenAPI 3.1.0
 *   - has the expected path/operation surface
 *   - is byte-identical to the known canonical SHA-256
 *
 * Update CANONICAL_SHA256 when the private contract is intentionally re-mirrored.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import YAML from 'yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, '..', 'openapi.yaml');

// SHA-256 of wpconvert/wpconvert-api/openapi.yaml at commit cbbccafa (terminal guest previews and buying).
const CANONICAL_SHA256 = '38c4b2bd9d53c5d35aee404130b5a1e977be627c73bf98c4063a7c15752324bd';

const EXPECTED_OPERATION_IDS = [
  'getQuota',
  'submitConversion',
  'createUploadUrl',
  'submitConversionFromStorage',
  'getConversionStatus',
  'getDownload',
  'createPlaygroundSession',
  'getPlanCatalog',
  'getCheckoutOptions',
  'createTerminalCheckout',
];

const EXPECTED_PATHS = [
  '/api/convert/quota',
  '/api/convert',
  '/api/convert/upload-url',
  '/api/convert/from-storage',
  '/api/convert/{jobId}/status',
  '/api/download/{projectId}',
  '/api/playground/sessions',
  '/api/billing/catalog',
  '/api/billing/cli-options',
  '/api/billing/cli-checkout',
];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const raw = readFileSync(SPEC_PATH, 'utf8');
const sha256 = createHash('sha256').update(raw).digest('hex');

if (sha256 !== CANONICAL_SHA256) {
  fail(
    `openapi.yaml SHA-256 mismatch.\n` +
      `  expected: ${CANONICAL_SHA256}\n` +
      `  actual:   ${sha256}\n` +
      `Re-mirror from the private canonical contract; do not edit schemas here.`
  );
}

let spec;
try {
  spec = YAML.parse(raw);
} catch (e) {
  fail(`openapi.yaml is not valid YAML: ${e.message}`);
}

if (!String(spec.openapi || '').startsWith('3.1')) {
  fail(`expected OpenAPI 3.1.x, found "${spec.openapi}"`);
}

const paths = Object.keys(spec.paths || {});
if (paths.length !== EXPECTED_PATHS.length) {
  fail(`expected ${EXPECTED_PATHS.length} paths, found ${paths.length}`);
}
for (const route of EXPECTED_PATHS) {
  if (!paths.includes(route)) fail(`missing path: ${route}`);
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const operationIds = [];
for (const pathItem of Object.values(spec.paths || {})) {
  for (const method of METHODS) {
    if (pathItem?.[method]?.operationId) operationIds.push(pathItem[method].operationId);
  }
}
if (operationIds.length !== EXPECTED_OPERATION_IDS.length) {
  fail(`expected ${EXPECTED_OPERATION_IDS.length} operations, found ${operationIds.length}`);
}
for (const id of EXPECTED_OPERATION_IDS) {
  if (!operationIds.includes(id)) fail(`missing operationId: ${id}`);
}

console.log('OK: openapi.yaml mirror verified.');
console.log(`  OpenAPI ${spec.openapi} | SHA-256 ${sha256.slice(0, 12)}…`);
console.log(`  ${paths.length} paths | ${operationIds.length} operations`);
