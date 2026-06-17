import { haversineDistanceM, toLatLngPlain } from './unitsDistance.js';

export const GPS_MODES = {
  TWO_TAP: 'two-tap',
  LIVE: 'live-gps'
};

export function createGpsPlayState(overrides = {}) {
  return {
    mode: overrides.mode || GPS_MODES.TWO_TAP,
    course: overrides.course || null,
    hole: Number(overrides.hole || 1),
    start: toLatLngPlain(overrides.start),
    target: toLatLngPlain(overrides.target),
    greenCentre: toLatLngPlain(overrides.greenCentre),
    pin: toLatLngPlain(overrides.pin),
    lockedFrame: Boolean(overrides.lockedFrame),
    selectedClubId: overrides.selectedClubId || null,
    lastKnownPosition: toLatLngPlain(overrides.lastKnownPosition),
    permission: overrides.permission || 'prompt',
    updatedAt: overrides.updatedAt || new Date().toISOString()
  };
}

export function canRenderShot(state) {
  const s = createGpsPlayState(state);
  return Boolean(s.start && (s.target || s.greenCentre));
}

export function shotDistanceM(state) {
  const s = createGpsPlayState(state);
  return haversineDistanceM(s.start, s.target || s.greenCentre);
}

export function shouldReframeForMovement(previousPosition, nextPosition, thresholdM = 5) {
  const distance = haversineDistanceM(previousPosition, nextPosition);
  return Number.isFinite(distance) && distance > thresholdM;
}

export function applyTwoTap(state, point) {
  const s = createGpsPlayState(state);
  const p = toLatLngPlain(point);
  if (!p) return s;
  if (!s.start) return createGpsPlayState({ ...s, start: p, lockedFrame: false });
  return createGpsPlayState({ ...s, target: p, greenCentre: p, lockedFrame: true });
}

export function clearShotOnly(state) {
  const s = createGpsPlayState(state);
  return createGpsPlayState({
    ...s,
    start: null,
    target: null,
    greenCentre: null,
    pin: null,
    lockedFrame: false
  });
}

export function unlockToPreLocked(state) {
  const s = createGpsPlayState(state);
  return createGpsPlayState({ ...s, lockedFrame: false });
}
