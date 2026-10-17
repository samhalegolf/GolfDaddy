/* Clarity Studio - Record Hub. STUDIO ONLY.
 *
 * The Garmin, the Apple Watch and the phone app side by side on one course, for screen
 * recording. The two watches are the preview pages' own faces (GDWatchPreviewPage.mountWatch,
 * each a port of its watch's draw code); the phone is the real app (app/index.html) running in
 * a phone-sized frame, opened on the same course through its ?courseId= hand-off.
 *
 * One rule for what is shared: the course, the hole, where the player stands and whether the
 * shot is locked are always the same on all three. Unlocked is the screen before the lock - the
 * Garmin's and the Apple Watch's numbers, the phone tracking with no Bubble; Locked is the shot
 * on the map. Aiming is what "Linked" switches - linked, a drag on any one device moves the aim
 * on the other two as it goes (the same ground point, carried onto each device's own aim);
 * individual, each device aims on its own.
 *
 * The phone is driven through its own Marshal: DEMO_APPROACH makes the hub's player its fix and
 * the hole live, LOCK / UNLOCK follow the switch, AIM_DRAGGED moves the aim. It is opened with
 * ?recording=1, so it plays as Guest with no GPS and writes nothing a round writes (boot.js,
 * gd-play-context.js). A tap on its map, which would be Preview's PLACED, moves the player on all
 * three instead.
 *
 * Recording: a watch records straight from its canvas (no picker, the watch's own pixels). The
 * phone, and "all three as one video", record this tab cropped to that element (Region Capture,
 * Chrome) - the browser asks once which tab to share; pick this one. Each recording downloads
 * when it stops. */
(function () {
  "use strict";

  var WATCHES = ["garmin", "apple"];
  var PHONES = [
    { id: "iphone16pro", name: "iPhone 16 Pro", width: 402, height: 874, top: 54, bottom: 34, corner: 55, island: true },
    { id: "iphone16promax", name: "iPhone 16 Pro Max", width: 440, height: 956, top: 54, bottom: 34, corner: 55, island: true },
    { id: "iphone16", name: "iPhone 16", width: 393, height: 852, top: 54, bottom: 34, corner: 47, island: true },
    { id: "pixel9", name: "Pixel 9", width: 412, height: 915, top: 40, bottom: 24, corner: 44, island: false }
  ];
  var PHONE_READY_MS = 60000, PHONE_POLL_MS = 250;
  var SAME_AIM_M = 0.3;

  /* The hub's own state, kept across leaving and re-entering the page. Each watch keeps its
     own store as well (its device, map mode, units), separate from its preview page's. */
  var hub = { courseKey: "", courseName: "", holeNumbers: [], holeNumber: null, player: null, linked: true, locked: false, phoneId: PHONES[0].id, phoneScale: "fit", watchZoom: 0.75, units: "m" };

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function metres(a, b) { return window.GDWatchCommon.Geo.distance(a, b); }
  function stamp() {
    var d = new Date(), two = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes()) + two(d.getSeconds());
  }
  function clock(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60); }

  // ---------------------------------------------------------------- recording

  function recordingType() {
    if (typeof MediaRecorder === "undefined") return null;
    var types = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
    for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported(types[i])) return types[i];
    return "";
  }

  /* One recording of one stream; stop() downloads it. */
  function startRecording(stream, fileName) {
    var type = recordingType();
    var recorder = new MediaRecorder(stream, Object.assign({ videoBitsPerSecond: 16000000 }, type ? { mimeType: type } : {}));
    var chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var done = new Promise(function (resolve) {
      recorder.onstop = function () {
        var mime = recorder.mimeType || type || "video/webm";
        var blob = new Blob(chunks, { type: mime });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName + (/mp4/.test(mime) ? ".mp4" : ".webm");
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
        stream.getTracks().forEach(function (t) { t.stop(); });
        resolve();
      };
    });
    recorder.start(1000);
    return { startedAt: Date.now(), stop: function () { if (recorder.state !== "inactive") recorder.stop(); return done; } };
  }

  /* This tab, shared once and kept while the page is open; each recording takes a clone of it
     cropped to its own element. Without Region Capture (not Chrome) the clone is the whole tab. */
  var display = null;
  function displayStream() {
    var live = display && display.getVideoTracks()[0] && display.getVideoTracks()[0].readyState === "live";
    if (live) return Promise.resolve(display);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return Promise.reject(new Error("this browser cannot record a tab"));
    return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" })
      .then(function (stream) { display = stream; return stream; });
  }
  function croppedStream(element) {
    return displayStream().then(function (stream) {
      var track = stream.getVideoTracks()[0].clone();
      var out = new MediaStream([track]);
      if (!window.CropTarget || typeof track.cropTo !== "function") return { stream: out, cropped: false };
      return window.CropTarget.fromElement(element).then(function (target) { return track.cropTo(target); })
        .then(function () { return { stream: out, cropped: true }; });
    });
  }
  function stopDisplay() { if (display) display.getTracks().forEach(function (t) { t.stop(); }); display = null; }

  // ---------------------------------------------------------------- the page

  function render(containerEl) {
    var page = window.GDWatchPreviewPage;
    var options = {};
    WATCHES.forEach(function (key) { options[key] = page && page.watchOptions(key); });
    if (!page || !options.garmin || !options.apple || !window.GDWatchCommon) {
      containerEl.innerHTML = '<p class="gdStudioMuted" style="padding:16px">The watch renderers did not load on this surface.</p>';
      return null;
    }

    var destroyed = false;
    var watches = {}, sessions = {};
    var recordings = {};          // device key -> { startedAt, stop }
    var tickTimer = null;

    function deviceSelect(key) {
      var R = options[key].render, session = sessions[key];
      return R.DEVICES.map(function (d) {
        return '<option value="' + esc(d.id) + '"' + (d.id === session.deviceId ? " selected" : "") + ">" + esc(d.name) + "</option>";
      }).join("");
    }
    WATCHES.forEach(function (key) {
      var o = options[key];
      sessions[key] = page.store("hub-" + key, { deviceId: o.deviceId, mode: o.modes ? o.modes[0].value : "" });
      sessions[key].zoom = hub.watchZoom;
      sessions[key].units = hub.units;
    });

    function watchColumn(key) {
      var o = options[key];
      return '<div class="gdHubHead">' +
        '<strong>' + esc(o.label) + "</strong>" +
        '<select data-hub="device-' + key + '" title="Watch model">' + deviceSelect(key) + "</select>" +
        (o.modes ? '<select data-hub="mode-' + key + '" title="Map">' + o.modes.map(function (m) { return '<option value="' + esc(m.value) + '">' + esc(m.label) + "</option>"; }).join("") + "</select>" : "") +
        '<button type="button" class="gdStudioDiagramBtn gdHubRec" data-hub="rec-' + key + '">● Rec</button>' +
        "</div>";
    }
    var phoneOptions = PHONES.map(function (p) { return '<option value="' + p.id + '"' + (p.id === hub.phoneId ? " selected" : "") + ">" + esc(p.name) + "</option>"; }).join("");

    containerEl.innerHTML =
      '<div class="gdStudioLede" style="margin-bottom:12px"><p>The Garmin, the Apple Watch and the phone app on the same course, ready to screen record. ' +
      "Course, hole and where the player stands are always the same on all three. <strong>Tap the phone's map</strong> to place the player (or use <strong>Player on the tee</strong>). " +
      "<strong>Unlocked / Locked</strong> sets the shot on all three - the numbers before the lock, or the shot on the map. <strong>Linked</strong>: drag the aim on any device and the other two follow. <strong>Individual</strong>: each aims on its own. " +
      "A watch records straight from its face; the phone and <strong>Record together</strong> record this tab cropped to the devices - when the browser asks, share <strong>this tab</strong>.</p></div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="pick">Pick course</button>' +
      '<label class="gdStudioViewportField">or key <input type="text" data-hub="key" placeholder="course-key" style="width:160px"></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="load">Load</button>' +
      '<span class="gdStudioViewportCourse" data-hub="course">No course loaded</span>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="prev" title="Previous hole">◀</button>' +
      '<label class="gdStudioViewportField">Hole <select data-hub="hole"></select></label>' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="next" title="Next hole">▶</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="tee">Player on the tee</button>' +
      '<span class="gdHubLink" role="group" aria-label="Shot">' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="unlocked">Unlocked</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="locked">Locked</button>' +
      "</span>" +
      '<span class="gdHubLink" role="group" aria-label="Aiming">' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="linked">Linked</button>' +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="individual">Individual</button>' +
      "</span>" +
      '<label class="gdStudioViewportField">Units <select data-hub="units"><option value="m">metres</option><option value="y">yards</option></select></label>' +
      '<label class="gdStudioViewportField">Watch size <select data-hub="watchZoom"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.5">1.5×</option></select></label>' +
      '<label class="gdStudioViewportField">Phone size <select data-hub="phoneScale"><option value="fit">Fit to screen</option><option value="0.6">0.6×</option><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option></select></label>' +
      "</div>" +
      '<div class="gdStudioViewportBar">' +
      '<button type="button" class="gdStudioDiagramBtn gdHubRec" data-hub="recAll">● Record all three (separate files)</button>' +
      '<button type="button" class="gdStudioDiagramBtn gdHubRec" data-hub="recStage">● Record together (one video)</button>' +
      '<span class="gdStudioMuted" data-hub="recStatus"></span>' +
      "</div>" +
      '<div class="gdHubGrid">' +
      watchColumn("garmin") + watchColumn("apple") +
      '<div class="gdHubHead"><strong>Phone</strong><select data-hub="phoneModel" title="Phone">' + phoneOptions + "</select>" +
      '<button type="button" class="gdStudioDiagramBtn" data-hub="phoneReload" title="Reopen the app on this course">Reload</button>' +
      '<button type="button" class="gdStudioDiagramBtn gdHubRec" data-hub="rec-phone">● Rec</button></div>' +
      '<div class="gdHubStage" data-hub="stage">' +
      '<div class="gdHubCell" data-hub="cell-garmin"><div class="gdStudioWatchBezel" data-hub="bezel-garmin"><canvas data-hub="canvas-garmin"></canvas></div></div>' +
      '<div class="gdHubCell" data-hub="cell-apple"><div class="gdStudioWatchBezel" data-hub="bezel-apple"><canvas data-hub="canvas-apple"></canvas></div></div>' +
      '<div class="gdHubCell"><div class="gdHubPhoneBox" data-hub="phoneBox"><div class="gdHubPhone" data-hub="phone">' +
      '<div class="gdHubPhoneScreen" data-hub="phoneScreen">' +
      '<div class="gdHubPhoneStatus" data-hub="phoneStatus"><span>9:41</span><i class="gdHubIsland"></i>' +
      '<span class="gdHubPhoneIcons" aria-hidden="true">' +
      '<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>' +
      '<svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="#fff" stroke-opacity="0.5"/><rect x="2" y="2" width="19" height="8" rx="1.5"/><rect x="24" y="4" width="1.5" height="4" rx="0.75" fill-opacity="0.5"/></svg>' +
      "</span></div>" +
      '<iframe data-hub="phoneFrame" title="Clarity Caddy phone app" tabindex="0"></iframe>' +
      '<div class="gdHubPhoneEmpty" data-hub="phoneEmpty">Pick a course to open it in the app.</div>' +
      '<i class="gdHubHomeBar"></i>' +
      "</div></div></div></div>" +
      "</div>" +
      '<div class="gdStudioViewportBar gdStudioWatchButtons" data-hub="buttons-garmin"></div>' +
      '<div class="gdStudioViewportBar gdStudioWatchButtons" data-hub="buttons-apple"></div>' +
      '<div class="gdStudioViewportBar gdStudioMuted" data-hub="phoneNote"></div>' +
      "</div>" +
      '<details class="gdHubReadouts"><summary>Readouts</summary>' +
      '<pre class="gdStudioWatchReadout" data-hub="readout-garmin"></pre>' +
      '<pre class="gdStudioWatchReadout" data-hub="readout-apple"></pre>' +
      '<pre class="gdStudioWatchReadout" data-hub="readout-phone"></pre>' +
      "</details>";

    var el = {};
    containerEl.querySelectorAll("[data-hub]").forEach(function (node) { el[node.getAttribute("data-hub")] = node; });
    el.units.value = hub.units; el.watchZoom.value = String(hub.watchZoom); el.phoneScale.value = String(hub.phoneScale);
    if (el["mode-garmin"]) el["mode-garmin"].value = sessions.garmin.mode;

    // ---------------------------------------------------------------- the watches

    /* Linked aiming. A device's aim is broadcast when a finger or a button on it has moved
       it: `seen` is where its aim stood before the touch, refreshed on every frame drawn while
       nothing is touching it (so an aim it was handed from another device is not echoed). */
    var seen = {}, gesture = {};
    function onWatchInput(key, phase) {
      /* A LOCK or UNLOCK pressed on this watch is the switch for all three. */
      if (phase === "end" && !!sessions[key].locked !== hub.locked) setLocked(!!sessions[key].locked);
      var t = watches[key] && watches[key].currentTarget();
      if (!hub.linked || !t) { if (phase === "end") gesture[key] = null; return; }
      var g = gesture[key], base = g ? g.last : seen[key];
      if (!base || metres(t, base) > SAME_AIM_M) {
        broadcastAim(key, t, "move");
        g = gesture[key] = { last: t };
      }
      if (phase === "end") {
        if (g) broadcastAim(key, t, "end");
        gesture[key] = null;
        seen[key] = t;
      }
    }
    function broadcastAim(from, target, phase) {
      WATCHES.forEach(function (key) { if (key !== from && watches[key]) watches[key].mirrorAim(target, phase); });
      if (from !== "phone") phoneAim(target);
    }

    WATCHES.forEach(function (key) {
      watches[key] = page.mountWatch(options[key], { canvas: el["canvas-" + key], bezel: el["bezel-" + key], buttons: el["buttons-" + key] }, sessions[key], {
        onDraw: function () {
          if (!gesture[key] && watches[key]) seen[key] = watches[key].currentTarget();
          el["readout-" + key].textContent = options[key].label + "\n" + (watches[key] ? watches[key].readoutLines().join("\n") : "");
        },
        onInput: function (phase) { onWatchInput(key, phase); },
        onStepHole: function (n) { setHole(n, key); }
      });
      el["device-" + key].addEventListener("change", function () { sessions[key].deviceId = el["device-" + key].value; watches[key].newFace(); watches[key].requestUpdate(); });
    });
    if (el["mode-garmin"]) el["mode-garmin"].addEventListener("change", function () { sessions.garmin.mode = el["mode-garmin"].value; watches.garmin.requestUpdate(); });

    // ---------------------------------------------------------------- the phone

    var phone = { marshal: null, token: 0, applying: 0, dragging: false, note: "" };
    function phoneDevice() { return PHONES.filter(function (p) { return p.id === hub.phoneId; })[0] || PHONES[0]; }
    /* A tab recording only sees what is on screen, so "Fit to screen" sizes the phone - the
       tallest device - to the window's height, stage padding and all. */
    var STAGE_PADDING = 18, BEZEL = 12;
    function phoneScale() {
      if (hub.phoneScale !== "fit") return Number(hub.phoneScale) || 1;
      var room = window.innerHeight - STAGE_PADDING * 2 - 8;
      return Math.max(0.3, Math.min(1.25, room / (phoneDevice().height + BEZEL * 2)));
    }
    function layoutPhone() {
      var p = phoneDevice(), s = phoneScale(), bezel = BEZEL;
      el.phone.style.width = p.width + bezel * 2 + "px"; el.phone.style.height = p.height + bezel * 2 + "px";
      el.phone.style.borderRadius = p.corner + bezel + "px";
      el.phone.style.transform = "scale(" + s + ")";
      el.phoneBox.style.width = (p.width + bezel * 2) * s + "px"; el.phoneBox.style.height = (p.height + bezel * 2) * s + "px";
      el.phoneScreen.style.width = p.width + "px"; el.phoneScreen.style.height = p.height + "px";
      el.phoneScreen.style.borderRadius = p.corner + "px";
      el.phoneStatus.style.height = p.top + "px";
      el.phoneStatus.classList.toggle("hasIsland", p.island);
      el.phoneFrame.style.top = p.top + "px"; el.phoneFrame.style.height = p.height - p.top + "px";
    }
    function setPhoneNote(text) { phone.note = text; el.phoneNote.textContent = text; renderPhoneReadout(); }
    function renderPhoneReadout() {
      var lines = ["Phone · " + phoneDevice().name + " · " + phoneDevice().width + "×" + phoneDevice().height + " pt"];
      var m = phone.marshal;
      if (m) {
        try {
          var scene = m.scene();
          lines.push("flow " + scene.flow + " · mode " + scene.mode + " · hole " + scene.hole.number);
          if (scene.player) lines.push("player " + scene.player.lat.toFixed(6) + ", " + scene.player.lng.toFixed(6));
          if (scene.bubble && scene.bubble.target) lines.push("aim " + scene.bubble.target.lat.toFixed(6) + ", " + scene.bubble.target.lng.toFixed(6));
        } catch (e) { lines.push("scene unavailable: " + (e && e.message || e)); }
      }
      if (phone.note) lines.push(phone.note);
      el["readout-phone"].textContent = lines.join("\n");
    }

    /* Signals the hub sends are marked, so the Scene they publish is not read back as the
       phone's own input. */
    function phoneSignal(name, payload) {
      if (!phone.marshal) return false;
      phone.applying += 1;
      try { return phone.marshal.signal(name, payload); }
      catch (e) { return false; }
      finally { phone.applying -= 1; }
    }
    function phoneMode() { try { return phone.marshal ? phone.marshal.scene().mode : null; } catch (e) { return null; } }
    function phoneAim(target) {
      if (!hub.linked || phoneMode() !== "aim") return;
      phoneSignal("AIM_DRAGGED", { point: { lat: target.lat, lng: target.lng } });
    }
    /* The phone plays the hole live, as a round does: DEMO_APPROACH makes the hub's player its
       fix and the hole live, in Track - the screen before LOCK - then the switch is applied. */
    function phonePlace(point) {
      if (!phone.marshal || !point || hub.holeNumber == null) return;
      if (!phoneSignal("DEMO_APPROACH", { hole: hub.holeNumber, point: { lat: point.lat, lng: point.lng } })) setPhoneNote("The phone did not take the player there.");
      phoneLock();
      renderPhoneReadout();
    }
    function phoneLock() {
      var mode = phoneMode();
      if (hub.locked && mode === "track") phoneSignal("LOCK");
      else if (!hub.locked && mode === "aim") phoneSignal("UNLOCK");
    }
    function phoneHole(n) {
      if (!phone.marshal) return;
      var current = null;
      try { current = phone.marshal.round().hole; } catch (e) { current = null; }
      if (current !== n) phoneSignal("VIEW_HOLE_CHANGED", { hole: n });
    }

    function onPhoneScene(token, scene, cause) {
      if (destroyed || token !== phone.token) return;
      renderPhoneReadout();
      if (phone.applying > 0 || !scene) return;
      if (cause === "LOCK" || cause === "UNLOCK") { setLocked(scene.mode === "aim"); return; }
      if (/^(VIEW_HOLE_CHANGED|NEXT_HOLE|PREV_HOLE|ADVANCE_TO_HOLE|VIEW_LIVE_HOLE)$/.test(cause) && scene.hole && scene.hole.number !== hub.holeNumber) {
        setHole(scene.hole.number, "phone");
        return;
      }
      if (cause === "AIM_DRAGGED" && hub.linked && scene.bubble && scene.bubble.target) {
        phone.dragging = true;
        broadcastAim("phone", scene.bubble.target, "move");
      }
    }
    function onPhonePointerUp() {
      if (!phone.dragging) return;
      phone.dragging = false;
      var target = null;
      try { target = phone.marshal.scene().bubble.target; } catch (e) { target = null; }
      if (hub.linked && target) broadcastAim("phone", target, "end");
    }

    /* The app opens the course itself from ?courseId=; the hub waits for its Marshal to have the
       round and its package, then puts it on the hub's hole and player. */
    function openPhone() {
      phone.token += 1;
      phone.marshal = null; phone.dragging = false;
      var token = phone.token;
      if (!hub.courseKey) { el.phoneFrame.removeAttribute("src"); el.phoneEmpty.hidden = false; renderPhoneReadout(); return; }
      el.phoneEmpty.hidden = true;
      setPhoneNote("Opening the app on " + (hub.courseName || hub.courseKey) + "…");
      el.phoneFrame.src = "app/index.html?recording=1&courseId=" + encodeURIComponent(hub.courseKey) + (hub.holeNumber != null ? "&hole=" + hub.holeNumber : "") +
        (hub.courseName ? "&courseName=" + encodeURIComponent(hub.courseName) : "");
      var started = Date.now();
      (function poll() {
        if (destroyed || token !== phone.token) return;
        var win = null, m = null;
        try { win = el.phoneFrame.contentWindow; m = win && win.ClarityApp && win.ClarityApp.marshal; } catch (e) { m = null; }
        var ready = false;
        try { ready = !!(m && m.round().open && m.pkg() && Array.isArray(m.pkg().holes) && m.pkg().holes.length); } catch (e) { ready = false; }
        if (!ready) {
          if (Date.now() - started > PHONE_READY_MS) { setPhoneNote("The app did not open the course within a minute - is the course published, and are you signed in?"); return; }
          setTimeout(poll, PHONE_POLL_MS);
          return;
        }
        phone.marshal = m;
        m.onScene(function (scene, cause) { onPhoneScene(token, scene, cause); });
        /* A tap on the phone's map is Preview's PLACED, which a live hole refuses. Here it is
           the player moving, on all three. The hub's own signals pass straight through. */
        var signal = m.signal;
        m.signal = function (name, payload) {
          if (name === "PLACED" && phone.applying === 0) {
            var point = payload && payload.point;
            if (point) setTimeout(function () { if (!destroyed && token === phone.token) setPlayer(point, null); }, 0);
            return false;
          }
          return signal.call(m, name, payload);
        };
        try {
          win.document.addEventListener("pointerup", onPhonePointerUp, true);
          win.document.addEventListener("pointercancel", onPhonePointerUp, true);
        } catch (e) {}
        setPhoneNote("");
        if (hub.holeNumber != null) phoneHole(hub.holeNumber);
        if (hub.player) phonePlace(hub.player);
        else phoneLock();
        renderPhoneReadout();
      })();
    }

    // ---------------------------------------------------------------- the shared round

    function teeOf(n) {
      for (var i = 0; i < WATCHES.length; i++) {
        var hole = sessions[WATCHES[i]].holes.filter(function (h) { return h.holeNumber === n; })[0];
        if (hole && hole.skeleton && hole.skeleton.t) return { lat: hole.skeleton.t.lat, lng: hole.skeleton.t.lng };
      }
      return null;
    }
    function setPlayer(point, from) {
      hub.player = point ? { lat: point.lat, lng: point.lng } : null;
      WATCHES.forEach(function (key) { gesture[key] = null; watches[key].setPlayer(hub.player); watches[key].setLocked(hub.locked); });
      if (from !== "phone") phonePlace(hub.player);
    }
    /* The switch: the same LOCK / UNLOCK on all three. */
    function setLocked(locked) {
      hub.locked = !!locked;
      WATCHES.forEach(function (key) { watches[key].setLocked(hub.locked); });
      phoneLock();
      renderLock();
    }
    function renderLock() {
      el.locked.classList.toggle("isActive", hub.locked);
      el.unlocked.classList.toggle("isActive", !hub.locked);
      el.locked.setAttribute("aria-pressed", String(hub.locked));
      el.unlocked.setAttribute("aria-pressed", String(!hub.locked));
    }
    /* A new hole starts from its tee on every device. */
    function setHole(n, from) {
      if (n == null) return;
      hub.holeNumber = n;
      el.hole.value = String(n);
      WATCHES.forEach(function (key) { watches[key].setHole(n); });
      if (from !== "phone") phoneHole(n);
      var tee = teeOf(n);
      if (tee) setPlayer(tee, null);
    }
    function stepHole(delta) {
      var i = hub.holeNumbers.indexOf(hub.holeNumber), next = hub.holeNumbers[i + delta];
      if (i >= 0 && next != null) setHole(next, null);
    }
    function showCourse() {
      el.hole.innerHTML = hub.holeNumbers.map(function (n) { return '<option value="' + n + '"' + (n === hub.holeNumber ? " selected" : "") + ">Hole " + n + "</option>"; }).join("");
      var bits = WATCHES.map(function (key) {
        var s = sessions[key];
        return options[key].label + " " + (s.holes.length ? s.packageKind + " v" + s.packageVersion : "no package");
      });
      el.course.textContent = hub.courseKey ? (hub.courseName || hub.courseKey) + " · " + hub.holeNumbers.length + " holes · " + bits.join(" · ") : "No course loaded";
      if (el["mode-garmin"]) { el["mode-garmin"].disabled = sessions.garmin.packageKind === "garmin"; el["mode-garmin"].value = sessions.garmin.mode; }
    }

    function loadCourse(courseKey, courseName) {
      courseKey = String(courseKey || "").trim();
      if (!courseKey) return;
      el.course.textContent = "Loading " + courseKey + "…";
      Promise.all(WATCHES.map(function (key) {
        return page.loadWatchPackage(courseKey, options[key].packages).catch(function (error) {
          return { kind: "", holes: [], version: null, status: "failed: " + (error && error.message || error) };
        });
      })).then(function (loaded) {
        if (destroyed) return;
        hub.courseKey = courseKey; hub.courseName = courseName || courseKey;
        var numbers = {};
        WATCHES.forEach(function (key, i) {
          watches[key].useCourse(courseKey, hub.courseName, loaded[i]);
          loaded[i].holes.forEach(function (h) { numbers[h.holeNumber] = true; });
        });
        hub.holeNumbers = Object.keys(numbers).map(Number).sort(function (a, b) { return a - b; });
        hub.holeNumber = hub.holeNumbers.length ? hub.holeNumbers[0] : null;
        hub.player = null;
        showCourse();
        if (!hub.holeNumbers.length) {
          el.course.textContent = courseKey + " · no watch package (" + loaded.map(function (l) { return l.status; }).join(", ") + ")";
        } else {
          WATCHES.forEach(function (key) { watches[key].setHole(hub.holeNumber); });
          var tee = teeOf(hub.holeNumber);
          if (tee) setPlayer(tee, "phone");   // the phone is told once it has opened
        }
        openPhone();
      });
    }
    function pickCourse() {
      var pick = window.GDStudioCoursePick;
      var opened = pick && typeof pick.open === "function" && pick.open({
        source: "studio-record-hub",
        onPick: function (course) { if (!destroyed) loadCourse(page.slug(course), course && (course.name || course.courseName)); }
      });
      if (!opened) el.course.textContent = "The course picker is not loaded on this surface - type a course key instead.";
    }

    function renderLink() {
      el.linked.classList.toggle("isActive", hub.linked);
      el.individual.classList.toggle("isActive", !hub.linked);
      el.linked.setAttribute("aria-pressed", String(hub.linked));
      el.individual.setAttribute("aria-pressed", String(!hub.linked));
    }

    // ---------------------------------------------------------------- recording

    var RECORD_KEYS = ["garmin", "apple", "phone", "stage"];
    function fileName(key) {
      var hole = hub.holeNumber != null ? "-h" + hub.holeNumber : "";
      return "clarity-" + key + "-" + (hub.courseKey || "no-course") + hole + "-" + stamp();
    }
    function streamFor(key) {
      if (key === "garmin" || key === "apple") {
        var canvas = el["canvas-" + key];
        if (typeof canvas.captureStream !== "function") return Promise.reject(new Error("this browser cannot record a canvas"));
        watches[key].requestUpdate();
        return Promise.resolve({ stream: canvas.captureStream(60), cropped: true });
      }
      return croppedStream(key === "phone" ? el.phoneScreen : el.stage);
    }
    function startKeys(keys) {
      if (recordingType() === null) { el.recStatus.textContent = "This browser cannot record video (no MediaRecorder)."; return; }
      keys = keys.filter(function (k) { return !recordings[k]; });
      if (!keys.length) return;
      /* The tab recordings are cropped to what is on screen: bring the devices fully into view. */
      if (keys.indexOf("phone") >= 0 || keys.indexOf("stage") >= 0) el.stage.scrollIntoView({ block: "center" });
      /* Every stream first, then every recorder in the same tick, so recordings started
         together start together. */
      Promise.all(keys.map(streamFor)).then(function (results) {
        if (destroyed) { results.forEach(function (r) { r.stream.getTracks().forEach(function (t) { t.stop(); }); }); return; }
        var uncropped = false;
        results.forEach(function (r, i) {
          recordings[keys[i]] = startRecording(r.stream, fileName(keys[i]));
          if (!r.cropped) uncropped = true;
        });
        el.recStatus.textContent = uncropped ? "This browser cannot crop a tab recording, so the phone / together video is the whole tab." : "";
        renderRecording();
        if (!tickTimer) tickTimer = setInterval(renderRecording, 500);
      }).catch(function (error) {
        el.recStatus.textContent = "Recording did not start - " + (error && error.message || error);
      });
    }
    function stopKeys(keys) {
      keys.forEach(function (k) { if (recordings[k]) { recordings[k].stop(); delete recordings[k]; } });
      if (!Object.keys(recordings).length && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
      renderRecording();
    }
    function renderRecording() {
      function label(key, idle) { var r = recordings[key]; return r ? "■ Stop " + clock(Date.now() - r.startedAt) : idle; }
      ["garmin", "apple", "phone"].forEach(function (k) {
        el["rec-" + k].textContent = label(k, "● Rec");
        el["rec-" + k].classList.toggle("isRecording", !!recordings[k]);
      });
      var allOn = recordings.garmin && recordings.apple && recordings.phone;
      el.recAll.textContent = allOn ? "■ Stop all three " + clock(Date.now() - recordings.garmin.startedAt) : "● Record all three (separate files)";
      el.recAll.classList.toggle("isRecording", !!allOn);
      el.recStage.textContent = label("stage", "● Record together (one video)");
      el.recStage.classList.toggle("isRecording", !!recordings.stage);
    }
    function toggle(keys) { if (keys.every(function (k) { return recordings[k]; })) stopKeys(keys); else startKeys(keys); }

    // ---------------------------------------------------------------- wiring

    el.pick.addEventListener("click", pickCourse);
    el.load.addEventListener("click", function () { loadCourse(el.key.value); });
    el.key.addEventListener("keydown", function (e) { if (e.key === "Enter") loadCourse(el.key.value); });
    el.hole.addEventListener("change", function () { setHole(Number(el.hole.value), null); });
    el.prev.addEventListener("click", function () { stepHole(-1); });
    el.next.addEventListener("click", function () { stepHole(1); });
    el.tee.addEventListener("click", function () { var tee = teeOf(hub.holeNumber); if (tee) setPlayer(tee, null); });
    el.locked.addEventListener("click", function () { setLocked(true); });
    el.unlocked.addEventListener("click", function () { setLocked(false); });
    el.linked.addEventListener("click", function () { hub.linked = true; renderLink(); });
    el.individual.addEventListener("click", function () { hub.linked = false; renderLink(); });
    el.units.addEventListener("change", function () {
      hub.units = el.units.value;
      WATCHES.forEach(function (key) { sessions[key].units = hub.units; watches[key].requestUpdate(); });
    });
    el.watchZoom.addEventListener("change", function () {
      hub.watchZoom = Number(el.watchZoom.value) || 0.75;
      WATCHES.forEach(function (key) { sessions[key].zoom = hub.watchZoom; watches[key].newFace(); watches[key].requestUpdate(); });
    });
    el.phoneScale.addEventListener("change", function () { hub.phoneScale = el.phoneScale.value === "fit" ? "fit" : Number(el.phoneScale.value) || 1; layoutPhone(); });
    function onResize() { if (hub.phoneScale === "fit") layoutPhone(); }
    window.addEventListener("resize", onResize);
    el.phoneModel.addEventListener("change", function () { hub.phoneId = el.phoneModel.value; layoutPhone(); });
    el.phoneReload.addEventListener("click", openPhone);
    ["garmin", "apple", "phone"].forEach(function (k) { el["rec-" + k].addEventListener("click", function () { toggle([k]); }); });
    el.recAll.addEventListener("click", function () { toggle(["garmin", "apple", "phone"]); });
    el.recStage.addEventListener("click", function () { toggle(["stage"]); });

    // ---------------------------------------------------------------- boot

    renderLink();
    renderLock();
    layoutPhone();
    renderRecording();
    if (hub.courseKey) {
      showCourse();
      WATCHES.forEach(function (key) { if (hub.holeNumber != null) watches[key].setHole(hub.holeNumber); watches[key].setPlayer(hub.player); watches[key].setLocked(hub.locked); });
      openPhone();
    } else renderPhoneReadout();

    return function cleanup() {
      destroyed = true;
      stopKeys(RECORD_KEYS);
      stopDisplay();
      window.removeEventListener("resize", onResize);
      phone.token += 1;
      WATCHES.forEach(function (key) { watches[key].destroy(); });
      if (window.GDStudioCoursePick) window.GDStudioCoursePick.cancel();
      if (window.GDStudioShell) window.GDStudioShell.show();
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["gps-record-hub"] = render;
})();
