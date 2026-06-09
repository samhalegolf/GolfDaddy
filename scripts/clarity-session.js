(function () {
  "use strict";

  var root = window.Clarity = window.Clarity || {};
  var safe = root.store && root.store.safe || function (fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  };
  var current = null;

  function normalizeRole(value) {
    var raw = String(value || "player").trim().toLowerCase().replace(/[\s_-]+/g, "");
    if (raw === "admin") return "admin";
    if (raw === "coach") return "coach";
    if (raw === "subscribed" || raw === "subscriber" || raw === "subscribedplayer") return "subscribedPlayer";
    return "player";
  }

  function accountApi() {
    return window.GolfDaddyAccounts || window.ClarityCaddieAccounts || null;
  }

  function profileApi() {
    return window.GolfDaddyProfiles || window.ClarityCaddieProfiles || null;
  }

  function legacyAccount() {
    return safe(function () {
      var api = accountApi();
      return api && typeof api.current === "function" ? api.current() : null;
    }, null);
  }

  function legacyState() {
    return safe(function () {
      var api = accountApi();
      return api && typeof api.state === "function" ? api.state() : null;
    }, null);
  }

  function legacyProfile() {
    return safe(function () {
      var api = profileApi();
      return api && typeof api.active === "function" ? api.active() : null;
    }, null);
  }

  function snapshot(reason) {
    var account = legacyAccount();
    var state = legacyState() || {};
    var profile = legacyProfile();
    var role = normalizeRole(account && (account.role || account.permission) || profile && (profile.permission || profile.accountPermission || profile.mode));
    var ownProfileId = account && account.profileId || "";
    var viewedProfileId = state.viewingProfileId || profile && profile.id || ownProfileId || "";
    return {
      accountId: account && account.accountId || "",
      accountName: account && account.name || profile && profile.name || "",
      accountEmail: account && account.email || profile && profile.email || "",
      accountRole: role,
      ownProfileId: ownProfileId,
      viewedProfileId: viewedProfileId,
      viewedAs: account && viewedProfileId && ownProfileId && viewedProfileId !== ownProfileId ? role : "self",
      isSignedIn: !!account,
      isStaff: role === "admin" || role === "coach",
      reason: reason || "sync",
      updatedAt: new Date().toISOString()
    };
  }

  function sameSession(a, b) {
    return !!a && !!b &&
      a.accountId === b.accountId &&
      a.accountRole === b.accountRole &&
      a.ownProfileId === b.ownProfileId &&
      a.viewedProfileId === b.viewedProfileId &&
      a.isSignedIn === b.isSignedIn;
  }

  function applyToDom(session) {
    if (!document.body) return;
    document.body.dataset.clarityAccountRole = session.accountRole;
    document.body.dataset.clarityAccountId = session.accountId || "";
    document.body.dataset.clarityOwnProfileId = session.ownProfileId || "";
    document.body.dataset.clarityViewedProfileId = session.viewedProfileId || "";
    document.body.dataset.clarityViewedAs = session.viewedAs || "self";
  }

  function sync(reason) {
    var next = snapshot(reason);
    var changed = !sameSession(current, next);
    current = next;
    applyToDom(current);
    if (changed) {
      safe(function () {
        window.dispatchEvent(new CustomEvent("clarity:session-changed", { detail: current }));
      });
    }
    return current;
  }

  function get() {
    return current || sync("get");
  }

  function canManage() {
    var role = get().accountRole;
    return role === "admin" || role === "coach";
  }

  root.session = {
    get: get,
    sync: sync,
    normalizeRole: normalizeRole,
    canManage: canManage
  };

  window.ClaritySession = root.session;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { sync("dom-ready"); });
  } else {
    sync("load");
  }
})();
