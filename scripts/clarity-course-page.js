/* The public course page's "Looking for your course?" picker (functions/course-page.mjs).
 *
 * The same search the app's picker uses (GET /api/course-search), with each result offering
 * what fits it:
 *   a course with a public page   -> See this course (its /courses/ page)
 *   any course                    -> Request an upgrade (a better map of it)
 *   a course that is not mapped   -> Map this course
 * The two requests are one form (name, email, a note) sent to POST /api/watch-preview-request
 * with `request` and the course, the same ticket the watch preview's sign-up makes. There is
 * no list of courses to browse: discovery here is search-shaped on purpose, and every request
 * is a signal of what to map or improve next.
 *
 * Also the page's one side effect: the first click or key anywhere on it asks for this
 * course's Apple Watch map (POST /api/course-page-wake, functions/course-page-wake.mjs), so by
 * the time the visitor opens the Apple Watch tab the bake is that much further along. Once per
 * page load; the answer is not needed. */
(function (root) {
  "use strict";
  if (!root || !root.document) return;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var LABELS = {
    map: { button: "Map this course", title: "Ask us to map ", done: "We’ll let you know when it’s mapped." },
    upgrade: { button: "Request an upgrade", title: "Ask for a better map of ", done: "We’ll let you know when it’s upgraded." }
  };

  var el = {};
  var state = { searching: null, request: null };

  function wakeAppleOnFirstInteraction() {
    var preview = $("preview");
    var courseId = preview && preview.getAttribute("data-course-id");
    if (!courseId) return;
    var sent = false;
    function wake() {
      if (sent) return;
      sent = true;
      fetch("/api/course-page-wake", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ courseId: courseId }), keepalive: true })
        .catch(function () {});
    }
    ["pointerdown", "keydown"].forEach(function (type) { document.addEventListener(type, wake, { once: true, passive: true }); });
  }

  function boot() {
    wakeAppleOnFirstInteraction();
    ["findForm", "findInput", "findStatus", "findResults", "requestForm", "requestTitle", "requestName", "requestEmail", "requestNote", "requestStatus", "requestCancel"]
      .forEach(function (id) { el[id] = $(id); });
    if (!el.findForm || !el.requestForm) return;
    el.findForm.addEventListener("submit", function (e) { e.preventDefault(); search(el.findInput.value); });
    el.findResults.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-request]");
      if (btn) openRequest(btn.getAttribute("data-request"), btn.getAttribute("data-course-id") || "", btn.getAttribute("data-course-name") || "");
    });
    el.requestForm.addEventListener("submit", sendRequest);
    el.requestCancel.addEventListener("click", closeRequest);
  }

  function search(query) {
    query = String(query || "").trim();
    if (query.length < 2) { el.findStatus.textContent = "Type at least two letters of the course name."; return; }
    el.findStatus.textContent = "Searching…";
    el.findResults.innerHTML = "";
    closeRequest();
    var token = state.searching = {};
    fetch("/api/course-search?q=" + encodeURIComponent(query), { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error("HTTP " + res.status)); })
      .then(function (data) {
        if (token !== state.searching) return;
        var results = (data && data.results) || [];
        if (!results.length) { el.findStatus.textContent = "No course found for “" + query + "”."; return; }
        el.findStatus.textContent = "";
        el.findResults.innerHTML = results.map(resultCard).join("");
      })
      .catch(function (error) { if (token === state.searching) el.findStatus.textContent = "Search failed - " + (error && error.message || error); });
  }

  function resultCard(r) {
    var mapped = !!(r.courseId && r.hasMap);
    var where = [r.region, r.country].filter(Boolean).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ");
    var id = r.courseId || "";
    var actions = [];
    if (mapped && r.hasPage) actions.push('<a class="cpAction isPrimary" href="/courses/' + encodeURIComponent(id) + '">See this course</a>');
    if (!mapped) actions.push(requestButton("map", id, r.name, true));
    actions.push(requestButton("upgrade", id, r.name, false));
    return '<div class="cpResult"><div><strong>' + esc(r.name) + "</strong>" + (where ? "<span>" + esc(where) + "</span>" : "")
      + "<em>" + (mapped ? (r.hasPage ? "On Clarity" : "Mapped on Clarity") : "Not mapped yet") + "</em></div>"
      + '<div class="cpActions">' + actions.join("") + "</div></div>";
  }

  function requestButton(kind, id, name, primary) {
    return '<button type="button" class="cpAction' + (primary ? " isPrimary" : "") + '" data-request="' + kind + '" data-course-id="' + esc(id) + '" data-course-name="' + esc(name) + '">' + LABELS[kind].button + "</button>";
  }

  function openRequest(kind, courseId, courseName) {
    if (!LABELS[kind]) return;
    state.request = { kind: kind, courseId: courseId, courseName: courseName };
    el.requestTitle.textContent = LABELS[kind].title + courseName;
    el.requestStatus.textContent = "";
    el.requestForm.hidden = false;
    el.requestForm.querySelector('button[type="submit"]').disabled = false;
    el.requestName.focus();
  }

  function closeRequest() {
    state.request = null;
    el.requestForm.hidden = true;
  }

  function sendRequest(e) {
    e.preventDefault();
    if (!state.request) return;
    var request = state.request;
    var body = { name: el.requestName.value, email: el.requestEmail.value, note: el.requestNote.value, request: request.kind, courseId: request.courseId, courseName: request.courseName, locale: navigator.language || "" };
    var button = el.requestForm.querySelector('button[type="submit"]');
    button.disabled = true;
    el.requestStatus.textContent = "Sending…";
    fetch("/api/watch-preview-request", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok) { el.requestStatus.textContent = result.data && result.data.error || "Your request could not be sent. Please try again."; button.disabled = false; return; }
        el.requestStatus.textContent = "Thanks, " + body.name.trim() + ". " + LABELS[request.kind].done;
      })
      .catch(function () { el.requestStatus.textContent = "Your request could not be sent. Check your connection and try again."; button.disabled = false; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : null);
