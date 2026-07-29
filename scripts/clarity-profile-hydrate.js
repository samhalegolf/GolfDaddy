/* Restore the player list from the server when the device has lost it.
 *
 * The player list lives in localStorage (gd_player_profiles_v27) and sync only
 * ever pushed it upwards. Lose that key - webview storage eviction, a reinstall,
 * a new device, signing in somewhere else - and the list rendered 0, then
 * bootProfileShell() minted a replacement profile with a fresh random id and
 * pushed it up. One account collected seven profiles all named "Sam Hale" that
 * way. This module is the missing downward half.
 *
 * IT ONLY EVER FILLS AN EMPTY LIST.
 *
 * This is the whole safety design, so it is worth being explicit. If the local
 * list already has profiles, this module does nothing at all - it does not
 * merge, reconcile or update.
 *
 * The reason is that there is no server-side delete for profiles. Deleting a
 * player is a local-only operation, so a "proper" two-way sync would fetch the
 * deleted row straight back and resurrect it, every launch, with no way for the
 * user to get rid of it. A merge would also happily overwrite local edits made
 * while offline with staler server copies.
 *
 * Restricting this to the empty case fixes the reported bug - the list going to
 * zero - and cannot cause either of those. It is a recovery path, not a sync.
 * dev/profile-hydrate.test.js pins that behaviour.
 *
 * Profiles are rebuilt from profile_json, which is the original client-side
 * object clarity-cloud-sync uploaded, so the restore round-trips fields the flat
 * columns never held. The columns are the fallback for older rows.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/account-profiles";
  var PROFILE_KEY = "gd_player_profiles_v27";
  var ran = false;

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }

  function readStore() {
    return safe(function () { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}"); }) || {};
  }

  function localProfileCount() {
    var raw = readStore();
    return Array.isArray(raw.profiles) ? raw.profiles.length : 0;
  }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  /* Server row -> the shape gd-app-core stores. profile_json is the original
     object, so prefer it wholesale and only fill gaps from the columns. */
  function toLocalProfile(row, accountId) {
    if (!row) return null;
    var base = {};
    if (row.profile_json && typeof row.profile_json === "object" && !Array.isArray(row.profile_json)) {
      base = JSON.parse(JSON.stringify(row.profile_json));
    }
    base.id = row.profile_id || base.id;
    if (!base.id) return null;
    base.accountId = base.accountId || accountId || "";
    base.name = base.name || row.name || "Player 1";
    base.handedness = base.handedness || row.handedness || "right";
    if (base.handicap == null || base.handicap === "") base.handicap = row.handicap || "";
    base.permission = base.permission || row.permission || "player";
    if (!Array.isArray(base.bag) && Array.isArray(row.bag_json)) base.bag = row.bag_json;
    return base;
  }

  async function hydrate(reason) {
    if (ran) return false;
    /* The guard that makes this safe. Checked here rather than only before the
       request, because the list can be populated while the request is in
       flight - by boot creating a profile, or by another tab. */
    if (localProfileCount() > 0) return false;

    var token = await accessToken();
    if (!token) return false;

    var body = null;
    try {
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token })
      });
      body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !body.ok) return false;
    } catch (_error) {
      return false;
    }

    var rows = Array.isArray(body.profiles) ? body.profiles : [];
    if (!rows.length) return false;

    /* Re-check: the request took time, and restoring over a list that filled in
       meanwhile would clobber it. */
    if (localProfileCount() > 0) return false;

    var restored = rows
      .map(function (row) { return toLocalProfile(row, body.accountId); })
      .filter(Boolean);
    if (!restored.length) return false;

    var store = readStore();
    store.profiles = restored;
    var wantedActive = body.activeProfileId;
    var hasWanted = restored.some(function (p) { return p.id === wantedActive; });
    store.activeId = hasWanted ? wantedActive : restored[0].id;

    var written = safe(function () {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(store));
      return true;
    });
    if (!written) return false;

    ran = true;

    /* Pull the new list into memory and redraw. Only reached when the list was
       empty, which is the state where the user is staring at a blank player
       list - so re-showing home is a fix, not an interruption. */
    safe(function () { if (typeof window.loadPlayerProfiles === "function") window.loadPlayerProfiles(); });
    safe(function () { if (typeof window.showShellHome === "function") window.showShellHome(); });
    safe(function () {
      window.dispatchEvent(new CustomEvent("clarity:profiles-restored", {
        detail: { count: restored.length, reason: reason || "" }
      }));
    });
    safe(function () {
      if (window.toast) window.toast("Restored " + restored.length + " player" + (restored.length === 1 ? "" : "s"));
    });
    return true;
  }

  function schedule(reason) {
    /* Let boot and the auth session settle first; freshAccessToken is useless
       before the session is loaded. */
    setTimeout(function () { hydrate(reason).catch(function () {}); }, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { schedule("boot"); });
  } else {
    schedule("boot");
  }
  window.addEventListener("clarity:session-changed", function () { schedule("session-changed"); });

  window.ClarityProfileHydrate = {
    hydrate: hydrate,
    localProfileCount: localProfileCount,
    toLocalProfile: toLocalProfile
  };
})();
