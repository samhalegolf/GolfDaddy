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
      "#gdProfileV67 .heroMain>div:first-child{min-width:0;flex:1}",
      "#gdProfileV67 .clarityProfileIdentityHead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;width:100%}",
      "#gdProfileV67 .clarityProfileIdentityHead>.name{min-width:0}",
      "#gdProfileV67 .clarityProfileMembershipPin{display:grid;place-items:center;width:46px;height:52px;padding:3px;border:1px solid rgba(255,255,255,.18);border-radius:14px;color:#fff;background:rgba(5,9,7,.55);box-shadow:0 8px 18px rgba(0,0,0,.2);cursor:pointer}",
      "#gdProfileV67 .clarityProfileMembershipPin:hover,#gdProfileV67 .clarityProfileMembershipPin:focus-visible{border-color:rgba(183,255,59,.55);outline:0}",
      "#gdProfileV67 .clarityProfileMembershipPin .clarityMembershipMini{display:block}",
      "#gdProfileV67 .clarityProfileMembershipPin .clarityMembershipMini>span:last-child{display:none}",
      "#gdProfileV67 .clarityProfileMembershipPin .clarityMembershipPin--mini{width:34px;height:40px}",
      "#gdProfileV67 .clarityProfileMembershipPin--month_pass{border-color:rgba(183,255,59,.52);background:linear-gradient(145deg,rgba(31,211,109,.16),rgba(3,15,8,.72))}",
      "#gdProfileV67 .clarityProfileMembershipPin--membership{border-color:rgba(183,255,59,.62);background:linear-gradient(145deg,rgba(61,159,27,.5),rgba(16,72,15,.82))}",
      "#gdProfileV67 .clarityProfileIdentityMeta{margin-top:3px}",
      "#gdProfileV67 .clarityProfileAccountLine{margin-top:2px;color:rgba(255,255,255,.58);font-size:11px;font-weight:700;line-height:1.25}",
      "@media(max-width:430px){#gdProfileV67 .clarityProfileMembershipPin{width:42px;height:48px;border-radius:12px}#gdProfileV67 .clarityProfileMembershipPin .clarityMembershipPin--mini{width:31px;height:37px}}"
    ].join("");
    document.head.appendChild(style);
  }

  function openMembership() {
    if (window.ClarityPayments && typeof window.ClarityPayments.showSettings === "function") return window.ClarityPayments.showSettings();
    if (typeof window.gd67OpenMembershipSettings === "function") return window.gd67OpenMembershipSettings();
    return false;
  }

  function splitMeta(copyHost) {
    var meta = copyHost && copyHost.querySelector(":scope > .meta");
    if (!meta || meta.dataset.membershipLayout === "true") return;
    var parts = String(meta.textContent || "").split(" · ").map(function (part) { return part.trim(); }).filter(Boolean);
    if (parts.length < 2) return;
    var account = parts.length > 2 ? parts.pop() : "";
    meta.textContent = parts.join(" · ");
    meta.classList.add("clarityProfileIdentityMeta");
    meta.dataset.membershipLayout = "true";
    if (account) {
      var line = document.createElement("div");
      line.className = "clarityProfileAccountLine";
      line.textContent = account;
      copyHost.appendChild(line);
    }
  }

  function installProfileBadge() {
    if (!window.ClarityMembershipCard || !window.ClarityPayments) return;
    var heroMain = document.querySelector("#gdProfileV67 .hero .heroMain");
    if (!heroMain) return;
    var copyHost = heroMain.firstElementChild;
    if (!copyHost) return;
    var name = copyHost.querySelector(":scope > .name");
    if (!name) return;

    splitMeta(copyHost);

    var head = copyHost.querySelector(":scope > .clarityProfileIdentityHead");
    if (!head) {
      head = document.createElement("div");
      head.className = "clarityProfileIdentityHead";
      copyHost.insertBefore(head, name);
      head.appendChild(name);
    }

    var type = currentType();
    var detail = detailText();
    var existing = head.querySelector("[data-clarity-profile-membership]");
    var stateKey = type + "|" + detail;
    if (existing && existing.dataset.stateKey === stateKey) return;

    var button = existing || document.createElement("button");
    button.type = "button";
    button.setAttribute("data-clarity-profile-membership", "");
    button.className = "clarityProfileMembershipPin clarityProfileMembershipPin--" + type;
    button.dataset.stateKey = stateKey;
    button.title = detail;
    button.setAttribute("aria-label", detail + ". Open Access and Membership.");
    button.onclick = openMembership;
    button.innerHTML = window.ClarityMembershipCard.render({ type: type, size: "mini", detail: detail });
    if (!existing) head.appendChild(button);
  }

  function refresh() {
    ensureStyles();
    installProfileBadge();
  }

  function install() {
    var observer = new MutationObserver(function () { setTimeout(refresh, 0); });
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
    refresh();
    setInterval(refresh, 500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
