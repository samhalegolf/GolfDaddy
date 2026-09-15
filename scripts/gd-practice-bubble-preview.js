/* Temporary Practice Bubble -> Play preview handoff.
 * Carries only direction and handedness. It never carries shots, captures,
 * analysis, bag changes or a saved profile source; paid Adopt/Save remains the
 * only route into My Bubble. */
(function () {
  "use strict";
  if (window.GolfDaddyPracticeBubblePreview) return;
  var STORAGE_KEY = "gd_practice_bubble_preview_v1";
  var SIGNUP_KEY = "gd_practice_bubble_preview_signup_v1";
  var MAX_AGE_MS = 6 * 60 * 60 * 1000;
  function safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
  function read() {
    var value = safe(function () { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); }, null);
    if (!value || value.active !== true || !Number.isFinite(Number(value.offsetDeg))) return null;
    if (!Number.isFinite(Number(value.createdAt)) || Date.now() - Number(value.createdAt) > MAX_AGE_MS) {
      safe(function () { sessionStorage.removeItem(STORAGE_KEY); });
      return null;
    }
    return value;
  }
  function stage(input) {
    input = input || {};
    var offset = Number(input.offsetDeg);
    if (!Number.isFinite(offset)) return null;
    var value = {
      active: true,
      previewOnly: true,
      offsetDeg: Math.max(-15, Math.min(15, offset)),
      handedness: input.handedness === "left" ? "left" : "right",
      source: String(input.source || "practice_data"),
      club: String(input.club || ""),
      guest: input.guest === true,
      createdAt: Date.now()
    };
    safe(function () { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); });
    return value;
  }
  function clear() { safe(function () { sessionStorage.removeItem(STORAGE_KEY); }); }
  function createAccount() {
    safe(function () { sessionStorage.setItem(SIGNUP_KEY, "1"); });
    window.location.href = "/?login=1";
    return false;
  }
  function viewPlans() { window.location.href = "/?login=1&membership=1"; return false; }
  function openRequestedSignup() {
    var requested = safe(function () { return sessionStorage.getItem(SIGNUP_KEY) === "1"; }, false);
    if (!requested || typeof window.gd67OpenAuth !== "function") return false;
    safe(function () { sessionStorage.removeItem(SIGNUP_KEY); });
    window.gd67OpenAuth("signup");
    return true;
  }
  function renderPlayBanner() {
    var preview = read();
    var play = document.getElementById("playScreen");
    if (!preview || !play) return false;
    var banner = document.getElementById("gdPracticeBubblePreviewBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "gdPracticeBubblePreviewBanner";
      banner.className = "gdPracticeBubblePreviewBanner";
      banner.setAttribute("role", "status");
      var top = document.getElementById("playTopBar");
      if (top) top.appendChild(banner);
      else play.insertBefore(banner, play.firstChild);
    }
    banner.innerHTML = '<div><strong>Bubble Preview</strong><span>Your practice Bubble is temporary and stays out of My Bubble until you unlock it.</span></div>'
      + '<button type="button" id="gdPracticeBubblePreviewSignup">' + (preview.guest ? 'Create account' : 'View plans') + '</button>';
    var button = document.getElementById("gdPracticeBubblePreviewSignup");
    if (button) button.onclick = preview.guest ? createAccount : viewPlans;
    document.body.classList.add("gdPracticeBubblePreviewRoute");
    return true;
  }
  var api = { storageKey: STORAGE_KEY, current: read, stage: stage, clear: clear, createAccount: createAccount, renderPlayBanner: renderPlayBanner };
  window.GolfDaddyPracticeBubblePreview = api;
  function boot() {
    /* Returning from /app to the root ends this preview. The root course picker
       does not reload when a preview is first staged, so the handoff survives
       that trip but cannot leak into a later normal Play entry. */
    var path = safe(function () { return String(window.location.pathname || ""); }, "");
    if (path && path.indexOf("/app") === -1 && read()) clear();
    renderPlayBanner();
    [0, 250, 800].forEach(function (delay) { setTimeout(openRequestedSignup, delay); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
