'use strict';

/**
 * Browser links for the terminal: a guest activation (one Turnstile check,
 * a few free previews) or a sign-in that mints an API key.
 *
 * The terminal shows a link and a short code; the secret (guest token or API
 * key) arrives on the poll that wins and goes straight to the 0600 config
 * file. Neither the device code nor the secret is ever printed.
 */

const api = require('./api');
const config = require('./config');
const { ApiError } = api;

const DEFAULT_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
const SLOW_DOWN_STEP_S = 5;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function linkExpired() {
  return new ApiError('The link expired before it was approved. Run the command again.', { code: 'link_expired' });
}

function isTransient(e) {
  if (!(e instanceof ApiError)) return true;
  return e.code === 'network_error' || e.code === 'rate_limited' || e.status >= 500;
}

/** Print the link and code; open the browser only for a person at a real terminal. */
function presentLink(link, { log, isTTY, env = process.env, open, heading } = {}) {
  if (heading) log(heading);
  log(`  Open: ${link.verification_url}`);
  log(`  Code: ${link.user_code}`);
  if (isTTY && !env.CI && typeof open === 'function') {
    open(link.verification_url);
    log('  Opening your browser ...');
  }
}

/** Poll at the server's interval until the link is approved, then return the secret body. */
async function waitForApproval(link, { poll = api.pollDeviceToken, sleep = realSleep, now = Date.now } = {}) {
  const deadline = now() + Math.max(1, Number(link.expires_in) || 600) * 1000;
  let intervalS = Math.min(MAX_INTERVAL_S, Math.max(1, Number(link.interval) || DEFAULT_INTERVAL_S));

  while (now() < deadline) {
    await sleep(intervalS * 1000);
    if (now() >= deadline) break;
    let reply;
    try {
      reply = await poll(link.device_code);
    } catch (e) {
      if (isTransient(e)) continue;
      throw e;
    }
    if (reply.status === 'ok') return reply.body;
    if (reply.status === 'slow_down') {
      const next = Number(reply.interval) || intervalS + SLOW_DOWN_STEP_S;
      intervalS = Math.min(MAX_INTERVAL_S, Math.max(intervalS, next));
      continue;
    }
    if (reply.status === 'authorization_pending') continue;
    throw linkExpired();
  }
  throw linkExpired();
}

/**
 * Save the secret from a winning poll to the config file and return only
 * what is safe to show (no token, no key).
 */
function storeApproval(body, expectedKind) {
  const kind = body && body.kind;
  if (kind === 'guest' && (!expectedKind || expectedKind === 'guest') && typeof body.guest_token === 'string') {
    config.saveGuestSession({
      token: body.guest_token,
      convertUntil: body.convert_until,
      claimUntil: body.claim_until,
      remaining: Number.isInteger(body.budget) ? body.budget : undefined,
    });
    return { kind, budget: body.budget, convertUntil: body.convert_until, claimUntil: body.claim_until };
  }
  if (kind === 'login' && (!expectedKind || expectedKind === 'login') && typeof body.api_key === 'string') {
    config.writeFileConfig({ apiKey: body.api_key, email: typeof body.email === 'string' ? body.email : undefined });
    return { kind, email: body.email || null, previewScoped: body.preview_scoped === true };
  }
  throw new ApiError('The server did not return what was asked for.', { code: 'server_error' });
}

/** Guest activation: link, Turnstile in the browser, then save the guest session. */
async function activateGuest(ctx) {
  const link = await api.createDeviceLink('guest');
  presentLink(link, { ...ctx, heading: 'Confirm you are human to start your free guest previews (no account needed):' });
  return storeApproval(await waitForApproval(link, ctx), 'guest');
}

/** Browser sign-in: link, sign in and type the code, then save the new API key. */
async function loginWithBrowser(ctx) {
  const link = await api.createDeviceLink('login');
  presentLink(link, { ...ctx, heading: 'Sign in to WPConvert in your browser, then enter this code:' });
  return storeApproval(await waitForApproval(link, ctx), 'login');
}

module.exports = {
  isTransient,
  presentLink,
  waitForApproval,
  storeApproval,
  activateGuest,
  loginWithBrowser,
};
