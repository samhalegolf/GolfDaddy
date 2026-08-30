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
    var profile = safe(function () { return window.gdProfileById && id ? window.gdProfileById(id) : null; }, null)
      || safe(function () { return window.GolfDaddyProfiles && window.GolfDaddyProfiles.active(); }, null) || null;
    return { id: id || "guest", name: clean(profile && profile.name) || clean(session.accountName) || "Guest", ownId: clean(session.ownProfileId) };
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
  function restore() {
    var handoff = readHandoff();
    var context = handoff && handoff.returnContext;
    if (!context || !context.surface) return false;
    safe(function () { sessionStorage.removeItem(HANDOFF_KEY); });
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
