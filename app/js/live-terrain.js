/* Clarity 3D Mesh on the live map - TEST PATH, admin only.

   A hole with no published surface plays on the Leaflet map: tiles, plus the hillshade layer.
   This builds one temporary picture of the hole instead - a single Mapbox raster and the DEM
   resampled onto exactly the same ground (/api/live-terrain-frame) - and hands painter.js the
   pair in the shape of a published surface's metadata. From there nothing is new: the published
   path frames it (stageFrameTransform), stands it up (gd-terrain-mesh.js), lifts the overlays
   onto it and grounds taps from it. One camera, one mesh, one projector.

   What this file owns is only the part the published path never needed:
     - whether the mode is on at all (wanted)
     - which rectangle of ground covers the hole (frameWindow)
     - fetching the two layers and proving they are the window that was asked for (load)
     - letting go of them (release)
   Nothing is stored or published. The two images live as object URLs for as long as the hole
   is on screen and are revoked when it is not. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.liveTerrain = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var TILE = 256;
  /* Kept in step with functions/lib/gd-live-terrain-core.mjs. */
  var MIN_Z = 14, MAX_Z = 18, MAX_SIDE = 2048;
  /* Ground around the hole. The lock view looks well past the target and the tilt pulls the
     far ground onto the screen, so a hole needs a generous apron - a third of its length, and
     never less than a short pitch either side. */
  var PAD_FRACTION = 0.33, PAD_MIN_M = 90;

  /* The whole activation rule, in one place so a test can pin it. */
  function wanted(ctx) {
    if (!ctx) return false;
    return ctx.override === "mesh" && ctx.admin === true && Number(ctx.relief) > 0 && ctx.webgl === true;
  }

  function worldPx(lat, lng, z) {
    var scale = TILE * Math.pow(2, z);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
  }

  function latAt(py, z) {
    var n = Math.PI * (1 - (2 * py) / (TILE * Math.pow(2, z)));
    return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  }

  function metresPerPx(lat, z) {
    return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
  }

  function valid(p) { return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)); }

  /* The rectangle of web-mercator pixels the hole is pictured in: every known point of the
     hole plus the apron, at the finest zoom that keeps it inside the size limit. Depends on the
     hole only - never on the camera, the player or the aim - so a round re-uses it for every
     stage and every fix, and only a different hole asks for a new one. Null without a tee and
     a green. */
  function frameWindow(hole) {
    if (!hole || !valid(hole.tee) || !valid(hole.green)) return null;
    var pts = [hole.tee, hole.green].concat(hole.route || [], hole.greenShape || []).filter(valid);
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    pts.forEach(function (p) {
      minLat = Math.min(minLat, Number(p.lat)); maxLat = Math.max(maxLat, Number(p.lat));
      minLng = Math.min(minLng, Number(p.lng)); maxLng = Math.max(maxLng, Number(p.lng));
    });
    var midLat = (minLat + maxLat) / 2;
    var ref = 20;
    var a = worldPx(maxLat, minLng, ref), b = worldPx(minLat, maxLng, ref);
    var t = worldPx(hole.tee.lat, hole.tee.lng, ref), g = worldPx(hole.green.lat, hole.green.lng, ref);
    var lengthM = Math.hypot(g.x - t.x, g.y - t.y) * metresPerPx(midLat, ref);
    var padPx = Math.max(PAD_MIN_M, lengthM * PAD_FRACTION) / metresPerPx(midLat, ref);
    var x0 = a.x - padPx, y0 = a.y - padPx, x1 = b.x + padPx, y1 = b.y + padPx;
    for (var z = MAX_Z; z >= MIN_Z; z--) {
      var k = Math.pow(2, ref - z);
      var x = Math.floor(x0 / k), y = Math.floor(y0 / k);
      var w = Math.ceil(x1 / k) - x, h = Math.ceil(y1 / k) - y;
      if (w <= MAX_SIDE && h <= MAX_SIDE) return { z: z, x: x, y: y, w: w, h: h };
    }
    return null;
  }

  function windowKey(courseKey, holeNumber, win) {
    return [courseKey || "", holeNumber, win.z, win.x, win.y, win.w, win.h].join("|");
  }

  function windowMetres(win) {
    var lat = (latAt(win.y, win.z) + latAt(win.y + win.h, win.z)) / 2;
    var mpp = metresPerPx(lat, win.z);
    return { width: mpp * win.w, height: mpp * win.h };
  }

  /* The published playSurface shape (play-surface.js projectToSurface, painter attachMesh),
     filled from the window and the elevation answer. liveTerrain marks it as a test frame, so
     the painter can light it for a photo with no relief baked in and never mistake it for a
     published bake. */
  function surfaceMeta(win, elevation) {
    var metres = windowMetres(win);
    return {
      liveTerrain: true,
      captureZoom: win.z,
      originPx: { x: win.x, y: win.y },
      outputDimensions: { width: win.w, height: win.h },
      elevation: {
        url: elevation.url,
        encoding: "terrain-rgb",
        width: elevation.width,
        height: elevation.height,
        metresPerPixel: metres.width / elevation.width,
        elevationRange: { min: elevation.min, max: elevation.max }
      }
    };
  }

  function header(res, name) {
    try { return res.headers.get(name); } catch (e) { return null; }
  }

  /* Both layers for a window, or a rejection whose message is the fallback reason the admin
     sees. deps: { fetch, apiUrl(path), token() -> Promise<string>, createObjectURL(blob),
     revokeObjectURL(url) }.

     "Alignment cannot be proven" is a failure like any other: each answer must echo the exact
     window asked for, and the elevation must say how big its grid is - the mesh would draw
     whatever it was given and has no way to notice the two do not agree. */
  function load(win, deps) {
    var query = "&z=" + win.z + "&x=" + win.x + "&y=" + win.y + "&w=" + win.w + "&h=" + win.h;
    var expect = [win.z, win.x, win.y, win.w, win.h].join("/");
    var made = [];
    function revokeAll() { made.forEach(function (u) { try { deps.revokeObjectURL(u); } catch (e) {} }); }
    return Promise.resolve(deps.token ? deps.token() : "").then(function (token) {
      var headers = token ? { Authorization: "Bearer " + token } : {};
      function get(layer) {
        return deps.fetch(deps.apiUrl("/api/live-terrain-frame?layer=" + layer + query), { headers: headers })
          .then(function (res) {
            if (!res || !res.ok) {
              return (res && res.json ? res.json().catch(function () { return null; }) : Promise.resolve(null))
                .then(function (body) {
                  throw new Error(layer + " " + (res ? res.status : "no answer") + (body && body.error ? ": " + body.error : ""));
                });
            }
            if (header(res, "X-Window") !== expect) throw new Error(layer + " answered for a different window");
            return res.blob().then(function (blob) { return { res: res, blob: blob }; });
          }, function (e) { throw new Error(layer + " request failed: " + ((e && e.message) || e)); });
      }
      return Promise.all([get("aerial"), get("elevation")]);
    }).then(function (both) {
      var aerial = both[0], elevation = both[1];
      var size = String(header(elevation.res, "X-Elevation-Size") || "").split("x").map(Number);
      var min = Number(header(elevation.res, "X-Elevation-Min")), max = Number(header(elevation.res, "X-Elevation-Max"));
      if (!(size[0] > 1 && size[1] > 1) || !Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error("elevation answer is missing its size or range");
      }
      var aerialUrl = deps.createObjectURL(aerial.blob); made.push(aerialUrl);
      var elevationUrl = deps.createObjectURL(elevation.blob); made.push(elevationUrl);
      var meta = surfaceMeta(win, { url: elevationUrl, width: size[0], height: size[1], min: min, max: max });
      var metres = windowMetres(win);
      var credit = "";
      try { credit = decodeURIComponent(header(elevation.res, "X-Elevation-Credit") || ""); } catch (e) { credit = ""; }
      return {
        urls: made.slice(),
        asset: { live: true, url: aerialUrl, playSurface: meta },
        debug: {
          imagery: header(aerial.res, "X-Live-Imagery") || "mapbox.satellite",
          elevation: header(elevation.res, "X-Elevation-Source") || "?",
          elevationCredit: credit,
          demZoom: Number(header(elevation.res, "X-Elevation-Zoom")) || null,
          window: win,
          rasterPx: win.w + "x" + win.h,
          demPx: size[0] + "x" + size[1],
          metres: Math.round(metres.width) + "x" + Math.round(metres.height) + "m",
          elevationRange: min.toFixed(1) + ".." + max.toFixed(1) + "m"
        }
      };
    }).catch(function (e) {
      revokeAll();
      throw e;
    });
  }

  /* One frame is held at a time; this is how the previous one goes. */
  function release(entry, revokeObjectURL) {
    if (!entry || !entry.urls) return;
    entry.urls.forEach(function (u) { try { revokeObjectURL(u); } catch (e) {} });
    entry.urls = [];
  }

  /* The admin's one-line readout, drawn where a published hole shows its bake stamp. */
  function debugLabel(debug, exaggeration) {
    if (!debug) return "";
    return ["3D mesh", "Mapbox z" + debug.window.z + " " + debug.rasterPx,
      "DEM " + debug.elevation + (debug.demZoom ? " z" + debug.demZoom : "") + " " + debug.demPx,
      debug.metres, debug.elevationRange, exaggeration + "x",
      debug.rebuild || "", debug.loadMs != null ? debug.loadMs + "ms" : ""].filter(Boolean).join(" · ");
  }

  return {
    wanted: wanted,
    frameWindow: frameWindow,
    windowKey: windowKey,
    windowMetres: windowMetres,
    surfaceMeta: surfaceMeta,
    load: load,
    release: release,
    debugLabel: debugLabel
  };
});
