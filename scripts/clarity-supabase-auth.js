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

  window.ClaritySupabaseAuth = { signup: signup, login: login, updateAccount: updateAccount, commit: commit, wrap: wrap, session: function () { return loadJson(SESSION_KEY, null); } };
  document.addEventListener("DOMContentLoaded", function () { setTimeout(wrap, 0); setTimeout(wrap, 600); });
  setTimeout(wrap, 0);
  setTimeout(wrap, 800);
})();
