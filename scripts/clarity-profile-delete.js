/* Remove one spare profile from your own account, on the server too.
 *
 * gdAccountDeleteManagedProfile removes the row from localStorage immediately -
 * that part must not wait on the network, and must not fail because of it. This
 * module is the server half, called after the fact.
 *
 * It matters because clarity-profile-hydrate restores the whole list from
 * app_profiles whenever a device loses its storage. A profile deleted only on
 * the phone comes straight back on the next restore, which is how one account
 * reached four copies of the same player in the first place.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/account-profile-delete";

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  async function remove(profileId) {
    var id = String(profileId || "").trim();
    if (!id) return { ok: false, reason: "no_profile" };

    var token = await accessToken();
    if (!token) return { ok: false, reason: "no_session" };

    var body = null;
    try {
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, profileId: id })
      });
      body = await response.json().catch(function () { return null; });
      if (!response.ok || !body || !body.ok) {
        /* Reported rather than swallowed: the local row is already gone, so a
           failure here is invisible until the profile reappears weeks later
           after a storage wipe. That silent shape is what this whole area was
           reported for. */
        safe(function () {
          if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
            window.ClarityErrorReporter.report(
              "Server profile delete failed",
              "profileId=" + id + " code=" + ((body && body.code) || "unknown")
            );
          }
        });
        return { ok: false, reason: (body && body.code) || "request_failed" };
      }
    } catch (error) {
      safe(function () {
        if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
          window.ClarityErrorReporter.report("Server profile delete failed", "profileId=" + id + " error=" + (error && error.message || ""));
        }
      });
      return { ok: false, reason: "network" };
    }

    return { ok: true, deleted: !!body.deleted, profileId: id };
  }

  window.ClarityProfileDelete = { remove: remove };
})();
