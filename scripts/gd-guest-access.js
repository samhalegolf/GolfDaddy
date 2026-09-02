/* What a signed-out session IS, in one place.
 *
 * Before this file, "signed out" meant "not yet a user": the Profile screen was
 * a sign-in form, and the whole shot system answered gdAuthGateAllows() with a
 * login prompt. That is a wall in front of features that are not account based
 * (App Store guideline 5.1.1(v)), and it is also just a bad first run - the one
 * thing a new player most wants to see is what the bubble does, and they could
 * not reach it.
 *
 * A guest now has an identity, a profile, and the shot system - in demo mode.
 * Three separate ideas, kept separate:
 *
 *   identity   gd-guest-identity.js already mints a durable per-installation
 *              id ("guest:9f7381c2..."). This file derives a slug-safe PROFILE
 *              id from it ("guest9f7381c2"), so everything the app namespaces
 *              by profile id - the saved-course library keys in
 *              gd_user_course_library_v1, practice player scope - lands
 *              somewhere stable instead of on the shared hard-coded
 *              gd_placeholder_demo_player constant.
 *
 *   profile    A real row in the profile store named "Guest", carrying the
 *              placeholder's seeded bag and bubble so the Profile screen has
 *              the normal thing to render. It keeps placeholderProfile:true
 *              until the guest actually sets a bag, which is what tells
 *              gdProfileForNewAccount() whether signing up should adopt this
 *              profile or mint a fresh one.
 *
 *   demo mode  A guest may OPEN the shot system but may not feed it real
 *              evidence. The synthetic pipeline (GDDemoSession ->
 *              GDDemoCourseDataProvider) is the whole experience, so the
 *              guided flow is the only flow. importCapture is the single
 *              choke point every real practice import goes through, and it is
 *              guarded here rather than at each of the six intake buttons.
 *
 * What this file does NOT do: it is not a security boundary and never decides
 * what the SERVER will accept. Clearing storage mints a new guest. Round
 * writes during play are a separate decision owned by app/js/access.js, and
 * membership is owned by clarity-payments.js - a guest gate is not a paywall
 * and must not grow into one.
 */
(function () {
  "use strict";
  if (window.GDGuestAccess) return;

  /* Same store gd-course-library-pin-lock.js reads. Its keys are `${uid}::${cid}`
     where uid is `user-${slug(profileId)}`, so adopting a profile under a new id
     without rewriting them orphans every saved course. */
  var COURSE_STORE_KEY = "gd_user_course_library_v1";
  var ACCOUNTS_KEY = "gd_accounts_v1";
  var PLACEHOLDER_ID = "gd_placeholder_demo_player";
  var GUEST_NAME = "Guest";
  /* Names the seeded placeholder ships with. Anything else is something the
     player typed, and renaming it to "Guest" would be overwriting their work. */
  var REPLACEABLE_NAMES = { "Demo Player": 1, "Player 1": 1, "Player": 1, "": 1 };

  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

  /* Byte-identical to slug() in gd-course-library-pin-lock.js. The uid it
     builds has to match what that file computes from the same profile id, or
     the re-key below moves records somewhere nothing reads. */
  function slug(value) {
    return String(value || "item").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
  }
  function uidFor(profileId) { return "user-" + slug(profileId); }

  function account() {
    return safe(function () {
      var api = window.GolfDaddyAccounts;
      return api && typeof api.current === "function" ? api.current() : null;
    }, null);
  }

  function isGuest() { return !account(); }

  /* The URL demo route (?demo=practice-bubble) seeds REAL practice rows through
     importCapture on purpose - gd-auth-gate-v1.js:seedRealPracticeDemo. It is a
     deliberate developer/marketing route, not a guest walking in, so the guard
     stands aside for it rather than silently producing an empty demo. */
  function urlDemoRoute() {
    return safe(function () {
      return new URLSearchParams(window.location.search).get("demo") === "practice-bubble";
    }, false);
  }

  function guestProfileId() {
    var id = safe(function () {
      return window.GDGuestIdentity && typeof window.GDGuestIdentity.getOrCreateGuestId === "function"
        ? String(window.GDGuestIdentity.getOrCreateGuestId() || "")
        : "";
    }, "") || "";
    /* Lowercase hex by construction, so the result stays slug-safe and survives
       slug() unchanged - "guest9f7381c2" in, "guest9f7381c2" out. */
    return id ? "guest" + id.slice(0, 8) : "guest";
  }

  function profileState() {
    return safe(function () {
      /* gd-app-core.js declares this with `let` at the top level of a classic
         script, so it lives in the global lexical scope rather than on window.
         The typeof guard is what keeps this file loadable on its own. */
      return typeof GD_PROFILE_STATE !== "undefined" ? GD_PROFILE_STATE : (window.GD_PROFILE_STATE || null);
    }, null);
  }

  function persistProfiles() {
    safe(function () { if (typeof window.savePlayerProfiles === "function") window.savePlayerProfiles(); });
    safe(function () { if (typeof window.syncCoreProfileFromActive === "function") window.syncCoreProfileFromActive(); });
  }

  /* Profile ids any stored account points at. Those profiles belong to a real
     account - a second player on the same device, or this player signed out -
     and must never be re-labelled as the guest. */
  function claimedProfileIds() {
    return safe(function () {
      var raw = JSON.parse(window.localStorage.getItem(ACCOUNTS_KEY) || "null") || {};
      var accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      return accounts.map(function (row) { return row && row.profileId ? String(row.profileId) : ""; })
        .filter(Boolean);
    }, []) || [];
  }

  /* Moves saved-course records from one profile's namespace to another. Returns
     how many moved, so a caller (and the test) can tell "nothing to move" from
     "the write failed". */
  function rekeyCourseLibrary(fromProfileId, toProfileId) {
    if (!fromProfileId || !toProfileId) return 0;
    var oldUid = uidFor(fromProfileId);
    var newUid = uidFor(toProfileId);
    if (oldUid === newUid) return 0;
    return safe(function () {
      var raw = window.localStorage.getItem(COURSE_STORE_KEY);
      if (!raw) return 0;
      var store = JSON.parse(raw);
      if (!store || !store.courses) return 0;
      var prefix = oldUid + "::";
      var moved = 0;
      var next = {};
      Object.keys(store.courses).forEach(function (key) {
        var course = store.courses[key];
        var mine = !!course && (course.userId === oldUid || String(key).indexOf(prefix) === 0);
        if (!mine) { next[key] = course; return; }
        /* Prefer the key's own course id. A record whose key does not carry the
           expected prefix still has courseId on it, so it is re-keyed rather
           than dropped. */
        var cid = String(key).indexOf(prefix) === 0
          ? String(key).slice(prefix.length)
          : slug(course && (course.courseId || course.id) || "course");
        course.userId = newUid;
        next[newUid + "::" + cid] = course;
        moved += 1;
      });
      if (!moved) return 0;
      store.courses = next;
      window.localStorage.setItem(COURSE_STORE_KEY, JSON.stringify(store));
      return moved;
    }, 0);
  }

  /* The seeded placeholder, but only when nothing else has a claim on it.
     Adopting it in place (rather than minting a second profile beside it) is
     what stops a guest who has already been using the app from losing the bag
     and the saved courses they built up under the old shared id. */
  function adoptablePlaceholder(state) {
    var claimed = claimedProfileIds();
    return (state.profiles || []).filter(function (p) {
      if (!p || !p.id) return false;
      if (claimed.indexOf(String(p.id)) !== -1) return false;
      return p.id === PLACEHOLDER_ID || p.placeholderProfile === true;
    })[0] || null;
  }

  function buildGuestProfile(id) {
    var built = safe(function () {
      return typeof window.gdPlaceholderProfile === "function" ? window.gdPlaceholderProfile(id) : null;
    }, null);
    if (!built) {
      built = {
        id: id, name: GUEST_NAME, handedness: "right", mode: "player",
        permission: "player", accountPermission: "player", consistency: "mid",
        bag: [], bubbleProfiles: {}, onboardingComplete: true, placeholderProfile: true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
    }
    built.id = id;
    built.name = GUEST_NAME;
    return built;
  }

  /* Idempotent: safe to call on every session change, every boot, and from the
     Profile screen's own render path. Returns the guest profile, or null when
     there is an account (a signed-in player is never given one). */
  function ensureGuestProfile() {
    if (!isGuest()) return null;
    var state = profileState();
    if (!state || !Array.isArray(state.profiles)) return null;

    var id = guestProfileId();
    var guest = state.profiles.filter(function (p) { return p && p.id === id; })[0] || null;

    if (!guest) {
      var adopted = adoptablePlaceholder(state);
      if (adopted) {
        var previousId = String(adopted.id);
        adopted.id = id;
        if (REPLACEABLE_NAMES[String(adopted.name || "")]) adopted.name = GUEST_NAME;
        rekeyCourseLibrary(previousId, id);
        guest = adopted;
      } else {
        guest = buildGuestProfile(id);
        state.profiles.unshift(guest);
      }
    }

    guest.guestProfile = true;
    guest.guestId = id;
    state.activeId = guest.id;
    persistProfiles();
    return guest;
  }

  /* The one question the shot system asks. True means "synthetic evidence only,
     and the guided demo is the way in". */
  function demoOnly() { return isGuest() && !urlDemoRoute(); }

  function toast(message) {
    safe(function () {
      if (typeof window.gdLmToast === "function") return window.gdLmToast(message);
      if (typeof window.toast === "function") return window.toast(message);
    });
  }

  /* Every real practice import - camera scan, email intake, pasted CSV, manual
     plot, coach set - ends at importCapture. Guarding it here is one edit
     instead of six, and it cannot be routed around by a new intake button that
     forgets to ask. The demo pipeline never calls it (GDDemoSession builds its
     store in memory and hands it straight to analyze()), so the guided flow is
     unaffected. */
  function guardPracticeWrites() {
    var api = window.GolfDaddyLaunchMonitorData;
    if (!api || api.__gdGuestGuard || typeof api.importCapture !== "function") return false;
    var real = api.importCapture;
    api.importCapture = function () {
      if (demoOnly()) {
        toast("Demo mode - sign in to import your own practice data");
        /* The real return shape, emptied. Callers read .shots.length to report
           what landed; returning null would throw on the way to the message. */
        return { session: null, capture: null, shots: [], blocked: "guest-demo" };
      }
      return real.apply(this, arguments);
    };
    api.__gdGuestGuard = true;
    return true;
  }

  /* One class, read by styles/gd-guest-mode.css to take the real-intake controls
     off the Practice surface, and by gd-route-audit.js to decide whether opening
     the shot system should start the guided demo. */
  function applyBodyState() {
    var guest = isGuest();
    safe(function () {
      if (!document.body) return;
      document.body.classList.toggle("gdGuestSession", guest);
      document.body.classList.toggle("gdGuestDemoMode", demoOnly());
    });
    if (guest) ensureGuestProfile();
    return guest;
  }

  function sync() {
    guardPracticeWrites();
    return applyBodyState();
  }

  window.GDGuestAccess = {
    isGuest: isGuest,
    demoOnly: demoOnly,
    guestProfileId: guestProfileId,
    ensureGuestProfile: ensureGuestProfile,
    sync: sync,
    /* exposed for dev/guest-access.test.js */
    _uidFor: uidFor,
    _rekeyCourseLibrary: rekeyCourseLibrary,
    _guardPracticeWrites: guardPracticeWrites
  };

  /* Sign in and sign out both land here: clarity-session.js dispatches on any
     identity change, which is exactly when the guest profile has to appear or
     stand down. */
  safe(function () {
    window.addEventListener("clarity:session-changed", function () { sync(); });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(sync, 0); });
  } else {
    setTimeout(sync, 0);
  }
  /* gd-app-core.js's bootProfileShell() installs the placeholder and saves the
     store on its own schedule; a second pass after it settles is what makes the
     adopt-in-place path deterministic on a cold boot. */
  setTimeout(sync, 400);
})();
