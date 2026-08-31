/* Wiring only. Route transitions toggle body classes here and nowhere else, and
   each transition finishes its own cleanup — no pollers exist to catch strays. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  /* The round currently in play, and which kind of map it's using - drives
     the background update check below. Cleared whenever play stops so a
     check in flight for a course just left can't land on the next one. */
  var activeCourse = null;
  var activeMapType = null;   // "object" | "published" | null (nothing usable yet)
  var mapUpdateDismissed = false;
  var updateCheckToken = 0;

  /* The start point of the shot the engine was last handed, as a value key.
     shotChanged compares against it to tell "the shot moved on" (reset wind)
     from "the same shot's aim is being dragged" (leave wind alone). */
  var lastShotStartKey = null;

  /* Build the Marshal and hand it the effects it is allowed to cause. It is
     pure by construction — no globals, no DOM — so everything with a side
     effect arrives here, which is also why the whole transition table can be
     driven in node (dev/marshal.test.js).

     Note what is NOT in this list: anything that draws. The Painter is a Scene
     subscriber, not an effect, because drawing is not something the Marshal
     asks for — it is what the Scene IS. */
  /* access.js owns the rule; this is just the short name for it. Defaults to
     TRUE when access.js is somehow absent, so a load failure cannot silently
     stop a paying member's round from being saved. */
  function roundFeatures() {
    return !app.access || app.access.roundFeatures();
  }

  function ensureMarshal() {
    if (app.marshal) return app.marshal;
    app.marshal = app.createMarshal({
      trace: app.trace || null,
      /* The engine's own target rule: the green when the bag reaches it, the
         fairway layup point when it cannot. */
      defaultTarget: function (start, rec) {
        var green = rec && rec.green;
        if (!green) return null;
        if (!window.GDBubbleEngine) return green;
        try {
          window.GDBubbleEngine.setShot(start, null);
          return window.GDBubbleEngine.targetForGreenCentre(green, { hole: rec.holeNumber }) || green;
        } catch (e) { return green; }
      },
      /* The bag's roof on a DRAGGED aim — despite the name, maxPlayableCarryM
         is the longest club's total distance, rollout included. Same rule that
         already limits defaultTarget's layup, handed to the Marshal so the
         drag cannot go where the auto target refuses to. Null (no engine) is
         "no rule", and the Marshal leaves the drag free. */
      maxAimM: function () {
        if (!window.GDBubbleEngine) return null;
        try { return window.GDBubbleEngine.maxPlayableCarryM(); } catch (e) { return null; }
      },
      effects: {
        /* Split by who owns it. The pin, the fix and the wake lock are the
           rangefinder and run for everybody; Course Data and the scorecard are
           round history, and a rangefinder-only session never opens either -
           so nothing is left half-written when it ends. */
        roundStarted: function (courseKey, courseName) {
          if (app.pin) app.pin.startRound();
          if (app.gps) app.gps.start();
          if (app.wakeLock) app.wakeLock.start();
          if (!roundFeatures()) return;
          if (app.courseData) app.courseData.startRound(courseKey);
          if (app.scorecard) app.scorecard.setCourse(courseKey, courseName);
        },
        roundEnded: function () {
          if (app.gps) app.gps.stop();
          if (app.wakeLock) app.wakeLock.stop();
        },
        holeEntered: function (hole, rec) {
          if (app.pin) app.pin.startHole(hole);
          if (app.undo) app.undo.clear();
          /* The bubble is free; resume is the round record, so it is not. */
          if (window.GDBubbleEngine && rec) {
            window.GDBubbleEngine.setHoleContext({
              hole: hole, tee: rec.tee, green: rec.green, route: rec.route
            });
          }
          if (roundFeatures() && app.resume) app.resume.setHole(hole);
        },
        shotChanged: function (start, target) {
          if (window.GDBubbleEngine) window.GDBubbleEngine.setShot(start || null, target || null);
          /* Wind is per shot. A different start point — or no shot at all —
             is the next shot, and it starts calm (wind.js reset). Dragging
             the aim only moves the TARGET, so a drag never lands here; a new
             lock, a new placement, an unlock and a hole change all do. */
          var key = start ? Number(start.lat).toFixed(7) + "," + Number(start.lng).toFixed(7) : null;
          if (key !== lastShotStartKey) {
            lastShotStartKey = key;
            if (app.wind && app.wind.reset) app.wind.reset();
          }
        },
        /* GPS Play's only analytical output. Wrapped because nothing about
           Course Data may interrupt a round. */
        shotCompleted: function (shot, meta) {
          if (!roundFeatures()) return;
          try { if (app.courseData) app.courseData.submit(shot, meta); } catch (e) {}
        },
        scoreSet: function (hole, strokes) {
          if (!roundFeatures()) return;
          if (app.scorecard && app.scorecard.setScore) app.scorecard.setScore(hole, strokes);
        }
      }
    });
    if (app.painter) app.painter.attach(app.marshal);
    /* A native surface is another subscriber to Marshal, never another round
       owner. The iOS NativeRoundBridge can register after boot; web remains
       inert when no native adapter is present. */
    if (app.createCaddyWatchBridge) {
      app.caddyWatch = app.createCaddyWatchBridge({
        marshal: app.marshal,
        bubbleModel: function () {
          return window.GDBubbleEngine && window.GDBubbleEngine.renderModel
            ? window.GDBubbleEngine.renderModel() : null;
        }
      });
      if (window.GDNativeRoundBridge && window.GDNativeRoundBridge.attach) {
        window.GDNativeRoundBridge.attach(app.caddyWatch);
      }
    }
    /* The only two things that turn the outside world into Signals. A fix that
       is not trusted is refused inside the Marshal, not here — this file does
       not get to decide what counts. */
    if (app.gps) {
      app.gps.onFix(function (fix) { app.marshal.signal("FIX_RECEIVED", { point: fix }); });
      app.gps.onStatus(function (status) {
        renderGpsNotice(status);
        if (status === "denied" || status === "unsupported") app.marshal.signal("FIX_LOST");
      });
    }
    return app.marshal;
  }

  function startRound(course, pkg) {
    ensureMarshal().signal("ROUND_OPENED", {
      courseKey: app.courseKey(course.courseId),
      courseName: course.courseName || "",
      pkg: pkg || null,
      centre: Number.isFinite(course.courseLat) && Number.isFinite(course.courseLng)
        ? { lat: course.courseLat, lng: course.courseLng } : null
    });
  }

  /* Which SCREEN the app is on — home, play or sign-in — is genuinely outside
     the Marshal's remit: it owns the round, not the route. But an unattributed
     write to a watched element is a Leak whoever did it, and it should be,
     so this declares itself instead of quietly slipping past. Trace showed it
     as `body.class.toggle ← boot.js` on the very first boot, which is the
     mechanism working. */
  function show(route) {
    function paintRoute() {
      ["home", "play", "signin"].forEach(function (name) {
        document.body.classList.toggle("route-" + name, route === name);
      });
    }
    if (app.trace) app.trace.paint("ROUTE_CHANGED", route, paintRoute);
    else paintRoute();
    /* Lets CSS soften anything that is only meaningful with a round behind it,
       without any module having to ask twice. */
    document.body.classList.toggle("rangefinderOnly", !roundFeatures());
    if (route !== "play") {
      if (app.marshal) app.marshal.signal("END_ROUND");
      if (app.painter && app.painter.detach) app.painter.detach();
      if (app.gps) app.gps.stop();
      if (app.wakeLock) app.wakeLock.stop();
      activeCourse = null;
      activeMapType = null;
      stopDemoCourseDataTimer();
    }
    if (route === "home") renderAccountState();
  }

  /* Demo Mode only: ~20s after GPS Play genuinely becomes interactive, offer
     a "See Course Data" CTA. Gated on DemoSession.active && .adopted so a
     real round never sees this. Cleared above whenever show() routes away
     from "play" (screen exit, course change teardown, sign-in, etc.) - the
     one place that already tears down every other play-only resource. */
  var demoCourseDataTimer = null;
  var DEMO_COURSE_DATA_DELAY_MS = 20000;
  function startDemoCourseDataTimerIfNeeded() {
    if (demoCourseDataTimer) return;
    var demo = window.GDDemoSession;
    if (!demo || !demo.active || !demo.adopted) return;
    demo.markGpsEntered();
    demoCourseDataTimer = setTimeout(function () {
      demoCourseDataTimer = null;
      var cta = document.getElementById("gdDemoCourseDataCta");
      if (cta) cta.hidden = false;
    }, DEMO_COURSE_DATA_DELAY_MS);
  }
  function stopDemoCourseDataTimer() {
    if (demoCourseDataTimer) { clearTimeout(demoCourseDataTimer); demoCourseDataTimer = null; }
  }
  function seeDemoCourseData() {
    if (window.GDDemoSession) window.GDDemoSession.setCourseDataActive(true);
    window.location.href = "/?openDemoCourseData=1";
  }

  /* Visible from first paint (see index.html) so it covers both the "which
     route" decision and, on a hand-off, the course-package fetch — hidden
     once there's something real underneath it to show. Same bar-and-text
     shape as the main site's course loading overlay, on purpose: the picker
     hands off to this page mid-load, and two different loading screens in a
     row read as two different apps. */
  function hideLoadingScreen() {
    var el = document.getElementById("loadingScreen");
    if (el) el.classList.add("hiddenState");
  }
  function setLoading(text, pct) {
    var sub = document.getElementById("loadingSub");
    var bar = document.getElementById("loadingBar");
    if (sub && text) sub.textContent = text;
    if (bar && Number.isFinite(Number(pct))) bar.style.width = Math.max(8, Math.min(100, Number(pct))) + "%";
  }
  function setLoadingTitle(text) {
    var title = document.getElementById("loadingTitle");
    if (title && text) title.textContent = text;
  }

  /* Back is semantic navigation. The handoff context, not browser history,
     owns the actual shell destination. */
  function exitToMainSite() {
    window.location.href = "/";
  }
  function exitBack() {
    /* Back peels one layer at a time, and the Marshal owns what a layer is:
       it answers false when there was nothing to close, so Back falls through
       to its next meaning rather than this file guessing at the play state. */
    if (app.marshal && app.marshal.signal("BACK")) return;
    /* Then the player's own last change — a wind level, a dropped pin. Same
       shape as the Marshal above: undo.pop() answers false when the stack is
       empty and Back falls through. Without this the stack that wind.js and
       pin.js push onto was never read by anything, so the very first Back
       during play left GPS play outright and took the change with it. */
    if (app.undo && app.undo.pop()) return;
    if (window.GDPlayContext && window.GDPlayContext.returnToOrigin) window.GDPlayContext.returnToOrigin();
    else exitToMainSite();
  }

  /* The location-denied notice. Only "denied" shows it: that is the one status
     the player can act on, and the one that will never resolve on its own.
     Dismissal lasts the round - re-nagging on every status event would be worse
     than the silence it replaces. */
  var gpsNoticeDismissed = false;
  function renderGpsNotice(status) {
    var el = document.getElementById("gpsNotice");
    if (!el) return;
    el.classList.toggle("hiddenState", gpsNoticeDismissed || status !== "denied");
  }

  /* Android's hardware Back, routed to the same handler as the on-screen one.
     Without a listener the system default pops the WebView's history or closes
     the app outright, which mid-round is the worst thing this app can do.

     This page does not load gd-native-back-button.js on purpose: that module
     asks GDShell for the current route, GDShell does not exist here, and a
     missing route reads as "root" - so every Back press would have reached its
     exitApp() branch and dropped the round. exitBack already encodes this
     page's real semantics (undo a wind/pin change, then history, then the main
     site), so Back means the same thing whichever way it is pressed.

     iOS has no hardware back button and web has no plugin, so both no-op. */
  function installNativeBack() {
    if (!(window.GDNative && window.GDNative.isNative && window.GDNative.platform === "android")) return false;
    var cap = window.Capacitor;
    var api = cap && cap.Plugins && cap.Plugins.App;
    if (!api || typeof api.addListener !== "function") return false;
    try { api.addListener("backButton", function () { exitBack(); }); } catch (e) { return false; }
    return true;
  }
  /* GPS Settings is a sheet in this page now, not a hand-off. It used to
     navigate to /?openGpsSettings=1, which meant leaving the round entirely
     and landing on the main site's home shell — and if you were not signed
     in, the legacy panel bailed to "Sign in first" and you just stayed on
     home. The four settings that survived the rebuild are all local display
     preferences, so none of that round trip was buying anything. */
  function openGpsSettings() {
    if (app.toolRail) app.toolRail.close();
    if (app.gpsSettings) app.gpsSettings.open();
  }

  /* Tapping the hole number opens a grid of every hole in play - a straight
     jump, not just stepping one at a time. Built fresh each open since the
     available holes can change mid-round (a multi-nine pairing swap). */
  /* The grid itself is drawn by the Painter, because the tile that matters is
     the flagged one — a hole still holding a shot with no end — and that is a
     view of the Marshal's record, not something this file can know. Opening the
     panel is all that is left here. */
  function openHolePicker() {
    document.getElementById("holePickerPanel").classList.remove("hiddenState");
  }
  function closeHolePicker() {
    document.getElementById("holePickerPanel").classList.add("hiddenState");
  }

  function renderAccountState() {
    var state = document.getElementById("accountState");
    var action = document.getElementById("accountAction");
    var signedIn = app.account.signedIn();
    state.textContent = signedIn ? app.account.label() : "Not signed in";
    action.textContent = signedIn ? "Sign out" : "Sign in";
  }

  async function submitSignIn(event) {
    event.preventDefault();
    var status = document.getElementById("signInStatus");
    var submit = document.getElementById("signInSubmit");
    submit.disabled = true;
    status.textContent = "Signing in…";
    try {
      await app.account.login(
        document.getElementById("signInEmail").value,
        document.getElementById("signInPassword").value
      );
      document.getElementById("signInPassword").value = "";
      status.textContent = "";
      show("home");
    } catch (error) {
      status.textContent = (error && error.message) || "Could not sign in. Check your connection.";
    } finally {
      submit.disabled = false;
    }
  }

  function mapTypeOf(pkg) {
    if (pkg && pkg.status === "full-map-ready") return "published";
    if (pkg && pkg.status === "lite-geo-ready") return "object";
    return null;   // processing/manual-required/none - nothing worth keeping yet
  }

  /* Only called with a package that actually has geometry - the course
     picker's own placeholder/processing/none answers are never saved, or
     the library would fill up with empty records for unmapped courses. */
  function saveCourseToLibrary(course, pkg) {
    var mapType = mapTypeOf(pkg);
    if (!mapType) return null;
    return app.courseStore.save({
      courseId: course.courseId,
      courseName: course.courseName,
      mapType: mapType,
      /* pkg.objectsVersion, NOT pkg.geometryVersion: the freshness check
         compares this against /api/course-library's objects_version, and
         geometryVersion is a different field entirely (the mapper algorithm
         version, "v1"). Storing the wrong one is what made every course read
         as permanently "Update available". */
      objectsVersion: pkg.objectsVersion || null,
      mapVersion: pkg.packageVersion || null,
      pkg: pkg
    });
  }

  /* Once per hole change, ask whether the SERVER's copy is newer than the one
     on this device. Fire-and-forget: this runs after a hole change already
     resolved, never blocks navigation.

     It used to ask a different question - "is the server's map a different
     TYPE than the one I'm playing?" - and that question is not the same thing
     as an update. A course sitting on the object map was offered a swap the
     moment any published map existed, however old, and a course already on a
     published map was skipped entirely, so a genuinely republished map never
     reached the player at all. Presence of a map on the server is not news;
     the scan finishing is not news. Only a higher version is news.

     One rule, app.courseVersions.isStale, shared with the Course Library
     badge - see app/js/course-versions.js. Nothing saved locally is NOT an
     update, it's a first download, and that path belongs to openPlay. */
  async function checkForMapUpdate() {
    if (!activeCourse) return;
    var course = activeCourse;
    var token = ++updateCheckToken;
    var pkg = await app.fetchCoursePackage({
      courseId: course.courseId, courseName: course.courseName,
      courseLat: course.courseLat, courseLng: course.courseLng
    });
    if (token !== updateCheckToken || activeCourse !== course) return;   // superseded: left/changed course
    var mapType = mapTypeOf(pkg);
    if (!mapType) return;                                                // nothing publishable on the server
    /* The captured map has landed on a round that is streaming the live one.
     *
     * Taken without asking, and it is the only case that is. Anything short of
     * a published map - a lite-geo package, or no package at all - means the
     * surface under the player is live tiles, fetched and drawn for every hole
     * for the whole round. A published capture is the same course as a
     * declared surface: less network, less battery, and it renders without the
     * basemap at all. Prompting to make the round cheaper is a question with
     * one sensible answer, so this stops asking it.
     *
     * Every other move stays a prompt. A player already on a published map is
     * being offered a NEWER one, and swapping the ground under them mid-hole
     * is a change they should get to decline. */
    if (mapType === "published" && activeMapType !== "published") {
      adoptMapUpdate(course, pkg, mapType);
      return;
    }
    /* The dismissal belongs to the prompt, not to the check - it was a "no" to
       being asked, and the auto-adopt above never asked. */
    if (mapUpdateDismissed) return;
    var local = app.courseStore.load(course.courseId);
    /* Playing on the live map with nothing saved: the first map to appear is
       genuinely new to this device, whatever its version. */
    if (!local) { showMapUpdateBar(course, pkg, mapType); return; }
    if (!app.courseVersions.isStale(local, {
      objectsVersion: pkg.objectsVersion || null,
      mapVersion: pkg.packageVersion || null
    })) return;
    showMapUpdateBar(course, pkg, mapType);
  }

  /* Save it, adopt it, and hand it to the Marshal.
   *
   * PACKAGE_UPDATED is a swap, not a restart: shots already recorded stay, the
   * live hole stays, the mode stays, and only the geometry underneath changes
   * (see marshal.js). That is what makes taking a map mid-round safe enough to
   * do without asking. */
  function adoptMapUpdate(course, pkg, mapType) {
    saveCourseToLibrary(course, pkg);
    activeMapType = mapType;
    app.marshal.signal("PACKAGE_UPDATED", { pkg: pkg });
    document.getElementById("mapUpdateBar").classList.add("hiddenState");
  }

  /* A prompt, not an auto-switch - the auto-download bias only applies to a
     map that's already there when the round STARTS (openPlay saves it with
     no prompt at all); one that arrives mid-round asks first, since the
     player is already using the map they have. */
  function showMapUpdateBar(course, pkg, mapType) {
    /* "Available" is the right word only when the device has nothing. With a
       copy already saved this bar is offering a NEWER one, and saying
       "available" there is the same overclaim checkForMapUpdate just stopped
       making. */
    document.getElementById("mapUpdateLabel").textContent =
      app.courseStore.load(course.courseId) ? "Updated map available"
        : mapType === "published" ? "Published map available" : "Course map available";
    document.getElementById("mapUpdateBar").classList.remove("hiddenState");
    document.getElementById("mapUpdateDownload").onclick = function () {
      adoptMapUpdate(course, pkg, mapType);
    };
  }

  /* Resuming lands on the hole the round reached. start() has already opened
     the first hole in play, so this is a second transition rather than a
     parameter to it - which also means a stale or nonsense hole number simply
     leaves the player on hole 1 rather than failing the whole entry. */
  function goResumeHole(hole) {
    var n = Number(hole);
    if (!Number.isFinite(n) || n < 1) return;
    if (app.marshal.round().hole === n) return;
    app.marshal.signal("VIEW_HOLE_CHANGED", { hole: n });
  }

  async function openPlay(course, resumeHole) {
    show("play");
    activeCourse = course;
    mapUpdateDismissed = false;
    gpsNoticeDismissed = false;
    /* Record the round the moment it is genuinely up, so a phone that dies on
       the 7th tee still has somewhere to come back to. play.js keeps the hole
       current from here on. */
    if (app.resume && roundFeatures()) app.resume.setCourse(course);
    var cached = app.courseStore.load(course.courseId);
    var pkg = cached && cached.pkg;
    if (pkg) {
      /* Bias to the downloaded copy: play starts immediately, never waits
         on a network round-trip for a course already on the device. */
      activeMapType = cached.mapType;
      startRound(course, pkg);
      goResumeHole(resumeHole);
      hideLoadingScreen();
      startDemoCourseDataTimerIfNeeded();
    } else {
      /* awaitCoursePackage, not fetchCoursePackage: for a course the server
         is still mapping ("processing"), this holds the player behind the
         loading screen until the map lands rather than silently starting a
         live-map-only round they would have to leave and re-enter to fix.
         A terminal answer or a timeout still falls through to the live map
         exactly as a plain null fetch always has. */
      setLoadingTitle(course.courseName);
      setLoading("Downloading course map", 24);
      pkg = await app.awaitCoursePackage({
        courseId: course.courseId,
        courseName: course.courseName,
        courseLat: course.courseLat,
        courseLng: course.courseLng,
        onProgress: function (info) {
          setLoading(info.waitedMs > 30000
            ? "Preparing course - first-time setup can take a little longer"
            : "Preparing course...",
            Math.min(90, 30 + 60 * (info.waitedMs / info.budgetMs)));
        }
      });
      activeMapType = mapTypeOf(pkg);
      /* null package → live map only. Normal, per the handover. */
      startRound(course, pkg);
      goResumeHole(resumeHole);
      hideLoadingScreen();
      startDemoCourseDataTimerIfNeeded();
      saveCourseToLibrary(course, pkg);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    /* FIRST, before any route opens. A hand-off to a course already in the
       library starts the round synchronously, and the map it builds on the way
       past can only pick aerial imagery if the keys are already on their way.
       This used to sit at the bottom of this handler, after openPlay. */
    app.basemap.prefetch();
    document.getElementById("accountAction").addEventListener("click", function () {
      if (app.account.signedIn()) { app.account.signOut(); renderAccountState(); }
      else show("signin");
    });
    document.getElementById("signInForm").addEventListener("submit", submitSignIn);
    document.getElementById("signInBack").addEventListener("click", function () { show("home"); });
    document.getElementById("globalBackBtn").addEventListener("click", exitBack);
    document.getElementById("globalHomeBtn").addEventListener("click", exitToMainSite);
    document.getElementById("railGpsSettings").addEventListener("click", openGpsSettings);
    /* The hole controls send their own Signals (painter.js). This listener is
       only the background "has a published map appeared" check riding along. */
    document.getElementById("prevHole").addEventListener("click", checkForMapUpdate);
    document.getElementById("nextHole").addEventListener("click", checkForMapUpdate);
    document.getElementById("holeNumber").addEventListener("click", openHolePicker);
    document.getElementById("holePickerClose").addEventListener("click", closeHolePicker);
    document.getElementById("mapUpdateDismiss").addEventListener("click", function () {
      mapUpdateDismissed = true;
      document.getElementById("mapUpdateBar").classList.add("hiddenState");
    });
    var demoCourseDataCta = document.getElementById("gdDemoCourseDataCta");
    if (demoCourseDataCta) demoCourseDataCta.addEventListener("click", seeDemoCourseData);
    var handoffCourseId = new URLSearchParams(window.location.search).get("courseId");
    if (handoffCourseId) {
      openPlay(courseFromUrl(handoffCourseId),
        new URLSearchParams(window.location.search).get("hole"));
    } else {
      show("home");
      hideLoadingScreen();
    }
    document.getElementById("gpsNoticeDismiss").addEventListener("click", function () {
      gpsNoticeDismissed = true;
      document.getElementById("gpsNotice").classList.add("hiddenState");
    });
    app.courseDataFeedInstalled = !!(app.courseData && app.courseData.submit);
    app.showRoute = show;   // access.js offers sign-in without leaving the page
    app.nativeBackInstalled = installNativeBack();
    app.booted = true;   // boot-test canary: the last line of the load order ran
  });

  /* The old course picker hands off a confirmed, already-mapped course by navigating
     here with ?courseId=... (courseName/courseLat/courseLng optional) rather than
     re-entering its own picker screen. */
  /* Number(null) is 0, and so is Number("") — both finite, and both a real
     point in the Gulf of Guinea. The picker only appends courseLat/courseLng
     when its own row carried them, so a course handed off without them used to
     start the round with a centre 15,000km away, and every GPS fix was rejected
     for the whole round. Absent has to read as absent so the Marshal falls
     through to deriving the centre from the package's own geometry. */
  function coordParam(params, name) {
    var raw = params.get(name);
    if (raw === null || String(raw).trim() === "") return NaN;
    var n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
  }

  function courseFromUrl(courseId) {
    var params = new URLSearchParams(window.location.search);
    return {
      courseId: courseId,
      courseName: params.get("courseName") || "",
      courseLat: coordParam(params, "courseLat"),
      courseLng: coordParam(params, "courseLng")
    };
  }
})();
