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

  function adminHeaders() {
    var payload = accountPayload();
    return Object.assign(requestHeaders(), {
      "Content-Type": "application/json",
      "X-Clarity-Account-Id": payload.accountId,
      "X-Clarity-Account-Email": payload.email
    });
  }

  function authToken() {
    return safe(function () {
      var session = window.ClaritySupabaseAuth && typeof window.ClaritySupabaseAuth.session === "function"
        ? window.ClaritySupabaseAuth.session()
        : JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null");
      return String(session && session.access_token || "").trim();
    }, "");
  }

  function requestHeaders() {
    var headers = { "Content-Type": "application/json" };
    var token = authToken();
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

  function products() {
    var rows = Array.isArray(settings && settings.products) ? settings.products : [];
    var defaults = {
      month_pass: { product_key: "month_pass", product_kind: "month_pass", name: "One Month Pass", description: "One payment for 30 days full access. No automatic renewal.", price_label: "One month", duration_hours: 720, billing_schedule: "one_time", active: true },
      monthly_membership: { product_key: "monthly_membership", product_kind: "membership", name: "Monthly Membership", description: "Full access with monthly renewal. Cancel anytime.", price_label: "Monthly", duration_hours: 720, billing_schedule: "monthly", active: false }
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
  function durationLabel(hours) { var value = Number(hours); if (!Number.isFinite(value) || value <= 0) return ""; if (value % 720 === 0) return (value / 720) + " month" + (value === 720 ? "" : "s"); if (value % 24 === 0) return (value / 24) + " day" + (value === 24 ? "" : "s"); return value + " hour" + (value === 1 ? "" : "s"); }
  function daysUntil(value) { var date = value ? new Date(value).getTime() : NaN; if (!Number.isFinite(date)) return null; return Math.ceil((date - Date.now()) / (24 * 60 * 60 * 1000)); }

  function hasActiveAccess() {
    var activeAccount = account();
    if (isStaff(activeAccount)) return true;
    return !!(status && status.active);
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
    return account() ? "Choose a pass or membership to unlock full Clarity Caddy access." : "Sign in before buying access.";
  }

  function applyStatus() {
    if (!document.body) return;
    document.body.dataset.clarityPaidAccess = hasActiveAccess() ? "active" : "inactive";
    document.body.dataset.clarityPaymentStatus = accessLabel();
    safe(function () { if (window.ClaritySession && typeof window.ClaritySession.sync === "function") window.ClaritySession.sync("payment-status"); });
    safe(function () { if (typeof window.gdRefreshPermissionChrome === "function") window.gdRefreshPermissionChrome(); });
  }

  async function refresh(opts) {
    opts = opts || {};
    var payload = accountPayload();
    if (opts.sessionId) payload.checkoutSessionId = opts.sessionId;
    var refreshKey = [payload.accountId, payload.email, payload.checkoutSessionId].join("|");
    if (!payload.accountId && !payload.email && !payload.checkoutSessionId) return saveStatus({ active: false, entitlements: [], configured: null, message: "Sign in to check payment status" });
    if (pending && refreshKey === lastRefreshKey) return status;
    pending = true; lastRefreshKey = refreshKey; render();
    try {
      var response = await fetch(STATUS_ENDPOINT, { method: "POST", headers: requestHeaders(), body: JSON.stringify(payload) });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Could not check payment status");
      pending = false; return saveStatus(body);
    } catch (error) {
      pending = false;
      var message = error && error.message ? error.message : "Could not check payment status";
      saveStatus(Object.assign({}, status, { active: false, entitlements: [], connectionIssue: true, error: message, checkedAt: new Date().toISOString() }));
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
      var response = await fetch(ADMIN_ENDPOINT, { method: "GET", headers: adminHeaders() });
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
      var response = await fetch(ADMIN_ENDPOINT, { method: "POST", headers: adminHeaders(), body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
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

  async function referralAction(action, payload, opts) {
    opts = opts || {};
    referralPending = true; render();
    try {
      var response = await fetch(REFERRAL_ENDPOINT, { method: "POST", headers: requestHeaders(), body: JSON.stringify(Object.assign({ action: action }, payload || {})) });
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
    var payload = accountPayload();
    if (!payload.accountId && !payload.email) return saveReferralState({ dashboard: null, shareUrl: referralState.shareUrl || "", error: "", lastChecked: "" });
    try {
      var body = await referralAction("dashboard", payload, { silent: true });
      return body;
    } catch (_error) {
      if (!opts.silent) safe(function () { return window.toast && window.toast(referralState.error || "Could not load referrals"); });
      return referralState.dashboard;
    }
  }

  async function createReferralInvite(opts) {
    opts = opts || {};
    try {
      var body = await referralAction("createInvite", Object.assign({}, accountPayload(), opts.payload || {}), opts);
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
    if (navigator.share) {
      await navigator.share({
        title: "A private Clarity invitation",
        text: "You have been privately invited to try a full month of Clarity Membership.",
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
      var body = await referralAction("accept", Object.assign({}, accountPayload(), { referralToken: token }), { silent: !!opts.silent });
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

  async function buy(productKey) {
    var payload = accountPayload();
    if (!payload.accountId && !payload.email) {
      safe(function () { return window.toast && window.toast("Sign in before buying access"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true; render();
    try {
      var response = await fetch(CHECKOUT_ENDPOINT, { method: "POST", headers: requestHeaders(), body: JSON.stringify(Object.assign({}, payload, { productKey: productKey, passType: productKey })) });
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
    var payload = accountPayload();
    if (!payload.accountId && !payload.email) {
      safe(function () { return window.toast && window.toast("Sign in before managing membership"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true; render();
    try {
      var response = await fetch(PORTAL_ENDPOINT, { method: "POST", headers: requestHeaders(), body: JSON.stringify(payload) });
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
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(&quot;menu&quot;)">‹ Settings</button>',
      "<strong>Access & Membership</strong>",
      '<span id="clarityPaymentSectionLine">Month Pass and Membership access.</span>',
      '<div class="clarityPaymentSection" id="clarityPaymentSection"></div>'
    ].join("");
    sheet.appendChild(panel);
    return panel;
  }

  function installMenuRow() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list || document.getElementById("gdPlayerSettingsPaymentsRow")) return;
    var accountRow = Array.prototype.find.call(list.children, function (node) { return String(node && node.getAttribute && node.getAttribute("onclick") || "").indexOf("account") !== -1; });
    var row = document.createElement("button");
    row.className = "gdPlayerSettingsRow";
    row.id = "gdPlayerSettingsPaymentsRow";
    row.type = "button";
    row.onclick = function () { showSection("payments"); };
    row.innerHTML = '<div><strong>Access & Membership</strong><span id="gdPlayerSettingsPaymentsLine">Free access</span></div>';
    if (accountRow) list.insertBefore(row, accountRow); else list.appendChild(row);
  }

  function showSection(name) {
    if (!originalShowSection && window.gdPlayerSettingsShowSection !== showSection) originalShowSection = window.gdPlayerSettingsShowSection;
    if (originalShowSection) originalShowSection(name);
    var panel = section();
    var menu = document.getElementById("gdPlayerSettingsMenu");
    if (panel) panel.hidden = name !== "payments";
    if (menu && name === "payments") menu.hidden = true;
    if (name === "payments") { render(); refresh({ silent: true }); loadReferralDashboard({ silent: true }); loadAdminSettings(); }
  }

  function render() {
    installMenuRow();
    var panel = section();
    var line = document.getElementById("gdPlayerSettingsPaymentsLine");
    if (line) line.textContent = accessLabel();
    var target = document.getElementById("clarityPaymentSection");
    if (!target || !panel) return;

    var activeAccount = account();
    var statusClass = hasActiveAccess() ? "active" : status && status.configured === false ? "warning" : "";

    target.innerHTML = [
      '<div class="clarityPaymentStatus ' + statusClass + '"><strong>' + escapeHTML(accessLabel()) + '</strong><span>' + escapeHTML(accessDetail()) + '</span></div>',
      renderExpiryBanner(),
      renderProductCards(),
      renderReferralSection(),
      '<div class="clarityPaymentActions"><button class="secondary" type="button" onclick="ClarityPayments.refresh()">Refresh Status</button></div>',
      '<div class="clarityPaymentNote">Card details are handled by Stripe Checkout. Clarity unlocks access only after the Stripe webhook creates a Supabase entitlement.</div>',
      isAdmin(activeAccount) ? renderAdminSettings() : ""
    ].join("");
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
      if (rowPriceMalformed) disabledReason = "Invalid Price ID";
      if (!priceConfigured && !product.stripe_price_id) disabledReason = "Not linked yet";
      var action = isMembershipProduct ? "Start Membership" : "Buy One Month";
      var onclick = 'ClarityPayments.buy(&quot;' + escapeHTML(key) + '&quot;)';
      if (isMembershipProduct && hasMembership) {
        action = member && String(member.status || "").toLowerCase() === "incomplete" ? "Complete payment setup" : "Manage Membership";
        onclick = "ClarityPayments.manageMembership()";
        disabledReason = "";
      }
      var lines = isMembershipProduct
        ? ["Full access", "Renews monthly", "Cancel anytime"]
        : ["One payment", "30 days full access", "No automatic renewal"];
      return '<button class="clarityPaymentPass" type="button" ' + (disabledReason ? 'disabled title="' + escapeHTML(disabledReason) + '"' : 'onclick="' + onclick + '"') + '><strong>' + escapeHTML(product.name) + '</strong><span>' + lines.map(escapeHTML).join(" · ") + '</span><small>' + escapeHTML(disabledReason || product.description || durationLabel(product.duration_hours)) + '</small><b>' + escapeHTML(price) + '</b><em>' + escapeHTML(disabledReason || action) + '</em></button>';
    }).join("");
    return '<div class="clarityPaymentPassGrid">' + cards + '</div>';
  }

  function renderReferralSection() {
    var dashboard = referralState && referralState.dashboard;
    var eligible = dashboard && dashboard.eligibility && dashboard.eligibility.eligible;
    var invitee = dashboard && dashboard.invitee;
    var activeAccount = account();
    if (!activeAccount) return "";
    if (!eligible && !invitee) return "";
    return [
      invitee ? renderInviteeReferral(invitee) : "",
      eligible ? renderMemberReferrals(dashboard) : "",
      referralState.error ? '<div class="clarityPaymentStatus warning"><strong>Referral update failed</strong><span>' + escapeHTML(referralState.error) + '</span></div>' : ""
    ].join("");
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

  function renderMemberReferrals(dashboard) {
    var summary = dashboard.summary || {};
    var max = Number(summary.maxOpenInvitations || dashboard.config && dashboard.config.maxOutstandingInvites || 10);
    var available = Number(summary.freeMonthsAvailableToGive);
    if (!Number.isFinite(available)) available = max;
    var source = dashboard.eligibility && dashboard.eligibility.eligibilitySource;
    var intro = source === "admin_comped_membership"
      ? "Your Membership includes private invitations. You can give up to 10 golfers a free month of Clarity while your comped Membership is active."
      : "Invite someone privately. They receive one full month with no card and no automatic renewal. If they later complete their first paid Membership month, you receive a free month too.";
    var limitReached = available <= 0;
    return [
      '<div class="clarityReferralPanel">',
      '<div class="clarityReferralHead"><strong>Your private Member Referrals</strong><span>You have up to 10 free Membership months to give away at one time.</span></div>',
      '<div class="clarityPaymentNote">' + escapeHTML(intro) + '</div>',
      '<div class="clarityReferralSummary">',
      referralMetric("Free months available to give", available + " of " + max),
      referralMetric("Friends using a free month", summary.friendsUsingFreeMonth || 0),
      referralMetric("Rewards waiting for conversion", summary.pendingRewards || 0),
      referralMetric("Free months earned", (summary.freeMonthsAvailable || 0) + (summary.freeMonthsScheduled || 0)),
      referralMetric("Free months already applied", summary.freeMonthsApplied || 0),
      '</div>',
      limitReached ? '<div class="clarityPaymentStatus warning"><strong>All 10 free months are currently allocated</strong><span>You can create another invitation when someone accepts, an invitation expires or you revoke an unused link.</span></div>' : renderReferralCreateForm(),
      renderReferralInviteList(dashboard.invites || []),
      '</div>'
    ].join("");
  }

  function referralMetric(label, value) {
    return '<div><span>' + escapeHTML(label) + '</span><strong>' + escapeHTML(value) + '</strong></div>';
  }

  function renderReferralCreateForm() {
    return [
      '<form class="clarityReferralForm" onsubmit="return ClarityPayments.createReferralFromForm(this, &quot;copy&quot;)">',
      '<strong>Give a free month</strong>',
      '<span>Create a private invitation for someone you know.</span>',
      '<input name="friendName" placeholder="Friend name (optional)">',
      '<input name="friendEmail" type="email" placeholder="Friend email (optional)">',
      '<div class="clarityPaymentActions">',
      '<button type="submit">' + (referralPending ? "Creating..." : "Copy private link") + '</button>',
      '<button class="secondary" type="button" onclick="ClarityPayments.createReferralFromForm(this.form, &quot;share&quot;)">Share</button>',
      '<button class="secondary" type="button" onclick="ClarityPayments.createReferralFromForm(this.form, &quot;email&quot;)">Send invitation email</button>',
      '</div>',
      '</form>'
    ].join("");
  }

  function renderReferralInviteList(invites) {
    var rows = (Array.isArray(invites) ? invites : []).slice(0, 12).map(function (invite) {
      var open = invite.status === "open" || invite.status === "opened";
      var title = invite.friendName || invite.inviteeEmail || "Private invitation";
      var status = referralStatusText(invite);
      return '<div class="clarityReferralRow"><div><strong>' + escapeHTML(title) + '</strong><span>' + escapeHTML(status.primary) + '</span><em>' + escapeHTML(status.detail) + '</em></div>' + (open ? '<button class="secondary" type="button" onclick="ClarityPayments.revokeReferralInvite(&quot;' + escapeHTML(invite.id) + '&quot;)">Revoke</button>' : '') + '</div>';
    }).join("");
    if (!rows) rows = '<div class="gdShotAdminEmpty">Give your first free month.</div>';
    return '<div class="clarityReferralList">' + rows + '</div>';
  }

  function referralStatusText(invite) {
    var created = formatDate(invite.createdAt) || "recently";
    if (invite.status === "open" || invite.status === "opened") return { primary: "Waiting for signup", detail: "Created " + created };
    if (invite.status === "accepted" || invite.status === "free_month_active") return { primary: "Free month active", detail: "Ends " + (formatDate(invite.freeAccessEndsAt) || "after 30 days") };
    if (invite.status === "free_month_ended") return { primary: "Waiting for first paid month", detail: "Free access completed" };
    if (invite.status === "converted") return { primary: "First paid month completed", detail: "Reward is being prepared" };
    if (invite.status === "reward_earned") return { primary: "You earned a free month", detail: "Reward will apply to your next eligible bill" };
    if (invite.status === "revoked" || invite.status === "invalid") return { primary: "Invite expired or invalid", detail: invite.revokedReason || invite.invalidReason || "No action needed" };
    return { primary: String(invite.status || "Referral"), detail: "Created " + created };
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
      '<details class="clarityPaymentAdminDetails"><summary><strong>Diagnostics</strong><span>Webhook, portal and membership health</span></summary>' + renderAdminDiagnostics() + '</details>',
      '<details class="clarityPaymentAdminDetails"><summary><strong>Advanced tools</strong><span>Comp access, entitlement lookup and resolver checks</span></summary>' + renderFreePassForm() + renderEntitlementViewer() + renderManualGrantForm() + renderResolverTester() + '<div class="clarityPaymentNote">Use Stripe Product/Price IDs here, never secret keys. Create the product/price in Stripe, then paste the public-looking <code>price_...</code> ID into this settings page.</div></details>',
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
    return '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.issueFreePassFromForm(this)"><strong>Issue comped access</strong><input name="email" placeholder="Player email"><input name="accountId" placeholder="Or account ID"><select name="productKey"><option value="admin_comped_membership" selected>Comped Membership month</option><option value="free_pass">Promotional free pass</option></select><input name="durationHours" type="number" min="1" step="1" value="720"><label><input type="checkbox" name="allowMemberReferrals" checked> Allow member referrals</label><textarea name="note" placeholder="Internal note"></textarea><button type="submit">Issue comped access</button></form>';
  }

  function formData(form) { var data = {}; Array.prototype.forEach.call(new FormData(form).entries(), function (entry) { data[entry[0]] = entry[1]; }); data.active = !!form.elements.active && form.elements.active.checked; return data; }

  function productFormData(form) {
    form = form && form.form ? form.form : form;
    var data = formData(form);
    var fallback = adminProductByKey(editingProductKey) || {};
    data.product_key = data.product_key || fallback.product_key || editingProductKey || "";
    data.product_kind = data.product_kind || fallback.product_kind || (data.product_key === "monthly_membership" ? "membership" : "month_pass");
    data.name = data.name || fallback.name || data.product_key.replace(/_/g, " ");
    data.duration_hours = data.duration_hours || fallback.duration_hours || 720;
    data.billing_schedule = data.billing_schedule || fallback.billing_schedule || (data.product_kind === "membership" ? "monthly" : "one_time");
    data.active = !!(form && form.elements && form.elements.active) ? !!form.elements.active.checked : fallback.active !== false;
    return data;
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
    if (payment || handledReferral) safe(function () { var clean = window.location.pathname + window.location.hash; window.history.replaceState({}, document.title, clean || "/"); });
  }

  window.ClarityPayments = {
    buy: buy,
    manageMembership: manageMembership,
    refresh: refresh,
    render: render,
    status: function () { return status; },
    settings: function () { return settings; },
    hasActiveAccess: hasActiveAccess,
    accessLabel: accessLabel,
    showSettings: function () { return showSection("payments"); },
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
    issueFreePassFromForm: function (form) { var data = formData(form); adminAction("issueFreePass", data).then(function () { form.reset(); if (form.elements.productKey) form.elements.productKey.value = "admin_comped_membership"; if (form.elements.durationHours) form.elements.durationHours.value = "720"; if (form.elements.allowMemberReferrals) form.elements.allowMemberReferrals.checked = true; refresh({ silent: true }); }); return false; }
    ,
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
      referralAction("revokeInvite", Object.assign({}, accountPayload(), { referralId: id, reason: "revoked_by_member" }))
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
          });
        }
      });
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
          });
        }
      });
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
  window.addEventListener("clarity:session-changed", function () { setTimeout(function () { install(); acceptStoredReferral({ silent: true }); refresh({ silent: true, auto: true }); loadReferralDashboard({ silent: true }); }, 50); });
})();
