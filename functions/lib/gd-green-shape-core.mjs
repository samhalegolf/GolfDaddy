/* Green Shape (Green Wand) engine. Server-side, and now the only copy.
   
   It began as a near-verbatim port of scripts/gd-green-shape-engine.js, kept
   deliberately diffable against it. That browser file has been deleted: the
   AutoMapper moved fully server-side (gd-automapper-core.mjs), which left the
   client engine with no caller, and a 700-line copy nothing runs is a copy that
   drifts silently. This file is the owner now, so edit it directly rather than
   looking for a client original to match.

   Two functions in the original touched the DOM and did not survive the port:
     - toCanvasImageSource(image) - a no-op passthrough, deleted (nothing to pass through)
     - analyzeGreenWand(image,width,height,options) - built two <canvas> elements, applied a
       CSS `filter` string via ctx.filter, and read back ImageData. Replaced below with a
       sharp-based renderFilteredBuffers() that reproduces the same six-filter chain
       (buildFilterString) as libvips ops.

   CALIBRATION, still open: sharp's ops are not bit-identical to Canvas 2D's `filter` CSS
   property, so these polygons were never calibrated against the browser's output on real
   imagery. The reference implementation that comparison would have run against now exists
   only in git history. Treat the numbers as uncalibrated rather than verified. */

import sharp from "sharp";

const GREEN_WAND_MODE_PRESETS = {
  robustTonal: {
    key: "robustTonal", label: "Robust Tonal",
    description: "Balanced tonal default for most courses. Good first mode when the edge ridge is visible but not extreme.",
    sensitivityRange: { min: 58, max: 79, preset: 68 }, baseBubbleSize: 61, clusterPull: 100,
    filters: { grayscale: 100, contrast: 170, brightness: 100, saturate: 40, blur: 1, invert: 0 }
  },
  stableHold: {
    key: "stableHold", label: "Stable Hold",
    description: "Calmer hold for when the fit is close but looks jumpy or choppy. Keeps the same tonal family with softer pull.",
    sensitivityRange: { min: 65, max: 85, preset: 76 }, baseBubbleSize: 61, clusterPull: 62,
    filters: { grayscale: 100, contrast: 170, brightness: 100, saturate: 40, blur: 1, invert: 0 }
  },
  aggressiveRidge: {
    key: "aggressiveRidge", label: "Aggressive Ridge Snap",
    description: "For strong visible white-dot ridges. Pulls hard and reacts more aggressively to the edge line.",
    sensitivityRange: { min: 80, max: 100, preset: 90 }, baseBubbleSize: 60, clusterPull: 100,
    filters: { grayscale: 100, contrast: 170, brightness: 100, saturate: 40, blur: 1, invert: 0 }
  }
};
const GREEN_WAND_MODE_ORDER = ["robustTonal", "stableHold", "aggressiveRidge"];

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function rgbDistance(a, b) { return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2); }
function luminance(p) { return 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b; }
function greenishScore(p) { return p.g - (p.r + p.b) * 0.5; }
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}
function buildFilterString(filters) {
  return [
    `grayscale(${filters.grayscale}%)`, `contrast(${filters.contrast}%)`, `brightness(${filters.brightness}%)`,
    `saturate(${filters.saturate}%)`, `blur(${filters.blur}px)`, `invert(${filters.invert}%)`
  ].join(" ");
}
function sensitivityToThreshold(sensitivity) { return clamp(120 - sensitivity * 1.05, 6, 120); }
function samplePixel(data, width, x, y) {
  const ix = clamp(Math.round(x), 0, width - 1);
  const height = Math.floor(data.length / 4 / width);
  const iy = clamp(Math.round(y), 0, height - 1);
  const i = (iy * width + ix) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
}
function averageAround(data, width, height, x, y, radius = 4) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = -radius; yy <= radius; yy++) {
    for (let xx = -radius; xx <= radius; xx++) {
      const px = clamp(Math.round(x + xx), 0, width - 1);
      const py = clamp(Math.round(y + yy), 0, height - 1);
      const i = (py * width + px) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}
function localToneContrast(data, width, x, y) {
  const pts = [
    samplePixel(data, width, x, y), samplePixel(data, width, x + 2, y), samplePixel(data, width, x - 2, y),
    samplePixel(data, width, x, y + 2), samplePixel(data, width, x, y - 2),
    samplePixel(data, width, x + 2, y + 2), samplePixel(data, width, x - 2, y - 2)
  ].map(luminance);
  return Math.max(...pts) - Math.min(...pts);
}
function centroid(points) {
  if (!points.length) return { x: 0, y: 0 };
  return points.reduce((acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }), { x: 0, y: 0 });
}
function averageRadius(points, c) {
  if (!points.length) return 0;
  return points.reduce((sum, p) => sum + dist(p, c), 0) / points.length;
}
function polygonPath(points) {
  if (!points.length) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + " Z";
}
function smoothPoints(points, passes = 3) {
  if (!points.length) return [];
  let out = points.map(p => ({ ...p }));
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((p, i) => {
      const prev = out[(i - 1 + out.length) % out.length];
      const next = out[(i + 1) % out.length];
      return { ...p, x: p.x * 0.45 + prev.x * 0.275 + next.x * 0.275, y: p.y * 0.45 + prev.y * 0.275 + next.y * 0.275 };
    });
  }
  return out;
}
function finalSmoothPoints(points, passes = 8) {
  if (!points.length) return [];
  let out = points.map(p => ({ ...p }));
  for (let pass = 0; pass < passes; pass++) {
    out = out.map((p, i) => {
      const prev2 = out[(i - 2 + out.length) % out.length];
      const prev1 = out[(i - 1 + out.length) % out.length];
      const next1 = out[(i + 1) % out.length];
      const next2 = out[(i + 2) % out.length];
      return {
        ...p,
        x: p.x * 0.34 + prev1.x * 0.22 + next1.x * 0.22 + prev2.x * 0.11 + next2.x * 0.11,
        y: p.y * 0.34 + prev1.y * 0.22 + next1.y * 0.22 + prev2.y * 0.11 + next2.y * 0.11
      };
    });
  }
  return out;
}
function addNeighbourSupport(candidates, baseBubbleSize = 61) {
  const scale = clamp((Number(baseBubbleSize) || 61) / 61, 0.75, 3.2);
  const radiusTolerance = 18 * scale;
  return candidates.map((c, i, arr) => {
    let support = 0;
    for (let offset = 1; offset <= 2; offset++) {
      const left = arr[(i - offset + arr.length) % arr.length];
      const right = arr[(i + offset) % arr.length];
      const leftClose = Math.max(0, 1 - Math.abs(left.radius - c.radius) / radiusTolerance);
      const rightClose = Math.max(0, 1 - Math.abs(right.radius - c.radius) / radiusTolerance);
      support += (leftClose + rightClose) * (offset === 1 ? 1.45 : 0.95);
    }
    return { ...c, support, totalScore: c.rawScore + support * 20 };
  });
}
function findRuns(mask, value) {
  const n = mask.length;
  if (!n) return [];
  const allSame = mask.every(v => v === value);
  if (allSame) return value ? [{ start: 0, end: n - 1, length: n }] : [];
  const anchor = mask.findIndex(v => v !== value);
  const runs = [];
  let current = null;
  for (let step = 1; step <= n; step++) {
    const idx = (anchor + step) % n;
    if (mask[idx] === value) {
      if (!current) current = { start: idx, end: idx, length: 1 };
      else { current.end = idx; current.length += 1; }
    } else if (current) { runs.push(current); current = null; }
  }
  if (current) runs.push(current);
  return runs;
}
function chainRadiusSmoothEnough(candidates, indices, maxStep) {
  for (let i = 1; i < indices.length; i++) {
    if (Math.abs(candidates[indices[i]].radius - candidates[indices[i - 1]].radius) > maxStep) return false;
  }
  return true;
}
function nearestAccepted(mask, index, direction, maxLook) {
  const n = mask.length;
  for (let step = 1; step <= maxLook; step++) {
    const idx = (index + direction * step + n) % n;
    if (mask[idx]) return idx;
  }
  return -1;
}
function findTonalEdgeCandidates({ imageData, width, height, seed, sensitivity, baseBubbleSize = 61 }) {
  const data = imageData.data;
  const safeSeed = { x: clamp(seed.x, 1, width - 2), y: clamp(seed.y, 1, height - 2) };
  const threshold = sensitivityToThreshold(sensitivity);
  const probeCount = 144;
  const probes = [];
  const candidates = [];
  const scale = clamp((Number(baseBubbleSize) || 61) / 61, 0.75, 3.2);
  const startR = Math.max(10, 10 * scale);
  const stepR = Math.max(3, 3 * Math.min(scale, 2.2));
  const innerAcceptR = Math.max(16, 16 * scale);
  const aheadStep = Math.max(3, 3 * Math.min(scale, 2.2));
  const outwardBiasR = Math.max(75, 75 * scale);
  const maxR = Math.min(Math.min(width, height) * 0.43, Math.max((Number(baseBubbleSize) || 61) * 2.35, innerAcceptR * 2.1));
  const seedTone = luminance(averageAround(data, width, height, safeSeed.x, safeSeed.y, Math.max(4, 6 * Math.min(scale, 1.8))));
  for (let i = 0; i < probeCount; i++) {
    const angle = (Math.PI * 2 * i) / probeCount;
    let prevLuma = seedTone;
    let best = null;
    let lastPoint = { x: safeSeed.x, y: safeSeed.y };
    for (let r = startR; r <= maxR; r += stepR) {
      const x = safeSeed.x + Math.cos(angle) * r;
      const y = safeSeed.y + Math.sin(angle) * r;
      if (x < 2 || y < 2 || x > width - 3 || y > height - 3) break;
      const px = samplePixel(data, width, x, y);
      const nowLuma = luminance(px);
      const toneJump = Math.abs(nowLuma - prevLuma);
      const localContrast = localToneContrast(data, width, x, y);
      const ahead1 = luminance(samplePixel(data, width, safeSeed.x + Math.cos(angle) * (r + aheadStep), safeSeed.y + Math.sin(angle) * (r + aheadStep)));
      const ahead2 = luminance(samplePixel(data, width, safeSeed.x + Math.cos(angle) * (r + aheadStep * 2), safeSeed.y + Math.sin(angle) * (r + aheadStep * 2)));
      const persistence = (Math.abs(ahead1 - nowLuma) + Math.abs(ahead2 - ahead1)) * 0.5;
      const centreDrift = Math.abs(nowLuma - seedTone);
      const outwardBias = 0.65 + Math.min(1, r / outwardBiasR) * 0.35;
      const rawScore = (toneJump * 1.9 + localContrast * 0.85 + persistence * 1.15 + centreDrift * 0.35) * outwardBias;
      const candidate = { x, y, angle, radius: r, rawScore, toneJump, localContrast, persistence, centreDrift, soft: rawScore < threshold };
      if (!best || rawScore > best.rawScore) best = candidate;
      if (rawScore > threshold && r > innerAcceptR) {
        const earlyHit = { ...candidate, soft: false };
        if (!best || earlyHit.rawScore > best.rawScore * 0.9) best = earlyHit;
        break;
      }
      prevLuma = nowLuma;
      lastPoint = { x, y };
    }
    const chosen = best || { x: lastPoint.x, y: lastPoint.y, angle, radius: dist(lastPoint, safeSeed), rawScore: 0, toneJump: 0, localContrast: 0, persistence: 0, centreDrift: 0, soft: true };
    candidates.push(chosen);
    probes.push({ x1: safeSeed.x, y1: safeSeed.y, x2: chosen.x, y2: chosen.y, hit: !chosen.soft });
  }
  return { candidates, probes };
}
function buildContinuitySelection(candidates) {
  const scores = candidates.map(c => c.totalScore || 0);
  const strongCut = percentile(scores, 0.48);
  const softCut = percentile(scores, 0.3);
  const n = candidates.length;
  let mask = candidates.map(c => (c.totalScore || 0) >= strongCut && (c.support || 0) >= 0.85);
  const expanded = [...mask];
  for (let i = 0; i < n; i++) {
    if (expanded[i]) continue;
    const c = candidates[i];
    if ((c.totalScore || 0) < softCut || (c.support || 0) < 0.45) continue;
    const left = nearestAccepted(expanded, i, -1, 3);
    const right = nearestAccepted(expanded, i, 1, 3);
    if (left !== -1 && right !== -1) {
      const local = [left, i, right];
      if (chainRadiusSmoothEnough(candidates, local, 22) && Math.abs(candidates[left].radius - candidates[right].radius) <= 26) expanded[i] = true;
    }
  }
  const bridged = [...expanded];
  const falseRuns = findRuns(bridged, false);
  for (const run of falseRuns) {
    if (run.length > 3) continue;
    const prev = (run.start - 1 + n) % n;
    const next = (run.end + 1) % n;
    if (!bridged[prev] || !bridged[next]) continue;
    const gapIndices = [];
    for (let step = 0; step < run.length; step++) gapIndices.push((run.start + step) % n);
    const avgGapScore = gapIndices.reduce((sum, idx) => sum + (candidates[idx].totalScore || 0), 0) / gapIndices.length;
    const test = [prev, ...gapIndices, next];
    const smoothEnough = chainRadiusSmoothEnough(candidates, test, 24);
    const endpointClose = Math.abs(candidates[prev].radius - candidates[next].radius) <= 28;
    if (avgGapScore >= softCut * 0.82 && smoothEnough && endpointClose) gapIndices.forEach(idx => { bridged[idx] = true; });
  }
  const chains = findRuns(bridged, true)
    .map(run => {
      const indices = [];
      for (let step = 0; step < run.length; step++) indices.push((run.start + step) % n);
      const avgScore = indices.reduce((sum, idx) => sum + (candidates[idx].totalScore || 0), 0) / indices.length;
      const radiusSteps = indices.slice(1).map((idx, k) => Math.abs(candidates[idx].radius - candidates[indices[k]].radius));
      const avgStep = radiusSteps.length ? radiusSteps.reduce((a, b) => a + b, 0) / radiusSteps.length : 0;
      const continuityBonus = Math.max(0, 18 - avgStep);
      return { indices, score: indices.length * 8 + avgScore + continuityBonus * 4 };
    })
    .sort((a, b) => b.score - a.score);
  const best = chains[0] || { indices: [] };
  return { acceptedIndices: new Set(best.indices), chains, bestLength: best.indices.length || 0 };
}
function buildRidgeLines(candidates, acceptedIndices) {
  const n = candidates.length;
  const acceptedMask = candidates.map((_, i) => acceptedIndices.has(i));
  const scores = candidates.map(c => c.totalScore || 0);
  const strongCut = percentile(scores, 0.34);
  const softCut = percentile(scores, 0.22);
  const mask = candidates.map((c, i) => acceptedMask[i] || ((c.totalScore || 0) >= strongCut && (c.support || 0) >= 0.75));
  for (let i = 0; i < n; i++) {
    if (mask[i]) continue;
    const c = candidates[i];
    if ((c.totalScore || 0) < softCut || (c.support || 0) < 0.4) continue;
    const left = mask[(i - 1 + n) % n] || mask[(i - 2 + n) % n];
    const right = mask[(i + 1) % n] || mask[(i + 2) % n];
    if (left && right) mask[i] = true;
  }
  const falseRuns = findRuns(mask, false);
  for (const run of falseRuns) {
    if (run.length > 2) continue;
    const prev = (run.start - 1 + n) % n;
    const next = (run.end + 1) % n;
    if (!mask[prev] || !mask[next]) continue;
    for (let step = 0; step < run.length; step++) {
      const idx = (run.start + step) % n;
      if ((candidates[idx].totalScore || 0) >= softCut * 0.85) mask[idx] = true;
    }
  }
  return findRuns(mask, true)
    .map(run => {
      const indices = [];
      for (let step = 0; step < run.length; step++) indices.push((run.start + step) % n);
      const points = indices.map(idx => ({ ...candidates[idx], score: candidates[idx].totalScore || 0, support: candidates[idx].support || 0 }));
      const avgScore = points.reduce((sum, p) => sum + p.score, 0) / Math.max(1, points.length);
      const peakScore = points.reduce((m, p) => Math.max(m, p.score), 0);
      return { indices, points, length: indices.length, avgScore, peakScore };
    })
    .filter(line => line.length >= 4);
}
function buildRidgeSnapProfile(candidates, ridgeLines, baseBubbleSize) {
  const n = candidates.length;
  const snapRadius = new Array(n).fill(baseBubbleSize);
  const snapStrength = new Array(n).fill(0);
  const accumRadius = new Array(n).fill(0);
  const accumWeight = new Array(n).fill(0);
  function circularDistance(a, b) { const d = Math.abs(a - b); return Math.min(d, n - d); }
  for (const line of ridgeLines) {
    const lineStrength = clamp(line.length / 7, 0.7, 2.6) * clamp(line.avgScore / 120, 0.75, 2.4) * clamp(line.peakScore / 150, 0.8, 2.0);
    for (let target = 0; target < n; target++) {
      let bestLocalWeight = 0;
      let bestLocalRadius = baseBubbleSize;
      for (const idx of line.indices) {
        const steps = circularDistance(target, idx);
        if (steps > 12) continue;
        const angularWeight = Math.exp(-(steps * steps) / (2 * 3.8 * 3.8));
        const candidateWeight = angularWeight * lineStrength;
        accumRadius[target] += candidates[idx].radius * candidateWeight;
        accumWeight[target] += candidateWeight;
        if (candidateWeight > bestLocalWeight) { bestLocalWeight = candidateWeight; bestLocalRadius = candidates[idx].radius; }
      }
      if (bestLocalWeight > snapStrength[target]) { snapStrength[target] = bestLocalWeight; snapRadius[target] = bestLocalRadius; }
    }
  }
  for (let i = 0; i < n; i++) {
    if (accumWeight[i] > 0) {
      const averaged = accumRadius[i] / accumWeight[i];
      snapRadius[i] = snapRadius[i] * 0.58 + averaged * 0.42;
    }
  }
  return { snapRadius, snapStrength };
}
function buildHealthyBubble({ candidates, acceptedIndices, ridgeLines, seed, baseBubbleSize, clusterPull }) {
  const n = candidates.length;
  if (!n) return { bubble: [] };
  const acceptedMask = candidates.map((_, i) => acceptedIndices.has(i));
  const accepted = candidates.filter((_, i) => acceptedMask[i]);
  const acceptedScores = accepted.map(c => c.totalScore || 0);
  const strongCut = acceptedScores.length ? percentile(acceptedScores, 0.45) : 0;
  const pullRatio = clusterPull / 100;
  const minRadius = baseBubbleSize * 0.38;
  const maxRadius = baseBubbleSize * 2.05;
  const maxOffset = Math.max(38, baseBubbleSize * 1.05);
  const ridgeProfile = buildRidgeSnapProfile(candidates, ridgeLines, baseBubbleSize);
  function circularDistance(a, b) { const d = Math.abs(a - b); return Math.min(d, n - d); }
  const bubble = [];
  for (let i = 0; i < n; i++) {
    let targetRadius = baseBubbleSize;
    const ridgeStrength = clamp(ridgeProfile.snapStrength[i], 0, 4.5);
    if (ridgeStrength > 0) {
      const ridgeBlend = clamp(0.36 + pullRatio * 0.44 + ridgeStrength * 0.08, 0.36, 1.0);
      targetRadius = targetRadius * (1 - ridgeBlend) + ridgeProfile.snapRadius[i] * ridgeBlend;
    }
    let weightedPull = 0;
    let totalWeight = 0;
    for (let j = 0; j < n; j++) {
      if (!acceptedMask[j]) continue;
      const c = candidates[j];
      const steps = circularDistance(i, j);
      if (steps > 10) continue;
      const angularWeight = Math.exp(-(steps * steps) / (2 * 4.0 * 4.0));
      const scoreNorm = strongCut > 0 ? clamp((c.totalScore || 0) / strongCut, 0.8, 2.5) : 1;
      const weight = angularWeight * scoreNorm;
      weightedPull += (c.radius - targetRadius) * weight;
      totalWeight += weight;
    }
    if (totalWeight > 0) {
      const avgPull = weightedPull / totalWeight;
      const localConfidence = clamp(totalWeight / 1.6, 0, 1.8);
      targetRadius += avgPull * (0.2 + pullRatio * 0.4) * localConfidence;
    }
    if (acceptedMask[i]) {
      const c = candidates[i];
      const directStrength = strongCut > 0 ? clamp((c.totalScore || 0) / strongCut, 0.75, 2.1) : 1;
      const directBlend = clamp(0.52 + pullRatio * 0.3 + (directStrength - 0.75) * 0.16, 0.52, 0.98);
      targetRadius = targetRadius * (1 - directBlend) + c.radius * directBlend;
    }
    const delta = clamp(targetRadius - baseBubbleSize, -maxOffset, maxOffset);
    targetRadius = clamp(baseBubbleSize + delta, minRadius, maxRadius);
    const angle = candidates[i].angle;
    bubble.push({ x: seed.x + Math.cos(angle) * targetRadius, y: seed.y + Math.sin(angle) * targetRadius, radius: targetRadius });
  }
  let fitted = smoothPoints(bubble, 1);
  fitted = finalSmoothPoints(fitted, 1);
  return { bubble: fitted };
}
function offsetContour(points, amount) {
  if (!points.length) return [];
  const c = centroid(points);
  return points.map(p => {
    const vx = p.x - c.x, vy = p.y - c.y;
    const len = Math.max(1, Math.hypot(vx, vy));
    return { x: p.x + (vx / len) * amount, y: p.y + (vy / len) * amount };
  });
}
function buildOuterShell(contour) {
  const c = centroid(contour);
  const avgR = averageRadius(contour, c);
  const shellExpand = clamp(avgR * 0.008, 0.5, 2.25);
  let shell = smoothPoints(contour, 3);
  shell = offsetContour(shell, shellExpand);
  shell = finalSmoothPoints(shell, 3);
  return { shell };
}
function buildInsetGreen(shell, originalImageData, width, height) {
  if (!shell.length) return { inset: [], avgInset: 0, avgGreenDelta: 0 };
  const data = originalImageData.data;
  const c = centroid(shell);
  const avgR = averageRadius(shell, c);
  const baseInset = clamp(avgR * 0.04, 4, 10);
  let greenDeltaTotal = 0;
  const inset = shell.map(p => {
    const vx = p.x - c.x, vy = p.y - c.y;
    const len = Math.max(1, Math.hypot(vx, vy));
    const nx = vx / len, ny = vy / len;
    const inside = averageAround(data, width, height, p.x - nx * 8, p.y - ny * 8, 3);
    const outside = averageAround(data, width, height, p.x + nx * 8, p.y + ny * 8, 3);
    const greenDelta = greenishScore(inside) - greenishScore(outside);
    greenDeltaTotal += greenDelta;
    const extraInset = clamp((2 - greenDelta) * 0.25, 0, 4);
    const move = baseInset + extraInset;
    return { x: p.x - nx * move, y: p.y - ny * move, move };
  });
  const avgInset = inset.reduce((sum, p) => sum + p.move, 0) / inset.length;
  const finalInset = finalSmoothPoints(inset.map(p => ({ x: p.x, y: p.y })), 4);
  return { inset: finalInset, avgInset, avgGreenDelta: greenDeltaTotal / inset.length };
}
function compareInsideOutside({ imageData, width, points }) {
  if (!points.length) return null;
  const data = imageData.data;
  const c = centroid(points);
  const inside = [];
  const outside = [];
  for (let i = 0; i < points.length; i += 4) {
    const p = points[i];
    const vx = p.x - c.x, vy = p.y - c.y;
    const len = Math.max(1, Math.hypot(vx, vy));
    const nx = vx / len, ny = vy / len;
    inside.push(samplePixel(data, width, p.x - nx * 13, p.y - ny * 13));
    outside.push(samplePixel(data, width, p.x + nx * 13, p.y + ny * 13));
  }
  const avg = arr => arr.reduce((a, p) => ({ r: a.r + p.r / arr.length, g: a.g + p.g / arr.length, b: a.b + p.b / arr.length }), { r: 0, g: 0, b: 0 });
  const ai = avg(inside), ao = avg(outside);
  const difference = rgbDistance(ai, ao);
  return { difference, verdict: difference > 26 ? "Strong edge" : difference > 15 ? "Possible edge" : "Weak edge" };
}

/* ---------- server-side replacement for the two DOM-touching functions -------------------- */

/* Reproduces buildFilterString's six-filter CSS chain as libvips ops, in the same order CSS
   applies them. Approximate, not bit-identical - see the module header and
   dev/green-shape-core-parity.test.js. sourceBuffer must already be RGBA at exactly
   width x height (see analyzeGreenWand below, which resizes with fit:"fill" to match
   Canvas 2D's drawImage(image,0,0,width,height) stretch-to-fit semantics). */
async function renderFilteredBuffer(sourceBuffer, width, height, filters) {
  let pipeline = sharp(sourceBuffer, { raw: { width, height, channels: 4 } });
  if (Number(filters.grayscale) > 0) pipeline = pipeline.grayscale();
  const contrastFactor = Number(filters.contrast) / 100;
  if (Number.isFinite(contrastFactor) && contrastFactor !== 1) {
    pipeline = pipeline.linear(contrastFactor, 128 * (1 - contrastFactor));
  }
  const brightnessFactor = Number(filters.brightness) / 100;
  const saturationFactor = Number(filters.saturate) / 100;
  if ((Number.isFinite(brightnessFactor) && brightnessFactor !== 1) || (Number.isFinite(saturationFactor) && saturationFactor !== 1)) {
    pipeline = pipeline.modulate({
      brightness: Number.isFinite(brightnessFactor) ? brightnessFactor : 1,
      saturation: Number.isFinite(saturationFactor) ? saturationFactor : 1
    });
  }
  const blurPx = Number(filters.blur);
  /* sharp's blur sigma has no exact CSS-px equivalent; sigma ~= px/2 is the commonly used
     browser approximation and is what this ports to. */
  if (Number.isFinite(blurPx) && blurPx > 0) pipeline = pipeline.blur(Math.max(0.3, blurPx / 2));
  const invertPct = Number(filters.invert);
  /* Partial invert (0 < invert < 100) has no direct sharp op; every current preset uses
     invert:0, so only the boundary case is implemented. */
  if (invertPct >= 50) pipeline = pipeline.negate({ alpha: false });
  const { data } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width, height };
}

/* image: a Buffer (already-decoded pixels are NOT required - any format sharp can read).
   width/height: the analysis resolution (the crop the caller already prepared upstream,
   matching what the browser passes into detect()). */
async function analyzeGreenWand(image, width, height, options) {
  const base = await sharp(image).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const originalImageData = { data: base.data, width, height };
  const filteredImageData = await renderFilteredBuffer(base.data, width, height, options.filters);
  const raw = findTonalEdgeCandidates({ imageData: filteredImageData, width, height, seed: options.seed, sensitivity: options.sensitivity, baseBubbleSize: options.baseBubbleSize || 61 });
  const supported = addNeighbourSupport(raw.candidates, options.baseBubbleSize || 61);
  const selection = buildContinuitySelection(supported);
  const accepted = supported.filter((_, i) => selection.acceptedIndices.has(i));
  const ridgeLines = buildRidgeLines(supported, selection.acceptedIndices);
  const bubbleFit = buildHealthyBubble({ candidates: supported, acceptedIndices: selection.acceptedIndices, ridgeLines, seed: options.seed, baseBubbleSize: options.baseBubbleSize, clusterPull: options.clusterPull });
  const { shell } = buildOuterShell(bubbleFit.bubble);
  const insetResult = buildInsetGreen(shell, originalImageData, width, height);
  const insetGreen = insetResult.inset;
  const miniLines = ridgeLines.map(line => line.points.map(p => ({ x: p.x, y: p.y })));
  const comparison = compareInsideOutside({ imageData: originalImageData, width, points: insetGreen });
  return {
    probes: raw.probes, candidates: supported, accepted, ridgeLines, miniLines,
    bubble: bubbleFit.bubble, outerShell: shell, insetGreen,
    metrics: {
      edgeDots: supported.length, acceptedDots: accepted.length, bestChain: selection.bestLength,
      ridgeLineCount: ridgeLines.length, ridgeCoverage: ridgeLines.reduce((sum, line) => sum + line.length, 0),
      difference: comparison?.difference || 0, greenDelta: insetResult.avgGreenDelta, verdict: comparison?.verdict || "—"
    }
  };
}

function getModeDefaults(mode) { return GREEN_WAND_MODE_PRESETS[mode]; }
function detectionConfidence(metrics) {
  const dots = clamp((Number(metrics?.acceptedDots) || 0) / 42, 0, 1);
  const chain = clamp((Number(metrics?.bestChain) || 0) / 24, 0, 1);
  const ridge = clamp((Number(metrics?.ridgeCoverage) || 0) / 120, 0, 1);
  const contrast = clamp((Number(metrics?.difference) || 0) / 42, 0, 1);
  return clamp(dots * 0.28 + chain * 0.28 + ridge * 0.18 + contrast * 0.26, 0, 1);
}
function validateDetection(result, constraints) {
  const c = constraints || {};
  const polygon = Array.isArray(result?.polygonPixels) ? result.polygonPixels : [];
  const metrics = result?.metrics || {};
  const minPoints = Number(c.minPoints) || 16;
  const minConfidence = Number(c.minConfidence) || 0.52;
  const minAcceptedDots = Number(c.minAcceptedDots) || 8;
  const minBestChain = Number(c.minBestChain) || 8;
  if (polygon.length < minPoints) return { ok: false, reason: "too-few-polygon-points" };
  if ((Number(result?.confidence) || 0) < minConfidence) return { ok: false, reason: "low-confidence" };
  if ((Number(metrics.acceptedDots) || 0) < minAcceptedDots && (Number(metrics.bestChain) || 0) < minBestChain) return { ok: false, reason: "weak-edge-support" };
  const width = Number(c.width) || Number(result?.width) || 0;
  const height = Number(c.height) || Number(result?.height) || 0;
  if (width > 0 && height > 0) {
    const pad = Number(c.edgePaddingPx) || 2;
    if (!polygon.every(p => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && Number(p.x) >= -pad && Number(p.y) >= -pad && Number(p.x) <= width + pad && Number(p.y) <= height + pad)) {
      return { ok: false, reason: "polygon-outside-crop" };
    }
  }
  return { ok: true, reason: "accepted" };
}

/* image: a Buffer readable by sharp. The rest of the signature is inherited from the
   deleted browser engine's detect() and kept as-is, so callers written against that
   contract still work. */
export async function detect(input) {
  const request = input || {};
  const image = request.image || null;
  const width = Number(request.imageWidth || request.width) || 0;
  const height = Number(request.imageHeight || request.height) || 0;
  const seed = request.candidateCentrePx || request.candidateCenterPx || request.seed || { x: width / 2, y: height / 2 };
  if (!image || !width || !height || !Number.isFinite(Number(seed.x)) || !Number.isFinite(Number(seed.y))) {
    return { ok: false, rejectionReason: "invalid-input", polygonPixels: [], confidence: 0, diagnostics: { width, height } };
  }
  const preset = getModeDefaults(request.mode || "robustTonal") || GREEN_WAND_MODE_PRESETS.robustTonal;
  const options = Object.assign({
    seed: { x: clamp(Number(seed.x), 0, width), y: clamp(Number(seed.y), 0, height) },
    sensitivity: Number(request.sensitivity) || preset.sensitivityRange.preset,
    baseBubbleSize: Number(request.baseBubbleSize) || preset.baseBubbleSize,
    clusterPull: Number(request.clusterPull) || preset.clusterPull,
    filters: preset.filters
  }, request.options || {});
  const analysis = await analyzeGreenWand(image, width, height, options);
  const polygonPixels = (Array.isArray(analysis.insetGreen) && analysis.insetGreen.length >= 3 ? analysis.insetGreen : analysis.outerShell || [])
    .map(p => ({ x: Number(p.x), y: Number(p.y) }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  const confidence = detectionConfidence(analysis.metrics || {});
  const result = {
    ok: false, polygonPixels, confidence, metrics: analysis.metrics || {},
    diagnostics: { mode: preset.key, width, height, candidateCentrePx: options.seed, polygonPoints: polygonPixels.length, confidence }
  };
  const verdict = validateDetection(Object.assign({}, result, { width, height }), Object.assign({ width, height }, request.constraints || {}));
  result.ok = !!verdict.ok;
  result.rejectionReason = verdict.reason;
  result.diagnostics.validation = verdict;
  if (request.includeRawAnalysis) result.rawAnalysis = analysis;
  return result;
}

export const __greenShapeCoreTest = { renderFilteredBuffer, analyzeGreenWand, buildFilterString, GREEN_WAND_MODE_PRESETS, GREEN_WAND_MODE_ORDER, polygonPath, validateDetection, getModeDefaults };
