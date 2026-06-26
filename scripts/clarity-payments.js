(function () {
  "use strict";

  var CACHE_KEY = "clarity:payments:status:v1";
  var SETTINGS_KEY = "clarity:payments:settings:v1";
  var CHECKOUT_ENDPOINT = "/api/create-checkout-session";
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
    return {
      "Content-Type": "application/json",
      "X-Clarity-Account-Id": payload.accountId,
      "X-Clarity-Account-Email": payload.email
    };
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
    if (rows.length) return rows.filter(function (product) { return product && product.active !== false; });
    return [
      { product_key: "day_pass", product_kind: "day_pass", name: "Day Pass", description: "Simple paid access for today.", price_label: "Buy pass", duration_hours: 24, active: true },
      { product_key: "round_pass", product_kind: "round_pass", name: "Round Pass", description: "Ready for a round-specific entitlement later.", price_label: "Buy pass", duration_hours: 24, active: true }
    ];
  }

  function bestEntitlement() { var rows = Array.isArray(status && status.entitlements) ? status.entitlements : []; return rows[0] || null; }
  function formatDate(value) { if (!value) return ""; var date = new Date(value); if (Number.isNaN(date.getTime())) return ""; return date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function durationLabel(hours) { var value = Number(hours); if (!Number.isFinite(value) || value <= 0) return ""; if (value % 720 === 0) return (value / 720) + " month" + (value === 720 ? "" : "s"); if (value % 24 === 0) return (value / 24) + " day" + (value === 24 ? "" : "s"); return value + " hour" + (value === 1 ? "" : "s"); }

  function hasActiveAccess() {
    var activeAccount = account();
    if (isStaff(activeAccount)) return true;
    var entitlement = bestEntitlement();
    if (!status || !status.active || !entitlement) return false;
    if (entitlement.expires_at && new Date(entitlement.expires_at).getTime() <= Date.now()) return false;
    return true;
  }

  function accessLabel() {
    var activeAccount = account();
    if (isStaff(activeAccount)) return "Staff access";
    var entitlement = bestEntitlement();
    if (hasActiveAccess() && entitlement) {
      var type = String(entitlement.entitlement_type || entitlement.product_key || "pass").replace(/_/g, " ");
      var expiry = formatDate(entitlement.expires_at);
      return expiry ? type + " active until " + expiry : type + " active";
    }
    if (status && status.configured === false) return "Payments not configured yet";
    return "No active pass";
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
      var response = await fetch(STATUS_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
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
      safe(function () { return window.toast && window.toast("Sign in before buying a pass"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true; render();
    try {
      var response = await fetch(CHECKOUT_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({}, payload, { productKey: productKey, passType: productKey })) });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.url) throw new Error(body.error || "Could not start checkout");
      window.location.assign(body.url);
    } catch (error) {
      pending = false; render();
      safe(function () { return window.toast && window.toast(error && error.message ? error.message : "Could not start checkout"); });
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
      '<span id="clarityPaymentSectionLine">Passes, memberships and Stripe-linked access.</span>',
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
    row.innerHTML = '<div><strong>Payments & Access</strong><span id="gdPlayerSettingsPaymentsLine">No active pass</span></div>';
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

    var active = hasActiveAccess();
    var activeAccount = account();
    var statusClass = active ? "active" : status && status.configured === false ? "warning" : "";
    var detail = active ? "Paid access is active on this account." : activeAccount ? "Buy a pass to unlock paid Clarity Caddie access." : "Sign in before buying a pass.";
    if (status && status.error) detail = status.error;
    if (status && status.connectionIssue) detail = "Supabase could not confirm payment access. Paid features stay locked until the backend confirms the entitlement.";
    if (pending) detail = "Checking payment status...";

    target.innerHTML = [
      '<div class="clarityPaymentStatus ' + statusClass + '"><strong>' + escapeHTML(accessLabel()) + '</strong><span>' + escapeHTML(detail) + '</span></div>',
      renderProductCards(),
      '<div class="clarityPaymentActions"><button class="secondary" type="button" onclick="ClarityPayments.refresh()">Refresh Status</button></div>',
      '<div class="clarityPaymentNote">Card details are handled by Stripe Checkout. Clarity unlocks access only after the Stripe webhook creates a Supabase entitlement.</div>',
      isAdmin(activeAccount) ? renderAdminSettings() : ""
    ].join("");
  }

  function renderProductCards() {
    var cards = products().filter(function (product) { return product.product_kind !== "free_pass"; }).map(function (product) {
      var price = moneyText(product.price_label) || (product.stripe_price_id ? "Buy" : "Not linked yet");
      return '<button class="clarityPaymentPass" type="button" onclick="ClarityPayments.buy(&quot;' + escapeHTML(product.product_key) + '&quot;)"><strong>' + escapeHTML(product.name) + '</strong><span>' + escapeHTML(product.description || durationLabel(product.duration_hours)) + '</span><small>' + escapeHTML(durationLabel(product.duration_hours)) + '</small><b>' + escapeHTML(price) + '</b></button>';
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
      '</div>',
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

  function statusPill(label, ok) { return '<div class="clarityPaymentPill ' + (ok ? 'ok' : 'bad') + '"><b>' + escapeHTML(ok ? '✓' : '!') + '</b><span>' + escapeHTML(label) + '</span></div>'; }

  function renderAdminProduct(product) {
    return '<div class="clarityPaymentProductRow"><div><strong>' + escapeHTML(product.name) + '</strong><span>' + escapeHTML(product.product_key + ' · ' + product.product_kind + ' · ' + durationLabel(product.duration_hours)) + '</span><em>' + escapeHTML(product.stripe_price_id || 'No Stripe Price ID') + '</em></div><button type="button" onclick="ClarityPayments.editProduct(&quot;' + escapeHTML(product.product_key) + '&quot;)">Edit</button><button type="button" onclick="ClarityPayments.toggleProduct(&quot;' + escapeHTML(product.product_key) + '&quot;,' + (product.active ? 'false' : 'true') + ')">' + (product.active ? 'Disable' : 'Enable') + '</button></div>';
  }

  function renderProductForm() {
    return '<form class="clarityPaymentForm" onsubmit="return ClarityPayments.saveProductFromForm(this)"><strong>Create / edit pass or membership</strong><input name="product_key" placeholder="product_key e.g. monthly_membership" required><select name="product_kind"><option value="day_pass">Day pass</option><option value="round_pass">Round pass</option><option value="membership">Membership</option><option value="free_pass">Free pass template</option></select><input name="name" placeholder="Name shown in app" required><input name="price_label" placeholder="Price label e.g. $2 / $19 monthly"><input name="stripe_price_id" placeholder="Stripe Price ID e.g. price_..."><input name="stripe_product_id" placeholder="Stripe Product ID e.g. prod_..."><input name="duration_hours" type="number" min="1" step="1" value="24" placeholder="Duration hours"><input name="billing_schedule" placeholder="one_time / monthly / annual"><textarea name="description" placeholder="Description"></textarea><label><input type="checkbox" name="active" checked> Active</label><button type="submit">Save product</button></form>';
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
    if (payment) safe(function () { var clean = window.location.pathname + window.location.hash; window.history.replaceState({}, document.title, clean || "/"); });
  }

  window.ClarityPayments = {
    buy: buy,
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
