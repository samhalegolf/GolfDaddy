/* Wind: live first, and it stays on.

   LIVE wind is the normal case. It is read from Open-Meteo at the player's
   position once there is one, and then only refreshed now and then - when the
   reading is REFRESH_MS old, or the player has moved MOVE_REFRESH_M from where
   it was taken - never per shot and never per ghost bubble. The engine holds
   the current wind (setWind) and every ghost the painter draws is worked out
   from that one setting. Live wind is not bucketed into the three manual
   levels: the strength goes to the engine straight from the measured speed.

   MANUAL wind is the fallback, only while live wind cannot answer (offline,
   no position, a bad response). The top wind chip then opens the compass;
   once a direction is picked, taps cycle the level 1→2→3→off and a long press
   re-opens the compass. A live reading landing later replaces it.

   OFF: a tap on the chip while live wind is showing turns it off - no ghost,
   the chip goes back to its plain glyph. Readings keep being taken in the
   background (Course Data still wants the evidence) but are not drawn. The
   next tap turns it back on with a fresh check.

   Wind never touches the dispersion shape. The bubble stays on the aim and
   the wind is drawn as a ghost bubble where it would carry the ball - the
   Garmin watch's behaviour (GarminConditions.windEffect). Nothing persists
   past the page: a reading describes this round, not the next one.

   Rule 3 holds: no setInterval. Refreshes are asked for by boot.js on shot
   and hole changes (refreshIfStale) and by a tap on the chip. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var CALM_KMH = 5;                  // below this there is no wind to draw (Garmin's CALM_KMH)
  var KMH_PER_STRENGTH = 10;         // 10 km/h is strength 1, 30 km/h and up is 3
  var FETCH_TIMEOUT_MS = 6000;
  var REFRESH_MS = 10 * 60 * 1000;   // a live reading is good for ten minutes
  var MOVE_REFRESH_M = 1500;         // or until the player is this far from where it was taken
  var RETRY_MS = 2 * 60 * 1000;      // after a failed check, wait before asking again on its own
  var LONG_PRESS_MS = 520;

  var liveReading = null;    // the last measured wind, kept for Course Data too
  var manual = false;        // the engine's wind was dialled in by hand
  var off = false;           // the player turned live wind off with a tap
  var checking = false;
  var unavailable = false;   // the last live check failed - manual wind is on offer
  var lastAttemptAt = 0;

  var listeners = [];
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  function engine() { return window.GDBubbleEngine || null; }

  /* Measured speed to engine strength, or 0 for calm. Continuous: 18 km/h
     blows the ghost 1.8x as far as 10 km/h, not "level 2" like 13 km/h. */
  function strengthForSpeed(kmh) {
    var speed = Number(kmh);
    if (!Number.isFinite(speed) || speed < CALM_KMH) return 0;
    return Math.max(1, Math.min(3, speed / KMH_PER_STRENGTH));
  }

  function applyLive() {
    var eng = engine();
    if (!eng || !liveReading) return;
    if (off) { eng.clearWind(); manual = false; return; }
    var strength = strengthForSpeed(liveReading.speedKmh);
    if (strength > 0) eng.setWind(liveReading.directionDeg * Math.PI / 180, strength);
    else eng.clearWind();
    manual = false;
  }

  /* Captures the manual wind as it is now and pushes an undo entry that puts
     it back, so Back can step a manual change off. Live updates never push
     one: nothing was pressed. */
  function pushUndo() {
    if (!app.undo) return;
    var eng = engine();
    var prev = eng && eng.windState();
    var prevManual = manual;
    app.undo.push(function () {
      var e = engine();
      if (!e || (liveReading && !manual)) return;   // live has since taken over; there is no manual wind to restore
      if (prev && prevManual) e.setWind(prev.originAngle, prev.level); else e.clearWind();
      manual = prevManual && !!prev;
      notify();
    });
  }

  function openPicker() {
    var picker = document.getElementById("windPopover");
    if (picker) picker.classList.remove("hiddenState");
  }
  function closePicker() {
    var picker = document.getElementById("windPopover");
    if (picker) picker.classList.add("hiddenState");
  }
  function pickerStatus(key) {
    var status = document.getElementById("windAutoStatus");
    if (!status) return;
    if (key) { window.GDI18n.set(status, key); status.classList.remove("hiddenState"); }
    else status.classList.add("hiddenState");
  }

  /* Tap origin on the compass ring: angle from its centre to the tap point,
     0 = north (up), clockwise — matches gdWindPickDirection. */
  function pickDirection(event) {
    var compass = document.getElementById("windCompass");
    var eng = engine();
    if (!compass || !eng) return;
    var rect = compass.getBoundingClientRect();
    var dx = event.clientX - (rect.left + rect.width / 2), dy = event.clientY - (rect.top + rect.height / 2);
    var state = eng.windState();
    pushUndo();
    eng.setWind(Math.atan2(dx, -dy), manual && state ? Math.round(state.level) : 1);
    manual = true;
    closePicker();
    notify();
  }

  function clearManual() {
    var eng = engine();
    if (eng && manual && eng.windState()) { pushUndo(); eng.clearWind(); }
    manual = false;
    closePicker();
    notify();
  }

  /* The top chip. Live: a tap turns it off; off: a tap turns it back on and
     checks again. No live wind: try live first; if it cannot answer the
     compass opens. Manual wind set: taps cycle the level, 3 clears. */
  function press() {
    var eng = engine();
    if (!eng || checking) return;
    if (manual && eng.windState()) {
      var level = Math.round(eng.windState().level);
      pushUndo();
      if (level >= 3) { eng.clearWind(); manual = false; }
      else eng.setWind(eng.windState().originAngle, level + 1);
      notify();
      return;
    }
    if (liveReading && !off) {
      off = true;
      applyLive();
      notify();
      return;
    }
    if (off) {
      off = false;
      applyLive();
      notify();
    }
    fetchLiveWind({ fallbackToPicker: !liveReading });
  }

  function longPress() {
    if (liveReading) { fetchLiveWind(); return; }   // manual is only for when live cannot answer
    pickerStatus(null);
    openPicker();
  }

  function position(fallback) {
    var pos = app.marshal && app.marshal.player && app.marshal.player();
    pos = pos || fallback || null;
    return pos && Number.isFinite(Number(pos.lat)) && Number.isFinite(Number(pos.lng))
      ? { lat: Number(pos.lat), lng: Number(pos.lng) } : null;
  }

  /* Asked on every shot and hole change. Cheap when nothing is due: a clock
     read and one distance. */
  function refreshIfStale(near) {
    if (checking) return;
    var pos = position(near);
    if (!pos) return;
    var now = Date.now();
    if (liveReading) {
      var age = now - Date.parse(liveReading.capturedAt);
      var moved = app.distance ? app.distance.haversineMeters(pos, liveReading.at) : 0;
      if (!(age >= REFRESH_MS) && !(moved >= MOVE_REFRESH_M)) return;
    } else if (now - lastAttemptAt < RETRY_MS) {
      return;
    }
    fetchLiveWind({ near: pos });
  }

  /* Fail-open like every other fresh-app fetch: no position, a timeout or a
     bad response leaves the wind as it was. A failure with no live reading
     at all marks live as unavailable so the chip offers manual wind; with
     fallbackToPicker (a tap) the compass opens straight away. */
  async function fetchLiveWind(opts) {
    opts = opts || {};
    var pos = position(opts.near);
    if (!pos) {
      unavailable = !liveReading;
      if (opts.fallbackToPicker) { pickerStatus("wind.noPositionTap"); openPicker(); }
      else pickerStatus("wind.noPosition");
      notify();
      return;
    }
    if (opts.fromPicker) pickerStatus("wind.checking");
    checking = true;
    lastAttemptAt = Date.now();
    notify();
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
      /* Kept as measured. Course Data records evidence, not the display
         value derived from it. */
      liveReading = {
        speedKmh: speed,
        directionDeg: direction,
        level: strengthForSpeed(speed),
        source: "open-meteo",
        capturedAt: new Date().toISOString(),
        at: pos
      };
      unavailable = false;
      applyLive();
      pickerStatus(null);
      closePicker();
    } catch (e) {
      /* An older live reading stays in use - a missed refresh is not a reason
         to throw away the wind we have. */
      if (!liveReading) {
        unavailable = true;
        if (opts.fallbackToPicker) { pickerStatus("wind.unavailableTap"); openPicker(); }
        else pickerStatus("wind.unavailable");
      }
    } finally {
      if (timer) clearTimeout(timer);
      checking = false;
      notify();
    }
  }

  app.wind = {
    press: press, longPress: longPress, openPicker: openPicker,
    fetchLiveWind: fetchLiveWind, refreshIfStale: refreshIfStale,
    strengthForSpeed: strengthForSpeed,
    /* What the wind was measured to be, or null if it never was this round.
       Null is a real answer - "no live evidence" - and Course Data records it
       as such rather than substituting the player's setting. */
    liveReading: function () { return liveReading; },
    isLive: function () { return !!liveReading && !manual && !off; },
    isManual: function () { return manual && !!(engine() && engine().windState()); },
    /* A live check in flight - the chip's "…" state. */
    checking: function () { return checking; },
    /* The last live check failed and there is no reading to fall back on. */
    unavailable: function () { return unavailable && !liveReading; },
    /* What the player dialled in by hand, which is intent, not evidence.
       Null whenever the wind on screen is live. */
    selection: function () {
      var eng = engine();
      var state = manual && eng && eng.windState();
      return state ? { originAngleRad: state.originAngle, level: state.level } : null;
    },
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); }
  };

  document.addEventListener("DOMContentLoaded", function () {
    var compass = document.getElementById("windCompass");
    if (compass) compass.addEventListener("click", pickDirection);
    var clear = document.getElementById("windClear");
    if (clear) clear.addEventListener("click", clearManual);
    var auto = document.getElementById("windAuto");
    if (auto) auto.addEventListener("click", function () { if (!checking) fetchLiveWind({ fromPicker: true }); });

    /* Same split as the pin: the long press is timed off pointerdown, the
       short tap is the click, which every engine delivers. */
    var chip = document.getElementById("windChip");
    if (!chip) return;
    var pressTimer = null, longPressed = false;
    chip.addEventListener("pointerdown", function () {
      longPressed = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(function () { longPressed = true; longPress(); }, LONG_PRESS_MS);
    });
    chip.addEventListener("pointerup", function () { clearTimeout(pressTimer); });
    chip.addEventListener("pointercancel", function () { clearTimeout(pressTimer); });
    chip.addEventListener("click", function (e) {
      e.preventDefault();
      clearTimeout(pressTimer);
      if (longPressed) { longPressed = false; return; }
      press();
    });
  });
})();
