(function () {
  "use strict";

  var root = window.Clarity = window.Clarity || {};
  var safe = root.store && root.store.safe || function (fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  };

  var ROUTE_LABELS = {
    home: "Home",
    gps: "GPS",
    bag: "Bag",
    profile: "Profile",
    settings: "Settings",
    playerSettings: "Settings",
    coachPortal: "Coaching Portal",
    shotData: "Shot Data",
    courseData: "Course Data",
    practiceData: "Practice Data",
    admin: "Admin",
    developer: "Admin"
  };

  var ALIASES = {
    shellHome: "home",
    gpsPanel: "gps",
    profilePanel: "profile",
    gdProfileV67: "profile",
    settingsPanel: "settings",
    playerSettingsPanel: "playerSettings",
    bagPanel: "bag",
    dataHubPanel: "shotData",
    statsPanel: "courseData",
    practiceDataPanel: "practiceData",
    developerPanel: "admin"
  };

  var state = {
    name: "home",
    label: "Home",
    params: {},
    previous: null,
    history: ["home"],
    updatedAt: new Date().toISOString()
  };

  function normalize(name) {
    var key = String(name || "home").trim();
    return ALIASES[key] || key || "home";
  }

  function labelFor(name) {
    return ROUTE_LABELS[normalize(name)] || String(name || "Home");
  }

  function emit(route) {
    safe(function () {
      window.dispatchEvent(new CustomEvent("clarity:route-changed", { detail: route }));
    });
  }

  function applyToDom(route) {
    if (!document.body) return;
    document.body.dataset.clarityRoute = route.name;
    document.body.dataset.clarityRouteLabel = route.label;
    var label = document.getElementById("shellRouteLabel");
    if (label) label.textContent = route.label || "Home";
    var back = document.getElementById("shellBackBtn");
    if (back) back.style.visibility = route.name && route.name !== "home" ? "visible" : "hidden";
  }

  function navigate(name, opts) {
    opts = opts || {};
    var nextName = normalize(name);
    var previous = state.name;
    var replacing = !!opts.replace;
    if (replacing) {
      state.history = state.history.length ? state.history.slice(0, -1).concat(nextName) : [nextName];
    } else if (state.history[state.history.length - 1] !== nextName) {
      state.history = state.history.concat(nextName).slice(-24);
    }
    state = {
      name: nextName,
      label: opts.label || labelFor(nextName),
      params: opts.params || {},
      previous: replacing ? state.previous : previous,
      history: state.history,
      source: opts.source || "app",
      updatedAt: new Date().toISOString()
    };
    applyToDom(state);
    if (!opts.silent) emit(state);
    return state;
  }

  function back(fallback) {
    var history = state.history.slice();
    history.pop();
    var target = history.pop() || fallback || "home";
    return navigate(target, { replace: true, source: "back" });
  }

  function legacyRemember(name, replace) {
    return navigate(normalize(name), {
      replace: !!replace,
      source: "legacy-remember",
      silent: true
    });
  }

  root.router = {
    get: function () { return state; },
    navigate: navigate,
    back: back,
    remember: legacyRemember,
    normalize: normalize,
    labelFor: labelFor
  };

  window.ClarityRouter = root.router;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { applyToDom(state); });
  } else {
    applyToDom(state);
  }
})();
