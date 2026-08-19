/* Web landing redirect.
 *
 * A signed-out visitor to caddy.claritygolf.app used to land directly on the
 * app shell with the sign-in panel forced open - functional, but it meant the
 * "marketing URL" given to App Store and Play review was a bare login wall
 * with no statement of what the product is and no visible legal links.
 * welcome.html is the answer to that: the landing page, with sign-in buttons
 * that come back here carrying ?login=1.
 *
 * This must run early (immediately after gd-native-bootstrap) and decide
 * synchronously from localStorage, because a redirect after the shell has
 * begun to paint is a visible flash of app-then-landing.
 *
 * The redirect deliberately never fires when:
 *  - running inside the native apps (their auth screen is their landing);
 *  - any special route is in flight - password reset / account setup links
 *    from the auth emails, Stripe checkout returns, referral invitations,
 *    the demo route, or an explicit ?login=1 from the landing itself. Those
 *    URLs are printed in emails and configured in Stripe; the landing must
 *    not eat them;
 *  - anyone is signed in. Returning players go straight to the app.
 *
 * When in doubt it stays on the app shell, whose auth gate is the same
 * sign-in the user would reach anyway - the landing is an improvement for
 * fresh visitors, never a wall for existing ones.
 */
(function () {
  "use strict";
  try {
    if (window.GDNative && window.GDNative.isNative) return;
    if (window.location.protocol === "file:") return;

    var search = new URLSearchParams(window.location.search || "");
    var hash = String(window.location.hash || "");
    var SKIP_PARAMS = [
      "login", "claritySetPassword", "clarityResetPassword",
      "clarityAccountSetup", "access_token", "type", "payment",
      "session_id", "ref", "referral", "demo", "membership"
    ];
    for (var i = 0; i < SKIP_PARAMS.length; i++) {
      if (search.has(SKIP_PARAMS[i])) return;
    }
    if (/access_token=|type=recovery/.test(hash)) return;

    /* Signed-in check, synchronous by design. gd_accounts_v1's activeId is
       what gdCurrentAccount() resolves; the Supabase session key covers a
       login that has not yet been mirrored into the account store; and the
       explicit signed-out flag beats both, because it is set by logout while
       the account store is retained. */
    var signedOut = false;
    var signedIn = false;
    try {
      if (localStorage.getItem("gd_account_signed_out_v1")) signedOut = true;
      var store = JSON.parse(localStorage.getItem("gd_accounts_v1") || "null");
      if (store && store.activeId) signedIn = true;
      if (localStorage.getItem("clarity:supabase-auth-session:v1")) signedIn = true;
    } catch (_e) { /* unreadable storage answers "not signed in" */ }

    if (signedOut || !signedIn) {
      window.location.replace("welcome.html");
    }
  } catch (_e) {
    /* The landing is never worth breaking the app boot for. */
  }
})();
