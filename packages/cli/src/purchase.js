'use strict';

/**
 * What the terminal shows before anyone pays. Text and prices come from the
 * server (GET /api/billing/catalog and /cli-options); this module only lays
 * them out, maps flags to one option, and words the confirmation.
 */

const PACK_SIZES = [1, 5, 10, 30];

function formatCents(cents) {
  const n = Math.round(Number(cents) || 0) / 100;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const credits = (n) => `${n} credit${n === 1 ? '' : 's'}`;

function optionPrice(option) {
  if (option.kind === 'starter') return `${formatCents(option.price_cents)} one-time`;
  if (option.kind === 'payg') return option.packs.map((p) => `${credits(p.size)} ${formatCents(p.price_cents)}`).join(', ');
  return `${formatCents(option.price_cents.month)}/month or ${formatCents(option.price_cents.year)}/year`;
}

/** `wpconvert plans`: every option, what it includes, today's price. */
function formatPlans(catalog) {
  const lines = [];
  for (const option of catalog.options || []) {
    lines.push(`${option.name}  ${optionPrice(option)}`);
    if (option.summary) lines.push(`  ${option.summary}`);
    for (const f of option.features || []) lines.push(`  - ${f}`);
    if (option.kind === 'starter' && option.pro_delta_cents) {
      lines.push(`  Some themes offer an optional ${formatCents(option.pro_delta_cents)} Pro upgrade at checkout.`);
    }
    if (option.kind === 'pro' && option.starter_credit_cents) {
      lines.push(`  Starter buyers get ${formatCents(option.starter_credit_cents)} off the first month.`);
    }
    lines.push('');
  }
  if (catalog.price_source !== 'stripe') lines.push('Prices shown are the published prices; Stripe shows the final price before you pay.');
  return lines;
}

/**
 * Numbered choices for `unlock <jobId>` (jobId set) or `upgrade` (no theme).
 * Each entry carries the exact cli-checkout request it will send.
 */
function buildMenu(cliOptions, { jobId }) {
  const byKind = Object.fromEntries((cliOptions.options || []).map((o) => [o.kind, o]));
  const subscriber = cliOptions.existing_subscriber === true;
  const menu = [];

  const starter = byKind.starter;
  if (jobId && starter && starter.available) {
    menu.push({
      id: 'starter',
      label: 'Starter: download this theme',
      price: `${formatCents(starter.today_cents)} one-time`,
      amount: formatCents(starter.today_cents),
      billing: 'once',
      note: starter.pro_delta_available ? `Checkout offers an optional ${formatCents(starter.pro_delta_cents)} Pro upgrade for this theme.` : null,
      request: { kind: 'starter' },
    });
  }

  for (const kind of ['pro', 'agency']) {
    const plan = byKind[kind];
    if (!plan) continue;
    const portal = plan.action === 'portal' || subscriber;
    for (const interval of ['month', 'year']) {
      const full = plan.price_cents[interval];
      const today = plan.today_cents ? plan.today_cents[interval] : full;
      const per = `${formatCents(full)}/${interval}`;
      menu.push({
        id: `${kind}-${interval}`,
        label: `${plan.name} (${interval === 'month' ? 'monthly' : 'yearly'})${jobId ? ': unlocks this theme and future conversions' : ''}`,
        price: today !== full ? `${formatCents(today)} today, then ${per}` : per,
        amount: per,
        billing: interval,
        portal,
        note: portal ? 'You already have a subscription; plan changes happen in the billing portal.' : null,
        request: { kind, interval },
      });
    }
  }

  const payg = byKind.payg;
  if (payg && payg.available !== false) {
    for (const pack of payg.packs || []) {
      menu.push({
        id: `payg-${pack.size}`,
        label: `Pay-as-you-go: ${credits(pack.size)}${jobId ? ' (one unlocks this theme)' : ''}`,
        price: formatCents(pack.price_cents),
        amount: formatCents(pack.price_cents),
        billing: 'once',
        request: { kind: 'payg', packSize: pack.size },
      });
    }
  }
  return menu;
}

/** --starter / --pro / --agency / --payg <n> / --yearly to one menu entry. */
function pickFromFlags(menu, flags) {
  const chosen = ['starter', 'pro', 'agency'].filter((k) => flags[k]);
  if (flags.payg !== undefined && flags.payg !== false) chosen.push('payg');
  if (chosen.length === 0) {
    if (flags.yearly) return { entry: null, error: 'Pass --pro or --agency with --yearly.' };
    return { entry: null };
  }
  if (chosen.length > 1) return { entry: null, error: 'Choose only one of --starter, --pro, --agency or --payg.' };
  const kind = chosen[0];
  if (flags.yearly && (kind === 'starter' || kind === 'payg')) {
    return { entry: null, error: '--yearly only applies to --pro and --agency.' };
  }
  let id = kind;
  if (kind === 'pro' || kind === 'agency') id = `${kind}-${flags.yearly ? 'year' : 'month'}`;
  if (kind === 'payg') {
    const size = Number(flags.payg);
    if (!PACK_SIZES.includes(size)) return { entry: null, error: '--payg takes a pack size: 1, 5, 10 or 30.' };
    id = `payg-${size}`;
  }
  const entry = menu.find((e) => e.id === id);
  if (!entry) return { entry: null, error: 'That option is not available for this theme.' };
  return { entry };
}

function confirmQuestion(entry) {
  if (entry.portal) return 'Open the billing portal to change plans?';
  return `Open Stripe to pay ${entry.amount}?`;
}

/** Changes when a purchase lands (plan or credits), not when a conversion is used. */
function quotaFingerprint(q) {
  const quota = q || {};
  return JSON.stringify([
    quota.effectivePlan || quota.plan || null,
    quota.payg_credits || 0,
    quota.conversion_credits || 0,
    quota.max ?? null,
  ]);
}

module.exports = {
  PACK_SIZES,
  formatCents,
  formatPlans,
  buildMenu,
  pickFromFlags,
  confirmQuestion,
  quotaFingerprint,
};
