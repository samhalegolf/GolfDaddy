(function () {
  "use strict";

  var CACHE_KEY = "clarity:payments:status:v1";
  var CHECKOUT_ENDPOINT = "/api/create-checkout-session";
  var STATUS_ENDPOINT = "/api/payment-entitlement";
  var status = loadStatus();
  var pending = false;
  var originalShowSection = null;
  var lastRefreshKey = "";

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  }

  function account() {
    return safe(function () {
      return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function"
        ? window.GolfDaddyAccounts.current()
        : null;
    }, null);
  }

  function role(activeAccount) {
    return String(activeAccount && activeAccount.role || "player").trim().toLowerCase();
  }

  function isStaff(activeAccount) {
    var current = role(activeAccount);
    return current === "admin" || current === "coach";
  }

  function accountPayload() {
    var activeAccount = account();
    return {
      accountId: String(activeAccount && activeAccount.accountId || "").trim(),
      email: String(activeAccount && activeAccount.email || "").trim().toLowerCase(),
      name: String(activeAccount && activeAccount.name || "").trim()
    };
  }

  function loadStatus() {
    return safe(function () {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    }, null) || { active: false, entitlements: [], configured: null, checkedAt: "" };
  }

  function saveStatus(next) {
    status = Object.assign({ active: false, entitlements: [] }, next || {});
    safe(function () { localStorage.setItem(CACHE_KEY, JSON.stringify(status)); });
    applyStatus();
    render();
    return status;
  }

  function bestEntitlement() {
    var rows = Array.isArray(status && status.entitlements) ? status.entitlements : [];
    return rows[0] || null;
  }

  function formatDate(value) {
    if (!value) return "";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

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
      var type = String(entitlement.entitlement_type || "pass").replace(/_/g, " ");
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
    safe(function () {
      if (window.ClaritySession && typeof window.ClaritySession.sync === "function") {
        window.ClaritySession.sync("payment-status");
      }
    });
    safe(function () {
      if (typeof window.gdRefreshPermissionChrome === "function") window.gdRefreshPermissionChrome();
    });
  }

  async function refresh(opts) {
    opts = opts || {};
    var payload = accountPayload();
    if (opts.sessionId) payload.checkoutSessionId = opts.sessionId;
    var refreshKey = [payload.accountId, payload.email, payload.checkoutSessionId].join("|");
    if (!payload.accountId && !payload.email && !payload.checkoutSessionId) {
      return saveStatus({ active: false, entitlements: [], configured: null, message: "Sign in to check payment status" });
    }
    if (pending && refreshKey === lastRefreshKey) return status;
    pending = true;
    lastRefreshKey = refreshKey;
    render();
    try {
      var response = await fetch(STATUS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || "Could not check payment status");
      pending = false;
      return saveStatus(body);
    } catch (error) {
      pending = false;
      saveStatus(Object.assign({}, status, {
        active: hasActiveAccess(),
        error: error && error.message ? error.message : "Could not check payment status",
        checkedAt: new Date().toISOString()
      }));
      safe(function () { return window.toast && window.toast(status.error || "Could not check payment status"); });
      return status;
    }
  }

  async function buy(passType) {
    var payload = accountPayload();
    if (!payload.accountId && !payload.email) {
      safe(function () { return window.toast && window.toast("Sign in before buying a pass"); });
      safe(function () { if (window.gdOpenProfileV67) window.gdOpenProfileV67(); });
      return false;
    }
    pending = true;
    render();
    try {
      var response = await fetch(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({}, payload, { passType: passType }))
      });
      var body = await response.json().catch(function () { return {}; });
      if (!response.ok || !body.url) throw new Error(body.error || "Could not start checkout");
      window.location.assign(body.url);
    } catch (error) {
      pending = false;
      render();
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
      '<button class="gdPlayerSettingsSubBack" type="button" onclick="gdPlayerSettingsShowSection(\'menu\')">‹ Settings</button>',
      "<strong>Payments</strong>",
      '<span id="clarityPaymentSectionLine">Day pass and round pass access.</span>',
      '<div class="clarityPaymentSection" id="clarityPaymentSection"></div>'
    ].join("");
    sheet.appendChild(panel);
    return panel;
  }

  function installMenuRow() {
    var list = document.querySelector("#gdPlayerSettingsMenu .gdPlayerSettingsList");
    if (!list || document.getElementById("gdPlayerSettingsPaymentsRow")) return;
    var accountRow = Array.prototype.find.call(list.children, function (node) {
      return String(node && node.getAttribute && node.getAttribute("onclick") || "").indexOf("account") !== -1;
    });
    var row = document.createElement("button");
    row.className = "gdPlayerSettingsRow";
    row.id = "gdPlayerSettingsPaymentsRow";
    row.type = "button";
    row.onclick = function () { showSection("payments"); };
    row.innerHTML = '<div><strong>Payments</strong><span id="gdPlayerSettingsPaymentsLine">No active pass</span></div>';
    if (accountRow) list.insertBefore(row, accountRow);
    else list.appendChild(row);
  }

  function showSection(name) {
    if (!originalShowSection && window.gdPlayerSettingsShowSection !== showSection) {
      originalShowSection = window.gdPlayerSettingsShowSection;
    }
    if (originalShowSection) originalShowSection(name);
    var panel = section();
    var menu = document.getElementById("gdPlayerSettingsMenu");
    if (panel) panel.hidden = name !== "payments";
    if (menu && name === "payments") menu.hidden = true;
    if (name === "payments") render();
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
    var detail = active
      ? "Paid access is active on this account."
      : activeAccount
        ? "Buy a pass to unlock paid Clarity Caddie access."
        : "Sign in before buying a pass.";
    if (status && status.error) detail = status.error;
    if (pending) detail = "Checking payment status...";

    target.innerHTML = [
      '<div class="clarityPaymentStatus ' + statusClass + '">',
      "<strong>" + escapeHTML(accessLabel()) + "</strong>",
      "<span>" + escapeHTML(detail) + "</span>",
      "</div>",
      '<div class="clarityPaymentPassGrid">',
      '<button class="clarityPaymentPass" type="button" onclick="ClarityPayments.buy(\'day_pass\')"><strong>Day Pass</strong><span>Simple paid access for today. Best first version while the app stabilises.</span><b>Buy pass</b></button>',
      '<button class="clarityPaymentPass" type="button" onclick="ClarityPayments.buy(\'round_pass\')"><strong>Round Pass</strong><span>Same checkout lane, ready for a round-specific entitlement later.</span><b>Buy pass</b></button>',
      "</div>",
      '<div class="clarityPaymentActions">',
      '<button class="secondary" type="button" onclick="ClarityPayments.refresh()">Refresh Status</button>',
      "</div>",
      '<div class="clarityPaymentNote">Card details are handled by Stripe Checkout. Clarity unlocks access only after the payment webhook creates an entitlement.</div>'
    ].join("");
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function install() {
    installMenuRow();
    section();
    if (window.gdPlayerSettingsShowSection !== showSection) {
      originalShowSection = window.gdPlayerSettingsShowSection;
      window.gdPlayerSettingsShowSection = showSection;
    }
    render();
    applyStatus();
  }

  function handleReturn() {
    var params = safe(function () { return new URLSearchParams(window.location.search || ""); }, null);
    if (!params) return;
    var payment = params.get("payment");
    var sessionId = params.get("session_id");
    if (payment === "success" && sessionId) {
      refresh({ sessionId: sessionId }).then(function () {
        safe(function () { return window.toast && window.toast(hasActiveAccess() ? "Pass active" : "Payment received. Access is updating."); });
      });
    }
    if (payment === "cancelled") {
      safe(function () { return window.toast && window.toast("Checkout cancelled"); });
    }
    if (payment) {
      safe(function () {
        var clean = window.location.pathname + window.location.hash;
        window.history.replaceState({}, document.title, clean || "/");
      });
    }
  }

  window.ClarityPayments = {
    buy: buy,
    refresh: refresh,
    render: render,
    status: function () { return status; },
    hasActiveAccess: hasActiveAccess,
    accessLabel: accessLabel,
    showSettings: function () { return showSection("payments"); }
  };

  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () {
      install();
      handleReturn();
      refresh();
    }, 150);
  });
  window.addEventListener("clarity:session-changed", function () {
    setTimeout(function () {
      install();
      refresh();
    }, 50);
  });
})();
