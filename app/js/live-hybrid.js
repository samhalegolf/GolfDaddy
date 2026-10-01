/* The hybrid hole picture for Clarity 3D Mesh - TEST PATH, admin only.

   One temporary aerial for the hole frame (live-terrain.js frameWindow), built from two
   providers on one pixel grid:

     Esri          every tile of the frame - the context, and the safety net
     Mapbox        only the tiles the playing area touches - tee, route, green, and the hole's
                   own fairway/bunker/water shapes near that line
     colour        Esri nudged toward Mapbox using pixels both cover, inside tight limits
     blend         Mapbox at full strength inside the playing area, fading to nothing across a
                   wide feather (metres, smoothstep) so there is no edge to find

   Both providers are fetched as 256px web-mercator tiles at the frame's own zoom, so a pixel of
   one is the same ground as the same pixel of the other: nothing is resampled before blending.

   Tiles are cached for the round (createSession), keyed provider/z/x/y, so a neighbouring hole
   only asks for the tiles it does not share. The cache holds encoded bytes, not decoded images,
   and lives as long as the course is open - never in course storage.

   The pixel work is plain functions over RGBA arrays (maskField, colourCorrection, compose)
   so it is tested without a browser; build() is the thin glue that fetches and draws. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.liveHybrid = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var TILE = 256;
  /* The mask is solved on a coarse grid and interpolated per pixel: the feather is tens of
     metres wide, so 4px cells are invisible and save 16x the distance work. */
  var CELL = 4;

  var DEFAULTS = {
    corridorM: 40,        // half-width of the tee-route-green corridor
    greenM: 35,           // radius around the green centre
    greenShapeM: 15,      // around each mapped green vertex
    featherM: 50,         // Mapbox fades 1 -> 0 across this many metres outside the area
    context: { saturation: 0.95, contrast: 0.97 },   // outer Esri, very slightly quieter
    limits: { gain: [0.8, 1.25], contrast: [0.85, 1.2], saturation: [0.85, 1.2] },
    minSamples: 400
  };

  var VIEWS = ["composite", "mask", "seam", "esri-raw", "esri-corrected", "mapbox-raw"];

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

  function worldPx(lat, lng, z) {
    var scale = TILE * Math.pow(2, z);
    var latRad = (Math.max(-85.05112878, Math.min(85.05112878, Number(lat))) * Math.PI) / 180;
    return {
      x: ((Number(lng) + 180) / 360) * scale,
      y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale
    };
  }

  function metresPerPx(win) {
    var n = Math.PI * (1 - (2 * (win.y + win.h / 2)) / (TILE * Math.pow(2, win.z)));
    var lat = Math.atan(Math.sinh(n));
    return (156543.03392804097 * Math.cos(lat)) / Math.pow(2, win.z);
  }

  function point(p) {
    if (!p) return null;
    var lat = Array.isArray(p) ? p[0] : p.lat, lng = Array.isArray(p) ? p[1] : (p.lng != null ? p.lng : p.lon);
    lat = Number(lat); lng = Number(lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  /* What the mask is drawn from, out of a hole record and its package entry. Course geometry
     only - never anything read off the imagery. */
  function holeGeometry(rec, pkgHole) {
    var g = (pkgHole && (pkgHole.geometry || pkgHole)) || {};
    var s = g.surfaces || (rec && rec.surfaces) || {};
    var rings = [];
    ["fairways", "bunkers", "water"].forEach(function (k) {
      (Array.isArray(s[k]) ? s[k] : []).forEach(function (f) {
        var ring = (f && (f.shape || f.ring) || []).map(point).filter(Boolean);
        if (ring.length >= 3) rings.push(ring);
      });
    });
    return {
      tee: point(rec && rec.tee),
      green: point(rec && rec.green),
      route: ((rec && rec.route) || []).map(point).filter(Boolean),
      greenShape: ((rec && rec.greenShape) || []).map(point).filter(Boolean),
      rings: rings
    };
  }

  function segDist(px, py, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0, 1) : 0;
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  }

  function inside(px, py, ring) {
    var hit = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  }

  /* The decision area as an alpha field over the frame. alpha is 1 inside the playing area,
     0 beyond the feather, smoothstep between - measured in ground metres from the area's edge.
     Depends on the hole and the frame only, so it is stable for the whole time a hole is up. */
  function maskField(win, geom, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var mpp = metresPerPx(win);
    function toPx(p) { var w = worldPx(p.lat, p.lng, win.z); return { x: w.x - win.x, y: w.y - win.y }; }
    var line = [geom.tee].concat(geom.route || [], [geom.green]).filter(Boolean).map(toPx);
    var discs = [];
    if (geom.green) discs.push({ c: toPx(geom.green), r: o.greenM / mpp });
    (geom.greenShape || []).forEach(function (p) { discs.push({ c: toPx(p), r: o.greenShapeM / mpp }); });
    var corridorPx = o.corridorM / mpp, featherPx = o.featherM / mpp;
    function lineDist(x, y) {
      var d = Infinity;
      for (var i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(x, y, line[i], line[i + 1]));
      if (line.length === 1) d = Math.hypot(x - line[0].x, y - line[0].y);
      return d;
    }
    /* Shapes near the line of play only: a neighbouring hole's bunker is context, not play. */
    var polys = [];
    (geom.rings || []).forEach(function (ring) {
      var pts = ring.map(toPx);
      var near = pts.some(function (p) { return lineDist(p.x, p.y) <= corridorPx + featherPx; });
      if (!near) return;
      var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      pts.forEach(function (p) { b.x0 = Math.min(b.x0, p.x); b.y0 = Math.min(b.y0, p.y); b.x1 = Math.max(b.x1, p.x); b.y1 = Math.max(b.y1, p.y); });
      polys.push({ pts: pts, box: b });
    });

    var gw = Math.ceil(win.w / CELL), gh = Math.ceil(win.h / CELL);
    var alpha = new Float32Array(gw * gh);
    var inner = 0, any = 0;
    for (var j = 0; j < gh; j++) {
      var y = (j + 0.5) * CELL;
      for (var i = 0; i < gw; i++) {
        var x = (i + 0.5) * CELL;
        var d = line.length ? lineDist(x, y) - corridorPx : Infinity;
        for (var k = 0; k < discs.length && d > 0; k++) d = Math.min(d, Math.hypot(x - discs[k].c.x, y - discs[k].c.y) - discs[k].r);
        for (var q = 0; q < polys.length && d > 0; q++) {
          var P = polys[q], bx = Math.max(P.box.x0 - x, 0, x - P.box.x1), by = Math.max(P.box.y0 - y, 0, y - P.box.y1);
          if (Math.hypot(bx, by) >= d) continue;     // cannot beat what we have
          if (inside(x, y, P.pts)) { d = 0; break; }
          for (var e = 0, f = P.pts.length - 1; e < P.pts.length; f = e++) d = Math.min(d, segDist(x, y, P.pts[f], P.pts[e]));
        }
        var a = d <= 0 ? 1 : 1 - smoothstep(d / featherPx);
        alpha[j * gw + i] = a;
        if (a >= 1) inner++;
        if (a > 0) any++;
      }
    }
    var cellM2 = CELL * CELL * mpp * mpp;
    return {
      win: win, gw: gw, gh: gh, cell: CELL, alpha: alpha, metresPerPx: mpp, featherM: o.featherM,
      innerM2: inner * cellM2, maskM2: any * cellM2, framePct: (any / (gw * gh)) * 100
    };
  }

  /* Bilinear between cell centres, so the per-pixel alpha has no 4px steps. */
  function alphaAt(field, px, py) {
    var fx = px / field.cell - 0.5, fy = py / field.cell - 0.5;
    var i0 = Math.floor(fx), j0 = Math.floor(fy), tx = fx - i0, ty = fy - j0;
    function at(i, j) {
      i = clamp(i, 0, field.gw - 1); j = clamp(j, 0, field.gh - 1);
      return field.alpha[j * field.gw + i];
    }
    var top = at(i0, j0) * (1 - tx) + at(i0 + 1, j0) * tx;
    var bottom = at(i0, j0 + 1) * (1 - tx) + at(i0 + 1, j0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }

  function tileRange(win) {
    return {
      x0: Math.floor(win.x / TILE), y0: Math.floor(win.y / TILE),
      x1: Math.floor((win.x + win.w - 1) / TILE), y1: Math.floor((win.y + win.h - 1) / TILE)
    };
  }

  /* Every tile of the frame - what Esri is asked for. */
  function frameTiles(win) {
    var r = tileRange(win), out = [];
    for (var ty = r.y0; ty <= r.y1; ty++) for (var tx = r.x0; tx <= r.x1; tx++) out.push({ z: win.z, x: tx, y: ty });
    return out;
  }

  /* The tiles any non-zero alpha touches - what Mapbox is asked for. Dilated by one cell,
     because a pixel's alpha is interpolated from the next cell too. Each tile once. */
  function maskTiles(field) {
    var win = field.win, seen = {}, out = [];
    function mark(px, py) {
      var tx = Math.floor((win.x + clamp(px, 0, win.w - 1)) / TILE), ty = Math.floor((win.y + clamp(py, 0, win.h - 1)) / TILE);
      var key = tx + "," + ty;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ z: win.z, x: tx, y: ty });
    }
    for (var j = 0; j < field.gh; j++) {
      for (var i = 0; i < field.gw; i++) {
        var lit = field.alpha[j * field.gw + i] > 0
          || (i > 0 && field.alpha[j * field.gw + i - 1] > 0) || (i + 1 < field.gw && field.alpha[j * field.gw + i + 1] > 0)
          || (j > 0 && field.alpha[(j - 1) * field.gw + i] > 0) || (j + 1 < field.gh && field.alpha[(j + 1) * field.gw + i] > 0);
        if (!lit) continue;
        var px0 = i * field.cell, py0 = j * field.cell;
        mark(px0, py0); mark(px0 + field.cell - 1, py0); mark(px0, py0 + field.cell - 1); mark(px0 + field.cell - 1, py0 + field.cell - 1);
      }
    }
    return out;
  }

  function luma(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

  function median(hist, total) {
    var half = total / 2, run = 0;
    for (var v = 0; v < hist.length; v++) { run += hist[v]; if (run >= half) return v; }
    return hist.length - 1;
  }
  function quantile(hist, total, q) {
    var want = total * q, run = 0;
    for (var v = 0; v < hist.length; v++) { run += hist[v]; if (run >= want) return v; }
    return hist.length - 1;
  }

  /* Robust statistics of both providers over ground both show at full Mapbox strength.
     Histograms, so medians and quartiles cost one pass; near-black and near-white pixels in
     either picture are skipped (shadow, glare, no-data). */
  function overlapStats(esri, mapbox, field, stride) {
    var win = field.win, step = stride || 5;
    var H = function () { return [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]; };
    var e = H(), m = H(), n = 0, satE = 0, satM = 0;
    for (var y = 0; y < win.h; y += step) {
      for (var x = (y / step) % 2 ? 2 : 0; x < win.w; x += step) {
        if (alphaAt(field, x + 0.5, y + 0.5) < 0.999) continue;
        var p = (y * win.w + x) * 4;
        var er = esri[p], eg = esri[p + 1], eb = esri[p + 2], mr = mapbox[p], mg = mapbox[p + 1], mb = mapbox[p + 2];
        var ye = luma(er, eg, eb), ym = luma(mr, mg, mb);
        if (ye < 18 || ye > 238 || ym < 18 || ym > 238) continue;
        e[0][er]++; e[1][eg]++; e[2][eb]++; e[3][Math.round(ye)]++;
        m[0][mr]++; m[1][mg]++; m[2][mb]++; m[3][Math.round(ym)]++;
        satE += Math.max(er, eg, eb) - Math.min(er, eg, eb);
        satM += Math.max(mr, mg, mb) - Math.min(mr, mg, mb);
        n++;
      }
    }
    if (!n) return { samples: 0 };
    function summary(h, sat) {
      return {
        median: [median(h[0], n), median(h[1], n), median(h[2], n)],
        luma: median(h[3], n),
        iqr: quantile(h[3], n, 0.75) - quantile(h[3], n, 0.25),
        saturation: sat / n
      };
    }
    return { samples: n, esri: summary(e, satE), mapbox: summary(m, satM) };
  }

  /* Small, bounded nudges of Esri toward Mapbox. Different dates, seasons and sun angles mean
     the two can never match exactly, so every factor is clamped and too few samples means no
     correction at all - "less obviously different", never "pixel matched". */
  function colourCorrection(stats, options) {
    var lim = Object.assign({}, DEFAULTS.limits, (options && options.limits) || {});
    var minSamples = (options && options.minSamples) || DEFAULTS.minSamples;
    var identity = { gain: [1, 1, 1], contrast: 1, saturation: 1, pivot: 128, samples: stats ? stats.samples || 0 : 0, applied: false };
    if (!stats || !(stats.samples >= minSamples)) return identity;
    var gain = [0, 1, 2].map(function (c) {
      var e = Math.max(1, stats.esri.median[c]);
      return clamp(stats.mapbox.median[c] / e, lim.gain[0], lim.gain[1]);
    });
    return {
      gain: gain,
      contrast: clamp(stats.mapbox.iqr / Math.max(1, stats.esri.iqr), lim.contrast[0], lim.contrast[1]),
      saturation: clamp(stats.mapbox.saturation / Math.max(1, stats.esri.saturation), lim.saturation[0], lim.saturation[1]),
      pivot: stats.mapbox.luma,
      samples: stats.samples,
      applied: true
    };
  }

  /* One pixel of Esri through the correction, plus the outer-context quieting weighted by how
     far outside the playing area it is (w = 1 - alpha). Writes into out at p. */
  function correctPixel(src, p, corr, ctx, w, out) {
    var r = src[p] * corr.gain[0], g = src[p + 1] * corr.gain[1], b = src[p + 2] * corr.gain[2];
    var k = corr.contrast * (1 - (1 - ctx.contrast) * w);
    r = corr.pivot + (r - corr.pivot) * k; g = corr.pivot + (g - corr.pivot) * k; b = corr.pivot + (b - corr.pivot) * k;
    var s = corr.saturation * (1 - (1 - ctx.saturation) * w);
    var y = luma(r, g, b);
    out[0] = y + (r - y) * s; out[1] = y + (g - y) * s; out[2] = y + (b - y) * s;
  }

  /* The picture, in whichever debug view is asked for. esri and mapbox are RGBA arrays of the
     frame; mapbox may be null (it failed, or there is no Esri and Mapbox IS the frame). */
  function compose(esri, mapbox, field, corr, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var view = VIEWS.indexOf(o.view) === -1 ? "composite" : o.view;
    var win = field.win, out = new Uint8ClampedArray(win.w * win.h * 4);
    var c = [0, 0, 0], ctx = o.context || DEFAULTS.context, identity = { gain: [1, 1, 1], contrast: 1, saturation: 1, pivot: 128 };
    for (var y = 0; y < win.h; y++) {
      for (var x = 0; x < win.w; x++) {
        var p = (y * win.w + x) * 4;
        var a = mapbox ? alphaAt(field, x + 0.5, y + 0.5) : 0;
        if (view === "esri-raw") { out[p] = esri[p]; out[p + 1] = esri[p + 1]; out[p + 2] = esri[p + 2]; out[p + 3] = 255; continue; }
        if (view === "mapbox-raw") {
          var on = mapbox && a > 0;
          out[p] = on ? mapbox[p] : 0; out[p + 1] = on ? mapbox[p + 1] : 0; out[p + 2] = on ? mapbox[p + 2] : 0; out[p + 3] = 255;
          continue;
        }
        correctPixel(esri, p, corr || identity, view === "esri-corrected" ? { saturation: 1, contrast: 1 } : ctx, 1 - a, c);
        if (view !== "esri-corrected" && a > 0) {
          c[0] = c[0] * (1 - a) + mapbox[p] * a; c[1] = c[1] * (1 - a) + mapbox[p + 1] * a; c[2] = c[2] * (1 - a) + mapbox[p + 2] * a;
        }
        if (view === "mask") {
          /* Mapbox ground tinted magenta by its strength. */
          c[0] = c[0] * (1 - 0.45 * a) + 255 * 0.45 * a; c[1] = c[1] * (1 - 0.45 * a); c[2] = c[2] * (1 - 0.45 * a) + 200 * 0.45 * a;
        } else if (view === "seam") {
          /* The feather band only, in yellow, strongest mid-band. */
          var band = a > 0 && a < 1 ? 1 - Math.abs(a - 0.5) * 2 : 0;
          c[0] = c[0] * (1 - 0.6 * band) + 255 * 0.6 * band; c[1] = c[1] * (1 - 0.6 * band) + 220 * 0.6 * band; c[2] = c[2] * (1 - 0.6 * band);
        }
        out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = 255;
      }
    }
    return out;
  }

  /* ---- the round's tile cache ---- */

  var SESSION_MAX_TILES = 900;

  function createSession(courseKey) {
    return { courseKey: courseKey || "", tiles: new Map(), network: { esri: 0, mapbox: 0 }, failed: { esri: 0, mapbox: 0 } };
  }

  /* One tile's bytes, from the session if it has them. A failure is not cached, so the next
     hole may try again. */
  function tileBytes(session, provider, t, url, deps, count) {
    var key = provider + "/" + t.z + "/" + t.x + "/" + t.y;
    var hit = session.tiles.get(key);
    if (hit) {
      session.tiles.delete(key); session.tiles.set(key, hit);   // most recently used last
      count.reused++;
      return hit;
    }
    count.network++;
    session.network[provider]++;
    var job = deps.fetch(url).then(function (res) {
      if (!res || !res.ok) throw new Error(provider + " tile " + (res ? res.status : "failed"));
      return res.blob();
    });
    session.tiles.set(key, job);
    job.catch(function () { session.tiles.delete(key); session.failed[provider]++; });
    while (session.tiles.size > SESSION_MAX_TILES) session.tiles.delete(session.tiles.keys().next().value);
    return job;
  }

  /* All of a provider's tiles for the frame, drawn onto one canvas on the frame's grid.
     Resolves to the RGBA array, or rejects with the first failure. */
  function acquire(win, tiles, provider, session, deps) {
    var count = { requested: tiles.length, network: 0, reused: 0 };
    var canvas = deps.canvas(win.w, win.h);
    var jobs = tiles.map(function (t) {
      var url = deps.tileUrl(provider, t.z, t.x, t.y);
      if (!url) return Promise.reject(new Error(provider + " is not configured"));
      return tileBytes(session, provider, t, url, deps, count).then(deps.decode).then(function (img) {
        canvas.draw(img, t.x * TILE - win.x, t.y * TILE - win.y, TILE, TILE);
      });
    });
    return Promise.all(jobs).then(function () {
      var data = canvas.read();
      canvas.free();
      return { data: data, count: count };
    }, function (e) {
      canvas.free();
      e.count = count;
      throw e;
    });
  }

  /* The hole's picture. Resolves { blob, debug }, or rejects when there is no context imagery
     at all (the caller's fallback is the live map). Mapbox failing is not a rejection: the
     surface is Esri on its own, and debug says why. */
  function build(win, geom, deps, options) {
    var o = Object.assign({}, DEFAULTS, options || {});
    var started = deps.now ? deps.now() : Date.now();
    var field = maskField(win, geom, o);
    var esriReady = !!deps.tileUrl("esri", win.z, 0, 0);
    /* No Esri key: Mapbox is the whole frame, as it was before the hybrid. */
    var context = esriReady ? "esri" : "mapbox";
    var allTiles = frameTiles(win);
    var mapboxTiles = esriReady ? maskTiles(field) : allTiles;
    var debug = {
      frame: { z: win.z, x: win.x, y: win.y, w: win.w, h: win.h },
      metresPerPx: field.metresPerPx,
      maskM2: Math.round(field.maskM2), maskPct: Math.round(field.framePct * 10) / 10,
      featherM: o.featherM, view: o.view || "composite", context: context,
      tiles: { frame: allTiles.length, mapbox: mapboxTiles.length }
    };
    var base = acquire(win, allTiles, context, deps.session, deps);
    var premium = esriReady ? acquire(win, mapboxTiles, "mapbox", deps.session, deps).then(null, function (e) {
      debug.mapboxFailed = (e && e.message) || String(e);
      debug.mapbox = e && e.count;
      return null;
    }) : Promise.resolve(null);
    return Promise.all([base, premium]).then(function (both) {
      var esri = both[0], mapbox = both[1];
      debug[context] = esri.count;
      if (mapbox) debug.mapbox = mapbox.count;
      debug.sessionMapbox = deps.session.network.mapbox;
      debug.sessionEsri = deps.session.network.esri;
      var corr = mapbox ? colourCorrection(overlapStats(esri.data, mapbox.data, field), o) : colourCorrection(null);
      debug.colour = corr;
      var pixels = compose(esri.data, mapbox ? mapbox.data : null, field, corr, o);
      var out = deps.canvas(win.w, win.h);
      out.write(pixels);
      return out.toBlob().then(function (blob) {
        out.free();
        debug.composeMs = (deps.now ? deps.now() : Date.now()) - started;
        return { blob: blob, debug: debug };
      });
    }, function (e) {
      e.debug = debug;
      throw e;
    });
  }

  /* The browser's canvas, for build(). */
  function browserRaster() {
    return {
      canvas: function (w, h) {
        var c = document.createElement("canvas");
        c.width = w; c.height = h;
        var ctx = c.getContext("2d", { willReadFrequently: true });
        return {
          draw: function (img, x, y, dw, dh) { ctx.drawImage(img, x, y, dw, dh); if (img.close) img.close(); },
          read: function () { return ctx.getImageData(0, 0, w, h).data; },
          write: function (pixels) { ctx.putImageData(new ImageData(pixels, w, h), 0, 0); },
          toBlob: function () {
            return new Promise(function (resolve, reject) {
              c.toBlob(function (b) { if (b) resolve(b); else reject(new Error("composite would not encode")); }, "image/jpeg", 0.9);
            });
          },
          /* Give the backing store back now rather than when the collector gets round to it. */
          free: function () { c.width = 0; c.height = 0; }
        };
      },
      decode: function (blob) { return createImageBitmap(blob); }
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    VIEWS: VIEWS,
    holeGeometry: holeGeometry,
    maskField: maskField,
    alphaAt: alphaAt,
    frameTiles: frameTiles,
    maskTiles: maskTiles,
    overlapStats: overlapStats,
    colourCorrection: colourCorrection,
    compose: compose,
    createSession: createSession,
    acquire: acquire,
    build: build,
    browserRaster: browserRaster
  };
});
