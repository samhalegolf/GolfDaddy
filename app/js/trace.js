/* Trace — where did that come from?

   Design: PLAY_OWNER_CONCEPT.md §11. The point of a controller that guarantees
   the visual state is being able to PROVE it does.

     If something changes on screen it either came through the Marshal or it did
     not, and Trace says which.

   Two halves, with different costs and therefore different lifetimes:

   1. The SIGNAL LOG is always on. It is a handful of objects per minute, and it
      is what makes a round replayable — every Scene comes from a Signal and the
      Marshal holds no hidden state, so the signal list reproduces the round
      exactly. An oddity on the 9th becomes a file you can step through instead
      of a story you half remember.

   2. The WRITE HOOKS are debug-only (?trace=1, or the stored setting). They
      shadow the watched elements so a write can be attributed the instant it
      happens.

   Why hooks and not a MutationObserver on its own: the observer tells you an
   element changed but not WHO changed it, because it runs a microtask later
   with the stack long gone. Who is the only part you actually need. Shadowing
   is per-instance (Object.defineProperty on the element, a Proxy for classList
   and style) so no prototype is touched and nothing leaks into normal use. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var SETTING_KEY = "clarity:trace:v1";
  var MAX_ROWS = 400;      // what the window shows
  var MAX_SIGNALS = 2000;  // what a replay needs; ~4 hours of play

  /* The Watch: the elements the Marshal guarantees. This list IS the contract,
     written down. Leaflet's tiles and panes are deliberately outside it, so its
     constant churn is not noise in the log. */
  var WATCH = [
    "gpsDot", "aimBubble", "bubbleSvg", "greenRing", "pinMarker", "pinDistance",
    "greenFocusBall", "greenFocusHint", "distanceBar", "shotActionBtn",
    "startPill", "map", "surfaceImage", "playerBadge", "playButton", "loggedScreen",
    "finishControl", "holeCompleteControl", "holeCompleteScreen", "queuedCard"
  ];

  var rows = [];       // newest first
  var signals = [];    // oldest first — replay order
  var leakCount = 0;
  var listeners = [];

  var painting = null;   // the Signal currently being painted, or null
  var instrumented = false;
  var enabled = false;

  function readSetting() {
    try {
      if (/[?&]trace=1/.test(window.location.search)) return true;
      if (/[?&]trace=0/.test(window.location.search)) return false;
      return localStorage.getItem(SETTING_KEY) === "1";
    } catch (e) { return false; }
  }

  function stamp() {
    var d = new Date();
    return d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");
  }

  function push(row) {
    row.at = stamp();
    rows.unshift(row);
    if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
    if (row.kind === "leak") leakCount += 1;
    render();
    listeners.forEach(function (fn) { try { fn(row); } catch (e) {} });
  }

  /* The first stack frame that is not Trace's own — the code that actually did
     it. Without this a leak reads "something changed body.class", which is the
     half of the answer you already had. */
  function culprit() {
    var stack = "";
    try { stack = new Error().stack || ""; } catch (e) { return "unknown"; }
    var lines = stack.split("\n").slice(1);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/trace\.js/.test(line)) continue;
      var match = line.match(/([\w.-]+\.js):(\d+):(\d+)/);
      if (match) return match[1] + ":" + match[2];
      if (line.trim()) return line.trim().slice(0, 60);
    }
    return "unknown";
  }

  /* Every write to a watched element lands here. Inside a paint window it is an
     Order, carrying the Signal that caused it. Outside one it is a Leak — a
     system acting on its own, which is not automatically a bug and is never
     thrown for, but is visible the moment it appears rather than three weeks
     later as a symptom nobody can place. */
  function record(target, field, value) {
    if (painting) {
      push({ kind: "order", target: target, field: field, signal: painting.cause,
        mode: painting.mode, value: brief(value) });
    } else {
      push({ kind: "leak", target: target, field: field, from: culprit(), value: brief(value) });
    }
  }

  function brief(value) {
    if (value == null) return "";
    var text = typeof value === "string" ? value : String(value);
    return text.length > 40 ? text.slice(0, 37) + "…" : text;
  }

  // ------------------------------------------------------------ the hooks

  function shadowClassList(el, name) {
    var real = el.classList;
    var proxy = new Proxy(real, {
      get: function (target, key) {
        var value = target[key];
        if (typeof value !== "function") return value;
        if (key === "add" || key === "remove" || key === "toggle" || key === "replace") {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            var before = target.value;
            var result = value.apply(target, args);
            /* Only record when it actually changed something. A toggle that
               re-asserts the current state is not a visual change and should not
               fill the log with rows that describe nothing. */
            if (target.value !== before) record(name, "class." + key, args.join(" "));
            return result;
          };
        }
        return value.bind(target);
      }
    });
    Object.defineProperty(el, "classList", { get: function () { return proxy; }, configurable: true });
  }

  function shadowStyle(el, name) {
    var real = el.style;
    var proxy = new Proxy(real, {
      get: function (target, key) {
        var value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
      set: function (target, key, value) {
        if (target[key] !== value) record(name, "style." + String(key), value);
        target[key] = value;
        return true;
      }
    });
    Object.defineProperty(el, "style", { get: function () { return proxy; }, configurable: true });
  }

  function shadowProperty(el, name, proto, key) {
    var desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc || !desc.set) return;
    Object.defineProperty(el, key, {
      configurable: true,
      get: function () { return desc.get.call(el); },
      set: function (value) {
        if (desc.get.call(el) !== value) record(name, key, typeof value === "string" ? value.length + " chars" : value);
        desc.set.call(el, value);
      }
    });
  }

  function instrument() {
    if (instrumented) return false;
    instrumented = true;
    WATCH.concat(["__body"]).forEach(function (name) {
      var el = name === "__body" ? document.body : document.getElementById(name);
      if (!el) return;
      var label = name === "__body" ? "body" : name;
      try {
        shadowClassList(el, label);
        shadowStyle(el, label);
        shadowProperty(el, label, Element.prototype, "innerHTML");
        shadowProperty(el, label, Node.prototype, "textContent");
        var realSetAttribute = el.setAttribute.bind(el);
        el.setAttribute = function (key, value) {
          if (el.getAttribute(key) !== String(value)) record(label, "attr." + key, value);
          return realSetAttribute(key, value);
        };
      } catch (e) {}
    });
    return true;
  }

  // ------------------------------------------------------------------- api

  app.trace = {
    /* Called by the Marshal for every signal, changed or not. An accepted signal
       that changed nothing gets a row of its own — "I pressed it and nothing
       happened" is invisible in every other kind of logging and is usually the
       confusing case. */
    signal: function (name, payload, info) {
      info = info || {};
      signals.push({ t: Date.now(), name: name, payload: payload || null });
      if (signals.length > MAX_SIGNALS) signals.shift();

      if (info.known === false) {
        push({ kind: "inert", signal: name, note: "unknown signal" });
        return;
      }
      if (info.before && info.after && info.before.flow !== info.after.flow) {
        push({ kind: "flow", signal: name, from: info.before.flow, to: info.after.flow });
      }
      if (!info.changed) {
        push({ kind: "inert", signal: name, mode: info.before && info.before.mode,
          note: name === "FIX_LOST" ? "no flow change" : "ignored, no change" });
      }
    },

    error: function (name, err) {
      push({ kind: "leak", target: "—", field: "threw in " + name,
        from: (err && err.message) || String(err) });
    },

    /* The Painter wraps its work in this. Everything written to a watched
       element inside the callback is an Order attributed to `cause`; anything
       written outside one is a Leak. That is the whole mechanism. */
    paint: function (cause, mode, fn) {
      var previous = painting;
      painting = { cause: cause, mode: mode };
      try { return fn(); }
      finally { painting = previous; }
    },

    /* Replay: the signal list reproduces the round exactly, because every Scene
       comes from a Signal and the Marshal holds nothing hidden. Feed this back
       through marshal.signal() in order and you get the identical sequence. */
    exportLog: function () {
      return JSON.stringify({
        version: 1,
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        leaks: rows.filter(function (r) { return r.kind === "leak"; }),
        signals: signals
      }, null, 2);
    },

    rows: function () { return rows.slice(); },
    leaks: function () { return leakCount; },
    onRow: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    enabled: function () { return enabled; },

    enable: function () {
      enabled = true;
      try { localStorage.setItem(SETTING_KEY, "1"); } catch (e) {}
      instrument();
      buildWindow();
      render();
      return true;
    },
    disable: function () {
      enabled = false;
      try { localStorage.removeItem(SETTING_KEY); } catch (e) {}
      /* The shadows stay: undoing them mid-session would leave half the round
         instrumented and half not, which is worse than a little overhead. The
         window goes away and the next load starts clean. */
      var panel = document.getElementById("tracePanel");
      if (panel) panel.classList.add("hiddenState");
      return true;
    },
    toggle: function () { return enabled ? this.disable() : this.enable(); }
  };

  // ---------------------------------------------------------------- window

  var panel = null, list = null, count = null;

  function buildWindow() {
    if (panel || !document.body) return;
    panel = document.createElement("div");
    panel.id = "tracePanel";
    panel.innerHTML =
      '<div id="traceHead">'
      + '<strong>TRACE</strong>'
      + '<span id="traceCount"></span>'
      + '<button id="traceCopy" type="button">Copy log</button>'
      + '<button id="traceClose" type="button">&times;</button>'
      + "</div>"
      + '<div id="traceList"></div>';
    document.body.appendChild(panel);
    list = panel.querySelector("#traceList");
    count = panel.querySelector("#traceCount");
    panel.querySelector("#traceClose").addEventListener("click", function (e) {
      e.stopPropagation();
      app.trace.disable();
    });
    /* Tap the header to open the log. Collapsed it is one strip carrying the
       leak count; expanded it covers the play controls, which is fine when you
       are reading it and not fine the rest of the time. */
    panel.querySelector("#traceHead").addEventListener("click", function () {
      panel.classList.toggle("expanded");
      render();
    });
    panel.querySelector("#traceCopy").addEventListener("click", function (e) {
      e.stopPropagation();
      var text = app.trace.exportLog();
      try { navigator.clipboard.writeText(text); } catch (e) {}
      var blob = new Blob([text], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "clarity-trace-" + Date.now() + ".json";
      a.click();
    });
  }

  var ICON = { order: "✓", leak: "⚠", flow: "⇄", inert: "·" };

  function rowText(row) {
    if (row.kind === "order") {
      return { head: row.mode || "", body: row.target + "." + row.field, foot: "← " + row.signal };
    }
    if (row.kind === "leak") {
      return { head: "LEAK", body: row.target + "." + row.field, foot: "← " + row.from };
    }
    if (row.kind === "flow") {
      return { head: "FLOW", body: row.from + " → " + row.to, foot: "← " + row.signal };
    }
    return { head: row.mode || "", body: row.signal, foot: row.note };
  }

  var pending = false;
  function render() {
    if (!enabled || !list || pending) return;
    if (panel && !panel.classList.contains("expanded")) {
      /* Collapsed: keep the count live, skip the row work entirely. */
      if (count) {
        count.textContent = leakCount ? leakCount + (leakCount === 1 ? " leak" : " leaks") : "clean";
        count.className = leakCount ? "traceLeaky" : "";
      }
      return;
    }
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (!list) return;
      count.textContent = leakCount ? leakCount + (leakCount === 1 ? " leak" : " leaks") : "clean";
      count.className = leakCount ? "traceLeaky" : "";
      list.innerHTML = rows.slice(0, 120).map(function (row) {
        var text = rowText(row);
        return '<div class="traceRow trace-' + row.kind + '">'
          + '<span class="traceAt">' + row.at + "</span>"
          + '<span class="traceIcon">' + ICON[row.kind] + "</span>"
          + '<span class="traceHeadCol">' + escape(text.head) + "</span>"
          + '<span class="traceBody">' + escape(text.body) + "</span>"
          + '<span class="traceFoot">' + escape(text.foot) + "</span>"
          + "</div>";
      }).join("");
    });
  }

  function escape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* Instrument as early as the elements exist, so a leak during boot is caught
     like any other. The signal log runs regardless of the setting — that is what
     makes an unplanned on-course capture possible. */
  document.addEventListener("DOMContentLoaded", function () {
    if (!readSetting()) return;
    app.trace.enable();
  });
})();
