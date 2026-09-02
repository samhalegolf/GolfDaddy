/* Change the email a managed account signs in with. Server-first, always.
 *
 * WHY THIS ONE IS NOT FIRE-AND-FORGET
 *
 * clarity-coach-unlink.js cuts the link locally and tells the server after the
 * fact, because a coach ending a coaching relationship must not depend on the
 * network. An email change is the opposite shape: the address IS the login, and
 * only the server can say whether it is free, only the server can move Supabase
 * Auth, and only the server can tell the account holder it happened. Writing it
 * locally first would show the coach a change that may never have landed and
 * leave the player signing in with an address the app no longer displays.
 *
 * So: call, wait, and only then let the caller touch local state.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/account-change-email";

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  function normalise(value) { return String(value || "").trim().toLowerCase(); }

  function looksLikeEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

  /* Resolves with the server's answer, or throws with a message that is already
     fit to show a coach - the endpoint writes them for exactly that. */
  async function change(targetAccountId, nextEmail) {
    var accountId = String(targetAccountId || "").trim();
    var email = normalise(nextEmail);
    if (!accountId) throw new Error("No account to change");
    if (!looksLikeEmail(email)) throw new Error("Enter a valid email");

    var token = await accessToken();
    if (!token) throw new Error("Your session has expired. Sign in again.");

    var response;
    var body = null;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ targetAccountId: accountId, email: email })
      });
      body = await response.json().catch(function () { return null; });
    } catch (_networkError) {
      throw new Error("Could not reach the server. Nothing was changed.");
    }

    if (!response.ok || !body || body.ok === false) {
      var error = new Error((body && body.error) || "Could not change the login email");
      error.code = (body && body.code) || "request_failed";
      error.status = response.status;
      safe(function () {
        if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
          window.ClarityErrorReporter.report("Staff email change failed", "accountId=" + accountId + " code=" + error.code);
        }
      });
      throw error;
    }

    return body;
  }

  window.ClarityAccountEmail = { change: change };
})();
