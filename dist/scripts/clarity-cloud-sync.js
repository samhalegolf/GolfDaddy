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
      account: account,
      profile: profileFor(account)
    };
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

  function enqueue(payload, error) {
    var rows = outbox();
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
      saveStatus({ state: "synced", label: "Synced", lastSyncedAt: result.checkedAt || new Date().toISOString(), error: "" });
      return result;
    } catch (error) {
      enqueue(payload, error);
      saveStatus({
        state: "blocked",
        label: "Supabase connection issue",
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
    var flushed = 0;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      try {
        await post(row.payload);
        flushed += 1;
      } catch (error) {
        row.attempts = Number(row.attempts || 0) + 1;
        row.lastError = error && error.message || String(error || "");
        row.updatedAt = new Date().toISOString();
        remaining.push(row);
      }
    }
    saveOutbox(remaining);
    saveStatus(remaining.length ? {
      state: "pending",
      label: "Pending sync",
      error: remaining[0] && remaining[0].lastError || ""
    } : {
      state: "synced",
      label: "Synced",
      lastSyncedAt: new Date().toISOString(),
      error: ""
    });
    return { flushed: flushed, pending: remaining.length };
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
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(raw));
      if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load();
      var profileRaw = JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}");
      var profiles = Array.isArray(profileRaw.profiles) ? profileRaw.profiles : [];
      profileRaw.profiles = profiles.filter(function (profile) { return !profile || profile.accountId !== accountId; });
      if (removed && profileRaw.activeId === removed.profileId) profileRaw.activeId = profileRaw.profiles[0] && profileRaw.profiles[0].id || null;
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profileRaw));
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
    var shouldShow = account && status && status.state && ["blocked", "pending", "checking"].indexOf(status.state) !== -1;
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
