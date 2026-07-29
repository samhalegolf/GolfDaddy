(function () {
  "use strict";

  var root = window.Clarity = window.Clarity || {};
  var ENDPOINT = "/api/account-sync";
  var OUTBOX_KEY = "clarity:cloud-sync:outbox:v1";
  var STATUS_KEY = "clarity:cloud-sync:status:v1";
  var ACCOUNT_KEY = "gd_accounts_v1";
  var PROFILE_KEY = "gd_player_profiles_v27";
  var status = loadStatus();
  var pending = false;

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function loadStatus() {
    return safe(function () { return JSON.parse(localStorage.getItem(STATUS_KEY) || "null"); }, null) || {
      state: "unknown",
      label: "Not checked",
      lastSyncedAt: "",
      pendingCount: 0,
      error: ""
    };
  }

  function saveStatus(next) {
    status = Object.assign({}, status, next || {}, { pendingCount: outbox().length });
    safe(function () { localStorage.setItem(STATUS_KEY, JSON.stringify(status)); });
    applyStatus();
    return status;
  }

  function isAutomaticReason(reason) {
    return ["startup", "session-changed", "resume", "visibility"].indexOf(String(reason || "")) !== -1;
  }

  function outbox() {
    return safe(function () {
      var rows = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
      return Array.isArray(rows) ? rows : [];
    }, []);
  }

  function saveOutbox(rows) {
    safe(function () { localStorage.setItem(OUTBOX_KEY, JSON.stringify(Array.isArray(rows) ? rows : [])); });
    saveStatus({ pendingCount: outbox().length });
  }

  function accountApi() { return window.GolfDaddyAccounts || window.ClarityCaddieAccounts || null; }
  function profileApi() { return window.GolfDaddyProfiles || window.ClarityCaddieProfiles || null; }

  function currentAccount() {
    return safe(function () {
      var api = accountApi();
      return api && typeof api.current === "function" ? api.current() : null;
    }, null);
  }

  function profileFor(account) {
    return safe(function () {
      var api = profileApi();
      if (api && typeof api.active === "function") return api.active();
      var raw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
      var rows = Array.isArray(raw.profiles) ? raw.profiles : [];
      return rows.find(function (profile) { return profile && profile.id === (account && account.profileId); }) || null;
    }, null);
  }

  function payloadFor(account, reason) {
    account = account || currentAccount();
    return {
      action: "upsert_account",
      reason: reason || "sync",
      clientTime: new Date().toISOString(),
      /* When this sync was triggered by clarity:session-changed, say which
         identity fields flipped and what they flipped from and to. The
         production mystery this answers: bursts of session-changed rows every
         ~10s during play, with the payload showing a stable profile id - so the
         flapping field was invisible from the server. */
      sessionChange: safe(function () {
        var change = window.__gdLastSessionChange;
        if (!change || !change.fields || !change.fields.length) return null;
        return { fields: change.fields.slice(0, 5), reason: change.reason || "", from: change.from, to: change.to, at: change.at };
      }, null),
      account: account,
      profile: profileFor(account)
    };
  }

  /* Restore an account onto this device from Supabase, using the recovery token
     the setup/reset email link carries as proof of email ownership. Previously
     this was called in three places but never defined, so it silently no-opped
     and a coach-invited user on a new device was told their account could not be
     found. See functions/auth-restore-account.js for the security model - the
     token is the proof, never a client-supplied email. */
  function recoveryAccessToken() {
    return safe(function () {
      var hash = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
      var query = new URLSearchParams(String(location.search || ""));
      return hash.get("access_token") || query.get("access_token") || "";
    }, "");
  }

  async function restoreAccounts(reason) {
    var token = recoveryAccessToken();
    if (!token) {
      /* No token means no proof of identity. Without it we cannot safely fetch
         an account, so the caller falls back to its own "not found" message -
         the same outcome as before, but now explicit rather than a missing
         function. */
      return { accountsMerged: 0, accounts: [], reason: reason || "", restored: false, code: "no_token" };
    }
    try {
      var response = await fetch("/api/auth-restore-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token })
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.ok || !body.account) {
        var error = new Error(body.error || "Could not restore account");
        error.status = response.status;
        error.code = body.code || "";
        throw error;
      }
      /* Merge into local state without activating - the setup/reset flow finishes
         the sign-in itself once the password is set. */
      safe(function () {
        if (window.ClaritySupabaseAuth && typeof window.ClaritySupabaseAuth.commit === "function") {
          window.ClaritySupabaseAuth.commit(body, { activate: false });
        }
      });
      return { accountsMerged: 1, accounts: [body.account], account: body.account, restored: true, reason: reason || "" };
    } catch (error) {
      /* Report rather than swallow: a failed restore is invisible to the user
         beyond a generic message, and this is exactly the silent-failure class
         the audit is closing. */
      safe(function () {
        if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
          window.ClarityErrorReporter.report(
            "Account restore failed: " + (error && (error.code || error.message) || "unknown"),
            "reason=" + (reason || "") + " status=" + (error && error.status || "")
          );
        }
      });
      return { accountsMerged: 0, accounts: [], restored: false, reason: reason || "", error: error && (error.code || error.message) || "restore_failed" };
    }
  }

  async function post(payload) {
    var response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.synced === false) {
      var error = new Error(body.error || "Could not confirm account in Supabase");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function adoptCanonicalIds(result) {
    if (!result || !result.merged || !result.accountId) return;
    var oldId = result.localAccountId;
    var newId = result.accountId;
    var oldProfileId = result.localProfileId;
    var newProfileId = result.profileId;
    if (!oldId || (oldId === newId && oldProfileId === newProfileId)) return;
    safe(function () {
      var raw = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}");
      var accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      accounts.forEach(function (account) {
        if (account && account.accountId === oldId) {
          account.accountId = newId;
          if (newProfileId) account.profileId = newProfileId;
        }
      });
      if (raw.activeId === oldId) raw.activeId = newId;
      if (oldProfileId && newProfileId && raw.viewingProfileId === oldProfileId) raw.viewingProfileId = newProfileId;
      gdSafeLocalSet(ACCOUNT_KEY, JSON.stringify(raw));
      if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load();
      var profileRaw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
      var profiles = Array.isArray(profileRaw.profiles) ? profileRaw.profiles : [];
      profiles.forEach(function (profile) {
        if (!profile) return;
        if (profile.accountId === oldId) profile.accountId = newId;
        if (oldProfileId && newProfileId && profile.id === oldProfileId) profile.id = newProfileId;
      });
      if (oldProfileId && newProfileId && profileRaw.activeId === oldProfileId) profileRaw.activeId = newProfileId;
      gdSafeLocalSet(PROFILE_KEY, JSON.stringify(profileRaw));
    });
  }

  function enqueue(payload, error) {
    var status = error && error.status;
    if (status >= 400 && status < 500) return; // client errors won't succeed on retry
    var rows = outbox().filter(function (row) {
      var queued = row && row.payload;
      return !(queued && queued.action === payload.action && queued.account && payload.account && queued.account.accountId === payload.account.accountId);
    });
    rows.push({
      id: "sync_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
      payload: payload,
      attempts: 0,
      lastError: error && error.message || String(error || ""),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    saveOutbox(rows.slice(-50));
  }

  async function requireAccountSynced(account, reason) {
    var payload = payloadFor(account, reason || "required");
    if (!payload.account || !payload.account.accountId) throw new Error("No local account to sync");
    saveStatus({ state: "checking", label: "Confirming account in Supabase…", error: "" });
    try {
      var result = await post(payload);
      adoptCanonicalIds(result);
      saveStatus({ state: "synced", label: "Synced", lastSyncedAt: result.checkedAt || new Date().toISOString(), error: "" });
      return result;
    } catch (error) {
      enqueue(payload, error);
      saveStatus({
        state: isAutomaticReason(reason) ? "pending" : "blocked",
        label: isAutomaticReason(reason) ? "Pending sync" : "Supabase connection issue",
        reason: reason || "required",
        silent: isAutomaticReason(reason),
        error: error && error.message ? error.message : "Could not confirm account in Supabase"
      });
      throw error;
    }
  }

  async function syncNow(reason) {
    var account = currentAccount();
    if (!account) return saveStatus({ state: "signed_out", label: "Signed out", error: "" });
    if (pending) return status;
    pending = true;
    try {
      await requireAccountSynced(account, reason || "manual");
      await flushOutbox();
    } finally {
      pending = false;
    }
    return status;
  }

  async function flushOutbox() {
    var rows = outbox();
    if (!rows.length) return { flushed: 0 };
    saveStatus({ state: "checking", label: "Syncing pending changes…" });
    var remaining = [];
    var dropped = [];
    var flushed = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      try {
        var flushedResult = await post(row.payload);
        adoptCanonicalIds(flushedResult);
        flushed += 1;
      } catch (error) {
        var errorStatus = error && error.status;
        row.attempts = Number(row.attempts || 0) + 1;
        row.lastError = error && error.message || String(error || "");
        row.updatedAt = new Date().toISOString();
        var permanent = errorStatus >= 400 && errorStatus < 500;
        if (!permanent && row.attempts < 8) remaining.push(row);
        else dropped.push(row);
      }
    }
    saveOutbox(remaining);
    if (dropped.length) {
      // A row the server rejected with 4xx (or exhausted retries) is discarded so
      // it stops blocking the queue - but that is a real, unrecoverable loss of a
      // change the user made. Previously this still reported "Synced", so the loss
      // was invisible. Report it and refuse to claim everything is synced.
      safe(function () {
        if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
          window.ClarityErrorReporter.report(
            "Cloud sync dropped a rejected change",
            "count=" + dropped.length + " status/last=" + (dropped[0] && dropped[0].lastError || "")
          );
        }
      });
    }
    if (remaining.length) {
      saveStatus({ state: "pending", label: "Pending sync", error: remaining[0] && remaining[0].lastError || "" });
    } else if (dropped.length) {
      // Honest state: some changes could not be saved. Not "Synced".
      saveStatus({ state: "error", label: "Some changes could not be saved", error: dropped[0] && dropped[0].lastError || "" });
    } else {
      saveStatus({ state: "synced", label: "Synced", lastSyncedAt: new Date().toISOString(), error: "" });
    }
    return { flushed: flushed, pending: remaining.length, dropped: dropped.length };
  }

  function discardLocalAccount(accountId) {
    if (!accountId) return false;
    safe(function () {
      var raw = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "{}");
      var accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
      var removed = accounts.find(function (account) { return account && account.accountId === accountId; });
      raw.accounts = accounts.filter(function (account) { return !account || account.accountId !== accountId; });
      if (raw.activeId === accountId) raw.activeId = null;
      if (removed && raw.viewingProfileId === removed.profileId) raw.viewingProfileId = null;
      gdSafeLocalSet(ACCOUNT_KEY, JSON.stringify(raw));
      if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load();
      var profileRaw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
      var profiles = Array.isArray(profileRaw.profiles) ? profileRaw.profiles : [];
      profileRaw.profiles = profiles.filter(function (profile) { return !profile || profile.accountId !== accountId; });
      if (removed && profileRaw.activeId === removed.profileId) profileRaw.activeId = profileRaw.profiles[0] && profileRaw.profiles[0].id || null;
      gdSafeLocalSet(PROFILE_KEY, JSON.stringify(profileRaw));
    });
    return true;
  }

  async function diagnostics() {
    var account = currentAccount();
    var payload = {
      action: "diagnostics",
      accountId: account && account.accountId || "",
      email: account && account.email || ""
    };
    var response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "Could not load diagnostics");
    return body;
  }

  function applyStatus() {
    if (!document.body) return;
    document.body.dataset.claritySyncState = status.state || "unknown";
    document.body.dataset.claritySyncLabel = status.label || "";
    renderBadge();
    safe(function () {
      window.dispatchEvent(new CustomEvent("clarity:cloud-sync-status", { detail: status }));
    });
  }

  function renderBadge() {
    var account = currentAccount();
    var silentAutoStatus = status && status.silent && isAutomaticReason(status.reason);
    var shouldShow = account && !silentAutoStatus && status && status.state && ["blocked", "pending", "checking"].indexOf(status.state) !== -1;
    var existing = document.getElementById("clarityCloudSyncBadge");
    if (!shouldShow) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement("button");
      existing.id = "clarityCloudSyncBadge";
      existing.type = "button";
      existing.className = "clarityCloudSyncBadge";
      existing.onclick = function () { syncNow("badge-click").catch(function () {}); };
      document.body.appendChild(existing);
    }
    existing.textContent = status.state === "checking" ? "Checking Supabase…" : (status.label || "Pending sync");
    existing.title = status.error || "Tap to retry sync";
  }

  function installStyles() {
    if (document.getElementById("clarityCloudSyncStyles")) return;
    var style = document.createElement("style");
    style.id = "clarityCloudSyncStyles";
    style.textContent = [
      ".clarityCloudSyncBadge{position:fixed;left:12px;right:12px;bottom:calc(82px + env(safe-area-inset-bottom));z-index:9900;border:1px solid rgba(255,159,47,.55);background:rgba(12,18,14,.94);color:#fff;border-radius:999px;padding:10px 14px;font:800 12px/1.2 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 12px 26px rgba(0,0,0,.32)}",
      "body[data-clarity-sync-state='synced'] .clarityCloudSyncBadge{display:none}"
    ].join("\n");
    document.head.appendChild(style);
  }

  root.cloudSync = {
    status: function () { return status; },
    syncNow: syncNow,
    flushOutbox: flushOutbox,
    restoreAccounts: restoreAccounts,
    requireAccountSynced: requireAccountSynced,
    discardLocalAccount: discardLocalAccount,
    diagnostics: diagnostics,
    outbox: outbox
  };
  window.ClarityCloudSync = root.cloudSync;

  installStyles();
  applyStatus();
  window.addEventListener("online", function () { flushOutbox().catch(function () {}); });
  window.addEventListener("clarity:session-changed", function () { setTimeout(function () { syncNow("session-changed").catch(function () {}); }, 300); });
  document.addEventListener("DOMContentLoaded", function () {
    installStyles();
    applyStatus();
    setTimeout(function () { syncNow("startup").catch(function () {}); }, 600);
  });
})();
