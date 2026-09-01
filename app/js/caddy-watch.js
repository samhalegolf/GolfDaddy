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

    /* Which surface is DRIVING the round: the phone in the hand, or the Watch
       on the wrist with the phone in the bag. Marshal still owns the round on
       either answer; this is presentation state, kept here because both ends
       read it off the same Scene and both ends may change it. A handover is
       for one round only, so it carries the round it was made for and lapses
       with it. */
    var surface = { active: "phone", roundId: null, handover: null };
    var watchState = { paired: false, appInstalled: false, reachable: false };
    /* How much of the course's lite-map package the wrist has. Reported by
       watch-map-delivery.js from what it sent and what the Watch says it
       holds; the phone's card and the Watch's Receiving face both read it. */
    var watchMaps = { total: 0, have: 0 };
    var handoverSeq = 0;

    /* Only LIVE play can be driven from the wrist: the Watch has no Play
       button and nothing to preview from a couch. So a handover needs a live
       hole, and lapses when the round changes or live play ends (END_ROUND
       keeps the round record for its card; it is the live hole that goes). */
    function liveRoundId(round) {
      return round.roundId && round.liveHole !== null && round.liveHole !== undefined ? round.roundId : null;
    }
    function surfaceFor(round) {
      if (surface.active === "watch" && surface.roundId !== liveRoundId(round)) surface = { active: "phone", roundId: null, handover: null };
      return {
        active: surface.active,
        handover: surface.handover ? { id: surface.handover.id, state: surface.handover.state, from: surface.handover.from } : null,
        watch: {
          paired: !!watchState.paired, appInstalled: !!watchState.appInstalled, reachable: !!watchState.reachable,
          maps: { total: watchMaps.total, have: watchMaps.have }
        }
      };
    }

    function setWatchMaps(progress) {
      progress = progress || {};
      var total = Number.isInteger(Number(progress.total)) && Number(progress.total) > 0 ? Number(progress.total) : 0;
      var have = Number.isInteger(Number(progress.have)) ? Math.max(0, Math.min(total, Number(progress.have))) : 0;
      if (total === watchMaps.total && have === watchMaps.have) return false;
      watchMaps = { total: total, have: have };
      publish();
      return true;
    }

    /* `from` is who asked. A phone-initiated handover is only OFFERED until the
       wrist answers with TAKE_OVER; a wrist-initiated one is confirmed by the
       asking. Both directions converge on the same confirmed state, so the
       phone's "is the Watch actually driving?" has one honest answer. */
    function setActive(active, from) {
      var round = marshal.round ? marshal.round() : {};
      if (active !== "watch" && active !== "phone") return false;
      if (active === "watch") {
        var roundId = liveRoundId(round);
        if (!roundId) return false;
        var current = surface.active === "watch" && surface.roundId === roundId ? surface.handover : null;
        if (from === "watch") {
          if (current && current.state === "confirmed") return true;
          handoverSeq += 1;
          surface = { active: "watch", roundId: roundId, handover: { id: current ? current.id : String(now()) + "-" + handoverSeq, state: "confirmed", from: current ? current.from : "watch" } };
        } else {
          if (current) return true;
          handoverSeq += 1;
          surface = { active: "watch", roundId: roundId, handover: { id: String(now()) + "-" + handoverSeq, state: "offered", from: "phone" } };
        }
      } else {
        if (surface.active === "phone") return true;
        surface = { active: "phone", roundId: null, handover: null };
      }
      publish();
      return true;
    }

    function setWatchState(state) {
      state = state || {};
      var next = { paired: !!state.paired, appInstalled: !!state.appInstalled, reachable: !!state.reachable };
      if (next.paired === watchState.paired && next.appInstalled === watchState.appInstalled && next.reachable === watchState.reachable) return false;
      watchState = next;
      publish();
      return true;
    }

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
        /* Which course is in play. An adapter needs it to pick the right
           pre-delivered hole imagery; it is an identifier, never geometry, and
           nothing on the far side may treat it as permission to load a course. */
        course: { key: round.courseKey || null, name: scene && scene.banner && scene.banner.course || null },
        hole: {
          number: scene && scene.hole && scene.hole.number || null,
          par: r && finite(r.par) && Number(r.par) > 0 ? Number(r.par) : null,
          live: round.liveHole === (scene && scene.hole && scene.hole.number),
          /* The hole's own length, for a face that has no player yet: the
             Watch's Ready face and the phone's card both show tee-to-green
             before anyone is standing anywhere. */
          teeToGreenM: r && point(r.tee) && point(r.green) ? rounded(distance.haversineMeters(point(r.tee), point(r.green)), 0) : null
        },
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
        surface: surfaceFor(round),
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
      else if (type === "TAKE_OVER" || type === "HAND_BACK") {
        /* Surface commands move no golf state, so they never reach Marshal
           and cannot be "marshal-rejected"; the round-ID check above is what
           stops a wrist claiming a round it is not looking at. */
        var applied = setActive(type === "TAKE_OVER" ? "watch" : "phone", "watch");
        /* "Play here" before Play was pressed on the phone: there is no live
           hole to drive yet, and the wrist is told so rather than left waiting. */
        if (!applied) return { accepted: false, reason: "no-live-round", revision: latest.revision };
        seenCommands[id] = true;
        return { accepted: true, reason: null, revision: latest.revision };
      }
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
      return { accepted: changed, reason: changed ? null : "marshal-rejected", revision: latest.revision };
    }
    marshal.onScene(function (scene) { publish(scene); });
    publish(marshal.scene());
    return {
      scene: function () { return latest; }, onScene: onScene, receiveCommand: receiveCommand, publish: publish, localPoint: localPoint,
      validateLocationObservation: function (v) { return locationObservation(v, now); },
      /* The phone's side of a handover. The wrist's side arrives as TAKE_OVER /
         HAND_BACK commands through receiveCommand, so both go through the
         same setActive and the Scene is the only place the answer lives. */
      handToWatch: function () { return setActive("watch", "phone"); },
      takeBack: function () { return setActive("phone", "phone"); },
      setWatchState: setWatchState,
      setWatchMaps: setWatchMaps,
      surface: function () { return latest ? latest.surface : null; }
    };
  }

  createCaddyWatchBridge.SCHEMA_VERSION = SCHEMA_VERSION;
  createCaddyWatchBridge.localPoint = localPoint;
  return createCaddyWatchBridge;
});
