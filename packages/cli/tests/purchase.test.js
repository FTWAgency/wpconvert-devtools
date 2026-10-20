'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const purchase = require('../src/purchase');

const catalog = {
  currency: 'usd',
  price_source: 'stripe',
  trial_available: false,
  options: [
    { kind: 'starter', name: 'Starter', billing: 'one_time', summary: 'Unlock and download this one theme. One-time payment.', features: ['Standard WordPress theme export (.zip)'], price_cents: 1900, pro_delta_cents: 600 },
    { kind: 'pro', name: 'Pro', billing: 'subscription', summary: 'Monthly plan for professionals.', features: ['20 conversions per month'], price_cents: { month: 4900, year: 49000 }, starter_credit_cents: 1900 },
    { kind: 'agency', name: 'Agency', billing: 'subscription', summary: 'Everything in Pro for teams.', features: ['Unlimited conversions'], price_cents: { month: 24900, year: 249000 } },
    { kind: 'payg', name: 'Pay-as-you-go credits', billing: 'one_time', summary: 'Credits, no subscription.', features: ['No expiry.'], packs: [{ size: 1, price_cents: 2500 }, { size: 5, price_cents: 9900 }, { size: 10, price_cents: 17900 }, { size: 30, price_cents: 39900 }] },
  ],
};

function options({ subscriber = false, starterCredit = false, unlockable = true, delta = false } = {}) {
  return {
    currency: 'usd',
    trial_available: false,
    existing_subscriber: subscriber,
    job: { id: '11111111-1111-4111-8111-111111111111', unlockable, reason: unlockable ? null : 'preview_only' },
    options: [
      { ...catalog.options[0], available: unlockable, today_cents: 1900, pro_delta_available: delta },
      { ...catalog.options[1], action: subscriber ? 'portal' : 'checkout', starter_credit_applies: starterCredit, today_cents: { month: starterCredit ? 3000 : 4900, year: 49000 } },
      { ...catalog.options[2], action: subscriber ? 'portal' : 'checkout', today_cents: { month: 24900, year: 249000 } },
      { ...catalog.options[3], available: unlockable, today_cents: [{ size: 1, cents: 2500 }, { size: 5, cents: 9900 }, { size: 10, cents: 17900 }, { size: 30, cents: 39900 }] },
    ],
  };
}

describe('formatCents', () => {
  it('formats US dollars', () => {
    assert.strictEqual(purchase.formatCents(1900), '$19.00');
    assert.strictEqual(purchase.formatCents(249000), '$2,490.00');
  });
});

describe('formatPlans', () => {
  it('lists all four options with what each includes and today\'s price, and no trial', () => {
    const out = purchase.formatPlans(catalog).join('\n');
    assert.match(out, /Starter/);
    assert.match(out, /\$19\.00 one-time/);
    assert.match(out, /Pro/);
    assert.match(out, /\$49\.00\/month or \$490\.00\/year/);
    assert.match(out, /Agency/);
    assert.match(out, /\$249\.00\/month or \$2,490\.00\/year/);
    assert.match(out, /1 credit \$25\.00/);
    assert.match(out, /30 credits \$399\.00/);
    assert.match(out, /20 conversions per month/);
    assert.doesNotMatch(out, /trial/i);
  });

  it('says when prices are the published ones rather than live', () => {
    const out = purchase.formatPlans({ ...catalog, price_source: 'published' }).join('\n');
    assert.match(out, /Stripe shows the final price/);
  });
});

describe('buildMenu', () => {
  it('offers every option for a theme, numbered, with today\'s price', () => {
    const menu = purchase.buildMenu(options({ starterCredit: true, delta: true }), { jobId: 'x' });
    assert.deepStrictEqual(menu.map((e) => e.id), ['starter', 'pro-month', 'pro-year', 'agency-month', 'agency-year', 'payg-1', 'payg-5', 'payg-10', 'payg-30']);
    const pro = menu.find((e) => e.id === 'pro-month');
    assert.match(pro.price, /\$30\.00 today, then \$49\.00\/month/);
    assert.match(menu[0].note, /optional \$6\.00 Pro upgrade/);
    assert.deepStrictEqual(menu[0].request, { kind: 'starter' });
    assert.deepStrictEqual(menu.find((e) => e.id === 'agency-year').request, { kind: 'agency', interval: 'year' });
    assert.deepStrictEqual(menu.find((e) => e.id === 'payg-10').request, { kind: 'payg', packSize: 10 });
  });

  it('drops Starter and PAYG when the theme cannot be unlocked', () => {
    const menu = purchase.buildMenu(options({ unlockable: false }), { jobId: 'x' });
    assert.ok(!menu.some((e) => e.id === 'starter' || e.id.startsWith('payg')));
  });

  it('upgrade without a theme has no Starter', () => {
    const menu = purchase.buildMenu({ ...options(), job: null }, { jobId: null });
    assert.ok(!menu.some((e) => e.id === 'starter'));
    assert.ok(menu.some((e) => e.id === 'payg-5'));
  });

  it('existing subscribers get the billing portal for plan changes', () => {
    const menu = purchase.buildMenu(options({ subscriber: true }), { jobId: 'x' });
    const pro = menu.find((e) => e.id === 'pro-month');
    assert.strictEqual(pro.portal, true);
    assert.match(purchase.confirmQuestion(pro), /billing portal/);
  });
});

describe('pickFromFlags', () => {
  const menu = purchase.buildMenu(options(), { jobId: 'x' });
  it('maps flags to one option', () => {
    assert.strictEqual(purchase.pickFromFlags(menu, { starter: true }).entry.id, 'starter');
    assert.strictEqual(purchase.pickFromFlags(menu, { pro: true }).entry.id, 'pro-month');
    assert.strictEqual(purchase.pickFromFlags(menu, { pro: true, yearly: true }).entry.id, 'pro-year');
    assert.strictEqual(purchase.pickFromFlags(menu, { agency: true, yearly: true }).entry.id, 'agency-year');
    assert.strictEqual(purchase.pickFromFlags(menu, { payg: '5' }).entry.id, 'payg-5');
    assert.strictEqual(purchase.pickFromFlags(menu, {}).entry, null);
  });
  it('rejects conflicting or unavailable choices', () => {
    assert.match(purchase.pickFromFlags(menu, { starter: true, pro: true }).error, /only one/);
    assert.match(purchase.pickFromFlags(menu, { payg: '7' }).error, /1, 5, 10 or 30/);
    assert.match(purchase.pickFromFlags(menu, { starter: true, yearly: true }).error, /--yearly/);
    const locked = purchase.buildMenu(options({ unlockable: false }), { jobId: 'x' });
    assert.match(purchase.pickFromFlags(locked, { starter: true }).error, /not available/);
  });
});

describe('confirmQuestion', () => {
  it('names the amount and how it is billed', () => {
    const menu = purchase.buildMenu(options(), { jobId: 'x' });
    assert.strictEqual(purchase.confirmQuestion(menu.find((e) => e.id === 'pro-month')), 'Open Stripe to pay $49.00/month?');
    assert.strictEqual(purchase.confirmQuestion(menu.find((e) => e.id === 'starter')), 'Open Stripe to pay $19.00?');
    assert.strictEqual(purchase.confirmQuestion(menu.find((e) => e.id === 'payg-5')), 'Open Stripe to pay $99.00?');
  });
});

describe('quotaFingerprint', () => {
  it('changes when the plan or credits change, not on usage noise', () => {
    const before = purchase.quotaFingerprint({ effectivePlan: 'free', payg_credits: 0, conversion_credits: 0, max: 1, current: 0 });
    assert.strictEqual(before, purchase.quotaFingerprint({ effectivePlan: 'free', payg_credits: 0, conversion_credits: 0, max: 1, current: 1 }));
    assert.notStrictEqual(before, purchase.quotaFingerprint({ effectivePlan: 'pro', payg_credits: 0, conversion_credits: 0, max: 20, current: 0 }));
    assert.notStrictEqual(before, purchase.quotaFingerprint({ effectivePlan: 'free', payg_credits: 5, conversion_credits: 0, max: 1, current: 0 }));
  });
});
