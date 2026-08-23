/* Render green slope previews over real published captures.

     node dev/green-slope-preview/fetch-green-data.mjs     # once, to get the pixels
     node dev/green-slope-preview/render-green-slope.mjs   # writes ./out

   Five variants per green, so the question "how subtle is subtle enough" can be answered by
   looking rather than by arguing:

     1-whisper    flow lines only, barely there
     2-subtle     flow lines + a faint slope tint          <- the proposal
     3-contours   flow lines + 15cm contours
     4-strong     everything turned up, to show where it stops being tasteful
     5-naive      per-pixel slope straight off the DEM, no fit - the control

   Variant 5 is the important one. It is what this feature looks like if the surface is not
   fitted, and it is the reason the rest of the pipeline exists. */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { decodeElevation } from "../../functions/lib/gd-relief-core.mjs";
import {
  projector, metricFrame, centroid, pointInPolygon, distanceToPolygon,
  fitSurface, slopeAt, flowLines, contours, summarise, compassName
} from "./green-surface.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, "data");
const OUT = path.join(HERE, "out");
const TARGET_PX = 1000;
const COLLAR_M = 7;        // ground included in the fit beyond the green edge
const MARGIN_M = 9;        // ground shown around the green in the picture

/* Muted on purpose. A saturated ramp over an aerial photograph reads as a weather map laid on
   a golf course; these are pulled toward the colours already in the picture so the tint looks
   like light on the turf rather than a sticker over it.

   CONTINUOUS, not banded. Discrete bands were the first thing tried and they are exactly the
   silly look worth avoiding: hard colour steps across a smooth surface draw contour rings that
   the ground does not have, and the eye reads the step edges as features. Interpolating
   between the stops keeps the same information with nothing to catch on. */
const STOPS = [
  { at: 0.0, rgb: [122, 168, 158], alpha: 0.00 },
  { at: 1.2, rgb: [122, 168, 158], alpha: 0.13 },
  { at: 2.2, rgb: [206, 186, 126], alpha: 0.21 },
  { at: 3.2, rgb: [193, 138, 92], alpha: 0.27 },
  { at: 4.8, rgb: [176, 96, 72], alpha: 0.33 }
];
function rampFor(percent) {
  if (percent <= STOPS[0].at) return STOPS[0];
  const last = STOPS[STOPS.length - 1];
  if (percent >= last.at) return last;
  for (let i = 1; i < STOPS.length; i++) {
    const a = STOPS[i - 1], b = STOPS[i];
    if (percent > b.at) continue;
    const t = (percent - a.at) / (b.at - a.at);
    return {
      rgb: [0, 1, 2].map(c => a.rgb[c] + (b.rgb[c] - a.rgb[c]) * t),
      alpha: a.alpha + (b.alpha - a.alpha) * t
    };
  }
  return last;
}

const STYLES = {
  "1-whisper": { tint: 0, lineAlpha: 0.50, lineWidth: 2.6, contour: false, spacing: 4.0 },
  "2-subtle": { tint: 1.0, lineAlpha: 0.62, lineWidth: 3.0, contour: false, spacing: 3.4 },
  "3-contours": { tint: 0.6, lineAlpha: 0.58, lineWidth: 2.8, contour: true, spacing: 3.8 },
  "4-strong": { tint: 2.0, lineAlpha: 0.9, lineWidth: 4.0, contour: true, spacing: 2.4 }
};

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

  /* ---- tint layer: slope colour inside the green, feathered at the edge ---- */
  function tintLayer(strength, naive) {
    const buf = Buffer.alloc(outW * outH * 4, 0);
    const featherM = 1.1;
    for (let py = 0; py < outH; py++) {
      for (let px = 0; px < outW; px++) {
        const m = toMetric(px + 0.5, py + 0.5);
        if (!pointInPolygon(m.x, m.y, polygon)) continue;
        /* Feathering matters more than it sounds: a hard polygon edge makes the overlay look
           like a decal stuck on the picture rather than a property of the ground. */
        const edge = Math.min(1, distanceToPolygon(m.x, m.y, polygon) / featherM);
        let percent;
        if (naive) {
          const ll = frame.toLatLng(m.x, m.y);
          const p = elevProject(ll.lat, ll.lng);
          const d = stepM;
          const llx = frame.toLatLng(m.x + d, m.y), lly = frame.toLatLng(m.x, m.y + d);
          const lmx = frame.toLatLng(m.x - d, m.y), lmy = frame.toLatLng(m.x, m.y - d);
          const at = (q) => { const e = elevProject(q.lat, q.lng); return heightAtPixel(e.x, e.y); };
          void p;
          percent = Math.hypot((at(llx) - at(lmx)) / (2 * d), (at(lly) - at(lmy)) / (2 * d)) * 100;
        } else {
          percent = slopeAt(fit, m.x, m.y).percent;
        }
        const band = rampFor(percent);
        const a = Math.min(1, band.alpha * strength) * edge;
        if (a <= 0) continue;
        const i = (py * outW + px) * 4;
        buf[i] = band.rgb[0]; buf[i + 1] = band.rgb[1]; buf[i + 2] = band.rgb[2];
        buf[i + 3] = Math.round(a * 255);
      }
    }
    return { input: buf, raw: { width: outW, height: outH, channels: 4 } };
  }

  /* ---- vector overlay ---- */
  function overlaySvg(style) {
    const parts = [];
    if (style.contour) {
      const segs = contours(fit, polygon, { interval: 0.15, cell: 0.4 });
      segs.forEach(s => {
        const a = toOut(s.a.x, s.a.y), b = toOut(s.b.x, s.b.y);
        /* Every other line heavier, so the eye gets a 30cm reference without counting. */
        const index = Math.abs(Math.round(s.level / 0.15)) % 2 === 0;
        parts.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="#ffffff" stroke-opacity="${index ? 0.34 : 0.17}" stroke-width="${index ? 1.5 : 1.0}"/>`);
      });
    }

    const lines = flowLines(fit, polygon, { spacing: style.spacing });
    lines.forEach(line => {
      const pts = line.points.map(p => toOut(p.x, p.y));
      const K = pts.length - 1;
      /* Fainter where the ground is nearly flat. Length already carries magnitude; carrying it
         in opacity too is what makes the layer fade out of the way on a flat green instead of
         covering it in evenly-confident marks. */
      const strength = Math.min(1, 0.4 + line.slopePercent / 3.5);
      for (let k = 0; k < K; k++) {
        const t = k / K;
        /* Thickest at the downhill end so the stroke reads as travelling that way. */
        const w = style.lineWidth * (0.25 + 0.75 * t);
        const alpha = style.lineAlpha * strength * (0.3 + 0.7 * t);
        const a = pts[k], b = pts[k + 1];
        const seg = `x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"`;
        /* Dark under-stroke: white alone disappears on pale turf and on bunker sand. */
        parts.push(`<line ${seg} stroke="#0d1a12" stroke-opacity="${(alpha * 0.4).toFixed(3)}" stroke-width="${(w + 1.4).toFixed(2)}" stroke-linecap="round"/>`);
        parts.push(`<line ${seg} stroke="#ffffff" stroke-opacity="${alpha.toFixed(3)}" stroke-width="${w.toFixed(2)}" stroke-linecap="round"/>`);
      }
      const head = pts[pts.length - 1];
      parts.push(`<circle cx="${head.x.toFixed(1)}" cy="${head.y.toFixed(1)}" r="${(style.lineWidth * 0.55).toFixed(2)}" fill="#ffffff" fill-opacity="${(style.lineAlpha * strength).toFixed(3)}"/>`);
    });

    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">${parts.join("")}</svg>`
    );
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

  for (const [name, style] of Object.entries(STYLES)) {
    const layers = [];
    if (style.tint > 0) layers.push(tintLayer(style.tint, false));
    layers.push({ input: overlaySvg(style) });
    layers.push({ input: captionSvg(`h${hole} — ${name.slice(2)} (${geo.label})`, sub) });
    const file = path.join(OUT, `h${hole}-${name}.png`);
    await sharp(baseImg).composite(layers).png().toBuffer().then(b => writeFile(file, b));
    written.push(file);
  }

  /* The control: no fit, just the DEM differenced pixel to pixel. */
  const naiveFile = path.join(OUT, `h${hole}-5-naive.png`);
  await sharp(baseImg)
    .composite([
      tintLayer(1.0, true),
      { input: captionSvg(`h${hole} — naive per-pixel slope, NO surface fit`, `this is the same elevation data without the fit — noise, not slope`) }
    ])
    .png().toBuffer().then(b => writeFile(naiveFile, b));
  written.push(naiveFile);

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
