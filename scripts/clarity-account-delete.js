/* In-app account deletion.
 *
 * Play Console and App Store review both require an in-app route to delete an
 * account for any app that lets you create one. /delete-account.html is the
 * web half, required separately by Play; this is the in-app half.
 *
 * The server owns the decision. This module never removes anything itself and
 * never treats a local wipe as success - it asks /api/account-delete, and only
 * clears local state once the server has confirmed. A client that deleted first
 * would leave a signed-out device and a live account, which looks to the user
 * exactly like a successful deletion and is the worst possible outcome here.
 *
 * Identity travels as the Supabase access token, never as an account id. The
 * endpoint resolves the account from the token, so a tampered client cannot aim
 * this at anyone else.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/account-delete";
  var busy = false;

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }
  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(message) {
    safe(function () { if (window.toast) window.toast(message); });
  }
  function isNative() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  /* Store subscriptions live in the user's Apple/Google account, not ours, and
     deleting the app account cannot cancel them. Saying so before the fact is
     the difference between a clean exit and a chargeback. */
  function subscriptionWarning() {
    if (isNative()) {
      return "If you have a paid membership, cancel it in your App Store or Google Play subscriptions first - deleting your account here does not cancel it, and you would keep being charged.";
    }
    return "If you have a paid membership, tell us when you contact support if you also need billing cancelled.";
  }

  function close() {
    var overlay = document.getElementById("clarityAccountDeleteOverlay");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function open() {
    if (document.getElementById("clarityAccountDeleteOverlay")) return;

    var overlay = document.createElement("div");
    overlay.id = "clarityAccountDeleteOverlay";
    overlay.className = "clarityAccountDeleteOverlay";
    overlay.innerHTML = [
      '<div class="clarityAccountDeleteBox" role="dialog" aria-modal="true" aria-labelledby="clarityAccountDeleteTitle">',
      '<strong id="clarityAccountDeleteTitle">Delete your account</strong>',
      "<span>This permanently deletes your account and your golf data: your profile, bag, practice records, rounds, scores and shots. It cannot be undone.</span>",
      "<span>" + escapeHTML(subscriptionWarning()) + "</span>",
      '<label for="clarityAccountDeleteConfirm">Type DELETE to confirm</label>',
      '<input id="clarityAccountDeleteConfirm" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DELETE">',
      '<span class="clarityAccountDeleteError" id="clarityAccountDeleteError" hidden></span>',
      '<div class="clarityAccountDeleteActions">',
      '<button type="button" class="secondary" id="clarityAccountDeleteCancel">Keep my account</button>',
      '<button type="button" id="clarityAccountDeleteConfirmBtn" disabled>Delete permanently</button>',
      "</div>",
      "</div>"
    ].join("");
    document.body.appendChild(overlay);

    var input = document.getElementById("clarityAccountDeleteConfirm");
    var confirmBtn = document.getElementById("clarityAccountDeleteConfirmBtn");

    /* The button stays disabled until the word is typed exactly. A tap-through
       confirmation is not a confirmation. */
    input.addEventListener("input", function () {
      confirmBtn.disabled = input.value.trim().toUpperCase() !== "DELETE";
    });
    document.getElementById("clarityAccountDeleteCancel").addEventListener("click", close);
    confirmBtn.addEventListener("click", function () { run(); });
    safe(function () { input.focus(); });
  }

  function showError(message) {
    var node = document.getElementById("clarityAccountDeleteError");
    if (!node) { toast(message); return; }
    node.textContent = message;
    node.hidden = false;
  }

  function setBusy(state) {
    busy = state;
    var confirmBtn = document.getElementById("clarityAccountDeleteConfirmBtn");
    var cancelBtn = document.getElementById("clarityAccountDeleteCancel");
    if (confirmBtn) {
      confirmBtn.disabled = state;
      confirmBtn.textContent = state ? "Deleting..." : "Delete permanently";
    }
    if (cancelBtn) cancelBtn.disabled = state;
  }

  async function run() {
    if (busy) return false;
    var input = document.getElementById("clarityAccountDeleteConfirm");
    if (!input || input.value.trim().toUpperCase() !== "DELETE") return false;

    setBusy(true);
    var token = await accessToken();
    if (!token) {
      setBusy(false);
      showError("Your session has expired. Sign in again, then delete your account.");
      return false;
    }

    var body = null;
    try {
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, confirm: "DELETE" })
      });
      body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body || !body.ok) {
        throw new Error(body && body.error || "Your account could not be deleted. Please try again.");
      }
    } catch (error) {
      setBusy(false);
      showError(error && error.message ? error.message : "Your account could not be deleted. Please try again.");
      return false;
    }

    /* Confirmed server-side. Only now is it safe to wipe the device, because the
       account genuinely no longer exists. */
    safe(function () { localStorage.clear(); });
    safe(function () { sessionStorage.clear(); });
    close();
    toast("Your account has been deleted");
    safe(function () { location.replace(location.origin + location.pathname); });
    return true;
  }

  function installMenuRow() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list || document.getElementById("gdPlayerSettingsDeleteAccountRow")) return;
    var row = document.createElement("button");
    row.className = "gdPlayerSettingsRow gdPlayerSettingsRowDanger";
    row.id = "gdPlayerSettingsDeleteAccountRow";
    row.type = "button";
    row.onclick = function () { open(); };
    row.innerHTML = '<div><strong>Delete account</strong><span>Permanently delete your account and data</span></div>';
    list.appendChild(row);
  }

  function boot() {
    installMenuRow();
    /* The settings menu is built lazily, so the row is re-checked when settings
       are opened rather than assuming it exists at load. */
    safe(function () {
      var original = window.gdPlayerSettingsShowSection;
      if (typeof original !== "function" || original.__clarityDeleteWrapped) return;
      var wrapped = function (name) {
        var result = original.apply(this, arguments);
        installMenuRow();
        return result;
      };
      wrapped.__clarityDeleteWrapped = true;
      window.gdPlayerSettingsShowSection = wrapped;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.ClarityAccountDelete = { open: open, close: close, run: run };
})();
