/* Web landing redirect.
 *
 * The HTML app is not a public surface, and /studio is the only way to sign in
 * on the web. netlify/edge-functions/web-app-gate.js keeps every browser
 * without the access cookie on welcome.html, but that cookie is the Studio key:
 * once it is set, the same browser reaches the app at / whether or not anyone
 * is signed in - and signed out, the app opens in guest mode. Guest mode exists
 * for the store apps (App Store guideline 5.1.1), not for the web. This script
 * is the second half of the gate: a browser with no account goes to the landing
 * page, before the shell paints, decided synchronously from localStorage so
 * there is no flash of app-then-landing.
 *
 * App surface only (data-gd-surface="app" in index.html): the Studio is built
 * from the same index.html and signs in through its own door, so it must never
 * carry this - that is why an earlier copy of this file was deleted.
 *
 * There is no query-string way past it. The auth-email and Stripe links that
 * used to be let through are claimed by the native apps on a phone, and the
 * edge gate already lands them on welcome.html in any other browser; this
 * only makes the owner's browser behave the same way. The redirect stays out
 * of the way only when:
 *  - running inside the native apps (their auth screen is their landing);
 *  - served from localhost / 127.0.0.1 / file:, the same hosts the edge gate
 *    leaves open, so local development and the browser tests see the app;
 *  - an account is signed in. Returning players go straight to the app.
 */
(function () {
  "use strict";
  try {
    if (window.GDNative && window.GDNative.isNative) return;
    if (window.location.protocol === "file:") return;
    var host = String(window.location.hostname || "");
    if (host === "localhost" || host === "127.0.0.1") return;

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
      window.location.replace("/welcome.html");
    }
  } catch (_e) {
    /* The landing is never worth breaking the app boot for. */
  }
})();
