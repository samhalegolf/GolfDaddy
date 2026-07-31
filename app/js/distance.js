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

  return { haversineMeters: haversineMeters, greenDistances: greenDistances };
});
