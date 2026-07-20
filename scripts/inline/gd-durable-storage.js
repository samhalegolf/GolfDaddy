/* Durable storage for the keys that cannot be re-fetched.
 *
 * Everything in this app lives in localStorage - 278 call sites, all
 * synchronous. A WebView can evict localStorage under storage pressure, which
 * signs the user out and loses the round they are in the middle of playing. On
 * the 14th hole that is the worst failure this app has.
 *
 * @capacitor/preferences is durable native storage (SharedPreferences on
 * Android, UserDefaults on iOS) and is NOT evicted with web storage. But its API
 * is async and localStorage is sync, so it cannot be swapped in behind 278
 * synchronous readers.
 *
 * So this mirrors rather than replaces:
 *
 *   write  - localStorage stays the source of truth; critical keys are copied
 *            to Preferences fire-and-forget, so nothing waits on it
 *   boot   - if a critical key is missing from localStorage but present in
 *            Preferences, eviction has happened; restore it and reload once
 *
 * The reload is unavoidable: app scripts read localStorage synchronously as they
 * load, and the restore cannot complete before that. It only happens after real
 * eviction, which is rare, and is guarded against looping.
 *
 * Only irreplaceable keys are mirrored. The course library is deliberately
 * excluded - it is large and re-pulls from the server per course, so mirroring
 * it would cost storage to protect data that is already safe.
 */
(function () {
  "use strict";

  var DURABLE_KEYS = [
    "clarity:supabase-auth-session:v1", /* signed-in session - loss means logout */
    "gd_accounts_v1",                   /* accounts - loss means logout */
    "gd_player_profiles_v27",           /* profiles, bag, handicap - user-entered */
    "gd_gps_resume_round_v1"            /* the round being played right now */
  ];
  var RELOAD_GUARD = "gd_durable_restore_reloaded_v1";
  var PREFIX = "durable:";

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  function isNative() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  function prefs() {
    var cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.Preferences ? cap.Plugins.Preferences : null;
  }

  var state = { restored: [], mirrored: 0, active: false };
  /* Kept so restore() can write without going back through the patched setter,
     which would immediately mirror back the value it just read. */
  var originalSetItem = null;

  function mirror(key, value) {
    var api = prefs();
    if (!api || typeof api.set !== "function") return;
    safe(function () {
      /* Fire and forget: a mirror failure must never delay or break a write that
         has already succeeded in localStorage. */
      api.set({ key: PREFIX + key, value: String(value) }).then(function () {
        state.mirrored += 1;
      }, function () {});
    });
  }

  function unmirror(key) {
    var api = prefs();
    if (!api || typeof api.remove !== "function") return;
    safe(function () { api.remove({ key: PREFIX + key }).then(function () {}, function () {}); });
  }

  /* Patch localStorage so existing call sites keep working untouched. Wrapped so
     a failure here can never break a write - the original is always called. */
  function installMirror() {
    var storage = window.localStorage;
    if (!storage || storage.__gdDurableMirror) return;

    var originalSet = storage.setItem.bind(storage);
    var originalRemove = storage.removeItem.bind(storage);
    originalSetItem = originalSet;
    var durable = {};
    DURABLE_KEYS.forEach(function (key) { durable[key] = true; });

    storage.setItem = function (key, value) {
      var result = originalSet(key, value);
      if (durable[key]) safe(function () { mirror(key, value); });
      return result;
    };
    storage.removeItem = function (key) {
      var result = originalRemove(key);
      if (durable[key]) safe(function () { unmirror(key); });
      return result;
    };

    storage.__gdDurableMirror = true;
    state.active = true;
  }

  /* Copy anything already in localStorage up to Preferences, so the first run
     after this ships is protected rather than waiting for the next write. */
  function seed() {
    DURABLE_KEYS.forEach(function (key) {
      var value = safe(function () { return window.localStorage.getItem(key); }, null);
      if (value !== null && value !== undefined) mirror(key, value);
    });
  }

  async function restore() {
    var api = prefs();
    if (!api || typeof api.get !== "function") return [];
    var restored = [];
    for (var i = 0; i < DURABLE_KEYS.length; i += 1) {
      var key = DURABLE_KEYS[i];
      var present = safe(function () { return window.localStorage.getItem(key); }, null);
      if (present !== null && present !== undefined) continue;
      try {
        var result = await api.get({ key: PREFIX + key });
        var value = result && result.value;
        if (value === null || value === undefined || value === "") continue;
        /* Write through the original setter: the patched one would immediately
           mirror back the value we just read out of Preferences. */
        var write = originalSetItem || window.localStorage.setItem.bind(window.localStorage);
        safe(function () { write(key, value); });
        restored.push(key);
      } catch (_e) {
        /* A failed restore leaves the user signed out, which is the status quo
           without this module. Never fatal. */
      }
    }
    return restored;
  }

  async function boot() {
    if (!isNative()) return;
    var restored = await restore();
    state.restored = restored;

    if (!restored.length) {
      seed();
      return;
    }

    /* Something was evicted and has been put back. App scripts have already read
       an empty localStorage synchronously, so the only way to make them see the
       restored state is to load again. Guarded so a persistent failure cannot
       produce a reload loop. */
    var alreadyReloaded = safe(function () { return sessionStorage.getItem(RELOAD_GUARD) === "1"; }, false);
    if (alreadyReloaded) return;
    safe(function () { sessionStorage.setItem(RELOAD_GUARD, "1"); });
    safe(function () {
      if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
        window.ClarityErrorReporter.report(
          "Durable storage restored evicted keys",
          restored.join(",")
        );
      }
    });
    safe(function () { location.reload(); });
  }

  window.GDDurableStorage = {
    keys: function () { return DURABLE_KEYS.slice(); },
    state: function () { return { restored: state.restored.slice(), mirrored: state.mirrored, active: state.active }; },
    /* Exposed for tests and for a manual integrity check on a device. */
    seed: seed,
    restore: restore
  };

  /* The mirror installs immediately, not on DOMContentLoaded: writes that happen
     while the app boots are exactly the ones worth protecting, and waiting would
     miss them. The async restore still runs after load. */
  if (isNative()) safe(installMirror);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { safe(function () { boot(); }); }, { once: true });
  } else {
    safe(function () { boot(); });
  }
})();
