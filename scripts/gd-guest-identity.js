/* The anonymous installation identity, and the one place it is minted or read.
 *
 * Preparing a course costs the server an Overpass query and a geometry resolve, so a mapping
 * run has to be attributable to somebody or it cannot be rate limited. Until now "somebody"
 * meant a Supabase account, and functions/course-package.mjs simply declined to start a run
 * for anyone signed out - so the most common first run of this app (install, search a course,
 * press Play) could only ever end in manual green-tapping, because nothing was ever queued.
 *
 * This is the missing half: a string this installation mints for itself once and keeps.
 *
 *   guest:9f7381c2e4a60b5d...
 *
 * What it is NOT, and must not become:
 *   - it is not an account. Nothing is created server-side for it, and it never unlocks the
 *     operator actions on /api/course-mapper-jobs (nudge, remap) - those still ask for a
 *     verified admin session.
 *   - it is not personal data. 16 random bytes, no device, network or account details in it,
 *     and it is never sent anywhere but this app's own mapping endpoints.
 *   - it is not a security boundary. Clearing storage mints a new one, which is exactly the
 *     honest cost of the anonymous budget it guards: a speed bump against a loop, not a lock.
 *
 * Durability matters more than it looks. A WebView that evicts localStorage would otherwise
 * hand the same installation a fresh budget on every eviction, so the key is listed in
 * scripts/inline/gd-durable-storage.js's DURABLE_KEYS and rides its native mirror - which is
 * also why that script must load before this one.
 */
(function () {
  "use strict";
  if (window.GDGuestIdentity) return;

  /* Same key space as the rest of the app's newer storage, and the exact string
     gd-durable-storage.js mirrors. Changing it here without changing it there silently
     un-mirrors the id. */
  var KEY = "clarity:guest-install-id:v1";
  /* Must satisfy GUEST_ID_RE in functions/course-mapper-jobs.mjs, which is deliberately
     stricter than "any string": a value that fails there is treated as no actor at all, and
     the course quietly stops being mapped. Lowercase hex clears it by construction. */
  var VALID = /^[a-f0-9]{16,64}$/;

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  function mint() {
    var bytes = safe(function () {
      var c = window.crypto || window.msCrypto;
      if (!c || typeof c.getRandomValues !== "function") return null;
      return c.getRandomValues(new Uint8Array(16));
    }, null);
    var hex = "";
    if (bytes) {
      for (var i = 0; i < bytes.length; i += 1) hex += ("0" + bytes[i].toString(16)).slice(-2);
      return hex;
    }
    /* Only reached where crypto is missing entirely. Collisions here cost two installations a
       shared mapping budget, which is a worse rate limit and not a leak of anything. */
    while (hex.length < 32) hex += Math.floor(Math.random() * 16).toString(16);
    return hex;
  }

  /* Minted at most once per installation. A stored value that does not match VALID is treated
     as absent and replaced rather than sent - a malformed id would be silently ignored by the
     server, which reads to the app as "my courses stopped being mapped". */
  function getOrCreateGuestId() {
    var stored = String(safe(function () { return window.localStorage.getItem(KEY); }, "") || "").trim().toLowerCase();
    if (VALID.test(stored)) return stored;
    var next = mint();
    /* Through the ordinary setter on purpose: that is what gd-durable-storage.js patched, and
       it is what mirrors the write to native Preferences. */
    safe(function () { window.localStorage.setItem(KEY, next); });
    return next;
  }

  /* The signed-in half is best-effort and advisory. The SERVER decides who a caller is, from
     the bearer token, and prefers a verified user over anything sent alongside - so a stale
     or missing session here can never charge a real player's run to a guest budget, or the
     other way round. This exists so client-side diagnostics can say which one is in play. */
  function currentUserId() {
    return safe(function () {
      var auth = window.ClaritySupabaseAuth;
      var session = auth && typeof auth.session === "function" ? auth.session() : null;
      var user = session && session.user;
      return user && user.id ? String(user.id) : "";
    }, "") || "";
  }

  function getActorKey() {
    var uid = currentUserId();
    return uid ? "user:" + uid : "guest:" + getOrCreateGuestId();
  }

  window.GDGuestIdentity = {
    storageKey: KEY,
    getOrCreateGuestId: getOrCreateGuestId,
    getActorKey: getActorKey
  };
})();
