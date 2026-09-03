(function () {
  "use strict";

  var ACCOUNT_KEY = "gd_accounts_v1";
  var PROFILE_KEY = "gd_player_profiles_v27";
  var SESSION_KEY = "clarity:supabase-auth-session:v1";
  var MIN_PASSWORD_LENGTH = 8;
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

  /* `authed` sends the signed-in user's Supabase access token. Endpoints that
     create accounts or link coaches to players verify it server-side -- the
     role check in invitePlayer() below is a UI convenience and proves nothing
     on its own, since anyone can call the endpoint directly. */
  async function post(url, payload, authed) {
    var headers = { "Content-Type": "application/json" };
    if (authed) {
      var token = "";
      try { token = await freshAccessToken(); } catch (_error) { token = ""; }
      if (!token) throw new Error("Sign in again to continue");
      headers.Authorization = "Bearer " + token;
    }
    var response = await fetch(url, { method: "POST", headers: headers, body: JSON.stringify(payload || {}) });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.ok === false) {
      var error = new Error(body.error || "Sign-in request failed. Please try again.");
      error.code = body.code || "request_failed";
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  function clearStaleAuthState() {
    safe(function () { localStorage.removeItem(SESSION_KEY); });
    safe(function () { localStorage.removeItem("gd_account_signed_out_v1"); });
    safe(function () { localStorage.removeItem("gd_account_keep_logged_in_v1"); });
    safe(function () { localStorage.removeItem("gd_account_session_login_v1"); });
    safe(function () { sessionStorage.removeItem("gd_account_session_login_v1"); });
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
      gdSafeLocalSet("gd_account_keep_logged_in_v1", opts.keepLoggedIn === false ? "0" : "1");
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
    if (!existing.supabaseUserId) throw new Error("This account needs to be re-linked. Sign out and sign back in, then try again.");
    var nextPassword = String(data && data.password || "");
    /* The access token is the proof of identity - the endpoint resolves the user
       from it and refuses a request without one. Sending the account's own
       supabaseUserId alongside is a consistency check, not the credential: the
       server compares the two and rejects a mismatch.

       `role` is passed through but carries no authority: app_accounts.role is
       what grants admin, so the server honours a role only when the account is
       already an admin and otherwise keeps the stored one. The account form only
       shows the selector to admins, which is a UI nicety - the check that counts
       is the server's. */
    var token = await freshAccessToken();
    if (!token) {
      var expired = new Error("Your session has expired. Sign in again to update your account.");
      expired.code = "session_expired";
      throw expired;
    }
    var body = await post("/api/auth-update-account", { accessToken: token, supabaseUserId: existing.supabaseUserId, name: data && data.name, email: data && data.email, password: nextPassword, role: data && data.role || existing.role });
    var updated = commit(body, { activate: true });
    if (body && body.passwordUpdated && nextPassword) {
      clearStaleAuthState();
      var nextEmail = normalizeEmail(data && data.email || existing.email);
      if (!nextEmail) nextEmail = normalizeEmail(existing.email);
      try {
        return await login(nextEmail, nextPassword, { keepLoggedIn: true });
      } catch (error) {
        clearStaleAuthState();
        var message = new Error("Password changed. Please sign in again with the new password.");
        message.code = "password_changed_relogin_required";
        message.body = error && error.body || null;
        throw message;
      }
    }
    return updated;
  }

  function linkLocalCoachPlayer(coachId, player) {
    if (!coachId || !player || !player.accountId) return player;
    var s = state();
    var p = profiles();
    var coach = s.accounts.find(function (item) { return item && item.accountId === coachId; });
    var storedPlayer = s.accounts.find(function (item) { return item && item.accountId === player.accountId; });
    if (coach) {
      coach.linkedPlayerIds = Array.isArray(coach.linkedPlayerIds) ? coach.linkedPlayerIds : [];
      if (coach.linkedPlayerIds.indexOf(player.accountId) === -1) coach.linkedPlayerIds.push(player.accountId);
      coach.updatedAt = nowISO();
    }
    if (storedPlayer) {
      storedPlayer.linkedCoachIds = Array.isArray(storedPlayer.linkedCoachIds) ? storedPlayer.linkedCoachIds : [];
      if (storedPlayer.linkedCoachIds.indexOf(coachId) === -1) storedPlayer.linkedCoachIds.push(coachId);
      storedPlayer.updatedAt = nowISO();
    }
    p.profiles.forEach(function (profile) {
      if (!profile || profile.accountId !== player.accountId) return;
      profile.coachAccountIds = Array.isArray(profile.coachAccountIds) ? profile.coachAccountIds : [];
      if (profile.coachAccountIds.indexOf(coachId) === -1) profile.coachAccountIds.push(coachId);
      profile.linkedCoachIds = Array.isArray(profile.linkedCoachIds) ? profile.linkedCoachIds : [];
      if (profile.linkedCoachIds.indexOf(coachId) === -1) profile.linkedCoachIds.push(coachId);
      profile.updatedAt = nowISO();
    });
    saveJson(ACCOUNT_KEY, s);
    saveJson(PROFILE_KEY, p);
    safe(function () { if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.load === "function") window.GolfDaddyAccounts.load(); });
    safe(function () { if (window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.apply === "function") window.GolfDaddyAccounts.apply({ silent: true }); });
    return storedPlayer || player;
  }

  async function invitePlayer(data) {
    var coach = currentAccount();
    if (!coach || (role(coach.role) !== "coach" && role(coach.role) !== "admin")) throw new Error("Coach or admin account required");
    var body = await post("/api/admin-user-invite", {
      name: data && data.name,
      email: data && data.email,
      role: "player",
      actorName: coach.name || coach.email || "your coach",
      // Sent for continuity, but the server takes the actor from the token.
      actorAccountId: coach.accountId || "",
      targetAccountId: data && data.accountId || "",
      // Admin-only, re-checked server-side; the endpoint writes the entitlement and folds it
      // into the one setup email rather than sending a second one.
      compedMonth: !!(data && data.compedMonth)
    }, true);
    var player = commit(body, { activate: false });
    var linked = linkLocalCoachPlayer(coach.accountId, player);
    /* Reported back on a COPY, not on the stored account row: the comp outcome describes this
       one call, not the player, and writing it onto the persisted account would leave a stale
       "comped: true" on the row forever. The form needs it separately from the account because
       the two can succeed independently - the account is written before the entitlement is. */
    return Object.assign({}, linked, {
      comped: !!(body && body.comped),
      compError: body && body.compError || ""
    });
  }

  function parseRecoveryParams() {
    var params = new URLSearchParams(location.search || "");
    var hash = new URLSearchParams(String(location.hash || "").replace(/^#/, ""));
    var accessToken = hash.get("access_token") || params.get("access_token") || "";
    var refreshToken = hash.get("refresh_token") || params.get("refresh_token") || "";
    var type = hash.get("type") || params.get("type") || "";
    var requested = params.get("claritySetPassword") === "1" || params.get("clarityResetPassword") === "1" || params.get("clarityAccountSetup") === "1" || type === "recovery" || !!accessToken;
    return requested ? { accessToken: accessToken, refreshToken: refreshToken, type: type, raw: hash.get("error") || params.get("error") || "" } : null;
  }

  /* This config is public, per-deploy and effectively static - a Supabase URL, an
     anon key and a basemaps key. It used to be fetched fresh on every call, with
     cache:"no-store", which put a network round-trip in front of every token
     refresh. On a golf course that turned patchy signal into two visible faults:

       - doRefreshSession() below gives up when this throws and returns no token,
         so /api/payment-entitlement answered 401, clarity-payments treated that
         as "no access", and because clarity-session derives accountRole from
         payment state the resulting flip fired clarity:session-changed and its
         whole listener cascade;
       - gdLinzBasemapsKey never got published, so gd-app-core rejects every
         imagery source that requiresKey==="linzKey" and the map silently falls
         back to street tiles.

     So it is cached, in memory and in localStorage, and a cached copy is served
     without waiting for the network. A refresh still runs in the background so a
     rotated key propagates within the session; it just no longer sits on the
     critical path. Only a complete response is ever cached - a partial one would
     poison the cache with something that can never satisfy callers. */
  var AUTH_CONFIG_KEY = "clarity:auth-config:v1";
  var authConfigMemo = null;
  var authConfigRefreshing = false;

  function usableAuthConfig(body) {
    return !!(body && body.supabaseUrl && body.supabaseAnonKey);
  }

  /* The live map needs its imagery key before anyone signs in, and this is the only public
     config fetch on the boot path. Published rather than returned so the map layer does not
     have to become auth-aware to read one string. */
  function publishAuthConfigExtras(body) {
    safe(function () { if (body && body.linzBasemapsKey) window.gdLinzBasemapsKey = String(body.linzBasemapsKey); });
    safe(function () { if (body && body.esriApiKey) window.gdEsriApiKey = String(body.esriApiKey); });
  }

  async function fetchAuthConfig() {
    var response = await fetch("/api/auth-public-config");
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || !usableAuthConfig(body)) throw new Error("Sign-in is not available right now. Please try again later.");
    authConfigMemo = body;
    saveJson(AUTH_CONFIG_KEY, body);
    publishAuthConfigExtras(body);
    return body;
  }

  async function publicAuthConfig() {
    if (!usableAuthConfig(authConfigMemo)) {
      var cached = loadJson(AUTH_CONFIG_KEY, null);
      if (usableAuthConfig(cached)) authConfigMemo = cached;
    }

    if (usableAuthConfig(authConfigMemo)) {
      publishAuthConfigExtras(authConfigMemo);
      /* Serve the cache, then quietly bring it up to date. Failures here are
         ignored on purpose: the caller already has a usable config, and this is
         the exact network call whose flakiness the cache exists to absorb. */
      if (!authConfigRefreshing) {
        authConfigRefreshing = true;
        safe(function () {
          fetchAuthConfig()
            .catch(function () {})
            .then(function () { authConfigRefreshing = false; });
        });
      }
      return authConfigMemo;
    }

    /* Nothing cached - first run, or a wiped device. The network is the only
       source, so this one still has to wait, and still throws if it cannot. */
    return await fetchAuthConfig();
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

  // --- Access-token refresh -------------------------------------------------
  // Supabase access tokens expire ~hourly. Nothing used to refresh them, so the
  // stored session went stale and every JWT-gated call (the referral dashboard)
  // failed auth - which, before the backend stopped alerting on 401s, flooded
  // the admin inbox. These helpers refresh the token from the stored
  // refresh_token before it's used, and drop a dead session so the app stops
  // retrying it.

  // Decode a JWT payload without verifying (the browser has no signing secret).
  // Returns null when the token isn't a well-formed 3-segment JWT.
  function decodeJwtPayload(token) {
    var parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    return safe(function () {
      return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    }, null);
  }

  // Missing, malformed, or within 60s of expiry -> refresh before using it.
  function tokenNeedsRefresh(token) {
    var payload = decodeJwtPayload(token);
    if (!payload || !payload.exp) return true;
    return payload.exp * 1000 <= Date.now() + 60000;
  }

  var refreshInFlight = null;

  function reportAuth(message, detail) {
    safe(function () {
      if (window.ClarityErrorReporter && typeof window.ClarityErrorReporter.report === "function") {
        window.ClarityErrorReporter.report("Auth refresh: " + message, String(detail || ""));
      }
    });
  }

  async function doRefreshSession() {
    var session = loadJson(SESSION_KEY, null);
    var refreshToken = session && session.refresh_token;
    if (!refreshToken) return "";
    var config;
    try {
      config = await publicAuthConfig();
    } catch (configError) {
      // The config endpoint being unreachable is a transient failure, NOT a
      // reason to sign the user out - their token may be perfectly valid. Report
      // it (this is the CORS-block silent-failure class) and leave the session
      // intact so the next attempt can retry.
      reportAuth("config fetch failed", configError && (configError.message || configError));
      return "";
    }
    var response;
    var body;
    try {
      response = await fetch(config.supabaseUrl.replace(/\/+$/, "") + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST",
        headers: { apikey: config.supabaseAnonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      body = await response.json().catch(function () { return {}; });
    } catch (networkError) {
      // Network error reaching Supabase - transient. Keep the session.
      reportAuth("network error", networkError && (networkError.message || networkError));
      return "";
    }
    if (!response.ok || !body.access_token) {
      // Only a definitive client-side auth rejection (400/401) means the refresh
      // token is genuinely revoked or expired. A 5xx/429/408 is a transient
      // Supabase problem - deleting the session there silently logs out a valid
      // user over a blip and keeps them out after Supabase recovers.
      var tokenIsRevoked = response.status === 400 || response.status === 401;
      if (tokenIsRevoked) {
        // Clear only the Supabase session (the rest of the app's account state
        // lives elsewhere) so it stops sending a dead token and a fresh sign-in
        // can repopulate it. This is expected, so it is not reported as an error.
        safe(function () { localStorage.removeItem(SESSION_KEY); });
        return "";
      }
      // Transient server error: keep the session, report, retry next time.
      reportAuth("transient " + response.status, body && (body.error_description || body.error || body.msg));
      return "";
    }
    saveJson(SESSION_KEY, {
      access_token: body.access_token,
      refresh_token: body.refresh_token || refreshToken,
      expires_at: body.expires_at || (body.expires_in ? Math.floor(Date.now() / 1000) + Number(body.expires_in) : null),
      token_type: body.token_type || "bearer",
      savedAt: nowISO()
    });
    return body.access_token;
  }

  // De-duped so concurrent callers (e.g. several referral polls) share one
  // network round-trip instead of racing to spend the single-use refresh token.
  function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = doRefreshSession().then(function (token) {
      refreshInFlight = null;
      return token;
    }, function () {
      refreshInFlight = null;
      return "";
    });
    return refreshInFlight;
  }

  // A valid access token, refreshing first when the stored one is missing or
  // about to expire. Returns "" when there is no session or the refresh failed.
  async function freshAccessToken() {
    var session = loadJson(SESSION_KEY, null);
    var token = session && session.access_token;
    if (token && !tokenNeedsRefresh(token)) return token;
    return await refreshSession();
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
      "<div style='color:#42b66a;font-weight:900;letter-spacing:.12em;text-transform:uppercase;font-size:12px;margin-bottom:10px'>Clarity Caddy</div>",
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
      if (p1.length < MIN_PASSWORD_LENGTH) { status.textContent = "Password needs at least " + MIN_PASSWORD_LENGTH + " characters."; return; }
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
        clearRecoveryUrl();
        status.textContent = "Password saved. Opening Clarity...";
        setTimeout(function () { overlay.remove(); location.reload(); }, 600);
      } catch (error) {
        button.disabled = false;
        var message = error && error.message || "Could not save password. Try the latest setup email link.";
        if (/access token|expired|invalid|wrong|site|wrong site/i.test(message)) message = "That reset link is invalid or from the wrong site. Request a new reset email from Sign in > Forgot password.";
        status.textContent = message;
      } finally {
        clearRecoveryUrl();
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
    api.addPlayer = function (data) { return invitePlayer(data); };
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

  window.ClaritySupabaseAuth = { signup: signup, login: login, updateAccount: updateAccount, invitePlayer: invitePlayer, commit: commit, wrap: wrap, showPasswordSetup: showPasswordSetup, session: function () { return loadJson(SESSION_KEY, null); }, freshAccessToken: freshAccessToken, refreshSession: refreshSession };
  document.addEventListener("DOMContentLoaded", function () { setTimeout(wrap, 0); setTimeout(wrap, 600); setTimeout(showPasswordSetup, 50); });
  setTimeout(wrap, 0);
  setTimeout(wrap, 800);
  setTimeout(showPasswordSetup, 900);
})();
