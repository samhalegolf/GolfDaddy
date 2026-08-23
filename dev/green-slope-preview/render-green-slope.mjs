/* Render green slope previews over real published captures.

     node dev/green-slope-preview/fetch-green-data.mjs     # once, to get the pixels
     node dev/green-slope-preview/render-green-slope.mjs   # writes ./out

   Contour lines only. The slope tint and the downhill flow lines were both tried and both cut:
   the tint saturates to a flat wash on any green steeper than the putting bands it was anchored
   to (Jacks Point h8 averages 5.8%, past the top of the ramp), and flow lines drawn at the same
   weight as contours turn the pair into a mesh you have to trace with a finger to read.

   What is left is the oldest way of drawing ground there is, and it carries the slope on its
   own: lines close together mean steep, far apart mean flat, and their shape is the shape of
   the surface. Nothing needs a legend.

   Seven treatments at one interval, since ink and spacing are separate questions.

   Dark greens ONLY - lines, fill, arrows and halos alike. Nothing light appears anywhere, so
   the drawing reads as part of the turf rather than as ink laid over a photograph. Height is
   carried by TONE inside that narrow dark range, never by climbing toward something brighter.

   The cost is stated plainly: a dark line on dark ground has no contrast to fall back on, so
   this palette depends on the green itself being the mid-toned part of the picture. It is the
   right bet on mown turf and it would be the wrong one over deep shade.

     a-deep          one deep green
     b-ramp          dark green shaded BY HEIGHT
     c-deep-supp     deep green, plus 5cm supplementary lines filling the gaps
     d-ramp-supp     the height ramp, plus the same fill
     e-deep-arrows   deep green + fill + short dense fall arrows
     f-ramp-arrows   the height ramp + fill + the same arrows
     g-ramp-one      the height ramp + fill + a single overall fall arrow
     z-raw           off the UNFITTED DEM - the control

   z-raw is the important one. It is the same elevation contoured without the surface fit, and
   it is the artefact gd-relief-core warns about, drawn on purpose. */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { decodeElevation } from "../../functions/lib/gd-relief-core.mjs";
import {
  projector, metricFrame, centroid, pointInPolygon, distanceToPolygon,
  fitSurface, contourPaths, slopeAt, summarise, compassName
} from "./green-surface.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const OUT = path.join(HERE, "out");
const TARGET_PX = 1000;
/* Ground included in the fit beyond the green edge.

   This was 7m, on the reasoning that a fit needs data past its edge or the edge wanders, and
   that the collar is where chipping happens anyway. Real greens killed it. On Jacks Point h1
   and h6 the residual went 0.07m -> 0.31m as the collar grew 0 -> 7m, and h6's reported fall
   went 1.7% -> 2.9%: a cubic cannot represent a putting surface AND a bunker face, so it
   splits the difference and gets both wrong. The synthetic fixture never showed this because
   it is smooth everywhere - the collar was free on invented ground and expensive on real ground.

   Zero is safe here specifically because nothing is ever drawn outside the polygon: flowLines
   and contours both clip to it with an inset. The edge-wander argument is about extrapolation,
   and there is no extrapolation. Raise this only alongside a scheme that downweights the
   collar rather than fitting it as equal evidence. */
const COLLAR_M = 0;
const MARGIN_M = 9;        // ground shown around the green in the picture

/* Interval is fixed per variant rather than fitted to each green's own range, and that is the
   whole point of drawing contours at all: a green with 0.8m of relief gets five lines and one
   with 2.9m gets nineteen, so the DENSITY carries the steepness. Normalising the count per
   green would throw that away and make a flat green look exactly like a severe one.

   Index every fourth line, so the heavier line is a round 40/60/100cm depending on variant and
   the eye gets a reference without counting. */
const INTERVAL_M = 0.15;
const INDEX_EVERY = 4;

/* Supplementary contours - the thin neutral lines that fill the empty ground.

   A fixed interval leaves a flat green nearly bare: spacing is interval/slope, so the gentler
   the ground the wider the gaps, and the part of the green with least to say ends up with the
   most blank space. Supplementary lines are the old survey answer to that - a finer interval
   drawn subordinate, present only where the main lines are too far apart to describe anything.

   Gated on the GAP ITSELF, not on a slope threshold. The first attempt used absolute slope and
   drew nothing: these greens average 3.3-5.8%, so a "flat ground" cutoff picked for putting
   surfaces in general excluded all of them. Gap width is the quantity actually being complained
   about, it is one divide away (spacing = interval / slope), and it is scale-honest - 3m of bare
   turf is a hole worth filling whether the green is gentle or severe.

   Honesty note. At 7.5cm these lines sit INSIDE the fit's own residual, which runs 0.05-0.13m
   on the greens measured so far. They are real iso-lines of the fitted surface and they are
   smooth and continuous, but the ground truth does not resolve to 7.5cm and they must never be
   drawn as though it does. Hence thin, neutral and unlabelled - texture and coverage, carrying
   no claim the main interval is not already making. */
const SUPP_DIVISOR = 3;          // 5cm between supplementary lines
const SUPP_GAP_FULL_M = 2.8;     // full strength once main lines are this far apart
const SUPP_GAP_NONE_M = 1.3;     // gone by here - the main lines already cover the ground
const SUPP_INK = "#1b3a23";
const SUPP_ALPHA = 0.26;
const SUPP_WIDTH = 0.72;
const SUPP_CHUNK = 6;            // points per constant-opacity run

/* Fall arrows.

   These are NOT the flow lines that were cut. That layer seeded a streamline every ~3m and made
   length proportional to slope, so on any steep shoulder the strokes overlapped into a comb and
   the picture turned into hair. The fix is a division of labour: the contours already say how
   steep the ground is, in the only way that needs no legend - their spacing. So an arrow has
   exactly one job left, which is direction, and it can therefore be CONSTANT size. Nothing about
   an arrow varies with magnitude and nothing bunches - which is what lets them be short and
   dense rather than long and sparse, since a short mark only has to point.

   Hung off the INDEX contours rather than scattered on a lattice. A lattice position is an
   arbitrary choice the picture cannot justify - why there and not 40cm left? - whereas a point
   on a contour is a place the drawing already commits to. Each arrow sits ON its line and points
   away downhill, so it reads as a property of that contour rather than as a second layer, and
   because a contour runs perpendicular to the fall by definition, the arrow always leaves it at
   a right angle with no extra work.

   Skipped where the ground is too flat for a direction to mean anything - on a shelf at 0.4% the
   fall bearing is real arithmetic and a lie about what a ball will do. */
const ARROW_ALONG_M = 7.5;       // distance between arrows ALONG an index contour
const ARROW_INSET_M = 2.0;
const ARROW_LEN_M = 1.6;
const ARROW_MIN_PERCENT = 1.0;
const ARROW_INK = "#0b2013";
const ARROW_HALO = "#050e08";
const ARROW_ALPHA = 0.44;

/* The ramp is the interesting one. A plain contour map cannot tell you which end is high - you
   either label the lines or you count them - and on a green that is the first thing you want to
   know. Shading each iso-line by its own level answers it at a glance: dark sits low, light sits
   high, and the eye reads the fall direction without a legend or a single number on the page. */
const INKS = {
  "a-deep":        { label: "deep green", halo: "#050e08", haloAlpha: 0.26, alpha: [0.34, 0.58], colour: () => "#0d2416" },
  "b-ramp":        { label: "dark green by height", halo: "#050e08", haloAlpha: 0.26, alpha: [0.40, 0.62], colour: t => rampGreen(t) },
  "c-deep-supp":   { label: "deep green + fill", halo: "#050e08", haloAlpha: 0.26, alpha: [0.34, 0.58], colour: () => "#0d2416", supplementary: true },
  "d-ramp-supp":   { label: "by height + fill", halo: "#050e08", haloAlpha: 0.26, alpha: [0.40, 0.62], colour: t => rampGreen(t), supplementary: true },
  "e-deep-arrows": { label: "deep green + fill + arrows", halo: "#050e08", haloAlpha: 0.26, alpha: [0.34, 0.58], colour: () => "#0d2416", supplementary: true, arrows: "sparse" },
  "f-ramp-arrows": { label: "by height + fill + arrows", halo: "#050e08", haloAlpha: 0.26, alpha: [0.40, 0.62], colour: t => rampGreen(t), supplementary: true, arrows: "sparse" },
  "g-ramp-one":    { label: "by height + fill + one overall arrow", halo: "#050e08", haloAlpha: 0.26, alpha: [0.40, 0.62], colour: t => rampGreen(t), supplementary: true, arrows: "single" }
};

/* All one family: dark green, low to high. The range is deliberately narrow and entirely at the
   dark end - this is variation WITHIN a shade, not a scale from dark to light. Height still
   reads, because tone separation of even this size is plainly visible once the lines sit next to
   each other, but no line ever gets bright enough to jump off the picture and become the subject.

   Dark rather than light because the turf underneath is mid-toned: a dark line has the whole
   bright half of the range to separate itself against, and it holds up over pale dormant grass
   and bunker sand alike, where a light line would wash out on both. */
const GREEN_STOPS = [
  { at: 0.00, rgb: [7, 18, 11] },
  { at: 0.45, rgb: [15, 34, 20] },
  { at: 0.75, rgb: [24, 50, 29] },
  { at: 1.00, rgb: [35, 68, 40] }
];
function rampGreen(t) {
  const u = Math.max(0, Math.min(1, t));
  let a = GREEN_STOPS[0], b = GREEN_STOPS[GREEN_STOPS.length - 1];
  for (let i = 1; i < GREEN_STOPS.length; i++) {
    if (u <= GREEN_STOPS[i].at) { a = GREEN_STOPS[i - 1]; b = GREEN_STOPS[i]; break; }
  }
  const span = (b.at - a.at) || 1;
  const k = (u - a.at) / span;
  const c = [0, 1, 2].map(i => Math.round(a.rgb[i] + (b.rgb[i] - a.rgb[i]) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

async function loadJson(file) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); }
  catch { return null; }
}

/* Where the base image sits on the earth. A green-surround capture carries its own bounds in
   the captures index; a hole frame carries them in its sidecar. */
function baseGeometry(hole, meta, baseKind, capturesIndex) {
  if (baseKind === "green-surround" && capturesIndex) {
    const entry = (capturesIndex.captures || []).find(
      c => c.role === "green-surround" && Number(c.holeNumber) === hole
    );
    if (entry && entry.bounds) {
      return { bounds: entry.bounds, width: entry.width, height: entry.height, label: `green capture z${entry.captureZoom}` };
    }
  }
  const dims = meta.playSurface?.outputDimensions || {};
  return { bounds: meta.bounds, width: dims.width || meta.width, height: dims.height || meta.height, label: "hole frame" };
}

async function renderHole(hole, capturesIndex) {
  const meta = await loadJson(`h${hole}.meta.json`);
  if (!meta) return null;
  const baseInfo = await loadJson(`h${hole}.base.json`);
  const elevMeta = meta.playSurface?.elevation;
  const greenShape = meta.playSurface?.anchorPins?.greenShape || [];
  if (!elevMeta || greenShape.length < 8) {
    console.log(`h${hole}: no elevation or no green polygon, skipped`);
    return null;
  }

  /* ---- elevation ---- */
  const elevRaw = await sharp(path.join(DATA, `h${hole}.elevation.png`), { limitInputPixels: false })
    .raw().toBuffer({ resolveWithObject: true });
  const decoded = decodeElevation(
    elevRaw.data, elevRaw.info.width, elevRaw.info.height, elevRaw.info.channels, elevMeta.encoding
  );
  const elevProject = projector(elevMeta.bounds, elevRaw.info.width, elevRaw.info.height);
  const heightAtPixel = (px, py) => {
    const x = Math.max(0, Math.min(elevRaw.info.width - 1, px));
    const y = Math.max(0, Math.min(elevRaw.info.height - 1, py));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(elevRaw.info.width - 1, x0 + 1), y1 = Math.min(elevRaw.info.height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const h = (a, b) => decoded.heights[b * elevRaw.info.width + a];
    return h(x0, y0) * (1 - fx) * (1 - fy) + h(x1, y0) * fx * (1 - fy)
         + h(x0, y1) * (1 - fx) * fy + h(x1, y1) * fx * fy;
  };

  /* ---- local metric frame + polygon ---- */
  const origin = centroid(greenShape);
  const frame = metricFrame(origin.lat, origin.lng);
  const polygon = greenShape.map(p => frame.toMetres(p.lat, p.lng));

  /* ---- samples: every DEM pixel whose centre lands in the green or its collar ---- */
  const samples = [];
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const bbox = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  const stepM = Number(elevMeta.metresPerPixel) || 1.7;
  for (let y = bbox.minY - COLLAR_M; y <= bbox.maxY + COLLAR_M; y += stepM) {
    for (let x = bbox.minX - COLLAR_M; x <= bbox.maxX + COLLAR_M; x += stepM) {
      const insideGreen = pointInPolygon(x, y, polygon);
      if (!insideGreen && distanceToPolygon(x, y, polygon) > COLLAR_M) continue;
      const ll = frame.toLatLng(x, y);
      const p = elevProject(ll.lat, ll.lng);
      if (p.x < 0 || p.y < 0 || p.x >= elevRaw.info.width || p.y >= elevRaw.info.height) continue;
      samples.push({ x, y, z: heightAtPixel(p.x, p.y) });
    }
  }

  const fit = fitSurface(samples, { order: 3, scale: 20 });
  if (!fit) { console.log(`h${hole}: fit did not converge (${samples.length} samples)`); return null; }
  const summary = summarise(fit, polygon, { metresPerSample: stepM });

  console.log(
    `h${String(hole).padEnd(3)} ${String(samples.length).padStart(4)} samples @${stepM.toFixed(2)}m  ` +
    `fall ${summary.meanSlopePercent.toFixed(2)}% toward ${compassName(summary.fallBearing)} ` +
    `(${summary.fallBearing.toFixed(0)}deg)  relief ${summary.reliefM.toFixed(2)}m  ` +
    `residual ${summary.residualRms.toFixed(3)}m (${summary.residualRatio.toFixed(1)}x q)  ` +
    `-> ${summary.confidence}${summary.reason ? ": " + summary.reason : ""}`
  );

  /* ---- base image + crop ---- */
  const geo = baseGeometry(hole, meta, baseInfo?.kind, capturesIndex);
  const baseProject = projector(geo.bounds, geo.width, geo.height);
  const cornersPx = [
    [bbox.minX - MARGIN_M, bbox.minY - MARGIN_M], [bbox.maxX + MARGIN_M, bbox.minY - MARGIN_M],
    [bbox.maxX + MARGIN_M, bbox.maxY + MARGIN_M], [bbox.minX - MARGIN_M, bbox.maxY + MARGIN_M]
  ].map(([x, y]) => { const ll = frame.toLatLng(x, y); return baseProject(ll.lat, ll.lng); });
  const cropLeft = Math.max(0, Math.floor(Math.min(...cornersPx.map(p => p.x))));
  const cropTop = Math.max(0, Math.floor(Math.min(...cornersPx.map(p => p.y))));
  const cropRight = Math.min(geo.width, Math.ceil(Math.max(...cornersPx.map(p => p.x))));
  const cropBottom = Math.min(geo.height, Math.ceil(Math.max(...cornersPx.map(p => p.y))));
  const cropW = cropRight - cropLeft, cropH = cropBottom - cropTop;
  if (cropW < 16 || cropH < 16) { console.log(`h${hole}: green falls outside the base image`); return null; }

  const scale = TARGET_PX / Math.max(cropW, cropH);
  const outW = Math.max(1, Math.round(cropW * scale));
  const outH = Math.max(1, Math.round(cropH * scale));
  const baseImg = await sharp(path.join(DATA, `h${hole}.base.jpg`), { limitInputPixels: false })
    .extract({ left: cropLeft, top: cropTop, width: cropW, height: cropH })
    .resize({ width: outW, height: outH, fit: "fill", kernel: "lanczos3" })
    .toBuffer();

  /* metric -> output pixel */
  const toOut = (x, y) => {
    const ll = frame.toLatLng(x, y);
    const p = baseProject(ll.lat, ll.lng);
    return { x: (p.x - cropLeft) * scale, y: (p.y - cropTop) * scale };
  };
  /* output pixel -> metric, for the per-pixel tint pass */
  const originOut = toOut(0, 0);
  const unitX = toOut(1, 0), unitY = toOut(0, 1);
  const ax = unitX.x - originOut.x, ay = unitX.y - originOut.y;
  const bx = unitY.x - originOut.x, by = unitY.y - originOut.y;
  const det = ax * by - ay * bx;
  const toMetric = (px, py) => {
    const dx = px - originOut.x, dy = py - originOut.y;
    return { x: (dx * by - dy * bx) / det, y: (ax * dy - ay * dx) / det };
  };

  /* ---- contour overlay ----

     Clipping is a feathered mask rather than a hard cut at the polygon: an iso-line that stops
     dead on an invisible boundary reads as a sticker laid over the picture. Fading the last
     metre lets the lines die into the surround the way a real contour map does at the edge of
     its survey. */
  const maskId = `green${hole}`;
  function greenMaskDefs() {
    const ring = polygon.map(p => { const o = toOut(p.x, p.y); return `${o.x.toFixed(1)},${o.y.toFixed(1)}`; }).join(" ");
    const featherPx = Math.max(2, Math.abs(toOut(1.4, 0).x - toOut(0, 0).x));
    return `<defs><filter id="${maskId}blur"><feGaussianBlur stdDeviation="${featherPx.toFixed(1)}"/></filter>`
      + `<mask id="${maskId}"><polygon points="${ring}" fill="#fff" filter="url(#${maskId}blur)"/></mask></defs>`;
  }

  /* Walk each index contour and drop an arrow every ARROW_ALONG_M of ground. Stepping by arc
     length rather than by vertex count matters: Chaikin leaves the smoothed line densely packed
     through curves and sparse on straights, so counting vertices would cluster every arrow into
     the bends. */
  function marksOnIndexLines(paths, interval, indexEvery) {
    const marks = [];
    for (const c of paths) {
      if (Math.abs(Math.round(c.level / interval)) % indexEvery !== 0) continue;
      let since = ARROW_ALONG_M * 0.5;   // half a step in, so lines do not all start with one
      for (let i = 1; i < c.points.length; i++) {
        const a = c.points[i - 1], b = c.points[i];
        since += Math.hypot(b.x - a.x, b.y - a.y);
        if (since < ARROW_ALONG_M) continue;
        since = 0;
        if (distanceToPolygon(b.x, b.y, polygon) < ARROW_INSET_M) continue;
        const g = fit.gradientAt(b.x, b.y);
        const mag = Math.hypot(g.dx, g.dy);
        if (mag * 100 < ARROW_MIN_PERCENT) continue;
        marks.push({ x: b.x, y: b.y, dx: -g.dx / mag, dy: -g.dy / mag, attach: true });
      }
    }
    return marks;
  }

  /* The whole green in one mark, at the area-weighted mean fall. */
  function singleFallMark() {
    const cx = polygon.reduce((a, p) => a + p.x, 0) / polygon.length;
    const cy = polygon.reduce((a, p) => a + p.y, 0) / polygon.length;
    const rad = (summary.fallBearing * Math.PI) / 180;
    return { x: cx, y: cy, dx: Math.sin(rad), dy: Math.cos(rad), lenM: 9.0, weight: 2.6 };
  }

  function contourSvg({ ink, raw = false, supplementary = false, arrows = false }) {
    /* `contourPaths` only ever calls heightAt, so the control is the same drawing code handed a
       surface that reads the DEM directly instead of the fit. That is the honest comparison -
       one variable changed, nothing else. */
    const surface = raw
      ? { heightAt: (x, y) => { const ll = frame.toLatLng(x, y); const e = elevProject(ll.lat, ll.lng); return heightAtPixel(e.x, e.y); } }
      : fit;
    const paths = contourPaths(surface, polygon, { interval: INTERVAL_M, cell: 0.35 });

    /* Normalised against the levels actually drawn, not against the fitted surface's full range:
       the extremes of a cubic can sit outside the polygon entirely, and normalising to them
       would compress every visible line into the middle of the ramp. */
    const levels = paths.map(c => c.level);
    const lo = Math.min(...levels), hi = Math.max(...levels);
    const span = (hi - lo) || 1;

    const parts = [greenMaskDefs(), `<g mask="url(#${maskId})" fill="none" stroke-linecap="round" stroke-linejoin="round">`];
    /* Halo underneath every line first, then every line on top, so one contour's edge never
       lands over its neighbour's stroke where two run close together.

       The halo used to be near-white and did the real legibility work - a light edge under a
       dark line survives any background. With the palette held to dark greens only, it can no
       longer do that job, and what is left is a soft shadow: it still separates a line from
       pale ground like bunker sand, and it still keeps neighbouring lines from merging, but it
       cannot rescue a dark line sitting on dark ground. That case is now handled by staying off
       dark ground - the mask stops at the green - rather than by contrast. */
    for (const pass of ["halo", "ink"]) {
      for (const c of paths) {
        const index = Math.abs(Math.round(c.level / INTERVAL_M)) % INDEX_EVERY === 0;
        const d = "M" + c.points.map(p => { const o = toOut(p.x, p.y); return `${o.x.toFixed(1)} ${o.y.toFixed(1)}`; }).join("L");
        const w = index ? 2.1 : 1.1;
        parts.push(pass === "halo"
          ? `<path d="${d}" stroke="${ink.halo}" stroke-opacity="${ink.haloAlpha}" stroke-width="${(w + 1.8).toFixed(2)}"/>`
          : `<path d="${d}" stroke="${ink.colour((c.level - lo) / span)}" stroke-opacity="${index ? ink.alpha[1] : ink.alpha[0]}" stroke-width="${w}"/>`);
      }
    }
    /* Supplementary pass. Opacity is resolved per short run rather than per line, so one line
       can be present across a flat shoulder and gone by the time it reaches the fall. */
    if (supplementary && !raw) {
      const fine = INTERVAL_M / SUPP_DIVISOR;
      const supp = contourPaths(surface, polygon, { interval: fine, cell: 0.35, minLengthM: 2.2 });
      for (const c of supp) {
        /* Skip the levels that ARE main contours - drawing both puts a thin pale line exactly
           under a heavy one, which just dirties its edge. */
        const onMain = Math.abs(c.level / INTERVAL_M - Math.round(c.level / INTERVAL_M)) < 1e-6;
        if (onMain) continue;
        for (let i = 0; i < c.points.length - 1; i += SUPP_CHUNK) {
          const run = c.points.slice(i, Math.min(c.points.length, i + SUPP_CHUNK + 1));
          if (run.length < 2) continue;
          const mid = run[run.length >> 1];
          const pct = slopeAt(fit, mid.x, mid.y).percent;
          /* Ground distance between neighbouring MAIN contours here. */
          const gapM = INTERVAL_M / Math.max(pct / 100, 1e-4);
          const fade = Math.max(0, Math.min(1, (gapM - SUPP_GAP_NONE_M) / (SUPP_GAP_FULL_M - SUPP_GAP_NONE_M)));
          if (fade <= 0.02) continue;
          const d = "M" + run.map(p => { const o = toOut(p.x, p.y); return `${o.x.toFixed(1)} ${o.y.toFixed(1)}`; }).join("L");
          parts.push(`<path d="${d}" stroke="${SUPP_INK}" stroke-opacity="${(SUPP_ALPHA * fade).toFixed(3)}" stroke-width="${SUPP_WIDTH}"/>`);
        }
      }
    }

    /* Arrows last, so they sit over the line work rather than under it. */
    if (arrows) {
      const marks = arrows === "single" ? [singleFallMark()] : marksOnIndexLines(paths, INTERVAL_M, INDEX_EVERY);
      for (const m of marks) {
        if (!m) continue;
        /* An attached arrow starts AT the contour and runs downhill from it; a free one (the
           single overall mark) straddles its point instead. */
        const L = m.lenM || ARROW_LEN_M;
        const back = m.attach ? 0 : L / 2;
        const fwd = m.attach ? L : L / 2;
        const tail = toOut(m.x - m.dx * back, m.y - m.dy * back);
        const head = toOut(m.x + m.dx * fwd, m.y + m.dy * fwd);
        /* Chevron built in OUTPUT space off the drawn direction, so the head stays a sane size
           and a true right angle no matter how the metric frame lands on the pixels. */
        const vx = head.x - tail.x, vy = head.y - tail.y;
        const len = Math.hypot(vx, vy) || 1;
        const ux = vx / len, uy = vy / len;
        const wing = Math.max(3.2, len * 0.40);
        const p1 = `${(head.x - ux * wing + -uy * wing * 0.52).toFixed(1)} ${(head.y - uy * wing + ux * wing * 0.52).toFixed(1)}`;
        const p2 = `${(head.x - ux * wing - -uy * wing * 0.52).toFixed(1)} ${(head.y - uy * wing - ux * wing * 0.52).toFixed(1)}`;
        const d = `M${tail.x.toFixed(1)} ${tail.y.toFixed(1)}L${head.x.toFixed(1)} ${head.y.toFixed(1)}M${p1}L${head.x.toFixed(1)} ${head.y.toFixed(1)}L${p2}`;
        const w = m.weight || 1.25;
        parts.push(`<path d="${d}" stroke="${ARROW_HALO}" stroke-opacity="0.26" stroke-width="${(w + 1.7).toFixed(2)}"/>`);
        parts.push(`<path d="${d}" stroke="${ARROW_INK}" stroke-opacity="${ARROW_ALPHA}" stroke-width="${w}"/>`);
      }
    }

    parts.push("</g>");
    return { svg: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">${parts.join("")}</svg>`), count: paths.length };
  }

  function captionSvg(text, sub) {
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}">` +
      `<rect x="0" y="${outH - 62}" width="${outW}" height="62" fill="#0b120e" fill-opacity="0.62"/>` +
      `<text x="16" y="${outH - 36}" font-family="Helvetica,Arial,sans-serif" font-size="19" fill="#ffffff">${esc(text)}</text>` +
      `<text x="16" y="${outH - 15}" font-family="Helvetica,Arial,sans-serif" font-size="14" fill="#c8d6cc">${esc(sub)}</text>` +
      `</svg>`
    );
  }

  await mkdir(OUT, { recursive: true });
  const written = [];
  const sub = `${summary.meanSlopePercent.toFixed(1)}% toward ${compassName(summary.fallBearing)} · relief ${summary.reliefM.toFixed(2)}m · ${samples.length} samples @${stepM.toFixed(2)}m · ${summary.confidence}`;

  for (const [name, ink] of Object.entries(INKS)) {
    const file = path.join(OUT, `h${hole}-${name}.png`);
    await sharp(baseImg).composite([
      { input: contourSvg({ ink, supplementary: !!ink.supplementary, arrows: ink.arrows || false }).svg },
      { input: captionSvg(`h${hole} — ${ink.label}, ${(INTERVAL_M * 100).toFixed(0)}cm (${geo.label})`, sub) }
    ]).png().toBuffer().then(b => writeFile(file, b));
    written.push(file);
  }

  /* The control: the same interval contoured off the raw DEM, no fit. The staircases this draws
     are the 0.1m terrain-RGB quantisation steps, not ground. */
  const rawFile = path.join(OUT, `h${hole}-z-raw.png`);
  await sharp(baseImg).composite([
    { input: contourSvg({ ink: INKS["a-deep"], raw: true }).svg },
    { input: captionSvg(`h${hole} — contours off the UNFITTED DEM`, `the control: same elevation, no surface fit — these steps are quantisation, not ground`) }
  ]).png().toBuffer().then(b => writeFile(rawFile, b));
  written.push(rawFile);

  return { hole, summary, samples: samples.length, stepM, written, label: geo.label };
}

async function main() {
  const capturesIndex = await loadJson("captures-index.json");
  let files;
  try { files = await readdir(DATA); }
  catch { console.error("no data directory - run fetch-green-data.mjs first"); process.exit(1); }
  const holes = [...new Set(files.map(f => (f.match(/^h(\d+)\.meta\.json$/) || [])[1]).filter(Boolean))]
    .map(Number).sort((a, b) => a - b);
  if (!holes.length) { console.error("no hole data found - run fetch-green-data.mjs first"); process.exit(1); }

  console.log(`rendering ${holes.length} greens\n`);
  const results = [];
  for (const hole of holes) {
    const r = await renderHole(hole, capturesIndex).catch(e => {
      console.log(`h${hole}: ${String(e && e.message || e)}`);
      return null;
    });
    if (r) results.push(r);
  }
  console.log(`\n${results.reduce((n, r) => n + r.written.length, 0)} images in ${path.relative(process.cwd(), OUT)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
