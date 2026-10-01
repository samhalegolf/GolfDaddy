/* GPS Settings: the round/shot-view preferences that survived the rebuild.

   The legacy panel (index.html #settingsPanel) carried thirteen controls.
   Most of them described decisions the app no longer lets a player make:
   map source is chosen by imagery licence and region (basemap.js), mapped vs
   manual play is decided by whether the package has geometry, and the bubble
   render/bias/texture toggles were dev tuning for comparing renderers that
   bubble-engine.js now bakes in. What is left is the five things that are
   genuinely the player's call, none of which app/ could express before:

     units          - metres or yards, everywhere a distance is shown
     aimLine        - draw the start-to-target guide at all
     shotUp         - rotate the view so the shot runs up the screen
     frameTightness - how much of the shot the lock stage fills
     relief         - how far the terrain mesh lifts the ground (off to 5x)

   Owns its own storage, same as bag.js and scorecard.js do. Nothing here
   talks to a server or to any course/surface table. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:gps-settings:v1";

  /* label/sub are translation keys (scripts/i18n/en.js). */
  var TIGHTNESS = {
    tight:  { label: "gpsSettings.tightnessTight",  sub: "gpsSettings.tightnessTightHint",  factor: 1.18 },
    medium: { label: "gpsSettings.tightnessMedium", sub: "gpsSettings.tightnessMediumHint", factor: 1 },
    wide:   { label: "gpsSettings.tightnessWide",   sub: "gpsSettings.tightnessWideHint",   factor: 0.84 }
  };
  var TIGHTNESS_ORDER = ["tight", "medium", "wide"];

  /* Vertical exaggeration for the terrain mesh (gd-terrain-mesh.js). Off
     leaves the flat published frame, which is a complete picture on its own. */
  var RELIEF = {
    off:      { label: "gpsSettings.reliefOff",      sub: "gpsSettings.reliefOffHint",      factor: 0 },
    natural:  { label: "gpsSettings.reliefNatural",  sub: "gpsSettings.reliefNaturalHint",  factor: 1 },
    enhanced: { label: "gpsSettings.reliefEnhanced", sub: "gpsSettings.reliefEnhancedHint", factor: 2.5 },
    dramatic: { label: "gpsSettings.reliefDramatic", sub: "gpsSettings.reliefDramaticHint", factor: 5 }
  };
  var RELIEF_ORDER = ["off", "natural", "enhanced", "dramatic"];

  /* corridor is deliberately not in the panel yet: it is the dispersion
     corridor from the v2 bubble design, off until it has been played with.
     Stored like the rest so turning it on survives a reload. */
  var DEFAULTS = { units: "m", aimLine: true, shotUp: true, frameTightness: "medium", relief: "enhanced", corridor: false };

  var state = load();
  var listeners = [];

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null") || {};
      return {
        units: raw.units === "yd" ? "yd" : "m",
        aimLine: raw.aimLine !== false,
        shotUp: raw.shotUp !== false,
        frameTightness: TIGHTNESS[raw.frameTightness] ? raw.frameTightness : DEFAULTS.frameTightness,
        relief: RELIEF[raw.relief] ? raw.relief : DEFAULTS.relief,
        corridor: raw.corridor === true
      };
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function notify() { listeners.forEach(function (fn) { try { fn(state); } catch (e) {} }); }

  var YARDS_PER_METRE = 1.0936133;

  function t(key) { return window.GDI18n ? window.GDI18n.t(key) : key; }

  app.gpsSettings = {
    get: function () { return Object.assign({}, state); },
    units: function () { return state.units; },
    aimLine: function () { return state.aimLine; },
    shotUp: function () { return state.shotUp; },
    corridor: function () { return state.corridor; },
    /* The lock stage's anchor spread. >1 pushes the aim target further from
       the player anchor, so the same real distance spans more pixels — a
       tighter, more zoomed shot view. */
    lockTightness: function () { return TIGHTNESS[state.frameTightness].factor; },
    /* 0 means no mesh at all, not a flat mesh. */
    reliefExaggeration: function () { return RELIEF[state.relief].factor; },

    /* Metres in (everything upstream computes in metres, always), display
       number out. Rounded, never a unit suffix — callers own their own
       label, and the shot card deliberately shows bare numbers. */
    toDisplay: function (metres) {
      if (!Number.isFinite(Number(metres))) return null;
      var v = Number(metres);
      return Math.round(state.units === "yd" ? v * YARDS_PER_METRE : v);
    },
    unitLabel: function () { return state.units === "yd" ? "yd" : "m"; },
    /* The inverse: a number the player typed in their units (a rangefinder
       reading for Pin Lock) back to the metres everything computes in.
       Null for anything that is not a positive number. */
    fromDisplay: function (shown) {
      var v = Number(shown);
      if (!Number.isFinite(v) || v <= 0) return null;
      return state.units === "yd" ? v / YARDS_PER_METRE : v;
    },
    /* "142m" / "155yd" — for the labels that do carry a suffix (pin distance,
       the middle guide's green readout). */
    format: function (metres) {
      var n = this.toDisplay(metres);
      return n === null ? "" : n + this.unitLabel();
    },

    set: function (key, value) {
      if (!(key in DEFAULTS)) return;
      state[key] = value;
      save();
      render();
      notify();
    },
    onChange: function (fn) { listeners.push(fn); },

    open: function () {
      var panel = document.getElementById("gpsSettingsPanel");
      if (!panel) return;
      render();
      panel.classList.remove("hiddenState");
    },
    close: function () {
      var panel = document.getElementById("gpsSettingsPanel");
      if (panel) panel.classList.add("hiddenState");
    }
  };

  /* Every row is the same shape: a toggle button whose text IS its current
     value, matching the legacy panel's own idiom. */
  function render() {
    var unitsBtn = document.getElementById("setUnits");
    if (unitsBtn) {
      unitsBtn.textContent = t(state.units === "yd" ? "gpsSettings.unitsYards" : "gpsSettings.unitsMetres");
      unitsBtn.setAttribute("aria-pressed", "true");
    }
    var aimBtn = document.getElementById("setAimLine");
    if (aimBtn) {
      aimBtn.textContent = t(state.aimLine ? "common.on" : "common.off");
      aimBtn.setAttribute("aria-pressed", state.aimLine ? "true" : "false");
    }
    var shotUpBtn = document.getElementById("setShotUp");
    if (shotUpBtn) {
      shotUpBtn.textContent = t(state.shotUp ? "common.on" : "common.off");
      shotUpBtn.setAttribute("aria-pressed", state.shotUp ? "true" : "false");
    }
    var tightBtn = document.getElementById("setFrameTight");
    var tightSub = document.getElementById("setFrameTightSub");
    if (tightBtn) {
      tightBtn.textContent = t(TIGHTNESS[state.frameTightness].label);
      tightBtn.setAttribute("aria-pressed", "true");
    }
    if (tightSub) tightSub.textContent = t(TIGHTNESS[state.frameTightness].sub);
    var reliefBtn = document.getElementById("setRelief");
    if (reliefBtn) {
      reliefBtn.textContent = t(RELIEF[state.relief].label);
      reliefBtn.setAttribute("aria-pressed", state.relief === "off" ? "false" : "true");
    }
    var reliefSub = document.getElementById("setReliefSub");
    if (reliefSub) reliefSub.textContent = t(RELIEF[state.relief].sub);
    renderMapSource();
  }

  /* Operator-only map source override, owned by basemap.js; this is only its
     button. Hidden for everyone but the admin account. */
  var MAP_SOURCE_LABELS = { auto: "Auto", esri: "Esri", mapbox: "Mapbox" };
  var MAP_SOURCE_SUBS = {
    auto: "Auto: chosen by region.",
    esri: "Forced: Esri World Imagery.",
    mapbox: "Forced: Mapbox Satellite. Falls back to Auto if no token is set."
  };
  function renderMapSource() {
    var group = document.getElementById("setMapSourceGroup");
    if (!group) return;
    var operator = false;
    try { operator = !!(app.account && app.account.isAdmin && app.account.isAdmin()); } catch (e) {}
    if (!operator || !app.basemap || !app.basemap.override) { group.classList.add("hiddenState"); return; }
    group.classList.remove("hiddenState");
    var current = app.basemap.override();
    var btn = document.getElementById("setMapSource");
    if (btn) btn.textContent = MAP_SOURCE_LABELS[current] || current;
    var sub = document.getElementById("setMapSourceSub");
    if (sub) sub.textContent = MAP_SOURCE_SUBS[current] || "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var unitsBtn = document.getElementById("setUnits");
    if (unitsBtn) unitsBtn.addEventListener("click", function () {
      app.gpsSettings.set("units", state.units === "yd" ? "m" : "yd");
    });
    var aimBtn = document.getElementById("setAimLine");
    if (aimBtn) aimBtn.addEventListener("click", function () {
      app.gpsSettings.set("aimLine", !state.aimLine);
    });
    var shotUpBtn = document.getElementById("setShotUp");
    if (shotUpBtn) shotUpBtn.addEventListener("click", function () {
      app.gpsSettings.set("shotUp", !state.shotUp);
    });
    var tightBtn = document.getElementById("setFrameTight");
    if (tightBtn) tightBtn.addEventListener("click", function () {
      var i = TIGHTNESS_ORDER.indexOf(state.frameTightness);
      app.gpsSettings.set("frameTightness", TIGHTNESS_ORDER[(i + 1) % TIGHTNESS_ORDER.length]);
    });
    var reliefBtn = document.getElementById("setRelief");
    if (reliefBtn) reliefBtn.addEventListener("click", function () {
      var i = RELIEF_ORDER.indexOf(state.relief);
      app.gpsSettings.set("relief", RELIEF_ORDER[(i + 1) % RELIEF_ORDER.length]);
    });
    var mapSourceBtn = document.getElementById("setMapSource");
    if (mapSourceBtn) mapSourceBtn.addEventListener("click", function () {
      if (!app.basemap || !app.basemap.setOverride) return;
      var order = app.basemap.overrides();
      var i = order.indexOf(app.basemap.override());
      app.basemap.setOverride(order[(i + 1) % order.length]);
      renderMapSource();
    });
    var close = document.getElementById("gpsSettingsClose");
    if (close) close.addEventListener("click", function () { app.gpsSettings.close(); });
    if (window.GDI18n) window.GDI18n.onChange(render);
    render();
  });
})();
