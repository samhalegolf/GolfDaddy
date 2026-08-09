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

  /* Inside this of the green centre, Finish opens itself — but only when there
     is an open shot to log (§4.3). Arriving at a green with nothing outstanding
     does nothing, which is correct. */
  var GREEN_FOCUS_M = 40;

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
      tee: pt(geometry.tee),
      green: pt(geometry.green),
      greenShape: (Array.isArray(geometry.greenShape) ? geometry.greenShape : []).map(pt).filter(Boolean),
      route: (Array.isArray(geometry.route) ? geometry.route : []).map(pt).filter(Boolean),
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

    function emptyState() {
      return {
        round: { courseKey: null, pkg: null, centre: null, nines: null, open: false },
        atCourse: false,
        viewHole: 0,
        /* liveHole is set by Play and cleared by End Round. NOTHING ELSE
           TOUCHES IT — not a dropped fix, not a denial, not a sleeping phone.
           Losing GPS changes what Track can draw, never which flow you are in
           (§2). This one line is the whole of "Live is sticky". */
        live: { hole: null, mode: "track", awayFixes: 0 },
        preview: { mode: "setup", placement: null, target: null },
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

    function flow() {
      return (S.live.hole !== null && S.viewHole === S.live.hole) ? "live" : "preview";
    }

    function mode() {
      return flow() === "live" ? S.live.mode : S.preview.mode;
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

    function holesWithOpenShots() {
      return Object.keys(S.shots)
        .map(Number)
        .filter(function (h) { return !!openShot(h); })
        .sort(function (a, b) { return a - b; });
    }

    /* Where the player is. Live: the trusted fix, full stop. Preview: the
       placement you made. Two different questions, so two different sources —
       which is why there is no "source" policy to get wrong any more. */
    function player() {
      if (flow() === "live") {
        return S.fix.point ? { lat: S.fix.point.lat, lng: S.fix.point.lng, stale: !S.fix.fresh } : null;
      }
      var placed = S.preview.placement;
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

    function holesInPlay() {
      if (S.round.nines && Array.isArray(S.round.nines.holesInPlay)) return S.round.nines.holesInPlay;
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

    function setMode(next) {
      if (flow() === "live") S.live.mode = next;
      else S.preview.mode = next;
    }

    function completeShot(hole, shot, endPoint, method) {
      shot.end = pt(endPoint);
      shot.method = method;
      if (typeof fx.shotCompleted === "function") {
        try { fx.shotCompleted({ start: shot.start, target: shot.target, end: shot.end }, { hole: hole, captureMethod: method }); }
        catch (e) {}
      }
      S.logged = { hole: hole, record: { start: shot.start, target: shot.target, end: shot.end, method: method } };
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
          courseKey: p.courseKey || null,
          pkg: p.pkg || null,
          centre: pt(p.centre) || packageCentre(p.pkg),
          nines: p.nines || null,
          open: true
        };
        enterHole(p.hole || holesInPlay()[0] || 1);
        if (typeof fx.roundStarted === "function") { try { fx.roundStarted(S.round.courseKey); } catch (e) {} }
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
        if (flow() !== "live") return true;

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

        /* Arriving at the green opens Finish — but only with something to log.
           Nothing outstanding means nothing happens, which is why this needs no
           dismissal flag to stop it re-opening. */
        if (S.live.mode === "track" && openShot(S.live.hole)) {
          var r = rec();
          var toGreen = r && r.green ? metres(point, r.green) : null;
          if (toGreen !== null && toGreen <= GREEN_FOCUS_M) {
            S.finish = { hole: S.live.hole, ball: point, placed: false };
            S.live.mode = "finish";
          }
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

      PLAY_PRESSED: function () {
        if (!S.atCourse || !S.fix.point) return false;
        var hole = nearestHole(S.fix.point);
        S.live = { hole: hole || S.viewHole, mode: "track", awayFixes: 0 };
        S.preview = { mode: "setup", placement: null, target: null };
        if (S.viewHole !== S.live.hole) enterHole(S.live.hole);
        return true;
      },

      END_ROUND: function () {
        if (S.live.hole === null) return false;
        S.live = { hole: null, mode: "track", awayFixes: 0 };
        S.preview = { mode: "setup", placement: null, target: null };
        S.finish = null;
        S.logged = null;
        if (typeof fx.roundEnded === "function") { try { fx.roundEnded(); } catch (e) {} }
        return true;
      },

      /* The picker: "show me hole N". Looking around, not moving on — so it
         never advances the round. Landing anywhere but the live hole is Preview,
         which opens at SETUP with nothing placed. */
      VIEW_HOLE_CHANGED: function (p) {
        var hole = Number(p && p.hole);
        if (!Number.isFinite(hole) || hole === S.viewHole) return false;
        S.logged = null;
        S.finish = null;
        enterHole(hole);
        if (flow() === "preview") S.preview = { mode: "setup", placement: null, target: null };
        syncEngine();
        return true;
      },

      /* The arrows: "I have moved on". In Live that walks the round, so the hole
         you are playing keeps up with you without a Play press per hole. In
         Preview there is no round to walk, so it is plain navigation. */
      NEXT_HOLE: function () { return stepRound(1); },
      PREV_HOLE: function () { return stepRound(-1); },

      /* Preview only: placing yourself IS the plan, so the lock-in is automatic
         and the bubble is there with nothing to press (§3). */
      PLACED: function (p) {
        if (flow() !== "preview") return false;
        var point = pt(p && p.point);
        if (!point) return false;
        S.preview.placement = point;
        S.preview.target = pt(defaultTarget(point, rec()));
        S.preview.mode = "aim";
        syncEngine();
        return true;
      },

      /* Live only. Closes the previous shot HERE and opens the next from here,
         which is why mid-hole boundaries need no separate action and why Shot
         End is only ever the hole's last shot (§4.0). */
      LOCK: function () {
        if (flow() !== "live" || S.live.mode !== "track") return false;
        var here = S.fix.point;
        if (!here) return false;
        var hole = S.live.hole;
        var open = openShot(hole);
        if (open) completeShot(hole, open, here, "lock");
        else S.logged = null;
        shotsFor(hole).push({ start: here, target: pt(defaultTarget(here, rec())), end: null, method: null });
        S.live.mode = "aim";
        S.live.awayFixes = 0;
        syncEngine();
        return true;
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
          open.target = point;
        } else {
          S.preview.target = point;
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

      /* Reachable from either flow, for any hole still holding an open shot —
         that is the deferred logging in §4.3. Preview may CLOSE a shot Live
         opened; what it may never do is open one. */
      FINISH_OPENED: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        var open = openShot(hole);
        if (!open) return false;
        S.finish = { hole: hole, ball: S.finish && S.finish.hole === hole ? S.finish.ball : null, placed: false };
        setMode("finish");
        return true;
      },

      BALL_MOVED: function (p) {
        var point = pt(p && p.point);
        if (!point || !S.finish) return false;
        S.finish.ball = point;
        S.finish.placed = true;
        return true;
      },

      FINISH_LOGGED: function () {
        if (!S.finish) return false;
        var hole = S.finish.hole;
        var open = openShot(hole);
        var ball = S.finish.ball || S.fix.point;
        if (!open || !ball) return false;
        completeShot(hole, open, ball, S.finish.placed ? "ball-placed" : "ball-tracked");
        S.finish = null;
        setMode("logged");
        return true;
      },

      SCORE_SET: function (p) {
        var hole = Number((p && p.hole) != null ? p.hole : S.viewHole);
        var strokes = Number(p && p.strokes);
        if (!Number.isFinite(hole) || !Number.isFinite(strokes) || strokes < 1) return false;
        if (S.scores[hole] === strokes) return false;
        S.scores[hole] = strokes;
        if (typeof fx.scoreSet === "function") { try { fx.scoreSet(hole, strokes); } catch (e) {} }
        return true;
      },

      /* Peels one layer. Answers false when there was nothing to close, so the
         caller falls through to Back's next meaning (leaving play). */
      BACK: function () {
        if (S.finish) { S.finish = null; setMode(flow() === "live" ? "track" : "setup"); return true; }
        if (mode() === "logged") { S.logged = null; setMode("track"); return true; }
        return false;
      }
    };

    function stepRound(delta) {
      var live = flow() === "live";
      var from = live ? S.live.hole : S.viewHole;
      var next = stepHole(from, delta);
      if (next === from) return false;
      S.logged = null;
      S.finish = null;
      if (live) { S.live = { hole: next, mode: "track", awayFixes: 0 }; }
      enterHole(next);
      if (!live) S.preview = { mode: "setup", placement: null, target: null };
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

      var d = (who && r) ? distance.greenDistances(who, r) : null;
      var pending = holesWithOpenShots();

      return {
        flow: f,
        mode: m,
        hole: { number: S.viewHole, rec: r },

        banner: {
          flow: f,
          hole: S.viewHole,
          returnTo: f === "preview" && S.live.hole !== null ? S.live.hole : null
        },

        /* Gated on being at the course and nothing else. You cannot start a
           round the app cannot place you in — but once started it holds (§2). */
        playButton: {
          show: S.round.open && S.live.hole === null && S.atCourse && !!S.fix.point,
          hole: S.fix.point ? nearestHole(S.fix.point) : null
        },

        player: who,

        /* The one rule the whole audit was about: no bubble unless you asked
           for one. In Live that means a Lock; in Preview, a placement. */
        bubble: {
          show: !!(aimShot && aimShot.start && aimShot.target),
          start: aimShot ? aimShot.start : null,
          target: aimShot ? aimShot.target : null
        },

        distances: {
          show: !!d && m !== "finish" && m !== "logged",
          front: d ? d.front : null,
          centre: d ? d.centre : null,
          back: d ? d.back : null
        },

        startPill: { show: f === "preview" && m === "setup" && !!(r && r.tee) },

        dock: {
          show: live && (m === "track" ? !!S.fix.point : m === "aim"),
          face: m === "aim" ? "unlock" : "lock",
          canShotEnd: m === "aim" && !!S.fix.point
        },

        /* Offered exactly when this hole has an open shot. Derived from the
           record, so it is right retroactively and cannot be left armed. */
        finishControl: { show: !!openShot(S.viewHole) && m !== "finish" && m !== "logged" },

        finish: S.finish ? {
          show: true,
          hole: S.finish.hole,
          ball: S.finish.ball,
          placed: S.finish.placed,
          origin: (openShot(S.finish.hole) || {}).start || null
        } : { show: false },

        logged: (m === "logged" && S.logged) ? {
          show: true,
          hole: S.logged.hole,
          record: S.logged.record,
          score: S.scores[S.logged.hole] || null,
          next: nextAfterLogged()
        } : { show: false },

        picker: { flagged: pending, holes: holesInPlay(), current: S.viewHole },

        /* What to frame. The Painter solves the transform; the Marshal only says
           what the camera is looking at. It never asks for the player to be
           fitted in — a fix that does not land on screen is edge-clamped by the
           Painter instead (§6). */
        camera: {
          stage: m === "finish" ? "green" : (aiming ? "shot" : "hole"),
          hole: r,
          shot: aimShot
        }
      };
    }

    /* The Logged screen's button reads the situation: the next hole when you
       logged the one you are playing, the next outstanding hole when you are
       catching up, and back to your live hole when that was the last of them. */
    function nextAfterLogged() {
      var loggedHole = S.logged ? S.logged.hole : S.viewHole;
      var pending = holesWithOpenShots().filter(function (h) { return h !== loggedHole; });
      if (S.live.hole !== null && loggedHole === S.live.hole) {
        var next = stepHole(S.live.hole, 1);
        return next !== S.live.hole
          ? { label: "Hole " + next, signal: "NEXT_HOLE", payload: null }
          : { label: "End round", signal: "END_ROUND", payload: null };
      }
      if (pending.length) {
        return { label: "Next pending: hole " + pending[0], signal: "VIEW_HOLE_CHANGED", payload: { hole: pending[0] } };
      }
      if (S.live.hole !== null) {
        return { label: "Back to hole " + S.live.hole, signal: "VIEW_HOLE_CHANGED", payload: { hole: S.live.hole } };
      }
      return { label: "Done", signal: "BACK", payload: null };
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
      /* Read-only, for Trace and for tests. Never a way in. */
      state: function () { return JSON.parse(JSON.stringify(S)); },
      shots: function (hole) { return (S.shots[hole] || []).slice(); },
      openShot: openShot,
      constants: { AT_COURSE_M: AT_COURSE_M, GREEN_FOCUS_M: GREEN_FOCUS_M, AIM_RELEASE_M: AIM_RELEASE_M, AIM_RELEASE_FIXES: AIM_RELEASE_FIXES }
    };
  }

  createMarshal.holeRecord = holeRecord;
  createMarshal.packageCentre = packageCentre;
  return createMarshal;
});
