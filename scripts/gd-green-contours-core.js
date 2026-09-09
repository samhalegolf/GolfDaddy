/* Green contour maps - the single implementation.
 *
 * Loaded two ways, and it must stay portable between them:
 *   - browser, via <script> in app/index.html, as window.GDGreenContoursCore
 *   - Netlify function, via import from functions/lib/gd-visual-export-core.mjs
 *
 * Same policy as scripts/gd-bubble-signals-core.js: one file, no platform APIs above the
 * export tail - no window, no document, no canvas, no Buffer, no sharp. The reason is the
 * same too. This decides how a green is READ, and the phone and the export must agree; two
 * copies of that opinion would drift, and the drift would be invisible because both would
 * still look like plausible contour maps.
 *
 * The platform split is drawn at PROJECTION, not at maths. This file produces a display list
 * in green-local METRES with every colour and opacity already resolved; the caller projects
 * those metres to its own pixels and strokes them however it strokes things - SVG paths on
 * the server, canvas on the phone. So there is exactly one copy of "what to draw" and two
 * thin copies of "how to put a line on this surface", which is the part that genuinely
 * differs.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 *
 * A green falls maybe a metre over thirty. The DEM behind it samples every ~1.7m and quantises
 * height to 0.1m, so the rise between two adjacent samples is comparable to a single
 * quantisation step. Differencing neighbours - what a normal slope raster does - returns the
 * quantisation pattern, not the ground. It looks like slope. It is noise.
 *
 * What rescues it is that a green is a SMOOTH surface. Fit a low-order polynomial through all
 * ~200-300 samples at once and the quantisation, being zero-mean, averages down by roughly the
 * square root of the sample count; the fitted gradient is then a real measurement. Every line
 * and every arrow here is read off the fitted surface analytically, never off pixel differences.
 *
 * Order 3 is a deliberate ceiling. It expresses what a green actually does - overall tilt, a
 * crown, a saddle, one tier - and cannot express what the data will not support. Raising it
 * would make the residual smaller and the answer worse.
 *
 * MEASURED ON REAL GROUND. Jacks Point, z16 elevation (1.69 m/px), green polygon only:
 *
 *   h1   247 samples  fall 1.49% NNW  relief 0.77m  residual 0.063m (2.2x quantisation)
 *   h6   197 samples  fall 1.87% WSW  relief 0.82m  residual 0.049m (1.7x)
 *   h8   276 samples  fall 5.77% SSW  relief 2.88m  residual 0.127m (4.4x)
 *   h9   197 samples  fall 4.43% SW   relief 1.22m  residual 0.046m (1.6x)
 *   h17  303 samples  fall 3.31% ESE  relief 1.40m  residual 0.095m (3.3x)
 *
 * NO COLLAR. Samples come from inside the green polygon and nowhere else. Including a 7m
 * collar - which seemed obviously right, since a fit wants data past its edge and the collar is
 * where chipping happens - tripled the residual on real greens (h1 0.063 -> 0.311m) and tilted
 * the answer (h6 1.87% -> 2.92%), because a cubic cannot represent a putting surface AND a
 * bunker face and splits the difference between them. Nothing is ever DRAWN outside the polygon
 * either, so there is no extrapolation for the collar to have protected.
 *
 * WHAT THIS MAY CLAIM. Which way the green falls, where the tiers are, roughly how steep each
 * region is. Macro read. It must never claim a putt breaks four inches right of the cup - that
 * needs survey data this pipeline does not have. Ship it as "how this green sits".
 */

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GDGreenContoursCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------- geometry ---------------------------------------------------------------------- */

  function mercY(lat) {
    const s = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }

  /* lat/lng -> pixel inside a north-up mercator raster of known bounds. Exact rather than a
     linear latitude interpolation, because the raster IS a mercator crop. */
  function rasterProjector(bounds, width, height) {
    const x0 = (bounds.west + 180) / 360, x1 = (bounds.east + 180) / 360;
    const y0 = mercY(bounds.north), y1 = mercY(bounds.south);
    const dx = (x1 - x0) || 1e-12, dy = (y1 - y0) || 1e-12;
    return (lat, lng) => ({
      x: (((lng + 180) / 360) - x0) / dx * width,
      y: (mercY(lat) - y0) / dy * height
    });
  }

  /* Local metric frame: metres east and north of an origin. Over a green the flat-earth
     approximation is exact to well under a millimetre. */
  function metricFrame(originLat, originLng) {
    const mPerLat = 111320;
    const mPerLng = 111320 * Math.cos((originLat * Math.PI) / 180);
    return {
      toMetres: (lat, lng) => ({ x: (lng - originLng) * mPerLng, y: (lat - originLat) * mPerLat }),
      toLatLng: (x, y) => ({ lat: originLat + y / mPerLat, lng: originLng + x / mPerLng })
    };
  }

  function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function distanceToPolygon(x, y, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j].x, ay = poly[j].y, bx = poly[i].x, by = poly[i].y;
      const vx = bx - ax, vy = by - ay;
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len2)) : 0;
      const d = Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
      if (d < best) best = d;
    }
    return best;
  }

  /* ---------- polynomial surface fit --------------------------------------------------------- */

  function terms(order) {
    const out = [];
    for (let total = 0; total <= order; total++) {
      for (let i = total; i >= 0; i--) out.push([i, total - i]);
    }
    return out;
  }

  /* Gaussian elimination with partial pivoting. The system is 10x10 for order 3, so nothing
     fancier is warranted. */
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      if (Math.abs(M[pivot][col]) < 1e-12) return null;
      [M[col], M[pivot]] = [M[pivot], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        if (!f) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / M[i][i]);
  }

  function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Fit z = P(x, y) over scattered samples.
   *
   * Coordinates are normalised by `scale` before fitting - without it the cubic terms of a 30m
   * green carry values around 27000 and the normal equations lose most of their precision.
   *
   * Robustness is Tukey biweight over three reweighting passes, for a specific failure: a cart
   * path, a sprinkler head or a tree-shadow artefact caught inside the mask is a real feature of
   * the DEM and a lie about the putting surface, and plain least squares would tilt the whole
   * green to accommodate it.
   */
  function fitSurface(samples, { order = 3, scale = 20, robustPasses = 3 } = {}) {
    const T = terms(order);
    const n = T.length;
    if (samples.length < n * 2) return null;

    const basis = samples.map(s => {
      const u = s.x / scale, v = s.y / scale;
      return T.map(([i, j]) => Math.pow(u, i) * Math.pow(v, j));
    });

    let weights = samples.map(() => 1);
    let coeffs = null;
    for (let pass = 0; pass <= robustPasses; pass++) {
      const A = Array.from({ length: n }, () => new Array(n).fill(0));
      const b = new Array(n).fill(0);
      for (let s = 0; s < samples.length; s++) {
        const w = weights[s], row = basis[s], z = samples[s].z;
        for (let i = 0; i < n; i++) {
          b[i] += w * row[i] * z;
          for (let j = i; j < n; j++) A[i][j] += w * row[i] * row[j];
        }
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
      const next = solve(A, b);
      if (!next) return null;
      coeffs = next;
      if (pass === robustPasses) break;

      const residuals = samples.map((s, k) => s.z - basis[k].reduce((acc, v, i) => acc + v * coeffs[i], 0));
      /* MAD rather than sd: one gross outlier inflates sd enough to stop excluding itself. */
      const mad = median(residuals.map(Math.abs)) || 1e-6;
      const c = 4.685 * 1.4826 * mad;
      weights = residuals.map(r => {
        const t = Math.abs(r) / c;
        return t >= 1 ? 0 : Math.pow(1 - t * t, 2);
      });
    }

    const residuals = samples.map((s, k) => s.z - basis[k].reduce((acc, v, i) => acc + v * coeffs[i], 0));
    const residualRms = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / residuals.length);

    const heightAt = (x, y) => {
      const u = x / scale, v = y / scale;
      return T.reduce((acc, [i, j], k) => acc + coeffs[k] * Math.pow(u, i) * Math.pow(v, j), 0);
    };
    /* Analytic derivative. The 1/scale is the chain rule for the normalisation above - dropping
       it is a silent factor-of-20 error in every slope reported. */
    const gradientAt = (x, y) => {
      const u = x / scale, v = y / scale;
      let dx = 0, dy = 0;
      T.forEach(([i, j], k) => {
        if (i > 0) dx += coeffs[k] * i * Math.pow(u, i - 1) * Math.pow(v, j);
        if (j > 0) dy += coeffs[k] * j * Math.pow(u, i) * Math.pow(v, j - 1);
      });
      return { dx: dx / scale, dy: dy / scale };
    };

    return { coeffs, order, scale, residualRms, sampleCount: samples.length, heightAt, gradientAt };
  }

  /* Slope as a percentage and the compass bearing water runs toward. */
  function slopeAt(fit, x, y) {
    const { dx, dy } = fit.gradientAt(x, y);
    const magnitude = Math.hypot(dx, dy);
    const bearing = (((Math.atan2(-dx, -dy) * 180) / Math.PI) + 360) % 360;
    return { percent: magnitude * 100, bearing, dx, dy };
  }

  /* ---------- contours ----------------------------------------------------------------------- */

  /* Marching squares over the FITTED surface. Contouring the raw DEM instead is what produces
     the staircase artefact gd-relief-core warns about: those steps are the 0.1m quantisation
     drawn as if it were terrain. */
  function contours(surface, polygon, { interval = 0.15, cell = 0.4 } = {}) {
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cols = Math.ceil((maxX - minX) / cell) + 1;
    const rows = Math.ceil((maxY - minY) / cell) + 1;

    const gx = i => minX + i * cell;
    const gy = j => minY + j * cell;
    const H = [];
    for (let j = 0; j < rows; j++) {
      const row = [];
      for (let i = 0; i < cols; i++) row.push(surface.heightAt(gx(i), gy(j)));
      H.push(row);
    }
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      if (!pointInPolygon(gx(i), gy(j), polygon)) continue;
      lo = Math.min(lo, H[j][i]); hi = Math.max(hi, H[j][i]);
    }
    if (!(lo < hi)) return [];

    const segments = [];
    const first = Math.ceil(lo / interval) * interval;
    for (let level = first; level <= hi; level += interval) {
      for (let j = 0; j < rows - 1; j++) {
        for (let i = 0; i < cols - 1; i++) {
          const corners = [
            { x: gx(i), y: gy(j), h: H[j][i] },
            { x: gx(i + 1), y: gy(j), h: H[j][i + 1] },
            { x: gx(i + 1), y: gy(j + 1), h: H[j + 1][i + 1] },
            { x: gx(i), y: gy(j + 1), h: H[j + 1][i] }
          ];
          const crossings = [];
          for (let e = 0; e < 4; e++) {
            const a = corners[e], b = corners[(e + 1) % 4];
            if ((a.h > level) === (b.h > level)) continue;
            const t = (level - a.h) / (b.h - a.h);
            crossings.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
          }
          if (crossings.length !== 2) continue;
          const mid = { x: (crossings[0].x + crossings[1].x) / 2, y: (crossings[0].y + crossings[1].y) / 2 };
          if (!pointInPolygon(mid.x, mid.y, polygon)) continue;
          segments.push({ a: crossings[0], b: crossings[1], level });
        }
      }
    }
    return segments;
  }

  /* Marching squares emits each crossing as its own two-point segment, in whatever order the
     cells happened to be walked. Drawn straight, that is a few thousand disconnected sticks: the
     eye reads them as stipple rather than as a line, and every joint shows. Chaining walks the
     shared endpoints back into continuous polylines.

     Endpoints match EXACTLY rather than approximately - two adjacent cells interpolate the
     crossing on their shared edge from the same two corner heights, so the arithmetic is
     identical - which is why a rounded key works and no tolerance search is needed. */
  function chainSegments(segments, { quantum = 1e-7 } = {}) {
    const key = p => Math.round(p.x / quantum) + "," + Math.round(p.y / quantum);
    const byLevel = new Map();
    for (const s of segments) {
      if (!byLevel.has(s.level)) byLevel.set(s.level, []);
      byLevel.get(s.level).push(s);
    }

    const chains = [];
    for (const [level, segs] of byLevel) {
      const ends = new Map();
      segs.forEach((s, i) => {
        for (const e of ["a", "b"]) {
          const k = key(s[e]);
          if (!ends.has(k)) ends.set(k, []);
          ends.get(k).push({ i, e });
        }
      });

      const used = new Array(segs.length).fill(false);
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        const points = [segs[i].a, segs[i].b];
        /* Grow from the tail, then from the head, so an open line is found whole no matter which
           of its segments was picked up first. */
        for (const fromTail of [true, false]) {
          for (;;) {
            const tip = fromTail ? points[points.length - 1] : points[0];
            const next = (ends.get(key(tip)) || []).find(c => !used[c.i]);
            if (!next) break;
            used[next.i] = true;
            const seg = segs[next.i];
            const other = next.e === "a" ? seg.b : seg.a;
            if (fromTail) points.push(other); else points.unshift(other);
          }
        }
        chains.push({ level, points, closed: key(points[0]) === key(points[points.length - 1]) });
      }
    }
    return chains;
  }

  /* Chaikin corner cutting. The chained line is still a staircase of cell-edge crossings, and a
     green's iso-lines are smooth curves - the corners are an artefact of the sampling lattice,
     not ground. Two passes removes them without pulling the line off the surface it came from. */
  function smoothPolyline(points, { passes = 2, closed = false } = {}) {
    let pts = closed && points.length > 1 ? points.slice(0, -1) : points.slice();
    for (let p = 0; p < passes; p++) {
      if (pts.length < 3) break;
      const n = pts.length;
      const next = [];
      if (!closed) next.push(pts[0]);
      const last = closed ? n : n - 1;
      for (let i = 0; i < last; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      if (!closed) next.push(pts[n - 1]);
      pts = next;
    }
    return closed && pts.length ? [...pts, pts[0]] : pts;
  }

  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    return total;
  }

  /**
   * Iso-lines as smooth continuous polylines - the drawable form of `contours`.
   *
   * `minLengthM` drops the stubs left where an iso-line clips the polygon edge. They are real
   * crossings, but a 40cm fragment reads as a scratch in the turf rather than as ground, and a
   * dozen of them around the rim make the overlay look like dirt on a lens.
   */
  function contourPaths(surface, polygon, { interval = 0.15, cell = 0.4, minLengthM = 1.6, passes = 2 } = {}) {
    return chainSegments(contours(surface, polygon, { interval, cell }))
      .filter(c => c.points.length >= 3 && polylineLength(c.points) >= minLengthM)
      .map(c => ({ ...c, points: smoothPolyline(c.points, { passes, closed: c.closed }) }));
  }

  /* ---------- confidence --------------------------------------------------------------------- */

  /* The gate that decides whether anything is drawn at all.

     A residual far ABOVE the DEM's own quantisation means the fit is describing something that is
     not a putting surface - a bad mask, a tree, junk elevation. A residual far BELOW it means the
     source had no detail to begin with: a coarse national DEM upsampled to a fine grid is almost
     perfectly smooth, and fits beautifully while knowing nothing. gd-imagery-sources records
     nativeResolutionM 1 and fallbackResolutionM 8 on the LINZ DEM but there is no runtime way to
     know which tier you got - this is that detector.

     Both must refuse to draw. Showing nothing is a fine outcome; showing a confident wrong read
     of a green is not. */
  function summarise(fit, polygon, { quantisationM = 0.1, metresPerSample = 1.7 } = {}) {
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    let sumDx = 0, sumDy = 0, count = 0;
    let lowest = null, highest = null;
    const slopes = [];
    for (let y = minY; y <= maxY; y += 0.5) {
      for (let x = minX; x <= maxX; x += 0.5) {
        if (!pointInPolygon(x, y, polygon)) continue;
        const s = slopeAt(fit, x, y);
        const h = fit.heightAt(x, y);
        sumDx += s.dx; sumDy += s.dy; count++;
        slopes.push(s.percent);
        if (!lowest || h < lowest.h) lowest = { x, y, h };
        if (!highest || h > highest.h) highest = { x, y, h };
      }
    }
    if (!count) return null;

    const meanDx = sumDx / count, meanDy = sumDy / count;
    const fallBearing = (((Math.atan2(-meanDx, -meanDy) * 180) / Math.PI) + 360) % 360;
    slopes.sort((a, b) => a - b);

    const quantisationRms = quantisationM / Math.sqrt(12);
    const ratio = fit.residualRms / quantisationRms;
    let confidence = "good";
    let reason = "";
    if (fit.sampleCount < 60) { confidence = "low"; reason = "only " + fit.sampleCount + " elevation samples inside the green"; }
    else if (ratio > 6) { confidence = "low"; reason = "residual " + fit.residualRms.toFixed(3) + "m is " + ratio.toFixed(1) + "x quantisation - the mask or the elevation is wrong"; }
    else if (ratio < 0.35) { confidence = "low"; reason = "residual " + fit.residualRms.toFixed(3) + "m is far below quantisation - upsampled coarse DEM, no real detail"; }
    else if (fit.sampleCount < 150) { confidence = "fair"; reason = fit.sampleCount + " samples at ~" + metresPerSample.toFixed(2) + "m spacing"; }

    return {
      fallBearing,
      meanSlopePercent: Math.hypot(meanDx, meanDy) * 100,
      medianSlopePercent: slopes[Math.floor(slopes.length * 0.5)],
      reliefM: highest.h - lowest.h,
      residualRms: fit.residualRms,
      residualRatio: ratio,
      sampleCount: fit.sampleCount,
      confidence, reason
    };
  }

  function compassName(bearing) {
    const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return names[Math.round(bearing / 22.5) % 16];
  }

  /* ---------- fit a green from a decoded elevation raster ------------------------------------ */

  /**
   * Everything the drawing needs, from heights + a green outline. Pure: no sharp, no I/O, so the
   * caller keeps ownership of decoding and this stays testable on a synthetic surface.
   *
   * @param {Float32Array} heights   decoded elevation, row-major
   * @param {object} raster          { width, height, bounds, metresPerPixel }
   * @param {Array} greenShape       [{lat,lng}, ...] - the wand/automapper green outline
   * @returns {object|null}          { fit, polygon, frame, summary } or null if unusable
   */
  function fitGreenSurface(heights, raster, greenShape) {
    if (!heights || !raster || !Array.isArray(greenShape) || greenShape.length < 8) return null;
    const { width, height, bounds } = raster;
    if (!(width > 0 && height > 0) || !bounds) return null;

    const stepM = Number(raster.metresPerPixel) > 0 ? Number(raster.metresPerPixel) : 1.7;
    const project = rasterProjector(bounds, width, height);

    const originLat = greenShape.reduce((s, p) => s + p.lat, 0) / greenShape.length;
    const originLng = greenShape.reduce((s, p) => s + p.lng, 0) / greenShape.length;
    const frame = metricFrame(originLat, originLng);
    const polygon = greenShape.map(p => frame.toMetres(p.lat, p.lng));

    const bilinear = (px, py) => {
      const x = Math.max(0, Math.min(width - 1, px));
      const y = Math.max(0, Math.min(height - 1, py));
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
      const fx = x - x0, fy = y - y0;
      const h = (a, b) => heights[b * width + a];
      return h(x0, y0) * (1 - fx) * (1 - fy) + h(x1, y0) * fx * (1 - fy)
           + h(x0, y1) * (1 - fx) * fy + h(x1, y1) * fx * fy;
    };

    /* Every DEM pixel whose centre lands inside the green. No collar - see the header. */
    const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
    const bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    const samples = [];
    for (let y = bbox.minY; y <= bbox.maxY; y += stepM) {
      for (let x = bbox.minX; x <= bbox.maxX; x += stepM) {
        if (!pointInPolygon(x, y, polygon)) continue;
        const ll = frame.toLatLng(x, y);
        const p = project(ll.lat, ll.lng);
        if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) continue;
        samples.push({ x, y, z: bilinear(p.x, p.y) });
      }
    }

    const fit = fitSurface(samples, { order: 3, scale: 20 });
    if (!fit) return null;
    const summary = summarise(fit, polygon, { metresPerSample: stepM });
    if (!summary) return null;
    return { fit, polygon, frame, summary };
  }


  /* ---------- the drawing, as a platform-neutral display list ------------------------------ */

  /* The locked palette. Dark greens only - lines, fill, arrows and halos alike - so the drawing
     reads as part of the turf rather than as ink laid over a photograph. Height is carried by
     TONE inside a narrow dark range, never by climbing toward something brighter.

     The trade this accepts: a dark line on dark ground has no contrast to fall back on, so the
     palette depends on the green being the mid-toned part of the picture. That is the right bet
     on mown turf and would be the wrong one over deep shade. The edge fade keeps it on turf. */
  var LEVEL_STOPS = [
    { at: 0.00, rgb: [7, 18, 11] },
    { at: 0.45, rgb: [15, 34, 20] },
    { at: 0.75, rgb: [24, 50, 29] },
    { at: 1.00, rgb: [35, 68, 40] }
  ];
  function levelColour(t) {
    var u = Math.max(0, Math.min(1, t));
    var a = LEVEL_STOPS[0], b = LEVEL_STOPS[LEVEL_STOPS.length - 1];
    for (var i = 1; i < LEVEL_STOPS.length; i++) {
      if (u <= LEVEL_STOPS[i].at) { a = LEVEL_STOPS[i - 1]; b = LEVEL_STOPS[i]; break; }
    }
    var k = (u - a.at) / ((b.at - a.at) || 1);
    var c = [0, 1, 2].map(function (i) { return Math.round(a.rgb[i] + (b.rgb[i] - a.rgb[i]) * k); });
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  var HALO = "#050e08";
  var HALO_ALPHA = 0.26;
  var SUPP_INK = "#1b3a23";
  var SUPP_ALPHA = 0.26;
  var ARROW_INK = "#0b2013";
  var ARROW_ALPHA = 0.44;
  var RUN_POINTS = 6;

  var CONTOUR_DEFAULTS = {
    intervalM: 0.15,
    indexEvery: 4,
    /* Supplementary fill at a third of the main interval, gated on GAP WIDTH rather than on a
       slope threshold. A fixed interval leaves a flat green bare - spacing is interval/slope, so
       the gentler the ground the wider the gaps - and gap width is the quantity actually being
       complained about. An absolute slope cutoff was tried first and drew nothing at all,
       because these greens average 3.3-5.8% and any "flat ground" threshold excludes them all.

       At 5cm these lines sit INSIDE the fit's own residual (0.05-0.13m measured). They are real
       iso-lines of the fitted surface and they are smooth and continuous, but the ground truth
       does not resolve to 5cm and they must never be drawn as though it does - hence thin,
       neutral and unlabelled. Texture and coverage, making no claim the main interval is not. */
    supplementaryDivisor: 3,
    supplementaryGapFullM: 2.8,
    supplementaryGapNoneM: 1.3,
    /* Arrows hang off the INDEX contours rather than a lattice. A lattice position is arbitrary
       - why there and not 40cm left? - whereas a point on a contour is somewhere the drawing
       already commits to. Each arrow sits ON its line and runs downhill from it, and because a
       contour is perpendicular to the fall by definition it leaves at a right angle for free.

       Size is CONSTANT in ground metres. The contours already say how steep the ground is, in
       the only way that needs no legend - their spacing - so an arrow has exactly one job left,
       direction. Nothing varies with magnitude, so nothing bunches. That is what separates this
       from the flow-line layer it replaced, where length tracked slope and the strokes combed
       together on every steep shoulder. */
    arrowAlongM: 7.5,
    arrowLenM: 1.6,
    arrowInsetM: 2.0,
    /* THE knob. Below this the fall bearing is still real arithmetic and a lie about what a ball
       will do, so no arrow is drawn. */
    arrowMinSlopePercent: 1.0,
    /* How far inside the polygon the drawing fades to nothing. This is what keeps the green
       OUTLINE from ever appearing: no line reaches the boundary, so there is no edge to see. */
    edgeFadeM: 2.6,
    opacity: 1,
    /* Stroke widths, in output pixels. Callers rendering at a much smaller canvas (the Watch
       map, 448px wide vs. up to 2048px for the satellite bake) override these to keep the same
       proportion of ink to ground rather than drawing satellite-scale lines onto a wrist. */
    indexWidthPx: 1.1,
    nonIndexWidthPx: 0.7,
    indexHaloWidthPx: 2.1,
    nonIndexHaloWidthPx: 1.5,
    suppWidthPx: 0.72,
    arrowWidthPx: 1.25,
    arrowHaloWidthPx: 2.95
  };

  /**
   * Everything to draw for one green, in green-local METRES.
   *
   * The green outline decides WHERE to draw and is itself never drawn. Two mechanisms, and the
   * distinction matters:
   *
   *   - `contours` clips segments to the polygon, so nothing is generated outside it;
   *   - every run and arrow then fades by its distance INSIDE the polygon, reaching zero
   *     `edgeFadeM` before the boundary.
   *
   * The fade is baked into each run's alpha rather than applied as a mask. A mask would mean a
   * blur filter on a filled polygon - which depends on the renderer supporting filter
   * primitives and, worse, spreads OUTWARD, revealing line work past the green edge, the precise
   * opposite of what is wanted. Fading in ground metres is predictable, needs nothing from the
   * renderer, and reaches zero where we say it does. It also survives being drawn to canvas,
   * which has no equivalent of an SVG mask at all.
   *
   * @returns {{runs: Array, arrows: Array}|null} runs are polylines in metres with colour,
   *   widthPx and alpha resolved; arrows carry tail/head in metres plus alpha.
   */
  function buildGreenDrawing(surface, options) {
    if (!surface || !surface.fit || !surface.polygon) return null;
    var cfg = {};
    var k;
    for (k in CONTOUR_DEFAULTS) if (Object.prototype.hasOwnProperty.call(CONTOUR_DEFAULTS, k)) cfg[k] = CONTOUR_DEFAULTS[k];
    if (options) for (k in options) if (Object.prototype.hasOwnProperty.call(options, k) && options[k] !== undefined) cfg[k] = options[k];
    if (!(cfg.opacity > 0)) return null;

    var fit = surface.fit, polygon = surface.polygon;

    function fade(x, y) {
      if (!pointInPolygon(x, y, polygon)) return 0;
      var d = distanceToPolygon(x, y, polygon);
      var t = Math.max(0, Math.min(1, d / cfg.edgeFadeM));
      return t * t * (3 - 2 * t);   // smoothstep, so the fade has no visible start
    }

    var paths = contourPaths(fit, polygon, { interval: cfg.intervalM, cell: 0.35 });
    if (!paths.length) return null;

    var levels = paths.map(function (c) { return c.level; });
    var lo = Math.min.apply(null, levels), hi = Math.max.apply(null, levels);
    var span = (hi - lo) || 1;

    var runs = [], arrows = [];

    /* Split a polyline into constant-opacity runs. Doing this by arc position rather than
       drawing the whole line at one alpha is what lets a single contour be fully present in the
       middle of the green and gone by the time it reaches the rim. */
    function pushRuns(points, colour, widthPx, baseAlpha, haloWidthPx, gate) {
      for (var i = 0; i < points.length - 1; i += RUN_POINTS) {
        var run = points.slice(i, Math.min(points.length, i + RUN_POINTS + 1));
        if (run.length < 2) continue;
        var mid = run[run.length >> 1];
        var f = fade(mid.x, mid.y);
        if (f <= 0.02) continue;
        if (gate) { f *= gate(mid); if (f <= 0.02) continue; }
        runs.push({
          points: run, colour: colour, widthPx: widthPx,
          haloWidthPx: haloWidthPx || 0, haloColour: HALO,
          haloAlpha: haloWidthPx ? HALO_ALPHA * f * cfg.opacity : 0,
          alpha: baseAlpha * f * cfg.opacity
        });
      }
    }

    /* Supplementary fill first, then main lines, then arrows - so the heavier marks always sit
       over the lighter ones where they cross. */
    if (cfg.supplementaryDivisor > 1) {
      var fine = cfg.intervalM / cfg.supplementaryDivisor;
      var supp = contourPaths(fit, polygon, { interval: fine, cell: 0.35, minLengthM: 2.2 });
      for (var s = 0; s < supp.length; s++) {
        var sc = supp[s];
        /* Skip levels that ARE main contours - a thin pale line exactly under a heavy one just
           dirties its edge. */
        if (Math.abs(sc.level / cfg.intervalM - Math.round(sc.level / cfg.intervalM)) < 1e-6) continue;
        pushRuns(sc.points, SUPP_INK, cfg.suppWidthPx, SUPP_ALPHA, 0, function (mid) {
          var pct = slopeAt(fit, mid.x, mid.y).percent;
          var gapM = cfg.intervalM / Math.max(pct / 100, 1e-4);
          return Math.max(0, Math.min(1,
            (gapM - cfg.supplementaryGapNoneM) / (cfg.supplementaryGapFullM - cfg.supplementaryGapNoneM)));
        });
      }
    }

    for (var p = 0; p < paths.length; p++) {
      var c = paths[p];
      var index = Math.abs(Math.round(c.level / cfg.intervalM)) % cfg.indexEvery === 0;
      pushRuns(c.points, levelColour((c.level - lo) / span),
        index ? cfg.indexWidthPx : cfg.nonIndexWidthPx, index ? 0.62 : 0.40,
        index ? cfg.indexHaloWidthPx : cfg.nonIndexHaloWidthPx, null);
    }

    /* Walk each index contour and drop an arrow every arrowAlongM of GROUND. Stepping by arc
       length rather than vertex count matters - Chaikin leaves the smoothed line densely packed
       through curves and sparse on straights, so counting vertices would cluster every arrow
       into the bends and leave the straights bare. */
    for (var q = 0; q < paths.length; q++) {
      var pc = paths[q];
      if (Math.abs(Math.round(pc.level / cfg.intervalM)) % cfg.indexEvery !== 0) continue;
      var since = cfg.arrowAlongM * 0.5;
      for (var i2 = 1; i2 < pc.points.length; i2++) {
        var a = pc.points[i2 - 1], b = pc.points[i2];
        since += Math.hypot(b.x - a.x, b.y - a.y);
        if (since < cfg.arrowAlongM) continue;
        since = 0;
        if (distanceToPolygon(b.x, b.y, polygon) < cfg.arrowInsetM) continue;
        var g = fit.gradientAt(b.x, b.y);
        var mag = Math.hypot(g.dx, g.dy);
        if (mag * 100 < cfg.arrowMinSlopePercent) continue;
        var f2 = fade(b.x, b.y);
        if (f2 <= 0.05) continue;
        arrows.push({
          tail: { x: b.x, y: b.y },
          head: { x: b.x - (g.dx / mag) * cfg.arrowLenM, y: b.y - (g.dy / mag) * cfg.arrowLenM },
          colour: ARROW_INK, haloColour: HALO,
          alpha: ARROW_ALPHA * f2 * cfg.opacity,
          haloAlpha: HALO_ALPHA * f2 * cfg.opacity,
          widthPx: cfg.arrowWidthPx, haloWidthPx: cfg.arrowHaloWidthPx
        });
      }
    }

    if (!runs.length && !arrows.length) return null;
    return { runs: runs, arrows: arrows };
  }

  /* Chevron wings for an arrow, in the CALLER'S pixel space. Built from the projected tail and
     head rather than in metres so the head keeps a sane size and a true right angle however the
     metric frame lands on the pixels - and so a phone at one zoom and an export at another both
     get a head that reads. */
  function arrowWings(tailPx, headPx) {
    var vx = headPx.x - tailPx.x, vy = headPx.y - tailPx.y;
    var len = Math.hypot(vx, vy) || 1;
    var ux = vx / len, uy = vy / len;
    var wing = Math.max(3.2, len * 0.40);
    return [
      { x: headPx.x - ux * wing - uy * wing * 0.52, y: headPx.y - uy * wing + ux * wing * 0.52 },
      { x: headPx.x - ux * wing + uy * wing * 0.52, y: headPx.y - uy * wing - ux * wing * 0.52 }
    ];
  }

  /* ---------- turf palette ------------------------------------------------------------------ */

  /* Green colour, taken from the green.

     Sampling the putting surface gives a run of tones that already belong to this green on this
     day - mowing bands, wear, the shade under a lip. Tiering along that run can say "this end is
     high" in a colour the ground can actually be, instead of tinting it with a hue borrowed from
     a cartographic ramp. Measured on Jacks Point h3: 28829 sampled pixels run rgb(102,111,94) to
     rgb(159,154,141), and nothing outside that run is ever needed to draw five readable tiers.

     What gets stored is the RUN, not a picture: the principal axis of the colour cloud, the
     quantile breakpoints along it, and one averaged colour per bin. Baked once at export and
     carried in the frames index, so the export and the phone tier identically without either of
     them re-reading pixels - the same reason the contour maths lives in this file.

     The axis is the first principal component rather than luminance because turf does not vary
     along grey: it drifts warmer and lighter together, and a luminance ramp would cut across that
     drift and pick colours the green does not have.

     PALETTE_BINS is 32. The tail turns rank into colour by interpolating between bins, so the
     bins only have to be finer than the eye can step; 32 keeps a hole to ~130 numbers in an index
     that already carries per-hole geometry. */
  var PALETTE_BINS = 32;
  var PALETTE_MIN_SAMPLES = 400;

  /* Clip to the 2nd/98th percentile before building the run. The tails of a green's colour cloud
     are sprinkler heads, a ball mark, the odd bunker pixel the polygon clipped in - real colours,
     but not turf, and letting them define the ends would spend the whole run reaching them. */
  function sampleGreenPalette(rgb, count) {
    if (!rgb) return null;
    var n = count > 0 ? Math.floor(count) : Math.floor(rgb.length / 3);
    if (!(n >= PALETTE_MIN_SAMPLES)) return null;

    var i, k, mr = 0, mg = 0, mb = 0;
    for (i = 0; i < n; i++) { mr += rgb[i * 3]; mg += rgb[i * 3 + 1]; mb += rgb[i * 3 + 2]; }
    mr /= n; mg /= n; mb /= n;

    var c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) {
      var d0 = rgb[i * 3] - mr, d1 = rgb[i * 3 + 1] - mg, d2 = rgb[i * 3 + 2] - mb;
      c[0] += d0 * d0; c[1] += d0 * d1; c[2] += d0 * d2;
      c[4] += d1 * d1; c[5] += d1 * d2; c[8] += d2 * d2;
    }
    c[3] = c[1]; c[6] = c[2]; c[7] = c[5];
    for (i = 0; i < 9; i++) c[i] /= n;

    /* Power iteration: the covariance of a turf cloud is strongly dominated by its first
       component, so this converges long before 24 rounds and needs no eigen solver. */
    var v = [0.5773, 0.5773, 0.5773];
    for (k = 0; k < 24; k++) {
      var w0 = c[0] * v[0] + c[1] * v[1] + c[2] * v[2];
      var w1 = c[3] * v[0] + c[4] * v[1] + c[5] * v[2];
      var w2 = c[6] * v[0] + c[7] * v[1] + c[8] * v[2];
      var m = Math.sqrt(w0 * w0 + w1 * w1 + w2 * w2) || 1;
      v = [w0 / m, w1 / m, w2 / m];
    }
    if (v[0] + v[1] + v[2] < 0) v = [-v[0], -v[1], -v[2]];   // point the run at the lighter end

    var proj = new Float64Array(n);
    for (i = 0; i < n; i++) {
      proj[i] = (rgb[i * 3] - mr) * v[0] + (rgb[i * 3 + 1] - mg) * v[1] + (rgb[i * 3 + 2] - mb) * v[2];
    }
    var order = new Array(n);
    for (i = 0; i < n; i++) order[i] = i;
    order.sort(function (a, b) { return proj[a] - proj[b]; });

    var lo = Math.floor(n * 0.02), hi = Math.floor((n - 1) * 0.98);
    var span = hi - lo;
    if (!(span > PALETTE_BINS)) return null;

    var stops = [], lut = [];
    for (k = 0; k <= PALETTE_BINS; k++) {
      stops.push(Math.round(proj[order[lo + Math.round(span * k / PALETTE_BINS)]] * 100) / 100);
    }
    for (k = 0; k < PALETTE_BINS; k++) {
      var a = lo + Math.round(span * k / PALETTE_BINS);
      var b = Math.max(a + 1, lo + Math.round(span * (k + 1) / PALETTE_BINS));
      var sr = 0, sg = 0, sb = 0, cnt = 0;
      for (i = a; i < b; i++) { var j = order[i]; sr += rgb[j * 3]; sg += rgb[j * 3 + 1]; sb += rgb[j * 3 + 2]; cnt++; }
      lut.push(Math.round(sr / cnt), Math.round(sg / cnt), Math.round(sb / cnt));
    }
    /* The rank lookup inverts these stops, so they have to be strictly increasing. A plateau in
       the middle of the run is NORMAL - a green with a large evenly-mown area puts a lot of its
       pixels on one colour - so nudge those apart rather than refusing the green. Only a run with
       no spread at all (flat cloud, or a solid fill where there is no turf to read) is refused,
       and that is a genuine "there is no palette here" rather than a numerical inconvenience. */
    if (!(stops[stops.length - 1] > stops[0])) return null;
    for (k = 1; k < stops.length; k++) {
      if (!(stops[k] > stops[k - 1])) stops[k] = stops[k - 1] + 1e-4;
    }

    return {
      version: 1,
      bins: PALETTE_BINS,
      samples: n,
      mean: [Math.round(mr * 10) / 10, Math.round(mg * 10) / 10, Math.round(mb * 10) / 10],
      axis: [Math.round(v[0] * 10000) / 10000, Math.round(v[1] * 10000) / 10000, Math.round(v[2] * 10000) / 10000],
      stops: stops,
      lut: lut
    };
  }

  /* Where a colour sits along the run, 0..1. Piecewise-linear against the stored quantiles, so
     rank is the pixel's percentile among real turf rather than a linear read of brightness. */
  function paletteRank(pal, r, g, b) {
    var p = (r - pal.mean[0]) * pal.axis[0] + (g - pal.mean[1]) * pal.axis[1] + (b - pal.mean[2]) * pal.axis[2];
    var stops = pal.stops, last = stops.length - 1;
    if (p <= stops[0]) return 0;
    if (p >= stops[last]) return 1;
    var lo = 0, hi = last;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (p >= stops[mid]) lo = mid; else hi = mid; }
    var t = (p - stops[lo]) / ((stops[lo + 1] - stops[lo]) || 1e-9);
    return (lo + t) / last;
  }

  /* Colour at a rank. Past either end the run is CONTINUED along itself rather than clamped:
     clamping pins every over-driven pixel to one colour and flattens the tier it belongs to,
     whereas continuing keeps the steps apart in the same hue direction the turf already runs.
     It stops being a colour the green has, which is why the caller gates how far it may go. */
  function paletteColour(pal, t, out) {
    out = out || [0, 0, 0];
    var lut = pal.lut, bins = pal.bins || (lut.length / 3), lastBin = bins - 1;
    var i, e;
    if (t < 0 || t > 1) {
      var d0 = lut[lastBin * 3] - lut[0], d1 = lut[lastBin * 3 + 1] - lut[1], d2 = lut[lastBin * 3 + 2] - lut[2];
      e = t < 0 ? t : t - 1;
      i = t < 0 ? 0 : lastBin * 3;
      out[0] = Math.max(0, Math.min(255, lut[i] + e * d0));
      out[1] = Math.max(0, Math.min(255, lut[i + 1] + e * d1));
      out[2] = Math.max(0, Math.min(255, lut[i + 2] + e * d2));
      return out;
    }
    var f = t * lastBin, b0 = Math.floor(f), fr = f - b0, b1 = Math.min(lastBin, b0 + 1);
    out[0] = lut[b0 * 3] * (1 - fr) + lut[b1 * 3] * fr;
    out[1] = lut[b0 * 3 + 1] * (1 - fr) + lut[b1 * 3 + 1] * fr;
    out[2] = lut[b0 * 3 + 2] * (1 - fr) + lut[b1 * 3 + 2] * fr;
    return out;
  }

  /* Tiers. tiers=5 gives ~0.56m steps on a 2.8m green - four reads as shelves, six as a map.
     spread stretches the tier targets past the sampled ends; 0.2 measured 0% colour outside the
     green's own gamut on real ground, because the run was cut at the 2nd/98th percentile and
     there is real turf in the tails.

     strength is how far a pixel moves toward its tier, and it is NOT 1 for a reason worth
     stating. The palette reconstructs turf to about 1.2/255, so at strength 1 every pixel in a
     tier lands on the tier colour and the residual that carries mowing bands and wear is gone -
     the tier reads as a decal laid over the green rather than the green itself. Holding it at
     0.7 keeps roughly a third of the within-tier spread, which is what makes the paint look like
     ground. Tiers stay legible because the SEPARATION between them is set by spread, not by
     strength. */
  var PAINT_DEFAULTS = { tiers: 5, spread: 0.2, strength: 0.7 };

  function paintTargetForHeight(zNorm, cfg) {
    var tiers = Math.max(2, Math.round((cfg && cfg.tiers) || PAINT_DEFAULTS.tiers));
    var spread = (cfg && cfg.spread !== undefined) ? cfg.spread : PAINT_DEFAULTS.spread;
    var k = Math.max(0, Math.min(tiers - 1, Math.floor(zNorm * tiers)));
    return (k / (tiers - 1) - 0.5) * (1 + 2 * spread) + 0.5;
  }

  return {
    rasterProjector: rasterProjector,
    metricFrame: metricFrame,
    pointInPolygon: pointInPolygon,
    distanceToPolygon: distanceToPolygon,
    fitSurface: fitSurface,
    slopeAt: slopeAt,
    sampleGreenPalette: sampleGreenPalette,
    paletteRank: paletteRank,
    paletteColour: paletteColour,
    paintTargetForHeight: paintTargetForHeight,
    PAINT_DEFAULTS: PAINT_DEFAULTS,
    contours: contours,
    chainSegments: chainSegments,
    smoothPolyline: smoothPolyline,
    contourPaths: contourPaths,
    summarise: summarise,
    compassName: compassName,
    fitGreenSurface: fitGreenSurface,
    buildGreenDrawing: buildGreenDrawing,
    arrowWings: arrowWings,
    CONTOUR_DEFAULTS: CONTOUR_DEFAULTS
  };
});
