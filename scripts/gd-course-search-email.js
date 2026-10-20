/* Ask for an email before the first course search.
 *
 * The course picker (scripts/inline/gd-course-picker-search-v2.js) calls ask() before it runs a
 * typed search. Once per device, a card over the picker asks for an address and says it is only
 * used to tell the player when a map is updated. "Not now" skips it - the rangefinder and search
 * are free features and App Store guideline 5.1.1 does not let them wait on personal details -
 * and either answer is remembered, so the card never comes back on this device.
 *
 * A signed-in player is never asked: the account already has their address.
 *
 * The address goes to /api/course-map-contact (functions/course-map-contact.mjs) with the
 * session token when there is one, and is kept as the email the "map not available" card
 * (gd-course-map-notify.js) starts with.
 */
(function () {
  "use strict";

  var ANSWERED_KEY = "gd_course_search_email_v1";
  /* Shared with gd-course-map-notify.js, so its email box starts with this address. */
  var NOTIFY_EMAIL_KEY = "gd_course_map_notify_email_v1";
  var CARD_ID = "gdCourseSearchEmailCard";
  /* Answered this session even if storage is unavailable, so a blocked localStorage cannot
     put the card in front of every search. */
  var answered = false;
  var pending = null;

  function L(key, vars) { return window.GDI18n.t(key, vars); }
  function H(key, vars) { return window.GDI18n.html(key, vars); }
  function toastSafe(msg) { try { if (typeof window.toast === "function") window.toast(msg); } catch (e) {} }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }

  function accountEmail() {
    try {
      var accounts = window.GolfDaddyAccounts;
      var account = accounts && typeof accounts.current === "function" ? accounts.current() : null;
      return account && account.email ? String(account.email).trim() : "";
    } catch (e) { return ""; }
  }
  function savedNotifyEmail() {
    try { var saved = JSON.parse(localStorage.getItem(NOTIFY_EMAIL_KEY) || "null"); return typeof saved === "string" ? saved : ""; } catch (e) { return ""; }
  }

  function needed() {
    if (answered) return false;
    try { if (localStorage.getItem(ANSWERED_KEY)) { answered = true; return false; } } catch (e) {}
    return !accountEmail();
  }

  function remember(value, email) {
    answered = true;
    try { localStorage.setItem(ANSWERED_KEY, value); } catch (e) {}
    if (email) { try { localStorage.setItem(NOTIFY_EMAIL_KEY, JSON.stringify(email)); } catch (e) {} }
  }

  async function accessToken() {
    try {
      var auth = window.ClaritySupabaseAuth;
      return auth && typeof auth.freshAccessToken === "function" ? (await auth.freshAccessToken()) || "" : "";
    } catch (e) { return ""; }
  }

  async function send(email) {
    var headers = { "Content-Type": "application/json" };
    var token = await accessToken();
    if (token) headers.Authorization = "Bearer " + token;
    var res = await fetch("/api/course-map-contact", { method: "POST", headers: headers, body: JSON.stringify({ email: email }) });
    if (!res.ok) throw new Error(L("searchEmail.couldNotSave"));
  }

  function ensureCard() {
    var el = document.getElementById(CARD_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = CARD_ID;
    el.className = "gdCourseSearchEmailCard hidden";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    document.body.appendChild(el);
    if (!document.getElementById(CARD_ID + "Style")) {
      var style = document.createElement("style");
      style.id = CARD_ID + "Style";
      style.textContent = ".gdCourseSearchEmailCard{position:fixed;inset:0;z-index:7800;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55)}"
        + ".gdCourseSearchEmailCard.hidden{display:none!important}"
        + ".gdCourseSearchEmailBox{display:flex;flex-direction:column;gap:8px;align-items:center;width:min(92vw,360px);box-sizing:border-box;border:1px solid rgba(255,159,47,.34);border-radius:18px;background:rgba(3,18,9,.96);color:#f6fff7;padding:18px 16px;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.34)}"
        + ".gdCourseSearchEmailBox strong{font-size:15px;font-weight:950}.gdCourseSearchEmailBox span{font-size:12px;opacity:.78}"
        + ".gdCourseSearchEmailBox input[type=email]{width:100%;box-sizing:border-box;margin-top:4px;border:1px solid rgba(246,255,247,.22);border-radius:12px;background:rgba(246,255,247,.08);color:#f6fff7;padding:10px 12px;font-size:15px;text-align:center}"
        + ".gdCourseSearchEmailBox input[type=email]::placeholder{color:rgba(246,255,247,.5)}"
        + ".gdCourseSearchEmailActions{display:flex;gap:8px;margin-top:4px;flex-wrap:wrap;justify-content:center}"
        + ".gdCourseSearchEmailActions button{border:1px solid rgba(246,255,247,.22);border-radius:999px;background:rgba(246,255,247,.08);color:#f6fff7;padding:8px 15px;font-size:13px;font-weight:900}"
        + ".gdCourseSearchEmailActions button[data-gd-search-email-go]{border-color:rgba(255,159,47,.55);background:rgba(255,159,47,.2)}"
        + ".gdCourseSearchEmailActions button:disabled{opacity:.55}";
      document.head.appendChild(style);
    }
    return el;
  }

  /* Resolves once the player has given an address or skipped - never rejects - so the caller
     simply runs its search afterwards. */
  function ask() {
    if (!needed()) return Promise.resolve();
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      var card = ensureCard();
      card.innerHTML = '<div class="gdCourseSearchEmailBox">'
        + "<strong>" + H("searchEmail.title") + "</strong><span>" + H("searchEmail.detail") + "</span>"
        + '<input type="email" autocomplete="email" inputmode="email" data-gd-search-email placeholder="' + esc(L("searchEmail.placeholder")) + '" value="' + esc(savedNotifyEmail()) + '">'
        + '<div class="gdCourseSearchEmailActions">'
        + '<button type="button" data-gd-search-email-go>' + H("searchEmail.continue") + "</button>"
        + '<button type="button" data-gd-search-email-skip>' + H("searchEmail.notNow") + "</button></div></div>";
      var input = card.querySelector("[data-gd-search-email]");
      var go = card.querySelector("[data-gd-search-email-go]");
      var finish = function () { card.classList.add("hidden"); pending = null; resolve(); };
      var submit = async function () {
        var email = String(input.value || "").trim().toLowerCase();
        if (!validEmail(email)) { toastSafe(L("auth.errValidEmail")); input.focus(); return; }
        go.disabled = true;
        try {
          await send(email);
          remember("given", email);
          finish();
        } catch (e) {
          go.disabled = false;
          toastSafe(e && e.message || L("searchEmail.couldNotSave"));
        }
      };
      go.onclick = submit;
      input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } };
      card.querySelector("[data-gd-search-email-skip]").onclick = function () { remember("skipped"); finish(); };
      card.classList.remove("hidden");
      setTimeout(function () { try { input.focus(); } catch (e) {} }, 60);
    });
    return pending;
  }

  window.GDCourseSearchEmail = { needed: needed, ask: ask };
})();
