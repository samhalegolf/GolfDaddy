/* The map-not-available banner - shown when a course scan fails, and when it comes back with
 * holes missing.
 *
 * gd-course-library-pin-lock.js (endFailedScan) sends the player back to a fresh course
 * picker and calls GDCourseMapNotify.offer(course). A small card says the map is not
 * available yet and, when we know which course it was, offers to email them once it is done.
 * The same controller calls offer(course, {incomplete}) when the map a course opened with is
 * partial (Sugar Ridge, 2026-10-12: 17 of 18 holes, hole 17 missing) - whether a scan just
 * published it or the course opened from the device's saved copy: the course opens and plays,
 * the card over it says which holes are missing, and the same email offer is made. The server
 * only sends that email once the map is complete (course-map-notify.mjs).
 *
 * The card carries its own email box, so nobody has to have an account to ask: a signed-in
 * player sees their account address filled in, anyone else types one. The tap posts to
 * /api/course-map-notify with that address (and the session token when there is one, so the
 * row is linked to the account). The email itself goes out from the server
 * (course-mapper-sweeper.mjs) once the course has a playable map, however it got one, and asks
 * an address with no account to sign up.
 */
(function () {
  "use strict";

  var REQUESTED_KEY = "gd_course_map_notify_requested_v1";
  /* The address last typed into the card, so the next failed course does not ask for it again. */
  var EMAIL_KEY = "gd_course_map_notify_email_v1";
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

  /* The address to start the box with: the signed-in account's, else the one typed last time. */
  function knownEmail() {
    try {
      var accounts = window.GolfDaddyAccounts;
      var account = accounts && typeof accounts.current === "function" ? accounts.current() : null;
      if (account && account.email) return String(account.email).trim();
    } catch (e) {}
    var saved = readJson(EMAIL_KEY, "");
    return typeof saved === "string" ? saved : "";
  }

  function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

  async function sendRequest(ref, email) {
    var headers = { "Content-Type": "application/json" };
    var token = await accessToken();
    if (token) headers.Authorization = "Bearer " + token;
    var res = await fetch("/api/course-map-notify", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ courseId: ref.courseId, courseName: ref.courseName, email: email })
    });
    var body = await res.json().catch(function () { return null; });
    if (!res.ok) {
      var error = new Error(body && body.error || L("mapNotify.couldNotSave"));
      error.status = res.status;
      throw error;
    }
    rememberRequested(ref.courseId);
    writeJson(EMAIL_KEY, email);
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
        + ".gdCourseMapNotifyCard input[type=email]{width:100%;box-sizing:border-box;margin-top:6px;border:1px solid rgba(246,255,247,.22);border-radius:12px;background:rgba(246,255,247,.08);color:#f6fff7;padding:9px 12px;font-size:14px;text-align:center}"
        + ".gdCourseMapNotifyCard input[type=email]::placeholder{color:rgba(246,255,247,.5)}"
        + ".gdCourseMapNotifyActions{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center}"
        + ".gdCourseMapNotifyActions button{border:1px solid rgba(246,255,247,.22);border-radius:999px;background:rgba(246,255,247,.08);color:#f6fff7;padding:7px 13px;font-size:12px;font-weight:900}"
        + ".gdCourseMapNotifyActions button[data-gd-notify-go]{border-color:rgba(255,159,47,.55);background:rgba(255,159,47,.2)}"
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
      + H(name ? "mapNotify.willEmailAddress" : "mapNotify.willEmailAddressThis", { email: email, course: name }) + "</span>";
    setTimeout(hide, 4000);
  }

  /* The card's wording. A failed scan says the map is not available; a partial one says what
     is missing. `incomplete` is {mapped, expected, missing:[holeNumbers]} from the server
     package's readiness fields. */
  function wording(ref, incomplete) {
    var name = ref.courseName;
    if (incomplete) {
      var missing = Array.isArray(incomplete.missing) ? incomplete.missing.filter(function (n) { return Number.isFinite(Number(n)); }) : [];
      return {
        title: H(name ? "mapNotify.incomplete" : "mapNotify.incompleteThis", { course: name }),
        detail: H(missing.length ? "mapNotify.incompleteDetail" : "mapNotify.incompleteDetailNoList", {
          mapped: Number(incomplete.mapped) || 0,
          expected: Number(incomplete.expected) || 0,
          missing: missing.join(", ")
        }),
        onList: H("mapNotify.incompleteOnList")
      };
    }
    return {
      title: H(name ? "mapNotify.couldNotMap" : "mapNotify.couldNotMapThis", { course: name }),
      detail: H("mapNotify.requestSent"),
      onList: H("mapNotify.onList")
    };
  }

  function offer(course, opts) {
    var ref = courseRef(course);
    var offerId = ++currentOffer;
    var name = ref.courseName;
    var incomplete = opts && opts.incomplete ? opts.incomplete : null;
    var words = wording(ref, incomplete);
    var card = ensureCard();
    card.dataset.gdNotifyOffer = String(offerId);
    card.dataset.gdNotifyKind = incomplete ? "incomplete" : "failed";
    if (!ref.courseId || alreadyRequested(ref.courseId)) {
      card.innerHTML = "<strong>" + words.title + "</strong><span>" + (ref.courseId ? words.onList : words.detail) + "</span>"
        + '<div class="gdCourseMapNotifyActions"><button type="button" data-gd-notify-close>' + H("mapNotify.ok") + '</button></div>';
    } else {
      card.innerHTML = "<strong>" + words.title + "</strong><span>" + words.detail + "</span>"
        + '<input type="email" autocomplete="email" inputmode="email" data-gd-notify-email placeholder="' + esc(L("mapNotify.emailPlaceholder")) + '" value="' + esc(knownEmail()) + '">'
        + '<div class="gdCourseMapNotifyActions">'
        + '<button type="button" data-gd-notify-go>' + H("mapNotify.emailMe") + "</button>"
        + '<button type="button" data-gd-notify-close>' + H("mapNotify.noThanks") + '</button></div>';
      var input = card.querySelector("[data-gd-notify-email]");
      var go = card.querySelector("[data-gd-notify-go]");
      var submit = async function () {
        var email = String(input.value || "").trim().toLowerCase();
        if (!validEmail(email)) { toastSafe(L("auth.errValidEmail")); input.focus(); return; }
        go.disabled = true;
        try {
          var result = await sendRequest(ref, email);
          showDone(card, name, result.email || email);
        } catch (e) {
          go.disabled = false;
          toastSafe(e && e.message || L("mapNotify.couldNotSave"));
        }
      };
      go.onclick = submit;
      input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } };
    }
    var close = card.querySelector("[data-gd-notify-close]");
    if (close) close.onclick = hide;
    card.classList.remove("hidden");
    return offerId;
  }

  window.GDCourseMapNotify = { offer: offer, hide: hide };
})();
