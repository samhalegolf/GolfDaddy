/* Clarity Studio — Map Viewport. Studio-only, view-only.
 *
 * What it is for: seeing the ground the mapper sees, and moving around on it. Nothing here
 * writes anything - no pin, no package, no scan, no course record. It is a window.
 *
 * Three things it deliberately does NOT own:
 *
 *   1. The course list. Establishing the first view goes through the REAL course picker
 *      (scripts/inline/gd-course-picker-search-v2.js) in its pick-only mode, so search,
 *      nearby and the database list behave exactly as they do for a player. A private
 *      "admin course search" would be a second list to keep true, and the first time it
 *      disagreed with the real one it would send someone chasing a bug in the wrong place.
 *
 *   2. The provider list. It draws scripts/gd-app-core.js's own mapSources through
 *      window.GDMapSources - the same entries, bboxes, keys and zoom ceilings a course
 *      plays over. Those are LIVE display sources; several of them (Esri, Queensland) are
 *      licensed for display and not for storage, which is exactly why they may appear here
 *      and must never appear in functions/lib/gd-imagery-sources.mjs.
 *
 *   3. What the scanner would use. That comes from /api/imagery-source, which reads the
 *      scan registry server-side. "Scanner view" then points the map at the live twin of
 *      that source and drops to its zoom ceiling, so what you are looking at is the
 *      resolution a stored frame would actually carry rather than an upscale of it.
 */
(function () {
  "use strict";

  /* Survives leaving and re-entering the page - the shell tears the DOM down on every route
     change, and re-picking the course you were just looking at is pure friction. */
  var session = { course: null, scan: null, scanError: "", view: null, sourceKey: "" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : null; }
  function sourcesApi() { return window.GDMapSources || null; }
  function liveSources() {
    var api = sourcesApi();
    return api && Array.isArray(api.list) ? api.list : [];
  }

  /* Registry keys are "<programme>-<country>" (linz-nz, naip-us, pdok-nl); the live list is
     keyed on the programme half (linz, naip, pdok). That is the whole mapping, and it is a
     lookup rather than a rule: an unmatched scan source - Japan's GSI, say, which has no live
     entry - returns "" and the caller falls back to whatever covers the view. */
  function liveKeyForScan(scanKey) {
    var head = String(scanKey || "").split("-")[0];
    var match = liveSources().filter(function (s) { return s.key === head; })[0];
    return match ? match.key : "";
  }

  function render(containerEl) {
    var mapObj = null;
    var layer = null;
    var marker = null;
    var pickerWatch = null;
    var pickerTimer = null;
    var destroyed = false;

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px">' +
      "<p>View only — nothing on this page writes a pin, a package or a scan. Pick a course " +
      "with the real course picker to set the first view, then pan, zoom and switch providers. " +
      "<strong>Scanner view</strong> snaps to the live twin of whatever source the scan registry " +
      "resolves here, at the zoom that source actually resolves.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-viewport="pick">Pick course</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-gd-viewport="scanner">Scanner view</button>' +
      '<label class="gdStudioViewportField">Provider <select data-gd-viewport="provider"></select></label>' +
      '<span class="gdStudioViewportCourse" data-gd-viewport="course">No course picked</span>' +
      "</div>" +
      '<div class="gdStudioViewportMap" data-gd-viewport="map"></div>' +
      '<div class="gdStudioViewportReadout" data-gd-viewport="readout"></div>' +
      '<div class="gdStudioViewportCredit" data-gd-viewport="credit"></div>' +
      '<div class="gdStudioViewportScan" data-gd-viewport="scan"></div>';

    var el = {};
    ["pick", "scanner", "provider", "course", "map", "readout", "credit", "scan"].forEach(function (name) {
      el[name] = containerEl.querySelector('[data-gd-viewport="' + name + '"]');
    });

    if (typeof window.L === "undefined" || !sourcesApi()) {
      el.map.innerHTML = '<p class="gdStudioMuted" style="padding:16px">Leaflet or the map source list did not load on this surface.</p>';
      return null;
    }

    /* ---- provider handling ---- */

    /* Why a source cannot draw where we are looking. Two different answers with two different
       fixes - a missing key is a deploy problem, no coverage is geography - so they are never
       collapsed into one "unavailable". */
    function availability(source, centre) {
      var api = sourcesApi();
      if (source.requiresKey && !api.keyValue(source.requiresKey)) return "no key";
      if (!api.covers(source, centre)) return "no coverage here";
      return "";
    }

    function centre() {
      try { return mapObj ? mapObj.getCenter() : null; } catch (e) { return null; }
    }

    /* Rebuilt only when a LABEL would change, not on every pan. The labels carry each
       provider's availability at the current centre, which only flips when the view crosses a
       coverage edge - and blowing away the select's DOM under someone who has it open is a
       real annoyance to pay for a string that usually did not move. */
    var providerSignature = "";
    function buildProviderOptions() {
      var here = centre();
      var rows = liveSources().map(function (s) {
        var why = availability(s, here);
        return { key: s.key, text: s.name + (why ? " — " + why : "") };
      });
      var signature = rows.map(function (r) { return r.key + "|" + r.text; }).join("\n");
      if (signature === providerSignature) return;
      providerSignature = signature;
      var current = el.provider.value || session.sourceKey;
      el.provider.innerHTML = rows.map(function (r) {
        return '<option value="' + esc(r.key) + '">' + esc(r.text) + "</option>";
      }).join("");
      if (current) el.provider.value = current;
    }

    function sourceByKey(key) {
      return liveSources().filter(function (s) { return s.key === key; })[0] || null;
    }

    /* Every source stays selectable even where it has nothing to draw - this is a viewport
       whose job is to show what a provider does and does not have, and hiding the empty ones
       would hide the answer. The label says so, and the readout says so again after the swap. */
    function useSource(key, reason) {
      var source = sourceByKey(key) || liveSources()[0];
      if (!source) return;
      session.sourceKey = source.key;
      el.provider.value = source.key;
      if (layer) { try { mapObj.removeLayer(layer); } catch (e) {} }
      layer = sourcesApi().buildLayer(source);
      layer.addTo(mapObj);
      var maxZoom = num(source.options && source.options.maxZoom) || 21;
      try { mapObj.setMaxZoom(maxZoom); } catch (e) {}
      el.credit.innerHTML = esc(source.label) + (source.attribution ? " — " + esc(source.attribution) : "");
      updateReadout(reason);
    }

    /* First covering source in list order - the same preference the app applies, regional
       aerial before the global fallback. */
    function bestSourceKey() {
      var here = centre();
      var api = sourcesApi();
      var found = liveSources().filter(function (s) { return api.ready(s, here); })[0];
      return found ? found.key : (liveSources()[0] || {}).key || "";
    }

    /* ---- readouts ---- */

    function updateReadout(reason) {
      if (destroyed || !mapObj) return;
      var here = centre();
      var zoom = mapObj.getZoom();
      var source = sourceByKey(session.sourceKey);
      var why = source && here ? availability(source, here) : "";
      var native = source ? (num(source.options && source.options.maxNativeZoom) || null) : null;
      var bits = [];
      if (here) bits.push("centre " + here.lat.toFixed(6) + ", " + here.lng.toFixed(6));
      bits.push("z" + zoom);
      if (source) bits.push(source.name + (why ? " (" + why + ")" : ""));
      if (native && zoom > native) bits.push("above this provider's native z" + native + " — upscaled");
      if (reason) bits.push(reason);
      el.readout.textContent = bits.join(" · ");
      session.view = here ? { lat: here.lat, lng: here.lng, zoom: zoom } : session.view;
    }

    function renderScanPanel() {
      if (session.scanError) {
        el.scan.innerHTML = '<span class="gdStudioWarnText">Scan source unknown — ' + esc(session.scanError) + "</span>";
        return;
      }
      var scan = session.scan;
      if (!scan) { el.scan.textContent = ""; return; }
      if (!scan.scannable) {
        el.scan.innerHTML = '<span class="gdStudioWarnText">No scan source here — ' + esc(scan.reason || "unknown") +
          ". The course still plays over live tiles; it just gets no stored frames.</span>";
        return;
      }
      var s = scan.source || {};
      var live = liveKeyForScan(s.key);
      var zoom = mapObj ? mapObj.getZoom() : 0;
      var ceiling = num(s.maxUsefulZoom);
      var over = ceiling && zoom > ceiling;
      el.scan.innerHTML =
        "Scan source: <strong>" + esc(s.label || s.key) + "</strong> (" + esc(s.key) + ")" +
        (ceiling ? " · resolves to z" + ceiling : "") +
        (s.minTrustedZoom ? " · trusted from z" + s.minTrustedZoom : "") +
        (s.license && s.license.name ? " · " + esc(s.license.name) : "") +
        (s.hasElevation ? " · has elevation" : " · no elevation") +
        (live ? "" : ' · <span class="gdStudioWarnText">no live twin in the app\'s provider list</span>') +
        (over ? ' · <span class="gdStudioWarnText">you are above z' + ceiling + " — a stored frame could not carry this detail</span>" : "");
    }

    function loadScanSource(lat, lng, autoView) {
      session.scan = null;
      session.scanError = "";
      el.scan.textContent = "Asking the scan registry what covers this…";
      fetch("/api/imagery-source?lat=" + encodeURIComponent(lat) + "&lng=" + encodeURIComponent(lng), { cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
        .then(function (body) {
          if (destroyed) return;
          session.scan = body;
          renderScanPanel();
          /* Auto-switch on arrival, but only for a FRESH course. The answer lands async, so on
             a page re-entry it would otherwise come back after the saved view was restored and
             yank the zoom back to the ceiling - throwing away the view someone deliberately
             left. A manual pick after this stands too: nothing re-runs it on pan. */
          if (autoView) scannerView({ silent: true });
        })
        .catch(function (error) {
          if (destroyed) return;
          session.scanError = (error && error.message) || "request failed";
          renderScanPanel();
        });
    }

    /* ---- actions ---- */

    function scannerView(opts) {
      var scan = session.scan;
      if (!scan || !scan.scannable) {
        if (!(opts && opts.silent)) updateReadout("no scan source here — provider left as is");
        return;
      }
      var s = scan.source || {};
      var live = liveKeyForScan(s.key);
      useSource(live || bestSourceKey(), live ? "scanner view" : "scanner view (no live twin — nearest covering provider)");
      var ceiling = num(s.maxUsefulZoom);
      if (ceiling) { try { mapObj.setZoom(Math.min(ceiling, mapObj.getMaxZoom())); } catch (e) {} }
      renderScanPanel();
    }

    function showCourse(course, opts) {
      var restoring = !!(opts && opts.restoring);
      session.course = course;
      var lat = num(course && (course.lat != null ? course.lat : course.latitude));
      var lng = num(course && (course.lng != null ? course.lng : course.longitude));
      el.course.textContent = String(course && (course.name || course.courseName) || "Course") +
        (lat != null && lng != null ? " · " + lat.toFixed(5) + ", " + lng.toFixed(5) : " · no coordinates");
      if (lat == null || lng == null) { el.scan.textContent = ""; return; }
      mapObj.setView([lat, lng], 17);
      if (marker) { try { mapObj.removeLayer(marker); } catch (e) {} }
      marker = L.circleMarker([lat, lng], {
        radius: 6, color: "#3cff8d", weight: 2, fillColor: "#3cff8d", fillOpacity: 0.35
      }).addTo(mapObj);
      useSource(bestSourceKey(), "course centre");
      loadScanSource(lat, lng, !restoring);
    }

    /* ---- the picker hand-off ----
       Studio is a fixed layer over the whole app, so handing over the real picker means
       stepping aside for it (GDStudioShell.hide) and coming back when it is done. "Done" has
       two shapes: a selection, which arrives on onPick, and a cancel, which does not - the
       picker's Back and Home buttons live in gd-app-core.js and simply hide #courseScreen.
       So the close is watched on the DOM rather than through a callback that only one of the
       two exits would ever fire. */
    function stopWatch() {
      if (pickerWatch) { try { pickerWatch.disconnect(); } catch (e) {} pickerWatch = null; }
      if (pickerTimer) { clearTimeout(pickerTimer); pickerTimer = null; }
    }

    function restoreStudio() {
      if (window.GDStudioShell) window.GDStudioShell.show();
      /* The map was laid out inside a hidden root; Leaflet has to be told the box is back. */
      setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 60);
    }

    function watchPicker() {
      stopWatch();
      var screen = document.getElementById("courseScreen");
      if (!screen) return;
      var seenOpen = false;
      pickerWatch = new MutationObserver(function () {
        var hidden = screen.classList.contains("hidden");
        if (!hidden) { seenOpen = true; return; }
        if (!seenOpen) return;
        stopWatch();
        restoreStudio();
      });
      pickerWatch.observe(screen, { attributes: true, attributeFilter: ["class"] });
      /* If the picker never actually opened, do not leave the operator staring at the app with
         no way back to Studio. */
      pickerTimer = setTimeout(function () {
        if (!seenOpen) { stopWatch(); restoreStudio(); }
      }, 4000);
    }

    function pickCourse() {
      if (!window.GDCoursePicker || typeof window.GDCoursePicker.open !== "function") {
        el.readout.textContent = "The course picker is not loaded on this surface.";
        return;
      }
      watchPicker();
      if (window.GDStudioShell) window.GDStudioShell.hide();
      window.GDCoursePicker.open({
        source: "studio-map-viewport",
        returnTarget: "home",
        onPick: function (course) {
          stopWatch();
          restoreStudio();
          if (!destroyed) showCourse(course);
        }
      });
    }

    /* ---- boot ---- */

    mapObj = L.map(el.map, {
      zoomControl: true,
      attributionControl: false,
      doubleClickZoom: true,
      scrollWheelZoom: true,
      /* 22 so a source's own maxZoom is what binds, not the map's. setMaxZoom follows the
         mounted layer in useSource. */
      maxZoom: 22
    }).setView([0, 0], 2);

    buildProviderOptions();
    useSource(session.sourceKey || bestSourceKey(), "");

    mapObj.on("moveend zoomend", function () {
      buildProviderOptions();
      updateReadout("");
      renderScanPanel();
    });

    el.pick.addEventListener("click", pickCourse);
    el.scanner.addEventListener("click", function () { scannerView({}); });
    el.provider.addEventListener("change", function () { useSource(el.provider.value, "manual"); });

    /* Re-entering the page: put back the course and the view rather than making someone
       search for the course they were looking at 10 seconds ago. */
    if (session.course) {
      var restoring = !!session.view;
      showCourse(session.course, { restoring: restoring });
      if (session.view) {
        try { mapObj.setView([session.view.lat, session.view.lng], session.view.zoom); } catch (e) {}
      }
    } else {
      updateReadout("pick a course to establish the first view");
    }
    setTimeout(function () { if (!destroyed && mapObj) { try { mapObj.invalidateSize(); } catch (e) {} } }, 80);

    return function cleanup() {
      destroyed = true;
      stopWatch();
      if (window.GDStudioShell) window.GDStudioShell.show();
      if (mapObj) { try { mapObj.remove(); } catch (e) {} }
      mapObj = null;
      layer = null;
      marker = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["map-viewport"] = render;

  /* The way in from somewhere else in Studio - Course Database's "Map viewport" button is the
     only caller today. It seeds the course and routes; the page's own render does the rest,
     so there is one code path for showing a course whether it came from the picker or from a
     database row. Takes any object carrying lat/lng and a name. */
  window.GDStudioMapViewport = {
    open: function (course) {
      session.course = course || null;
      session.scan = null;
      session.scanError = "";
      session.view = null;
      if (window.GDStudioRouter && typeof window.GDStudioRouter.go === "function") {
        return window.GDStudioRouter.go("map-viewport");
      }
      return false;
    }
  };
})();
