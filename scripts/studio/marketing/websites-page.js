/* Clarity Studio — Marketing › Websites. Studio-only.
 *
 * Clarity's own public websites (the Clarity Caddy site, and the Clarity Golf Booking site at
 * the root of claritygolf.app) are built with Clarity Booking's website builder: the same
 * editor, renderer and hosting coaches use for their own sites. There is one builder, and it
 * lives in the Booking repository, so this page does not draw an editor of its own. It frames
 * the builder from the Booking deploy at <bookingUrl>/studio-sites, and every change to the
 * builder shows up here the moment Booking deploys it.
 *
 * The frame has no Booking session. When it asks ({source:"clarity-studio-sites",
 * type:"need-pass"}), this page fetches a short-lived pass from /api/studio-site-pass
 * (functions/studio-site-pass.mjs: admin-checked, signed with the shared service secret) and
 * posts it to the frame, addressed to the Booking origin only, so no other page can read it.
 * The frame asks again before a pass runs out. */
(function () {
  "use strict";

  var FRAME_SOURCE = "clarity-studio-sites";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  async function accessToken() {
    if (typeof window.gdAdminCourseDbAccessToken === "function") return window.gdAdminCourseDbAccessToken();
    try {
      var auth = window.ClaritySupabaseAuth;
      if (auth && typeof auth.freshAccessToken === "function") return (await auth.freshAccessToken()) || "";
    } catch (e) {}
    return "";
  }

  /* { pass, expiresAt, bookingUrl } for the signed-in admin. */
  async function fetchPass() {
    var token = await accessToken();
    if (!token) throw new Error("Sign in as an admin first.");
    var res = await fetch("/api/studio-site-pass", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      cache: "no-store"
    });
    var data = await res.json().catch(function () { return null; });
    if (!res.ok || !data || !data.pass) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  function render(containerEl) {
    var destroyed = false;
    var frame = null;
    var bookingOrigin = "";

    var root = document.createElement("div");
    root.className = "gdSitesRoot";
    root.innerHTML =
      '<div class="gdStudioLede"><p>Clarity\'s public websites, built with the same website builder coaches use in Clarity Booking. ' +
      "There is one builder: anything added to it reaches these sites and every coach's site together.</p></div>" +
      '<p class="gdStudioMuted gdSitesStatus">Signing in to the builder…</p>';
    containerEl.appendChild(root);
    var status = root.querySelector(".gdSitesStatus");

    function onMessage(event) {
      if (!frame || event.source !== frame.contentWindow || event.origin !== bookingOrigin) return;
      var data = event.data || {};
      if (data.source !== FRAME_SOURCE || data.type !== "need-pass") return;
      fetchPass().then(function (got) {
        if (destroyed || !frame) return;
        frame.contentWindow.postMessage({ source: "clarity-studio", type: "pass", pass: got.pass, expiresAt: got.expiresAt }, bookingOrigin);
      }).catch(function (error) {
        if (destroyed || !frame) return;
        frame.contentWindow.postMessage({ source: "clarity-studio", type: "pass-error", message: String(error && error.message || error) }, bookingOrigin);
      });
    }
    window.addEventListener("message", onMessage);

    /* One pass up front: it proves the admin can sign in, and says where the builder lives. */
    fetchPass().then(function (got) {
      if (destroyed) return;
      bookingOrigin = new URL(got.bookingUrl).origin;
      status.remove();
      frame = document.createElement("iframe");
      frame.className = "gdSitesFrame";
      frame.title = "Website builder";
      frame.src = got.bookingUrl + "/studio-sites";
      root.appendChild(frame);
      var where = document.createElement("p");
      where.className = "gdStudioMuted";
      where.innerHTML = "Built and hosted by Clarity Booking (" + esc(bookingOrigin) + ").";
      root.appendChild(where);
    }).catch(function (error) {
      if (!destroyed) status.textContent = "Could not open the website builder: " + (error.message || error);
    });

    return function cleanup() {
      destroyed = true;
      window.removeEventListener("message", onMessage);
      frame = null;
    };
  }

  window.GDStudioPages = window.GDStudioPages || {};
  window.GDStudioPages["marketing-websites"] = render;
})();
