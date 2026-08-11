'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  EXIT_ENTITLEMENT_DENIED,
  humanizeCode,
  modeLabel,
  reasonLabel,
  actionLabel,
  consumesLabel,
  getConversionCapability,
  formatQuotaHuman,
  formatPreflightSummary,
  formatDenialMessage,
  resolveConvertPreflight,
  jobIsDownloadable,
} = require('../src/capabilities');

function caps(overrides = {}) {
  const conversion = {
    can_start: true,
    mode: 'full',
    consumes: 'subscription_quota',
    reason: 'subscription_quota_available',
    ...overrides.conversion,
  };
  return {
    effectivePlan: overrides.effectivePlan || 'pro',
    current: overrides.current ?? 2,
    max: overrides.max ?? 20,
    remaining: overrides.remaining ?? 18,
    payg_credits: overrides.payg_credits ?? 0,
    conversion_credits: overrides.conversion_credits ?? 0,
    unused_delta_entitlements: overrides.unused_delta_entitlements ?? 0,
    api_conversion_mode: overrides.api_conversion_mode || 'full',
    capabilities: {
      conversion,
      usage: {
        plan: overrides.effectivePlan || 'pro',
        subscription: {
          limit: overrides.max ?? 20,
          used: overrides.current ?? 2,
          remaining: overrides.remaining ?? 18,
        },
        payg_credits: overrides.payg_credits ?? 0,
        starter_credits: overrides.conversion_credits ?? 0,
        free_previews: {
          limit: overrides.dev_preview_limit ?? 3,
          used: overrides.dev_preview_count ?? 0,
          remaining: overrides.dev_preview_remaining ?? 3,
        },
      },
      outputs: {
        download: {
          available: overrides.download_available !== false && conversion.mode === 'full' && conversion.can_start,
          reason: conversion.mode === 'preview_only' ? 'download_requires_upgrade' : null,
        },
      },
      recommended_action: overrides.recommended_action || 'convert_full',
      reasons: overrides.reasons || [conversion.reason],
      ...overrides.capabilitiesExtra,
    },
  };
}

describe('capabilities formatters', () => {
  it('exports exit code 3 for entitlement denial', () => {
    assert.strictEqual(EXIT_ENTITLEMENT_DENIED, 3);
  });

  it('humanizes unknown codes safely', () => {
    assert.strictEqual(humanizeCode('some_future_code'), 'Some future code');
    assert.strictEqual(reasonLabel('some_future_code'), 'Some future code');
    assert.strictEqual(actionLabel('brand_new_action'), 'Brand new action');
    assert.strictEqual(modeLabel('weird_mode'), 'Weird mode');
  });

  it('maps known reason and action labels', () => {
    assert.strictEqual(reasonLabel('subscription_quota_exhausted'), 'Subscription quota exhausted');
    assert.strictEqual(actionLabel('buy_payg_or_wait_renewal'), 'Buy a PAYG credit or wait for renewal');
    assert.strictEqual(modeLabel('preview_only'), 'Preview only');
  });

  it('labels Agency none as Agency allowance', () => {
    assert.strictEqual(
      consumesLabel('none', { plan: 'agency', reason: 'subscription_quota_available', canStart: true }),
      'Agency allowance'
    );
  });

  it('labels Starter delta none as Starter→Pro reconversion', () => {
    assert.strictEqual(
      consumesLabel('none', { plan: 'starter', reason: 'subscription_quota_available', canStart: true }),
      'Starter→Pro reconversion'
    );
  });

  it('does not show No credit deduction when blocked', () => {
    const label = consumesLabel('none', {
      plan: 'pro',
      reason: 'subscription_quota_exhausted',
      canStart: false,
    });
    assert.strictEqual(label, 'Subscription quota exhausted');
    assert.ok(!String(label).includes('No credit deduction'));
  });

  it('formats Pro full conversion quota', () => {
    const text = formatQuotaHuman(caps({
      remaining: 18,
      max: 20,
      current: 2,
      payg_credits: 2,
    })).join('\n');
    assert.match(text, /Plan\s+Pro/);
    assert.match(text, /Conversion mode\s+Full/);
    assert.match(text, /Can start\s+Yes/);
    assert.match(text, /Next conversion\s+Subscription quota/);
    assert.match(text, /Subscription\s+18 of 20 remaining/);
    assert.match(text, /PAYG\s+2 credits/);
    assert.match(text, /Download\s+Available/);
    assert.match(text, /Action\s+Convert/);
  });

  it('formats Starter preview-only quota', () => {
    const q = caps({
      effectivePlan: 'starter',
      api_conversion_mode: 'preview_only',
      conversion: {
        can_start: true,
        mode: 'preview_only',
        consumes: 'free_preview',
        reason: 'free_preview_available',
      },
      recommended_action: 'convert_preview',
      download_available: false,
      remaining: 1,
      max: 1,
      current: 0,
    });
    q.capabilities.outputs.download = { available: false, reason: 'download_requires_upgrade' };
    const text = formatQuotaHuman(q).join('\n');
    assert.match(text, /Plan\s+Starter/);
    assert.match(text, /Conversion mode\s+Preview only/);
    assert.match(text, /Next conversion\s+Free developer preview/);
    assert.match(text, /Free previews\s+3 of 3 remaining/);
    assert.match(text, /Download\s+Requires upgrade/);
    assert.match(text, /Action\s+Convert a preview/);
  });

  it('formats blocked subscription exhausted quota', () => {
    const q = caps({
      remaining: 0,
      max: 20,
      current: 20,
      payg_credits: 0,
      conversion: {
        can_start: false,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_exhausted',
      },
      recommended_action: 'buy_payg_or_wait_renewal',
    });
    q.capabilities.outputs.download = { available: false, reason: 'download_requires_upgrade' };
    const text = formatQuotaHuman(q).join('\n');
    assert.match(text, /Can start\s+No/);
    assert.match(text, /Reason\s+Subscription quota exhausted/);
    assert.match(text, /Action\s+Buy a PAYG credit or wait for renewal/);
    assert.ok(!/Next conversion/.test(text));
  });

  it('formats PAYG fallback', () => {
    const text = formatQuotaHuman(caps({
      remaining: 0,
      max: 20,
      current: 20,
      payg_credits: 3,
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'payg_credit',
        reason: 'payg_credit_available',
      },
    })).join('\n');
    assert.match(text, /Next conversion\s+PAYG credit/);
    assert.match(text, /PAYG\s+3 credits/);
  });

  it('formats Starter credit path', () => {
    const text = formatQuotaHuman(caps({
      effectivePlan: 'starter',
      conversion_credits: 1,
      remaining: 0,
      max: 1,
      current: 1,
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'starter_credit',
        reason: 'starter_credit_available',
      },
    })).join('\n');
    assert.match(text, /Next conversion\s+Starter credit/);
    assert.match(text, /Starter credits\s+1 credit/);
  });

  it('formats Agency non-consuming path', () => {
    const text = formatQuotaHuman(caps({
      effectivePlan: 'agency',
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_available',
      },
    })).join('\n');
    assert.match(text, /Next conversion\s+Agency allowance/);
  });

  it('formats Starter→Pro delta entitlement presentation', () => {
    const text = formatQuotaHuman(caps({
      effectivePlan: 'starter',
      unused_delta_entitlements: 1,
      conversion: {
        can_start: true,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_available',
      },
    })).join('\n');
    assert.match(text, /Next conversion\s+Starter→Pro reconversion/);
    assert.match(text, /Reconversions\s+1 unused Starter→Pro reconversion/);
  });

  it('formats download locked', () => {
    const q = caps({
      conversion: {
        can_start: true,
        mode: 'preview_only',
        consumes: 'free_preview',
        reason: 'free_preview_available',
      },
      recommended_action: 'convert_preview',
    });
    q.capabilities.outputs.download = { available: false, reason: 'download_requires_upgrade' };
    const text = formatQuotaHuman(q).join('\n');
    assert.match(text, /Download\s+Requires upgrade/);
  });

  it('legacy missing capabilities keeps flat output', () => {
    const text = formatQuotaHuman({
      effectivePlan: 'pro',
      current: 1,
      max: 20,
      remaining: 19,
      payg_credits: 2,
      unused_delta_entitlements: 1,
    }).join('\n');
    assert.match(text, /Plan\s+Pro/);
    assert.match(text, /Used\s+1 \/ 20/);
    assert.match(text, /Remaining\s+19/);
    assert.match(text, /PAYG\s+2 credits/);
    assert.match(text, /Reconversions/);
    assert.ok(!/Conversion mode/.test(text));
    assert.ok(!/Can start/.test(text));
  });

  it('getConversionCapability requires boolean can_start', () => {
    assert.strictEqual(getConversionCapability({}), null);
    assert.strictEqual(getConversionCapability({ capabilities: { conversion: { mode: 'full' } } }), null);
    assert.ok(getConversionCapability(caps()));
  });

  it('formatPreflightSummary for full and preview', () => {
    const full = formatPreflightSummary(caps());
    assert.match(full, /Mode: Full/);
    assert.match(full, /Uses: Subscription quota/);
    assert.match(full, /Download: Available/);

    const preview = caps({
      effectivePlan: 'starter',
      conversion: {
        can_start: true,
        mode: 'preview_only',
        consumes: 'free_preview',
        reason: 'free_preview_available',
      },
    });
    preview.capabilities.outputs.download = { available: false, reason: 'download_requires_upgrade' };
    const p = formatPreflightSummary(preview);
    assert.match(p, /Mode: Preview only/);
    assert.match(p, /Uses: Free developer preview/);
    assert.match(p, /Download: Locked/);
  });

  it('formatDenialMessage includes reason and action', () => {
    const q = caps({
      remaining: 0,
      conversion: {
        can_start: false,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_exhausted',
      },
      recommended_action: 'buy_payg_or_wait_renewal',
    });
    const lines = formatDenialMessage(q);
    assert.ok(lines.some((l) => /Subscription quota exhausted/.test(l)));
    assert.ok(lines.some((l) => /Next step: Buy a PAYG credit/.test(l)));
  });
});

describe('resolveConvertPreflight', () => {
  it('allows when can_start true', async () => {
    const r = await resolveConvertPreflight(async () => caps());
    assert.strictEqual(r.outcome, 'allow');
  });

  it('denies when can_start false', async () => {
    const r = await resolveConvertPreflight(async () => caps({
      conversion: {
        can_start: false,
        mode: 'full',
        consumes: 'none',
        reason: 'subscription_quota_exhausted',
      },
    }));
    assert.strictEqual(r.outcome, 'deny');
  });

  it('legacy when capabilities missing', async () => {
    const r = await resolveConvertPreflight(async () => ({
      effectivePlan: 'pro',
      remaining: 5,
    }));
    assert.strictEqual(r.outcome, 'legacy');
  });

  it('auth_error on missing credentials', async () => {
    const err = Object.assign(new Error('no key'), { code: 'missing_credentials', name: 'ApiError' });
    const r = await resolveConvertPreflight(async () => { throw err; });
    assert.strictEqual(r.outcome, 'auth_error');
  });

  it('warn_continue on network failure', async () => {
    const err = Object.assign(new Error('boom'), { code: 'network_error', name: 'ApiError', status: 0 });
    const r = await resolveConvertPreflight(async () => { throw err; });
    assert.strictEqual(r.outcome, 'warn_continue');
    assert.match(r.warning, /Could not verify conversion availability/);
  });

  it('warn_continue on 5xx', async () => {
    const err = Object.assign(new Error('server'), { code: 'http_error', name: 'ApiError', status: 503 });
    const r = await resolveConvertPreflight(async () => { throw err; });
    assert.strictEqual(r.outcome, 'warn_continue');
  });

  it('warn_continue on malformed body', async () => {
    const r = await resolveConvertPreflight(async () => null);
    assert.strictEqual(r.outcome, 'warn_continue');
  });
});

describe('jobIsDownloadable', () => {
  it('preview-only job is not downloadable', () => {
    assert.strictEqual(jobIsDownloadable({ preview_only: true, download_available: false }), false);
    assert.strictEqual(jobIsDownloadable({ conversion_mode: 'preview_only' }), false);
  });

  it('download_available true wins when not preview-only', () => {
    assert.strictEqual(jobIsDownloadable({ download_available: true, status: 'done' }), true);
  });

  it('download_available false blocks', () => {
    assert.strictEqual(jobIsDownloadable({ download_available: false }), false);
  });

  it('preflight hint does not override server preview_only false with download true', () => {
    assert.strictEqual(
      jobIsDownloadable({ download_available: true, preview_only: false }, { previewOnlyHint: true }),
      false
    );
  });
});
