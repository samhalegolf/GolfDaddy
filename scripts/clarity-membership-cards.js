(function () {
  "use strict";

  var PIN_SRC = "assets/brand/cg-gps-pin.png?v=clarity-cg-gps-20260601";
  var DEFAULTS = {
    free: {
      title: "Free",
      description: "Core GPS access",
      footer: "Always free",
      features: ["Play GPS", "Bag Management", "Profile & Stats", "Bubble Studio (Basic)"]
    },
    month_pass: {
      title: "Month Pass",
      description: "Full access for 30 days",
      footer: "One payment · No renewal",
      marker: "30",
      features: ["All GPS Features", "Advanced Bubbles", "Course Data History", "Cloud Sync"]
    },
    membership: {
      title: "Clarity Member",
      description: "Full access · Renews monthly",
      footer: "Renews monthly",
      features: ["All GPS Features", "Advanced Bubbles", "Course Data History", "Cloud Sync", "Priority Support"]
    }
  };

  function safe(fn, fallback) { try { return fn(); } catch (_error) { return fallback; } }
  function escapeHTML(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function normaliseType(value) {
    value = String(value || "free").trim().toLowerCase().replace(/-/g, "_");
    if (value === "monthly_membership") return "membership";
    return DEFAULTS[value] ? value : "free";
  }
  function cleanFeatures(value, fallback) {
    var rows = Array.isArray(value) ? value : [];
    rows = rows.map(function (item, index) {
      if (typeof item === "string") return { key: "feature_" + index, label: item, enabled: true, sort_order: index * 10 };
      item = item || {};
      return {
        key: String(item.key || "feature_" + index),
        label: String(item.label || "").trim(),
        enabled: item.enabled !== false,
        sort_order: Number.isFinite(Number(item.sort_order)) ? Number(item.sort_order) : index * 10
      };
    }).filter(function (item) { return item.label && item.enabled; });
    if (!rows.length) return cleanFeatures(fallback || [], []);
    return rows.sort(function (a, b) { return a.sort_order - b.sort_order; });
  }
  function displayConfig(type, product) {
    type = normaliseType(type);
    product = product || {};
    var base = DEFAULTS[type];
    var metadata = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
    var display = metadata.membership_card && typeof metadata.membership_card === "object" ? metadata.membership_card : {};
    return {
      type: type,
      title: String(display.title || product.name || base.title),
      description: String(display.description || product.description || base.description),
      footer: String(display.footer || base.footer),
      marker: display.marker === false ? "" : String(display.marker || base.marker || ""),
      features: cleanFeatures(display.features, base.features),
      price: String(product.price_label || ""),
      active: product.active !== false,
      productKey: String(product.product_key || (type === "membership" ? "monthly_membership" : type))
    };
  }
  function productFor(type) {
    var rows = safe(function () { return window.ClarityPayments && window.ClarityPayments.settings().products; }, []) || [];
    var key = normaliseType(type) === "membership" ? "monthly_membership" : normaliseType(type);
    return rows.filter(function (row) { return row && row.product_key === key; })[0] || null;
  }
  function renderPin(config, mini) {
    return [
      '<span class="clarityMembershipPin' + (mini ? ' clarityMembershipPin--mini' : '') + '">',
      '<img src="' + PIN_SRC + '" alt="">',
      config.marker ? '<b>' + escapeHTML(config.marker) + '</b>' : '',
      '</span>'
    ].join("");
  }
  function renderCard(options) {
    options = options || {};
    var config = displayConfig(options.type, options.product || productFor(options.type));
    var size = options.size === "mini" ? "mini" : "full";
    if (size === "mini") {
      return [
        '<span class="clarityMembershipMini clarityMembershipMini--' + escapeHTML(config.type) + '">',
        renderPin(config, true),
        '<span><strong>' + escapeHTML(config.title) + '</strong><small>' + escapeHTML(options.detail || config.description) + '</small></span>',
        '</span>'
      ].join("");
    }
    var action = options.action || "";
    var actionHTML = action ? '<button type="button" class="clarityMembershipCard__action"' + (options.disabled ? ' disabled' : '') + (options.onclick ? ' onclick="' + escapeHTML(options.onclick) + '"' : '') + '>' + escapeHTML(action) + '</button>' : '';
    return [
      '<article class="clarityMembershipCard clarityMembershipCard--' + escapeHTML(config.type) + '" data-membership-card="' + escapeHTML(config.type) + '">',
      '<div class="clarityMembershipCard__visual">' + renderPin(config, false) + '</div>',
      '<header class="clarityMembershipCard__heading"><strong>' + escapeHTML(config.title) + '</strong><span>' + escapeHTML(config.description) + '</span></header>',
      '<ul class="clarityMembershipCard__features">',
      config.features.map(function (feature) { return '<li><i>✓</i><span>' + escapeHTML(feature.label) + '</span></li>'; }).join(""),
      '</ul>',
      '<footer class="clarityMembershipCard__footer"><span>' + escapeHTML(config.footer) + '</span>' + actionHTML + '</footer>',
      '</article>'
    ].join("");
  }
  function renderProductCards() {
    var target = document.querySelector("#clarityPaymentSection .clarityPaymentPassGrid");
    if (!target || target.dataset.membershipCardsEnhanced === "true") return;
    var settings = safe(function () { return window.ClarityPayments.settings(); }, {}) || {};
    var member = safe(function () { return window.ClarityPayments.status().membership; }, null);
    var hasMembership = !!(member && ["active", "trialing", "past_due", "paused", "incomplete"].indexOf(String(member.status || "").toLowerCase()) !== -1);
    var rows = Array.isArray(settings.products) ? settings.products : [];
    var products = [
      rows.filter(function (row) { return row.product_key === "month_pass"; })[0] || {},
      rows.filter(function (row) { return row.product_key === "monthly_membership"; })[0] || {}
    ];
    var monthConfig = displayConfig("month_pass", products[0]);
    var memberConfig = displayConfig("membership", products[1]);
    var monthDisabled = products[0].active === false || !(settings.monthPassPriceConfigured || products[0].stripe_price_id);
    var memberDisabled = products[1].active === false || !(settings.monthlyMembershipPriceConfigured || products[1].stripe_price_id);
    var memberAction = hasMembership ? (String(member.status || "").toLowerCase() === "incomplete" ? "Complete payment setup" : "Manage Membership") : "Start Membership";
    target.className = "clarityMembershipCardGrid";
    target.innerHTML = renderCard({ type: "month_pass", product: products[0], action: monthDisabled ? "Not available" : (monthConfig.price || "Buy One Month"), disabled: monthDisabled, onclick: monthDisabled ? "" : "ClarityPayments.buy('month_pass')" }) +
      renderCard({ type: "membership", product: products[1], action: hasMembership ? memberAction : (memberDisabled ? "Not available" : (memberConfig.price || "Start Membership")), disabled: !hasMembership && memberDisabled, onclick: hasMembership ? "ClarityPayments.manageMembership()" : (memberDisabled ? "" : "ClarityPayments.buy('monthly_membership')") });
    target.dataset.membershipCardsEnhanced = "true";
  }
  function currentType() {
    var status = safe(function () { return window.ClarityPayments.status(); }, {}) || {};
    if (status.paymentState === "membership_active" || status.paymentState === "membership_ending" || status.paymentState === "payment_problem_grace") return "membership";
    if (status.paymentState === "month_pass_active" || status.paymentState === "referral_access_active") return "month_pass";
    return "free";
  }
  function installCurrentAccessMini() {
    var row = document.getElementById("gdPlayerSettingsPaymentsRow");
    if (!row || row.querySelector(".clarityMembershipMini")) return;
    var copy = row.querySelector("div");
    if (!copy) return;
    var type = currentType();
    var detail = safe(function () { return window.ClarityPayments.accessLabel(); }, "Access & Membership");
    var wrapper = document.createElement("span");
    wrapper.innerHTML = renderCard({ type: type, size: "mini", detail: detail });
    row.insertBefore(wrapper.firstChild, copy);
    row.classList.add("gdPlayerSettingsRow--membership");
  }
  function featureRowsHTML(config) {
    return config.features.map(function (feature, index) {
      return [
        '<div class="clarityMembershipFeatureEditorRow">',
        '<input type="text" data-membership-feature-label value="' + escapeHTML(feature.label) + '" placeholder="Feature label">',
        '<label><input type="checkbox" data-membership-feature-enabled' + (feature.enabled !== false ? ' checked' : '') + '> Show</label>',
        '<button type="button" class="secondary" data-membership-feature-up aria-label="Move feature up">↑</button>',
        '<button type="button" class="secondary" data-membership-feature-down aria-label="Move feature down">↓</button>',
        '<button type="button" class="secondary" data-membership-feature-remove aria-label="Remove feature">Remove</button>',
        '</div>'
      ].join("");
    }).join("");
  }
  function installAdminEditor() {
    var form = document.querySelector("[data-clarity-product-form]");
    if (!form || form.querySelector("[data-membership-card-editor]")) return;
    var productKey = form.elements.product_key ? form.elements.product_key.value : "";
    if (productKey !== "month_pass" && productKey !== "monthly_membership") return;
    var type = productKey === "monthly_membership" ? "membership" : "month_pass";
    var product = productFor(type) || {};
    var config = displayConfig(type, product);
    var panel = document.createElement("section");
    panel.className = "clarityMembershipCardEditor";
    panel.setAttribute("data-membership-card-editor", "");
    panel.innerHTML = [
      '<div class="clarityMembershipCardEditor__head"><strong>Membership card content</strong><span>Display copy only. Permissions remain controlled by the resolver.</span></div>',
      '<input name="membership_card_title" value="' + escapeHTML(config.title) + '" placeholder="Card title">',
      '<input name="membership_card_description" value="' + escapeHTML(config.description) + '" placeholder="Card description">',
      '<input name="membership_card_footer" value="' + escapeHTML(config.footer) + '" placeholder="Footer label">',
      '<input name="membership_card_marker" value="' + escapeHTML(config.marker) + '" placeholder="Small marker e.g. 30">',
      '<div class="clarityMembershipFeatureEditor" data-membership-feature-list>' + featureRowsHTML(config) + '</div>',
      '<button type="button" class="secondary" data-membership-feature-add>Add feature</button>',
      '<div class="clarityMembershipCardEditor__preview" data-membership-editor-preview>' + renderCard({ type: type, product: product }) + '</div>'
    ].join("");
    var submit = form.querySelector('button[type="submit"]');
    form.insertBefore(panel, submit || null);
    bindEditor(panel, form, type);
  }
  function editorFeatures(panel) {
    return Array.prototype.map.call(panel.querySelectorAll(".clarityMembershipFeatureEditorRow"), function (row, index) {
      return {
        key: "feature_" + index,
        label: String(row.querySelector("[data-membership-feature-label]").value || "").trim(),
        enabled: !!row.querySelector("[data-membership-feature-enabled]").checked,
        sort_order: index * 10
      };
    }).filter(function (row) { return row.label; });
  }
  function updateEditorPreview(panel, form, type) {
    var fake = {
      product_key: type === "membership" ? "monthly_membership" : "month_pass",
      name: form.elements.membership_card_title.value,
      description: form.elements.membership_card_description.value,
      metadata: { membership_card: {
        title: form.elements.membership_card_title.value,
        description: form.elements.membership_card_description.value,
        footer: form.elements.membership_card_footer.value,
        marker: form.elements.membership_card_marker.value,
        features: editorFeatures(panel)
      } }
    };
    var preview = panel.querySelector("[data-membership-editor-preview]");
    if (preview) preview.innerHTML = renderCard({ type: type, product: fake });
  }
  function bindEditor(panel, form, type) {
    panel.addEventListener("click", function (event) {
      var row = event.target.closest(".clarityMembershipFeatureEditorRow");
      var list = panel.querySelector("[data-membership-feature-list]");
      if (event.target.matches("[data-membership-feature-add]")) {
        var wrap = document.createElement("div");
        wrap.innerHTML = featureRowsHTML({ features: [{ label: "New feature", enabled: true, sort_order: list.children.length * 10 }] });
        list.appendChild(wrap.firstChild);
      } else if (row && event.target.matches("[data-membership-feature-remove]")) row.remove();
      else if (row && event.target.matches("[data-membership-feature-up]") && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      else if (row && event.target.matches("[data-membership-feature-down]") && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
      else return;
      updateEditorPreview(panel, form, type);
    });
    panel.addEventListener("input", function () { updateEditorPreview(panel, form, type); });
    panel.addEventListener("change", function () { updateEditorPreview(panel, form, type); });
  }
  function wrapSave() {
    if (!window.ClarityPayments || window.ClarityPayments.__membershipCardsSaveWrapped) return;
    var original = window.ClarityPayments.saveProductFromForm;
    if (typeof original !== "function") return;
    window.ClarityPayments.saveProductFromForm = function (form) {
      var panel = form && form.querySelector("[data-membership-card-editor]");
      if (panel) {
        var key = form.elements.product_key ? form.elements.product_key.value : "";
        var type = key === "monthly_membership" ? "membership" : "month_pass";
        var product = productFor(type);
        if (product) {
          product.metadata = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
          product.metadata.membership_card = {
            title: String(form.elements.membership_card_title.value || "").trim(),
            description: String(form.elements.membership_card_description.value || "").trim(),
            footer: String(form.elements.membership_card_footer.value || "").trim(),
            marker: String(form.elements.membership_card_marker.value || "").trim(),
            features: editorFeatures(panel)
          };
        }
      }
      return original.call(window.ClarityPayments, form);
    };
    window.ClarityPayments.__membershipCardsSaveWrapped = true;
  }
  function enhance() {
    if (!window.ClarityPayments) return;
    wrapSave();
    renderProductCards();
    installCurrentAccessMini();
    installAdminEditor();
  }
  function install() {
    var observer = new MutationObserver(function () { setTimeout(enhance, 0); });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    enhance();
    setInterval(enhance, 700);
  }

  window.ClarityMembershipCard = {
    render: renderCard,
    config: displayConfig,
    pinSrc: PIN_SRC,
    refresh: enhance
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
