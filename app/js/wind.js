/* Wind: tap the rail icon to turn wind ON — live wind first, no direction
   prompt when a reading is available (the level lands as 1/2/3 straight from
   the measured speed). Once on, taps cycle the level (1→2→3→off). The compass
   popover is the FALLBACK, not the front door: it opens when live wind cannot
   answer (offline, no position, bad response) and on long-press for a manual
   override — same long-press as the legacy rail button (gdOpenWindPicker).
   Wind never touches the dispersion shape, only the display target the shot
   card/rings render against — entirely owned by GDBubbleEngine's
   setWind/clearWind/windState (see dev/generate-bubble-engine-client.js).
   No storage, and wind is PER SHOT: boot.js calls reset() the moment the
   shot's start point changes, so every shot starts calm. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var LEVEL3_KMH = 24, LEVEL2_KMH = 13;   // same thresholds as the legacy gdWindLevelForSpeed defaults
  var FETCH_TIMEOUT_MS = 6000;
  var liveReading = null;   // last measured wind, for Course Data - see fetchLiveWind

  /* Whether the wind on screen came from a live reading rather than the
     player's own compass tap. Worth surfacing because the two look identical
     on the icon - both just show a level - and "is this measured or did I
     dial it in?" is the question a status dot exists to answer.

     Bumping the level with the rail button keeps it: the DIRECTION is still
     the measured one, and overriding the strength is exactly the manual
     override live wind is meant to allow. Picking a direction by hand, or
     clearing, drops it - at that point nothing measured is left. */
  var liveActive = false;

  /* A live fetch in flight from the rail tap. The banner shows it (painter
     drawWind), and a second tap while checking does nothing rather than
     stacking fetches. */
  var checking = false;

  /* The painter listens here so the bubble, the drift line and the wind
     banner move the moment wind changes — the same onChange seam pin.js and
     my-bubble.js already use. Without it a wind change only showed up when
     something else happened to repaint. */
  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function changed() { syncIcon(); notify(); }

  function engine() { return window.GDBubbleEngine || null; }

  /* Captures whatever the engine's wind state is right now and pushes an
     undo entry that puts it back - called just before every action below
     that changes it, so Back can step wind changes off one at a time. */
  function pushUndo() {
    if (!app.undo) return;
    var eng = engine();
    var prev = eng && eng.windState();
    var prevLive = liveActive;
    app.undo.push(function () {
      var e = engine();
      if (!e) return;
      if (prev) e.setWind(prev.originAngle, prev.level); else e.clearWind();
      liveActive = prevLive;
      changed();
    });
  }

  function levelForSpeed(kmh) {
    var speed = Number(kmh);
    if (!Number.isFinite(speed)) return 1;
    if (speed >= LEVEL3_KMH) return 3;
    if (speed >= LEVEL2_KMH) return 2;
    return 1;
  }

  /* Same inline glyph as the legacy rail button (gd-brand-icon-render.js
     WIND_SVG) — reused verbatim as markup, no new asset needed. */
  var WIND_SVG = '<svg aria-hidden="true" viewBox="0 0 48 48"><path d="M9 17h20c4.4 0 6.6-5.4 3.5-8.5-2.4-2.4-6.5-1.5-7.6 1.7" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M8 25h28c5.2 0 7.8 6.3 4.1 10-2.9 2.9-7.8 1.7-9.1-2.1" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M13 33h11" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>';

  function syncIcon() {
    var icon = document.getElementById("railWindIcon");
    var btn = document.getElementById("railWind");
    if (!icon || !btn) return;
    var eng = engine();
    var state = eng && eng.windState();
    btn.classList.toggle("active", !!state);
    btn.classList.toggle("live", !!state && liveActive);
    icon.textContent = state ? String(state.level) : "";
    if (!state) icon.innerHTML = WIND_SVG;
    btn.setAttribute("aria-label", state
      ? (liveActive ? "Live wind " + state.level : "Wind " + state.level)
      : "Wind");
  }

  function openPicker() {
    var picker = document.getElementById("windPopover");
    if (picker) picker.classList.remove("hiddenState");
    var status = document.getElementById("windAutoStatus");
    if (status) status.classList.add("hiddenState");
  }

  function closePicker() {
    var picker = document.getElementById("windPopover");
    if (picker) picker.classList.add("hiddenState");
  }

  /* The fallback path: live wind could not answer, so the compass takes the
     question, with the reason on its status line rather than a silent open. */
  function fallBackToPicker(message) {
    openPicker();
    var status = document.getElementById("windAutoStatus");
    if (status && message) {
      status.textContent = message;
      status.classList.remove("hiddenState");
    }
  }

  /* Tap origin on the compass ring: angle from its centre to the tap point,
     0 = north (up), clockwise — matches gdWindPickDirection. */
  function pickDirection(event) {
    var compass = document.getElementById("windCompass");
    if (!compass) return;
    var rect = compass.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var dx = event.clientX - cx, dy = event.clientY - cy;
    var angle = Math.atan2(dx, -dy);
    var eng = engine();
    if (eng) { pushUndo(); eng.setWind(angle, 1); liveActive = false; }
    closePicker();
    changed();
  }

  /* Short tap. Wind off: turn it ON — live first, so there is no direction
     prompt when a reading is available; the compass only appears when live
     wind cannot answer. Wind on: cycle the level 1→2→3→off, keeping the
     direction (measured or picked) as it is. */
  function press() {
    var eng = engine();
    if (!eng) return;
    var state = eng.windState();
    if (!state) {
      if (checking) return;   // a live check is already in flight
      fetchLiveWind({ fallbackToPicker: true });
      return;
    }
    pushUndo();
    if (state.level >= 3) { eng.clearWind(); liveActive = false; changed(); return; }
    eng.setWind(state.originAngle, state.level + 1);
    changed();
  }

  /* Wind is per shot. Called by boot.js whenever the shot's start point
     changes (a new lock, a new placement, unlock, a hole change) — the next
     shot starts calm, exactly like putting a fresh ball down. Deliberately
     no undo entry: nothing was pressed, so there is nothing Back should
     re-litigate. */
  function reset() {
    var eng = engine();
    var had = !!(eng && eng.windState());
    if (!had && !liveActive && !checking) return;
    if (eng) eng.clearWind();
    liveActive = false;
    checking = false;
    changed();
  }

  /* Live wind: the player's own position (the only location the fresh app
     reliably has — no course-centre/map-centre fallback chain like legacy's
     gdLiveWindLocation, since a hole with no position yet has nothing to ask
     Open-Meteo about). Fail-open like every other fresh-app fetch: no
     position, a timeout, or a bad response just leaves wind as it was —
     from the rail tap that means falling back to the compass, from the
     popover's own button it stays a status line. */
  async function fetchLiveWind(opts) {
    opts = opts || {};
    var status = document.getElementById("windAutoStatus");
    var pos = app.marshal && app.marshal.player();
    if (!pos) {
      if (opts.fallbackToPicker) { fallBackToPicker("No position yet — tap the wind origin"); return; }
      if (status) { status.textContent = "No position yet"; status.classList.remove("hiddenState"); }
      return;
    }
    if (!opts.fallbackToPicker && status) { status.textContent = "Checking wind…"; status.classList.remove("hiddenState"); }
    checking = true;
    notify();   // the banner shows the check, so a rail tap is never silent
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS) : null;
    try {
      var url = "https://api.open-meteo.com/v1/forecast?latitude=" + encodeURIComponent(pos.lat.toFixed(5))
        + "&longitude=" + encodeURIComponent(pos.lng.toFixed(5))
        + "&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timezone=auto";
      var res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store", signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error("wind fetch failed");
      var json = await res.json();
      var current = (json && json.current) || {};
      var speed = Number(current.wind_speed_10m), direction = Number(current.wind_direction_10m);
      if (!Number.isFinite(speed) || !Number.isFinite(direction)) throw new Error("wind data missing");
      var eng = engine();
      var level = levelForSpeed(speed);
      /* Kept as measured, before levelForSpeed buckets it. The engine only
         needs the level, but Course Data records evidence rather than the
         display value derived from it - and comparing what the wind actually
         was against what the player dialled in is the whole point of holding
         both. Not persisted: it describes this moment, not the round. */
      liveReading = {
        speedKmh: speed,
        directionDeg: direction,
        level: level,
        source: "open-meteo",
        capturedAt: new Date().toISOString(),
        at: { lat: pos.lat, lng: pos.lng }
      };
      if (eng) { pushUndo(); eng.setWind(direction * Math.PI / 180, level); liveActive = true; }
      /* The "Checking wind…" line has done its job; leaving it up made a
         reading that had already landed look like it was still in flight. */
      if (status) status.classList.add("hiddenState");
      closePicker();
      checking = false;
      changed();
    } catch (e) {
      checking = false;
      if (opts.fallbackToPicker) fallBackToPicker("Live wind unavailable — tap the wind origin");
      else if (status) { status.textContent = "Live wind unavailable"; status.classList.remove("hiddenState"); }
      notify();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  app.wind = {
    press: press, openPicker: openPicker, syncIcon: syncIcon, fetchLiveWind: fetchLiveWind,
    reset: reset,
    /* What the wind was measured to be, or null if it was never fetched this
       round. Null is a real answer - "no live evidence" - and Course Data
       records it as such rather than substituting the player's setting. */
    liveReading: function () { return liveReading; },
    /* Whether what is on the icon came from a live reading. */
    isLive: function () { return liveActive && !!(engine() && engine().windState()); },
    /* A rail-tap live check still in flight — the banner's "…" state. */
    checking: function () { return checking; },
    /* What the player dialled in, which is intent, not evidence. */
    selection: function () {
      var eng = engine();
      var state = eng && eng.windState();
      if (!state) return null;
      return { originAngleRad: state.originAngle, level: state.level };
    },
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); }
  };

  document.addEventListener("DOMContentLoaded", function () {
    syncIcon();
    var compass = document.getElementById("windCompass");
    if (compass) compass.addEventListener("click", pickDirection);
    var clear = document.getElementById("windClear");
    if (clear) clear.addEventListener("click", function () {
      var eng = engine();
      if (eng && eng.windState()) { pushUndo(); eng.clearWind(); }
      liveActive = false;
      closePicker();
      changed();
    });
    var auto = document.getElementById("windAuto");
    if (auto) auto.addEventListener("click", function () { fetchLiveWind(); });
  });
})();
