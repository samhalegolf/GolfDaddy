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

  function show(route) {
    ["home", "play", "signin"].forEach(function (name) {
      document.body.classList.toggle("route-" + name, route === name);
    });
    if (route !== "play") {
      app.play.stop();
      activeCourse = null;
      activeMapType = null;
    }
    if (route === "home") renderAccountState();
  }

  /* Visible from first paint (see index.html) so it covers both the "which
     route" decision and, on a hand-off, the course-package fetch — hidden
     once there's something real underneath it to show. */
  function hideLoadingScreen() {
    var el = document.getElementById("loadingScreen");
    if (el) el.classList.add("hiddenState");
  }

  /* Exits GPS play back to the main site - the picker there is the only
     other entry point into this page, so there's nothing of this page's own
     to navigate back to. Home lands on the site root; Back prefers actual
     browser history so it returns to the picker they came from. GPS
     Settings deep-links into the old shell's GPS settings panel, which
     checks for this param on boot the same way it already does for the
     password-reset route. */
  function exitToMainSite() {
    window.location.href = "/";
  }
  /* During play, Back undoes the most recent wind/pin change before it
     leaves the screen - only once there is nothing left to undo does it
     fall through to leaving GPS play the way it always has. */
  function exitBack() {
    if (app.undo && app.undo.pop()) return;
    if (window.history.length > 1) window.history.back();
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
  function openHolePicker() {
    var grid = document.getElementById("holePickerGrid");
    var current = app.play.state().hole;
    grid.textContent = "";
    app.play.availableHoles().forEach(function (hole) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = String(hole);
      button.className = hole === current ? "active" : "";
      button.addEventListener("click", function () {
        app.play.goHole(hole);
        closeHolePicker();
        checkForMapUpdate();
      });
      grid.appendChild(button);
    });
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
      objectsVersion: pkg.geometryVersion || null,
      mapVersion: pkg.packageVersion || null,
      pkg: pkg
    });
  }

  /* If the course started on the object map (or nothing at all), check once
     per hole change whether a published map has since appeared - a real
     answer, not guessed at, since the same /api/course-package fetch used
     everywhere else already reports it. Fire-and-forget: this runs after a
     hole change already resolved, never blocks navigation. */
  async function checkForMapUpdate() {
    if (activeMapType === "published" || mapUpdateDismissed || !activeCourse) return;
    var course = activeCourse;
    var token = ++updateCheckToken;
    var pkg = await app.fetchCoursePackage({
      courseId: course.courseId, courseName: course.courseName,
      courseLat: course.courseLat, courseLng: course.courseLng
    });
    if (token !== updateCheckToken || activeCourse !== course) return;   // superseded: left/changed course
    var mapType = mapTypeOf(pkg);
    if (mapType && mapType !== activeMapType) showMapUpdateBar(course, pkg, mapType);
  }

  /* A prompt, not an auto-switch - the auto-download bias only applies to a
     map that's already there when the round STARTS (openPlay saves it with
     no prompt at all); one that arrives mid-round asks first, since the
     player is already using the map they have. */
  function showMapUpdateBar(course, pkg, mapType) {
    document.getElementById("mapUpdateLabel").textContent =
      mapType === "published" ? "Published map available" : "Course map available";
    var bar = document.getElementById("mapUpdateBar");
    bar.classList.remove("hiddenState");
    document.getElementById("mapUpdateDownload").onclick = function () {
      saveCourseToLibrary(course, pkg);
      activeMapType = mapType;
      app.play.updatePackage(pkg);
      bar.classList.add("hiddenState");
    };
  }

  async function openPlay(course) {
    show("play");
    activeCourse = course;
    mapUpdateDismissed = false;
    gpsNoticeDismissed = false;
    var cached = app.courseStore.load(course.courseId);
    var pkg = cached && cached.pkg;
    if (pkg) {
      /* Bias to the downloaded copy: play starts immediately, never waits
         on a network round-trip for a course already on the device. */
      activeMapType = cached.mapType;
      await app.play.start(course.courseId, pkg, { lat: course.courseLat, lng: course.courseLng });
      hideLoadingScreen();
    } else {
      pkg = await app.fetchCoursePackage({
        courseId: course.courseId,
        courseName: course.courseName,
        courseLat: course.courseLat,
        courseLng: course.courseLng
      });
      activeMapType = mapTypeOf(pkg);
      /* null package → live map only. Normal, per the handover. */
      await app.play.start(course.courseId, pkg, { lat: course.courseLat, lng: course.courseLng });
      hideLoadingScreen();
      saveCourseToLibrary(course, pkg);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("accountAction").addEventListener("click", function () {
      if (app.account.signedIn()) { app.account.signOut(); renderAccountState(); }
      else show("signin");
    });
    document.getElementById("signInForm").addEventListener("submit", submitSignIn);
    document.getElementById("signInBack").addEventListener("click", function () { show("home"); });
    document.getElementById("globalBackBtn").addEventListener("click", exitBack);
    document.getElementById("globalHomeBtn").addEventListener("click", exitToMainSite);
    document.getElementById("railGpsSettings").addEventListener("click", openGpsSettings);
    document.getElementById("prevHole").addEventListener("click", function () {
      app.play.prevHole();
      checkForMapUpdate();
    });
    document.getElementById("nextHole").addEventListener("click", function () {
      app.play.nextHole();
      checkForMapUpdate();
    });
    document.getElementById("holeNumber").addEventListener("click", openHolePicker);
    document.getElementById("holePickerClose").addEventListener("click", closeHolePicker);
    document.getElementById("mapUpdateDismiss").addEventListener("click", function () {
      mapUpdateDismissed = true;
      document.getElementById("mapUpdateBar").classList.add("hiddenState");
    });
    var handoffCourseId = new URLSearchParams(window.location.search).get("courseId");
    if (handoffCourseId) {
      openPlay(courseFromUrl(handoffCourseId));
    } else {
      show("home");
      hideLoadingScreen();
    }
    document.getElementById("gpsNoticeDismiss").addEventListener("click", function () {
      gpsNoticeDismissed = true;
      document.getElementById("gpsNotice").classList.add("hiddenState");
    });
    if (app.gps) app.gps.onStatus(renderGpsNotice);
    if (app.courseData) app.courseDataFeedInstalled = app.courseData.install();
    app.basemap.prefetch();   // so base-layer choice is synchronous by map time
    app.nativeBackInstalled = installNativeBack();
    app.booted = true;   // boot-test canary: the last line of the load order ran
  });

  /* The old course picker hands off a confirmed, already-mapped course by navigating
     here with ?courseId=... (courseName/courseLat/courseLng optional) rather than
     re-entering its own picker screen. */
  function courseFromUrl(courseId) {
    var params = new URLSearchParams(window.location.search);
    return {
      courseId: courseId,
      courseName: params.get("courseName") || "",
      courseLat: Number(params.get("courseLat")),
      courseLng: Number(params.get("courseLng"))
    };
  }
})();
