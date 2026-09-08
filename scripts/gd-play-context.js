/* One owner for the player operating Play, its durable state, and its way back
   to the shell.  The root page can resolve the selected coach player directly;
   /app/ receives that exact snapshot through sessionStorage. */
(function () {
  "use strict";
  var HANDOFF_KEY = "clarity:play-context:v1";
  var MIGRATION_KEY = "clarity:play-legacy-migrated:v1";
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function clean(value) { return String(value || "").trim(); }
  function readHandoff() { return safe(function () { return JSON.parse(sessionStorage.getItem(HANDOFF_KEY) || "null"); }, null) || null; }
  function rootIdentity() {
    var session = safe(function () { return window.ClaritySession && window.ClaritySession.get(); }, null) || {};
    var id = clean(session.viewedProfileId || session.ownProfileId);
    /* No profile id means nobody is signed in and nobody is being viewed.
       GolfDaddyProfiles.active() still answers here (it falls back to the first
       stored profile, which logout deliberately leaves behind), so asking it
       would stamp a signed-out round with the previous owner's name. */
    if (!id) return { id: "guest", name: "Guest", ownId: "" };
    var profile = safe(function () { return window.gdProfileById ? window.gdProfileById(id) : null; }, null)
      || safe(function () { return window.GolfDaddyProfiles && window.GolfDaddyProfiles.active(); }, null) || null;
    return { id: id, name: clean(profile && profile.name) || clean(session.accountName) || "Guest", ownId: clean(session.ownProfileId) };
  }
  function identity() {
    var handoff = readHandoff();
    if (handoff && clean(handoff.playerId)) return { id: clean(handoff.playerId), name: clean(handoff.playerName) || "Player", ownId: clean(handoff.ownProfileId) };
    return rootIdentity();
  }
  function returnContext(opts) {
    opts = opts || {};
    var player = identity();
    if (opts.returnContext && typeof opts.returnContext === "object") return opts.returnContext;
    if (opts.returnTarget === "practice" || opts.source === "practice-play") return { surface: "practice" };
    if (player.ownId && player.id !== player.ownId) return { surface: "coach-player", profileId: player.id };
    return { surface: "home" };
  }
  function begin(opts) {
    var player = rootIdentity();
    var payload = { version: 1, playerId: player.id || "guest", playerName: player.name || "Guest", ownProfileId: player.ownId || "", returnContext: returnContext(opts), createdAt: Date.now() };
    safe(function () { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload)); });
    return payload;
  }
  function key(name) { return "clarity:player:" + identity().id.replace(/[^a-zA-Z0-9_-]/g, "_") + ":" + clean(name) + ":v1"; }
  function readJson(name, legacyKey) {
    var scoped = safe(function () { return JSON.parse(localStorage.getItem(key(name)) || "null"); }, null);
    if (scoped) return scoped;
    /* A legacy record has no reliable owner. Adopt it once, only for the first
       legitimate Play owner; later coach-selected players always start clean. */
    if (!legacyKey || safe(function () { return localStorage.getItem(MIGRATION_KEY); }, "")) return null;
    var legacy = safe(function () { return JSON.parse(localStorage.getItem(legacyKey) || "null"); }, null);
    if (legacy) {
      safe(function () { localStorage.setItem(key(name), JSON.stringify(legacy)); localStorage.setItem(MIGRATION_KEY, "1"); });
      return legacy;
    }
    return null;
  }
  function writeJson(name, value) { safe(function () { localStorage.setItem(key(name), JSON.stringify(value)); }); return value; }
  function remove(name) { safe(function () { localStorage.removeItem(key(name)); }); }
  /* DEMO MODE COMES BACK TO COURSE DATA, NOT TO WHERE IT SET OFF FROM.
     The demo tells one story - practice, adopt a bubble, take it round, then
     look at what the round did to it - and the last step is the point of the
     first three. Returning to Practice put the player back on a screen they had
     already finished with, with the round they had just played nowhere on it.
     This covers every way out of GPS Play, not just the "See Course Data"
     button: Back and the exit control land here too. Real rounds are untouched,
     because it only reads true while a demo session is live.

     Read straight out of sessionStorage rather than through window.GDDemoSession
     on purpose. This file loads before gd-demo-session.js and gd-route-audit.js,
     and restore() is fired from gd-shell.js, which loads before all three - so
     the object is not reliably there yet, while the key it is built from always
     is. Same cross-document contract app/js/demo-session.js reads. */
  var DEMO_STATE_KEY = "gd_demo_session_v1";
  function demoState() {
    return safe(function () { return JSON.parse(sessionStorage.getItem(DEMO_STATE_KEY) || "null"); }, null) || null;
  }
  /* Through the object when it is there, and only otherwise by hand. Course
     Data is switched to the demo analysis by gdCurrentStatsAnalysis reading
     GDDemoSession.courseDataActive, and that getter answers from the copy
     gd-demo-session.js loaded at parse time - a raw write to the key underneath
     it changes nothing that screen will ever look at. */
  function markDemoCourseDataActive() {
    if (safe(function () { return typeof window.GDDemoSession.setCourseDataActive === "function"; }, false)) {
      safe(function () { window.GDDemoSession.setCourseDataActive(true); });
      return;
    }
    var state = demoState();
    if (!state) return;
    state.courseDataActive = true;
    safe(function () { sessionStorage.setItem(DEMO_STATE_KEY, JSON.stringify(state)); });
  }
  function openDemoCourseData() {
    return safe(function () {
      if (typeof window.gdOpenCourseData !== "function") return false;
      window.gdOpenCourseData({ demo: true });
      return true;
    }, false);
  }
  function restoreDemoCourseData() {
    var state = demoState();
    if (!state || !state.active) return false;
    /* The CTA route (/?openDemoCourseData=1) is already opening Course Data from
       bootProfileShell by the time this runs; opening it twice would push a
       second history entry for one screen. */
    if (safe(function () { return new URLSearchParams(window.location.search || "").has("openDemoCourseData"); }, false)) return true;
    markDemoCourseDataActive();
    if (openDemoCourseData()) return true;
    /* gdOpenCourseData is defined in gd-route-audit.js, which the shell's restore
       timer can beat. Claim the return anyway and open on the next turn, rather
       than falling through to Practice - the one screen this exists to avoid. */
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(openDemoCourseData, 0); }, { once: true });
    else setTimeout(openDemoCourseData, 0);
    return true;
  }
  function restore() {
    var handoff = readHandoff();
    var context = handoff && handoff.returnContext;
    if (!context || !context.surface) return false;
    safe(function () { sessionStorage.removeItem(HANDOFF_KEY); });
    if (restoreDemoCourseData()) return true;
    if (context.surface === "practice") return safe(function () { return window.GDShell.openModule("practiceData", { module: "practiceData", moduleId: "practiceDataPanel", source: "gps-return" }); }, false);
    if (context.surface === "coach-player" && clean(context.profileId)) {
      safe(function () { window.GolfDaddyAccounts && window.GolfDaddyAccounts.viewProfile(context.profileId); });
      return safe(function () { return window.GDShell.openModule("profile", { module: "profile", source: "gps-return-player" }); }, false);
    }
    return safe(function () { return window.GDShell.showHome({ source: "gps-return" }); }, false);
  }
  function returnToOrigin() { window.location.href = "/"; return false; }
  window.GDPlayContext = { identity: identity, effectivePlayerId: function () { return identity().id; }, effectivePlayerName: function () { return identity().name; }, storageKey: key, readJson: readJson, writeJson: writeJson, remove: remove, begin: begin, restore: restore, returnToOrigin: returnToOrigin, returnContext: returnContext };
}());
