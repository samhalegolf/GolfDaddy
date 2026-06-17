export const METRES_PER_YARD = 0.9144;
export const YARDS_PER_METRE = 1 / METRES_PER_YARD;

export function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

export function roundTo(value, places = 0) {
  const p = Math.pow(10, places);
  return Math.round((Number(value) || 0) * p) / p;
}

export function metresToYards(metres) {
  return Number(metres || 0) * YARDS_PER_METRE;
}

export function yardsToMetres(yards) {
  return Number(yards || 0) * METRES_PER_YARD;
}

export function displayDistance(metres, units = 'm') {
  const value = units === 'yd' || units === 'yards' ? metresToYards(metres) : metres;
  const suffix = units === 'yd' || units === 'yards' ? 'yd' : 'm';
  return `${Math.round(value)} ${suffix}`;
}

export function toLatLngPlain(value) {
  if (!value) return null;
  const lat = Number(value.lat ?? value.latitude);
  const lng = Number(value.lng ?? value.lon ?? value.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function haversineDistanceM(a, b) {
  const aa = toLatLngPlain(a);
  const bb = toLatLngPlain(b);
  if (!aa || !bb) return Infinity;
  const radius = 6371000;
  const toRad = n => Number(n) * Math.PI / 180;
  const dLat = toRad(bb.lat - aa.lat);
  const dLng = toRad(bb.lng - aa.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aa.lat)) * Math.cos(toRad(bb.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function bearingRad(a, b) {
  const aa = toLatLngPlain(a);
  const bb = toLatLngPlain(b);
  if (!aa || !bb) return 0;
  return Math.atan2(bb.lng - aa.lng, bb.lat - aa.lat);
}

export function projectPoint(origin, angleRad, metres) {
  const o = toLatLngPlain(origin);
  if (!o) return null;
  const earth = 111320;
  return {
    lat: o.lat + (Math.cos(angleRad) * metres) / earth,
    lng: o.lng + (Math.sin(angleRad) * metres) / (earth * Math.cos(o.lat * Math.PI / 180))
  };
}

export function projectOffset(origin, angleRad, forwardM, sideM) {
  const forward = projectPoint(origin, angleRad, forwardM);
  return forward ? projectPoint(forward, angleRad + Math.PI / 2, sideM) : null;
}
