'use strict';

/**
 * Pure formatters for the developer-capabilities contract on GET /api/convert/quota.
 *
 * Trust the backend capabilities object. This module never decides entitlement —
 * it only maps stable codes to human-readable CLI text and formats compact output.
 */

/** Explicit capability denial (can_start === false). Documented CLI exit code. */
const EXIT_ENTITLEMENT_DENIED = 3;

const MODE_LABELS = {
  full: 'Full',
  preview_only: 'Preview only',
};

const CONSUMES_LABELS = {
  subscription_quota: 'Subscription quota',
  payg_credit: 'PAYG credit',
  starter_credit: 'Starter credit',
  free_preview: 'Free developer preview',
  none: 'No credit deduction',
};

const REASON_LABELS = {
  free_preview_available: 'Free developer preview available',
  free_previews_exhausted: 'Free developer previews exhausted',
  free_preview_keys_disabled: 'Free developer preview keys are disabled',
  subscription_quota_available: 'Subscription quota available',
  subscription_quota_exhausted: 'Subscription quota exhausted',
  payg_credit_available: 'PAYG credit available',
  starter_credit_available: 'Starter credit available',
  download_requires_upgrade: 'Download requires upgrade',
  playground_unavailable: 'Playground unavailable',
  export_not_supported: 'Export not supported',
  email_not_verified: 'Email not verified',
};

const ACTION_LABELS = {
  convert_full: 'Convert',
  convert_preview: 'Convert a preview',
  buy_payg_or_wait_renewal: 'Buy a PAYG credit or wait for renewal',
  upgrade_or_buy_payg: 'Upgrade or buy PAYG credits',
  verify_email: 'Verify your email',
  retry_later: 'Retry later',
  contact_support: 'Contact support',
  none: 'None',
};

/** Turn unknown_snake_code into "Unknown snake code". */
function humanizeCode(code) {
  if (code == null || code === '') return '';
  const s = String(code).replace(/_/g, ' ').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function labelFromMap(map, code, fallbackHumanize = true) {
  if (code == null || code === '') return null;
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
  return fallbackHumanize ? humanizeCode(code) : String(code);
}

function modeLabel(mode) {
  return labelFromMap(MODE_LABELS, mode) || 'Unknown';
}

function reasonLabel(reason) {
  return labelFromMap(REASON_LABELS, reason);
}

function actionLabel(action) {
  return labelFromMap(ACTION_LABELS, action);
}

/**
 * Presentational label for what the next conversion consumes.
 * Uses plan + reason only for wording when consumes === 'none'.
 */
function consumesLabel(consumes, { plan, reason, canStart } = {}) {
  if (consumes == null || consumes === '') return null;

  if (consumes === 'none') {
    // Blocked: never say "No credit deduction"
    if (canStart === false) {
      return reasonLabel(reason) || null;
    }
    const p = String(plan || '').toLowerCase();
    if (p === 'agency') return 'Agency allowance';
    if (reason === 'subscription_quota_available') {
      // Starter→Pro delta path reports consumes none + this reason
      if (p === 'starter') return 'Starter→Pro reconversion';
    }
    return CONSUMES_LABELS.none;
  }

  return labelFromMap(CONSUMES_LABELS, consumes);
}

function safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

function plural(n, singular, pluralForm) {
  return n === 1 ? singular : (pluralForm || `${singular}s`);
}

/**
 * @returns {object|null} capabilities.conversion when present with a boolean can_start
 */
function getConversionCapability(quota) {
  const conv = quota && quota.capabilities && quota.capabilities.conversion;
  if (!conv || typeof conv !== 'object') return null;
  if (typeof conv.can_start !== 'boolean') return null;
  return conv;
}

function downloadLabel(capabilities) {
  const dl = capabilities && capabilities.outputs && capabilities.outputs.download;
  if (!dl || typeof dl !== 'object') return null;
  if (dl.available === true) return 'Available';
  if (dl.available === false) {
    if (dl.reason === 'download_requires_upgrade') return 'Requires upgrade';
    return 'Locked';
  }
  return null;
}

function formatUsageLines(quota, capabilities) {
  const lines = [];
  const usage = (capabilities && capabilities.usage) || {};
  const sub = usage.subscription || {};
  const plan = String(usage.plan || quota.effectivePlan || '').toLowerCase();
  const mode = capabilities && capabilities.conversion && capabilities.conversion.mode;

  const rem = safeCount(sub.remaining != null ? sub.remaining : quota.remaining);
  const lim = safeCount(sub.limit != null ? sub.limit : quota.max);
  const used = safeCount(sub.used != null ? sub.used : quota.current);

  if (mode !== 'preview_only' && lim != null && rem != null) {
    lines.push({
      key: 'Subscription',
      value: `${rem} of ${lim} remaining`,
    });
  } else if (mode !== 'preview_only' && used != null && lim != null) {
    lines.push({
      key: 'Subscription',
      value: `${Math.max(0, lim - used)} of ${lim} remaining`,
    });
  }

  const payg = safeCount(usage.payg_credits != null ? usage.payg_credits : quota.payg_credits);
  if (payg != null) {
    // Show PAYG when present, or when 0 on Pro (useful for blocked/exhausted messaging).
    // Hide zero PAYG noise on preview-only Starter paths.
    if (payg > 0 || (plan === 'pro' && mode !== 'preview_only')) {
      lines.push({
        key: 'PAYG',
        value: `${payg} ${plural(payg, 'credit')}`,
      });
    }
  }

  const starter = safeCount(usage.starter_credits != null ? usage.starter_credits : quota.conversion_credits);
  // Starter credits matter for full-mode Starter paths; skip on preview-only (uses free previews).
  if (starter != null && starter > 0 && plan === 'starter' && mode !== 'preview_only') {
    lines.push({
      key: 'Starter credits',
      value: `${starter} ${plural(starter, 'credit')}`,
    });
  }

  const fp = usage.free_previews || {};
  const fpRem = safeCount(fp.remaining != null ? fp.remaining : quota.dev_preview_remaining);
  const fpLim = safeCount(fp.limit != null ? fp.limit : quota.dev_preview_limit);
  if (mode === 'preview_only' && fpRem != null && fpLim != null) {
    lines.push({
      key: 'Free previews',
      value: `${fpRem} of ${fpLim} remaining`,
    });
  } else if (mode === 'preview_only' && fpRem != null) {
    lines.push({
      key: 'Free previews',
      value: `${fpRem} ${plural(fpRem, 'preview')} remaining`,
    });
  }

  const delta = safeCount(quota.unused_delta_entitlements);
  if (delta != null && delta > 0) {
    lines.push({
      key: 'Reconversions',
      value: `${delta} unused Starter→Pro ${plural(delta, 'reconversion')}`,
    });
  }

  return lines;
}

/**
 * Format human-readable quota lines (without ANSI). Returns string[].
 */
function formatQuotaHuman(quota) {
  if (!quota || typeof quota !== 'object') {
    return ['Plan             unknown'];
  }

  const caps = quota.capabilities;
  const conv = getConversionCapability(quota);
  const lines = [];

  const plan = (caps && caps.usage && caps.usage.plan) || quota.effectivePlan || 'unknown';
  lines.push(`Plan             ${String(plan).charAt(0).toUpperCase()}${String(plan).slice(1)}`);

  if (!conv) {
    // Legacy backend: preserve prior flat fields
    lines.push(`Used             ${quota.current ?? '?'} / ${quota.max ?? '?'}`);
    lines.push(`Remaining        ${quota.remaining ?? '?'}`);
    if (quota.payg_credits != null) {
      const p = safeCount(quota.payg_credits) ?? 0;
      lines.push(`PAYG             ${p} ${plural(p, 'credit')}`);
    }
    if (quota.unused_delta_entitlements) {
      const d = safeCount(quota.unused_delta_entitlements) || 0;
      lines.push(`Reconversions    ${d} unused upgrade ${plural(d, 'reconversion')}`);
    }
    return lines;
  }

  lines.push(`Conversion mode  ${modeLabel(conv.mode)}`);
  lines.push(`Can start        ${conv.can_start ? 'Yes' : 'No'}`);

  if (conv.can_start) {
    const uses = consumesLabel(conv.consumes, {
      plan,
      reason: conv.reason,
      canStart: true,
    });
    if (uses) lines.push(`Next conversion  ${uses}`);
  }

  for (const u of formatUsageLines(quota, caps)) {
    const pad = u.key.padEnd(16, ' ');
    lines.push(`${pad} ${u.value}`);
  }

  const dl = downloadLabel(caps);
  if (dl) lines.push(`Download         ${dl}`);

  if (!conv.can_start && conv.reason) {
    const r = reasonLabel(conv.reason);
    if (r) lines.push(`Reason           ${r}`);
  }

  const action = (caps && caps.recommended_action) || null;
  if (action && action !== 'none') {
    const a = actionLabel(action);
    if (a) lines.push(`Action           ${a}`);
  }

  return lines;
}

/**
 * One-line pre-submit summary when can_start is true.
 * e.g. "Mode: Preview only · Uses: Free developer preview · Download: Locked"
 */
function formatPreflightSummary(quota) {
  const conv = getConversionCapability(quota);
  if (!conv || !conv.can_start) return null;

  const plan = (quota.capabilities && quota.capabilities.usage && quota.capabilities.usage.plan)
    || quota.effectivePlan;
  const uses = consumesLabel(conv.consumes, {
    plan,
    reason: conv.reason,
    canStart: true,
  }) || 'Unknown';
  const dl = downloadLabel(quota.capabilities);
  const downloadText = dl === 'Available' ? 'Available' : (dl || 'Locked');

  return `Mode: ${modeLabel(conv.mode)} · Uses: ${uses} · Download: ${downloadText === 'Requires upgrade' ? 'Locked' : downloadText}`;
}

/**
 * Denial message lines for can_start === false.
 */
function formatDenialMessage(quota) {
  const caps = quota && quota.capabilities;
  const conv = getConversionCapability(quota);
  if (!conv) return ['Conversion is not available.'];

  const lines = [];
  const reason = reasonLabel(conv.reason) || 'Conversion cannot start';
  lines.push(reason);

  const action = caps && caps.recommended_action;
  if (action && action !== 'none') {
    const a = actionLabel(action);
    if (a) lines.push(`Next step: ${a}`);
  }

  for (const u of formatUsageLines(quota, caps)) {
    lines.push(`${u.key}: ${u.value}`);
  }

  return lines;
}

/**
 * Resolve convert preflight against a quota snapshot (or via getQuotaFn).
 *
 * @param {() => Promise<object>} getQuotaFn
 * @returns {Promise<{
 *   outcome: 'allow'|'deny'|'legacy'|'auth_error'|'warn_continue',
 *   quota?: object,
 *   error?: Error,
 *   warning?: string,
 * }>}
 */
async function resolveConvertPreflight(getQuotaFn) {
  let quota;
  try {
    quota = await getQuotaFn();
  } catch (e) {
    const code = e && e.code;
    if (
      code === 'missing_credentials' ||
      code === 'invalid_api_key' ||
      code === 'email_not_verified' ||
      (e && e.status === 401) ||
      (e && e.status === 403 && (code === 'invalid_api_key' || code === 'email_not_verified'))
    ) {
      return { outcome: 'auth_error', error: e };
    }
    return {
      outcome: 'warn_continue',
      error: e,
      warning:
        'Could not verify conversion availability. Continuing; the server will enforce entitlement.',
    };
  }

  if (!quota || typeof quota !== 'object') {
    return {
      outcome: 'warn_continue',
      quota,
      warning:
        'Could not verify conversion availability. Continuing; the server will enforce entitlement.',
    };
  }

  const conv = getConversionCapability(quota);
  if (!conv) {
    return { outcome: 'legacy', quota };
  }

  if (conv.can_start === false) {
    return { outcome: 'deny', quota };
  }

  return { outcome: 'allow', quota };
}

/** Whether a job should be treated as downloadable (server job flags win). */
function jobIsDownloadable(status, { previewOnlyHint } = {}) {
  if (status && (status.preview_only === true || status.conversion_mode === 'preview_only')) {
    return false;
  }
  if (previewOnlyHint === true) return false;
  if (status && status.download_available === false) return false;
  if (status && status.download_available === true) return true;
  // Unknown: not preview-only — treat as potentially downloadable for guidance
  return !previewOnlyHint;
}

module.exports = {
  EXIT_ENTITLEMENT_DENIED,
  MODE_LABELS,
  CONSUMES_LABELS,
  REASON_LABELS,
  ACTION_LABELS,
  humanizeCode,
  modeLabel,
  reasonLabel,
  actionLabel,
  consumesLabel,
  safeCount,
  getConversionCapability,
  downloadLabel,
  formatQuotaHuman,
  formatPreflightSummary,
  formatDenialMessage,
  formatUsageLines,
  resolveConvertPreflight,
  jobIsDownloadable,
};
