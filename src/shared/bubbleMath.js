import { clampNumber, projectOffset, roundTo } from './unitsDistance.js';

export function normaliseBubble(raw = {}, distanceM = 0) {
  const visual = raw.visual || {};
  let widthM = Number(raw.widthM || raw.visualWidthM || raw.clusterWidthM || visual.visualWidthM || raw.lateralRadiusM * 2);
  let depthM = Number(raw.depthM || raw.visualDepthM || raw.clusterDepthM || visual.visualDepthM || raw.depthRadiusM * 2);

  if (!(widthM > 0)) widthM = clampNumber(distanceM * 0.13, 6, 36);
  if (!(depthM > 0)) depthM = clampNumber(distanceM * 0.18, 8, 52);

  return {
    widthM: roundTo(widthM, 1),
    depthM: roundTo(depthM, 1),
    radiusM: roundTo(Number(raw.radiusM || raw.radius || Math.max(widthM, depthM) / 2), 1),
    aimOffsetM: roundTo(Number(raw.aimOffsetM || 0), 1),
    aimOffsetDeg: roundTo(Number(raw.aimOffsetDeg || raw.offsetDeg || raw.faceOffsetDeg || 0), 2),
    clusterTiltDeg: roundTo(Number(raw.clusterTiltDeg || raw.tiltDeg || 0), 2),
    dispersionMultiplier: Number(raw.dispersionMultiplier || 1)
  };
}

export function bubbleRenderCenter(targetPoint, bearingToTargetRad, bubble) {
  const b = normaliseBubble(bubble);
  return projectOffset(targetPoint, bearingToTargetRad, 0, b.aimOffsetM) || targetPoint;
}

export function bubbleBoundsMetres(bubble) {
  const b = normaliseBubble(bubble);
  return {
    leftM: -b.widthM / 2,
    rightM: b.widthM / 2,
    shortM: -b.depthM / 2,
    longM: b.depthM / 2
  };
}

export function pointInsideBubble(localPoint, bubble) {
  const b = normaliseBubble(bubble);
  const x = Number(localPoint?.sideM || 0) / Math.max(1, b.widthM / 2);
  const y = Number(localPoint?.longM || 0) / Math.max(1, b.depthM / 2);
  return x * x + y * y <= 1;
}

export function createShotBubble({ club, baseCarry, clusterWidthM, clusterDepthM, aimOffsetM = 0, clusterTiltDeg = 0, dispersionMultiplier = 1 } = {}) {
  return normaliseBubble({
    club,
    baseCarry,
    clusterWidthM,
    clusterDepthM,
    aimOffsetM,
    clusterTiltDeg,
    dispersionMultiplier
  }, Number(baseCarry || 0));
}
