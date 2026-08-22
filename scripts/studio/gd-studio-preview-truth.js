/* Course Visual Studio - preview truth model.
   STUDIO ONLY (index.html loads it with data-gd-surface="studio").

   The Studio used to answer "is this effect on?" by reading the control values.
   That is what the operator asked for, not what the phone preview is showing, and
   the two drift apart constantly: a bake takes seconds, a second adjustment lands
   mid-bake, a bake fails silently, a stale bake finishes last. The panel then
   described a picture that was never rendered.

   This module owns the difference. It knows three things and nothing else:

     CURRENT   the recipe the controls are asking for (last commit)
     IN FLIGHT which committed recipe is being rendered, and since when
     DISPLAYED the recipe that produced the frame currently painted in the phone

   Everything the Studio says out loud - the status line, the progress bar, the
   ingredient chips - is derived from those three. Nothing here touches the DOM,
   the engine or the network: the caller supplies a `run` function per request and
   calls noteDisplayedFrame() when it actually paints something. That keeps the
   whole lifecycle testable in node (dev/studio-preview-truth.test.js).

   Scheduling is latest-request-wins. One render at a time; anything committed
   while a render is in flight replaces whatever was waiting. Intermediate states
   are allowed to be skipped, the newest committed one never is. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GDStudioPreviewTruth = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STATE = {
    REQUESTED: "requested",
    RENDERING: "rendering",
    DISPLAYED: "displayed",
    /* The render produced a real frame and the phone is showing something else - a
       terrain preview, a cloud frame. Not a failure, and emphatically not a
       confirmation, so it gets its own name rather than being forced into one. */
    RENDERED: "rendered-not-displayed",
    FAILED: "failed",
    TIMED_OUT: "timed-out",
    SUPERSEDED: "superseded"
  };
  var TERMINAL = { displayed: true, "rendered-not-displayed": true, failed: true, "timed-out": true, superseded: true };

  /* A bake of one hole over owned rasters is normally well under two seconds. Six
     seconds is the point where it is worth saying so; fifteen is the point where
     waiting longer teaches the operator nothing. Terrain is a server round trip
     that shades from LINZ elevation - twelve, per the relief endpoint's own budget. */
  var TIMEOUT_BAKE = 15000;
  var TIMEOUT_TERRAIN = 12000;
  var SLOW_AFTER = 6000;
  /* How long a finished render is given to actually appear. The paint is synchronous
     with the caller's repaint, so this only ever elapses when the phone is showing a
     different picture on purpose. */
  var PAINT_GRACE = 1500;

  function num(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  /* Same FNV-1a as the engine's hashString, so a hash computed here from the form
     compares directly against the overrideHash the engine stamped onto a baked
     frame. dev/studio-preview-truth.test.js pins the two against each other. */
  function overrideHash(value) {
    var str = typeof value === "string" ? value : JSON.stringify(value || "");
    var hash = 2166136261;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return ("00000000" + (hash >>> 0).toString(16)).slice(-8);
  }

  /* Mowing visibility is an enum on the recipe, not a number. Number("Clear") is
     NaN, so the old `Number(settings.mowingVisibility) > .02` test reported mow
     lines as off at every setting including Prominent. The engine's own
     mowingOpacity() maps Low/Clear/Prominent to .12/.28/.48 and everything else
     to 0 - this is that mapping, as a predicate. */
  function mowingActive(value) {
    var v = String(value == null ? "" : value).trim();
    return v === "Low" || v === "Clear" || v === "Prominent";
  }

  function turfSignature(s) {
    var t = (s && s.turf) || {};
    return [
      num(t.greenStrength, 0.35), num(t.greenTone, 0), num(t.targetPull, 1),
      num(t.hueMin, 86), num(t.hueMax, 142),
      num(t.saturationMin, 28), num(t.saturationMax, 66),
      num(t.brightnessMin, 30), num(t.brightnessMax, 72)
    ].join("/");
  }
  function floodSignature(s) {
    var f = (s && s.floodlight) || {};
    return [
      f.enabled === true ? 1 : 0, num(f.ambientLevel, 24), num(f.litLevel, 64),
      num(f.throwOff, 0.35), num(f.spread, 0.45), num(f.greenPool, 0.8),
      num(f.greenPoolRadius, 0.22), f.useObjectMask === true ? 1 : 0
    ].join("/");
  }

  /* An ingredient is on/off plus a signature. On/off alone is not enough truth:
     brightness 56 and brightness 60 are both "on", and a chip that stays green
     across a change the picture has not received yet is the exact lie this file
     exists to remove. */
  var INGREDIENTS = [
    {
      id: "brightness", label: "Brightness",
      on: function (s) { return Math.abs(num((s.lighting || {}).brightnessTarget, 52) - 52) > 2; },
      sig: function (s) { return String(num((s.lighting || {}).brightnessTarget, 52)); }
    },
    {
      id: "contrast", label: "Contrast",
      on: function (s) { return Math.abs(num((s.lighting || {}).contrastTarget, 1) - 1) > 0.03; },
      sig: function (s) {
        var l = s.lighting || {};
        return [num(l.contrastTarget, 1), num(l.shadowFloor, 14), num(l.highlightCeiling, 92)].join("/");
      }
    },
    {
      id: "shadowlift", label: "Shadow lift",
      on: function (s) { return num((s.lighting || {}).shadowLiftStrength, 0) > 0.02; },
      sig: function (s) {
        var l = s.lighting || {};
        return [num(l.shadowLiftStrength, 0), num(l.shadowLiftThreshold, 30)].join("/");
      }
    },
    {
      id: "turf", label: "Turf tone",
      on: function (s) { return num((s.turf || {}).greenStrength, 0.35) > 0.05; },
      sig: turfSignature
    },
    {
      id: "floodlight", label: "Floodlight",
      on: function (s) { return !!(s.floodlight && s.floodlight.enabled === true); },
      sig: floodSignature
    },
    {
      id: "mow", label: "Mow lines",
      on: function (s) { return mowingActive(s.mowingVisibility); },
      sig: function (s) { return String(s.mowingVisibility == null ? "" : s.mowingVisibility); }
    },
    {
      /* Terrain relief never comes out of the local pixel bake - the main preview
         gets it from /api/relief-preview as a transient server render, and the
         shipped frame gets it from the cloud export. So it cannot be confirmed by
         comparing recipe hashes on a baked frame; it is confirmed only when the
         main phone is actually showing the terrain frame. */
      id: "terrain", label: "Terrain", confirm: "terrain-frame",
      on: function (s) { return num((s.visualTools || {}).holeTerrainStrength, 0.9) > 0.02; },
      sig: function (s) { return String(num((s.visualTools || {}).holeTerrainStrength, 0.9)); }
    }
  ];

  /* current   : merged settings the controls are asking for
     displayed : merged settings that produced the painted frame, or null if the
                 frame's recipe cannot be identified (a cloud frame, a raw capture,
                 a bake from a previous session)
     pipeline  : {state, kind} from status()
     terrain   : {confirmed:boolean} - is the painted frame the latest terrain render */
  function ingredientStates(input) {
    input = input || {};
    var current = input.current || {};
    var displayed = input.displayed || null;
    var pipeline = input.pipeline || {};
    var terrain = input.terrain || {};
    var busyState = pipeline.state === STATE.RENDERING ? "applying"
      : pipeline.state === STATE.REQUESTED ? "waiting"
        : pipeline.state === STATE.FAILED ? "failed"
          : pipeline.state === STATE.TIMED_OUT ? "timed-out"
            : "unconfirmed";
    return INGREDIENTS.map(function (ing) {
      var wantOn = !!ing.on(current);
      var state;
      if (ing.confirm === "terrain-frame") {
        if (!wantOn) state = "off";
        else if (terrain.confirmed) state = "confirmed";
        else if (pipeline.state === STATE.RENDERING && pipeline.kind === "terrain") state = "applying";
        else if (pipeline.state === STATE.REQUESTED && pipeline.kind === "terrain") state = "waiting";
        else if (pipeline.kind === "terrain" && pipeline.state === STATE.FAILED) state = "failed";
        else if (pipeline.kind === "terrain" && pipeline.state === STATE.TIMED_OUT) state = "timed-out";
        else state = "unconfirmed";
      } else if (!displayed) {
        state = wantOn ? "unconfirmed" : "off";
      } else if (ing.sig(current) === ing.sig(displayed)) {
        state = wantOn ? "confirmed" : "off";
      } else {
        state = busyState;
      }
      return {
        id: ing.id,
        label: ing.label,
        state: state,
        wanted: wantOn,
        text: ingredientText(ing, state, wantOn)
      };
    });
  }

  function ingredientText(ing, state, wantOn) {
    if (ing.confirm === "terrain-frame") {
      if (state === "off") return "Terrain — off";
      if (state === "confirmed") return "Terrain — preview confirmed";
      if (state === "applying") return "Applying Terrain…";
      if (state === "waiting") return "Terrain — waiting";
      if (state === "failed") return "Terrain preview failed";
      if (state === "timed-out") return "Terrain preview timed out";
      return "Terrain — configured, not in displayed frame";
    }
    if (state === "off") return ing.label;
    if (state === "confirmed") return ing.label;
    if (state === "applying") return (wantOn ? "Applying " : "Removing ") + ing.label + "…";
    if (state === "waiting") return ing.label + " — waiting";
    if (state === "failed") return ing.label + " — failed";
    if (state === "timed-out") return ing.label + " — timed out";
    return ing.label + " — not in displayed frame";
  }

  function createPreviewTruth(options) {
    options = options || {};
    var nowFn = options.now || function () { return Date.now(); };
    var setTimer = options.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer = options.clearTimeout || function (id) { clearTimeout(id); };
    var onChange = options.onChange || function () { };
    var logFn = options.log || null;

    var seq = 0;
    var courses = Object.create(null);
    var journal = [];

    function state(courseId) {
      var key = String(courseId || "");
      if (!courses[key]) {
        courses[key] = {
          courseId: key,
          active: null,      /* rendering right now */
          queued: null,      /* latest commit waiting for the slot */
          desired: null,     /* newest committed snapshot, whatever became of it */
          displayed: null,   /* the frame the phone is actually painting */
          /* Counts how many times the picture has actually CHANGED. Wall-clock time
             cannot answer "has the phone been repainted since this was asked for?" -
             two events in the same millisecond are indistinguishable - and this is the
             question the stale-frame recovery below turns on. */
          frameSeq: 0,
          lastConfirmed: null,
          /* Every recipe this session has asked to render, by the hash the engine
             stamps onto the frame it produces. A frame is identified by looking its
             hash up here - which stays true even after the saved recipe has moved on,
             and even for effects (terrain strength) that change the hash without
             changing what the local bake draws. */
          recipes: Object.create(null),
          recipeOrder: [],
          /* Recent requests by id. An abandoned render can arrive long after it has
             stopped being either the active or the newest-finished request, and it
             still has to be recognisable when it does - otherwise the frame it just
             wrote onto the record goes unnoticed. */
          recent: [],
          reconciledFor: "",
          last: null         /* newest terminal request, for the status line */
        };
      }
      return courses[key];
    }

    function log(request, extra) {
      var line = {
        at: nowFn(),
        requestId: request.requestId,
        courseId: request.courseId,
        hole: request.holeNumber,
        control: request.control || "",
        kind: request.kind,
        overrideHash: request.overrideHash,
        state: request.state
      };
      if (extra) Object.keys(extra).forEach(function (k) { line[k] = extra[k]; });
      journal.push(line);
      if (journal.length > 200) journal.splice(0, journal.length - 200);
      if (logFn) logFn(line);
      return line;
    }

    function changed(courseId, reason) {
      try { onChange(String(courseId || ""), reason || ""); } catch (e) { }
    }

    /* Two frames are the same picture when the same recipe rendered the same hole.
       Terrain frames carry no recipe hash the bake could reproduce, so they are
       identified by the request that fetched them. */
    function matchKey(descriptor) {
      if (!descriptor) return "";
      if (descriptor.kind === "terrain") return "terrain:" + descriptor.requestId;
      return ["bake", descriptor.presetId || "", descriptor.overrideHash || "", descriptor.holeNumber || 0].join(":");
    }

    function frameMatchesRequest(frame, request) {
      if (!frame || !request) return false;
      if (request.kind === "terrain") {
        return frame.kind === "terrain" && Number(frame.requestId) === Number(request.requestId);
      }
      if (frame.kind === "terrain") return false;
      if (!frame.overrideHash) return false;
      return String(frame.overrideHash) === String(request.overrideHash)
        && String(frame.presetId || "") === String(request.presetId || "")
        && Number(frame.holeNumber || 0) === Number(request.holeNumber || 0);
    }

    function disarm(request) {
      if (request.__timeoutId != null) { clearTimer(request.__timeoutId); request.__timeoutId = null; }
      if (request.__slowId != null) { clearTimer(request.__slowId); request.__slowId = null; }
      if (request.__graceId != null) { clearTimer(request.__graceId); request.__graceId = null; }
    }

    function finish(courseId, request, nextState, error) {
      var s = state(courseId);
      disarm(request);
      request.state = nextState;
      request.completedAt = nowFn();
      request.durationMs = request.startedAt ? request.completedAt - request.startedAt : 0;
      request.error = error || request.error || null;
      log(request, { duration: request.durationMs, error: request.error ? String(request.error.message || request.error) : undefined });
      if (s.active === request) s.active = null;
      s.last = request;
      changed(courseId, nextState);
      drain(courseId);
    }

    function drain(courseId) {
      var s = state(courseId);
      if (s.active || !s.queued) return;
      var next = s.queued;
      s.queued = null;
      start(courseId, next);
    }

    function start(courseId, request) {
      var s = state(courseId);
      s.active = request;
      request.state = STATE.RENDERING;
      request.startedAt = nowFn();
      log(request);
      changed(courseId, STATE.RENDERING);
      request.__slowId = setTimer(function () {
        request.__slowId = null;
        if (s.active === request) { request.slow = true; changed(courseId, "slow"); }
      }, request.slowAfterMs);
      /* A timed-out request is abandoned, not cancelled: the engine has no cancel.
         It stays terminal, so if it does finish later settle() drops it on the floor
         and the queue is free the moment the clock runs out. */
      request.__timeoutId = setTimer(function () {
        request.__timeoutId = null;
        if (s.active !== request) return;
        finish(courseId, request, STATE.TIMED_OUT, { message: "Preview timed out" });
      }, request.timeoutMs);

      var settled = false;
      var run;
      try { run = request.run(request); } catch (error) { run = Promise.reject(error); }
      Promise.resolve(run).then(function (result) {
        if (settled) return;
        settled = true;
        var ok = !(result && result.ok === false);
        settle(request.requestId, ok ? { ok: true } : { ok: false, error: result && result.error });
      }, function (error) {
        if (settled) return;
        settled = true;
        settle(request.requestId, { ok: false, error: error });
      });
    }

    /* The render finished. That is NOT confirmation - the bake resolves whether or
       not it produced a frame (the engine records failures on the record rather
       than rejecting), and even a real frame has to reach the phone before the
       Studio may claim it. Confirmation happens in noteDisplayedFrame. */
    function settle(requestId, result) {
      result = result || {};
      var found = findRequest(requestId);
      if (!found) return { stale: true };
      var s = found.state, request = found.request;
      if (TERMINAL[request.state] || s.active !== request) {
        log(request, { note: "late completion ignored" });
        /* Ignored as a transaction, but it has almost certainly just written a frame
           onto the record, so the caller has to look at the phone again. */
        changed(s.courseId, "stale");
        return { stale: true };
      }
      if (result.ok === false) {
        finish(s.courseId, request, STATE.FAILED, result.error || { message: "Preview failed" });
        return { stale: false, ok: false };
      }
      disarm(request);
      request.rendered = true;
      request.renderedAt = nowFn();
      /* Still RENDERING until a frame is painted, with the clock stopped. The caller
         repaints on this notification and noteDisplayedFrame() closes it out; the
         grace timer is what ends it when the repaint shows something else. */
      request.__graceId = setTimer(function () {
        request.__graceId = null;
        if (s.active !== request) return;
        finish(s.courseId, request, STATE.RENDERED, { message: "Rendered, but the preview is showing another frame" });
      }, PAINT_GRACE);
      changed(s.courseId, "rendered");
      return { stale: false, ok: true, request: request };
    }

    /* Called by the render layer with the frame it just put on screen. This is the
       only thing in the Studio allowed to turn an ingredient green. */
    function noteDisplayedFrame(courseId, frame) {
      var s = state(courseId);
      var next = frame ? {
        kind: frame.kind === "terrain" ? "terrain" : "bake",
        presetId: frame.presetId || "",
        overrideHash: frame.overrideHash || "",
        holeNumber: Number(frame.holeNumber || 0) || 0,
        requestId: Number(frame.requestId || 0) || 0,
        source: frame.source || "",
        recipeKnown: frame.recipeKnown !== false,
        overrides: frame.overrides || null,
        at: nowFn()
      } : null;
      var before = matchKey(s.displayed);
      /* `at` is when the PICTURE last changed, not when it was last looked at.
         Re-reporting the same frame - which happens on every repaint - must not make
         an unchanged image look like a fresh arrival. */
      if (next && before === matchKey(next) && s.displayed) next.at = s.displayed.at;
      else s.frameSeq += 1;
      s.displayed = next;
      var request = s.active;
      if (request && request.rendered && frameMatchesRequest(next, request)) {
        s.lastConfirmed = { request: request, frame: next };
        finish(courseId, request, STATE.DISPLAYED);
        return true;
      }
      if (!request && s.last && frameMatchesRequest(next, s.last)) {
        s.lastConfirmed = { request: s.last, frame: next };
      }
      if (before !== matchKey(next)) changed(courseId, "frame");
      return false;
    }

    function findRequest(requestId) {
      var id = Number(requestId);
      var keys = Object.keys(courses);
      for (var i = 0; i < keys.length; i++) {
        var s = courses[keys[i]];
        for (var j = s.recent.length - 1; j >= 0; j--) {
          if (s.recent[j].requestId === id) return { state: s, request: s.recent[j] };
        }
      }
      return null;
    }

    /* Latest-request-wins. B, C and D committed while A renders collapse to D, and
       D renders the moment A leaves the slot. Nothing committed is dropped on the
       floor because something else happens to be in flight. */
    function commit(spec) {
      spec = spec || {};
      var courseId = String(spec.courseId || "");
      var s = state(courseId);
      var kind = spec.kind === "terrain" ? "terrain" : "bake";
      var request = {
        requestId: ++seq,
        courseId: courseId,
        holeNumber: Number(spec.holeNumber || 0) || 0,
        presetId: String(spec.presetId || ""),
        /* An immutable snapshot. A render started for this recipe may never later
           claim to represent a different one because the form moved on. */
        overrides: spec.overrides ? JSON.parse(JSON.stringify(spec.overrides)) : {},
        overrideHash: spec.overrideHash || overrideHash(spec.overrides || {}),
        control: String(spec.control || ""),
        kind: kind,
        label: String(spec.label || spec.control || (kind === "terrain" ? "Terrain" : "Preview")),
        requestedAt: nowFn(),
        frameSeqAtRequest: s.frameSeq,
        startedAt: 0,
        completedAt: 0,
        durationMs: 0,
        state: STATE.REQUESTED,
        rendered: false,
        slow: false,
        error: null,
        timeoutMs: num(spec.timeoutMs, kind === "terrain" ? TIMEOUT_TERRAIN : TIMEOUT_BAKE),
        slowAfterMs: num(spec.slowAfterMs, SLOW_AFTER),
        run: typeof spec.run === "function" ? spec.run : function () { return Promise.resolve({ ok: true }); }
      };
      s.desired = request;
      var recipeKey = String(request.presetId || "") + ":" + String(request.overrideHash || "");
      if (!s.recipes[recipeKey]) {
        s.recipes[recipeKey] = request.overrides;
        s.recipeOrder.push(recipeKey);
        while (s.recipeOrder.length > 60) delete s.recipes[s.recipeOrder.shift()];
      }
      if (s.queued) {
        var dropped = s.queued;
        dropped.state = STATE.SUPERSEDED;
        log(dropped, { supersededBy: request.requestId });
      }
      s.recent.push(request);
      while (s.recent.length > 50) s.recent.shift();
      log(request);
      if (s.active) {
        s.queued = request;
        changed(courseId, STATE.REQUESTED);
      } else {
        start(courseId, request);
      }
      return request;
    }

    function status(courseId) {
      var s = state(courseId);
      var pending = s.active || s.queued || null;
      if (pending) {
        var elapsed = pending.startedAt ? nowFn() - pending.startedAt : 0;
        return {
          state: pending.state,
          kind: pending.kind,
          requestId: pending.requestId,
          label: pending.label,
          elapsedMs: elapsed,
          timeoutMs: pending.timeoutMs,
          slow: !!pending.slow,
          queuedBehind: s.active && s.queued ? s.queued.requestId : 0,
          busy: true
        };
      }
      var last = s.last;
      if (!last) return { state: "idle", kind: "", label: "", elapsedMs: 0, busy: false };
      return {
        state: last.state,
        kind: last.kind,
        requestId: last.requestId,
        label: last.label,
        durationMs: last.durationMs,
        holeNumber: last.holeNumber,
        error: last.error ? String(last.error.message || last.error) : "",
        busy: false
      };
    }

    /* One line, plain, for the strip beside the phone. */
    function statusText(courseId) {
      var st = status(courseId);
      if (st.state === STATE.RENDERING) {
        var secs = (st.elapsedMs / 1000).toFixed(1);
        return (st.slow ? "Applying " + st.label + "… " + secs + "s — taking longer than usual"
          : "Applying " + st.label + "… " + secs + "s");
      }
      if (st.state === STATE.REQUESTED) return st.label + " — waiting";
      if (st.state === STATE.DISPLAYED) {
        return "✓ " + st.label + " applied to H" + (st.holeNumber || "?") + " · " + (st.durationMs / 1000).toFixed(1) + "s";
      }
      if (st.state === STATE.RENDERED) return "◦ " + st.label + " rendered — the preview is showing another frame";
      if (st.state === STATE.FAILED) {
        /* The reason rides on the line. "failed" alone sent the operator to the console
           to learn something the transaction already knew. */
        var why = String(st.error || "").slice(0, 120);
        return "✕ " + st.label + " failed — previous preview retained" + (why ? " · " + why : "");
      }
      if (st.state === STATE.TIMED_OUT) return "⚠ " + st.label + " timed out — previous preview retained";
      return "";
    }

    /* The overrides that produced a frame carrying this preset and hash, if this
       session ever asked for them. */
    function recipeFor(courseId, presetId, hash) {
      if (!hash) return null;
      var s = state(courseId);
      return s.recipes[String(presetId || "") + ":" + String(hash)] || null;
    }
    function displayed(courseId) { return state(courseId).displayed; }
    function desired(courseId) { return state(courseId).desired; }
    function active(courseId) { return state(courseId).active; }
    function queued(courseId) { return state(courseId).queued; }
    function lastConfirmed(courseId) { return state(courseId).lastConfirmed; }

    /* Is the painted frame the newest terrain render we asked for? */
    function terrainConfirmed(courseId) {
      var s = state(courseId);
      if (!s.displayed || s.displayed.kind !== "terrain") return false;
      var lastTerrain = null;
      if (s.last && s.last.kind === "terrain") lastTerrain = s.last;
      if (s.active && s.active.kind === "terrain") lastTerrain = s.active;
      if (!lastTerrain) return false;
      return Number(s.displayed.requestId) === Number(lastTerrain.requestId)
        && lastTerrain.state === STATE.DISPLAYED;
    }

    /* A bake that timed out is abandoned, not cancelled, and can still land on the
       record minutes later - replacing the frame on screen with an older recipe than
       the controls. That, and only that, is what this recovers from: the picture
       CHANGED, after the current recipe was asked for, into something that is not it.

       A plain timeout is deliberately NOT a trigger. Retrying there would put a
       doomed render straight back into the slot and make the operator's next
       adjustment queue behind it, which is the opposite of what a timeout is for. */
    function needsReconcile(courseId) {
      var s = state(courseId);
      if (s.active || s.queued) return false;
      var want = s.desired;
      if (!want || want.kind !== "bake") return false;
      /* Re-baking cannot change which picture the phone has chosen to show, so a
         render whose frame the preview declined to display is never re-run. A render
         that WAS displayed and has since been painted over, on the other hand, is
         exactly the case here. */
      if (want.state === STATE.RENDERED) return false;
      var frame = s.displayed;
      if (!frame || s.frameSeq <= want.frameSeqAtRequest) return false;
      var key = matchKey(want);
      if (s.reconciledFor === key) return false;
      return matchKey(frame) !== key;
    }
    function markReconciled(courseId) {
      var s = state(courseId);
      s.reconciledFor = matchKey(s.desired);
    }

    function reset(courseId) {
      var s = state(courseId);
      if (s.active) disarm(s.active);
      if (s.queued) disarm(s.queued);
      courses[String(courseId || "")] = null;
      delete courses[String(courseId || "")];
    }

    return {
      STATE: STATE,
      commit: commit,
      settle: settle,
      noteDisplayedFrame: noteDisplayedFrame,
      status: status,
      statusText: statusText,
      displayed: displayed,
      recipeFor: recipeFor,
      desired: desired,
      active: active,
      queued: queued,
      lastConfirmed: lastConfirmed,
      terrainConfirmed: terrainConfirmed,
      needsReconcile: needsReconcile,
      markReconciled: markReconciled,
      matchKey: matchKey,
      frameMatchesRequest: frameMatchesRequest,
      reset: reset,
      journal: function () { return journal.slice(); }
    };
  }

  return {
    STATE: STATE,
    TIMEOUT_BAKE: TIMEOUT_BAKE,
    TIMEOUT_TERRAIN: TIMEOUT_TERRAIN,
    SLOW_AFTER: SLOW_AFTER,
    INGREDIENTS: INGREDIENTS,
    ingredientStates: ingredientStates,
    mowingActive: mowingActive,
    overrideHash: overrideHash,
    createPreviewTruth: createPreviewTruth
  };
});
