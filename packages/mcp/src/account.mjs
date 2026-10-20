/**
 * Connecting without a key, and buying, for the MCP server.
 *
 * wpconvert_connect starts a browser link (guest check or sign-in) and keeps
 * the device code in memory; wpconvert_connect_status polls briefly and saves
 * the secret to ~/.wpconvert/config.json (0600) through the CLI's own code.
 * wpconvert_plans shows every option; wpconvert_checkout sends only the
 * option the user picked. No tool result ever contains a token, key or
 * device code, and nothing here opens a browser.
 */

import { createRequire } from 'module';
import { ok, fail, redactSecrets } from './result.mjs';

const require = createRequire(import.meta.url);
const api = require('wpconvert/src/api');
const config = require('wpconvert/src/config');
const { storeApproval, isTransient } = require('wpconvert/src/device');
const { PACK_SIZES, formatPlans, buildMenu } = require('wpconvert/src/purchase');

const CONNECT_KINDS = ['guest', 'login'];
const CHECKOUT_KINDS = ['starter', 'pro', 'agency', 'payg'];
const INTERVALS = ['month', 'year'];
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INTERVAL_S = 60;
const SLOW_DOWN_STEP_S = 5;

let connectWaitMs = 20000;
let pending = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONNECT_NEXT = {
  guest: { tool: 'wpconvert_connect', arguments: { kind: 'guest' }, reason: 'Start a free guest preview (no account needed).' },
  login: { tool: 'wpconvert_connect', arguments: { kind: 'login' }, reason: 'Buying needs a WPConvert account. Sign in or create one in the browser.' },
};

export const ACCOUNT_TOOLS = [
  {
    name: 'wpconvert_connect',
    description:
      'Connect WPConvert without an API key. kind "guest": the user confirms they are human once in the browser and gets a few free previews (no account; downloads need a purchase). kind "login": the user signs in or creates an account in the browser and types the code shown, and a new API key is saved locally. Returns a link and a short code. Show both to the user and ask them to open the link; never open it yourself. Then call wpconvert_connect_status.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: CONNECT_KINDS, description: '"guest" for free previews, "login" to use a WPConvert account (needed to buy).' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'wpconvert_connect_status',
    description:
      'Check whether the user finished the wpconvert_connect link (waits up to about 20 seconds). Call it again while it says "waiting". Also reports how WPConvert is connected now: guest (with previews left) or account (with a masked email). Never returns the token or key.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wpconvert_plans',
    description:
      'List what the user can buy: Starter (unlock one theme), Pro, Agency (monthly or yearly) and pay-as-you-go credit packs, with what each includes and today\'s price. Pass jobId to see options for unlocking that conversion. Show all options to the user and let them choose; do not pick for them. Then call wpconvert_checkout with the checkout_arguments of their choice.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Conversion to unlock (optional).' } },
    },
  },
  {
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
  },
];

function envKeyOverrides() {
  const env = process.env.WPCONVERT_API_KEY && process.env.WPCONVERT_API_KEY.trim();
  const saved = config.readFileConfig().apiKey;
  return Boolean(env && saved && env !== saved);
}

const ENV_OVERRIDE_NOTE =
  'Note: WPCONVERT_API_KEY is set in the MCP server environment and is used instead of the key saved by sign-in. ' +
  'To use the account just signed in, remove WPCONVERT_API_KEY from the MCP server config and restart the server.';

/** How WPConvert is connected right now (no secrets). */
export function connectionSummary() {
  if (api.hasApiKey()) {
    const file = config.readFileConfig();
    const fromEnv = Boolean(process.env.WPCONVERT_API_KEY && process.env.WPCONVERT_API_KEY.trim());
    return {
      mode: 'api_key',
      key_source: fromEnv ? 'environment' : 'sign_in',
      email: !fromEnv && typeof file.email === 'string' ? file.email : null,
      env_key_override: envKeyOverrides(),
    };
  }
  const guest = config.getGuestSession();
  if (guest) {
    return {
      mode: 'guest',
      can_convert: config.guestCanConvert(guest),
      remaining_previews: guest.remaining,
      convert_until: guest.convertUntil,
      claim_until: guest.claimUntil,
    };
  }
  return { mode: 'none' };
}

function connectedResult(summary, previewScoped) {
  if (summary.mode === 'guest') {
    const left = summary.remaining_previews != null ? `${summary.remaining_previews} free preview(s) left` : 'free previews available';
    return ok(
      `Connected as a guest: ${left}${summary.convert_until ? ` until ${summary.convert_until}` : ''}. Guest conversions can be previewed but not downloaded until bought.`,
      { ok: true, state: 'connected', ...summary, recommended_next: { tool: 'wpconvert_convert_folder', reason: 'Convert a folder as a guest preview.' } }
    );
  }
  const lines = [`Connected to WPConvert${summary.email ? ` as ${summary.email}` : ''}.`];
  if (previewScoped) lines.push('This account has no paid plan yet, so conversions are previews until something is bought (see wpconvert_plans).');
  if (summary.env_key_override) lines.push(ENV_OVERRIDE_NOTE);
  return ok(lines.join('\n'), {
    ok: true,
    state: 'connected',
    ...summary,
    ...(previewScoped != null ? { preview_scoped: previewScoped } : {}),
    recommended_next: { tool: 'wpconvert_quota', reason: 'Review what the account can convert and download.' },
  });
}

function linkText(p) {
  const head = p.kind === 'guest'
    ? 'Ask the user to open this link and complete the quick human check (no account needed). The page shows the same code:'
    : 'Ask the user to open this link, sign in or create a WPConvert account, then type this code:';
  return `${head}\n  ${p.url}\n  Code: ${p.userCode}\nDo not open the link yourself. When the user says they are done, call wpconvert_connect_status.`;
}

async function connect(args) {
  const kind = args && args.kind;
  if (!CONNECT_KINDS.includes(kind)) return fail('kind must be "guest" or "login".');
  if (kind === 'guest' && api.hasApiKey()) {
    return ok('An API key is already configured, so guest previews are not needed. Call wpconvert_convert_folder.', {
      ok: true,
      state: 'connected',
      ...connectionSummary(),
      recommended_next: { tool: 'wpconvert_convert_folder', reason: 'Already connected with an API key.' },
    });
  }
  const link = await api.createDeviceLink(kind);
  pending = {
    kind,
    deviceCode: link.device_code,
    userCode: link.user_code,
    url: link.verification_url,
    intervalS: Math.min(MAX_INTERVAL_S, Math.max(1, Number(link.interval) || 5)),
    expiresAt: Date.now() + Math.max(1, Number(link.expires_in) || 600) * 1000,
    lastPollAt: 0,
  };
  return ok(linkText(pending), {
    ok: true,
    kind,
    verification_url: pending.url,
    user_code: pending.userCode,
    expires_in: link.expires_in,
    recommended_next: { tool: 'wpconvert_connect_status', reason: 'Call after the user opens the link and finishes in the browser.' },
  });
}

function linkEnded(kind, message) {
  pending = null;
  return fail(message, {
    ok: false,
    state: 'expired',
    error: { code: 'link_expired', message },
    recommended_next: CONNECT_NEXT[kind],
  });
}

async function connectStatus() {
  if (!pending) {
    const summary = connectionSummary();
    if (summary.mode === 'none') {
      return ok('Not connected. Call wpconvert_connect with kind "guest" (free previews) or "login" (WPConvert account).', {
        ok: true,
        state: 'not_connected',
        mode: 'none',
        recommended_next: CONNECT_NEXT.guest,
      });
    }
    return connectedResult(summary);
  }

  const p = pending;
  const stopAt = Date.now() + connectWaitMs;
  while (Date.now() < p.expiresAt) {
    const due = p.lastPollAt + p.intervalS * 1000;
    if (due > stopAt) break;
    if (due > Date.now()) await sleep(due - Date.now());
    p.lastPollAt = Date.now();
    let reply;
    try {
      reply = await api.pollDeviceToken(p.deviceCode);
    } catch (e) {
      if (isTransient(e)) continue;
      pending = null;
      throw e;
    }
    if (reply.status === 'ok') {
      const shown = storeApproval(reply.body, p.kind);
      pending = null;
      return connectedResult(connectionSummary(), shown.kind === 'login' ? shown.previewScoped : undefined);
    }
    if (reply.status === 'slow_down') {
      const next = Number(reply.interval) || p.intervalS + SLOW_DOWN_STEP_S;
      p.intervalS = Math.min(MAX_INTERVAL_S, Math.max(p.intervalS, next));
      continue;
    }
    if (reply.status === 'authorization_pending') continue;
    return linkEnded(p.kind, 'The link expired or was refused. Call wpconvert_connect again for a new link.');
  }
  if (Date.now() >= p.expiresAt) return linkEnded(p.kind, 'The link expired before it was used. Call wpconvert_connect again for a new link.');
  return ok(`Still waiting for the user to finish in the browser.\n  ${p.url}\n  Code: ${p.userCode}\nCall wpconvert_connect_status again once they are done.`, {
    ok: true,
    state: 'waiting',
    kind: p.kind,
    verification_url: p.url,
    user_code: p.userCode,
    recommended_next: { tool: 'wpconvert_connect_status', reason: 'The user has not finished yet.' },
  });
}

function badJobId(jobId) {
  return jobId != null && (typeof jobId !== 'string' || !UUID_RX.test(jobId));
}

async function plans(args) {
  const jobId = args && args.jobId ? args.jobId : undefined;
  if (badJobId(jobId)) return fail('jobId must be a conversion id from wpconvert_convert_folder.');

  if (!api.hasApiKey()) {
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
      recommended_next: CONNECT_NEXT.login,
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

async function checkout(args) {
  const { request, error } = checkoutRequest(args);
  if (error) {
    return fail(`${error} Call wpconvert_plans and pass the chosen option's checkout_arguments.`, {
      ok: false,
      error: { code: 'invalid_request', message: error },
      recommended_next: { tool: 'wpconvert_plans', reason: 'Get the exact checkout arguments for each option.' },
    });
  }
  if (!api.hasApiKey()) {
    return fail('Buying needs a WPConvert account. Call wpconvert_connect with kind "login" so the user can sign in, then call wpconvert_checkout again.', {
      ok: false,
      error: { code: 'missing_credentials', message: 'Sign in to buy.' },
      recommended_next: CONNECT_NEXT.login,
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

export async function handleAccountCall(name, args) {
  switch (name) {
    case 'wpconvert_connect': return connect(args);
    case 'wpconvert_connect_status': return connectStatus();
    case 'wpconvert_plans': return plans(args);
    case 'wpconvert_checkout': return checkout(args);
    default: return null;
  }
}

export const _internals = {
  setConnectWaitMs(ms) { connectWaitMs = ms; },
  resetConnect() { pending = null; },
};
