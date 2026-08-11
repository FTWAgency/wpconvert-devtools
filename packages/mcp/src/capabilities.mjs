/**
 * Pure MCP projections for developer-capabilities contract.
 * No entitlement math — delegates to wpconvert/src/capabilities for labels/preflight.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  getConversionCapability,
  formatPreflightSummary,
  formatDenialMessage,
  formatQuotaHuman,
  reasonLabel,
  actionLabel,
  jobIsDownloadable,
} = require('wpconvert/src/capabilities');

const TOOL_QUOTA = 'wpconvert_quota';
const TOOL_CONVERT = 'wpconvert_convert_folder';
const TOOL_STATUS = 'wpconvert_check_status';
const TOOL_DOWNLOAD = 'wpconvert_download_result';
const TOOL_PREVIEW = 'wpconvert_create_preview';
const TOOL_EXPLAIN = 'wpconvert_explain_failure';

const STATUS_POLL_SECONDS = 15;

function downloadAvailable(capabilities) {
  const dl = capabilities && capabilities.outputs && capabilities.outputs.download;
  if (!dl || typeof dl !== 'object') return null;
  return dl.available === true;
}

function buildSummary(quota) {
  const conv = getConversionCapability(quota);
  if (!conv) return undefined;
  const caps = quota.capabilities || {};
  const dl = downloadAvailable(caps);
  return {
    can_start: conv.can_start,
    mode: conv.mode,
    consumes: conv.consumes,
    reason: conv.reason,
    download_available: dl === true,
    recommended_action: caps.recommended_action || null,
  };
}

/**
 * Recommend the next MCP tool from a quota snapshot.
 */
export function recommendedNextForQuota(quota) {
  const conv = getConversionCapability(quota);
  if (!conv) {
    return {
      tool: TOOL_CONVERT,
      reason: 'Capabilities unavailable from server; server will enforce entitlement on submit.',
    };
  }
  if (conv.can_start === false) {
    const action = quota.capabilities && quota.capabilities.recommended_action;
    const actionText = action ? actionLabel(action) : null;
    return {
      tool: TOOL_QUOTA,
      reason: actionText
        ? `Conversion blocked. ${actionText}. Review quota before retrying.`
        : 'Conversion blocked. Review quota and recommended action before retrying.',
    };
  }
  const mode = conv.mode === 'preview_only' ? 'preview' : 'full';
  return {
    tool: TOOL_CONVERT,
    reason: `Conversion allowed (${mode} mode). Call wpconvert_convert_folder when ready.`,
  };
}

/**
 * Project quota API response into MCP structured payload.
 */
export function projectQuotaResponse(quota) {
  const conv = getConversionCapability(quota);
  const capabilitiesAvailable = !!conv;
  return {
    ok: true,
    quota,
    capabilities_available: capabilitiesAvailable,
    summary: buildSummary(quota),
    recommended_next: recommendedNextForQuota(quota),
  };
}

/**
 * Recommend the next MCP tool from a job status snapshot.
 */
export function recommendedNextForStatus(status) {
  const s = status || {};
  const jobStatus = String(s.status || '').toLowerCase();

  if (jobStatus === 'failed') {
    return {
      tool: TOOL_EXPLAIN,
      reason: 'Job failed. Use wpconvert_explain_failure for details and recovery guidance.',
    };
  }

  if (jobStatus === 'queued' || jobStatus === 'processing' || jobStatus === 'pending') {
    return {
      tool: TOOL_STATUS,
      reason: 'Job still running. Poll wpconvert_check_status until done.',
      retry_after_seconds: STATUS_POLL_SECONDS,
    };
  }

  if (jobStatus === 'done') {
    const previewOnly = s.preview_only === true || s.conversion_mode === 'preview_only';
    const downloadable = jobIsDownloadable(s);

    if (previewOnly || !downloadable) {
      return {
        tool: TOOL_PREVIEW,
        reason: previewOnly
          ? 'Preview-only conversion. Use wpconvert_create_preview; download requires upgrade.'
          : 'Download unavailable. Use wpconvert_create_preview or review quota.',
      };
    }

    return {
      tool: TOOL_DOWNLOAD,
      reason: 'Conversion complete. Download theme.zip with wpconvert_download_result.',
    };
  }

  return {
    tool: TOOL_STATUS,
    reason: 'Poll wpconvert_check_status for the latest job state.',
    retry_after_seconds: STATUS_POLL_SECONDS,
  };
}

/**
 * Project job status into MCP structured payload (no fabricated fields).
 */
export function projectStatusResponse(status) {
  const s = status || {};
  const out = {
    job_id: s.jobId || s.project_id || s.id || null,
    project_id: s.project_id || s.jobId || s.id || null,
    status: s.status || null,
    recommended_next: recommendedNextForStatus(s),
  };

  if (s.progress != null) out.progress = s.progress;
  if (s.error != null) out.error = s.error;
  if (s.preview_only != null) out.preview_only = s.preview_only;
  if (s.conversion_mode != null) out.conversion_mode = s.conversion_mode;
  if (s.download_available != null) out.download_available = s.download_available;
  if (s.preview_available != null) out.preview_available = s.preview_available;

  return out;
}

/**
 * Structured denial when preflight returns can_start === false.
 */
export function buildConversionDenial(quota) {
  const caps = (quota && quota.capabilities) || {};
  const conv = getConversionCapability(quota) || {};
  const denialLines = formatDenialMessage(quota);
  const message = denialLines.join(' ');

  return {
    ok: false,
    error: {
      code: 'conversion_not_available',
      message,
      reason: conv.reason || 'conversion_not_available',
      recommended_action: caps.recommended_action || null,
      retry_safe: false,
      mode: conv.mode || null,
      consumes: conv.consumes || null,
    },
    quota,
    summary: buildSummary(quota),
    recommended_next: recommendedNextForQuota(quota),
  };
}

/**
 * Human-readable quota text for MCP tool prose.
 */
export function formatQuotaText(quota) {
  return formatQuotaHuman(quota).join('\n');
}

/**
 * One-line preflight summary when conversion is allowed.
 */
export function formatAllowSummary(quota) {
  return formatPreflightSummary(quota);
}

export {
  TOOL_QUOTA,
  TOOL_CONVERT,
  TOOL_STATUS,
  TOOL_DOWNLOAD,
  TOOL_PREVIEW,
  TOOL_EXPLAIN,
  STATUS_POLL_SECONDS,
  reasonLabel,
};
