"use strict";

/**
 * Who is calling a Clarity function.
 *
 * Two kinds of caller reach the endpoints that create accounts, link coaches to
 * players, or issue passes:
 *
 *   1. A signed-in coach or admin in the Caddy app, holding a Supabase Auth
 *      bearer token. Their identity is verified against Supabase and then
 *      resolved to an app_accounts row -- the account they act as is the one
 *      that token belongs to, never one they name in the request body.
 *
 *   2. Clarity Booking's server, holding the shared service secret. Booking has
 *      already authenticated its own coach, so it is trusted to name the actor
 *      it is acting for. The secret is server-to-server only and must never be
 *      shipped to a browser.
 *
 * Anything else is anonymous and gets nothing.
 */

const { authenticatedAccount, encodeFilter, supabaseFetch } = require("./payment-utils");

function env(name) { return process.env[name] || ""; }

function serviceSecret() {
  return env("CLARITY_SERVICE_SECRET");
}

function headerValue(event, name) {
  const headers = (event && event.headers) || {};
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find(function (candidate) {
    return String(candidate).toLowerCase() === lower;
  });
  return key ? String(headers[key] || "") : "";
}

/**
 * Constant-time-ish comparison. Not a defence against a local attacker timing
 * the process, but it removes the trivial early-exit leak of a plain ===.
 */
function secretMatches(candidate) {
  const expected = serviceSecret();
  if (!expected || !candidate) return false;
  if (candidate.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  return diff === 0;
}

function isStaffRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "coach" || role === "admin";
}

async function accountById(accountId) {
  if (!accountId) return null;
  const rows = await supabaseFetch(
    "app_accounts?select=*&account_id=eq." + encodeFilter(accountId) + "&limit=1",
    { method: "GET" }
  ).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Resolves the caller.
 *
 * Returns null when nobody is authenticated. Throws with a `status` when a
 * token was supplied but is invalid -- the caller should surface that rather
 * than silently falling through to anonymous.
 *
 * Shape: { kind: "service" | "user", account, actorAccountId, isAdmin, isStaff }
 */
async function resolveCaller(event, options) {
  options = options || {};

  const presented =
    headerValue(event, "x-clarity-service-secret") ||
    headerValue(event, "x-clarity-service-key");
  if (presented) {
    if (!secretMatches(presented)) {
      const error = new Error("Service credential rejected");
      error.status = 401;
      throw error;
    }
    // Booking names the coach it is acting for. It has already authenticated
    // that coach on its own side; the secret is what makes that claim credible.
    const actorAccountId = String((options.actorAccountId || "")).trim();
    const account = actorAccountId ? await accountById(actorAccountId) : null;
    return {
      kind: "service",
      account,
      actorAccountId: (account && account.account_id) || actorAccountId,
      isAdmin: true,
      isStaff: true
    };
  }

  const account = await authenticatedAccount(event);
  if (!account) return null;
  const role = String(account.role || "").toLowerCase();
  return {
    kind: "user",
    account,
    actorAccountId: account.account_id,
    isAdmin: role === "admin",
    isStaff: isStaffRole(role)
  };
}

module.exports = {
  accountById,
  isStaffRole,
  resolveCaller,
  serviceSecretConfigured: function () { return !!serviceSecret(); }
};
