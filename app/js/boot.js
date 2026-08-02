/* Wiring only. Route transitions toggle body classes here and nowhere else, and
   each transition finishes its own cleanup — no pollers exist to catch strays. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  function show(route) {
    ["home", "play", "signin"].forEach(function (name) {
      document.body.classList.toggle("route-" + name, route === name);
    });
    if (route !== "play") app.play.stop();
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
  function exitBack() {
    if (window.history.length > 1) window.history.back();
    else exitToMainSite();
  }
  function openGpsSettings() {
    window.location.href = "/?openGpsSettings=1";
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

  async function openPlay(course) {
    show("play");
    var pkg = await app.fetchCoursePackage({
      courseId: course.courseId,
      courseName: course.courseName,
      courseLat: course.courseLat,
      courseLng: course.courseLng
    });
    /* null package → live map only. Normal, per the handover. */
    await app.play.start(course.courseId, pkg, {
      lat: course.courseLat, lng: course.courseLng
    });
    hideLoadingScreen();
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
    });
    document.getElementById("nextHole").addEventListener("click", function () {
      app.play.nextHole();
    });
    document.getElementById("holeNumber").addEventListener("click", openHolePicker);
    document.getElementById("holePickerClose").addEventListener("click", closeHolePicker);
    var handoffCourseId = new URLSearchParams(window.location.search).get("courseId");
    if (handoffCourseId) {
      openPlay(courseFromUrl(handoffCourseId));
    } else {
      show("home");
      hideLoadingScreen();
    }
    app.basemap.prefetch();   // so base-layer choice is synchronous by map time
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
