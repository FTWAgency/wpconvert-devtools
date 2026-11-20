/**
 * Tools the stdio server and the hosted server share (docs/HOSTED_MCP_PLAN.md
 * §3). Their handlers are in handlers.mjs.
 *
 * The descriptions are the stdio server's, word for word. Where one names a
 * local-only tool (wpconvert_convert_folder, wpconvert_connect), the hosted
 * server needs its own wording.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PACK_SIZES } = require('wpconvert/src/purchase');

export const CHECKOUT_KINDS = ['starter', 'pro', 'agency', 'payg'];
export const INTERVALS = ['month', 'year'];

export const CHECK_STATUS_TOOL = {
  name: 'wpconvert_check_status',
  description:
    'Check the status of a conversion job. Returns persisted status per the OpenAPI ConversionStatus enum (queued, analyzing, building, rendering, labeling, generating, validating, uploading, done, failed). The tool-layer bucket `processing` means still in progress — it is not a persisted API value. Also returns progress, download/preview availability, and recommended_next (which tool to call next). When done and downloadable, recommended_next points to wpconvert_download_result; for preview-only jobs it points to wpconvert_create_preview instead.',
  inputSchema: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
  },
};

export const CREATE_PREVIEW_TOOL = {
  name: 'wpconvert_create_preview',
  description:
    'Create a WordPress Playground preview link for a completed conversion so the user can view the theme running in a live, in-browser WordPress (no local install). Returns a URL the user must open in a browser — you cannot embed or render it yourself. The link expires after about ten minutes and grants temporary access to the theme, so treat it as sensitive.',
  inputSchema: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
  },
};

export const EXPLAIN_FAILURE_TOOL = {
  name: 'wpconvert_explain_failure',
  description:
    'Return the failure reason for a failed conversion job. Distinguishes status retries, recovering a submission with the same idempotency_key via wpconvert_convert_folder, and starting a deliberate new conversion without that key.',
  inputSchema: {
    type: 'object',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
  },
};

export const QUOTA_TOOL = {
  name: 'wpconvert_quota',
  description:
    'Show account quota, capabilities (conversion mode, can_start, download availability), and recommended_next. Call this before wpconvert_convert_folder to understand what the next conversion will consume. For a guest session it shows the free previews left.',
  inputSchema: { type: 'object', properties: {} },
};

export const PLANS_TOOL = {
  name: 'wpconvert_plans',
  description:
    'List what the user can buy: Starter (unlock one theme), Pro, Agency (monthly or yearly) and pay-as-you-go credit packs, with what each includes and today\'s price. Pass jobId to see options for unlocking that conversion. Show all options to the user and let them choose; do not pick for them. Then call wpconvert_checkout with the checkout_arguments of their choice.',
  inputSchema: {
    type: 'object',
    properties: { jobId: { type: 'string', description: 'Conversion to unlock (optional).' } },
  },
};

export const CHECKOUT_TOOL = {
  name: 'wpconvert_checkout',
  description:
    'Create a Stripe checkout link for the option the user picked from wpconvert_plans. Call this only after the user has chosen; pass that choice\'s checkout_arguments unchanged. Needs a signed-in account (wpconvert_connect kind "login"). Returns a link the user opens to pay; never open it yourself and never pay on their behalf.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: CHECKOUT_KINDS },
      jobId: { type: 'string', description: 'Conversion to unlock. Required for starter.' },
      interval: { type: 'string', enum: INTERVALS, description: 'Required for pro and agency.' },
      packSize: { type: 'number', enum: PACK_SIZES, description: 'Required for payg.' },
    },
    required: ['kind'],
  },
};

export const SHARED_TOOLS = [
  CHECK_STATUS_TOOL,
  CREATE_PREVIEW_TOOL,
  EXPLAIN_FAILURE_TOOL,
  QUOTA_TOOL,
  PLANS_TOOL,
  CHECKOUT_TOOL,
];
