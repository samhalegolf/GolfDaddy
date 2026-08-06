/* Distance math. Pure, node-requirable — no DOM, no state.

   The caddy numbers are front/centre/back of green in metres: centre is the
   haversine distance to greenCenter, front/back are the nearest/farthest
   points of the green shape. With no shape, front and back are null and the
   display falls back to centre only — a normal state for thin geometry. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.distance = factory();
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var EARTH_RADIUS_M = 6371008.8;

  function toRad(deg) { return (Number(deg) * Math.PI) / 180; }

  function haversineMeters(a, b) {
    if (!a || !b) return null;
    var lat1 = Number(a.lat), lng1 = Number(a.lng), lat2 = Number(b.lat), lng2 = Number(b.lng);
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
  }

  /* fix: {lat,lng}; green: {green:{lat,lng}, greenShape:[{lat,lng},…]}.
     → {front, centre, back} in metres (rounded), nulls where unanswerable. */
  function greenDistances(fix, green) {
    var centre = haversineMeters(fix, green && green.green);
    var shape = (green && Array.isArray(green.greenShape) ? green.greenShape : [])
      .map(function (p) { return haversineMeters(fix, p); })
      .filter(function (d) { return Number.isFinite(d); });
    return {
      front: shape.length ? Math.round(Math.min.apply(null, shape)) : null,
      centre: Number.isFinite(centre) ? Math.round(centre) : null,
      back: shape.length ? Math.round(Math.max.apply(null, shape)) : null
    };
  }

  function toDeg(rad) { return (Number(rad) * 180) / Math.PI; }

  /* Initial bearing a→b, radians clockwise from north. Null if either end is
     unusable, so callers get a real answer rather than a plausible zero. */
  function bearingRad(a, b) {
    if (!a || !b) return null;
    var lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    var dLng = toRad(Number(b.lng) - Number(a.lng));
    if (![lat1, lat2, dLng].every(Number.isFinite)) return null;
    var y = Math.sin(dLng) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return Math.atan2(y, x);
  }

  /* Destination `metres` from `from` along `bearing` (radians clockwise from
     north). The inverse of bearingRad, on the same sphere haversineMeters
     uses, so a round trip through the two closes to within a millimetre. */
  function project(from, bearing, metres) {
    if (!from) return null;
    var lat1 = toRad(from.lat), lng1 = toRad(from.lng);
    var d = Number(metres) / EARTH_RADIUS_M, brg = Number(bearing);
    if (![lat1, lng1, d, brg].every(Number.isFinite)) return null;
    var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
    var lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
  }

  /* Rough radius of a green in metres: the mean distance from its centre to
     its outline. Null with no usable shape — the caller decides what a green
     of unknown size is worth, rather than getting a made-up number. */
  function greenRadiusMeters(green) {
    var centre = green && green.green;
    var shape = (green && Array.isArray(green.greenShape) ? green.greenShape : [])
      .map(function (p) { return haversineMeters(centre, p); })
      .filter(function (d) { return Number.isFinite(d) && d > 0; });
    if (!shape.length) return null;
    return shape.reduce(function (sum, d) { return sum + d; }, 0) / shape.length;
  }

  return {
    haversineMeters: haversineMeters,
    greenDistances: greenDistances,
    bearingRad: bearingRad,
    project: project,
    greenRadiusMeters: greenRadiusMeters
  };
});
