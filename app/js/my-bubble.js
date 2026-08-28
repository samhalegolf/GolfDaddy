/* The saved My Bubble, read into the play surface.

   Adopt -> Save in the studio writes the aim onto the active player profile
   (p.faceOffsetDeg / p.centralFaceOffsetDeg), and marks it live with
   p.practiceBubbleSource.active. Bubble Bible s2 is the rule this file obeys:
   ONLY AN ACTIVE SOURCE COUNTS — a saved shape sitting on the profile is not a
   My Bubble by itself.

   This is the only thing in app/ that reads that store, and it hands the engine
   the only two values the GPS bubble is allowed to take from it: a degree value
   and a handedness. Size comes from the bag, never from here.

   With no active saved bubble we pass 0.0 deg explicitly rather than letting
   the engine fall through to its placeholder 1.4 deg right. A fabricated aim
   bias is the same stand-in the Bible rejects everywhere else, and it was being
   applied to left-handers as a right-hand miss. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var PROFILE_KEY = "gd_player_profiles_v27";   // gd-app-core.js GD_PROFILE_STORE_KEY
  var listeners = [];
  var applied = null;

  function activeProfile() {
    try {
      var raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null") || {};
      var profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      if (!profiles.length) return null;
      return profiles.filter(function (p) { return p && p.id === raw.activeId; })[0] || profiles[0];
    } catch (e) { return null; }
  }

  function num(value) {
    return (value === null || value === undefined || value === "") ? NaN : Number(value);
  }

  function handednessOf(profile) {
    return profile && profile.handedness === "left" ? "left" : "right";
  }

  /* null means "no My Bubble set", which is a real answer, not a failure. */
  function saved() {
    var p = activeProfile();
    if (!p) return null;
    var source = p.practiceBubbleSource;
    if (!source || source.active !== true) return null;
    /* Guard null/undefined/"" explicitly: Number(null) is 0 and passes a bare
       finite check, which would report a fabricated 0.0 deg aim as a real saved
       bubble (Bubble Bible s8). */
    var deg = num(p.faceOffsetDeg);
    if (!Number.isFinite(deg)) deg = num(p.centralFaceOffsetDeg);
    if (!Number.isFinite(deg)) return null;
    return { offsetDeg: deg, handedness: handednessOf(p) };
  }

  /* Demo Mode: a transient adopted bubble takes over this seam while active,
     without touching the real profile this file otherwise reads. See
     scripts/gd-demo-session.js and app/js/demo-session.js - both write the
     same sessionStorage key, since Play -> Course Picker -> GPS Play is a
     real document navigation with no in-JS handoff. */
  function demoSession() {
    return window.GDDemoSession && window.GDDemoSession.active ? window.GDDemoSession : null;
  }

  function apply() {
    if (!window.GDBubbleEngine || !window.GDBubbleEngine.setBubble) return;
    var demo = demoSession();
    var bubble = (demo && demo.adopted && demo.adoptedBubble) ? demo.adoptedBubble
      : (saved() || { offsetDeg: 0, handedness: handednessOf(activeProfile()) });
    var key = bubble.offsetDeg + "|" + bubble.handedness;
    window.GDBubbleEngine.setBubble(bubble);
    if (demo && demo.demoBag && demo.demoBag.length && window.GDBubbleEngine.setBag) {
      window.GDBubbleEngine.setBag(demo.demoBag);
    }
    if (key === applied) return;
    applied = key;
    listeners.forEach(function (fn) { try { fn(bubble); } catch (e) {} });
  }

  app.myBubble = {
    current: saved,
    refresh: apply,
    onChange: function (fn) { listeners.push(fn); }
  };

  /* A save made in the studio tab, or an app resumed mid-round, must not keep
     playing the old aim until the next drag. */
  window.addEventListener("storage", function (e) {
    if (!e.key || e.key === PROFILE_KEY) apply();
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) apply();
  });
  document.addEventListener("DOMContentLoaded", apply);
  apply();
})();
