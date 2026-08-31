/* Caddy Watch compatibility boundary.

   Marshal remains the only owner of a round. This module projects its plain
   Scene into a compact wearable scene, and translates a deliberately small
   wearable command vocabulary back into Marshal signals. It has no DOM,
   Leaflet, Swift, Kotlin, or Garmin assumptions so it can be used by the iOS
   native bridge now and by future platform adapters later. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./distance.js"));
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.createCaddyWatchBridge = factory(root.ClarityApp.distance);
  }
})(typeof window !== "undefined" ? window : globalThis, function (distance) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var LOCATION_SOURCES = ["phone-web", "phone-native", "apple-watch", "wear-os", "garmin"];

  function finite(n) { return Number.isFinite(Number(n)); }
  function point(p) {
    if (!p || !finite(p.lat) || !finite(p.lng)) return null;
    return { lat: Number(p.lat), lng: Number(p.lng) };
  }
  function copyPoint(p) { p = point(p); return p && { lat: p.lat, lng: p.lng }; }
  function rounded(n, places) {
    if (!finite(n)) return null;
    var f = Math.pow(10, places || 1);
    return Math.round(Number(n) * f) / f;
  }

  /* Equirectangular local metres are exact enough for a green and, unlike a
     phone pixel projection, can be rendered identically on every wearable. */
  function localPoint(origin, p, approachBearing) {
    origin = point(origin); p = point(p);
    if (!origin || !p) return null;
    var north = (p.lat - origin.lat) * 111320;
    var east = (p.lng - origin.lng) * 111320 * Math.cos(origin.lat * Math.PI / 180);
    var bearing = finite(approachBearing) ? Number(approachBearing) : 0;
    /* Rotate so the golfer's approach is at the bottom and the green's back is
       at the top. x is right, y is toward the back of the green. */
    return {
      x: rounded(east * Math.cos(bearing) - north * Math.sin(bearing)),
      y: rounded(north * Math.cos(bearing) + east * Math.sin(bearing))
    };
  }

  function geometryFor(scene) {
    var rec = scene && scene.hole && scene.hole.rec;
    if (!rec || !rec.green) return null;
    var player = point(scene.player) || point(scene.locator);
    var approachBearing = player ? distance.bearingRad(player, rec.green) : null;
    var origin = point(rec.green);
    var shape = Array.isArray(rec.greenShape) ? rec.greenShape.map(function (p) {
      return localPoint(origin, p, approachBearing);
    }).filter(Boolean) : [];
    return {
      /* The native renderer receives metres, never browser/map pixels. */
      origin: copyPoint(origin),
      approachBearingDeg: finite(approachBearing) ? rounded((Number(approachBearing) * 180) / Math.PI) : null,
      greenPolygon: shape.length >= 3 ? shape : [],
      target: scene.bubble && scene.bubble.show ? localPoint(origin, scene.bubble.target, approachBearing) : null,
      player: player ? localPoint(origin, player, approachBearing) : null,
      route: Array.isArray(rec.route) ? rec.route.map(function (p) {
        return localPoint(origin, p, approachBearing);
      }).filter(Boolean) : []
    };
  }

  function bubbleFor(scene, bubbleModel) {
    if (!scene || !scene.bubble || !scene.bubble.show) return null;
    var model = null;
    try { model = typeof bubbleModel === "function" ? bubbleModel() : null; } catch (e) {}
    var payload = model && model.payload || {};
    return {
      widthM: rounded(payload.visual && payload.visual.visualWidthM != null ? payload.visual.visualWidthM : payload.clusterWidthM),
      depthM: rounded(payload.visual && payload.visual.visualDepthM != null ? payload.visual.visualDepthM : payload.clusterDepthM),
      tiltDeg: rounded(payload.visual && payload.visual.visualTiltDeg != null ? payload.visual.visualTiltDeg : payload.clusterTiltDeg),
      /* The Bubble engine is authoritative for club choice/shape. Null is an
         honest answer while its model is unavailable, never a made-up club. */
      club: payload.club || null,
      carryM: rounded(payload.baseCarry),
      totalM: rounded(payload.totalM),
      centre: model && model.center ? copyPoint(model.center) : copyPoint(scene.bubble.target)
    };
  }

  function locationObservation(value, now) {
    value = value || {};
    var coordinate = point(value.coordinate || value.point || value);
    var source = String(value.source || "");
    var accuracy = Number(value.horizontalAccuracy);
    var timestamp = Number(value.timestamp);
    if (!coordinate || LOCATION_SOURCES.indexOf(source) === -1 || !finite(accuracy) || accuracy < 0 || accuracy > 100 || !finite(timestamp)) return null;
    /* A delayed GPS location is unsafe for a shot boundary. Five minutes is a
       deliberately conservative v1 ceiling; phone fixes remain unchanged. */
    if (Math.abs(now() - timestamp) > 5 * 60 * 1000) return null;
    return { coordinate: coordinate, horizontalAccuracy: accuracy, timestamp: timestamp, source: source };
  }

  function createCaddyWatchBridge(options) {
    options = options || {};
    var marshal = options.marshal;
    if (!marshal || typeof marshal.scene !== "function" || typeof marshal.signal !== "function") throw new Error("CaddyWatchBridge requires a Marshal");
    var now = options.now || function () { return Date.now(); };
    var bubbleModel = options.bubbleModel || null;
    var listeners = [];
    var seenCommands = Object.create(null);
    var revision = 0;
    var latest = null;

    function project(scene) {
      var b = bubbleFor(scene, bubbleModel);
      var r = scene && scene.hole && scene.hole.rec || null;
      var flow = scene && scene.flow || "preview";
      var mode = scene && scene.mode || "setup";
      var watchMode = mode === "finish" ? "green-focus" : (mode === "aim" ? "bubble" : "standard");
      var round = marshal.round ? marshal.round() : {};
      return {
        schemaVersion: SCHEMA_VERSION,
        roundId: round.roundId || null,
        revision: revision,
        flow: flow,
        mode: watchMode,
        hole: { number: scene && scene.hole && scene.hole.number || null, par: r && finite(r.par) ? Number(r.par) : null, live: round.liveHole === (scene && scene.hole && scene.hole.number) },
        distance: { target: scene && scene.distances && scene.distances.centre, front: scene && scene.distances && scene.distances.front, centre: scene && scene.distances && scene.distances.centre, back: scene && scene.distances && scene.distances.back },
        suggestion: b ? { club: b.club, carryM: b.carryM, totalM: b.totalM } : null,
        shot: { locked: mode === "aim", open: !!(scene && scene.finishControl && scene.finishControl.show) || mode === "aim" },
        target: scene && scene.bubble && scene.bubble.show ? copyPoint(scene.bubble.target) : null,
        bubble: b,
        geometry: geometryFor(scene),
        score: { strokes: scene && scene.logged && scene.logged.score || null },
        location: scene && scene.locator ? { coordinate: copyPoint(scene.locator), source: "phone-web", horizontalAccuracy: null, timestamp: null, fresh: !scene.locator.stale } : null,
        controls: {
          canLock: !!(scene && scene.dock && scene.dock.face === "lock"),
          canUnlock: !!(scene && scene.dock && scene.dock.face === "unlock"),
          canAim: !!(scene && scene.bubble && scene.bubble.show),
          canShotEnd: !!(scene && scene.dock && scene.dock.canShotEnd),
          canPreviousHole: !!(scene && scene.picker && scene.picker.current > 1),
          canNextHole: !!(scene && scene.picker && scene.picker.holes && scene.picker.current < scene.picker.holes.length)
        },
        connection: { status: "live" }
      };
    }
    function publish(scene) {
      revision += 1;
      latest = project(scene || marshal.scene());
      listeners.forEach(function (fn) { try { fn(latest); } catch (e) {} });
      return latest;
    }
    function onScene(fn) { if (typeof fn === "function") listeners.push(fn); }
    function receiveCommand(command) {
      command = command || {};
      var id = String(command.commandId || "");
      if (!id || !command.type || !latest || command.roundId !== latest.roundId) return { accepted: false, reason: "invalid-command" };
      if (seenCommands[id]) return { accepted: true, duplicate: true, revision: latest.revision };
      if (finite(command.baseRevision) && Number(command.baseRevision) > latest.revision) return { accepted: false, reason: "future-revision" };
      var type = String(command.type);
      var payload = command.payload || {};
      var observation = null;
      var signal = null;
      if (type === "LOCK") signal = "LOCK";
      else if (type === "UNLOCK") signal = "UNLOCK";
      else if (type === "AIM_AT") signal = "AIM_DRAGGED";
      else if (type === "SHOT_END") signal = "SHOT_END";
      else if (type === "VIEW_NEXT_HOLE") signal = "NEXT_HOLE";
      else if (type === "VIEW_PREVIOUS_HOLE") signal = "PREV_HOLE";
      else if (type === "VIEW_HOLE") signal = "VIEW_HOLE_CHANGED";
      else if (type === "SET_SCORE") signal = "SCORE_SET";
      else if (type === "REQUEST_LATEST_SCENE") return { accepted: true, scene: latest };
      else if (type === "LOCK_AT" || type === "SHOT_END_AT") {
        observation = locationObservation(payload.location, now);
        if (!observation) return { accepted: false, reason: "invalid-location" };
        signal = type;
      } else return { accepted: false, reason: "unknown-command" };
      var changed = marshal.signal(signal, observation ? { observation: observation } : payload);
      /* A rejected command was never applied. Keeping its ID unclaimed lets a
         caller retry after the authoritative state changes; only a genuine
         Marshal transition earns idempotency protection. */
      if (changed) seenCommands[id] = true;
      return { accepted: changed, revision: latest.revision };
    }
    marshal.onScene(function (scene) { publish(scene); });
    publish(marshal.scene());
    return { scene: function () { return latest; }, onScene: onScene, receiveCommand: receiveCommand, publish: publish, localPoint: localPoint, validateLocationObservation: function (v) { return locationObservation(v, now); } };
  }

  createCaddyWatchBridge.SCHEMA_VERSION = SCHEMA_VERSION;
  createCaddyWatchBridge.localPoint = localPoint;
  return createCaddyWatchBridge;
});
