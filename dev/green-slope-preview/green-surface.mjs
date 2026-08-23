/* Green surface fitting and flow-line generation. Pure maths - no I/O, no sharp, no network,
   so it can be tested on a synthetic green with known slope. Prototype for the eventual
   functions/lib/gd-green-surface-core.mjs.

   THE PROBLEM THIS SOLVES. A green falls maybe a metre over thirty. The DEM behind it samples
   every ~1.7m and quantises height to 0.1m, so the rise between two adjacent samples is
   comparable to a single quantisation step. Differencing neighbours - which is what a normal
   slope raster does - therefore returns the quantisation pattern, not the ground. It looks
   like slope. It is noise.

   What rescues it is that a green is a SMOOTH surface. Fit a low-order polynomial through all
   ~400 samples at once and the quantisation, being zero-mean, averages down by roughly the
   square root of the sample count; the fitted gradient is then a real measurement. Every
   direction and steepness this module reports is read off the fitted surface analytically,
   never off pixel differences.

   Order 3 is a deliberate ceiling. It can express the things a green actually does - overall
   tilt, a crown, a saddle, one tier - and cannot express the things the data cannot support.
   Raising it would make the residual smaller and the answer worse. */

/* ---------- geometry ---------------------------------------------------------------------- */

export function world(lat, lng) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/* lat/lng -> pixel inside a north-up mercator image of known bounds. Exact rather than a
   linear lat interpolation, because the image IS a mercator crop. */
export function projector(bounds, width, height) {
  const nw = world(bounds.north, bounds.west);
  const se = world(bounds.south, bounds.east);
  const dx = se.x - nw.x, dy = se.y - nw.y;
  return (lat, lng) => {
    const w = world(lat, lng);
    return { x: ((w.x - nw.x) / dx) * width, y: ((w.y - nw.y) / dy) * height };
  };
}

/* Local metric frame: metres east and metres north of an origin. Over a green the flat-earth
   approximation is exact to well under a millimetre. */
export function metricFrame(originLat, originLng) {
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return {
    toMetres: (lat, lng) => ({ x: (lng - originLng) * mPerLng, y: (lat - originLat) * mPerLat }),
    toLatLng: (x, y) => ({ lat: originLat + y / mPerLat, lng: originLng + x / mPerLng })
  };
}

export function centroid(points) {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distanceToPolygon(x, y, poly) {
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

/* Exponent pairs for a complete 2D polynomial of the given order, lowest first. */
function terms(order) {
  const out = [];
  for (let total = 0; total <= order; total++) {
    for (let i = total; i >= 0; i--) out.push([i, total - i]);
  }
  return out;
}

/* Gaussian elimination with partial pivoting. The system is (order+1)(order+2)/2 square -
   10 for order 3 - so nothing fancier is warranted. */
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
 * Coordinates are normalised by `scale` before fitting - without it the cubic terms of a
 * 30m green carry values around 27000 and the normal equations lose most of their precision.
 *
 * Robustness is Tukey biweight over three reweighting passes. It exists for a specific
 * failure: a bunker lip, a cart path or a tree crown caught inside the collar is a real
 * feature of the DEM and a lie about the putting surface, and least squares would tilt the
 * whole green to accommodate it.
 *
 * @returns {{coeffs:number[], order:number, scale:number, residualRms:number,
 *            sampleCount:number, gradientAt:Function, heightAt:Function}}
 */
export function fitSurface(samples, { order = 3, scale = 20, robustPasses = 3 } = {}) {
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
    const sigma = 1.4826 * mad;
    const c = 4.685 * sigma;
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
     it is a silent factor-of-20 error in every slope this module reports. */
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
export function slopeAt(fit, x, y) {
  const { dx, dy } = fit.gradientAt(x, y);
  const magnitude = Math.hypot(dx, dy);
  /* Downhill is the negative gradient. Bearing measured clockwise from north, which is +y. */
  const bearing = (((Math.atan2(-dx, -dy) * 180) / Math.PI) + 360) % 360;
  return { percent: magnitude * 100, bearing, dx, dy };
}

/* ---------- flow lines --------------------------------------------------------------------- */

/**
 * Streamlines running downhill across the green.
 *
 * Seeded on a jittered lattice rather than a regular one: a regular grid of arrows reads as a
 * weather map, and the eye locks onto the lattice instead of the flow. Jitter breaks that up
 * while keeping the coverage even.
 *
 * Length scales with slope and lines stop below `minSlopePercent`, so a flat green grows
 * almost nothing and a steep one fills in. That is the property that makes the layer feel
 * like information rather than decoration - it is absent exactly where there is nothing to
 * say.
 */
export function flowLines(fit, polygon, {
  spacing = 3.4,
  jitter = 0.45,
  step = 0.7,
  minSteps = 7,
  maxSteps = 24,
  minSlopePercent = 0.7,
  edgeInset = 1.2,
  seed = 12345
} = {}) {
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  /* Deterministic jitter: the same green must draw the same lines every time it renders, or
     two exports of one course disagree about where the flow is. */
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const inside = (x, y) => pointInPolygon(x, y, polygon) && distanceToPolygon(x, y, polygon) >= edgeInset;

  const lines = [];
  for (let y = minY; y <= maxY; y += spacing) {
    for (let x = minX; x <= maxX; x += spacing) {
      const sx = x + (rand() - 0.5) * spacing * 2 * jitter;
      const sy = y + (rand() - 0.5) * spacing * 2 * jitter;
      if (!inside(sx, sy)) continue;

      const start = slopeAt(fit, sx, sy);
      if (start.percent < minSlopePercent) continue;

      /* Longer where steeper, so line length itself carries magnitude - but with a floor.
         Pure proportionality made every line on a 1.8% green about 2m long, which reads as
         scratches in the turf rather than as flow; a stroke needs a certain length before the
         eye follows it at all. Magnitude still shows, it just rides on top of a readable
         minimum. */
      const steps = Math.max(minSteps, Math.min(maxSteps, Math.round(minSteps + start.percent * 3.2)));
      const pts = [{ x: sx, y: sy }];
      let cx = sx, cy = sy;
      for (let s = 0; s < steps; s++) {
        /* RK2 - midpoint. Euler visibly cuts corners on a curving fall line at this step size. */
        const g1 = fit.gradientAt(cx, cy);
        const m1 = Math.hypot(g1.dx, g1.dy);
        if (m1 < 1e-9) break;
        const hx = cx - (g1.dx / m1) * step * 0.5;
        const hy = cy - (g1.dy / m1) * step * 0.5;
        const g2 = fit.gradientAt(hx, hy);
        const m2 = Math.hypot(g2.dx, g2.dy);
        if (m2 < 1e-9) break;
        cx -= (g2.dx / m2) * step;
        cy -= (g2.dy / m2) * step;
        if (!inside(cx, cy)) break;
        pts.push({ x: cx, y: cy });
      }
      if (pts.length < 3) continue;
      lines.push({ points: pts, slopePercent: start.percent, bearing: start.bearing });
    }
  }
  return lines;
}

/* ---------- contours ----------------------------------------------------------------------- */

/* Marching squares over the FITTED surface, sampled on a fine lattice. Contouring the raw DEM
   instead is what produces the concentric-ring artefact gd-relief-core warns about: those
   rings are the 0.1m quantisation steps drawn as terrain. */
export function contours(fit, polygon, { interval = 0.15, cell = 0.5 } = {}) {
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
    for (let i = 0; i < cols; i++) row.push(fit.heightAt(gx(i), gy(j)));
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
   shared endpoints back into continuous polylines, one per iso-line.

   Endpoints match EXACTLY rather than approximately - two adjacent cells interpolate the
   crossing on their shared edge from the same two corner heights, so the arithmetic is
   identical - which is why a rounded key works and no tolerance search is needed. */
export function chainSegments(segments, { quantum = 1e-7 } = {}) {
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
      /* Grow from the tail, then from the head, so an open line is found whole no matter
         which of its segments was picked up first. */
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
   not ground. Two passes removes them without pulling the line off the surface it came from;
   more starts rounding off real tier noses. */
export function smoothPolyline(points, { passes = 2, closed = false } = {}) {
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
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
  return total;
}

/**
 * Iso-lines over the green as smooth, continuous polylines - the drawable form of `contours`.
 *
 * `minLengthM` drops the stubs left where an iso-line clips the polygon edge. They are real
 * crossings, but a 40cm fragment of contour reads as a scratch in the turf rather than as
 * ground, and a dozen of them around the rim make the whole overlay look like dirt on a lens.
 */
export function contourPaths(fit, polygon, { interval = 0.15, cell = 0.4, minLengthM = 1.6, passes = 2 } = {}) {
  return chainSegments(contours(fit, polygon, { interval, cell }))
    .filter(c => c.points.length >= 3 && polylineLength(c.points) >= minLengthM)
    .map(c => ({ ...c, points: smoothPolyline(c.points, { passes, closed: c.closed }) }));
}

/* ---------- summary ------------------------------------------------------------------------ */

/* The numbers a caller would publish alongside the picture, and the confidence gate.

   `confidence` is the part that matters. A residual far above the DEM's own quantisation means
   the fit is describing something that is not a putting surface - a bad mask, a tree, junk
   elevation. A residual far BELOW it means the source had no detail to begin with: coarse
   national DEM upsampled to a fine grid is almost perfectly smooth, and fits beautifully while
   knowing nothing. Both must refuse to draw. Showing nothing is a fine outcome; showing a
   confident wrong read of a green is not. */
export function summarise(fit, polygon, { quantisationM = 0.1, metresPerSample = 1.7 } = {}) {
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
  const pct = p => slopes[Math.min(slopes.length - 1, Math.floor(slopes.length * p))];

  /* The expected residual if the ONLY error were uniform quantisation. */
  const quantisationRms = quantisationM / Math.sqrt(12);
  const ratio = fit.residualRms / quantisationRms;
  let confidence = "good";
  let reason = "";
  if (fit.sampleCount < 60) { confidence = "low"; reason = `only ${fit.sampleCount} elevation samples inside the green`; }
  else if (ratio > 6) { confidence = "low"; reason = `residual ${fit.residualRms.toFixed(3)}m is ${ratio.toFixed(1)}x quantisation - the mask or the elevation is wrong`; }
  else if (ratio < 0.35) { confidence = "low"; reason = `residual ${fit.residualRms.toFixed(3)}m is far below quantisation - source is smoother than its grid, so this is upsampled coarse DEM`; }
  else if (fit.sampleCount < 150) { confidence = "fair"; reason = `${fit.sampleCount} samples at ~${metresPerSample.toFixed(2)}m spacing`; }

  return {
    fallBearing,
    meanSlopePercent: Math.hypot(meanDx, meanDy) * 100,
    medianSlopePercent: pct(0.5),
    p90SlopePercent: pct(0.9),
    reliefM: highest.h - lowest.h,
    lowest, highest,
    residualRms: fit.residualRms,
    quantisationRms,
    residualRatio: ratio,
    sampleCount: fit.sampleCount,
    confidence, reason
  };
}

export function compassName(bearing) {
  const names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round(bearing / 22.5) % 16];
}
