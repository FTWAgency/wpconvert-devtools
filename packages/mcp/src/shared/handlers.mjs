/**
 * API-only tool handlers the stdio server and the hosted server share
 * (docs/HOSTED_MCP_PLAN.md §2, §3): status, preview, explain failure, quota,
 * plans, checkout, and the API half of download.
 *
 * Nothing here reads files, config or the environment. The caller passes the
 * API client and says whether the caller has an account. The stdio server
 * passes wpconvert/src/api, which authenticates with the key from
 * WPCONVERT_API_KEY or ~/.wpconvert/config.json, or the guest session saved
 * there; the hosted server will pass a client that sends the signed-in user's
 * token.
 *
 * Results and wording are the stdio server's, unchanged.
 */

import { createRequire } from 'module';
import { ok, fail, redactSecrets } from './result.mjs';
import {
  projectQuotaResponse,
  projectStatusResponse,
  formatQuotaText,
  recommendedNextForStatus,
} from './capabilities.mjs';
import {
  CHECKOUT_KINDS,
  INTERVALS,
  CHECK_STATUS_TOOL,
  CREATE_PREVIEW_TOOL,
  EXPLAIN_FAILURE_TOOL,
  QUOTA_TOOL,
  PLANS_TOOL,
  CHECKOUT_TOOL,
} from './tools.mjs';

const require = createRequire(import.meta.url);
const { PACK_SIZES, formatPlans, buildMenu } = require('wpconvert/src/purchase');

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PREVIEW_LOCKED_DOWNLOAD_COPY =
  'Download locked. Upgrade to PRO or add PAYG credits, then re-run this conversion to download theme.zip.';

export const GUEST_DOWNLOAD_COPY =
  'Guest previews cannot be downloaded. To download this theme, call wpconvert_plans with this jobId and let the user choose how to unlock it (Starter unlocks just this theme).';

/** Where plans and checkout send a caller without an account: the stdio server's sign-in. */
export const SIGN_IN_NEXT = {
  tool: 'wpconvert_connect',
  arguments: { kind: 'login' },
  reason: 'Buying needs a WPConvert account. Sign in or create one in the browser.',
};

/**
 * Text for an API error whose meaning does not depend on how the caller
 * connected. Credential, guest and submission errors are worded by the server
 * that owns them, which falls back to this.
 */
export function describeApiError(e) {
  const d = (e && e.details) || {};
  switch (e && e.code) {
    case 'already_subscribed':
      return `${e.message || 'This account already has a subscription.'}${d.portal_url ? ` Manage the plan: ${d.portal_url}` : ''}`;
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
    default:
      return (e && e.message) || 'Request failed.';
  }
}

function downloadNotReady() {
  return fail(
    'No download URL available yet. Poll status until done.',
    {
      ok: false,
      error: { code: 'conversion_not_ready', message: 'No download URL available yet.' },
      recommended_next: recommendedNextForStatus({ status: 'processing' }),
    }
  );
}

/** The result for a download the plan does not allow, or null for any other error. */
function downloadLocked(e) {
  if (!(e && e.name === 'ApiError' && (e.code === 'upgrade_required' || e.details?.preview_only))) return null;
  return fail(
    PREVIEW_LOCKED_DOWNLOAD_COPY + '\nCall wpconvert_quota to review upgrade options, or wpconvert_plans to show the user what they can buy.',
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

function badJobId(jobId) {
  return jobId != null && (typeof jobId !== 'string' || !UUID_RX.test(jobId));
}

/** The checkout request, built only from fields that mean something for this kind. */
function checkoutRequest(args) {
  const a = args || {};
  if (!CHECKOUT_KINDS.includes(a.kind)) return { error: 'kind must be starter, pro, agency or payg.' };
  if (badJobId(a.jobId)) return { error: 'jobId must be a conversion id from wpconvert_convert_folder.' };
  const jobId = a.jobId || undefined;
  const request = { kind: a.kind };
  if (a.kind === 'starter') {
    if (!jobId) return { error: 'Starter unlocks one theme; pass its jobId.' };
    if (a.interval != null || a.packSize != null) return { error: 'Starter takes only a jobId.' };
  } else if (a.kind === 'payg') {
    if (!PACK_SIZES.includes(Number(a.packSize))) return { error: `packSize must be one of ${PACK_SIZES.join(', ')}.` };
    if (a.interval != null) return { error: 'interval only applies to pro and agency.' };
    request.packSize = Number(a.packSize);
  } else {
    if (!INTERVALS.includes(a.interval)) return { error: 'interval must be "month" or "year" (the user\'s choice from wpconvert_plans).' };
    if (a.packSize != null) return { error: 'packSize only applies to payg.' };
    request.interval = a.interval;
  }
  if (jobId) request.jobId = jobId;
  return { request };
}

/**
 * The WPConvert API client the handlers call: wpconvert/src/api, or any object
 * with these methods that throws errors named 'ApiError' carrying `code`,
 * `status` and `details` the way it does.
 * @typedef {object} WpconvertApi
 * @property {(jobId: string) => Promise<object>} getStatus
 * @property {(jobId: string) => Promise<object>} createPlaygroundSession
 * @property {() => Promise<object>} getQuota
 * @property {(jobId: string) => Promise<object>} getDownload
 * @property {() => Promise<object>} getCatalog
 * @property {(jobId?: string) => Promise<object>} getCheckoutOptions
 * @property {(request: object) => Promise<object>} createCheckout
 */

/**
 * @param {object} deps
 * @param {WpconvertApi} deps.api
 * @param {() => boolean} deps.hasAccount  Whether the caller is signed in to an
 *   account, asked on each call. Without one, plans shows the public catalog
 *   and checkout asks the user to sign in.
 */
export function createSharedHandlers({ api, hasAccount }) {
  async function checkStatus(args) {
    const s = await api.getStatus(args.jobId);
    const projected = projectStatusResponse(s);
    const previewOnly = s.preview_only || s.conversion_mode === 'preview_only';
    const lockedCopy = projected.guest ? GUEST_DOWNLOAD_COPY : PREVIEW_LOCKED_DOWNLOAD_COPY;
    const text =
      `status=${s.status}${s.progress != null ? ` progress=${s.progress}%` : ''}` +
      `${projected.guest && projected.remaining_previews != null ? `\nguest previews left: ${projected.remaining_previews}` : ''}` +
      `${s.status === 'done' && s.preview_available ? '\npreview: available (call wpconvert_create_preview)' : ''}` +
      `${(previewOnly || projected.guest) && s.status === 'done' ? `\n${lockedCopy}` : ''}` +
      `${s.status === 'failed' && s.error ? `\nerror: ${s.error}` : ''}` +
      `\nNext: ${projected.recommended_next.tool} — ${projected.recommended_next.reason}`;
    return ok(text, projected);
  }

  async function createPreview(args) {
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

  async function explainFailure(args) {
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

  async function quota() {
    const q = await api.getQuota();
    const projected = projectQuotaResponse(q);
    const text = formatQuotaText(q);
    return ok(text, projected);
  }

  async function plans(args) {
    const jobId = args && args.jobId ? args.jobId : undefined;
    if (badJobId(jobId)) return fail('jobId must be a conversion id from wpconvert_convert_folder.');

    if (!hasAccount()) {
      const catalog = await api.getCatalog();
      const text = [
        'WPConvert options:',
        '',
        ...formatPlans(catalog),
        'Buying needs a WPConvert account. Show these options to the user; if they want one, call wpconvert_connect with kind "login", then wpconvert_plans again' +
          (jobId ? ' with this jobId.' : '.'),
      ].join('\n');
      return ok(text, {
        ok: true,
        personalized: false,
        currency: catalog.currency,
        options: catalog.options,
        recommended_next: SIGN_IN_NEXT,
      });
    }

    const options = await api.getCheckoutOptions(jobId);
    const menu = buildMenu(options, { jobId });
    const choices = menu.map((e) => ({
      id: e.id,
      label: e.label,
      price: e.price,
      billing: e.billing,
      ...(e.note ? { note: e.note } : {}),
      ...(e.portal ? { opens: 'billing_portal' } : {}),
      checkout_arguments: { ...e.request, ...(jobId ? { jobId } : {}) },
    }));
    const notes = [];
    if (options.job && options.job.unlockable === false) {
      notes.push(`This conversion cannot be unlocked with Starter${options.job.reason ? ` (${options.job.reason})` : ''}.`);
    }
    if (options.existing_subscriber) notes.push('This account already has a subscription; plan changes open the billing portal.');
    const text = [
      'What each option includes:',
      '',
      ...formatPlans(options),
      ...notes,
      ...(notes.length ? [''] : []),
      'Choices:',
      ...choices.map((c, i) => `  ${i + 1}. ${c.label}: ${c.price}${c.note ? ` (${c.note})` : ''}`),
      '',
      'Ask the user which one they want and let the user choose. Then call wpconvert_checkout with that choice\'s checkout_arguments.',
    ].join('\n');
    return ok(text, {
      ok: true,
      personalized: true,
      currency: options.currency,
      existing_subscriber: options.existing_subscriber === true,
      job: options.job || null,
      choices,
      recommended_next: { tool: 'wpconvert_checkout', reason: 'Only after the user picks one of these choices.' },
    });
  }

  async function checkout(args) {
    const { request, error } = checkoutRequest(args);
    if (error) {
      return fail(`${error} Call wpconvert_plans and pass the chosen option's checkout_arguments.`, {
        ok: false,
        error: { code: 'invalid_request', message: error },
        recommended_next: { tool: 'wpconvert_plans', reason: 'Get the exact checkout arguments for each option.' },
      });
    }
    if (!hasAccount()) {
      return fail('Buying needs a WPConvert account. Call wpconvert_connect with kind "login" so the user can sign in, then call wpconvert_checkout again.', {
        ok: false,
        error: { code: 'missing_credentials', message: 'Sign in to buy.' },
        recommended_next: SIGN_IN_NEXT,
      });
    }

    let result;
    try {
      result = await api.createCheckout(request);
    } catch (e) {
      if (e && e.name === 'ApiError' && e.code === 'already_subscribed') {
        const portal = e.details && e.details.portal_url;
        return fail(`${redactSecrets(e.message)}${portal ? `\nAsk the user to open the billing portal to change plans:\n  ${portal}` : ''}`, {
          ok: false,
          error: { code: 'already_subscribed', message: redactSecrets(e.message) },
          ...(portal ? { portal_url: portal } : {}),
        });
      }
      throw e;
    }

    const after = request.jobId
      ? { tool: 'wpconvert_check_status', arguments: { jobId: request.jobId }, reason: 'After the user pays, the download unlocks within a minute.' }
      : { tool: 'wpconvert_quota', reason: 'After the user pays, the plan or credits show up here.' };

    if (result.portal_url) {
      return ok(`${result.message || 'This account already has a subscription.'}\nAsk the user to open this link to change plans in the billing portal (do not open it yourself):\n  ${result.portal_url}`, {
        ok: true,
        portal_url: result.portal_url,
        claimed: result.claimed || [],
        recommended_next: after,
      });
    }
    return ok(`Ask the user to open this link to pay on Stripe (do not open it yourself):\n  ${result.checkout_url}\nWhen they say they have paid, call ${after.tool}.`, {
      ok: true,
      checkout_url: result.checkout_url,
      claimed: result.claimed || [],
      recommended_next: after,
    });
  }

  /**
   * The API half of wpconvert_download_result. A ready download goes to
   * `deliver(info)` (the stdio server saves it to disk; the hosted server will
   * return a signed link). `onError(e)` may answer an error first, before the
   * plan-locked check; anything else is thrown.
   */
  async function downloadResult(jobId, { deliver, onError } = {}) {
    try {
      const info = await api.getDownload(jobId);
      if (!info.download_url) return downloadNotReady();
      return await deliver(info);
    } catch (e) {
      const claimed = onError ? onError(e) : null;
      if (claimed) return claimed;
      const locked = downloadLocked(e);
      if (locked) return locked;
      throw e;
    }
  }

  const byTool = {
    [CHECK_STATUS_TOOL.name]: checkStatus,
    [CREATE_PREVIEW_TOOL.name]: createPreview,
    [EXPLAIN_FAILURE_TOOL.name]: explainFailure,
    [QUOTA_TOOL.name]: quota,
    [PLANS_TOOL.name]: plans,
    [CHECKOUT_TOOL.name]: checkout,
  };

  /** The result of a shared tool, or null when `name` is not one. */
  async function handleSharedCall(name, args) {
    const handler = Object.hasOwn(byTool, name) ? byTool[name] : null;
    return handler ? handler(args) : null;
  }

  return { checkStatus, createPreview, explainFailure, quota, plans, checkout, downloadResult, handleSharedCall };
}
