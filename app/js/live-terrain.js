/* Clarity 3D Mesh on the live map - the default for any hole with no published surface.

   A hole with no published surface used to play on the Leaflet map: tiles, plus the hillshade
   layer. This builds one temporary picture of the hole instead - Esri across the frame with
   Mapbox over the playing area (live-hybrid.js), and the DEM resampled onto exactly the same
   ground (/api/live-terrain-frame) - and hands painter.js the pair in the shape of a published
   surface's metadata. From there nothing is new: the published path frames it
   (stageFrameTransform), stands it up (gd-terrain-mesh.js), lifts the overlays onto it and
   grounds taps from it. One camera, one mesh, one projector.

   The fallbacks, cheapest first: Mapbox off (failed, refused, or over our daily limit) is the
   same mesh on Esri alone; no elevation is the same picture, flat; no Esri tiles, no WebGL or
   no signed-in player is the Leaflet live map, which never left.

   What this file owns is only the part the published path never needed:
     - whether the mode is on at all (wanted)
     - which rectangle of ground covers the hole (frameWindow)
     - putting the picture and the elevation together and proving they agree (load)
     - letting go of them (release)
   Nothing is stored or published. The images live as object URLs for as long as the hole is on
   screen and are revoked when it is not. */
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
  /* Past the green, for the tilted lock view: half the hole's length, at least 150m, opening
     out by 0.6 of that to each side. */
  var THROW_FRACTION = 0.5, THROW_MIN_M = 150, THROW_SPREAD = 0.6;

  /* The whole activation rule, in one place so a test can pin it. On for every signed-in
     player on the normal map source; the operator forcing Esri or Mapbox gets that flat live
     map to compare against. Signed in because the elevation endpoint is. */
  function wanted(ctx) {
    if (!ctx) return false;
    return ctx.override === "auto" && ctx.signedIn === true && Number(ctx.relief) > 0 && ctx.webgl === true;
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

  function lngAt(px, z) {
    return (px / (TILE * Math.pow(2, z))) * 360 - 180;
  }

  function metresPerPx(lat, z) {
    return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
  }

  function valid(p) { return p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)); }

  /* The rectangle of web-mercator pixels the hole is pictured in: every known point of the
     hole plus the apron, at the finest zoom that keeps it inside the size limit. Depends on the
     hole only - never on the camera, the player or the aim - so a round re-uses it for every
     stage and every fix, and only a different hole asks for a new one. Null without a tee and
     a green.

     The lock view is tilted, so the top of the screen looks well past the target: beyond the
     green and out to both sides of it. The frame reaches that far too (a "throw" past the green,
     widening as it goes), because ground outside the frame draws as a dark band. That ground is
     only ever Esri - the Mapbox mask stops at the playing area - so it costs no Mapbox. It is
     the first thing given up for resolution: the zoom is chosen for the hole and its apron, and
     the throw shrinks to fit that zoom rather than pushing the whole picture a zoom coarser. */
  function frameWindow(hole) {
    if (!hole || !valid(hole.tee) || !valid(hole.green)) return null;
    var pts = [hole.tee, hole.green].concat(hole.route || [], hole.greenShape || []).filter(valid);
    var ref = 20;
    var px = pts.map(function (p) { return worldPx(p.lat, p.lng, ref); });
    var midLat = pts.reduce(function (sum, p) { return sum + Number(p.lat); }, 0) / pts.length;
    var mpp = metresPerPx(midLat, ref);
    var t = worldPx(hole.tee.lat, hole.tee.lng, ref), g = worldPx(hole.green.lat, hole.green.lng, ref);
    var len = Math.hypot(g.x - t.x, g.y - t.y);
    var lengthM = len * mpp;
    var padPx = Math.max(PAD_MIN_M, lengthM * PAD_FRACTION) / mpp;
    var throwPx = Math.max(THROW_MIN_M, lengthM * THROW_FRACTION) / mpp;
    var ux = len > 0 ? (g.x - t.x) / len : 0, uy = len > 0 ? (g.y - t.y) / len : -1;

    function box(fraction) {
      var all = px.slice();
      if (fraction > 0) {
        var reach = throwPx * fraction, spread = reach * THROW_SPREAD;
        var far = { x: g.x + ux * reach, y: g.y + uy * reach };
        all.push(far, { x: far.x - uy * spread, y: far.y + ux * spread }, { x: far.x + uy * spread, y: far.y - ux * spread });
      }
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      all.forEach(function (p) { b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y); });
      return { x0: b.x0 - padPx, y0: b.y0 - padPx, x1: b.x1 + padPx, y1: b.y1 + padPx };
    }
    function at(b, z) {
      var k = Math.pow(2, ref - z);
      var x = Math.floor(b.x0 / k), y = Math.floor(b.y0 / k);
      var w = Math.ceil(b.x1 / k) - x, h = Math.ceil(b.y1 / k) - y;
      return w <= MAX_SIDE && h <= MAX_SIDE ? { z: z, x: x, y: y, w: w, h: h } : null;
    }
    var core = box(0);
    for (var z = MAX_Z; z >= MIN_Z; z--) {
      if (!at(core, z)) continue;
      for (var f = 1; f > 0; f -= 0.25) {
        var withThrow = at(box(f), z);
        if (withThrow) return withThrow;
      }
      return at(core, z);
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
    var meta = {
      liveTerrain: true,
      captureZoom: win.z,
      originPx: { x: win.x, y: win.y },
      outputDimensions: { width: win.w, height: win.h }
    };
    /* No elevation: a flat picture, which the published path presents without a mesh. */
    if (!elevation) return meta;
    meta.elevation = {
      url: elevation.url,
      encoding: "terrain-rgb",
      /* The ground the grid covers - the window itself. The green contour fit
         (gd-green-contours.js) places the green on the DEM through these. */
      bounds: { north: latAt(win.y, win.z), south: latAt(win.y + win.h, win.z),
        west: lngAt(win.x, win.z), east: lngAt(win.x + win.w, win.z) },
      width: elevation.width,
      height: elevation.height,
      metresPerPixel: metres.width / elevation.width,
      elevationRange: { min: elevation.min, max: elevation.max },
      /* The source's own spacing, before the resample onto this grid. */
      sourceMetresPerSample: elevation.sampleM || null,
      /* What the course's baked terrain asset says the ground is good for, when the frame was
         cut from one (functions/lib/terrain/gd-terrain-config.mjs terrainCapabilities). */
      terrain: elevation.greenDetail ? { greenDetail: elevation.greenDetail, qualityClass: elevation.qualityClass || null, version: elevation.terrainVersion || null } : null
    };
    return meta;
  }

  /* Whether this elevation can read a green. A green's shape lives in the metre or two between
     samples; the contour fit's own gate catches a mis-fit, but a 10-25m DEM resampled onto a
     fine grid can pass it while knowing nothing about the green, so terrain that knows it is
     that coarse draws no slope lines at all.

     The terrain asset's own verdict wins when the elevation carries one (every bake since
     terrain became a course asset, and live frames cut from one): "allowed" and "conditional"
     draw - conditional still has to pass the fit's measured gate - "coarse" and "none" do not.
     Otherwise the source spacing decides, with the same threshold the asset uses. Elevation
     that says neither (a bake older than both) is left to the fit's gate, as before. */
  var GREEN_MAX_SAMPLE_M = 2.5;
  function greenReadable(elevation) {
    var detail = elevation && elevation.terrain && elevation.terrain.greenDetail;
    if (detail) return detail === "allowed" || detail === "conditional";
    var m = Number(elevation && elevation.sourceMetresPerSample);
    return !(m > GREEN_MAX_SAMPLE_M);
  }

  function header(res, name) {
    try { return res.headers.get(name); } catch (e) { return null; }
  }

  /* The hole's surface: the hybrid picture (live-hybrid.js build) and the elevation from
     /api/live-terrain-frame, for one window. Rejects with the fallback reason when there is no
     picture at all. A missing elevation is not a rejection: the picture is presented flat, which
     is still the hole, and debug says why.

     deps: { fetch, apiUrl(path), token() -> Promise<string>, createObjectURL(blob),
     revokeObjectURL(url), hybrid: { session, tileUrl, canvas, decode } }.

     The elevation answer must echo the exact window asked for and say how big its grid is - the
     mesh would draw whatever it was given and has no way to notice the two do not agree. */
  function elevationFor(win, deps) {
    var query = "&z=" + win.z + "&x=" + win.x + "&y=" + win.y + "&w=" + win.w + "&h=" + win.h
      /* Named so the server can cut the window from the course's baked terrain asset rather
         than go to an elevation provider. */
      + (deps.courseKey ? "&course=" + encodeURIComponent(deps.courseKey) : "");
    var expect = [win.z, win.x, win.y, win.w, win.h].join("/");
    return Promise.resolve(deps.token ? deps.token() : "").then(function (token) {
      var headers = token ? { Authorization: "Bearer " + token } : {};
      return deps.fetch(deps.apiUrl("/api/live-terrain-frame?layer=elevation" + query), { headers: headers });
    }).then(function (res) {
      if (!res || !res.ok) {
        return (res && res.json ? res.json().catch(function () { return null; }) : Promise.resolve(null)).then(function (body) {
          throw new Error("elevation " + (res ? res.status : "no answer") + (body && body.error ? ": " + body.error : ""));
        });
      }
      if (header(res, "X-Window") !== expect) throw new Error("elevation answered for a different window");
      var size = String(header(res, "X-Elevation-Size") || "").split("x").map(Number);
      var min = Number(header(res, "X-Elevation-Min")), max = Number(header(res, "X-Elevation-Max"));
      if (!(size[0] > 1 && size[1] > 1) || !Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error("elevation answer is missing its size or range");
      }
      var credit = "";
      try { credit = decodeURIComponent(header(res, "X-Elevation-Credit") || ""); } catch (e) { credit = ""; }
      return res.blob().then(function (blob) {
        return { blob: blob, width: size[0], height: size[1], min: min, max: max, credit: credit,
          sampleM: Number(header(res, "X-Elevation-Sample-M")) || null,
          from: header(res, "X-Elevation-From") || null,
          greenDetail: header(res, "X-Green-Detail") || null,
          qualityClass: header(res, "X-Terrain-Quality") || null,
          terrainVersion: Number(header(res, "X-Terrain-Version")) || null,
          source: header(res, "X-Elevation-Source") || "?" };
      });
    }, function (e) {
      throw new Error("elevation request failed: " + ((e && e.message) || e));
    });
  }

  function load(win, geom, deps, options) {
    var hybrid = (typeof window !== "undefined" && window.ClarityApp && window.ClarityApp.liveHybrid)
      || (deps.liveHybrid) || null;
    if (!hybrid) return Promise.reject(new Error("hybrid compositor missing"));
    var hybridDeps = Object.assign({ fetch: deps.fetch, now: deps.now }, deps.hybrid);
    var picture = hybrid.build(win, geom, hybridDeps, options);
    var elevation = elevationFor(win, deps).then(null, function (e) { return { error: (e && e.message) || String(e) }; });
    return Promise.all([picture, elevation]).then(function (both) {
      var pic = both[0], elev = both[1];
      var made = [];
      var aerialUrl = deps.createObjectURL(pic.blob); made.push(aerialUrl);
      var meta;
      if (elev.error) {
        meta = surfaceMeta(win, null);
      } else {
        var elevationUrl = deps.createObjectURL(elev.blob); made.push(elevationUrl);
        meta = surfaceMeta(win, { url: elevationUrl, width: elev.width, height: elev.height, min: elev.min, max: elev.max,
          sampleM: elev.sampleM, greenDetail: elev.greenDetail, qualityClass: elev.qualityClass, terrainVersion: elev.terrainVersion });
      }
      var metres = windowMetres(win);
      var d = pic.debug;
      return {
        urls: made,
        asset: { live: true, url: aerialUrl, playSurface: meta },
        debug: Object.assign(d, {
          window: win,
          rasterPx: win.w + "x" + win.h,
          metres: Math.round(metres.width) + "x" + Math.round(metres.height) + "m",
          elevation: elev.error ? null : elev.source,
          elevationFrom: elev.error ? null : elev.from,
          terrainVersion: elev.error ? null : elev.terrainVersion,
          elevationCredit: elev.error ? "" : elev.credit,
          elevationFailed: elev.error || null,
          demPx: elev.error ? null : elev.width + "x" + elev.height,
          elevationRange: elev.error ? null : elev.min.toFixed(1) + ".." + elev.max.toFixed(1) + "m",
          demSampleM: elev.error ? null : elev.sampleM,
          greenLines: elev.error ? false : greenReadable({ sourceMetresPerSample: elev.sampleM,
            terrain: elev.greenDetail ? { greenDetail: elev.greenDetail } : null }),
          greenDetail: elev.error ? null : elev.greenDetail
        })
      };
    });
  }

  /* One frame is held at a time; this is how the previous one goes. */
  function release(entry, revokeObjectURL) {
    if (!entry || !entry.urls) return;
    entry.urls.forEach(function (u) { try { revokeObjectURL(u); } catch (e) {} });
    entry.urls = [];
  }

  /* Whose imagery is in the frame, for its on-screen credit: Esri as the context unless there
     was no Esri key, Mapbox wherever it was actually drawn (not skipped, not failed, not an
     empty mask). */
  function providers(debug) {
    if (!debug) return [];
    if (debug.context !== "esri") return ["mapbox"];
    var mb = debug.mapbox || {};
    var mapbox = !debug.mapboxSkipped && !debug.mapboxFailed && (mb.network || 0) + (mb.reused || 0) > 0;
    return mapbox ? ["esri", "mapbox"] : ["esri"];
  }

  return {
    wanted: wanted,
    frameWindow: frameWindow,
    windowKey: windowKey,
    windowMetres: windowMetres,
    surfaceMeta: surfaceMeta,
    load: load,
    greenReadable: greenReadable,
    release: release,
    providers: providers
  };
});
