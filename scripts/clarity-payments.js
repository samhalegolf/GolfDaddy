(function () {
  "use strict";

  var CACHE_KEY = "clarity:payments:status:v1";
  var SETTINGS_KEY = "clarity:payments:settings:v1";
  var AUTH_SESSION_KEY = "clarity:supabase-auth-session:v1";
  var CHECKOUT_ENDPOINT = "/api/create-checkout-session";
  var PORTAL_ENDPOINT = "/api/create-billing-portal-session";
  var STATUS_ENDPOINT = "/api/payment-entitlement";
  var ADMIN_ENDPOINT = "/api/payment-admin";
  var REFERRAL_ENDPOINT = "/api/referrals";
  var REFERRAL_TOKEN_KEY = "clarity:referral:token:v1";
  var REFERRAL_STATE_KEY = "clarity:referrals:dashboard:v1";
  var status = loadStatus();
  var settings = loadSettings();
  var referralState = loadReferralState();
  var pending = false;
  var adminPending = false;
  var referralPending = false;
  var entitlementQueryState = { accountId: "", accountEmail: "", entitlements: [], loading: false, error: "", lastChecked: "" };
  /* The comp-access form gives its result inline, not just as a toast: a pass
     issued with a typo'd email used to fail with no visible outcome at all
     (2026-08-12 - the 400 surfaced only as an unhandled rejection in the error
     log while the admin sat wondering). Draft values survive re-renders so a
     validation failure does not eat what was typed. */
  var freePassDraft = { email: "", accountId: "", note: "" };
  var freePassFeedback = { status: "", message: "" };
  var issuedPassesState = { rows: [], loading: false, loaded: false, error: "" };
  var adminDetailsState = { diagnostics: false, advanced: false, users: false };
  var adminUsersState = { rows: [], loading: false, loaded: false, error: "", filter: "" };
  var resolverTestState = { permissionKey: "gps_live_bubble", accountId: "", accountEmail: "", profileId: "", loading: false, result: null, error: "" };
  var editingProductKey = "";
  var originalShowSection = null;
  var lastRefreshKey = "";
  var PERMISSION_KEYS = ["gps_round_start", "gps_round_pass", "gps_live_bubble", "practice_bubble_view", "my_bubble_view", "course_data_view", "course_bubble_view", "coach_admin_grant", "trial_access"];

  function safe(fn, fallback) { try { return fn(); } catch (_e) { return fallback; } }
  function escapeHTML(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function moneyText(value) { return String(value || "").trim(); }
  function isStripePriceId(value) { return /^price_[A-Za-z0-9_]+$/.test(String(value || "").trim()); }

  function account() {
    return safe(function () { return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function" ? window.GolfDaddyAccounts.current() : null; }, null);
  }

  function role(activeAccount) { return String(activeAccount && activeAccount.role || "player").trim().toLowerCase(); }
  function isStaff(activeAccount) { var current = role(activeAccount); return current === "admin" || current === "coach"; }
  function isAdmin(activeAccount) { return role(activeAccount) === "admin"; }

  function accountPayload() {
    var activeAccount = account();
    return {
      accountId: String(activeAccount && activeAccount.accountId || "").trim(),
      email: String(activeAccount && activeAccount.email || "").trim().toLowerCase(),
      name: String(activeAccount && activeAccount.name || "").trim(),
      role: String(activeAccount && activeAccount.role || "").trim()
    };
  }

  /* The admin endpoint identifies the caller from the bearer token alone. It used
     to read X-Clarity-Account-Id / X-Clarity-Account-Email instead, which meant
     anyone who knew an admin's email could send it and be treated as that admin -
     so those headers are gone rather than merely unused, to keep them from
     looking like a supported way to identify yourself.

     authedHeaders refreshes an expired token first: access tokens die roughly
     hourly, and the previous sync helper sent whatever was in storage, so an
     admin who had left the tab open got an unexplained failure. */
  async function adminHeaders(forceRefresh) {
    return await authedHeaders(forceRefresh);
  }

  function authToken() {
    return safe(function () {
      var session = window.ClaritySupabaseAuth && typeof window.ClaritySupabaseAuth.session === "function"
        ? window.ClaritySupabaseAuth.session()
        : JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null");
      return String(session && session.access_token || "").trim();
    }, "");
  }

  /* Removed 2026-07-27: requestHeaders(), which attached whatever access token
     happened to be in storage without refreshing it. Every payment call now goes
     through authedHeaders below and retries once on a 401. A helper that sends a
     possibly-expired token is not worth keeping around now that all four
     endpoints reject one. */

  // Builds the request headers, first refreshing the Supabase access token if it
  // has expired (every payment endpoint is JWT-gated, and tokens die ~hourly).
  // Falls back to whatever is stored if the auth module isn't loaded. When
  // forceRefresh is true it always exchanges the refresh token first - used to
  // retry once after a 401 in case the server rejected a token we thought was
  // still valid.
  async function authedHeaders(forceRefresh) {
    var headers = { "Content-Type": "application/json" };
    var token = "";
    try {
      var auth = window.ClaritySupabaseAuth;
      if (forceRefresh && auth && typeof auth.refreshSession === "function") {
        token = await auth.refreshSession();
      } else if (auth && typeof auth.freshAccessToken === "function") {
        token = await auth.freshAccessToken();
      } else {
        token = authToken();
      }
    } catch (_error) {
      token = authToken();
    }
    if (token) headers.Authorization = "Bearer " + token;
    return headers;
  }

  function loadStatus() { return safe(function () { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }, null) || { active: false, entitlements: [], configured: null, checkedAt: "" }; }
  function loadSettings() { return safe(function () { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); }, null) || { products: [], stripeConnected: false, webhookConfigured: false, isAdmin: false }; }
  function loadReferralState() { return safe(function () { return JSON.parse(localStorage.getItem(REFERRAL_STATE_KEY) || "null"); }, null) || { dashboard: null, shareUrl: "", error: "", lastChecked: "" }; }

  function saveStatus(next) {
    status = Object.assign({ active: false, entitlements: [] }, next || {});
    safe(function () { localStorage.setItem(CACHE_KEY, JSON.stringify(status)); });
    applyStatus(); render(); return status;
  }

  function saveSettings(next) {
    settings = Object.assign({ products: [] }, next || {});
    safe(function () { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); });
    render(); return settings;
  }

  function saveReferralState(next) {
    referralState = Object.assign({ dashboard: null, shareUrl: "", error: "", lastChecked: "" }, next || {});
    safe(function () { localStorage.setItem(REFERRAL_STATE_KEY, JSON.stringify(referralState)); });
    render(); return referralState;
  }

  /* These defaults are what a SIGNED-OUT player sees: refresh() needs a token,
     so a guest never loads the server's product rows and renders from here.
     monthly_membership used to default to active:false, which showed the
     subscription card greyed out and unbuyable as "Not active yet" - to a guest,
     and therefore to an App Store reviewer, who cannot sign in. The row in
     payment_products has been active:true throughout; the default was simply
     stale. Keep these in step with that table. */
  function products() {
    var rows = Array.isArray(settings && settings.products) ? settings.products : [];
    var defaults = {
      month_pass: { product_key: "month_pass", product_kind: "month_pass", name: "One Month Pass", description: "One payment for 30 days full access. No automatic renewal.", price_label: "One month", duration_hours: 720, billing_schedule: "one_time", active: true },
      monthly_membership: { product_key: "monthly_membership", product_kind: "membership", name: "Monthly Membership", description: "Full access with monthly renewal. Cancel anytime.", price_label: "Monthly", duration_hours: 720, billing_schedule: "monthly", active: true }
    };
    rows.forEach(function (product) {
      var key = String(product && product.product_key || "");
      if (defaults[key]) defaults[key] = Object.assign({}, defaults[key], product);
    });
    return [defaults.month_pass, defaults.monthly_membership];
  }

  function bestEntitlement() { var rows = Array.isArray(status && status.entitlements) ? status.entitlements : []; return rows[0] || null; }
  function monthPassEntitlement() {
    var rows = Array.isArray(status && status.entitlements) ? status.entitlements : [];
    return rows.filter(function (row) {
      return String(row && (row.product_key || row.entitlement_type || row.metadata && row.metadata.product_key) || "") === "month_pass";
    })[0] || null;
  }
  function referralEntitlement() {
    var rows = Array.isArray(status && status.entitlements) ? status.entitlements : [];
    return rows.filter(function (row) {
      return String(row && (row.product_key || row.entitlement_type || row.metadata && row.metadata.product_key) || "") === "referral_membership";
    })[0] || null;
  }
  function membership() { return status && status.membership || null; }
  function formatDate(value) { if (!value) return ""; var date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  /* Day only. formatDate carries the time because a Month Pass expires at an
     hour that matters to the person holding it; an invite's dates are things
     like "shared 1 Sept", where a timestamp is just noise in a list. */
  function formatDay(value) { if (!value) return ""; var date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return date.toLocaleDateString([], { day: "numeric", month: "short" }); }
  function durationLabel(hours) { var value = Number(hours); if (!Number.isFinite(value) || value <= 0) return ""; if (value % 720 === 0) return (value / 720) + " month" + (value === 720 ? "" : "s"); if (value % 24 === 0) return (value / 24) + " day" + (value === 24 ? "" : "s"); return value + " hour" + (value === 1 ? "" : "s"); }
  function daysUntil(value) { var date = value ? new Date(value).getTime() : NaN; if (!Number.isFinite(date)) return null; return Math.ceil((date - Date.now()) / (24 * 60 * 60 * 1000)); }

  /* The store's own answer for this device, held by clarity-store-billing. A
     purchase made without an account (Apple 5.1.1(v) requires that path) has no
     backend entitlement to ask about - the device entitlement IS the record
     until the player signs in and the purchase transfers to their account. */
  function storeEntitlementActive() {
    return safe(function () {
      return !!(window.ClarityStoreBilling
        && typeof window.ClarityStoreBilling.entitlementActive === "function"
        && window.ClarityStoreBilling.entitlementActive());
    }, false);
  }

  function hasActiveAccess() {
    var activeAccount = account();
    if (isStaff(activeAccount)) return true;
    if (status && status.active) return true;
    return storeEntitlementActive();
  }

  function accessLabel() {
    var activeAccount = account();
    if (isStaff(activeAccount)) return "Staff access";
    var member = membership();
    var monthPass = monthPassEntitlement();
    var referral = referralEntitlement();
    if (status && status.paymentState === "membership_active" && member) return "Membership active";
    if (status && status.paymentState === "membership_ending" && member) return "Membership cancelled";
    if (status && status.paymentState === "payment_problem_grace" && member) return "Payment problem";
    if (status && status.paymentState === "referral_access_active" && referral) return "Referral month active";
    if (status && status.paymentState === "month_pass_active" && monthPass) return "Month Pass active";
    if (status && status.paymentState === "legacy_access_active") return "Legacy paid access active";
    if (status && status.paymentState === "paid_access_expired") return "Paid access expired";
    if (storeEntitlementActive()) return activeAccount ? "Membership active" : "Membership active on this device";
    if (hasActiveAccess()) {
      var entitlement = bestEntitlement();
      if (entitlement) return "Paid access active";
    }
    if (status && status.configured === false) return "Payments not configured yet";
    return "Free access";
  }

  function accessDetail() {
    var member = membership();
    var monthPass = monthPassEntitlement();
    var referral = referralEntitlement();
    if (status && status.connectionIssue) return "Supabase could not confirm payment access. Paid features stay locked until the backend confirms the entitlement.";
    if (status && status.error) return status.error;
    if (pending) return "Checking payment status...";
    if (status && status.paymentState === "membership_active" && member) return "Renews on " + (formatDate(member.current_period_end || member.access_until) || "the next billing date") + ".";
    if (status && status.paymentState === "membership_ending" && member) return "Access continues until " + (formatDate(member.access_until || member.current_period_end) || "the paid-through date") + ".";
    if (status && status.paymentState === "payment_problem_grace" && member) return "Grace period active until " + (formatDate(member.grace_until) || "the grace-period end") + ".";
    if (status && status.paymentState === "referral_access_active" && referral) return "Your referral Membership access ends on " + (formatDate(referral.expires_at) || "the referral end date") + ".";
    if (status && status.paymentState === "month_pass_active" && monthPass) return "Access until " + (formatDate(monthPass.expires_at) || "the pass expiry date") + ".";
    if (status && status.paymentState === "legacy_access_active") return "A still-valid older pass is providing access.";
    if (status && status.paymentState === "paid_access_expired") return "Choose how you would like to continue.";
    if (!account() && storeEntitlementActive()) return "Bought on this device. Create a free account to keep score and use your membership everywhere.";
    return account() ? "Choose a pass or membership to unlock full Clarity Caddy access." : "Choose a pass or membership. No account is needed to buy.";
  }

  /* Which badge artwork matches the current paid state. Month Pass has its own
     pill; every membership-shaped state (paid, cancelled-but-active, grace,
     comped, referral, store, legacy) shows MEMBER. Null when access is not
     active - and staff deliberately get no badge, because the badge describes
     a pass someone holds, not a role. */
  function accessBadge() {
    if (!(status && status.active) && !storeEntitlementActive()) return null;
    var state = String(status.paymentState || "");
    if (state === "month_pass_active" || state === "store_month_pass_active") {
      return { src: "assets/brand/clarity-month-pass-badge.png?v=fd5af913", alt: "Month Pass" };
    }
    return { src: "assets/brand/clarity-member-badge.png?v=7d48a79a", alt: "Member" };
  }

  function accessBadgeHTML(context) {
    var badge = accessBadge();
    if (!badge) return "";
    return '<img class="clarityAccessBadge' + (context ? " clarityAccessBadge--" + escapeHTML(context) : "") + '" src="' + badge.src + '" alt="' + escapeHTML(badge.alt) + '" title="' + escapeHTML(badge.alt) + '">';
  }

  function updateHomeBadge() {
    var slot = document.getElementById("gdHomeAccessBadge");
    if (slot) slot.innerHTML = accessBadgeHTML("home");
  }

  function applyStatus() {
    if (!document.body) return;
    document.body.dataset.clarityPaidAccess = hasActiveAccess() ? "active" : "inactive";
    document.body.dataset.clarityPaymentStatus = accessLabel();
    updateHomeBadge();
    safe(function () { if (window.ClaritySession && typeof window.ClaritySession.sync === "function") window.ClaritySession.sync("payment-status"); });
    safe(function () { if (typeof window.gdRefreshPermissionChrome === "function") window.gdRefreshPermissionChrome(); });
  }

  async function refresh(opts) {
    opts = opts || {};
    /* Local signed-in gate and the de-dupe key only. The account is deliberately
       not sent: payment-entitlement reports the access of whoever the validated
       token belongs to, and used to take the account from this body with no
       authentication at all. */
    var signedIn = accountPayload();
    var checkoutSessionId = opts.sessionId || "";
    var refreshKey = [signedIn.accountId, signedIn.email, checkoutSessionId].join("|");
    /* A checkout session id alone is no longer enough to ask. It never actually
       was - the server echoed it without querying it, so a signed-out return
       from Stripe got a blank "free_access" answer - and it is now a 401. */
    if (!signedIn.accountId && !signedIn.email) return saveStatus({ active: false, entitlements: [], configured: null, message: "Sign in to check payment status" });
    if (pending && refreshKey === lastRefreshKey) return status;
    pending = true; lastRefreshKey = refreshKey; render();
    try {
      var requestBody = JSON.stringify(checkoutSessionId ? { checkoutSessionId: checkoutSessionId } : {});
      var response = await fetch(STATUS_ENDPOINT, { method: "POST", headers: await authedHeaders(false), body: requestBody });
      /* Paid features lock when this call fails, so a token that expired while
         the tab sat open must not read as "no access". Retry once refreshed. */
      if (response.status === 401) {
        response = await fetch(STATUS_ENDPOINT, { method: "POST", headers: await authedHeaders(true), body: requestBody });
      }
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Could not check payment status");
      pending = false; return saveStatus(body);
    } catch (error) {
      pending = false;
      var message = error && error.message ? error.message : "Could not check payment status";
      /* A failed request is not evidence of no entitlement, so the last
         known-good access survives it. Only the success path above may downgrade,
         because only the server knows.

         This used to force active:false and empty the entitlements on any error,
         which made a dropped request indistinguishable from a cancelled
         membership. On a golf course that is not a rare edge: every signal blip
         flipped access off and the next success flipped it back, and because
         clarity-session derives accountRole from hasActiveAccess(), each flip
         was an identity change. That fired clarity:session-changed, whose
         listeners re-run install(), acceptStoredReferral(), refresh() and
         loadReferralDashboard() here plus a full Supabase account sync in
         clarity-cloud-sync - a cascade heavy enough to be visible mid-round, and
         self-sustaining while the network stayed flaky.

         The same reasoning already guards expired tokens a few lines above. */
      saveStatus(Object.assign({}, status, { connectionIssue: true, error: message, checkedAt: new Date().toISOString() }));
      if (opts.silent || opts.auto) {
        safe(function () { console.warn("[ClarityPayments] payment status refresh skipped", message); });
      } else {
        safe(function () { return window.toast && window.toast(status.error || "Could not check payment status"); });
      }
      return status;
    }
  }

  async function loadAdminSettings() {
    var payload = accountPayload();
    if (!payload.accountId && !payload.email) return settings;
    try {
      var response = await fetch(ADMIN_ENDPOINT, { method: "GET", headers: await adminHeaders() });
      /* One retry with a force-refreshed token: the server now rejects an expired
         one, and a stale token is the likeliest cause of a 401 for a real admin. */
      if (response.status === 401) {
        response = await fetch(ADMIN_ENDPOINT, { method: "GET", headers: await adminHeaders(true) });
      }
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Could not load payment settings");
      return saveSettings(body);
    } catch (error) {
      saveSettings(Object.assign({}, settings, { settingsError: error && error.message ? error.message : "Could not load payment settings" }));
      return settings;
    }
  }

  async function adminAction(action, payload) {
    adminPending = true; render();
    try {
      var requestBody = JSON.stringify(Object.assign({ action: action }, payload || {}));
      var response = await fetch(ADMIN_ENDPOINT, { method: "POST", headers: await adminHeaders(), body: requestBody });
      if (response.status === 401) {
        response = await fetch(ADMIN_ENDPOINT, { method: "POST", headers: await adminHeaders(true), body: requestBody });
      }
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Payment setting failed");
      adminPending = false;
      if (body.products) saveSettings(body);
      safe(function () { return window.toast && window.toast(body.message || "Payment settings saved"); });
      return body;
    } catch (error) {
      adminPending = false; render();
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Payment setting failed"); });
      throw error;
    }
  }

  /* adminAction toasts on success, which is right for writes but pure noise for
     reads - loading the issued-pass list is not "Payment settings saved". */
  async function adminQuery(action, payload) {
    var requestBody = JSON.stringify(Object.assign({ action: action }, payload || {}));
    var response = await fetch(ADMIN_ENDPOINT, { method: "POST", headers: await adminHeaders(), body: requestBody });
    if (response.status === 401) {
      response = await fetch(ADMIN_ENDPOINT, { method: "POST", headers: await adminHeaders(true), body: requestBody });
    }
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(body.error || "Payment admin query failed");
    return body;
  }

  function loadIssuedPasses(opts) {
    opts = opts || {};
    if (!isAdmin(account())) return Promise.resolve();
    issuedPassesState.loading = true;
    issuedPassesState.error = "";
    if (!opts.silent) render();
    return adminQuery("listIssuedPasses", {}).then(function (body) {
      issuedPassesState = { rows: Array.isArray(body.passes) ? body.passes : [], loading: false, loaded: true, error: "" };
      render();
    }).catch(function (error) {
      issuedPassesState = { rows: issuedPassesState.rows, loading: false, loaded: true, error: error && error.message ? error.message : "Could not load issued passes" };
      render();
    });
  }

  function loadAdminUsers() {
    adminUsersState.loading = true;
    adminUsersState.error = "";
    render();
    return adminQuery("listUsers", {}).then(function (body) {
      adminUsersState = { rows: Array.isArray(body.users) ? body.users : [], loading: false, loaded: true, error: "", filter: adminUsersState.filter };
      render();
    }).catch(function (error) {
      adminUsersState = { rows: adminUsersState.rows, loading: false, loaded: true, error: error && error.message ? error.message : "Could not load users", filter: adminUsersState.filter };
      render();
    });
  }

  function filteredAdminUsers() {
    var query = String(adminUsersState.filter || "").toLowerCase();
    var rows = Array.isArray(adminUsersState.rows) ? adminUsersState.rows : [];
    if (!query) return rows;
    return rows.filter(function (row) {
      return (String(row.email || "") + " " + String(row.name || "") + " " + String(row.accountId || "") + " " + String(row.role || "") + " " + String(row.access || "")).toLowerCase().indexOf(query) !== -1;
    });
  }

  function adminUserRowHTML(row) {
    var accessLine = row.active
      ? row.access + (row.expiresAt ? " until " + (formatDate(row.expiresAt) || row.expiresAt) : " (no expiry)") + (row.paymentStatus ? " · " + row.paymentStatus : "")
      : "No active access";
    var identityLine = (row.email || row.accountId || "")
      + " · joined " + (formatDate(row.signedUpAt) || "unknown")
      + (row.memberSince ? " · member since " + (formatDate(row.memberSince) || row.memberSince) : "");
    return '<div class="gdShotAdminListRow"><strong>' + escapeHTML(row.name || row.email || row.accountId || "account") + '</strong><span>' + escapeHTML(row.role || "player") + '</span><em>' + escapeHTML(accessLine) + '</em><small>' + escapeHTML(identityLine) + '</small></div>';
  }

  function adminUserRowsHTML() {
    var rows = filteredAdminUsers();
    return rows.map(adminUserRowHTML).join("")
      || '<div class="gdShotAdminEmpty">' + (adminUsersState.loading ? "Loading users..." : adminUsersState.loaded ? "No users match." : "Open this section to load users.") + '</div>';
  }

  function renderAdminUsers() {
    var total = (adminUsersState.rows || []).length;
    var activeCount = (adminUsersState.rows || []).filter(function (row) { return row.active; }).length;
    return '<div class="clarityPaymentAdminSection">'
      + '<div class="clarityPaymentDiagGrid"><span>Total users <b>' + total + '</b></span><span>With active access <b>' + activeCount + '</b></span></div>'
      + '<form class="clarityPaymentForm" onsubmit="return false"><input name="userFilter" placeholder="Filter by email, name, role or pass type" value="' + escapeHTML(adminUsersState.filter) + '" oninput="ClarityPayments.adminUsersFilter(this.value)"></form>'
      + '<div class="clarityPaymentAdminActions"><button type="button" onclick="return ClarityPayments.reloadAdminUsers()">' + (adminUsersState.loading ? "Loading..." : "Refresh") + '</button><button type="button" onclick="return ClarityPayments.downloadAdminUsersCsv()">Download CSV</button></div>'
      + (adminUsersState.error ? '<div class="clarityPaymentStatus warning"><strong>' + escapeHTML(adminUsersState.error) + '</strong></div>' : "")
      + '<div class="gdShotAdminList" id="gdAdminUserRows">' + adminUserRowsHTML() + '</div>'
      + '</div>';
  }

  /* `payload` carries the ARGUMENTS of the action and never the caller. Since
     2026-07-27 functions/referrals.js resolves the acting member solely from the
     validated Supabase access token; account id and email in the body are
     ignored, and sending them anyway makes a deleted authentication path look
     supported. It also actively caused a bug: accountPayload() puts the user's
     own address under the key `email`, which createReferralInvite read as the
     invitee address whenever the friend-email field was left blank, so every
     untargeted invite came back addressed to the person who sent it. */
  async function referralAction(action, payload, opts) {
    opts = opts || {};
    referralPending = true; render();
    try {
      var requestBody = JSON.stringify(Object.assign({ action: action }, payload || {}));
      var response = await fetch(REFERRAL_ENDPOINT, { method: "POST", headers: await authedHeaders(false), body: requestBody });
      // A 401 means the token was stale/rejected: force one refresh and retry
      // before giving up, so a just-expired session recovers silently instead
      // of surfacing an error.
      if (response.status === 401) {
        response = await fetch(REFERRAL_ENDPOINT, { method: "POST", headers: await authedHeaders(true), body: requestBody });
      }
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Referral action failed");
      referralPending = false;
      if (body && (body.summary || body.eligibility || body.invites || body.rewards || body.invitee)) {
        saveReferralState(Object.assign({}, referralState, { dashboard: body, error: "", lastChecked: new Date().toISOString() }));
      }
      return body;
    } catch (error) {
      referralPending = false;
      saveReferralState(Object.assign({}, referralState, { error: error && error.message ? error.message : "Referral action failed", lastChecked: new Date().toISOString() }));
      if (!opts.silent) safe(function () { return window.toast && window.toast(referralState.error || "Referral action failed"); });
      throw error;
    }
  }

  async function loadReferralDashboard(opts) {
    opts = opts || {};
    /* A local "is anyone signed in" check, so a signed-out app does not fire a
       request that can only 401. It is not identity: the dashboard returned is
       whoever the access token belongs to, and the account is deliberately not
       sent - see referralAction. */
    var signedIn = accountPayload();
    if (!signedIn.accountId && !signedIn.email) return saveReferralState({ dashboard: null, shareUrl: referralState.shareUrl || "", error: "", lastChecked: "" });
    try {
      var body = await referralAction("dashboard", {}, { silent: true });
      return body;
    } catch (_error) {
      if (!opts.silent) safe(function () { return window.toast && window.toast(referralState.error || "Could not load referrals"); });
      return referralState.dashboard;
    }
  }

  /* Sends only the invite itself - who it is for, not who is sending it. This
     used to merge accountPayload() in, which put the inviter's own email under
     the key `email`; the server read that as the invitee address whenever the
     friend-email field was left blank, so untargeted invites came back
     addressed to the person who created them. The caller's identity is not
     needed here at all: since 2026-07-27 functions/referrals.js takes it solely
     from the validated Supabase token and ignores payload identity. */
  async function createReferralInvite(opts) {
    opts = opts || {};
    try {
      var body = await referralAction("createInvite", Object.assign({}, opts.payload || {}), opts);
      if (body && body.shareUrl) {
        saveReferralState(Object.assign({}, referralState, { shareUrl: body.shareUrl, error: "" }));
        if (opts.copy) await copyText(body.shareUrl);
        if (opts.share) await shareText(body.shareUrl);
      }
      await loadReferralDashboard({ silent: true });
      return body;
    } catch (_error) {
      return null;
    }
  }

  async function copyText(value) {
    var textValue = String(value || "").trim();
    if (!textValue) return false;
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(textValue);
    safe(function () { return window.toast && window.toast("Referral link copied"); });
    return true;
  }

  async function shareText(value) {
    var textValue = String(value || "").trim();
    if (!textValue) return false;
    /* navigator.share is absent on desktop browsers and has been unreliable in
       WKWebView, so copying is the fallback rather than an error. */
    if (navigator.share) {
      var sender = accountPayload().name;
      await navigator.share({
        title: "A month of Clarity Caddy",
        text: (sender ? sender + " has given you" : "You have been given") + " a free month of Clarity Caddy. No card, no automatic renewal.",
        url: textValue
      });
      return true;
    }
    return copyText(textValue);
  }

  async function acceptStoredReferral(opts) {
    opts = opts || {};
    var token = safe(function () { return localStorage.getItem(REFERRAL_TOKEN_KEY) || ""; }, "");
    if (!token || !account()) return false;
    try {
      var body = await referralAction("accept", { referralToken: token }, { silent: !!opts.silent });
      safe(function () { localStorage.removeItem(REFERRAL_TOKEN_KEY); });
      await refresh({ silent: true });
      await loadReferralDashboard({ silent: true });
      safe(function () { return window.toast && window.toast("Your free referral month is active"); });
      return body;
    } catch (_error) {
      if (referralState.error && !/sign in/i.test(referralState.error)) safe(function () { localStorage.removeItem(REFERRAL_TOKEN_KEY); });
      return false;
    }
  }

  function handleReferralRoute(params) {
    var token = params && (params.get("ref") || params.get("referral"));
    if (!token) return false;
    safe(function () { localStorage.setItem(REFERRAL_TOKEN_KEY, token); });
    fetch(REFERRAL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", referralToken: token })
    }).then(function (response) { return response.json().catch(function () { return {}; }); })
      .then(function (body) {
        if (body && body.ok) {
          saveReferralState(Object.assign({}, referralState, { invitePreview: body, error: "" }));
          if (!account()) showReferralLanding(body);
        }
      }).catch(function () {});
    acceptStoredReferral({ silent: true });
    return true;
  }

  function showReferralLanding(preview) {
    if (document.getElementById("clarityReferralLanding")) return;
    var inviter = preview && preview.invitation && preview.invitation.inviterName || "A Clarity member";
    var overlay = document.createElement("div");
    overlay.id = "clarityReferralLanding";
    overlay.className = "clarityReferralLanding";
    overlay.innerHTML = [
      '<div class="clarityReferralLandingBox">',
      '<strong>' + escapeHTML(inviter) + ' has given you a month of Clarity</strong>',
      '<span>Experience a full month of Clarity Membership.</span>',
      '<ul><li>No card required</li><li>No automatic renewal</li><li>Your access simply ends after 30 days</li><li>Choose whether to continue afterward</li></ul>',
      '<button type="button" onclick="ClarityPayments.acceptReferralLanding()">Accept free month</button>',
      '<button class="secondary" type="button" onclick="ClarityPayments.acceptReferralLanding()">Already have an account?</button>',
      '</div>'
    ].join("");
    document.body.appendChild(overlay);
  }

  function closeReferralLanding() {
    var overlay = document.getElementById("clarityReferralLanding");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  /* Store policy: a digital membership bought inside the iOS or Android app must
     go through Apple/Google billing. Sending the user to Stripe Checkout from the
     app is an in-app purchase violation on both stores, so the web checkout path
     is hard-blocked when native rather than merely hidden - render() can be
     bypassed, this cannot. Store purchases go through ClarityStoreBilling. */
  function storeBillingBlocksWebCheckout() {
    return !!(window.GDNative && window.GDNative.isNative);
  }

  /* The store's localized price for a product, from clarity-store-billing's
     cache. Empty until the offerings have loaded once - the module repaints
     this panel when they arrive. */
  function storePrice(productKey) {
    return safe(function () {
      return window.ClarityStoreBilling && typeof window.ClarityStoreBilling.price === "function"
        ? String(window.ClarityStoreBilling.price(productKey) || "")
        : "";
    }, "");
  }

  /* Store-build restore path (Apple 3.1.1): delegate to the store module, which
     restores with the store and then re-asks our backend what is entitled. */
  function restorePurchases() {
    if (!storeBillingBlocksWebCheckout()) return false;
    if (window.ClarityStoreBilling && typeof window.ClarityStoreBilling.restore === "function") {
      return window.ClarityStoreBilling.restore();
    }
    safe(function () { return window.toast && window.toast("Purchases are unavailable right now"); });
    return false;
  }

  async function buy(productKey) {
    if (storeBillingBlocksWebCheckout()) {
      if (window.ClarityStoreBilling && typeof window.ClarityStoreBilling.buy === "function") {
        return window.ClarityStoreBilling.buy(productKey);
      }
      safe(function () { return window.toast && window.toast("Purchases are unavailable right now"); });
      return false;
    }
    /* Local "is anyone signed in" check only, so a signed-out tap opens the
       profile gate instead of firing a request that can only 401. The account is
       deliberately not sent - create-checkout-session resolves the buyer with
       resolveAccount(requireAuth: true), which takes the validated token and
       never reads payload identity. */
    var signedIn = accountPayload();
    if (!signedIn.accountId && !signedIn.email) {
      safe(function () { return window.toast && window.toast("Sign in before buying access"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true; render();
    try {
      var requestBody = JSON.stringify({ productKey: productKey, passType: productKey });
      var response = await fetch(CHECKOUT_ENDPOINT, { method: "POST", headers: await authedHeaders(false), body: requestBody });
      /* Access tokens die roughly hourly and this call used to send whatever was
         in storage, so a member who had left the tab open got "Sign in before
         buying access" while looking at a signed-in screen. Retrying once with a
         force-refreshed token is safe: a 401 comes from the identity check,
         which runs before any Stripe call, so no checkout session exists yet. */
      if (response.status === 401) {
        response = await fetch(CHECKOUT_ENDPOINT, { method: "POST", headers: await authedHeaders(true), body: requestBody });
      }
      var body = await response.json().catch(function () { return {}; });
      if (body && body.existingMembership) {
        pending = false; render();
        if (body.action === "manage_membership" || body.action === "complete_payment_setup") return manageMembership();
        safe(function () { return window.toast && window.toast(body.message || "Membership already exists"); });
        return false;
      }
      if (!response.ok || !body.url) throw new Error(body.error || "Could not start checkout");
      window.location.assign(body.url);
    } catch (error) {
      pending = false; render();
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not start checkout"); });
    }
    return false;
  }

  async function manageMembership() {
    /* The Stripe billing portal is a web checkout surface, so it stays out of the
       apps for the same reason buy() does. Store-billed members manage their
       subscription in the store account that owns it; web-billed members are
       reminded by email and manage it on the website. Neither needs a link here. */
    if (storeBillingBlocksWebCheckout()) {
      safe(function () { return window.toast && window.toast("Your membership renews outside this app"); });
      return false;
    }
    /* Local signed-in check only; see buy(). create-billing-portal-session reads
       nothing from the body at all - the account comes from the token, and the
       Stripe customer from the account - so the request carries no payload. */
    var signedIn = accountPayload();
    if (!signedIn.accountId && !signedIn.email) {
      safe(function () { return window.toast && window.toast("Sign in before managing membership"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true; render();
    try {
      var requestBody = JSON.stringify({});
      var response = await fetch(PORTAL_ENDPOINT, { method: "POST", headers: await authedHeaders(false), body: requestBody });
      // Same stale-token retry as buy(); nothing has been created at this point.
      if (response.status === 401) {
        response = await fetch(PORTAL_ENDPOINT, { method: "POST", headers: await authedHeaders(true), body: requestBody });
      }
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.url) throw new Error(body.error || "Could not open membership management");
      window.location.assign(body.url);
    } catch (error) {
      pending = false; render();
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not open membership management"); });
    }
    return false;
  }

  function section() {
    var existing = document.getElementById("gdPlayerSettingsPaymentsSection");
    if (existing) return existing;
    var sheet = document.querySelector("#playerSettingsPanel .gdPlayerSettingsSheet");
    if (!sheet) return null;
    var panel = document.createElement("div");
    panel.className = "moduleCard gdPlayerSettingsSubPage";
    panel.id = "gdPlayerSettingsPaymentsSection";
    panel.hidden = true;
    panel.innerHTML = [
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(&quot;menu&quot;)">' + (account() ? "‹ Settings" : "‹ Back") + '</button>',
      "<strong>Access & Membership</strong>",
      '<span id="clarityPaymentSectionLine">Month Pass and Membership access.</span>',
      '<div class="clarityPaymentSection" id="clarityPaymentSection"></div>'
    ].join("");
    sheet.appendChild(panel);
    return panel;
  }

  function referralPage() {
    var existing = document.getElementById("gdPlayerSettingsReferralSection");
    if (existing) return existing;
    var sheet = document.querySelector("#playerSettingsPanel .gdPlayerSettingsSheet");
    if (!sheet) return null;
    var panel = document.createElement("div");
    panel.className = "moduleCard gdPlayerSettingsSubPage";
    panel.id = "gdPlayerSettingsReferralSection";
    panel.hidden = true;
    panel.innerHTML = [
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(&quot;menu&quot;)">‹ Settings</button>',
      "<strong>Invite a Golfer</strong>",
      '<span>Give a friend a month of Clarity Caddy.</span>',
      '<div class="clarityPaymentSection" id="clarityReferralSection"></div>'
    ].join("");
    sheet.appendChild(panel);
    return panel;
  }

  function installMenuRow() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list) return;
    if (!document.getElementById("gdPlayerSettingsPaymentsRow")) {
      var accountRow = Array.prototype.find.call(list.children, function (node) { return String(node && node.getAttribute && node.getAttribute("onclick") || "").indexOf("account") !== -1; });
      var row = document.createElement("button");
      row.className = "gdPlayerSettingsRow";
      row.id = "gdPlayerSettingsPaymentsRow";
      row.type = "button";
      row.onclick = function () { showSection("payments"); };
      row.innerHTML = '<div><strong>Access & Membership</strong><span id="gdPlayerSettingsPaymentsLine">Free access</span></div>';
      if (accountRow) list.insertBefore(row, accountRow); else list.appendChild(row);
    }
    syncReferralMenuRow(list);
  }

  /* Referrals are a private member benefit, so the row exists only while the
     server says this member may invite - it is not a greyed-out teaser for
     everyone else, and it disappears again if Membership lapses. Eligibility is
     the server's answer (dashboard.eligibility), never a local guess. */
  function syncReferralMenuRow(list) {
    list = list || document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list) return;
    var existing = document.getElementById("gdPlayerSettingsReferralRow");
    if (!referralEligible()) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    var row = existing;
    if (!row) {
      row = document.createElement("button");
      row.className = "gdPlayerSettingsRow";
      row.id = "gdPlayerSettingsReferralRow";
      row.type = "button";
      row.onclick = function () { showSection("referrals"); };
      row.innerHTML = '<div><strong>Invite a Golfer</strong><span id="gdPlayerSettingsReferralLine">Give a friend a month free.</span></div>';
      var paymentsRow = document.getElementById("gdPlayerSettingsPaymentsRow");
      if (paymentsRow && paymentsRow.nextSibling) list.insertBefore(row, paymentsRow.nextSibling);
      else if (paymentsRow) list.appendChild(row);
      else list.appendChild(row);
    }
    var line = document.getElementById("gdPlayerSettingsReferralLine");
    if (line) {
      var openInvites = number(referralSummary().openInvitations);
      line.textContent = openInvites
        ? openInvites + " of " + referralInviteCap() + " open invites"
        : "Give a friend a month free.";
    }
  }

  function showSection(name) {
    /* A guest is only ever in this panel for the paywall - the settings menu
       behind it is account-based and would be an empty room. So "‹ Settings"
       takes them back to the app instead of into it. */
    if (name === "menu" && !account()) {
      safe(function () { if (window.closePanel) window.closePanel("playerSettingsPanel"); });
      safe(function () { if (typeof window.showShellHome === "function") window.showShellHome(); });
      return;
    }
    if (!originalShowSection && window.gdPlayerSettingsShowSection !== showSection) originalShowSection = window.gdPlayerSettingsShowSection;
    /* The base switcher only knows its own six sections; an unknown name hides
       the menu and every page it owns, which is exactly the blank canvas both
       of ours need. */
    if (originalShowSection) originalShowSection(name);
    var panel = section();
    var invitePanel = referralPage();
    var menu = document.getElementById("gdPlayerSettingsMenu");
    if (panel) panel.hidden = name !== "payments";
    if (invitePanel) invitePanel.hidden = name !== "referrals";
    if (menu && (name === "payments" || name === "referrals")) menu.hidden = true;
    if (name === "payments") { render(); refresh({ silent: true }); loadReferralDashboard({ silent: true }); loadAdminSettings(); loadIssuedPasses({ silent: true }); }
    if (name === "referrals") { render(); loadReferralDashboard({ silent: true }); }
  }

  /* The one way in for everything that is not the settings menu: the Membership
     card, and later the contextual "enjoying Caddy?" card. Opens the panel
     first - showSection alone only toggles pages inside a sheet that may not be
     on screen. */
  function openReferrals() {
    safe(function () {
      if (typeof window.gdOpenPlayerSettingsPanel === "function") window.gdOpenPlayerSettingsPanel({});
    });
    showSection("referrals");
    return false;
  }

  /* The one way to put the paywall on screen. showSection() alone only toggles
     sections INSIDE the settings panel; if the panel is not open - and for a
     signed-out player it never is - it toggled hidden flags on a hidden sheet
     and the tap looked like nothing happened. Open the panel first, and open it
     for everyone: Apple 5.1.1(v) forbids requiring registration to reach a
     purchase, so gdOpenPlayerSettingsPanel accepts section:"payments" without
     an account. */
  function openPaywall() {
    safe(function () {
      if (typeof window.gdOpenPlayerSettingsPanel === "function") {
        window.gdOpenPlayerSettingsPanel({ section: "payments" });
      }
    });
    showSection("payments");
    return false;
  }

  function render() {
    installMenuRow();
    renderReferralPage();
    var panel = section();
    /* section() caches its markup, so the back label has to be re-synced here -
       it differs for a guest and a signed-in player, and signing in mid-panel
       must not leave "‹ Back" pointing at a menu that now exists. */
    safe(function () {
      var back = panel && panel.querySelector(".gdPlayerSettingsSubBack");
      if (back) back.textContent = account() ? "‹ Settings" : "‹ Back";
    });
    var line = document.getElementById("gdPlayerSettingsPaymentsLine");
    if (line) line.textContent = accessLabel();
    var target = document.getElementById("clarityPaymentSection");
    if (!target || !panel) return;

    var activeAccount = account();
    var statusClass = hasActiveAccess() ? "active" : status && status.configured === false ? "warning" : "";

    target.innerHTML = [
      '<div class="clarityPaymentStatus ' + statusClass + '">' + accessBadgeHTML("settings") + '<strong>' + escapeHTML(accessLabel()) + '</strong><span>' + escapeHTML(accessDetail()) + '</span></div>',
      renderExpiryBanner(),
      renderProductCards(),
      renderReferralSection(),
      /* Restore Purchases only exists on store builds: Apple rejects a
         subscription app without a visible restore path (3.1.1), and on the
         web there is nothing to restore - Stripe access follows the account. */
      '<div class="clarityPaymentActions"><button class="secondary" type="button" onclick="ClarityPayments.refreshStatusAndPrices()">Refresh Status</button>'
        + (storeBillingBlocksWebCheckout() ? '<button class="secondary" type="button" onclick="ClarityPayments.restorePurchases()">Restore Purchases</button>' : '')
        + '</div>',
      /* Store-build diagnostic, written into the page rather than a toast: a
         TestFlight device has no console, and the one time this matters is
         exactly when something is silently wrong. Shows only while prices are
         missing. */
      renderStoreDiagnostics(),
      renderStoreSubscriptionTerms(),
      renderBillingNote(),
      renderLegalLinks(),
      isAdmin(activeAccount) ? renderAdminSettings() : ""
    ].join("");
  }

  /* Who takes the money, said accurately for the surface the user is on.
     Naming Stripe inside the iOS or Android app is an in-app purchase red flag
     even though buy() already blocks the web checkout path there - a reviewer
     reads the screen, not the call graph, and "card details are handled by
     Stripe Checkout" on a store build reads as payment taken outside the store.
     Native builds therefore describe the store that actually charges them. */
  function renderBillingNote() {
    if (storeBillingBlocksWebCheckout()) {
      var store = window.GDNative && window.GDNative.platform === "android"
        ? "Google Play" : "the App Store";
      return '<div class="clarityPaymentNote">Purchases are handled by ' + store
        + '. Access unlocks once the purchase is confirmed.</div>';
    }
    return '<div class="clarityPaymentNote">Card details are handled by Stripe Checkout. Clarity unlocks access only after the Stripe webhook creates a Supabase entitlement.</div>';
  }

  function renderStoreDiagnostics() {
    if (!storeBillingBlocksWebCheckout()) return "";
    var billing = window.ClarityStoreBilling;
    if (!billing || typeof billing.diagnostics !== "function") return "";
    /* Only when something is wrong - a paywall with prices needs no caption. */
    var anyPrice = safe(function () {
      return !!(billing.price("monthly_membership") || billing.price("month_pass"));
    }, false);
    if (anyPrice) return "";
    var text = safe(function () { return String(billing.diagnostics() || ""); }, "");
    if (!text) return "";
    return '<div class="clarityPaymentNote" style="opacity:.75">Store: ' + escapeHTML(text) + '</div>';
  }

  /* Apple 3.1.2 wants both documents reachable from the purchase flow itself. */
  function renderLegalLinks() {
    if (window.ClarityLegalLinks && typeof window.ClarityLegalLinks.markup === "function") {
      return window.ClarityLegalLinks.markup();
    }
    return '<div class="clarityPaymentLegal"><a href="terms.html">Terms of Service</a> · <a href="privacy.html">Privacy Policy</a></div>';
  }

  function renderExpiryBanner() {
    var monthPass = monthPassEntitlement();
    if (status && status.paymentState === "paid_access_expired") {
      return '<div class="clarityPaymentStatus warning"><strong>Your paid access has ended.</strong><span>Choose how you would like to continue.</span></div>';
    }
    if (!monthPass || !monthPass.expires_at || status && status.paymentState !== "month_pass_active") return "";
    var days = daysUntil(monthPass.expires_at);
    if (days == null || days > 5 || days < 0) return "";
    var message = days <= 1 ? "Your Month Pass ends in 1 day." : "Your Month Pass ends in " + days + " days.";
    return '<div class="clarityPaymentStatus warning"><strong>' + escapeHTML(message) + '</strong><span>Buy another Month Pass or become a Member when you are ready.</span></div>';
  }

  function renderProductCards() {
    var member = membership();
    var hasMembership = !!(member && ["active", "trialing", "past_due", "paused", "incomplete"].indexOf(String(member.status || "").toLowerCase()) !== -1);
    var cards = products().map(function (product) {
      var key = String(product.product_key || "");
      var isMembershipProduct = key === "monthly_membership";
      var rowPriceId = String(product.stripe_price_id || "").trim();
      var rowPriceMalformed = !!(rowPriceId && !isStripePriceId(rowPriceId));
      var priceConfigured = (isMembershipProduct ? settings.monthlyMembershipPriceConfigured : settings.monthPassPriceConfigured) || isStripePriceId(rowPriceId);
      var price = rowPriceMalformed ? "Invalid Price ID" : (moneyText(product.price_label) || (priceConfigured || product.stripe_price_id ? "Configured in Stripe" : "Not linked yet"));
      var disabledReason = "";
      if (product.active === false) disabledReason = "Not active yet";
      if (storeBillingBlocksWebCheckout()) {
        /* A store build charges the store's price, so the card must quote the
           store - the Stripe label is the web price and can differ by currency
           and price tier, and "Configured in Stripe" on an iOS screen reads as
           payment taken outside the store. Stripe link problems are equally a
           web-only concern: the store path never touches a Price ID, so they
           must not disable a store card either. */
        price = storePrice(key) || "Price shown at purchase";
        /* On a store build the store is the authority on what can be sold: if
           RevenueCat returns a package, it is buyable, and buy() fails loudly if
           it is not. A stale local "active" flag must not be able to grey out a
           purchase the store would complete - that is a rejection, not a
           safeguard. */
        disabledReason = "";
      } else {
        if (rowPriceMalformed) disabledReason = "Invalid Price ID";
        if (!priceConfigured && !product.stripe_price_id) disabledReason = "Not linked yet";
      }
      var action = isMembershipProduct ? "Start Membership" : "Buy One Month";
      var onclick = 'ClarityPayments.buy(&quot;' + escapeHTML(key) + '&quot;)';
      if (isMembershipProduct && hasMembership) {
        action = member && String(member.status || "").toLowerCase() === "incomplete" ? "Complete payment setup" : "Manage Membership";
        onclick = "ClarityPayments.manageMembership()";
        disabledReason = "";
      }
      /* Apple 3.1.2(c): the billed amount must be the most conspicuous pricing
         element in the purchase flow, with the billing period stated plainly.
         The <b> price is the card's largest element (styles/clarity-payments.css)
         and carries its own period suffix so "NZ$14.99 / month" reads as one
         fact. Trial or intro wording, if ever added, goes in the small print
         BELOW the billed amount, never above or bigger. */
      var billedPeriod = isMembershipProduct ? " / month" : " one-time";
      /* Store prices arrive as a bare localized amount ("$14.99") and need the
         period stated beside them; web price labels are written with it. */
      var onStore = storeBillingBlocksWebCheckout();
      var billed = onStore && storePrice(key) ? storePrice(key) + billedPeriod : (onStore ? "" : price);
      /* No price yet - the store has not answered, or the product is not live in
         App Store Connect. Say so in SMALL print and leave the billed-amount
         slot empty rather than filling it with a placeholder: Apple 3.1.2(c)
         asks for the billed amount to be the clearest element on the card, and
         a stand-in phrase set in the price's size and colour reads as a price
         that is not one. An empty slot is honest; a fake one is a rejection. */
      var billedNote = onStore && !storePrice(key) ? "Price shown at purchase" : "";
      var lines = isMembershipProduct
        ? ["Full access", "1-month subscription, renews automatically until cancelled"]
        : ["Full access", "One payment for 30 days, does not renew"];
      return '<button class="clarityPaymentPass" type="button" ' + (disabledReason ? 'disabled title="' + escapeHTML(disabledReason) + '"' : 'onclick="' + onclick + '"') + '><strong>' + escapeHTML(product.name) + '</strong>'
        + (billed ? '<b>' + escapeHTML(billed) + '</b>' : '')
        + (billedNote ? '<i class="clarityPaymentPricePending">' + escapeHTML(billedNote) + '</i>' : '')
        + '<span>' + lines.map(escapeHTML).join(" · ") + '</span><small>' + escapeHTML(disabledReason || product.description || durationLabel(product.duration_hours)) + '</small><em>' + escapeHTML(disabledReason || action) + '</em></button>';
    }).join("");
    return '<div class="clarityPaymentPassGrid">' + cards + '</div>';
  }

  /* The written subscription terms Apple 3.1.2 requires inside the purchase
     flow: title, length, billed price, renewal behaviour, and how to cancel.
     Store builds only - the web flow states its terms on the Stripe page. */
  function renderStoreSubscriptionTerms() {
    if (!storeBillingBlocksWebCheckout()) return "";
    var store = window.GDNative && window.GDNative.platform === "android" ? "Google Play" : "App Store";
    var monthly = storePrice("monthly_membership");
    var pass = storePrice("month_pass");
    return '<div class="clarityPaymentNote">Monthly Membership is a 1-month auto-renewing subscription'
      + (monthly ? ", billed at " + escapeHTML(monthly) + " per month" : "")
      + ". It renews automatically unless cancelled in your " + store
      + " account settings at least 24 hours before the current month ends. One Month Pass is a single payment"
      + (pass ? " of " + escapeHTML(pass) : "")
      + " for 30 days of access and never renews.</div>";
  }

  /* Membership shows referrals as STATUS, not as their home.
   *
   * This used to render the whole referral dashboard - five metrics, the create
   * form and the full invite list - inside Access & Membership, which made
   * inviting a friend a sub-feature of billing and buried it behind a screen
   * members only open when something is wrong with their payment. The invite
   * flow now lives in its own settings page (renderReferralHome); what stays
   * here is the part that genuinely belongs to billing: the invitee's own free
   * month, and why an inviter's access dates may have moved. */
  function renderReferralSection() {
    var invitee = referralDashboard() && referralDashboard().invitee;
    if (!account()) return "";
    if (!referralEligible() && !invitee) return "";
    return [
      invitee ? renderInviteeReferral(invitee) : "",
      referralEligible() ? renderReferralStatusBlock() : "",
      referralState.error ? '<div class="clarityPaymentStatus warning"><strong>Referral update failed</strong><span>' + escapeHTML(referralState.error) + '</span></div>' : ""
    ].join("");
  }

  function renderReferralStatusBlock() {
    return [
      '<div class="clarityReferralPanel">',
      '<div class="clarityReferralHead"><strong>Invite a Golfer</strong><span>Give a friend a month free. If they become a member, you get a month too.</span></div>',
      renderReferralRewardLine(),
      '<div class="clarityPaymentActions"><button type="button" onclick="ClarityPayments.openReferrals()">Invite a Golfer</button></div>',
      '</div>'
    ].join("");
  }

  /* The honest version of "you get a month too".
   *
   * An earned reward is 30 days written to user_entitlements, stacked on the END
   * of existing access - it is not a discount on the next bill, and for a member
   * whose subscription is still renewing it sits behind those renewals. Say
   * "added to the end of your access", never "your next month is free". */
  function renderReferralRewardLine() {
    var summary = referralSummary();
    var earned = number(summary.freeMonthsAvailable) + number(summary.freeMonthsScheduled) + number(summary.freeMonthsApplied);
    var waiting = number(summary.pendingRewards);
    if (!earned && !waiting) return "";
    var parts = [];
    if (earned) parts.push(monthCount(earned) + " earned, added to the end of your Caddy Access");
    if (waiting) parts.push(monthCount(waiting) + " waiting to be added");
    return '<div class="clarityPaymentNote">Referral rewards: ' + escapeHTML(parts.join(". ")) + '.</div>';
  }

  function monthCount(value) {
    return value === 1 ? "1 free month" : value + " free months";
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function referralDashboard() {
    return referralState && referralState.dashboard || null;
  }

  function referralEligible() {
    var dashboard = referralDashboard();
    return !!(account() && dashboard && dashboard.eligibility && dashboard.eligibility.eligible);
  }

  function referralSummary() {
    var dashboard = referralDashboard();
    return dashboard && dashboard.summary || {};
  }

  /* The cap is the server's to state - it is enforced in referral-service.js and
     configurable per environment - so read it back rather than printing a
     literal. The UI said "10" in three places while the server allowed a
     different number. */
  function referralInviteCap() {
    var dashboard = referralDashboard();
    var summary = referralSummary();
    var max = number(summary.maxOpenInvitations) || number(dashboard && dashboard.config && dashboard.config.maxOutstandingInvites);
    return max || 5;
  }

  function renderInviteeReferral(invitee) {
    if (!invitee || !invitee.active) return "";
    var ends = invitee.freeAccessEndsAt || invitee.invitation && invitee.invitation.freeAccessEndsAt || "";
    return [
      '<div class="clarityReferralPanel invitee">',
      '<div class="clarityReferralHead"><strong>Your free month is active</strong><span>Your referral Membership access ends on ' + escapeHTML(formatDate(ends) || "the referral end date") + '.</span></div>',
      '<div class="clarityPaymentNote">Nothing will be charged. Add payment details only if you choose to continue.</div>',
      '<div class="clarityPaymentActions"><button type="button" onclick="ClarityPayments.buy(&quot;monthly_membership&quot;)">Continue after ' + escapeHTML(formatDate(ends) || "this month") + '</button><button class="secondary" type="button" onclick="ClarityPayments.buy(&quot;month_pass&quot;)">Buy Month Pass later</button></div>',
      '</div>'
    ].join("");
  }

  function renderReferralPage() {
    /* Built lazily and only for a member who has one: an ineligible player
       never gets the page, and referralPage() is not created until then. */
    if (!referralEligible() && !document.getElementById("gdPlayerSettingsReferralSection")) return;
    var page = referralPage();
    var target = document.getElementById("clarityReferralSection");
    if (!page || !target) return;
    target.innerHTML = renderReferralHome();
  }

  /* Invite a Golfer: the single source of truth for a member's referrals.
     Reached from its own Settings row and from the Membership card, never
     rendered inside the billing screen itself. */
  function renderReferralHome() {
    if (!account()) return '<div class="gdShotAdminEmpty">Sign in to invite a golfer.</div>';
    if (!referralEligible()) {
      var eligibility = referralDashboard() && referralDashboard().eligibility;
      return '<div class="clarityPaymentStatus"><strong>Invites come with Membership</strong><span>'
        + escapeHTML(eligibility && eligibility.reason || "Monthly Membership is required to invite a golfer.")
        + '</span></div>';
    }
    var cap = referralInviteCap();
    var openInvites = number(referralSummary().openInvitations);
    var full = openInvites >= cap;
    return [
      '<div class="clarityReferralPanel">',
      '<div class="clarityReferralHead"><strong>Give a friend 1 month of Clarity Caddy</strong><span>They get a full month with no card and no automatic renewal. If they become a member, you get a month too.</span></div>',
      renderReferralRewardLine(),
      full
        ? '<div class="clarityPaymentStatus warning"><strong>All ' + cap + ' invites are out</strong><span>You can send another when one is accepted, expires, or you close an unused link.</span></div>'
        : renderReferralCreateForm(),
      '</div>',
      '<div class="clarityReferralPanel">',
      '<div class="clarityReferralHead"><strong>Your invites</strong><span>' + escapeHTML(openInvites + " of " + cap + " open invites") + '</span></div>',
      renderReferralInviteList(referralDashboard() && referralDashboard().invites || []),
      '</div>',
      referralState.error ? '<div class="clarityPaymentStatus warning"><strong>Referral update failed</strong><span>' + escapeHTML(referralState.error) + '</span></div>' : ""
    ].join("");
  }

  /* Share first. The invite is a link the member sends through whatever they
     already use - Messages, WhatsApp, email - not a form where they type a
     friend's address into our app. Email stays behind a disclosure for whoever
     wants it. The name is optional and purely a label: it names the row in this
     member's own invite list and is never shown to the friend. */
  function renderReferralCreateForm() {
    return [
      '<form class="clarityReferralForm" onsubmit="return ClarityPayments.createReferralFromForm(this, &quot;share&quot;)">',
      '<input name="friendName" placeholder="Their name (optional)">',
      '<div class="clarityPaymentActions">',
      '<button type="submit">' + (referralPending ? "Creating..." : "Share Invite") + '</button>',
      '<button class="secondary" type="button" onclick="ClarityPayments.createReferralFromForm(this.form, &quot;copy&quot;)">Copy link</button>',
      '</div>',
      '<details class="clarityReferralEmail">',
      '<summary>Send it by email instead</summary>',
      '<input name="friendEmail" type="email" placeholder="Their email">',
      '<div class="clarityPaymentActions"><button class="secondary" type="button" onclick="ClarityPayments.createReferralFromForm(this.form, &quot;email&quot;)">Open email draft</button></div>',
      '</details>',
      '</form>'
    ].join("");
  }

  function renderReferralInviteList(invites) {
    var rows = (Array.isArray(invites) ? invites : []).slice(0, 12).map(function (invite) {
      var open = invite.status === "open" || invite.status === "opened";
      var title = invite.friendName || invite.inviteeEmail || "Invite";
      var status = referralStatusText(invite);
      return '<div class="clarityReferralRow"><div><strong>' + escapeHTML(title) + '</strong><span>' + escapeHTML(status.primary) + '</span><em>' + escapeHTML(status.detail) + '</em></div>' + (open ? '<button class="secondary" type="button" onclick="ClarityPayments.revokeReferralInvite(&quot;' + escapeHTML(invite.id) + '&quot;)">Close</button>' : '') + '</div>';
    }).join("");
    if (!rows) rows = '<div class="gdShotAdminEmpty">No invites yet. Share your first one above.</div>';
    return '<div class="clarityReferralList">' + rows + '</div>';
  }

  /* Nine server lifecycle states, told as the four things a member actually
     wants to know: did it go, did they join, did they stay, did I get my month.
     "Reward will apply to your next eligible bill" was also simply untrue - the
     reward is entitlement days on the end of their access, not a bill discount. */
  function referralStatusText(invite) {
    var created = formatDay(invite.createdAt) || "recently";
    if (invite.status === "open") return { primary: "Invite sent", detail: "Shared " + created };
    if (invite.status === "opened") return { primary: "Invite opened", detail: "Not claimed yet" };
    if (invite.status === "accepted" || invite.status === "free_month_active") return { primary: "Joined", detail: "Free month active until " + (formatDay(invite.freeAccessEndsAt) || "the end of their 30 days") };
    if (invite.status === "free_month_ended") return { primary: "Free month finished", detail: "Not a member yet" };
    if (invite.status === "converted") return { primary: "Became a member", detail: "Your free month is being added" };
    if (invite.status === "reward_earned") return { primary: "Became a member", detail: "✓ Your free month added" };
    if (invite.status === "revoked" || invite.status === "invalid") return { primary: "Invite closed", detail: invite.revokedReason || invite.invalidReason || "No action needed" };
    return { primary: String(invite.status || "Invite"), detail: "Shared " + created };
  }

  function renderAdminSettings() {
    var all = Array.isArray(settings.products) ? settings.products : [];
    var editingProduct = adminProductByKey(editingProductKey);
    return [
      '<div class="clarityPaymentAdmin">',
      '<div class="clarityPaymentAdminHead"><strong>Payment setup</strong><span>Products and safe live checks only. Secret keys stay in Netlify.</span></div>',
      '<div class="clarityPaymentConnectGrid">',
      statusPill('Stripe secret', settings.stripeConnected),
      statusPill('Webhook secret', settings.webhookConfigured),
      statusPill('Month Pass price', settings.monthPassPriceConfigured),
      statusPill('Membership price', settings.monthlyMembershipPriceConfigured),
      '</div>',
      settings.settingsError ? '<div class="clarityPaymentStatus warning"><strong>Settings warning</strong><span>' + escapeHTML(settings.settingsError) + '</span></div>' : '',
      '<div class="clarityPaymentAdminActions"><button type="button" onclick="ClarityPayments.reloadAdminSettings()">Reload</button><button type="button" onclick="ClarityPayments.seedDefaults()">Seed defaults</button></div>',
      '<div class="clarityPaymentProductList">' + all.map(renderAdminProduct).join("") + '</div>',
      editingProduct ? renderProductForm(editingProduct) : '<div class="clarityPaymentAdminHint">Tap Edit on a product to change its Stripe Price ID, price label, or live state.</div>',
      /* Both drawers carry their open state through re-renders. Every admin
         button (and each background refresh) rebuilds this section's HTML, and
         a bare <details> re-renders CLOSED - so clicking any button inside
         Advanced tools slammed the drawer shut and threw the admin out of the
         form they were mid-way through (2026-08-13, "every time I hit a button
         the tab hides"). */
      '<details class="clarityPaymentAdminDetails"' + (adminDetailsState.diagnostics ? " open" : "") + ' ontoggle="ClarityPayments.adminDetailsToggle(&quot;diagnostics&quot;, this.open)"><summary><strong>Diagnostics</strong><span>Webhook, portal and membership health</span></summary>' + renderAdminDiagnostics() + '</details>',
      '<details class="clarityPaymentAdminDetails"' + (adminDetailsState.users ? " open" : "") + ' ontoggle="ClarityPayments.adminDetailsToggle(&quot;users&quot;, this.open)"><summary><strong>Users</strong><span>Everyone, with membership dates and payment status</span></summary>' + renderAdminUsers() + '</details>',
      '<details class="clarityPaymentAdminDetails"' + (adminDetailsState.advanced ? " open" : "") + ' ontoggle="ClarityPayments.adminDetailsToggle(&quot;advanced&quot;, this.open)"><summary><strong>Advanced tools</strong><span>Comp access, entitlement lookup and resolver checks</span></summary>' + renderFreePassForm() + renderEntitlementViewer() + renderManualGrantForm() + renderResolverTester() + '<div class="clarityPaymentNote">Use Stripe Product/Price IDs here, never secret keys. Create the product/price in Stripe, then paste the public-looking <code>price_...</code> ID into this settings page.</div></details>',
      '</div>'
    ].join("");
  }

  function adminProductByKey(key) {
    key = String(key || "").trim();
    if (!key) return null;
    return (settings.products || []).filter(function (item) { return item.product_key === key; })[0] || null;
  }

  function renderAdminDiagnostics() {
    var failures = Array.isArray(settings.recentWebhookFailures) ? settings.recentWebhookFailures : [];
    var failureRows = failures.map(function (row) {
      return '<div class="gdShotAdminListRow"><strong>' + escapeHTML(row.event_type || "webhook") + '</strong><span>' + escapeHTML(row.stripe_event_id || "") + '</span><em>' + escapeHTML(row.error_message || "") + '</em></div>';
    }).join("") || '<div class="gdShotAdminEmpty">No recent webhook failures.</div>';
    return [
      '<div class="clarityPaymentAdminSection">',
      '<strong>Payment diagnostics</strong>',
      '<div class="clarityPaymentDiagGrid">',
      '<span>Unprocessed webhooks <b>' + escapeHTML(settings.unprocessedWebhookCount || 0) + '</b></span>',
      '<span>Past-due memberships <b>' + escapeHTML(settings.pastDueMembershipCount || 0) + '</b></span>',
      '<span>Grace periods <b>' + escapeHTML(settings.gracePeriodMembershipCount || 0) + '</b></span>',
      '</div>',
      settings.subscriptionWebhookEventsNote ? '<div class="clarityPaymentNote">' + escapeHTML(settings.subscriptionWebhookEventsNote) + '</div>' : '',
      settings.billingPortalConfiguredNote ? '<div class="clarityPaymentNote">' + escapeHTML(settings.billingPortalConfiguredNote) + '</div>' : '',
      '<div class="gdShotAdminList">' + failureRows + '</div>',
      '</div>'
    ].join("");
  }

  function renderEntitlementViewer() {
    var rows = Array.isArray(entitlementQueryState.entitlements) ? entitlementQueryState.entitlements : [];
    var rowsHTML = rows.map(function (row) {
      var hasId = !!row.id;
      var revokeButton = hasId
        ? '<button type="button" class="secondary" onclick="ClarityPayments.adminRevokeManualEntitlement(&quot;' + escapeHTML(row.id) + '&quot;)">Revoke</button>'
        : '<button type="button" class="secondary" disabled title="Load details again to capture entitlement ID">Revoke</button>';
      return '<div class="gdShotAdminListRow"><strong>' + escapeHTML(row.entitlement_type || row.product_key || "entitlement") + '</strong><span>' + escapeHTML(row.status || "unknown") + '</span><em>' + escapeHTML((formatDate(row.starts_at) || "No start") + " - " + (formatDate(row.expires_at) || "No expiry")) + '</em><small>' + escapeHTML(row.user_id || row.account_email || "") + '</small>' + revokeButton + '</div>';
    }).join("");
    if (!rowsHTML) rowsHTML = '<div class="gdShotAdminEmpty">No entitlements found.</div>';
    return [
      '<div class="clarityPaymentAdminSection">',
      '<strong>Admin entitlement viewer</strong>',
      '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.adminQueryEntitlements(this)">',
      '<input name="accountId" placeholder="Account ID">',
      '<input name="accountEmail" placeholder="Email">',
      '<div class="clarityPaymentAdminActions">',
      '<button type="submit">' + (entitlementQueryState.loading ? "Querying..." : "Load entitlements") + '</button>',
      '<button type="button" onclick="ClarityPayments.resetEntitlementQuery()">Reset</button>',
      '</div>',
      '</form>',
      entitlementQueryState.loading ? '<div class="clarityPaymentStatus">Loading entitlement data...</div>' : "",
      entitlementQueryState.error ? '<div class="clarityPaymentStatus warning"><strong>Viewer error</strong><span>' + escapeHTML(entitlementQueryState.error) + '</span></div>' : "",
      '<div class="gdShotAdminList" id="gdAdminEntitlementList">' + rowsHTML + '</div>',
      '</div>'
    ].join("");
  }

  function renderManualGrantForm() {
    var options = PERMISSION_KEYS.map(function (value) {
      return '<option value="' + escapeHTML(value) + '">' + escapeHTML(value) + '</option>';
    }).join("");
    return [
      '<div class="clarityPaymentAdminSection">',
      '<strong>Manual permission grant (skeleton)</strong>',
      '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.adminManualGrant(this)">',
      '<label><span class="gdFieldLabel">Permission</span><select name="permissionKey">' + options + '</select></label>',
      '<input name="accountId" placeholder="Account ID">',
      '<input name="accountEmail" placeholder="Email">',
      '<input name="profileId" placeholder="Profile ID">',
      '<input name="durationHours" type="number" min="1" step="1" placeholder="Hours (optional)">',
      '<textarea name="note" placeholder="Internal grant notes"></textarea>',
      '<button type="submit">Create manual grant</button>',
      '</form>',
      '</div>'
    ].join("");
  }

  function renderResolverTester() {
    var selected = escapeHTML(resolverTestState.permissionKey || PERMISSION_KEYS[0]);
    var options = PERMISSION_KEYS.map(function (value) {
      return '<option value="' + escapeHTML(value) + '"' + (value === resolverTestState.permissionKey ? ' selected' : '') + '>' + escapeHTML(value) + '</option>';
    }).join("");
    return [
      '<div class="clarityPaymentAdminSection">',
      '<strong>Resolver test panel</strong>',
      '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.adminTestResolver(this)">',
      '<label><span class="gdFieldLabel">Permission</span><select name="permissionKey">' + options + '</select></label>',
      '<input name="accountId" placeholder="Account ID">',
      '<input name="accountEmail" placeholder="Email">',
      '<input name="profileId" placeholder="Profile ID">',
      '<button type="submit">' + (resolverTestState.loading ? "Checking..." : "Run resolver") + '</button>',
      '</form>',
      resolverTestState.loading ? '<div class="clarityPaymentStatus">Running resolver check...</div>' : "",
      resolverTestState.error ? '<div class="clarityPaymentStatus warning"><strong>Resolver error</strong><span>' + escapeHTML(resolverTestState.error) + '</span></div>' : "",
      renderResolverResult(selected),
      '</div>'
    ].join("");
  }

  function renderResolverResult(permissionKey) {
    if (!resolverTestState.result) return "";
    var result = resolverTestState.result;
    var allowedClass = result.allowed ? "ok" : "bad";
    var lines = ["ok:" + (result.allowed ? " true" : " false"), "permission=" + escapeHTML(permissionKey || result.permissionKey || ""), "reasons=" + escapeHTML((Array.isArray(result.reasons) ? result.reasons.join(", ") : ""))];
    return '<div class="clarityPaymentStatus ' + allowedClass + '"><strong>Resolver result</strong><span>' + escapeHTML(lines.join(" · ")) + '</span><pre style="margin-top:8px;white-space:pre-wrap;color:#d6f4ff;font-size:12px;">' + escapeHTML(JSON.stringify(result, null, 2)) + '</pre></div>';
  }

  function statusPill(label, ok) {
    var state = ok === null || typeof ok === "undefined" ? "unknown" : ok ? "ok" : "bad";
    var mark = state === "unknown" ? "?" : ok ? "✓" : "!";
    return '<div class="clarityPaymentPill ' + state + '"><b>' + escapeHTML(mark) + '</b><span>' + escapeHTML(label) + '</span></div>';
  }

  function renderAdminProduct(product) {
    var selected = product.product_key === editingProductKey;
    var state = product.active ? "Live" : "Off";
    return '<div class="clarityPaymentProductRow' + (selected ? ' selected' : '') + '"><div><strong>' + escapeHTML(product.name) + '</strong><span>' + escapeHTML(state + ' · ' + product.product_key + ' · ' + durationLabel(product.duration_hours)) + '</span><em>' + escapeHTML(product.stripe_price_id || 'No Stripe Price ID') + '</em></div><button type="button" onclick="ClarityPayments.editProduct(&quot;' + escapeHTML(product.product_key) + '&quot;)">' + (selected ? 'Editing' : 'Edit') + '</button><button type="button" onclick="ClarityPayments.toggleProduct(&quot;' + escapeHTML(product.product_key) + '&quot;,' + (product.active ? 'false' : 'true') + ')">' + (product.active ? 'Disable' : 'Enable') + '</button></div>';
  }

  function optionHTML(value, label, current) {
    return '<option value="' + escapeHTML(value) + '"' + (value === current ? ' selected' : '') + '>' + escapeHTML(label) + '</option>';
  }

  function renderProductForm(product) {
    product = product || {};
    var kind = String(product.product_kind || "month_pass");
    return [
      '<form class="clarityPaymentForm clarityPaymentProductForm" data-clarity-product-form onsubmit="return ClarityPayments.saveProductFromForm(this)">',
      '<div class="clarityPaymentFormHead"><strong>Edit ' + escapeHTML(product.name || "product") + '</strong><button class="secondary" type="button" onclick="ClarityPayments.closeProductEditor()">Close</button></div>',
      '<input name="product_key" value="' + escapeHTML(product.product_key || "") + '" placeholder="month_pass or monthly_membership" required>',
      '<select name="product_kind">',
      optionHTML("month_pass", "Month Pass", kind),
      optionHTML("membership", "Membership", kind),
      optionHTML("free_pass", "Free pass template", kind),
      optionHTML("day_pass", "Legacy day pass", kind),
      optionHTML("round_pass", "Legacy round pass", kind),
      '</select>',
      '<input name="name" value="' + escapeHTML(product.name || "") + '" placeholder="Name shown in app" required>',
      '<input name="price_label" value="' + escapeHTML(product.price_label || "") + '" placeholder="Price label e.g. NZ$7.99 / month">',
      '<input name="stripe_price_id" value="' + escapeHTML(product.stripe_price_id || "") + '" placeholder="Stripe Price ID e.g. price_...">',
      '<input name="stripe_product_id" value="' + escapeHTML(product.stripe_product_id || "") + '" placeholder="Stripe Product ID e.g. prod_...">',
      '<input name="duration_hours" type="number" min="1" step="1" value="' + escapeHTML(product.duration_hours || 720) + '" placeholder="Duration hours">',
      '<input name="billing_schedule" value="' + escapeHTML(product.billing_schedule || "one_time") + '" placeholder="one_time / monthly">',
      '<textarea name="description" placeholder="Description">' + escapeHTML(product.description || "") + '</textarea>',
      '<label><input type="checkbox" name="active"' + (product.active !== false ? ' checked' : '') + '> Active</label>',
      '<button type="submit">' + (adminPending ? "Saving..." : "Save product") + '</button>',
      '</form>'
    ].join("");
  }

  function renderFreePassForm() {
    var draft = freePassDraft;
    var feedback = "";
    if (freePassFeedback.message) {
      var feedbackClass = freePassFeedback.status === "ok" ? "active" : freePassFeedback.status === "error" ? "warning" : "";
      feedback = '<div class="clarityPaymentStatus ' + feedbackClass + '"><strong>' + escapeHTML(freePassFeedback.message) + '</strong></div>';
    }
    return '<div class="clarityPaymentAdminSection">'
      + '<strong>Issue comped access</strong>'
      + '<form class="clarityPaymentForm" oninput="ClarityPayments.freePassDraftUpdate(event.target)" onsubmit="return ClarityPayments.issueFreePassFromForm(this)">'
      + '<label><span class="gdFieldLabel">Player email</span><input name="email" placeholder="name@example.com" value="' + escapeHTML(draft.email) + '"></label>'
      + '<label><span class="gdFieldLabel">Or account ID</span><input name="accountId" placeholder="acct_..." value="' + escapeHTML(draft.accountId) + '"></label>'
      + '<select name="productKey"><option value="admin_comped_membership" selected>Comped Membership month</option><option value="free_pass">Promotional free pass</option></select>'
      + '<input name="durationHours" type="number" min="1" step="1" value="720">'
      + '<label><input type="checkbox" name="allowMemberReferrals" checked> Allow member referrals</label>'
      + '<label><input type="checkbox" name="sendEmail" checked> Email them about it (new players get a set-password link)</label>'
      + '<textarea name="note" placeholder="Internal note">' + escapeHTML(draft.note) + '</textarea>'
      + '<button type="submit">' + (adminPending ? "Issuing..." : "Issue comped access") + '</button>'
      + '</form>'
      + feedback
      + renderIssuedPassesList()
      + '</div>';
  }

  function renderIssuedPassesList() {
    var rows = Array.isArray(issuedPassesState.rows) ? issuedPassesState.rows : [];
    var rowsHTML = rows.map(function (row) {
      var target = row.account_email || row.user_id || "unknown account";
      var kindLabel = row.product_key || row.entitlement_type || "pass";
      var isActive = String(row.status || "") === "active";
      var isExpired = row.expires_at && new Date(row.expires_at).getTime() < Date.now();
      var stateLabel = !isActive ? (row.status || "inactive") : isExpired ? "expired" : "active";
      var revoke = isActive && !isExpired && row.id
        ? '<button type="button" class="secondary" onclick="return ClarityPayments.adminRevokeIssuedPass(&quot;' + escapeHTML(row.id) + '&quot;)">Revoke</button>'
        : "";
      return '<div class="gdShotAdminListRow"><strong>' + escapeHTML(kindLabel) + '</strong><span>' + escapeHTML(stateLabel) + '</span><em>' + escapeHTML((formatDate(row.starts_at) || "No start") + " - " + (formatDate(row.expires_at) || "No expiry")) + '</em><small>' + escapeHTML(target) + '</small>' + revoke + '</div>';
    }).join("");
    if (!rowsHTML) rowsHTML = '<div class="gdShotAdminEmpty">' + (issuedPassesState.loading ? "Loading issued passes..." : issuedPassesState.loaded ? "No comped passes issued yet." : "List not loaded yet.") + '</div>';
    return '<div class="clarityPaymentAdminSection">'
      + '<strong>Issued passes</strong>'
      + '<div class="clarityPaymentAdminActions"><button type="button" onclick="return ClarityPayments.reloadIssuedPasses()">' + (issuedPassesState.loading ? "Loading..." : "Refresh list") + '</button></div>'
      + (issuedPassesState.error ? '<div class="clarityPaymentStatus warning"><strong>List error</strong><span>' + escapeHTML(issuedPassesState.error) + '</span></div>' : "")
      + '<div class="gdShotAdminList">' + rowsHTML + '</div>'
      + '</div>';
  }

  /* new FormData(form).entries() returns an ITERATOR, and Array.prototype.forEach
     iterates by .length - which an iterator does not have - so the previous
     Array.prototype.forEach.call(...entries()...) looped zero times and every
     form that used this helper submitted an EMPTY payload no matter what was
     typed (found 2026-08-13: comped-pass form kept reporting "email required"
     for a filled-in field). FormData's own forEach actually iterates. */
  function formData(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    data.active = !!form.elements.active && form.elements.active.checked;
    return data;
  }

  function formElement(form, name) {
    return form && form.elements ? form.elements[name] : null;
  }

  function formValue(form, name, fallback) {
    var element = formElement(form, name);
    if (!element) return fallback == null ? "" : fallback;
    return element.value == null ? "" : String(element.value);
  }

  function productFormData(form) {
    form = form && form.form ? form.form : form;
    var fallback = adminProductByKey(editingProductKey) || {};
    var productKey = String(formValue(form, "product_key", fallback.product_key || editingProductKey || "")).trim();
    var productKind = String(formValue(form, "product_kind", fallback.product_kind || (productKey === "monthly_membership" ? "membership" : "month_pass"))).trim();
    return {
      product_key: productKey,
      product_kind: productKind,
      name: String(formValue(form, "name", fallback.name || productKey.replace(/_/g, " "))).trim(),
      description: formValue(form, "description", fallback.description || ""),
      stripe_product_id: String(formValue(form, "stripe_product_id", fallback.stripe_product_id || "")).trim(),
      stripe_price_id: String(formValue(form, "stripe_price_id", fallback.stripe_price_id || "")).trim(),
      price_label: String(formValue(form, "price_label", fallback.price_label || "")).trim(),
      duration_hours: String(formValue(form, "duration_hours", fallback.duration_hours || 720)).trim(),
      billing_schedule: String(formValue(form, "billing_schedule", fallback.billing_schedule || (productKind === "membership" ? "monthly" : "one_time"))).trim(),
      active: formElement(form, "active") ? !!form.elements.active.checked : fallback.active !== false,
      colour: fallback.colour || "",
      sort_order: fallback.sort_order || 100,
      metadata: fallback.metadata || {}
    };
  }

  function updateAdminQueryState(next) {
    entitlementQueryState = Object.assign({}, entitlementQueryState, next || {});
    render();
  }

  function updateResolverTestState(next) {
    resolverTestState = Object.assign({}, resolverTestState, next || {});
    render();
  }

  function install() {
    installMenuRow(); section();
    if (window.gdPlayerSettingsShowSection !== showSection) { originalShowSection = window.gdPlayerSettingsShowSection; window.gdPlayerSettingsShowSection = showSection; }
    render(); applyStatus();
  }

  function handleReturn() {
    var params = safe(function () { return new URLSearchParams(window.location.search || ""); }, null);
    if (!params) return;
    var handledReferral = handleReferralRoute(params);
    var payment = params.get("payment"); var sessionId = params.get("session_id");
    if (payment === "success" && sessionId) refresh({ sessionId: sessionId }).then(function () { safe(function () { return window.toast && window.toast(hasActiveAccess() ? "Pass active" : "Payment received. Access is updating."); }); });
    if (payment === "cancelled") safe(function () { return window.toast && window.toast("Checkout cancelled"); });
    if (payment === "portal_return") refresh({ silent: true }).then(function () { safe(function () { return window.toast && window.toast("Membership settings updated"); }); });
    /* app/js/access.js sends a rangefinder-only player here when they reach for
       something a membership covers. Without this the "Membership" button would
       drop them on the home screen to go and find it themselves. */
    var membership = params.get("membership") === "1";
    if (membership) safe(function () { return openPaywall(); });
    if (payment || membership || handledReferral) safe(function () { var clean = window.location.pathname + window.location.hash; window.history.replaceState({}, document.title, clean || "/"); });
  }

  window.ClarityPayments = {
    buy: buy,
    manageMembership: manageMembership,
    restorePurchases: restorePurchases,
    refresh: refresh,
    render: render,
    status: function () { return status; },
    settings: function () { return settings; },
    hasActiveAccess: hasActiveAccess,
    accessLabel: accessLabel,
    accessBadgeHTML: accessBadgeHTML,
    showSettings: openPaywall,
    openPaywall: openPaywall,
    openReferrals: openReferrals,
    /* Refresh Status on a store build also re-asks the store for prices, and
       reports what it got. There is no console on a TestFlight device, so
       without this a paywall with no prices is a dead end to diagnose - the
       cause could be the Paid Apps Agreement, products not yet Ready to Submit,
       or an offering that does not contain them, and they look identical. */
    refreshStatusAndPrices: function () {
      refresh();
      if (!storeBillingBlocksWebCheckout()) return false;
      safe(function () {
        var billing = window.ClarityStoreBilling;
        if (!billing) return;
        Promise.resolve(billing.reloadPrices && billing.reloadPrices()).then(function () {
          render();
          safe(function () {
            if (window.toast && typeof billing.diagnostics === "function") window.toast(billing.diagnostics());
          });
        });
      });
      return false;
    },
    /* The one membership question for every member-only action. True means
       carry on; false means the membership panel is now open and the caller
       should stop.
       The line it enforces: the bubble and the ghost bag behind it are FREE -
       what costs is making them yours. Setting your own club distances, and
       adopting a bubble out of your own practice or course data, are the two
       ways to do that, so they are the two things that ask. */
    requireAccess: function (what) {
      if (hasActiveAccess()) return true;
      safe(function () { return window.toast && window.toast("A Clarity membership is needed to " + what + "."); });
      openPaywall();
      return false;
    },
    reloadAdminSettings: loadAdminSettings,
    seedDefaults: function () { return adminAction("seedDefaults", {}); },
    toggleProduct: function (key, active) { return adminAction("setProductActive", { productKey: key, active: !!active }); },
    editProduct: function (key) {
      if (!adminProductByKey(key)) return false;
      editingProductKey = key;
      render();
      safe(function () {
        var form = document.querySelector("[data-clarity-product-form]");
        if (form && typeof form.scrollIntoView === "function") form.scrollIntoView({ block: "nearest", behavior: "smooth" });
        if (form && form.elements.stripe_price_id) form.elements.stripe_price_id.focus();
      });
      return false;
    },
    closeProductEditor: function () { editingProductKey = ""; render(); return false; },
    saveProductFromForm: function (form) { var data = productFormData(form); editingProductKey = data.product_key || editingProductKey; adminAction("upsertProduct", { product: data }); return false; },
    issueFreePassFromForm: function (form) {
      var data = formData(form);
      var emailValue = String(data.email || "").trim();
      var accountIdValue = String(data.accountId || "").trim();
      freePassDraft = { email: emailValue, accountId: accountIdValue, note: String(data.note || "") };
      /* Validate here so a bad email is caught while the admin is still looking
         at the form, with the offending value shown back. The server rejects
         these too, but its 400 used to surface as nothing at all. */
      if (!emailValue && !accountIdValue) {
        freePassFeedback = { status: "error", message: "Enter the player's email (or account ID) first. Nothing was issued." };
        render();
        return false;
      }
      if (emailValue && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
        freePassFeedback = { status: "error", message: 'That email does not look right: "' + emailValue + '". Type it plainly, like name@example.com. Nothing was issued.' };
        render();
        return false;
      }
      data.email = emailValue;
      /* Explicit true/false: an unticked checkbox is simply ABSENT from
         FormData, and the server defaults a missing sendEmail to true - so
         without this an untick would still email the player. */
      data.sendEmail = form.elements.sendEmail && form.elements.sendEmail.checked ? "true" : "false";
      freePassFeedback = { status: "pending", message: "Issuing..." };
      adminAction("issueFreePass", data).then(function (body) {
        var emailNote = body && body.emailStatus === "sent" ? " Notification email sent."
          : body && body.emailStatus === "failed" ? " The pass is live, but the notification email failed to send."
          : "";
        freePassDraft = { email: "", accountId: "", note: "" };
        freePassFeedback = { status: "ok", message: "Pass issued to " + (emailValue || accountIdValue) + "." + emailNote + " It appears in the list below." };
        render();
        loadIssuedPasses({ silent: true });
        refresh({ silent: true });
      }).catch(function (error) {
        freePassFeedback = { status: "error", message: (error && error.message ? error.message : "Issuing failed") + " Nothing was issued." };
        render();
      });
      return false;
    },
    adminDetailsToggle: function (key, open) {
      if (adminDetailsState.hasOwnProperty(key)) adminDetailsState[key] = !!open;
      /* The user list is the one drawer with a real query behind it - load it
         the first time it is opened rather than on every panel visit. */
      if (key === "users" && open && !adminUsersState.loaded && !adminUsersState.loading) loadAdminUsers();
    },
    reloadAdminUsers: function () { loadAdminUsers(); return false; },
    adminUsersFilter: function (value) {
      adminUsersState.filter = String(value == null ? "" : value);
      /* Patch only the list rows - a full render() would rebuild the input
         mid-keystroke and throw the cursor out of it. */
      var list = document.getElementById("gdAdminUserRows");
      if (list) list.innerHTML = adminUserRowsHTML();
    },
    downloadAdminUsersCsv: function () {
      var rows = filteredAdminUsers();
      var head = ["email", "name", "role", "account_id", "signed_up", "last_login", "access", "active", "member_since", "expires", "payment_status", "stripe_customer"];
      var csv = [head.join(",")].concat(rows.map(function (row) {
        return [row.email, row.name, row.role, row.accountId, row.signedUpAt, row.lastLoginAt, row.access, row.active ? "yes" : "no", row.memberSince || "", row.expiresAt || "", row.paymentStatus || "", row.stripeCustomer ? "yes" : "no"].map(function (cell) {
          cell = String(cell == null ? "" : cell);
          return /[",\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
        }).join(",");
      })).join("\n");
      var blob = new Blob([csv], { type: "text/csv" });
      var link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "clarity-users.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 5000);
      return false;
    },
    freePassDraftUpdate: function (input) {
      if (!input || !input.name) return;
      if (input.name === "email") freePassDraft.email = input.value;
      if (input.name === "accountId") freePassDraft.accountId = input.value;
      if (input.name === "note") freePassDraft.note = input.value;
    },
    reloadIssuedPasses: function () { loadIssuedPasses({ silent: false }); return false; },
    adminRevokeIssuedPass: function (entitlementId) {
      if (!entitlementId) return false;
      adminAction("manualRevokePermission", { entitlementId: entitlementId }).then(function () {
        loadIssuedPasses({ silent: true });
        refresh({ silent: true });
      }).catch(function () { loadIssuedPasses({ silent: true }); });
      return false;
    },
    createReferralFromForm: function (form, mode) {
      var data = form ? formData(form) : {};
      createReferralInvite({ copy: mode === "copy", share: mode === "share", payload: data }).then(function (body) {
        if (!body || !body.shareUrl) return;
        if (mode === "email") {
          var subject = encodeURIComponent("A free month of Clarity Membership");
          var sender = accountPayload().name || "A Clarity member";
          var message = sender + " has given you a month of Clarity. Experience a full month of Clarity Membership with no card and no automatic renewal: " + body.shareUrl;
          var to = encodeURIComponent(data.friendEmail || "");
          window.location.href = "mailto:" + to + "?subject=" + subject + "&body=" + encodeURIComponent(message);
        }
        if (form) form.reset();
      });
      return false;
    },
    revokeReferralInvite: function (id) {
      if (!id) return false;
      referralAction("revokeInvite", { referralId: id, reason: "revoked_by_member" })
        .then(function () {
          safe(function () { return window.toast && window.toast("Referral link revoked"); });
          loadReferralDashboard({ silent: true });
        });
      return false;
    },
    reloadReferralDashboard: function () { return loadReferralDashboard({ silent: false }); },
    acceptReferralLanding: function () {
      closeReferralLanding();
      if (account()) acceptStoredReferral({ silent: false });
      else safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67({ authGate: true }); });
      return false;
    },
    adminQueryEntitlements: function (form) {
      var data = formData(form);
      entitlementQueryState = Object.assign({}, entitlementQueryState, {
        accountId: data.accountId || "",
        accountEmail: data.accountEmail || "",
        lastChecked: "",
        loading: true,
        error: "",
        entitlements: []
      });
      updateAdminQueryState({ loading: true, error: "", entitlements: [] });
      adminAction("queryEntitlements", data)
        .then(function (response) {
          updateAdminQueryState({ loading: false, entitlements: (response && response.entitlements) || [], lastChecked: new Date().toISOString(), error: response && response.error ? response.error : "" });
        })
        .catch(function (error) {
          updateAdminQueryState({ loading: false, error: error && error.message ? error.message : "Query failed" });
        });
      return false;
    },
    resetEntitlementQuery: function () { updateAdminQueryState({ accountId: "", accountEmail: "", entitlements: [], error: "", lastChecked: "" }); return false; },
    adminManualGrant: function (form) {
      var data = formData(form);
      if (!data.accountId && !data.accountEmail) {
        safe(function () { return window.toast && window.toast("Account ID or email is required"); });
        return false;
      }
      if (!data.permissionKey) {
        safe(function () { return window.toast && window.toast("Permission key is required"); });
        return false;
      }
      adminAction("manualGrantPermission", data).then(function () {
        form.reset();
        if (entitlementQueryState.accountId || entitlementQueryState.accountEmail) {
          adminAction("queryEntitlements", {
            accountId: entitlementQueryState.accountId || data.accountId,
            accountEmail: entitlementQueryState.accountEmail || data.accountEmail
          }).then(function (response) {
            updateAdminQueryState({ entitlements: (response && response.entitlements) || [], lastChecked: new Date().toISOString() });
          }).catch(function () {});
        }
        loadIssuedPasses({ silent: true });
      }).catch(function () {});
      return false;
    },
    adminRevokeManualEntitlement: function (entitlementId) {
      if (!entitlementId) {
        safe(function () { return window.toast && window.toast("entitlementId required"); });
        return false;
      }
      adminAction("manualRevokePermission", { entitlementId: entitlementId }).then(function () {
        if (entitlementQueryState.accountId || entitlementQueryState.accountEmail) {
          adminAction("queryEntitlements", {
            accountId: entitlementQueryState.accountId,
            accountEmail: entitlementQueryState.accountEmail
          }).then(function (response) {
            updateAdminQueryState({ entitlements: (response && response.entitlements) || [], lastChecked: new Date().toISOString() });
          }).catch(function () {});
        }
        loadIssuedPasses({ silent: true });
      }).catch(function () {});
      return false;
    },
    adminTestResolver: function (form) {
      var data = formData(form);
      updateResolverTestState({
        loading: true,
        error: "",
        permissionKey: String(data.permissionKey || PERMISSION_KEYS[0]),
        accountId: String(data.accountId || ""),
        accountEmail: String(data.accountEmail || ""),
        profileId: String(data.profileId || "")
      });
      var permissionKey = String(data.permissionKey || PERMISSION_KEYS[0]).trim();
      var resolveResult = window.ClarityPermissions && typeof window.ClarityPermissions.canUse === "function"
        ? window.ClarityPermissions.canUse(permissionKey, { route: "admin_resolver_test", scope: "permission" }, data.accountId, data.accountEmail, data.profileId)
        : Promise.resolve({
          ok: false,
          allowed: false,
          permissionKey: permissionKey,
          reasons: ["PERMISSIONS_HELPER_MISSING"],
          entitlement: null,
          raw: null,
          error: "ClarityPermissions unavailable"
        });
      resolveResult.then(function (result) {
        updateResolverTestState({
          loading: false,
          result: result || null,
          error: result && result.error ? result.error : ""
        });
      }).catch(function (error) {
        updateResolverTestState({ loading: false, result: null, error: error && error.message ? error.message : "Resolver request failed" });
      });
      return false;
    }
  };

  document.addEventListener("DOMContentLoaded", function () { setTimeout(function () { install(); handleReturn(); refresh({ silent: true, auto: true }); loadReferralDashboard({ silent: true }); }, 150); });
  window.addEventListener("clarity:session-changed", function (event) {
    /* Only re-run the full payment pipeline when WHO is signed in changed.
       accountRole is partly derived from this module's own status (player ->
       subscribedPlayer), so refreshing on a role-only change is the feedback
       edge of a loop: refresh -> applyStatus -> ClaritySession.sync ->
       session-changed -> refresh. And viewedProfileId is a coach flipping
       between players, which does not alter whose entitlement this is.
       Events without changedFields (older dispatchers) keep the old behaviour. */
    var fields = event && event.detail && Array.isArray(event.detail.changedFields) ? event.detail.changedFields : null;
    var identityChanged = !fields || fields.indexOf("accountId") !== -1 || fields.indexOf("isSignedIn") !== -1;
    setTimeout(function () {
      install();
      if (!identityChanged) return;
      acceptStoredReferral({ silent: true });
      refresh({ silent: true, auto: true });
      loadReferralDashboard({ silent: true });
    }, 50);
  });
})();
