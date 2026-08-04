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

  /* The /app/ surface owns its own key space (see app/README.md) and none of it
     was listed here until 2026-08-04, so the rebuilt play screen had exactly the
     exposure this module was written to close - including the live scorecard,
     which is the same "round being played right now" case as the legacy resume
     key one line above.

     clarity:course-library:v1 is deliberately absent for the same reason the old
     course library is: it is large and re-pulls from the server per course, so
     mirroring it would spend quota protecting data that is already safe.
     clarity:shot-card-boxes:v1 is absent because it is cosmetic box positions. */
  var DURABLE_KEYS = [
    "clarity:supabase-auth-session:v1", /* signed-in session - loss means logout */
    "gd_accounts_v1",                   /* accounts - loss means logout */
    "gd_player_profiles_v27",           /* profiles, bag, handicap - user-entered */
    "gd_gps_resume_round_v1",           /* the round being played right now */
    "clarity:scorecard:v1",             /* the live scorecard - user-entered, unrecoverable */
    "clarity:bag:v1",                   /* /app/ bag: clubs and carries, user-entered */
    "gd_bag_total_firmness_v1",         /* bag firmness preset, read by the bubble engine */
    "clarity:gps-settings:v1",          /* units, aim line, shot-up frame, lock tightness */
    "clarity:nines:v1",                 /* which nines are paired for a multi-nine course */
    /* Course Data's raw shot snapshots. The most irreplaceable thing the app
       holds: a shot is a measurement of a moment that cannot be taken again,
       and the intake writes each one exactly once. The derived analyses beside
       it (gd_conditions_analyses_v1) are deliberately NOT mirrored - they are
       recomputable from these by reprocessShot, so mirroring them would spend
       quota on data that is already safe. */
    "gd_shot_snapshots_v1"
  ];

  /* Restoring these is not enough on its own: app scripts read them
     synchronously as they load, so they have already seen an empty localStorage
     by the time the async restore finishes. Only a reload makes them visible.

     gd_gps_resume_round_v1 is deliberately NOT here. Nothing reads it during
     boot - the Resume Round button and the resume prompt both read it lazily,
     when the player opens Play - so restoring it is immediately effective and a
     reload buys nothing.

     That distinction is the whole point. A reload sends the player to home and
     loses where they were, and on a device where the webview evicts storage
     mid-round that was happening for a key that never needed it. Reloading only
     for keys that genuinely cannot be seen otherwise turns a lot of those
     interruptions into nothing at all.

     The two /app/ additions are here on the same test, applied by reading the
     modules rather than by assuming: bag.js and gps-settings.js both take their
     value at module load (`var clubs = load()`, `var state = load()`), so a
     restore that lands afterwards is invisible until the page runs again. The
     other /app/ keys read lazily - the scorecard when the panel opens, the
     firmness preset when the engine asks, the nines pairing when a hole changes
     - so like the resume key they restore into a running app for free. */
  var RELOAD_REQUIRED_KEYS = [
    "clarity:supabase-auth-session:v1",
    "gd_accounts_v1",
    "gd_player_profiles_v27",
    "clarity:bag:v1",
    "clarity:gps-settings:v1"
  ];
  var RELOAD_GUARD = "gd_durable_restore_reloaded_v1";
  var PREFIX = "durable:";

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  /* Shared quota-safe write, defined here because this module loads before every other app
     script. localStorage throws QuotaExceededError once full, and an unguarded setItem in a boot
     path takes the rest of boot with it - so a full disk presents as unrelated breakage rather
     than as a storage error. Writes may fail; they may not throw. Failures are reported, never
     swallowed, and the quota warning shows once rather than on every subsequent write.

     Note the patched localStorage.setItem below deliberately does NOT swallow quota errors: it
     must stay transparent so callers using this helper still see the failure. */
  var quotaWarned = false;
  function safeLocalSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (error) {
      var quota = error && (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014);
      console.warn("[GolfDaddy] storage write failed for " + key + (quota ? " - localStorage is full" : ""), error);
      safe(function () {
        window.ClarityErrorReporter && window.ClarityErrorReporter.report &&
          window.ClarityErrorReporter.report(error, { source: "gdSafeLocalSet", key: key, quotaExceeded: !!quota });
      });
      if (quota && !quotaWarned) {
        quotaWarned = true;
        safe(function () { window.toast && window.toast("Device storage is full - some settings can't be saved. Clear site data to recover."); });
      }
      return false;
    }
  }
  window.gdSafeLocalSet = safeLocalSet;

  function isNative() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  function prefs() {
    var cap = window.Capacitor;
    return cap && cap.Plugins && cap.Plugins.Preferences ? cap.Plugins.Preferences : null;
  }

  var state = { restored: [], mirrored: 0, active: false, cleaned: 0 };
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

  /* Keys a previous version of this file created by accident. See installMirror. */
  var STRAY_KEYS = ["setItem", "removeItem", "__gdDurableMirror"];

  /* Patch localStorage so existing call sites keep working untouched. Wrapped so
     a failure here can never break a write - the original is always called.

     Every assignment here MUST go through Object.defineProperty. localStorage is
     a WebIDL legacy platform object with a named-property setter, so a plain
     `storage.setItem = fn` stores an ENTRY called "setItem" holding the
     function's source text. An earlier version of this file did exactly that,
     and the engines disagree about what else happens: Chromium also overrides
     the method, so the mirror worked there and the test suite stayed green,
     while iOS WebKit did not override at all. On WebKit that left only the
     boot-time seed() mirroring - every write during a session went unmirrored,
     and the durable copy of the in-progress round was found sitting over two
     hours stale on a device. Restoring that after an eviction hands the player
     back the wrong hole.

     Both engines wrote the three junk keys ("setItem", "removeItem",
     "__gdDurableMirror") into the same quota this module exists to protect,
     which cleanStrayKeys below clears. Testing for those keys is also how this
     stays catchable in a Chromium-only harness.

     The installed flag lives on the patched function rather than on storage for
     the same reason - a flag on storage is a storage write. */
  function installMirror() {
    var storage = window.localStorage;
    if (!storage) return;

    var originalSet = storage.setItem.bind(storage);
    var originalRemove = storage.removeItem.bind(storage);
    if (storage.setItem.__gdDurableMirror) { state.active = true; return; }
    originalSetItem = originalSet;
    var durable = {};
    DURABLE_KEYS.forEach(function (key) { durable[key] = true; });

    function define(name, fn) {
      fn.__gdDurableMirror = true;
      /* Returns false rather than throwing if the property will not take, so a
         hostile or unusual Storage implementation degrades to no mirroring
         instead of breaking every write in the app. */
      return safe(function () {
        Object.defineProperty(storage, name, {
          value: fn, writable: true, configurable: true, enumerable: false
        });
        return storage[name] === fn;
      }, false);
    }

    var setOk = define("setItem", function (key, value) {
      var result = originalSet(key, value);
      if (durable[key]) safe(function () { mirror(key, value); });
      return result;
    });
    var removeOk = define("removeItem", function (key) {
      var result = originalRemove(key);
      if (durable[key]) safe(function () { unmirror(key); });
      return result;
    });

    cleanStrayKeys(originalRemove);
    state.active = setOk && removeOk;
  }

  /* Drop the junk entries the old assignment created. Uses the captured native
     removeItem: the patched one is in place by now, and these are not durable
     keys, but going straight to the original keeps this independent of whether
     the patch above actually took. */
  function cleanStrayKeys(originalRemove) {
    STRAY_KEYS.forEach(function (key) {
      safe(function () {
        if (window.localStorage.getItem(key) === null) return;
        originalRemove(key);
        state.cleaned += 1;
      });
    });
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

  /* What is actually filling the quota, measured on the device rather than
     guessed at from the repo.

     Eviction is the webview reclaiming space, so the only useful question is
     which keys are big - and that cannot be answered from here. The obvious
     suspects are already bounded (captured scans cap at 48, the sync outbox at
     36), so the real consumer is something nobody has looked at. This reports
     the total and the worst offenders once per session, and only when the total
     is big enough to be worth acting on, so it costs nothing in the normal case.

     Sizes are approximate on purpose: key.length + value.length in UTF-16 code
     units is within a rounding error of what the quota counts, and computing it
     exactly would mean walking every value twice. */
  var REPORT_BYTES = 2 * 1024 * 1024;
  var USAGE_REPORTED = "gd_durable_usage_reported_v1";

  function storageUsage() {
    var storage = window.localStorage;
    if (!storage) return null;
    var rows = [];
    var total = 0;
    for (var i = 0; i < storage.length; i += 1) {
      var key = storage.key(i);
      if (key === null) continue;
      var value = safe(function () { return storage.getItem(key); }, "") || "";
      var bytes = (key.length + value.length) * 2;
      total += bytes;
      rows.push({ key: key, bytes: bytes });
    }
    rows.sort(function (a, b) { return b.bytes - a.bytes; });
    return { total: total, keys: rows.length, top: rows.slice(0, 6) };
  }

  function reportUsageIfHeavy() {
    var already = safe(function () { return sessionStorage.getItem(USAGE_REPORTED) === "1"; }, false);
    if (already) return;
    var usage = storageUsage();
    if (!usage || usage.total < REPORT_BYTES) return;
    safe(function () { sessionStorage.setItem(USAGE_REPORTED, "1"); });
    safe(function () {
      if (!window.ClarityErrorReporter || typeof window.ClarityErrorReporter.report !== "function") return;
      var detail = Math.round(usage.total / 1024) + "KB over " + usage.keys + " keys | " +
        usage.top.map(function (row) { return row.key + "=" + Math.round(row.bytes / 1024) + "KB"; }).join(", ");
      window.ClarityErrorReporter.report("Durable storage usage high", detail);
    });
  }

  async function boot() {
    if (!isNative()) return;
    safe(reportUsageIfHeavy);
    var restored = await restore();
    state.restored = restored;

    if (!restored.length) {
      seed();
      return;
    }

    /* Something was evicted and has been put back. Report it either way - the
       eviction is the signal worth having, whether or not a reload follows. */
    safe(function () {
      if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
        window.ClarityErrorReporter.report(
          "Durable storage restored evicted keys",
          restored.join(",")
        );
      }
    });

    /* Only reload for keys the app read synchronously while booting. If the
       round was the only casualty it is already usable, and reloading would
       throw the player to home to fix something that is not broken. */
    var needsReload = restored.some(function (key) { return RELOAD_REQUIRED_KEYS.indexOf(key) !== -1; });
    if (!needsReload) {
      safe(function () {
        window.dispatchEvent(new CustomEvent("clarity:durable-restored", { detail: { keys: restored.slice(), reloaded: false } }));
      });
      return;
    }

    /* App scripts have already read an empty localStorage synchronously, so the
       only way to make them see the restored state is to load again. Guarded so
       a persistent failure cannot produce a reload loop. */
    var alreadyReloaded = safe(function () { return sessionStorage.getItem(RELOAD_GUARD) === "1"; }, false);
    if (alreadyReloaded) return;
    safe(function () { sessionStorage.setItem(RELOAD_GUARD, "1"); });
    safe(function () { location.reload(); });
  }

  window.GDDurableStorage = {
    keys: function () { return DURABLE_KEYS.slice(); },
    reloadKeys: function () { return RELOAD_REQUIRED_KEYS.slice(); },
    /* Exposed so the usage picture can be pulled on demand from a device
       console, not only when it crosses the reporting threshold. */
    usage: storageUsage,
    state: function () { return { restored: state.restored.slice(), mirrored: state.mirrored, active: state.active, cleaned: state.cleaned }; },
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
