/* The Marshal — the play controller.

   Design: PLAY_OWNER_CONCEPT.md. Read it before changing anything here; every
   rule below is there with its reasoning.

   The Marshal owns every piece of play state, is the only thing allowed to
   change it, and derives what should be on screen. Signals go in, a Scene comes
   out. It decides; nothing else does.

   Pure and node-requirable: no DOM, no Leaflet, no globals. Everything with a
   side effect — the bubble engine, Course Data, the scorecard, the resume
   record — is INJECTED as an effect, so the whole transition table can be
   driven in node without a browser. That is what dev/marshal.test.js does.

   Two things this replaces outright, rather than wrapping:
     - position.js — in Live the player IS the trusted fix, and in Preview the
       player IS your placement. One value with two owners was the thing that
       needed a source tag and a policy in play.js.
     - shot.js     — shots live here, because the open-shot rule (a shot with no
       end) is what decides whether Finish is offered, and that answer has to
       come from the same place as everything else. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./distance.js"));
  } else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.createMarshal = factory(root.ClarityApp.distance);
  }
})(typeof window !== "undefined" ? window : globalThis, function (distance) {
  "use strict";

  /* Is this person at the golf course at all — measured from the course centre,
     not from any one hole, so walking between holes never re-litigates it. */
  var AT_COURSE_M = 800;

  /* Inside this of the green centre the app is LOOKING AT THE GREEN. Green
     focus is a view, not a prompt: it opens on position alone, whether or not
     a shot is locked and whether or not there is anything outstanding to log.

     It used to be a Finish prompt gated on an open shot, which is why it kept
     failing to appear at exactly the moment it was wanted: chip on from 20m
     and the aim never released (that needs two fixes 30m from the lock), so
     you could stand on the green with the approach bubble still up. Play a
     hole without locking anything and it never came at all.

     The 40m is also the band the ball may be PLACED in, so the camera frames a
     circle of this radius rather than the green polygon — otherwise the thing
     you are asked to drag sits off the edge of the screen (see camera.focus). */
  var GREEN_FOCUS_M = 40;

  /* And leaving it takes five metres more than entering it. Without the gap a
     fix jittering across the boundary reopens a focus that was just dismissed,
     over and over. */
  var GREEN_RELEASE_M = 45;

  /* How much closer to the green you must have got since locking before green
     focus is allowed to take the screen off an aim.

     Without it, standing over a chip inside the radius with the bubble up
     would have the green snatch the screen back on the very next fix — the
     aim would be un-aimable. With it, the test is the one thing that actually
     separates "still deciding" from "played it": ground closed on the green.
     Ten metres is far enough that no fix jitter reaches it and short enough
     that any real chip does, and it is measured as CLOSING rather than as
     distance travelled so that a sideways wander cannot pass it. */
  var GREEN_APPROACH_M = 10;

  /* The tee zone. Standing here IS pressing Play on the hole you have queued
     up: the whole point of the between-holes screen is that GPS is only taken
     seriously relative to a hole once you are at its tee, so arriving is the
     commitment and no button has to be found. Tighter than HOLE_ARRIVAL_M
     because arriving is a stronger claim than being offered the choice. */
  var TEE_ZONE_M = 30;

  /* Close enough to a hole to be playing it. The arrows and the picker only
     ever LOOK at holes now — the live hole moves when you say so, and this is
     the test for whether the app is allowed to offer you that. Measured from
     the tee, falling back to the green, because "have I arrived" is a question
     about the tee box. */
  var HOLE_ARRIVAL_M = 100;

  /* Aim releases itself once you have plainly walked off the point you locked
     from: you locked in, you hit, you walked. Two fixes so one wild reading
     cannot do it — the same shape as the tee-pin release. Releasing the VIEW
     never ends the shot; the shot stays open and the next Lock closes it. */
  var AIM_RELEASE_M = 30;
  var AIM_RELEASE_FIXES = 2;

  function pt(value) {
    if (!value || value.lat == null || value.lng == null) return null;
    var lat = Number(value.lat), lng = Number(value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function metres(a, b) {
    var d = distance.haversineMeters(a, b);
    return Number.isFinite(d) ? d : null;
  }

  /* One surface group -> drawable rings. Anything that cannot make a polygon is
     dropped here rather than in the painter, so the render path never has to
     defend against a two-point "shape" off the wire. */
  function surfaceList(list) {
    return (Array.isArray(list) ? list : []).map(function (item) {
      var shape = (Array.isArray(item && item.shape) ? item.shape : []).map(pt).filter(Boolean);
      if (shape.length < 3) return null;
      return { shape: shape, centre: pt(item && item.centre) || pt(item && item.center), hazardClass: (item && item.hazardClass) || null };
    }).filter(Boolean);
  }

  /* OSM-derived surfaces for this hole, or null. Null is the ordinary answer for
     a thinly tagged course and must stay distinguishable from "empty groups" —
     the painter draws nothing either way, but a course that HAS surfaces and a
     course that never had any are different facts. */
  function holeSurfaces(geometry) {
    if (!geometry || !geometry.surfaces) return null;
    var fairways = surfaceList(geometry.surfaces.fairways);
    var bunkers = surfaceList(geometry.surfaces.bunkers);
    var water = surfaceList(geometry.surfaces.water);
    if (!fairways.length && !bunkers.length && !water.length) return null;
    return { fairways: fairways, bunkers: bunkers, water: water };
  }

  /* Normalise the package's two hole shapes (lite = flat, full = {geometry,
     visual}) into one record. Null when the hole has no geometry — a normal
     outcome, not an error. */
  function holeRecord(pkg, hole) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    var found = holes.find(function (h) { return Number(h && h.holeNumber) === Number(hole); });
    if (!found) return null;
    var geometry = found.geometry || found;
    return {
      holeNumber: Number(hole),
      par: Number.isFinite(Number(found.par != null ? found.par : geometry.par)) ? Number(found.par != null ? found.par : geometry.par) : null,
      tee: pt(geometry.tee),
      green: pt(geometry.green),
      greenShape: (Array.isArray(geometry.greenShape) ? geometry.greenShape : []).map(pt).filter(Boolean),
      route: (Array.isArray(geometry.route) ? geometry.route : []).map(pt).filter(Boolean),
      surfaces: holeSurfaces(geometry),
      visual: found.visual && found.visual.playSurface ? found.visual : null
    };
  }

  /* The mean of every hole's tee and green. The hand-off URL carries a centre
     only when the picker's row had one, and a missing centre used to mean every
     fix was rejected for the whole round (see boot.js coordParam). Only the
     at-course radius is measured from this, so a centroid is as good an answer
     as the library row's own. */
  function packageCentre(pkg) {
    var holes = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    var sumLat = 0, sumLng = 0, n = 0;
    holes.forEach(function (h) {
      var geometry = (h && h.geometry) || h || {};
      [pt(geometry.tee), pt(geometry.green)].forEach(function (p) {
        if (p) { sumLat += p.lat; sumLng += p.lng; n += 1; }
      });
    });
    return n ? { lat: sumLat / n, lng: sumLng / n } : null;
  }

  function createMarshal(options) {
    options = options || {};
    var fx = options.effects || {};
    var now = options.now || function () { return Date.now(); };
    var trace = options.trace || null;

    /* The engine's own target rule (green when the bag reaches it, the fairway
       layup point when it does not). Injected so the Marshal never reaches for
       a global; the fallback keeps it usable in tests with no engine. */
    var defaultTarget = options.defaultTarget || function (start, rec) {
      return (rec && rec.green) || null;
    };

    /* How far an aim may be dragged, in metres — the bag's longest total
       distance, injected the same way as defaultTarget. defaultTarget already
       bag-limits the target it PROPOSES; without this rule the drag that
       follows had no limit at all, so the auto target respected the bag and
       the moment you touched it, it didn't. Null means no rule (no engine),
       and the drag stays free rather than guessing at a roof. */
    var maxAimM = options.maxAimM || function () { return null; };

    /* The dragged point, pulled back onto the roof along its own bearing when
       it lands beyond it. The clamp lives on the TARGET, not the rendered
       bubble centre — clamping the render is the old bag-roof bug that shifted
       and deformed completed bubbles (dev/fresh-app-boot.test.js pins it out). */
    function clampAim(start, point) {
      var roof = Number(maxAimM());
      if (!start || !point || !Number.isFinite(roof) || roof <= 0) return point;
      var d = metres(start, point);
      if (d === null || d <= roof) return point;
      var brg = distance.bearingRad(start, point);
      if (brg === null) return point;
      return distance.project(start, brg, roof) || point;
    }

    function emptyState() {
      return {
        round: { id: null, courseKey: null, courseName: "", pkg: null, centre: null, open: false },
        atCourse: false,
        viewHole: 0,
        /* liveHole is set by Play and cleared by End Round. NOTHING ELSE
           TOUCHES IT — not a dropped fix, not a denial, not a sleeping phone.
           Losing GPS changes what Track can draw, never which flow you are in
           (§2). This one line is the whole of "Live is sticky". */
        /* live.mode: track | aim | finish | logged | complete.
           `complete` is the between-holes holding screen — the hole is done,
           the score is sitting on par until you say otherwise, and nothing has
           moved on yet. */
        live: { hole: null, mode: "track", awayFixes: 0 },
        /* preview.mode: setup | aim | finish | queued.
           `queued` is the next hole, previewed. It is deliberately NOT framed
           on your fix: you are still standing on the last green, and a hole
           drawn around a position 400m off it is the misleading readout this
           whole screen exists to avoid. Play is offered anyway (the override:
           "we do not think you are at the tee, but we could be wrong"), and
           walking into the tee zone presses it for you. */
        preview: { mode: "setup", placement: null, target: null },
        /* The hole whose green focus the player has closed by hand, so it does
           not reopen while they are still standing inside the radius. Cleared
           by walking out past GREEN_RELEASE_M and by changing hole. */
        greenClosed: null,
        /* The third flow, and the ONLY way to log an outcome for a hole you are
           not standing on. Set by the picker's outstanding badge, cleared the
           moment it is logged or cancelled — it always remembers the hole to put
           you back on, so catching up never costs you your place (§4.3). */
        logging: null,      // { hole, ball, placed, from }
        fix: { point: null, fresh: false, at: 0 },
        shots: {},          // hole -> [{ start, target, end, method }]
        finish: null,       // { hole, ball, placed }
        logged: null,       // { hole, record }
        scores: {}          // hole -> strokes
      };
    }

    var S = emptyState();
    var sceneListeners = [];
    var lastScene = null;

    // ---------------------------------------------------------------- reads

    /* Three flows, not two.

       Logging sits outside both of the others on purpose. It used to be Preview
       wearing a finish mode, which is what let a tap decide whether the round
       CHANGED: land near a green and the same Shot End button that was a look a
       second ago wrote to the card.

       Preview still reaches green focus — that is a picture, and the picture is
       right — but it can never write from there. Logging is entered ONLY from
       the picker's outstanding badge, does exactly one thing, and puts you back
       where you were (§4.3). One entrance to a write. */
    function flow() {
      if (S.logging) return "logging";
      return (S.live.hole !== null && S.viewHole === S.live.hole) ? "live" : "preview";
    }

    function mode() {
      var f = flow();
      if (f === "logging") return "finish";
      return f === "live" ? S.live.mode : S.preview.mode;
    }

    function rec() { return holeRecord(S.round.pkg, S.viewHole); }

    function shotsFor(hole) {
      return S.shots[hole] || (S.shots[hole] = []);
    }

    /* A shot with a start and no end. The single condition Finish availability
       and the picker flag both read off (§4.3) — nothing arms, nothing expires. */
    function openShot(hole) {
      var list = S.shots[hole];
      if (!list) return null;
      for (var i = list.length - 1; i >= 0; i--) if (list[i].end === null) return list[i];
      return null;
    }

    /* Where the player is. Live: the trusted fix, full stop. Preview: the
       placement you made. Two different questions, so two different sources —
       which is why there is no "source" policy to get wrong any more. */
    function player() {
      if (S.logging) {
        var ball = S.logging.ball;
        return ball ? { lat: ball.lat, lng: ball.lng, stale: false } : null;
      }
      if (flow() === "live") {
        return S.fix.point ? { lat: S.fix.point.lat, lng: S.fix.point.lng, stale: !S.fix.fresh } : null;
      }
      /* Green focus reached by tapping the green is still a placement — the ball
         IS where you said you are — so the tools (pin distance, wind) have a
         point to work from rather than a mode with nobody in it. */
      var placed = S.preview.placement || (S.finish ? S.finish.ball : null);
      return placed ? { lat: placed.lat, lng: placed.lng, stale: false } : null;
    }

    function nearestHole(point) {
      var holes = (S.round.pkg && Array.isArray(S.round.pkg.holes)) ? S.round.pkg.holes : [];
      var best = null;
      holes.forEach(function (h) {
        var r = holeRecord(S.round.pkg, h && h.holeNumber);
        var anchor = r && (r.tee || r.green);
        if (!anchor) return;
        var d = metres(point, anchor);
        if (d === null) return;
        if (!best || d < best.d) best = { hole: r.holeNumber, d: d };
      });
      return best ? best.hole : null;
    }

    /* How far the given point is from the green of the hole being played, or
       null when there is no green to measure to. The one measurement green
       focus is made of. */
    function toGreen(point, hole) {
      var r = holeRecord(S.round.pkg, hole == null ? S.viewHole : hole);
      return (r && r.green && point) ? metres(point, r.green) : null;
    }

    /* Should the green take the screen? Position, and nothing else.

       The three modes it will not interrupt are the three that are already
       about the green: focus itself, the Logged screen that follows a log, and
       the hole-complete holding screen. Everything else — Track, and now Aim
       — gives way, because standing on the green with an approach bubble up is
       the bug this rule exists to end. */
    function greenFocusDue(point) {
      if (S.live.hole === null || flow() !== "live") return false;
      if (S.live.mode === "finish" || S.live.mode === "logged" || S.live.mode === "complete") return false;
      if (S.greenClosed === S.live.hole) return false;
      var d = toGreen(point, S.live.hole);
      if (d === null || d > GREEN_FOCUS_M) return false;
      if (S.live.mode !== "aim") return true;
      /* Locked. The shot has to have been PLAYED before the green may take the
         screen off it — see GREEN_APPROACH_M. A lock with no start is not a
         shot to protect. */
      var open = openShot(S.live.hole);
      var fromLock = open ? toGreen(open.start, S.live.hole) : null;
      return fromLock !== null && (fromLock - d) >= GREEN_APPROACH_M;
    }

    /* Am I at the tee of this hole? Not "have I arrived in the area" — that is
       atHole, and it is three times as generous. This is the claim that a fix
       may be read as a position ON the hole. */
    function inTeeZone(hole) {
      if (!S.fix.point) return false;
      var r = holeRecord(S.round.pkg, hole);
      if (!r || !r.tee) return false;
      var d = metres(S.fix.point, r.tee);
      return d !== null && d <= TEE_ZONE_M;
    }

    /* Have I arrived at this hole? The one question that decides whether the app
       offers to start it. Tee first, green as the fallback, because a hole with
       no tee in the package still has to be startable. */
    function atHole(hole) {
      if (!S.fix.point) return false;
      var r = holeRecord(S.round.pkg, hole);
      var anchor = r && (r.tee || r.green);
      if (!anchor) return false;
      var d = metres(S.fix.point, anchor);
      return d !== null && d <= HOLE_ARRIVAL_M;
    }

    /* Which hole Play would start. Before the round there is no view to trust
       yet, so it is the nearest one — that is how you get going from the car
       park. Once the round is running you are looking at a hole deliberately, so
       Play means THAT one, and it is only offered when you have arrived. */
    function playableHole() {
      if (S.live.hole === null) return S.fix.point ? nearestHole(S.fix.point) : null;
      return S.viewHole;
    }

    function playOffered() {
      if (!S.round.open || !S.atCourse || !S.fix.point) return false;
      if (S.logging) return false;
      if (S.live.hole === null) return true;
      if (flow() !== "preview") return false;
      /* The queued next hole always offers it, however far away you are. That
         is the override the between-holes screen is for: arriving at the tee
         starts the hole by itself, and this button is how you say "start it
         anyway" when the tee is not where the package thinks it is, or you are
         playing from somewhere else entirely. */
      if (S.preview.mode === "queued") return true;
      return atHole(S.viewHole);
    }

    /* What the picker draws against each hole. A shot with an end is an outcome;
       a shot without one is the thing you can still go and log. Counts rather
       than flags, because a par 5 is legitimately two or three locks and the
       card should say so (0-0 x2) instead of pretending it was one. */
    /* Par for every hole in play, as a plain map. Small enough to travel with
       every Scene and the only thing a wearable needs in order to run the
       between-holes screens by itself: it already has tee and green for every
       hole from its lite-map package, and par is the one fact that lives on
       the card rather than in the geometry. Holes with no par are omitted
       rather than nulled — an unmapped par is a real answer, and a null in a
       WatchConnectivity payload is a send that throws. */
    function parMap() {
      var out = {};
      holesInPlay().forEach(function (hole) {
        var r = holeRecord(S.round.pkg, hole);
        var par = r && Number.isFinite(Number(r.par)) && Number(r.par) > 0 ? Number(r.par) : null;
        if (par) out[hole] = par;
      });
      return out;
    }

    function pickerMarks() {
      var out = {};
      Object.keys(S.shots).forEach(function (key) {
        var hole = Number(key);
        var list = S.shots[key] || [];
        var done = 0, open = 0;
        list.forEach(function (s) { if (s && s.end) done += 1; else if (s) open += 1; });
        if (done || open) out[hole] = { done: done, open: open };
      });
      return out;
    }

    /* Every hole the site has, in physical order. More than 18 is not a special
       case and needs no pairing UI: North Shore Golf Club is numbered 1-27, and
       its three named courses (Blue 1-18, Gold 19-27+1-9, Red 10-18+19-27) are
       play ORDERS over those same holes, not separately named nines. So the
       round presents every hole and the picker lets the player start and move
       wherever the club actually sent them. Hole 20 means one thing here, which
       is why nothing has to qualify it.

       The 18 fallback covers only a round opened before any package arrived. */
    function holesInPlay() {
      var holes = (S.round.pkg && Array.isArray(S.round.pkg.holes)) ? S.round.pkg.holes : [];
      var max = holes.reduce(function (m, h) { return Math.max(m, Number(h && h.holeNumber) || 0); }, 0);
      var out = [];
      for (var i = 1; i <= (max || 18); i++) out.push(i);
      return out;
    }

    function stepHole(from, delta) {
      var list = holesInPlay();
      var idx = list.indexOf(from);
      if (idx === -1) return from;
      var next = idx + delta;
      return (next >= 0 && next < list.length) ? list[next] : from;
    }

    // ------------------------------------------------------------- mutation

    /* Logging has exactly one mode and no way to leave it except logging or
       cancelling, so it is not a thing you can set a mode on. Guarding here
       rather than at each call site means a future signal cannot accidentally
       write a live/preview mode while a catch-up is open. */
    function setMode(next) {
      if (S.logging) return;
      if (flow() === "live") S.live.mode = next;
      else S.preview.mode = next;
    }

    function completeShot(hole, shot, endPoint, method, observation) {
      shot.end = pt(endPoint);
      shot.method = method;
      if (observation) shot.endLocation = observation;
      if (typeof fx.shotCompleted === "function") {
        try { fx.shotCompleted({ start: shot.start, target: shot.target, end: shot.end }, { hole: hole, captureMethod: method, location: observation || null }); }
        catch (e) {}
      }
      S.logged = { hole: hole, record: { start: shot.start, target: shot.target, end: shot.end, method: method } };
    }

    /* A wearable location is an observation for this one action, never a
       replacement for the phone's trusted fix. This preserves the existing GPS
       ownership while letting NativeRoundBridge make provenance explicit. */
    function observationPoint(observation) {
      observation = observation || {};
      var source = String(observation.source || "");
      var accuracy = Number(observation.horizontalAccuracy);
      var timestamp = Number(observation.timestamp);
      var allowed = ["phone-web", "phone-native", "apple-watch", "wear-os", "garmin"];
      if (allowed.indexOf(source) === -1 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100 || !Number.isFinite(timestamp)) return null;
      /* Do not accept a delayed wearable coordinate as a present shot boundary.
         `now` is injected, so this remains deterministic in Marshal tests. */
      if (Math.abs(now() - timestamp) > 5 * 60 * 1000) return null;
      var where = pt(observation.coordinate || observation.point);
      return where ? { point: where, observation: { source: source, horizontalAccuracy: accuracy, timestamp: timestamp } } : null;
    }

    function lockAt(here, observation) {
      if (flow() !== "live" || S.live.mode !== "track" || !here) return false;
      var hole = S.live.hole;
      var open = openShot(hole);
      if (open) completeShot(hole, open, here, "lock", observation);
      else S.logged = null;
      shotsFor(hole).push({ start: here, target: pt(defaultTarget(here, rec())), end: null, method: null, location: observation || null });
      /* A new shot ends any "leave the green alone" the player asked for: the
         focus that comes back is the one that follows this shot, and it cannot
         come back before the shot is played (greenFocusDue). */
      S.greenClosed = null;
      S.live.mode = "aim";
      S.live.awayFixes = 0;
      syncEngine();
      return true;
    }

    /* The one way a hole becomes the live hole. PLAY_PRESSED calls it, and so
       does walking into the tee zone of the hole you have queued up — which is
       the same commitment made with your feet instead of your thumb. Keeping
       both doors in one function is what stops them drifting apart. */
    function startHole(hole) {
      S.live = { hole: hole, mode: "track", awayFixes: 0 };
      S.preview = { mode: "setup", placement: null, target: null };
      S.finish = null;
      S.logged = null;
      S.greenClosed = null;
      if (S.viewHole !== hole) enterHole(hole);
      syncEngine();
    }

    /* Green focus, opened. The ball starts wherever there is an honest answer —
       your fix if the caller has one — because the ball is the thing you drag,
       and a focus that opens with nothing on it has nothing to drag.

       syncEngine() matters here: arriving on the green out of Aim has to put
       the bubble away, and the engine only learns that from this call. */
    function openFinish(hole, ball) {
      var keep = (S.finish && S.finish.hole === hole) ? S.finish.ball : null;
      S.finish = { hole: hole, ball: pt(keep) || pt(ball) || null, placed: false };
      setMode("finish");
      syncEngine();
    }

    function setScore(hole, strokes) {
      if (!Number.isFinite(hole) || !Number.isFinite(strokes) || strokes < 1) return false;
      if (S.scores[hole] === strokes) return false;
      S.scores[hole] = strokes;
      if (typeof fx.scoreSet === "function") { try { fx.scoreSet(hole, strokes); } catch (e) {} }
      return true;
    }

    function syncEngine() {
      if (typeof fx.shotChanged !== "function") return;
      var shot = null;
      if (flow() === "live" && S.live.mode === "aim") shot = openShot(S.live.hole);
      else if (flow() === "preview" && S.preview.mode === "aim") {
        shot = { start: S.preview.placement, target: S.preview.target };
      }
      try { fx.shotChanged(shot && shot.start, shot && shot.target); } catch (e) {}
    }

    function enterHole(hole) {
      /* A dismissal belongs to the green it was made on. */
      if (Number(hole) !== S.viewHole) S.greenClosed = null;
      S.viewHole = Number(hole) || 0;
      var r = rec();
      if (typeof fx.holeEntered === "function") { try { fx.holeEntered(S.viewHole, r); } catch (e) {} }
    }

    // -------------------------------------------------------------- signals

    /* Every signal returns true if it changed anything. A false is not silence:
       Trace shows it as an accepted-but-inert signal, which is the "I pressed it
       and nothing happened" case that is invisible in every other kind of log. */
    var HANDLERS = {

      ROUND_OPENED: function (p) {
        S = emptyState();
        S.round = {
          id: p.roundId || (String(p.courseKey || "round") + ":" + String(now())),
          courseKey: p.courseKey || null,
          courseName: p.courseName || "",
          pkg: p.pkg || null,
          centre: pt(p.centre) || packageCentre(p.pkg),
          open: true
        };
        enterHole(p.hole || holesInPlay()[0] || 1);
        if (typeof fx.roundStarted === "function") { try { fx.roundStarted(S.round.courseKey, S.round.courseName); } catch (e) {} }
        return true;
      },

      /* The trust gate, and only then anything else. An unverified fix is not a
         position, so it cannot move the dot, open Finish, or release Aim. */
      FIX_RECEIVED: function (p) {
        var point = pt(p && p.point);
        if (!point) return false;
        if (!S.atCourse) {
          var away = metres(point, S.round.centre);
          if (away === null || away > AT_COURSE_M) return false;
          S.atCourse = true;
        }
        S.fix = { point: point, fresh: true, at: now() };

        /* Walked far enough off the green to have left it: whatever the player
           dismissed there is no longer the thing in front of them. */
        if (S.greenClosed !== null) {
          var back = toGreen(point, S.greenClosed);
          if (back === null || back > GREEN_RELEASE_M) S.greenClosed = null;
        }

        /* The tee zone IS the Play button.

           The hole is queued, you are looking at it, and now you are standing
           on its tee — there is nothing left to ask. This is the ONLY place a
           fix moves the round on, and it can only ever start the hole already
           on screen, put there by a deliberate press on the hole-complete
           screen. It cannot pick a hole for you. */
        if (flow() === "preview" && S.preview.mode === "queued" && inTeeZone(S.viewHole)) {
          startHole(S.viewHole);
          return true;
        }
        if (flow() !== "live") return true;

        /* Green focus, before anything else Live does with a fix. Inside 40m
           this is the picture, so it takes the screen out of Aim as readily as
           out of Track — the locked approach has plainly been played, and the
           shot it opened stays open for the ball to close. */
        if (greenFocusDue(point)) {
          openFinish(S.live.hole, point);
          return true;
        }

        if (S.live.mode === "aim") {
          var open = openShot(S.live.hole);
          var fromLock = open && metres(point, open.start);
          if (fromLock !== null && fromLock > AIM_RELEASE_M) {
            S.live.awayFixes += 1;
            if (S.live.awayFixes >= AIM_RELEASE_FIXES) {
              S.live.awayFixes = 0;
              S.live.mode = "track";
              syncEngine();
            }
          } else {
            S.live.awayFixes = 0;
          }
          return true;
        }
        return true;
      },

      /* Changes what Track can draw and NOTHING ELSE. It cannot reach liveHole,
         so it can never move you between flows. */
      FIX_LOST: function () {
        if (!S.fix.fresh) return false;
        S.fix.fresh = false;
        return true;
      },

      /* The only door into Live. Nothing else moves the live hole — not the
         arrows, not the picker, not a fix arriving from somewhere else on the
         course. Which hole it starts is playableHole(), and it is only reachable
         when playOffered() says you have actually arrived. */
      PLAY_PRESSED: function () {
        if (!playOffered()) return false;
        var hole = playableHole();
        if (!hole) return false;
        startHole(hole);
        return true;
      },

      END_ROUND: function () {
        if (S.live.hole === null) return false;
        S.live = { hole: null, mode: "track", awayFixes: 0 };
        S.preview = { mode: "setup", placement: null, target: null };
        S.finish = null;
        S.logged = null;
        S.greenClosed = null;
        if (typeof fx.roundEnded === "function") { try { fx.roundEnded(); } catch (e) {} }
        return true;
      },

      /* The picker: "show me hole N". Looking around, not moving on — so it
         never advances the round. Landing anywhere but the live hole is Preview,
         which opens at SETUP with nothing placed. */
      VIEW_HOLE_CHANGED: function (p) {
        var hole = Number(p && p.hole);
        if (!Number.isFinite(hole) || hole === S.viewHole) return false;
        S.logging = null;
        S.logged = null;
        S.finish = null;
        enterHole(hole);
        if (flow() === "preview") S.preview = { mode: "setup", placement: null, target: null };
        syncEngine();
        return true;
      },

      /* The arrows LOOK, they do not move you on.

         They used to walk the round while Live, so the hole you were "playing"
         kept up with the arrow rather than with you — skip ahead to read the
         next hole and the app quietly decided you were on it, with the live dot
         and the green numbers reporting a hole you were nowhere near. Now
         stepping off the live hole is Preview, exactly like the picker, and the
         Play button appears when you actually arrive. One door into Live. */
      NEXT_HOLE: function () { return viewStep(1); },
      PREV_HOLE: function () { return viewStep(-1); },

      /* The hole-complete screen's Next hole button: "queue that one up".

         It NEVER goes straight to Live, however close the fix says you are.
         That is the whole point of the between-holes screen. It used to commit
         the moment the fix agreed you had arrived, so pressing Next on the 5th
         green — 30m from the 6th tee at a tight course — started hole 6 and
         framed it around a position that was still on the previous hole, with
         a tee shot distance measured from the wrong side of a hedge. Taking a
         GPS position seriously as a position ON a hole requires either the tee
         zone or an explicit Play this hole, and this button is neither.

         So it previews: the hole drawn from its own tee and green, Play
         offered as the override, and the tee zone pressing it for you. */
      ADVANCE_TO_HOLE: function (p) {
        var hole = Number(p && p.hole);
        if (!Number.isFinite(hole) || hole === S.live.hole) return false;
        S.logging = null;
        S.logged = null;
        S.finish = null;
        enterHole(hole);
        S.preview = { mode: "queued", placement: null, target: null };
        syncEngine();
        return true;
      },

      /* Preview only: placing yourself IS the plan, so the lock-in is automatic
         and the bubble is there with nothing to press (§3).

         SETUP only. Once you have placed yourself the bubble is up and you are
         aiming, and an ordinary tap must not move where you are playing from —
         a tap near the origin dragged it sideways and everything downstream
         (default target, cluster, guides) re-solved around the new point, over
         and over. Unlock is how you change your mind: it clears the placement
         and brings the pill back, which is the resting state of this flow (§5).
         play.js had the same trap and solved it with a single-use armed tap;
         gating on the mode says the same thing without a flag to leave on. */
      PLACED: function (p) {
        if (flow() !== "preview" || S.preview.mode !== "setup") return false;
        var point = pt(p && p.point);
        if (!point) return false;
        var r = rec();

        /* Placing yourself ON the green means green focus, the same as walking
           onto it with a fix does — same 40m, same picture, same draggable ball
           and Shot End. Anything else would be a shot view whose start and
           target are the same point: a bubble aiming at itself.

           View only. Preview opens no shots, so Shot End here writes nothing
           unless the hole already has an origin waiting for an outcome, which
           FINISH_LOGGED decides on its own terms. The placement is deliberately
           NOT set — leaving Preview with nothing placed means Back returns you
           to the resting state with the pill up (§5). */
        var onGreen = r && r.green ? metres(point, r.green) : null;
        if (onGreen !== null && onGreen <= GREEN_FOCUS_M) {
          S.finish = { hole: S.viewHole, ball: point, placed: true };
          S.preview.target = null;
          S.preview.mode = "finish";
          syncEngine();
          return true;
        }

        S.preview.placement = point;
        S.preview.target = pt(defaultTarget(point, r));
        S.preview.mode = "aim";
        syncEngine();
        return true;
      },

      /* Live only. Closes the previous shot HERE and opens the next from here,
         which is why mid-hole boundaries need no separate action and why Shot
         End is only ever the hole's last shot (§4.0). */
      LOCK: function () {
        return lockAt(S.fix.point, null);
      },

      /* Same shot transition as LOCK, with a one-action external observation.
         It deliberately leaves S.fix intact: an Apple Watch fix must not
         silently become the phone's global location. */
      LOCK_AT: function (p) {
        var observed = observationPoint(p && p.observation);
        return observed ? lockAt(observed.point, observed.observation) : false;
      },

      /* Returns you to the resting state of the flow you are in (§5). In Live
         that is Track, with the shot untouched — you lose the picture, never the
         record. In Preview it is Setup, with the placement cleared, because
         Preview's "where am I" was an answer you gave and unlocking un-gives it. */
      UNLOCK: function () {
        if (mode() !== "aim") return false;
        if (flow() === "live") { S.live.mode = "track"; S.live.awayFixes = 0; }
        else S.preview = { mode: "setup", placement: null, target: null };
        syncEngine();
        return true;
      },

      AIM_DRAGGED: function (p) {
        var point = pt(p && p.point);
        if (!point || mode() !== "aim") return false;
        if (flow() === "live") {
          var open = openShot(S.live.hole);
          if (!open) return false;
          open.target = clampAim(pt(open.start), point);
        } else {
          S.preview.target = clampAim(S.preview.placement, point);
        }
        syncEngine();
        return true;
      },

      SHOT_END: function () {
        if (flow() !== "live" || S.live.mode !== "aim") return false;
        var open = openShot(S.live.hole);
        var here = S.fix.point;
        if (!open || !here) return false;
        completeShot(S.live.hole, open, here, "shot-end");
        S.live.mode = "logged";
        syncEngine();
        return true;
      },

      SHOT_END_AT: function (p) {
        if (flow() !== "live" || S.live.mode !== "aim") return false;
        var observed = observationPoint(p && p.observation);
        var open = openShot(S.live.hole);
        if (!observed || !open) return false;
        completeShot(S.live.hole, open, observed.point, "shot-end", observed.observation);
        S.live.mode = "logged";
        return true;
      },

      /* Green focus for the hole you are standing on. Live only, and only with
         something outstanding to close — arriving at a green with nothing to log
         does nothing, which is why this needs no dismissal flag.

         Catching up on an earlier hole does NOT come through here; it comes
         through LOG_OPENED. Two entrances for two different situations, rather
         than one entrance with a flow test inside it. */
      FINISH_OPENED: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        if (flow() !== "live" || hole !== S.live.hole) return false;
        if (!openShot(hole)) return false;
        /* Asking for it by hand un-dismisses it, or the button would appear to
           do nothing on a green the player closed a moment ago. */
        S.greenClosed = null;
        openFinish(hole, player());
        return true;
      },

      /* The picker's outstanding badge: "hole 4 has an origin and no outcome —
         log it now". The whole of deferred logging (§4.3), and the only way to
         reach green focus for a hole you are not on.

         It can only ever CLOSE a shot something else opened. There is
         deliberately no way to add a shot after the fact: the thing worth
         catching up on is the outcome of an approach you already locked, and a
         retro-add would be a second, unverifiable way for shots to exist.

         The ball starts wherever there is a real answer to start it — your fix
         if you have one, otherwise the green — so there is always something to
         drag rather than an empty green. */
      LOG_OPENED: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        if (!Number.isFinite(hole) || !openShot(hole)) return false;
        var r = holeRecord(S.round.pkg, hole);
        S.finish = null;
        S.logged = null;
        S.logging = {
          hole: hole,
          ball: S.fix.point || (r && r.green) || null,
          placed: false,
          from: S.viewHole
        };
        if (S.viewHole !== hole) enterHole(hole);
        syncEngine();
        return true;
      },

      BALL_MOVED: function (p) {
        var point = pt(p && p.point);
        if (!point) return false;
        if (S.logging) { S.logging.ball = point; S.logging.placed = true; return true; }
        /* Placing the ball IS an assertion that you are on the green, so it
           opens green focus when nothing has yet — which is how a Watch that
           reached the green on its own fix gets its answer accepted by a phone
           asleep in a bag with a stale one. Live only: Preview reaches green
           focus by tapping, and a tap that missed must not become a placement. */
        if (!S.finish && flow() === "live" && S.live.hole !== null) openFinish(S.live.hole, point);
        if (!S.finish) return false;
        S.finish.ball = point;
        S.finish.placed = true;
        return true;
      },

      FINISH_LOGGED: function () {
        /* Catching up. Record it and put the view back exactly where it was —
           no Logged screen, no side trip. You went to the picker to close one
           thing out; closing it should not cost you your place. */
        if (S.logging) {
          var back = S.logging.from;
          var target = S.logging.hole;
          var outstanding = openShot(target);
          var where = S.logging.ball;
          if (outstanding && where) completeShot(target, outstanding, where, S.logging.placed ? "ball-placed" : "ball-tracked");
          S.logging = null;
          S.logged = null;
          if (S.viewHole !== back) enterHole(back);
          syncEngine();
          return true;
        }
        if (!S.finish) return false;
        var hole = S.finish.hole;
        var open = openShot(hole);
        var ball = S.finish.ball || S.fix.point;
        /* Live only, and only with something outstanding: this is the real log,
           and it lands on the Logged screen. Catching up on a hole you are not
           standing on is S.logging's job (§4.3), handled above — so Preview
           reaching green focus is always a look, never a write, however it got
           there. */
        if (open && ball && flow() === "live") {
          completeShot(hole, open, ball, S.finish.placed ? "ball-placed" : "ball-tracked");
          S.finish = null;
          setMode("logged");
          return true;
        }
        /* Nothing outstanding — the green was a look. Close it and go back to
           the flow's resting state, with nothing written.

           Remembered as dismissed, because green focus is positional now: you
           are still standing inside the radius, and without this the very next
           fix puts it straight back up. */
        if (S.finish && flow() === "live") S.greenClosed = S.finish.hole;
        S.finish = null;
        setMode(flow() === "live" ? "track" : "setup");
        return true;
      },

      /* The hole is done. The holding screen between two holes, and the whole
         of what it is for: somewhere to stand that is not a hole.

         The score defaults to par and is WRITTEN, not merely displayed. Leaving
         the screen untouched means par, which is the common case and should
         cost nothing; SCORE_STEP is there for the other days. Not overwriting
         an existing score matters because a player may have set one from the
         card mid-hole. */
      HOLE_COMPLETED: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.live.hole);
        if (flow() !== "live" || hole !== S.live.hole) return false;
        if (S.live.mode === "complete") return false;
        S.finish = null;
        S.logged = null;
        S.greenClosed = null;
        S.live.mode = "complete";
        if (S.scores[hole] == null) {
          var r = holeRecord(S.round.pkg, hole);
          var par = r && Number.isFinite(Number(r.par)) && Number(r.par) > 0 ? Number(r.par) : null;
          if (par) setScore(hole, par);
        }
        syncEngine();
        return true;
      },

      /* The + and - on the holding screen. A step rather than a value, so both
         surfaces say the same small thing and the floor lives in one place: a
         hole cannot be played in fewer than one shot. */
      SCORE_STEP: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        var delta = Number(p && p.delta);
        if (!Number.isFinite(hole) || !Number.isFinite(delta) || !delta) return false;
        var r = holeRecord(S.round.pkg, hole);
        var par = r && Number.isFinite(Number(r.par)) && Number(r.par) > 0 ? Number(r.par) : null;
        /* No par and no score is a hole the package knows nothing about. Rather
           than invent a par to count from, the first step counts from zero, so
           + reads 1 and - has nothing to take away from. */
        var base = S.scores[hole] != null ? S.scores[hole] : (par || 0);
        return setScore(hole, Math.max(1, Math.round(base + delta)));
      },

      /* A published map arrived after the round started (course-store's
         background freshness check). The round is NOT restarted — shots
         already recorded stay, the live hole stays, the mode stays. Only the
         geometry underneath changes, plus the centre if the round began with
         nothing to derive one from. */
      PACKAGE_UPDATED: function (p) {
        if (!p || !p.pkg) return false;
        S.round.pkg = p.pkg;
        if (!S.round.centre) S.round.centre = packageCentre(p.pkg);
        enterHole(S.viewHole);
        return true;
      },

      SCORE_SET: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        return setScore(hole, Number(p && p.strokes));
      },

      /* Peels one layer. Answers false when there was nothing to close, so the
         caller falls through to Back's next meaning (leaving play). */
      BACK: function () {
        /* Abandoning a catch-up writes nothing and returns you where you were,
           so the shot stays outstanding and the badge stays on the card. */
        if (S.logging) {
          var back = S.logging.from;
          S.logging = null;
          if (S.viewHole !== back) enterHole(back);
          syncEngine();
          return true;
        }
        if (S.finish) {
          if (flow() === "live") S.greenClosed = S.finish.hole;
          S.finish = null;
          setMode(flow() === "live" ? "track" : "setup");
          return true;
        }
        /* Off the holding screen and back onto the green you just finished —
           the hole is still the live one until the next is started, so this
           costs nothing and un-does a Hole complete pressed by accident. The
           score it defaulted stays: it is on the card and the card is where it
           is changed. */
        if (mode() === "complete") { setMode("track"); return true; }
        if (mode() === "logged") { S.logged = null; setMode("track"); return true; }
        return false;
      }
    };

    /* Plain view navigation, in every flow. The round is not walked here — see
       NEXT_HOLE. */
    function viewStep(delta) {
      var next = stepHole(S.viewHole, delta);
      if (next === S.viewHole) return false;
      S.logging = null;
      S.logged = null;
      S.finish = null;
      enterHole(next);
      if (flow() === "preview") S.preview = { mode: "setup", placement: null, target: null };
      syncEngine();
      return true;
    }

    // ---------------------------------------------------------------- scene

    /* What should be on screen, as plain data, derived fresh every signal. The
       Painter diffs this and applies the difference; it decides nothing. Every
       field here is computed — none of it is stored, so none of it can drift
       away from the state it describes. */
    function scene() {
      var f = flow();
      var m = mode();
      var r = rec();
      var who = player();
      var live = f === "live";
      var open = live ? openShot(S.live.hole) : null;
      var aiming = m === "aim";
      var aimShot = aiming ? (live ? open : { start: S.preview.placement, target: S.preview.target }) : null;

      /* In green focus the BALL is where you are — you have picked it up and
         put it where the shot finished — so that is what the numbers measure
         from. Everywhere else it is the player. */
      var from = (S.finish && S.finish.ball) || (S.logging && S.logging.ball) || who;
      var d = (from && r) ? distance.greenDistances(from, r) : null;
      /* The catch-up in progress reads as a finish, so the Painter needs no idea
         that Logging is a separate flow — it draws a ball and a Shot End either
         way. What it DOES need is scene.flow, so the banner can say so. */
      var focus = S.logging
        ? { show: true, hole: S.logging.hole, ball: S.logging.ball, placed: S.logging.placed,
            origin: (openShot(S.logging.hole) || {}).start || null, canLog: !!openShot(S.logging.hole) }
        : S.finish
          ? { show: true, hole: S.finish.hole, ball: S.finish.ball, placed: S.finish.placed,
              origin: (openShot(S.finish.hole) || {}).start || null, canLog: !!openShot(S.finish.hole) }
          : { show: false, canLog: false };

      return {
        flow: f,
        mode: m,
        hole: { number: S.viewHole, rec: r },

        /* What the player badge reads off. `course` is round state and so
           belongs here; who the player is, and whether this is Demo Mode, are
           not — the Painter takes those from GDPlayContext and GDDemoSession
           the same way it takes the bubble from GDBubbleEngine. */
        banner: {
          flow: f,
          hole: S.viewHole,
          course: S.round.courseName || "",
          returnTo: f !== "live" && S.live.hole !== null ? S.live.hole : null
        },

        /* Before the round: at the course with a fix is enough, and it starts
           the nearest hole. That is how you get going from the car park.

           During the round: it appears on the hole you are LOOKING at, and only
           once the fix says you have arrived there. That is the whole of "scroll
           through the holes and when you get to the one you are close to, the
           Play button comes up" — and it is the only thing that moves the round
           on, so the app can never decide for itself that you are on a hole you
           have not reached. */
        playButton: {
          show: playOffered(),
          hole: playableHole()
        },

        /* Two different questions, deliberately two fields.

           `player` is who the FLOW is playing as: the trusted fix in Live, your
           placement in Preview. It is what the distances measure from, because
           "if I stood here, how far is the green" is the whole question Preview
           answers.

           `locator` is where you ACTUALLY are, in both flows. It is what the dot
           draws, so the dot means one thing everywhere — and it is what makes
           the edge clamp work while previewing hole 5 from the 3rd fairway,
           which is the case §6 exists for. */
        player: who,
        locator: S.fix.point ? { lat: S.fix.point.lat, lng: S.fix.point.lng, stale: !S.fix.fresh } : null,

        /* The one rule the whole audit was about: no bubble unless you asked
           for one. In Live that means a Lock; in Preview, a placement. */
        bubble: {
          show: !!(aimShot && aimShot.start && aimShot.target),
          start: aimShot ? aimShot.start : null,
          target: aimShot ? aimShot.target : null
        },

        /* Green focus keeps a number, because you are still playing: the
           chip and the putt both want to know how far the middle is. It is
           one number rather than the full front/centre/back card — `single`
           says so — and the pin, when one is set, is a better answer than the
           middle and is drawn by the Painter beside the pin itself. */
        distances: {
          show: !!d && m !== "logged" && m !== "complete",
          single: m === "finish",
          from: from ? { lat: from.lat, lng: from.lng } : null,
          front: d ? d.front : null,
          centre: d ? d.centre : null,
          back: d ? d.back : null
        },

        startPill: { show: f === "preview" && m === "setup" && !!(r && r.tee) },

        /* Aiming ALWAYS offers Unlock, in either flow — it is the only way back
           to the flow's resting state (§5), and without it Preview's Head To
           the Tee was a one-way door: placed, bubble up, no pill, no way to
           change your mind short of leaving the hole.

           Lock is Live-only — Preview has no shots to open. The Shot End FACE
           appears in Preview's green focus, because that is the way out of it,
           but `canShotEnd` (the separate mid-aim button) stays Live-only: the
           face closes a green, the button closes a shot. */
        dock: {
          show: m === "aim" || m === "finish" || (live && m === "track" && !!S.fix.point),
          face: m === "finish" ? "shotEnd" : (m === "aim" ? "unlock" : "lock"),
          canShotEnd: live && m === "aim" && !!S.fix.point
        },

        /* The button that OPENS green focus for the hole you are on, offered
           while there is something outstanding on it. Live and resting only:
           while Aiming, Shot End is already the thing to press, and Preview
           needs no button — tapping the green is how you get there. */
        finishControl: { show: live && m === "track" && !!openShot(S.viewHole) },

        /* `canLog` is the difference between the two reasons to be here: a
           shot outstanding makes Shot End a write, and nothing outstanding
           makes green focus a place to stand and read the green. Both are
           legitimate — you do not have to lock a shot to walk onto a green. */
        finish: focus,

        logged: (m === "logged" && S.logged) ? {
          show: true,
          hole: S.logged.hole,
          record: S.logged.record,
          score: S.scores[S.logged.hole] || null,
          next: nextAfterLogged()
        } : { show: false },

        /* The holding screen. Hole done, nothing asked of you: the score is
           already par unless you touch it, and the only thing to press is the
           next hole. It is the one screen in the app that is not about a
           position, which is exactly why it exists — everything before it was
           a hole you were standing on and everything after it is a hole you
           have not reached. */
        holeComplete: (live && m === "complete") ? {
          show: true,
          hole: S.live.hole,
          par: r && Number.isFinite(Number(r.par)) ? Number(r.par) : null,
          score: S.scores[S.live.hole] != null ? S.scores[S.live.hole] : null,
          shots: shotsFor(S.live.hole).length,
          next: nextAfterComplete()
        } : { show: false },

        /* The next hole, previewed. `arrival` is the distance to its tee, so
           the screen can say how far the walk is rather than leaving the
           player to guess why Play has not pressed itself yet. */
        queued: (f === "preview" && m === "queued") ? {
          show: true,
          hole: S.viewHole,
          par: r && Number.isFinite(Number(r.par)) ? Number(r.par) : null,
          lengthM: (r && r.tee && r.green) ? Math.round(metres(r.tee, r.green)) : null,
          arrivalM: (r && r.tee && S.fix.point) ? Math.round(metres(S.fix.point, r.tee)) : null,
          atTee: inTeeZone(S.viewHole)
        } : { show: false },

        /* Offered on the green, which is the one place the hole can honestly
           be called done. Not on the Logged screen: that screen has its own
           button and already offers this as its `next` — a second control
           behind a full-screen overlay is a control nobody can press. */
        holeCompleteControl: { show: live && m === "finish" },

        /* The card. `marks` is per hole: `done` outcomes recorded and `open`
           origins still waiting for one, so the picker can draw 0 for something
           outstanding, 0-0 for a shot that has both ends, and x2 / x3 where a
           par 5 took more than one lock. An `open` count is the tappable way
           into Logging, and the only one. */
        picker: { holes: holesInPlay(), current: S.viewHole, marks: pickerMarks(), pars: parMap() },

        /* What to frame. The Painter solves the transform; the Marshal only says
           what the camera is looking at. It never asks for the player to be
           fitted in — a fix that does not land on screen is edge-clamped by the
           Painter instead (§6). */
        camera: {
          stage: m === "finish" ? "green" : (aiming ? "shot" : "hole"),
          hole: r,
          shot: aimShot,
          /* A point on the green-focus radius, so the camera can frame the
             whole 40m band as a circle rather than framing the green polygon.
             It is given as a POINT and not a number of metres because the
             framing happens in the presentation's own pixel space, which knows
             nothing about metres — it projects this and measures. Without it
             the ball you are asked to drag starts outside the frame the moment
             you are more than a green's width from the middle, which is most
             of the band. */
          focus: (m === "finish" && r && r.green) ? distance.project(r.green, 0, GREEN_FOCUS_M) : null,
          /* The course centre, so a hole with no tee or green still has
             somewhere to point the map — and so the basemap can be chosen at
             all, which is what keeps the imagery attribution on screen. */
          centre: S.round.centre
        }
      };
    }

    /* The Logged screen only ever follows a shot you ended on the hole you are
       playing — a catch-up returns you where you were rather than routing
       through here — so this has one job: the next hole, or the end of the
       round.

       It used to branch three more ways, for finding the next outstanding hole
       and getting back from it. That is the picker's job now, and none of those
       branches were reachable any more. */
    function nextAfterLogged() {
      if (S.live.hole === null) return { label: "Done", signal: "BACK", payload: null };
      /* Where the shot ENDED decides what comes next, because that is the only
         thing that distinguishes the last shot of a hole from any other one.
         Ended on the green: the hole is done, and the holding screen is next.
         Ended anywhere else: you shot-ended mid-hole, and what is next is the
         rest of the hole. */
      var end = S.logged && S.logged.record && S.logged.record.end;
      var d = end ? toGreen(end, S.live.hole) : null;
      return (d !== null && d <= GREEN_FOCUS_M)
        ? { label: "Hole complete", signal: "HOLE_COMPLETED", payload: { hole: S.live.hole } }
        : { label: "Keep playing", signal: "BACK", payload: null };
    }

    /* And the holding screen's own button: the next hole, queued up. */
    function nextAfterComplete() {
      if (S.live.hole === null) return { label: "Done", signal: "BACK", payload: null };
      var next = stepHole(S.live.hole, 1);
      return next !== S.live.hole
        ? { label: "Next hole", hole: next, signal: "ADVANCE_TO_HOLE", payload: { hole: next } }
        : { label: "End round", hole: null, signal: "END_ROUND", payload: null };
    }

    // ------------------------------------------------------------------ api

    function signal(name, payload) {
      var handler = HANDLERS[name];
      var before = { flow: flow(), mode: mode() };
      if (!handler) {
        if (trace) trace.signal(name, payload, { known: false, changed: false, before: before });
        return false;
      }
      var changed = false;
      try { changed = !!handler(payload || {}); }
      catch (e) {
        if (trace) trace.error(name, e);
        return false;
      }
      var after = { flow: flow(), mode: mode() };
      if (trace) trace.signal(name, payload, { known: true, changed: changed, before: before, after: after });
      if (changed) publish(name);
      return changed;
    }

    function publish(cause) {
      lastScene = scene();
      sceneListeners.forEach(function (fn) {
        /* Deliberately NOT swallowed the way position.js swallowed its
           listeners: a crash in the Painter used to be completely invisible —
           the screen simply stopped updating. Report it and carry on. */
        try { fn(lastScene, cause); }
        catch (e) { if (trace) trace.error("PAINT:" + cause, e); }
      });
    }

    return {
      signal: signal,
      scene: function () { return lastScene || (lastScene = scene()); },
      onScene: function (fn) { if (typeof fn === "function") sceneListeners.push(fn); },

      /* The small, purposeful reads the tool modules need. Deliberately not a
         general "give me the state" — each of these is a question something
         actually asks (wind wants a point to look up, the scorecard wants the
         holes in play, Course Data wants the course key), and keeping them means
         a new caller has to say what it wants rather than helping itself. */
      round: function () {
        return {
          roundId: S.round.id,
          courseKey: S.round.courseKey,
          hole: S.viewHole,
          liveHole: S.live.hole,
          holesInPlay: holesInPlay()
        };
      },
      player: player,
      lastFix: function () { return S.fix.point; },

      /* Read-only, for Trace and for tests. Never a way in. */
      state: function () { return JSON.parse(JSON.stringify(S)); },
      shots: function (hole) { return (S.shots[hole] || []).slice(); },
      openShot: openShot,
      constants: { AT_COURSE_M: AT_COURSE_M, GREEN_FOCUS_M: GREEN_FOCUS_M, GREEN_RELEASE_M: GREEN_RELEASE_M, GREEN_APPROACH_M: GREEN_APPROACH_M,
        TEE_ZONE_M: TEE_ZONE_M, HOLE_ARRIVAL_M: HOLE_ARRIVAL_M, AIM_RELEASE_M: AIM_RELEASE_M, AIM_RELEASE_FIXES: AIM_RELEASE_FIXES }
    };
  }

  createMarshal.holeRecord = holeRecord;
  createMarshal.packageCentre = packageCentre;
  return createMarshal;
});
