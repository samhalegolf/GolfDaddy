/* Wiring only. Route transitions toggle body classes here and nowhere else, and
   each transition finishes its own cleanup — no pollers exist to catch strays. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var pickerToken = 0;

  function show(route) {
    ["home", "picker", "play", "signin"].forEach(function (name) {
      document.body.classList.toggle("route-" + name, route === name);
    });
    if (route !== "play") app.play.stop();
    if (route !== "picker") pickerToken += 1;   // cancel an in-flight library load
    if (route === "home") renderAccountState();
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

  function renderCourseList(courses) {
    var list = document.getElementById("courseList");
    var empty = document.getElementById("pickerEmpty");
    list.textContent = "";
    empty.classList.toggle("hiddenState", courses.length > 0);
    courses.forEach(function (course) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      button.className = "courseRow";
      button.textContent = course.courseName + (course.holeCount ? " · " + course.holeCount + " holes" : "");
      button.addEventListener("click", function () { openPlay(course); });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  async function openPicker() {
    var token = ++pickerToken;
    show("picker");
    renderCourseList([]);   // empty state until the library answers
    var courses = await app.fetchCourseLibrary();
    if (token !== pickerToken) return;   // user navigated away meanwhile
    renderCourseList(courses);
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
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("playTile").addEventListener("click", openPicker);
    document.getElementById("accountAction").addEventListener("click", function () {
      if (app.account.signedIn()) { app.account.signOut(); renderAccountState(); }
      else show("signin");
    });
    document.getElementById("signInForm").addEventListener("submit", submitSignIn);
    document.getElementById("signInBack").addEventListener("click", function () { show("home"); });
    document.getElementById("pickerBack").addEventListener("click", function () { show("home"); });
    document.getElementById("backHome").addEventListener("click", function () { show("home"); });
    document.getElementById("prevHole").addEventListener("click", function () {
      app.play.goHole(Math.max(1, app.play.state().hole - 1));
    });
    document.getElementById("nextHole").addEventListener("click", function () {
      app.play.goHole(Math.min(18, app.play.state().hole + 1));
    });
    show("home");
    app.basemap.prefetch();   // so base-layer choice is synchronous by map time
    app.booted = true;   // boot-test canary: the last line of the load order ran
  });
})();
