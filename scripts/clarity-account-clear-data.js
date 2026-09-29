/* In-app "clear my golf data".
 *
 * The middle option between changing nothing and deleting the account. Play's
 * Data safety form asks whether users can have some of their data deleted
 * without losing their account; this is the feature that makes the answer yes.
 *
 * The server owns the decision, exactly as in clarity-account-delete.js. This
 * module never treats a local wipe as success - it asks /api/account-clear-data
 * first and only clears the device once the server confirms. Clearing locally on
 * a failed request would show the player an empty app while their rounds were
 * still on the server, and the next sync would put them all back.
 *
 * WHY A PRESERVE LIST RATHER THAN localStorage.clear()
 *
 * Account deletion can afford localStorage.clear(), because afterwards there is
 * no account to stay signed in to. Here there is. A blanket clear would drop
 * clarity:supabase-auth-session:v1 and sign the user out of an account they
 * explicitly chose to keep - which reads as "clearing my data deleted my
 * account", the exact confusion this feature exists to avoid.
 *
 * So: remove everything the backup module considers Clarity data, minus the keys
 * below. The pattern is copied from clarity-backup.js on purpose - what a backup
 * captures and what a clear removes should be the same set, or one of them is
 * wrong.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/account-clear-data";

  /* Same pattern clarity-backup.js uses to decide what belongs to Clarity. */
  var KEY_PATTERN = /^(gd_|clarity|Clarity|GolfDaddy)/;

  /* Survives the clear. Sign-in and identity, because the account is being kept;
     payment and referral state, because the player still paid for it and the
     entitlement is re-read from the server anyway. */
  var PRESERVE = [
    "clarity:supabase-auth-session:v1",
    "clarity:payments:status:v1",
    "clarity:payments:settings:v1",
    "clarity:referral:token:v1",
    "gd_accounts_v1",
    "gd_account_keep_logged_in_v1",
    "gd_account_session_login_v1",
    "gd_account_signed_out_v1",
    "gd_account_permission_v1",
    "gd_player_profiles_v27"
  ];

  var busy = false;

  function safe(fn) { try { return fn(); } catch (_e) { return undefined; } }
  function L(key, vars) { return window.GDI18n.t(key, vars); }
  function H(key, vars) { return window.GDI18n.html(key, vars); }
  /* The confirmation word in the player's language; CLEAR always works too.
     The server is still sent CLEAR either way. */
  function confirmed(value) {
    var typed = plainWord(value);
    return typed === "CLEAR" || typed === plainWord(L("clearData.confirmWord"));
  }
  /* Capitals and accents do not count: LOSCHEN is LÖSCHEN, STERGE is ȘTERGE -
     phone keyboards make the accented letter the slow one to find. */
  function plainWord(value) {
    return String(value || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLocaleUpperCase(window.GDI18n.locale());
  }
  function toast(message) {
    safe(function () { if (window.toast) window.toast(message); });
  }

  async function accessToken() {
    var auth = window.ClaritySupabaseAuth;
    if (!auth || typeof auth.freshAccessToken !== "function") return "";
    try { return (await auth.freshAccessToken()) || ""; } catch (_e) { return ""; }
  }

  function shouldClear(key) {
    var name = String(key || "");
    if (!KEY_PATTERN.test(name)) return false;
    return PRESERVE.indexOf(name) === -1;
  }

  /* Collect first, then remove. Removing while iterating a Storage object
     reindexes it and silently skips every other key. */
  function clearStorage(storage) {
    if (!storage) return 0;
    var doomed = [];
    for (var i = 0; i < storage.length; i++) {
      var key = storage.key(i);
      if (shouldClear(key)) doomed.push(key);
    }
    for (var j = 0; j < doomed.length; j++) {
      safe(function () { storage.removeItem(doomed[j]); });
    }
    return doomed.length;
  }

  function clearLocal() {
    return clearStorage(window.localStorage) + clearStorage(window.sessionStorage);
  }

  function close() {
    var overlay = document.getElementById("clarityAccountClearOverlay");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function open() {
    if (document.getElementById("clarityAccountClearOverlay")) return;

    var overlay = document.createElement("div");
    overlay.id = "clarityAccountClearOverlay";
    overlay.className = "clarityAccountDeleteOverlay clarityAccountClearOverlay";
    overlay.innerHTML = [
      '<div class="clarityAccountDeleteBox" role="dialog" aria-modal="true" aria-labelledby="clarityAccountClearTitle">',
      '<strong id="clarityAccountClearTitle">' + H("clearData.row") + '</strong>',
      "<span>" + H("clearData.body") + "</span>",
      "<span>" + H("clearData.kept") + "</span>",
      '<label for="clarityAccountClearConfirm">' + H("deleteAccount.typeToConfirm", { word: L("clearData.confirmWord") }) + '</label>',
      '<input id="clarityAccountClearConfirm" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="' + H("clearData.confirmWord") + '">',
      '<span class="clarityAccountDeleteError" id="clarityAccountClearError" hidden></span>',
      '<div class="clarityAccountDeleteActions">',
      '<button type="button" class="secondary" id="clarityAccountClearCancel">' + H("clearData.keep") + '</button>',
      '<button type="button" id="clarityAccountClearConfirmBtn" disabled>' + H("clearData.confirm") + '</button>',
      "</div>",
      "</div>"
    ].join("");
    document.body.appendChild(overlay);

    var input = document.getElementById("clarityAccountClearConfirm");
    var confirmBtn = document.getElementById("clarityAccountClearConfirmBtn");

    input.addEventListener("input", function () {
      confirmBtn.disabled = !confirmed(input.value);
    });
    document.getElementById("clarityAccountClearCancel").addEventListener("click", close);
    confirmBtn.addEventListener("click", function () { run(); });
    safe(function () { input.focus(); });
  }

  function showError(message) {
    var node = document.getElementById("clarityAccountClearError");
    if (!node) { toast(message); return; }
    node.textContent = message;
    node.hidden = false;
  }

  function setBusy(state) {
    busy = state;
    var confirmBtn = document.getElementById("clarityAccountClearConfirmBtn");
    var cancelBtn = document.getElementById("clarityAccountClearCancel");
    if (confirmBtn) {
      confirmBtn.disabled = state;
      confirmBtn.textContent = L(state ? "clearData.busy" : "clearData.confirm");
    }
    if (cancelBtn) cancelBtn.disabled = state;
  }

  async function run() {
    if (busy) return false;
    var input = document.getElementById("clarityAccountClearConfirm");
    if (!input || !confirmed(input.value)) return false;

    setBusy(true);
    var token = await accessToken();
    if (!token) {
      setBusy(false);
      showError(L("clearData.sessionExpired"));
      return false;
    }

    var body = null;
    try {
      var response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token, confirm: "CLEAR" })
      });
      body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body || !body.ok) {
        throw new Error(body && body.error || L("clearData.failed"));
      }
    } catch (error) {
      setBusy(false);
      showError(error && error.message ? error.message : L("clearData.failed"));
      return false;
    }

    /* Server confirmed, so the rows are gone and a resync cannot restore them. */
    clearLocal();
    close();
    toast(L("clearData.done"));

    /* Reload rather than reset the URL: the account is still signed in, and half
       the app holds cleared data in memory from before the wipe. */
    safe(function () { location.reload(); });
    return true;
  }

  function installMenuRow() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list || document.getElementById("gdPlayerSettingsClearDataRow")) return;
    var row = document.createElement("button");
    row.className = "gdPlayerSettingsRow gdPlayerSettingsRowDanger";
    row.id = "gdPlayerSettingsClearDataRow";
    row.type = "button";
    row.onclick = function () { open(); };
    row.innerHTML = '<div><strong data-i18n="clearData.row">' + H("clearData.row") + '</strong>'
      + '<span data-i18n="clearData.rowHint">' + H("clearData.rowHint") + '</span></div>';

    /* Above Delete account when that row already exists, so the menu reads from
       least to most destructive. */
    var deleteRow = document.getElementById("gdPlayerSettingsDeleteAccountRow");
    if (deleteRow && deleteRow.parentNode === list) list.insertBefore(row, deleteRow);
    else list.appendChild(row);
  }

  function boot() {
    installMenuRow();
    /* The settings menu is built lazily, so the row is re-checked when settings
       are opened rather than assuming it exists at load. */
    safe(function () {
      var original = window.gdPlayerSettingsShowSection;
      if (typeof original !== "function" || original.__clarityClearWrapped) return;
      var wrapped = function () {
        var result = original.apply(this, arguments);
        installMenuRow();
        return result;
      };
      wrapped.__clarityClearWrapped = true;
      window.gdPlayerSettingsShowSection = wrapped;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.ClarityAccountClearData = {
    open: open,
    close: close,
    run: run,
    shouldClear: shouldClear,
    PRESERVE: PRESERVE
  };
})();
