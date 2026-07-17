(function () {
  "use strict";

  var CACHE_KEY = "clarity:payments:status:v1";
  var SETTINGS_KEY = "clarity:payments:settings:v1";
  var AUTH_SESSION_KEY = "clarity:supabase-auth-session:v1";
  var CHECKOUT_ENDPOINT = "/api/create-checkout-session";
  var PORTAL_ENDPOINT = "/api/create-billing-portal-session";
  var STATUS_ENDPOINT = "/api/payment-entitlement";
  var ADMIN_ENDPOINT = "/api/payment-admin";
  var status = loadStatus();
  var settings = loadSettings();
  var pending = false;
  var adminPending = false;
  var entitlementQueryState = { accountId: "", accountEmail: "", entitlements: [], loading: false, error: "", lastChecked: "" };
  var resolverTestState = { permissionKey: "gps_live_bubble", accountId: "", accountEmail: "", profileId: "", loading: false, result: null, error: "" };
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
    if (status && status.paymentState === "membership_active" && member) return "Membership active";
    if (status && status.paymentState === "membership_ending" && member) return "Membership cancelled";
    if (status && status.paymentState === "payment_problem_grace" && member) return "Payment problem";
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
    if (status && status.connectionIssue) return "Supabase could not confirm payment access. Paid features stay locked until the backend confirms the entitlement.";
    if (status && status.error) return status.error;
    if (pending) return "Checking payment status...";
    if (status && status.paymentState === "membership_active" && member) return "Renews on " + (formatDate(member.current_period_end || member.access_until) || "the next billing date") + ".";
    if (status && status.paymentState === "membership_ending" && member) return "Access continues until " + (formatDate(member.access_until || member.current_period_end) || "the paid-through date") + ".";
    if (status && status.paymentState === "payment_problem_grace" && member) return "Grace period active until " + (formatDate(member.grace_until) || "the grace-period end") + ".";
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
      "<strong>Payments & Access</strong>",
      '<span id="clarityPaymentSectionLine">Month Pass, Membership and Stripe-linked access.</span>',
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
    row.innerHTML = '<div><strong>Payments & Access</strong><span id="gdPlayerSettingsPaymentsLine">Free access</span></div>';
    if (accountRow) list.insertBefore(row, accountRow); else list.appendChild(row);
  }

  function showSection(name) {
    if (!originalShowSection && window.gdPlayerSettingsShowSection !== showSection) originalShowSection = window.gdPlayerSettingsShowSection;
    if (originalShowSection) originalShowSection(name);
    var panel = section();
    var menu = document.getElementById("gdPlayerSettingsMenu");
    if (panel) panel.hidden = name !== "payments";
    if (menu && name === "payments") menu.hidden = true;
    if (name === "payments") { render(); refresh({ silent: true }); loadAdminSettings(); }
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

  function renderAdminSettings() {
    var all = Array.isArray(settings.products) ? settings.products : [];
    return [
      '<div class="clarityPaymentAdmin">',
      '<div class="clarityPaymentAdminHead"><strong>Admin Payment Settings</strong><span>Safe settings only. Stripe secret keys stay in Netlify.</span></div>',
      '<div class="clarityPaymentConnectGrid">',
      statusPill('Stripe secret', settings.stripeConnected),
      statusPill('Webhook secret', settings.webhookConfigured),
      statusPill('Alert email', settings.alertEmailConfigured),
      statusPill('Month Pass price', settings.monthPassPriceConfigured),
      statusPill('Membership price', settings.monthlyMembershipPriceConfigured),
      statusPill('Subscription events', settings.subscriptionWebhookEventsConfigured),
      statusPill('Billing Portal', settings.billingPortalConfigured),
      '</div>',
      renderAdminDiagnostics(),
      settings.settingsError ? '<div class="clarityPaymentStatus warning"><strong>Settings warning</strong><span>' + escapeHTML(settings.settingsError) + '</span></div>' : '',
      '<div class="clarityPaymentAdminActions"><button type="button" onclick="ClarityPayments.reloadAdminSettings()">Reload</button><button type="button" onclick="ClarityPayments.seedDefaults()">Seed defaults</button></div>',
      '<div class="clarityPaymentProductList">' + all.map(renderAdminProduct).join("") + '</div>',
      renderProductForm(),
      renderFreePassForm(),
      renderEntitlementViewer(),
      renderManualGrantForm(),
      renderResolverTester(),
      '<div class="clarityPaymentNote">Use Stripe Product/Price IDs here, never secret keys. Create the product/price in Stripe, then paste the public-looking <code>price_...</code> ID into this settings page.</div>',
      '</div>'
    ].join("");
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
    return '<div class="clarityPaymentProductRow"><div><strong>' + escapeHTML(product.name) + '</strong><span>' + escapeHTML(product.product_key + ' · ' + product.product_kind + ' · ' + durationLabel(product.duration_hours)) + '</span><em>' + escapeHTML(product.stripe_price_id || 'No Stripe Price ID') + '</em></div><button type="button" onclick="ClarityPayments.editProduct(&quot;' + escapeHTML(product.product_key) + '&quot;)">Edit</button><button type="button" onclick="ClarityPayments.toggleProduct(&quot;' + escapeHTML(product.product_key) + '&quot;,' + (product.active ? 'false' : 'true') + ')">' + (product.active ? 'Disable' : 'Enable') + '</button></div>';
  }

  function renderProductForm() {
    return '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.saveProductFromForm(this)"><strong>Create / edit pass or membership</strong><input name="product_key" placeholder="month_pass or monthly_membership" required><select name="product_kind"><option value="month_pass">Month Pass</option><option value="membership">Membership</option><option value="free_pass">Free pass template</option><option value="day_pass">Legacy day pass</option><option value="round_pass">Legacy round pass</option></select><input name="name" placeholder="Name shown in app" required><input name="price_label" placeholder="Price label e.g. $29 / month"><input name="stripe_price_id" placeholder="Stripe Price ID e.g. price_..."><input name="stripe_product_id" placeholder="Stripe Product ID e.g. prod_..."><input name="duration_hours" type="number" min="1" step="1" value="720" placeholder="Duration hours"><input name="billing_schedule" placeholder="one_time / monthly"><textarea name="description" placeholder="Description"></textarea><label><input type="checkbox" name="active" checked> Active</label><button type="submit">Save product</button></form>';
  }

  function renderFreePassForm() {
    return '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.issueFreePassFromForm(this)"><strong>Issue free pass</strong><input name="email" placeholder="Player email"><input name="accountId" placeholder="Or account ID"><input name="productKey" value="free_pass" placeholder="Entitlement type"><input name="durationHours" type="number" min="1" step="1" value="24"><textarea name="note" placeholder="Internal note"></textarea><button type="submit">Issue free pass</button></form>';
  }

  function formData(form) { var data = {}; Array.prototype.forEach.call(new FormData(form).entries(), function (entry) { data[entry[0]] = entry[1]; }); data.active = !!form.elements.active && form.elements.active.checked; return data; }

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
    var payment = params.get("payment"); var sessionId = params.get("session_id");
    if (payment === "success" && sessionId) refresh({ sessionId: sessionId }).then(function () { safe(function () { return window.toast && window.toast(hasActiveAccess() ? "Pass active" : "Payment received. Access is updating."); }); });
    if (payment === "cancelled") safe(function () { return window.toast && window.toast("Checkout cancelled"); });
    if (payment === "portal_return") refresh({ silent: true }).then(function () { safe(function () { return window.toast && window.toast("Membership settings updated"); }); });
    if (payment) safe(function () { var clean = window.location.pathname + window.location.hash; window.history.replaceState({}, document.title, clean || "/"); });
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
      var product = (settings.products || []).filter(function (item) { return item.product_key === key; })[0];
      var form = document.querySelector(".clarityPaymentForm"); if (!product || !form) return false;
      Object.keys(product).forEach(function (field) { if (form.elements[field]) form.elements[field].value = product[field] == null ? "" : product[field]; });
      if (form.elements.active) form.elements.active.checked = product.active !== false;
      return false;
    },
    saveProductFromForm: function (form) { var data = formData(form); adminAction("upsertProduct", { product: data }).then(function () { form.reset(); if (form.elements.active) form.elements.active.checked = true; }); return false; },
    issueFreePassFromForm: function (form) { var data = formData(form); adminAction("issueFreePass", data).then(function () { form.reset(); if (form.elements.productKey) form.elements.productKey.value = "free_pass"; if (form.elements.durationHours) form.elements.durationHours.value = "24"; refresh({ silent: true }); }); return false; }
    ,
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

  document.addEventListener("DOMContentLoaded", function () { setTimeout(function () { install(); handleReturn(); refresh({ silent: true, auto: true }); }, 150); });
  window.addEventListener("clarity:session-changed", function () { setTimeout(function () { install(); refresh({ silent: true, auto: true }); }, 50); });
})();
