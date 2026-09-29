/* "Email me when this course is ready" - offered when a course scan fails.
 *
 * gd-course-library-pin-lock.js calls GDCourseMapNotify.offer(course) when the server has
 * given its final answer on a course (status "failed" or "manual-required") and the player is
 * dropped into basic GPS. A small card says so and offers to email them once the map is done:
 *
 *   signed in -> one tap posts to /api/course-map-notify, which stores the request against
 *                their verified account email.
 *   guest     -> "Sign up to get notified" opens Create account. The course is remembered
 *                here and the request is sent as soon as a session appears
 *                (clarity:session-changed), so signing up IS the request - they are not asked
 *                twice.
 *
 * The email itself goes out from the server (course-mapper-sweeper.mjs) once the course has a
 * playable map, however it got one.
 */
(function () {
  "use strict";

  var PENDING_KEY = "gd_course_map_notify_pending_v1";
  var REQUESTED_KEY = "gd_course_map_notify_requested_v1";
  var CARD_ID = "gdCourseMapNotifyCard";

  function readJson(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function toastSafe(msg) { try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function courseRef(course) {
    if (!course) return null;
    var id = String(course.courseId || course.id || "").trim();
    if (!id) return null;
    return { courseId: id, courseName: String(course.courseName || course.name || "").trim() };
  }

  /* Already asked on this device - show that, rather than the button again. */
  function alreadyRequested(courseId) {
    var list = readJson(REQUESTED_KEY, []);
    return Array.isArray(list) && list.indexOf(courseId) !== -1;
  }
  function rememberRequested(courseId) {
    var list = readJson(REQUESTED_KEY, []);
    if (!Array.isArray(list)) list = [];
    if (list.indexOf(courseId) === -1) list.push(courseId);
    writeJson(REQUESTED_KEY, list.slice(-50));
  }

  async function accessToken() {
    try {
      var auth = window.ClaritySupabaseAuth;
      return auth && typeof auth.freshAccessToken === "function" ? (await auth.freshAccessToken()) || "" : "";
    } catch (e) { return ""; }
  }

  async function sendRequest(ref, token) {
    var res = await fetch("/api/course-map-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ courseId: ref.courseId, courseName: ref.courseName })
    });
    var body = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var error = new Error(body && body.error || "Could not save your request");
      error.status = res.status;
      throw error;
    }
    rememberRequested(ref.courseId);
    return body || {};
  }

  function ensureCard() {
    var el = document.getElementById(CARD_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = CARD_ID;
    el.className = "gdCourseMapNotifyCard hidden";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    if (!document.getElementById(CARD_ID + "Style")) {
      var style = document.createElement("style");
      style.id = CARD_ID + "Style";
      style.textContent = ".gdCourseMapNotifyCard{position:fixed;left:50%;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 148px);transform:translateX(-50%);z-index:1900;display:flex;flex-direction:column;gap:6px;align-items:center;width:min(92vw,360px);box-sizing:border-box;border:1px solid rgba(255,159,47,.34);border-radius:18px;background:rgba(3,18,9,.92);color:#f6fff7;padding:13px 16px;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.34);backdrop-filter:blur(14px)}"
        + ".gdCourseMapNotifyCard strong{font-size:14px;font-weight:950}.gdCourseMapNotifyCard span{font-size:12px;opacity:.78}"
        + ".gdCourseMapNotifyActions{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center}"
        + ".gdCourseMapNotifyActions button{border:1px solid rgba(246,255,247,.22);border-radius:999px;background:rgba(246,255,247,.08);color:#f6fff7;padding:7px 13px;font-size:12px;font-weight:900}"
        + ".gdCourseMapNotifyActions button[data-gd-notify-go]{border-color:rgba(255,159,47,.55);background:rgba(255,159,47,.2)}"
        + ".gdCourseMapNotifyActions button:disabled{opacity:.55}.gdCourseMapNotifyCard.hidden{display:none!important}";
      document.head.appendChild(style);
    }
    return el;
  }

  function hide() {
    try { var el = document.getElementById(CARD_ID); if (el) el.classList.add("hidden"); } catch (e) {}
  }

  function showDone(card, name, email) {
    card.innerHTML = "<strong>We'll let you know</strong><span>" + esc(email ? "We'll email " + email + " when " + name + " is ready." : "We'll email you when " + name + " is ready.") + "</span>";
    setTimeout(hide, 4000);
  }

  async function offer(course) {
    var ref = courseRef(course);
    if (!ref) return false;
    var name = ref.courseName || "this course";
    var card = ensureCard();
    if (alreadyRequested(ref.courseId)) {
      card.innerHTML = "<strong>We couldn't map " + esc(name) + " yet</strong><span>You're on the list - we'll email you when it's ready. Basic GPS works in the meantime.</span>"
        + '<div class="gdCourseMapNotifyActions"><button type="button" data-gd-notify-close>OK</button></div>';
    } else {
      var signedIn = !!(await accessToken());
      card.innerHTML = "<strong>We couldn't map " + esc(name) + " yet</strong><span>Basic GPS works in the meantime. We'll keep working on the full map.</span>"
        + '<div class="gdCourseMapNotifyActions">'
        + '<button type="button" data-gd-notify-go>' + (signedIn ? "Email me when it's ready" : "Sign up to get notified") + "</button>"
        + '<button type="button" data-gd-notify-close>No thanks</button></div>';
      var go = card.querySelector("[data-gd-notify-go]");
      if (go) go.onclick = async function () {
        var token = await accessToken();
        if (!token) {
          /* Remembered first, so the request survives the trip through Create account. */
          writeJson(PENDING_KEY, ref);
          hide();
          if (typeof window.gd67OpenAuth === "function") window.gd67OpenAuth("signup");
          return;
        }
        go.disabled = true;
        try {
          var result = await sendRequest(ref, token);
          showDone(card, name, result.email);
        } catch (e) {
          go.disabled = false;
          toastSafe(e && e.message || "Could not save your request");
        }
      };
    }
    var close = card.querySelector("[data-gd-notify-close]");
    if (close) close.onclick = hide;
    card.classList.remove("hidden");
    return true;
  }

  /* A guest who tapped "Sign up to get notified" and has now signed up (or signed in). */
  async function flushPending() {
    var ref = readJson(PENDING_KEY, null);
    if (!ref || !ref.courseId) return;
    var token = await accessToken();
    if (!token) return;
    writeJson(PENDING_KEY, null);
    try {
      await sendRequest(ref, token);
      toastSafe("We'll email you when " + (ref.courseName || "your course") + " is ready");
    } catch (e) {
      toastSafe(e && e.message || "Could not save your request");
    }
  }

  window.addEventListener("clarity:session-changed", function () { setTimeout(flushPending, 600); });
  /* And once at startup, for a sign-up that finished with a reload in between. */
  setTimeout(flushPending, 4000);

  window.GDCourseMapNotify = { offer: offer, hide: hide, flushPending: flushPending };
})();
