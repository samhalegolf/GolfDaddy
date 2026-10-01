/* Horizontal coordinate systems the terrain adapters can read.

   Small on purpose: the CRSs elevation providers actually publish golf-course ground in, each
   as a projection plus a datum shift to WGS84. A source declaring a CRS not in this table is
   refused at resolve time (see gd-terrain-resolver.mjs) rather than read as if it were
   something else - a grid placed in the wrong CRS is ground in the wrong field, not a subtle
   error.

   Transverse Mercator uses the Ordnance Survey's series (A Guide to Coordinate Systems in Great
   Britain, Annex C), good to millimetres inside a national zone. Datum shifts are the 7-parameter
   Helmert transforms proj publishes as +towgs84 (position-vector convention). Those are good to
   a metre or two for TM65/OSGB36 - well inside a 10m DTM cell, and the reason a LiDAR source in
   one of these CRSs should name a grid-based transform instead before anyone trusts it at 1m.

   Every function speaks [x, y] for projected coordinates and { lat, lng } for geographic. */

const DEG = Math.PI / 180;
const ARCSEC = Math.PI / (180 * 3600);

const ELLIPSOIDS = {
  WGS84: { a: 6378137, b: 6356752.314245 },
  GRS80: { a: 6378137, b: 6356752.314140 },
  Airy1830: { a: 6377563.396, b: 6356256.909 },
  AiryModified: { a: 6377340.189, b: 6356034.447 }
};

/* towgs84: [tx, ty, tz (m), rx, ry, rz (arcsec), s (ppm)], datum -> WGS84, position vector. */
const DATUMS = {
  WGS84: { ellipsoid: "WGS84", towgs84: null },
  ETRS89: { ellipsoid: "GRS80", towgs84: null },
  OSGB36: { ellipsoid: "Airy1830", towgs84: [446.448, -125.157, 542.06, 0.15, 0.247, 0.842, -20.489] },
  TM65: { ellipsoid: "AiryModified", towgs84: [482.5, -130.6, 564.6, -1.042, -0.214, -0.631, 8.15] },
  TM75: { ellipsoid: "AiryModified", towgs84: [482.5, -130.6, 564.6, -1.042, -0.214, -0.631, 8.15] }
};

const CRS = {
  "EPSG:4326": { kind: "geographic", datum: "WGS84" },
  "EPSG:3857": { kind: "web-mercator", datum: "WGS84" },
  /* British National Grid. */
  "EPSG:27700": { kind: "tmerc", datum: "OSGB36", lat0: 49, lon0: -2, k0: 0.9996012717, e0: 400000, n0: -100000 },
  /* Irish Grid on TM65 (OSNI's published grid) and TM75 (same projection, later adjustment). */
  "EPSG:29902": { kind: "tmerc", datum: "TM65", lat0: 53.5, lon0: -8, k0: 1.000035, e0: 200000, n0: 250000 },
  "EPSG:29903": { kind: "tmerc", datum: "TM75", lat0: 53.5, lon0: -8, k0: 1.000035, e0: 200000, n0: 250000 },
  /* Irish Transverse Mercator (ETRS89) - OSNI and Tailte Éireann's modern grid. */
  "EPSG:2157": { kind: "tmerc", datum: "ETRS89", lat0: 53.5, lon0: -8, k0: 0.99982, e0: 600000, n0: 750000 },
  /* New Zealand Transverse Mercator 2000 - LINZ's own grid, for a future WCS/COG source. */
  "EPSG:2193": { kind: "tmerc", datum: "WGS84", lat0: 0, lon0: 173, k0: 0.9996, e0: 1600000, n0: 10000000 }
};

export function supportedCrs(code) {
  return Object.prototype.hasOwnProperty.call(CRS, normaliseCrs(code));
}

export function normaliseCrs(code) {
  const s = String(code || "").trim().toUpperCase();
  if (s === "WGS84" || s === "CRS84") return "EPSG:4326";
  if (s === "EPSG:900913" || s === "EPSG:102100" || s === "EPSG:102113") return "EPSG:3857";
  return /^\d+$/.test(s) ? "EPSG:" + s : s;
}

export function listSupportedCrs() {
  return Object.keys(CRS);
}

/* ---------- web mercator --------------------------------------------------------------- */

const MERC_R = 6378137;

function mercForward(lat, lng) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return [MERC_R * lng * DEG, MERC_R * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2))];
}

function mercInverse(x, y) {
  return { lat: (2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) / DEG, lng: x / MERC_R / DEG };
}

/* ---------- transverse mercator (OS Annex C) -------------------------------------------- */

function meridionalArc(b, F0, n, phi, phi0) {
  const dp = phi - phi0, sp = phi + phi0;
  return b * F0 * (
    (1 + n + (5 / 4) * n * n + (5 / 4) * n * n * n) * dp
    - (3 * n + 3 * n * n + (21 / 8) * n * n * n) * Math.sin(dp) * Math.cos(sp)
    + ((15 / 8) * n * n + (15 / 8) * n * n * n) * Math.sin(2 * dp) * Math.cos(2 * sp)
    - (35 / 24) * n * n * n * Math.sin(3 * dp) * Math.cos(3 * sp)
  );
}

function tmForward(p, ell, latDeg, lngDeg) {
  const { a, b } = ell;
  const F0 = p.k0, phi0 = p.lat0 * DEG, lam0 = p.lon0 * DEG;
  const phi = latDeg * DEG, lam = lngDeg * DEG;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinP * sinP);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const eta2 = nu / rho - 1;
  const M = meridionalArc(b, F0, n, phi, phi0);
  const I = M + p.n0;
  const II = (nu / 2) * sinP * cosP;
  const III = (nu / 24) * sinP * Math.pow(cosP, 3) * (5 - tanP * tanP + 9 * eta2);
  const IIIA = (nu / 720) * sinP * Math.pow(cosP, 5) * (61 - 58 * tanP * tanP + Math.pow(tanP, 4));
  const IV = nu * cosP;
  const V = (nu / 6) * Math.pow(cosP, 3) * (nu / rho - tanP * tanP);
  const VI = (nu / 120) * Math.pow(cosP, 5) * (5 - 18 * tanP * tanP + Math.pow(tanP, 4) + 14 * eta2 - 58 * tanP * tanP * eta2);
  const dl = lam - lam0;
  const N = I + II * dl * dl + III * Math.pow(dl, 4) + IIIA * Math.pow(dl, 6);
  const E = p.e0 + IV * dl + V * Math.pow(dl, 3) + VI * Math.pow(dl, 5);
  return [E, N];
}

function tmInverse(p, ell, E, N) {
  const { a, b } = ell;
  const F0 = p.k0, phi0 = p.lat0 * DEG, lam0 = p.lon0 * DEG;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  let phi = (N - p.n0) / (a * F0) + phi0;
  let M = meridionalArc(b, F0, n, phi, phi0);
  for (let i = 0; i < 20 && Math.abs(N - p.n0 - M) >= 0.00001; i++) {
    phi += (N - p.n0 - M) / (a * F0);
    M = meridionalArc(b, F0, n, phi, phi0);
  }
  const sinP = Math.sin(phi), cosP = Math.cos(phi), tanP = Math.tan(phi), secP = 1 / cosP;
  const nu = a * F0 / Math.sqrt(1 - e2 * sinP * sinP);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const eta2 = nu / rho - 1;
  const VII = tanP / (2 * rho * nu);
  const VIII = tanP / (24 * rho * Math.pow(nu, 3)) * (5 + 3 * tanP * tanP + eta2 - 9 * tanP * tanP * eta2);
  const IX = tanP / (720 * rho * Math.pow(nu, 5)) * (61 + 90 * tanP * tanP + 45 * Math.pow(tanP, 4));
  const X = secP / nu;
  const XI = secP / (6 * Math.pow(nu, 3)) * (nu / rho + 2 * tanP * tanP);
  const XII = secP / (120 * Math.pow(nu, 5)) * (5 + 28 * tanP * tanP + 24 * Math.pow(tanP, 4));
  const XIIA = secP / (5040 * Math.pow(nu, 7)) * (61 + 662 * tanP * tanP + 1320 * Math.pow(tanP, 4) + 720 * Math.pow(tanP, 6));
  const dE = E - p.e0;
  const lat = phi - VII * dE * dE + VIII * Math.pow(dE, 4) - IX * Math.pow(dE, 6);
  const lng = lam0 + X * dE - XI * Math.pow(dE, 3) + XII * Math.pow(dE, 5) - XIIA * Math.pow(dE, 7);
  return { lat: lat / DEG, lng: lng / DEG };
}

/* ---------- datum shifts ---------------------------------------------------------------- */

function toCartesian(ell, latDeg, lngDeg, h = 0) {
  const { a, b } = ell;
  const e2 = 1 - (b * b) / (a * a);
  const phi = latDeg * DEG, lam = lngDeg * DEG;
  const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [(nu + h) * Math.cos(phi) * Math.cos(lam), (nu + h) * Math.cos(phi) * Math.sin(lam), ((1 - e2) * nu + h) * Math.sin(phi)];
}

function fromCartesian(ell, [x, y, z]) {
  const { a, b } = ell;
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 10; i++) {
    const nu = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
    const next = Math.atan2(z + e2 * nu * Math.sin(phi), p);
    if (Math.abs(next - phi) < 1e-12) { phi = next; break; }
    phi = next;
  }
  return { lat: phi / DEG, lng: Math.atan2(y, x) / DEG };
}

function helmert([x, y, z], params, inverse) {
  const sign = inverse ? -1 : 1;
  const [tx, ty, tz, rxs, rys, rzs, sppm] = params.map(v => v * sign);
  const rx = rxs * ARCSEC, ry = rys * ARCSEC, rz = rzs * ARCSEC, s = sppm * 1e-6;
  return [
    tx + (1 + s) * x - rz * y + ry * z,
    ty + rz * x + (1 + s) * y - rx * z,
    tz - ry * x + rx * y + (1 + s) * z
  ];
}

function datumToWgs84(datumKey, ll) {
  const d = DATUMS[datumKey];
  if (!d.towgs84) return ll;
  const c = helmert(toCartesian(ELLIPSOIDS[d.ellipsoid], ll.lat, ll.lng), d.towgs84, false);
  return fromCartesian(ELLIPSOIDS.WGS84, c);
}

function wgs84ToDatum(datumKey, ll) {
  const d = DATUMS[datumKey];
  if (!d.towgs84) return ll;
  const c = helmert(toCartesian(ELLIPSOIDS.WGS84, ll.lat, ll.lng), d.towgs84, true);
  return fromCartesian(ELLIPSOIDS[d.ellipsoid], c);
}

/* ---------- public ---------------------------------------------------------------------- */

function crsDef(code) {
  const def = CRS[normaliseCrs(code)];
  if (!def) throw new Error("unsupported CRS " + code);
  return def;
}

/* Projected/geographic coordinate in `code` -> WGS84 { lat, lng }. */
export function toLngLat(code, x, y) {
  const def = crsDef(code);
  if (def.kind === "geographic") return { lat: y, lng: x };
  if (def.kind === "web-mercator") return mercInverse(x, y);
  const local = tmInverse(def, ELLIPSOIDS[DATUMS[def.datum].ellipsoid], x, y);
  return datumToWgs84(def.datum, local);
}

/* WGS84 { lat, lng } -> [x, y] in `code`. */
export function fromLngLat(code, lat, lng) {
  const def = crsDef(code);
  if (def.kind === "geographic") return [lng, lat];
  if (def.kind === "web-mercator") return mercForward(lat, lng);
  const local = wgs84ToDatum(def.datum, { lat, lng });
  return tmForward(def, ELLIPSOIDS[DATUMS[def.datum].ellipsoid], local.lat, local.lng);
}

/* Bounds in `code` that contain WGS84 bounds - the four corners and edge midpoints, which is
   enough for the few-kilometre extents a course needs (TM curvature over 3km is centimetres). */
export function projectBounds(code, bounds) {
  const pts = [];
  for (const lat of [bounds.south, (bounds.south + bounds.north) / 2, bounds.north]) {
    for (const lng of [bounds.west, (bounds.west + bounds.east) / 2, bounds.east]) pts.push(fromLngLat(code, lat, lng));
  }
  return {
    minX: Math.min(...pts.map(p => p[0])), maxX: Math.max(...pts.map(p => p[0])),
    minY: Math.min(...pts.map(p => p[1])), maxY: Math.max(...pts.map(p => p[1]))
  };
}

/* Exposed for the projection's own tests (OS worked example). */
export const __test = { tmForward, tmInverse, ELLIPSOIDS, CRS };
