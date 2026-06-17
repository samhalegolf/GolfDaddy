(function () {
  "use strict";

  var ACCOUNT_KEY = "gd_accounts_v1";
  var PROFILE_KEY = "gd_player_profiles_v27";
  var SESSION_KEY = "clarity:supabase-auth-session:v1";
  var INSTALLED_KEY = "__claritySupabaseAuthInstalled";
  if (window[INSTALLED_KEY]) return;
  window[INSTALLED_KEY] = true;

  function safe(fn, fallback) { try { return fn(); } catch (_e) { return fallback; } }
  function nowISO() { return new Date().toISOString(); }
  function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
  function loadJson(key, fallback) { return safe(function () { return JSON.parse(localStorage.getItem(key) || "null"); }, null) || fallback; }
  function saveJson(key, value) { safe(function () { localStorage.setItem(key, JSON.stringify(value)); }); }
  function state() { var raw = loadJson(ACCOUNT_KEY, {}); raw.accounts = Array.isArray(raw.accounts) ? raw.accounts : []; return raw; }
  function profiles() { var raw = loadJson(PROFILE_KEY, {}); raw.profiles = Array.isArray(raw.profiles) ? raw.profiles : []; return raw; }
  function role(value) { var raw = String(value || "player").toLowerCase().replace(/[\s_-]+/g, ""); return raw === "admin" ? "admin" : raw === "coach" ? "coach" : (raw === "subscribed" || raw === "subscriber" || raw === "subscribedplayer" ? "subscribedPlayer" : "player"); }
  function permission(value) { var r = role(value); if (r === "admin") return "admin"; if (r === "coach") return "coach"; return r === "subscribedPlayer" ? "subscribed" : "player"; }
  function mode(value) { var r = role(value); return r === "admin" || r === "coach" ? "coach" : "player"; }

  async function post(url, payload) {
    var response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.ok === false) {
      var error = new Error(body.error || "Supabase Auth request failed");
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function normalisePack(account, profile) {
    account = account || {};
    profile = profile || {};
    var accountId = account.accountId || account.account_id || profile.accountId || profile.account_id || ("acct_" + Date.now().toString(36));
    var profileId = account.profileId || account.profile_id || profile.id || profile.profile_id || ("profile_" + Date.now().toString(36));
    var accountRole = role(account.role || profile.accountPermission || profile.permission);
    var email = normalizeEmail(account.email || profile.email);
    var name = String(account.name || profile.name || email.split("@")[0] || "Player").trim();
    var baseAccount = Object.assign({}, account, {
      accountId: accountId,
      profileId: profileId,
      supabaseUserId: account.supabaseUserId || account.auth_user_id || profile.supabaseUserId || profile.auth_user_id || "",
      name: name,
      email: email,
      role: accountRole,
      authProvider: "supabase",
      passwordSalt: "",
      passwordHash: "",
      linkedCoachIds: Array.isArray(account.linkedCoachIds) ? account.linkedCoachIds : [],
      linkedPlayerIds: Array.isArray(account.linkedPlayerIds) ? account.linkedPlayerIds : [],
      requiresPasswordSetup: false,
      updatedAt: nowISO(),
      lastLoginAt: nowISO()
    });
    var baseProfile = Object.assign({}, profile, {
      id: profileId,
      accountId: accountId,
      supabaseUserId: baseAccount.supabaseUserId,
      name: name,
      email: email,
      permission: permission(accountRole),
      accountPermission: permission(accountRole),
      mode: mode(accountRole),
      handedness: profile.handedness || "right",
      bag: Array.isArray(profile.bag) ? profile.bag : [],
      onboardingComplete: profile.onboardingComplete !== false,
      updatedAt: nowISO()
    });
    return { account: baseAccount, profile: baseProfile };
  }

  function commit(pack, opts) {
    opts = opts || {};
    var normalized = normalisePack(pack && pack.account, pack && pack.profile);
    var s = state();
    var p = profiles();
    s.accounts = s.accounts.filter(function (item) { return item && item.accountId !== normalized.account.accountId && normalizeEmail(item.email) !== normalized.account.email; });
    s.accounts.push(normalized.account);
    p.profiles = p.profiles.filter(function (item) { return item && item.id !== normalized.profile.id && item.accountId !== normalized.account.accountId; });
    p.profiles.push(normalized.profile);
    if (opts.activate !== false) {
      s.activeId = normalized.account.accountId;
      s.viewingProfileId = normalized.account.profileId;
      p.activeId = normalized.profile.id;
      localStorage.removeItem("gd_account_signed_out_v1");
      localStorage.setItem("gd_account_keep_logged_in_v1", opts.keepLoggedIn === false ? "0" : "1");
      safe(function () { sessionStorage.setItem("gd_account_session_login_v1", "1"); });
    }
    saveJson(ACCOUNT_KEY, s);
    saveJson(PROFILE_KEY, p);
    safe(function () { if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load(); });
    safe(function () { if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.apply === "function") window.GolfDaddyAccounts.apply({ silent: true }); });
    safe(function () { if (typeof window.syncCoreProfileFromActive === "function") window.syncCoreProfileFromActive(); });
    return normalized.account;
  }

  function currentAccount() {
    return safe(function () { return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function" ? window.GolfDaddyAccounts.current() : null; }, null);
  }

  async function signup(data, opts) {
    opts = opts || {};
    var body = await post("/api/auth-signup", { name: data && data.name, email: data && data.email, password: data && data.password, role: data && data.role || "player" });
    return commit(body, { activate: opts.activate !== false, keepLoggedIn: opts.keepLoggedIn });
  }

  async function login(email, password, opts) {
    opts = opts || {};
    var body = await post("/api/auth-login", { email: email, password: password });
    if (body.session) saveJson(SESSION_KEY, Object.assign({}, body.session, { savedAt: nowISO() }));
    return commit(body, { activate: true, keepLoggedIn: opts.keepLoggedIn !== false });
  }

  async function updateAccount(data) {
    var existing = currentAccount();
    if (!existing) throw new Error("Sign in first");
    if (!existing.supabaseUserId) throw new Error("This account is not linked to Supabase Auth yet. Sign out and sign back in with Supabase Auth.");
    var body = await post("/api/auth-update-account", { supabaseUserId: existing.supabaseUserId, name: data && data.name, email: data && data.email, password: data && data.password, role: data && data.role || existing.role });
    return commit(body, { activate: true });
  }

  function parseRecoveryParams() {
    var params = new URLSearchParams(location.search || "");
    var hash = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    var accessToken = hash.get("access_token") || params.get("access_token") || "";
    var refreshToken = hash.get("refresh_token") || params.get("refresh_token") || "";
    var type = hash.get("type") || params.get("type") || "";
    var requested = params.get("claritySetPassword") === "1" || params.get("clarityResetPassword") === "1" || type === "recovery" || !!accessToken;
    return requested ? { accessToken: accessToken, refreshToken: refreshToken, type: type } : null;
  }

  async function publicAuthConfig() {
    var response = await fetch("/api/auth-public-config", { cache: "no-store" });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || !body.supabaseUrl || !body.supabaseAnonKey) throw new Error("Supabase public auth config is missing");
    return body;
  }

  async function supabaseUser(config, accessToken) {
    var response = await fetch(config.supabaseUrl.replace(/\/+$/, "") + "/auth/v1/user", {
      method: "GET",
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + accessToken }
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.message || body.error_description || "Could not verify setup link");
    return body;
  }

  async function setSupabasePassword(config, accessToken, nextPassword) {
    var response = await fetch(config.supabaseUrl.replace(/\/+$/, "") + "/auth/v1/user", {
      method: "PUT",
      headers: { apikey: config.supabaseAnonKey, Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ password: nextPassword })
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.message || body.error_description || "Could not set password");
    return body;
  }

  function clearRecoveryUrl() {
    safe(function () {
      var clean = location.origin + location.pathname;
      history.replaceState(null, document.title, clean);
    });
  }

  function showPasswordSetup() {
    var token = parseRecoveryParams();
    if (!token || !token.accessToken) return false;
    if (document.getElementById("clarityPasswordSetupOverlay")) return true;
    var overlay = document.createElement("div");
    overlay.id = "clarityPasswordSetupOverlay";
    overlay.style.cssText = "position:fixed;inset:0;z-index:999999;background:rgba(3,8,5,.92);display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#fff";
    overlay.innerHTML = [
      "<div style='width:min(420px,100%);background:#101b15;border:1px solid rgba(255,255,255,.16);border-radius:22px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.45)'>",
      "<div style='color:#42b66a;font-weight:900;letter-spacing:.12em;text-transform:uppercase;font-size:12px;margin-bottom:10px'>Clarity Caddie</div>",
      "<h1 style='font-size:28px;line-height:1.05;margin:0 0 10px'>Set your password</h1>",
      "<p style='margin:0 0 16px;color:#c8d1cc;line-height:1.4'>Create a password for this Clarity account. This setup link can only be used with the email it was sent to.</p>",
      "<input id='claritySetupPassword1' type='password' autocomplete='new-password' placeholder='New password' style='box-sizing:border-box;width:100%;margin:0 0 10px;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:#07100b;color:#fff;font-size:16px'>",
      "<input id='claritySetupPassword2' type='password' autocomplete='new-password' placeholder='Confirm password' style='box-sizing:border-box;width:100%;margin:0 0 14px;padding:14px;border-radius:14px;border:1px solid rgba(255,255,255,.18);background:#07100b;color:#fff;font-size:16px'>",
      "<button id='claritySetupPasswordSave' style='width:100%;border:0;border-radius:999px;background:#ff9f2f;color:#06110b;font-weight:900;padding:13px 16px;font-size:15px'>Save password</button>",
      "<p id='claritySetupPasswordStatus' style='min-height:20px;margin:14px 0 0;color:#c8d1cc;font-size:13px;line-height:1.35'></p>",
      "</div>"
    ].join("");
    document.body.appendChild(overlay);
    var status = document.getElementById("claritySetupPasswordStatus");
    var button = document.getElementById("claritySetupPasswordSave");
    button.onclick = async function () {
      var p1 = document.getElementById("claritySetupPassword1").value || "";
      var p2 = document.getElementById("claritySetupPassword2").value || "";
      if (p1.length < 8) { status.textContent = "Password needs at least 8 characters."; return; }
      if (p1 !== p2) { status.textContent = "Passwords do not match."; return; }
      button.disabled = true;
      status.textContent = "Saving password...";
      try {
        var config = await publicAuthConfig();
        var user = await supabaseUser(config, token.accessToken);
        var accountEmail = normalizeEmail(user && user.email || "");
        await setSupabasePassword(config, token.accessToken, p1);
        if (!accountEmail) throw new Error("Could not read account email from setup link");
        await login(accountEmail, p1, { keepLoggedIn: true });
        if (token.refreshToken) saveJson(SESSION_KEY, { access_token: token.accessToken, refresh_token: token.refreshToken, savedAt: nowISO() });
        clearRecoveryUrl();
        status.textContent = "Password saved. Opening Clarity...";
        setTimeout(function () { overlay.remove(); location.reload(); }, 600);
      } catch (error) {
        button.disabled = false;
        status.textContent = error && error.message || "Could not save password. Try the latest setup email link.";
      }
    };
    return true;
  }

  function wrap() {
    var api = window.GolfDaddyAccounts || window.ClarityCaddieAccounts;
    if (!api || api.__claritySupabaseAuthWrapped) return false;
    var oldLogout = api.logout;
    api.signup = function (data) { return signup(data, { activate: true }); };
    api.login = function (email, password, opts) { return login(email, password, opts); };
    api.update = function (data) { return updateAccount(data); };
    api.logout = function () {
      safe(function () { localStorage.removeItem(SESSION_KEY); });
      return typeof oldLogout === "function" ? oldLogout.apply(this, arguments) : null;
    };
    api.authProvider = "supabase";
    api.__claritySupabaseAuthWrapped = true;
    window.GolfDaddyAccounts = api;
    window.ClarityCaddieAccounts = api;
    return true;
  }

  window.ClaritySupabaseAuth = { signup: signup, login: login, updateAccount: updateAccount, commit: commit, wrap: wrap, showPasswordSetup: showPasswordSetup, session: function () { return loadJson(SESSION_KEY, null); } };
  document.addEventListener("DOMContentLoaded", function () { setTimeout(wrap, 0); setTimeout(wrap, 600); setTimeout(showPasswordSetup, 50); });
  setTimeout(wrap, 0);
  setTimeout(wrap, 800);
  setTimeout(showPasswordSetup, 900);
})();
