/* Take a player off this coach's roster, on the server too.
 *
 * gdCoachUnlinkPlayer cuts the link in localStorage immediately - that part
 * must not wait on the network, and must not fail because of it. This module is
 * the server half, called after the fact.
 *
 * It matters because clarity-coach-roster.js rebuilds the roster from the
 * server, and coach-roster.js counts a link claimed by EITHER side as a link.
 * A player removed only on the phone is back in the list within thirty seconds.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/coach-unlink-player";

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }

  function report(detail) {
    safe(function () {
      if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
        window.ClarityErrorReporter.report("Server coach unlink failed", detail);
      }
    });
  }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  async function unlink(playerAccountId) {
    var id = String(playerAccountId || "").trim();
    if (!id) return { ok: false, reason: "no_player" };

    var token = await accessToken();
    if (!token) return { ok: false, reason: "no_session" };

    var body = null;
    try {
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, playerAccountId: id })
      });
      body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !body.ok) {
        /* Reported rather than swallowed: the local link is already cut, so a
           failure here is invisible until the player reappears on the next
           roster refresh and the coach concludes the button is broken. */
        report("playerAccountId=" + id + " code=" + ((body && body.code) || "unknown"));
        return { ok: false, reason: (body && body.code) || "request_failed" };
      }
    } catch (error) {
      report("playerAccountId=" + id + " error=" + (error && error.message || ""));
      return { ok: false, reason: "network" };
    }

    return { ok: true, unlinked: !!body.unlinked, playerAccountId: id };
  }

  window.ClarityCoachUnlink = { unlink: unlink };
})();
