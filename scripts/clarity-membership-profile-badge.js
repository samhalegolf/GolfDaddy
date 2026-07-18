(function () {
  "use strict";

  function safe(fn, fallback) { try { return fn(); } catch (_error) { return fallback; } }

  function currentType() {
    var status = safe(function () { return window.ClarityPayments && window.ClarityPayments.status(); }, {}) || {};
    if (status.paymentState === "membership_active" || status.paymentState === "membership_ending" || status.paymentState === "payment_problem_grace") return "membership";
    if (status.paymentState === "month_pass_active" || status.paymentState === "referral_access_active") return "month_pass";
    return "free";
  }

  function detailText() {
    return safe(function () { return window.ClarityPayments.accessLabel(); }, "Free access") || "Free access";
  }

  function ensureStyles() {
    if (document.getElementById("clarityMembershipProfileBadgeStyles")) return;
    var style = document.createElement("style");
    style.id = "clarityMembershipProfileBadgeStyles";
    style.textContent = [
      "#profileSummary{position:relative}",
      ".clarityProfileMembershipBadge{display:flex;align-items:center;justify-content:flex-start;width:fit-content;max-width:100%;margin-top:10px;padding:7px 10px;border:1px solid rgba(255,255,255,.14);border-radius:14px;color:#fff;background:rgba(5,9,7,.58);box-shadow:0 8px 18px rgba(0,0,0,.18);cursor:pointer}",
      ".clarityProfileMembershipBadge:hover,.clarityProfileMembershipBadge:focus-visible{border-color:rgba(183,255,59,.48);outline:0}",
      ".clarityProfileMembershipBadge .clarityMembershipMini{grid-template-columns:30px minmax(0,1fr);gap:8px}",
      ".clarityProfileMembershipBadge .clarityMembershipPin--mini{width:30px;height:35px}",
      ".clarityProfileMembershipBadge .clarityMembershipMini strong{font-size:10px}",
      ".clarityProfileMembershipBadge .clarityMembershipMini small{max-width:180px;font-size:9px}",
      ".clarityProfileMembershipBadge--month_pass{border-color:rgba(183,255,59,.42);background:linear-gradient(145deg,rgba(31,211,109,.15),rgba(3,15,8,.66))}",
      ".clarityProfileMembershipBadge--membership{border-color:rgba(183,255,59,.48);background:linear-gradient(145deg,rgba(61,159,27,.40),rgba(16,72,15,.72))}",
      "@media(max-width:430px){.clarityProfileMembershipBadge{width:100%;box-sizing:border-box}.clarityProfileMembershipBadge .clarityMembershipMini small{max-width:145px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function openMembership() {
    if (window.ClarityPayments && typeof window.ClarityPayments.showSettings === "function") return window.ClarityPayments.showSettings();
    if (typeof window.gd67OpenMembershipSettings === "function") return window.gd67OpenMembershipSettings();
    return false;
  }

  function installProfileBadge() {
    if (!window.ClarityMembershipCard || !window.ClarityPayments) return;
    var host = document.getElementById("profileSummary");
    if (!host) return;

    var type = currentType();
    var detail = detailText();
    var existing = host.querySelector("[data-clarity-profile-membership]");
    var stateKey = type + "|" + detail;
    if (existing && existing.dataset.stateKey === stateKey) return;

    var button = existing || document.createElement("button");
    button.type = "button";
    button.setAttribute("data-clarity-profile-membership", "");
    button.className = "clarityProfileMembershipBadge clarityProfileMembershipBadge--" + type;
    button.dataset.stateKey = stateKey;
    button.setAttribute("aria-label", detail + ". Open Access and Membership.");
    button.onclick = openMembership;
    button.innerHTML = window.ClarityMembershipCard.render({ type: type, size: "mini", detail: detail });
    if (!existing) host.appendChild(button);
  }

  function refresh() {
    ensureStyles();
    installProfileBadge();
  }

  function install() {
    var observer = new MutationObserver(function () { setTimeout(refresh, 0); });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    refresh();
    setInterval(refresh, 700);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
