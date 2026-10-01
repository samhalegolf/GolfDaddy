/* The map-not-available banner - shown when a course scan fails.
 *
 * gd-course-library-pin-lock.js (endFailedScan) sends the player back to a fresh course
 * picker and calls GDCourseMapNotify.offer(course). A small card says the map is not
 * available yet and, when we know which course it was, offers to email them once it is done:
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
 *
 * If the player's GPS is on and they are near that course, endFailedScan then calls
 * offerManualGps, which adds a small "Use Manual GPS" button. That button is the only way
 * into manual play.
 */
(function () {
  "use strict";

  var PENDING_KEY = "gd_course_map_notify_pending_v1";
  var REQUESTED_KEY = "gd_course_map_notify_requested_v1";
  var CARD_ID = "gdCourseMapNotifyCard";
  /* Which failed scan the card is showing, so a slow GPS answer for an earlier course
     cannot add its manual button to a later card. */
  var currentOffer = 0;

  function readJson(key, fallback) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }
  function writeJson(key, value) {
    try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function L(key, vars) { return window.GDI18n.t(key, vars); }
  function H(key, vars) { return window.GDI18n.html(key, vars); }
  function toastSafe(msg) { try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function courseRef(course) {
    if (!course) return { courseId: "", courseName: "" };
    return {
      courseId: String(course.courseId || course.id || "").trim(),
      courseName: String(course.courseName || course.name || "").trim()
    };
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
      var error = new Error(body && body.error || L("mapNotify.couldNotSave"));
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
      style.textContent = ".gdCourseMapNotifyCard{position:fixed;left:50%;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 148px);transform:translateX(-50%);z-index:7700;display:flex;flex-direction:column;gap:6px;align-items:center;width:min(92vw,360px);box-sizing:border-box;border:1px solid rgba(255,159,47,.34);border-radius:18px;background:rgba(3,18,9,.92);color:#f6fff7;padding:13px 16px;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.34);backdrop-filter:blur(14px)}"
        + ".gdCourseMapNotifyCard strong{font-size:14px;font-weight:950}.gdCourseMapNotifyCard span{font-size:12px;opacity:.78}"
        + ".gdCourseMapNotifyActions{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center}"
        + ".gdCourseMapNotifyActions button{border:1px solid rgba(246,255,247,.22);border-radius:999px;background:rgba(246,255,247,.08);color:#f6fff7;padding:7px 13px;font-size:12px;font-weight:900}"
        + ".gdCourseMapNotifyActions button[data-gd-notify-go]{border-color:rgba(255,159,47,.55);background:rgba(255,159,47,.2)}"
        + ".gdCourseMapNotifyCard button[data-gd-notify-manual]{border:0;background:none;color:#f6fff7;opacity:.78;padding:4px 8px;font-size:11px;font-weight:800;text-decoration:underline}"
        + ".gdCourseMapNotifyActions button:disabled{opacity:.55}.gdCourseMapNotifyCard.hidden{display:none!important}";
      document.head.appendChild(style);
    }
    return el;
  }

  function hide() {
    currentOffer++;
    try { var el = document.getElementById(CARD_ID); if (el) el.classList.add("hidden"); } catch (e) {}
  }

  function showDone(card, name, email) {
    card.innerHTML = "<strong>" + H("mapNotify.letYouKnow") + "</strong><span>"
      + (email ? H(name ? "mapNotify.willEmailAddress" : "mapNotify.willEmailAddressThis", { email: email, course: name })
        : H(name ? "mapNotify.willEmailYou" : "mapNotify.willEmailYouThis", { course: name })) + "</span>";
    setTimeout(hide, 4000);
  }

  async function offer(course) {
    var ref = courseRef(course);
    var offerId = ++currentOffer;
    var name = ref.courseName;
    var couldNotMap = H(name ? "mapNotify.couldNotMap" : "mapNotify.couldNotMapThis", { course: name });
    var card = ensureCard();
    card.dataset.gdNotifyOffer = String(offerId);
    if (!ref.courseId || alreadyRequested(ref.courseId)) {
      card.innerHTML = "<strong>" + couldNotMap + "</strong><span>" + H(ref.courseId ? "mapNotify.onList" : "mapNotify.requestSent") + "</span>"
        + '<div class="gdCourseMapNotifyActions"><button type="button" data-gd-notify-close>' + H("mapNotify.ok") + '</button></div>';
    } else {
      var signedIn = !!(await accessToken());
      if (offerId !== currentOffer) return false;
      card.innerHTML = "<strong>" + couldNotMap + "</strong><span>" + H("mapNotify.requestSent") + "</span>"
        + '<div class="gdCourseMapNotifyActions">'
        + '<button type="button" data-gd-notify-go>' + H(signedIn ? "mapNotify.emailMe" : "mapNotify.signUp") + "</button>"
        + '<button type="button" data-gd-notify-close>' + H("mapNotify.noThanks") + '</button></div>';
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
          toastSafe(e && e.message || L("mapNotify.couldNotSave"));
        }
      };
    }
    var close = card.querySelector("[data-gd-notify-close]");
    if (close) close.onclick = hide;
    card.classList.remove("hidden");
    return offerId;
  }

  /* Adds the small "Use Manual GPS" button to the card for this failed scan. The caller has
     already checked the player's GPS is on and that they are near the course. */
  function offerManualGps(offerId, onUse) {
    if (!offerId || offerId !== currentOffer || typeof onUse !== "function") return false;
    var card = document.getElementById(CARD_ID);
    if (!card || card.classList.contains("hidden") || card.dataset.gdNotifyOffer !== String(offerId)) return false;
    if (card.querySelector("[data-gd-notify-manual]")) return true;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-gd-notify-manual", "");
    btn.innerHTML = H("mapRecovery.useManualButton");
    btn.onclick = function () { hide(); onUse(); };
    card.appendChild(btn);
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
      toastSafe(ref.courseName ? L("mapNotify.toastWillEmail", { course: ref.courseName }) : L("mapNotify.toastWillEmailYours"));
    } catch (e) {
      toastSafe(e && e.message || L("mapNotify.couldNotSave"));
    }
  }

  window.addEventListener("clarity:session-changed", function () { setTimeout(flushPending, 600); });
  /* And once at startup, for a sign-up that finished with a reload in between. */
  setTimeout(flushPending, 4000);

  window.GDCourseMapNotify = { offer: offer, offerManualGps: offerManualGps, hide: hide, flushPending: flushPending };
})();
