/* Wind: tap the rail icon to cycle level (calm→1→2→3→off), long-press to open
   a compass and set direction — same split as the legacy rail button
   (gdWindToolPressed / gdOpenWindPicker). Wind never touches the dispersion
   shape, only the display target the shot card/rings render against —
   entirely owned by GDBubbleEngine's setWind/clearWind/windState
   (see dev/generate-bubble-engine-client.js). No storage: wind resets with
   the shot like the legacy tool did, nothing persists across a hole. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var LEVEL3_KMH = 24, LEVEL2_KMH = 13;   // same thresholds as the legacy gdWindLevelForSpeed defaults
  var FETCH_TIMEOUT_MS = 6000;

  function engine() { return window.GDBubbleEngine || null; }

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
    icon.textContent = state ? String(state.level) : "";
    if (!state) icon.innerHTML = WIND_SVG;
    btn.setAttribute("aria-label", state ? "Wind " + state.level : "Wind");
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
    if (eng) eng.setWind(angle, 1);
    closePicker();
    syncIcon();
  }

  /* Short tap: cycles level 1→2→3→off if active, or arms the compass to pick
     a direction if wind hasn't been set yet — mirrors gdWindToolPressed. */
  function press() {
    var eng = engine();
    if (!eng) return;
    var state = eng.windState();
    if (!state) { openPicker(); return; }
    if (state.level >= 3) { eng.clearWind(); syncIcon(); return; }
    eng.setWind(state.originAngle, state.level + 1);
    syncIcon();
  }

  /* Live wind: the player's own position (the only location the fresh app
     reliably has — no course-centre/map-centre fallback chain like legacy's
     gdLiveWindLocation, since a hole with no position yet has nothing to ask
     Open-Meteo about). Fail-open like every other fresh-app fetch: no
     position, a timeout, or a bad response just leaves wind as it was. */
  async function fetchLiveWind() {
    var status = document.getElementById("windAutoStatus");
    var pos = app.position && app.position.current();
    if (!pos) {
      if (status) { status.textContent = "No position yet"; status.classList.remove("hiddenState"); }
      return;
    }
    if (status) { status.textContent = "Checking wind…"; status.classList.remove("hiddenState"); }
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
      if (eng) eng.setWind(direction * Math.PI / 180, level);
      closePicker();
      syncIcon();
    } catch (e) {
      if (status) { status.textContent = "Live wind unavailable"; status.classList.remove("hiddenState"); }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  app.wind = { press: press, openPicker: openPicker, syncIcon: syncIcon, fetchLiveWind: fetchLiveWind };

  document.addEventListener("DOMContentLoaded", function () {
    syncIcon();
    var compass = document.getElementById("windCompass");
    if (compass) compass.addEventListener("click", pickDirection);
    var clear = document.getElementById("windClear");
    if (clear) clear.addEventListener("click", function () {
      var eng = engine();
      if (eng) eng.clearWind();
      closePicker();
      syncIcon();
    });
    var auto = document.getElementById("windAuto");
    if (auto) auto.addEventListener("click", fetchLiveWind);
  });
})();
