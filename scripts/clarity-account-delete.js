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
  function L(key, vars) { return window.GDI18n.t(key, vars); }
  function H(key, vars) { return window.GDI18n.html(key, vars); }
  /* The confirmation word in the player's language; DELETE always works too.
     The server is still sent DELETE either way. */
  function confirmed(value) {
    var typed = plainWord(value);
    return typed === "DELETE" || typed === plainWord(L("deleteAccount.confirmWord"));
  }
  /* Capitals and accents do not count: LOSCHEN is LÖSCHEN, STERGE is ȘTERGE -
     phone keyboards make the accented letter the slow one to find. */
  function plainWord(value) {
    return String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLocaleUpperCase(window.GDI18n.locale());
  }
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
      return L("deleteAccount.warnStore");
    }
    return L("deleteAccount.warnWeb");
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
      '<strong id="clarityAccountDeleteTitle">' + H("deleteAccount.title") + '</strong>',
      "<span>" + H("deleteAccount.body") + "</span>",
      "<span>" + escapeHTML(subscriptionWarning()) + "</span>",
      '<label for="clarityAccountDeleteConfirm">' + H("deleteAccount.typeToConfirm", { word: L("deleteAccount.confirmWord") }) + '</label>',
      '<input id="clarityAccountDeleteConfirm" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' + H("deleteAccount.confirmWord") + '">',
      '<span class="clarityAccountDeleteError" id="clarityAccountDeleteError" hidden></span>',
      '<div class="clarityAccountDeleteActions">',
      '<button type="button" class="secondary" id="clarityAccountDeleteCancel">' + H("deleteAccount.keep") + '</button>',
      '<button type="button" id="clarityAccountDeleteConfirmBtn" disabled>' + H("deleteAccount.confirm") + '</button>',
      "</div>",
      "</div>"
    ].join("");
    document.body.appendChild(overlay);

    var input = document.getElementById("clarityAccountDeleteConfirm");
    var confirmBtn = document.getElementById("clarityAccountDeleteConfirmBtn");

    /* The button stays disabled until the word is typed exactly. A tap-through
       confirmation is not a confirmation. */
    input.addEventListener("input", function () {
      confirmBtn.disabled = !confirmed(input.value);
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
      confirmBtn.textContent = L(state ? "deleteAccount.busy" : "deleteAccount.confirm");
    }
    if (cancelBtn) cancelBtn.disabled = state;
  }

  async function run() {
    if (busy) return false;
    var input = document.getElementById("clarityAccountDeleteConfirm");
    if (!input || !confirmed(input.value)) return false;

    setBusy(true);
    var token = await accessToken();
    if (!token) {
      setBusy(false);
      showError(L("deleteAccount.sessionExpired"));
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
        throw new Error(body && body.error || L("deleteAccount.failed"));
      }
    } catch (error) {
      setBusy(false);
      showError(error && error.message ? error.message : L("deleteAccount.failed"));
      return false;
    }

    /* Confirmed server-side. Only now is it safe to wipe the device, because the
       account genuinely no longer exists. */
    safe(function () { localStorage.clear(); });
    safe(function () { sessionStorage.clear(); });
    close();
    toast(L("deleteAccount.done"));
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
    row.innerHTML = '<div><strong data-i18n="deleteAccount.row">' + H("deleteAccount.row") + '</strong>'
      + '<span data-i18n="deleteAccount.rowHint">' + H("deleteAccount.rowHint") + '</span></div>';
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
