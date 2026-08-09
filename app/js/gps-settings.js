/* GPS Settings: the round/shot-view preferences that survived the rebuild.

   The legacy panel (index.html #settingsPanel) carried thirteen controls.
   Most of them described decisions the app no longer lets a player make:
   map source is chosen by imagery licence and region (basemap.js), mapped vs
   manual play is decided by whether the package has geometry, and the bubble
   render/bias/texture toggles were dev tuning for comparing renderers that
   bubble-engine.js now bakes in. What is left is the four things that are
   genuinely the player's call, none of which app/ could express before:

     units          - metres or yards, everywhere a distance is shown
     aimLine        - draw the start-to-target guide at all
     shotUp         - rotate the view so the shot runs up the screen
     frameTightness - how much of the shot the lock stage fills

   Owns its own storage, same as bag.js and scorecard.js do. Nothing here
   talks to a server or to any course/surface table. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:gps-settings:v1";

  var TIGHTNESS = {
    tight:  { label: "Tight",  sub: "Tight shot focus",     factor: 1.18 },
    medium: { label: "Medium", sub: "Balanced shot view",   factor: 1 },
    wide:   { label: "Wide",   sub: "More of the hole",     factor: 0.84 }
  };
  var TIGHTNESS_ORDER = ["tight", "medium", "wide"];

  /* corridor is deliberately not in the panel yet: it is the dispersion
     corridor from the v2 bubble design, off until it has been played with.
     Stored like the rest so turning it on survives a reload. */
  var DEFAULTS = { units: "m", aimLine: true, shotUp: true, frameTightness: "medium", corridor: false };

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
        corridor: raw.corridor === true
      };
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function notify() { listeners.forEach(function (fn) { try { fn(state); } catch (e) {} }); }

  var YARDS_PER_METRE = 1.0936133;

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

    /* Metres in (everything upstream computes in metres, always), display
       number out. Rounded, never a unit suffix — callers own their own
       label, and the shot card deliberately shows bare numbers. */
    toDisplay: function (metres) {
      if (!Number.isFinite(Number(metres))) return null;
      var v = Number(metres);
      return Math.round(state.units === "yd" ? v * YARDS_PER_METRE : v);
    },
    unitLabel: function () { return state.units === "yd" ? "yd" : "m"; },
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
      unitsBtn.textContent = state.units === "yd" ? "Yards" : "Meters";
      unitsBtn.setAttribute("aria-pressed", "true");
    }
    var aimBtn = document.getElementById("setAimLine");
    if (aimBtn) {
      aimBtn.textContent = state.aimLine ? "On" : "Off";
      aimBtn.setAttribute("aria-pressed", state.aimLine ? "true" : "false");
    }
    var shotUpBtn = document.getElementById("setShotUp");
    if (shotUpBtn) {
      shotUpBtn.textContent = state.shotUp ? "On" : "Off";
      shotUpBtn.setAttribute("aria-pressed", state.shotUp ? "true" : "false");
    }
    var tightBtn = document.getElementById("setFrameTight");
    var tightSub = document.getElementById("setFrameTightSub");
    if (tightBtn) {
      tightBtn.textContent = TIGHTNESS[state.frameTightness].label;
      tightBtn.setAttribute("aria-pressed", "true");
    }
    if (tightSub) tightSub.textContent = TIGHTNESS[state.frameTightness].sub;
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
    var close = document.getElementById("gpsSettingsClose");
    if (close) close.addEventListener("click", function () { app.gpsSettings.close(); });
    render();
  });
})();
