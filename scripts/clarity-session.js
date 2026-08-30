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
    /* Signed out, the profile store still holds the previous owner's profiles
       (logout leaves them behind, and active() falls back to the first one).
       None of that may name, identify, or set the role of a guest session. */
    if (!account) profile = null;
    var role = normalizeRole(account && (account.role || account.permission) || profile && (profile.permission || profile.accountPermission || profile.mode));
    var paidAccess = safe(function () {
      return !!(window.ClarityPayments && typeof window.ClarityPayments.hasActiveAccess === "function" && window.ClarityPayments.hasActiveAccess());
    }, false);
    if (role === "player" && paidAccess) role = "subscribedPlayer";
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
      hasPaidAccess: paidAccess,
      paymentStatus: safe(function () {
        return window.ClarityPayments && typeof window.ClarityPayments.accessLabel === "function" ? window.ClarityPayments.accessLabel() : "";
      }, ""),
      isStaff: role === "admin" || role === "coach",
      reason: reason || "sync",
      updatedAt: new Date().toISOString()
    };
  }

  /* The five identity fields. A change in any of these is what "the session
     changed" means; everything else in the snapshot is presentation. */
  var IDENTITY_FIELDS = ["accountId", "accountRole", "ownProfileId", "viewedProfileId", "isSignedIn"];

  function changedFields(a, b) {
    if (!a || !b) return IDENTITY_FIELDS.slice();
    var out = [];
    for (var i = 0; i < IDENTITY_FIELDS.length; i += 1) {
      var key = IDENTITY_FIELDS[i];
      if (a[key] !== b[key]) out.push(key);
    }
    return out;
  }

  function sameSession(a, b) {
    return !!a && !!b && changedFields(a, b).length === 0;
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
    var diff = changedFields(current, next);
    var previous = current;
    current = next;
    applyToDom(current);
    if (diff.length) {
      /* Which fields flipped, why, and from what - recorded before dispatch so
         every listener (and the sync payload that ends up in Supabase) can see
         it. Production showed bursts of session-changed every ~10s during play
         with no way to tell WHAT changed; this is that answer. */
      var change = {
        fields: diff.slice(),
        reason: reason || "sync",
        from: {},
        to: {},
        at: Date.now()
      };
      for (var i = 0; i < diff.length; i += 1) {
        change.from[diff[i]] = previous ? previous[diff[i]] : undefined;
        change.to[diff[i]] = next[diff[i]];
      }
      safe(function () { window.__gdLastSessionChange = change; });
      safe(function () {
        var detail = Object.assign({}, current, { changedFields: diff.slice(), changeReason: change.reason });
        window.dispatchEvent(new CustomEvent("clarity:session-changed", { detail: detail }));
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
