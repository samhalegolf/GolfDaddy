(function () {
  "use strict";

  // Client-side convenience only. Server-side /api/permission-resolver is the source of truth.
  // Feature gates should treat this as a hint + transport layer and still fail closed.
  if (window.ClarityPermissions) return;

  var RESOLVER_ENDPOINT = "/api/permission-resolver";
  var DEFAULT_CACHE_TTL_SECONDS = 30;
  var permissionResultCache = {};
  var permissionRequestInFlight = {};

  function safe(fn, fallback) {
    try { return fn(); } catch (_e) { return fallback; }
  }

  function toText(value) {
    if (value == null) return "";
    return String(value);
  }

  function trim(value) {
    return toText(value).trim();
  }

  function identityToString(value) {
    return trim(value).toLowerCase();
  }

  function isObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function stableStringify(value) {
    if (value === null || value === undefined) return "null";
    var valueType = typeof value;
    if (valueType !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length; i++) parts.push(stableStringify(value[i]));
      return "[" + parts.join(",") + "]";
    }
    if (isObject(value)) {
      var keys = Object.keys(value).sort();
      var result = [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        result.push(JSON.stringify(key) + ":" + stableStringify(value[key]));
      }
      return "{" + result.join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function normalizeContext(context) {
    if (!isObject(context)) return "";
    return stableStringify(context);
  }

  function resolveIdentity(overrides) {
    var override = isObject(overrides) ? overrides : {};
    var account = safe(function () {
      return window.GolfDaddyAccounts && typeof window.GolfDaddyAccounts.current === "function" ? window.GolfDaddyAccounts.current() : null;
    }, null);
    var session = safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.get === "function" ? window.ClaritySession.get() : null;
    }, null);
    var profile = safe(function () {
      return typeof activePlayerProfile === "function" ? activePlayerProfile() : null;
    }, null);
    var role = identityToString(account && account.role || session && session.accountRole || session && session.role || profile && profile.accountPermission || profile && profile.permission || "");
    var isStaff = role === "admin" || role === "coach" || safe(function () {
      return !!(session && session.isStaff);
    }, false);
    return {
      accountId: trim(override.accountId || (account && account.accountId) || (session && session.accountId) || (profile && profile.accountId)),
      accountEmail: trim(override.accountEmail || (account && account.email) || (session && session.accountEmail) || ""),
      profileId: trim(override.profileId || (session && session.viewedProfileId) || (profile && profile.id) || (account && account.profileId) || ""),
      role: role,
      isStaff: isStaff
    };
  }

  function normalizePermissionKey(value) {
    return toText(value).trim();
  }

  function cacheKey(permissionKey, identity, context) {
    return [
      permissionKey || "",
      identity.accountId || "",
      identity.accountEmail || "",
      identity.profileId || "",
      identity.role || "",
      normalizeContext(context)
    ].join("|");
  }

  function now() {
    return Date.now();
  }

  function normalizeResponse(permissionKey, identity, context, body, response) {
    var responseBody = isObject(body) ? body : null;
    var responsePermissionKey = responseBody && responseBody.permissionKey ? String(responseBody.permissionKey) : "";
    var reasons = responseBody && Array.isArray(responseBody.reasons) ? responseBody.reasons : [];
    var allowed = responseBody && responseBody.allowed === true;
    var ok = !!responseBody && isObject(responseBody);
    if (!responseBody || !responseBody.hasOwnProperty("allowed")) {
      ok = false;
      reasons = reasons.length ? reasons : ["INVALID_PAYLOAD"];
    }
    return {
      ok: ok,
      allowed: !!(response && response.ok && allowed),
      permissionKey: responsePermissionKey || permissionKey || "",
      reasons: reasons,
      entitlement: responseBody ? responseBody.entitlement || null : null,
      raw: responseBody,
      error: null
    };
  }

  function missingIdentityResult(permissionKey, accountId, accountEmail, profileId) {
    return {
      ok: false,
      allowed: false,
      permissionKey: permissionKey || "",
      reasons: ["MISSING_ACCOUNT_ID_OR_EMAIL_OR_PROFILE"],
      entitlement: null,
      raw: null,
      error: "Missing identity for permission check (" + (accountId ? "accountId" : accountEmail ? "accountEmail" : "profileId") + ")"
    };
  }

  function roleBypassResult(permissionKey, identity, context) {
    return {
      ok: true,
      allowed: true,
      permissionKey: normalizePermissionKey(permissionKey),
      reasons: ["staff_role_bypass"],
      entitlement: null,
      raw: { allowed: true, permissionKey: permissionKey || "", context: context || {}, source: "client-role-bypass" },
      error: null
    };
  }

  function requestFromResolver(permissionKey, context, identity) {
    var normalizedPermissionKey = normalizePermissionKey(permissionKey);
    if (!normalizedPermissionKey) {
      return Promise.resolve({
        ok: false,
        allowed: false,
        permissionKey: "",
        reasons: ["MISSING_PERMISSION_KEY"],
        entitlement: null,
        raw: null,
        error: "permissionKey is required"
      });
    }
    if (!identity.accountId && !identity.accountEmail && !identity.profileId) return Promise.resolve(missingIdentityResult(normalizedPermissionKey));
    if (identity.isStaff) return Promise.resolve(roleBypassResult(normalizedPermissionKey, identity, context));

    var key = cacheKey(normalizedPermissionKey, identity, context);
    var cached = safe(function () { return permissionResultCache[key]; }, null);
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.result);
    if (permissionRequestInFlight[key]) return permissionRequestInFlight[key];

    var payload = {
      permissionKey: normalizedPermissionKey,
      accountId: identity.accountId,
      accountEmail: identity.accountEmail,
      profileId: identity.profileId,
      context: isObject(context) ? context : {}
    };

    var request = fetch(RESOLVER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.text().then(function (text) {
        var body = null;
        try { body = JSON.parse(text); } catch (_e) { body = null; }
        var base = normalizeResponse(normalizedPermissionKey, identity, context, body, response);
        if (!base.ok) {
          base.allowed = false;
          base.error = base.error || "Invalid resolver payload";
        } else if (!response.ok) {
          base.ok = false;
          base.error = (body && body.error) ? toText(body.error) : ("Resolver HTTP " + String(response.status || ""));
        }
        if (base.error === null && Array.isArray(base.reasons) && base.reasons.indexOf("INVALID_PERMISSION_KEY") === -1 && !base.allowed) {
          base.reasons = base.reasons.length ? base.reasons : ["DENIED"];
        }
        var ttl = Number(body && body.cacheTtlSeconds);
        if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_CACHE_TTL_SECONDS;
        permissionResultCache[key] = { result: base, expiresAt: now() + ttl * 1000 };
        return base;
      });
    }).catch(function (error) {
      return {
        ok: false,
        allowed: false,
        permissionKey: normalizedPermissionKey,
        reasons: ["RESOLVER_REQUEST_FAILED"],
        entitlement: null,
        raw: null,
        error: error && error.message ? toText(error.message) : "Resolver request failed"
      };
    }).finally(function () {
      delete permissionRequestInFlight[key];
    });

    permissionRequestInFlight[key] = request;
    return request;
  }

  function matchesIdentity(identity) {
    return identity.accountId || identity.accountEmail || identity.profileId;
  }

  window.ClarityPermissions = {
    canUse: function (permissionKey, context, accountId, accountEmail, profileId) {
      var normalizedPermissionKey = normalizePermissionKey(permissionKey);
      var identity = resolveIdentity({
        accountId: accountId,
        accountEmail: accountEmail,
        profileId: profileId
      });
      if (!normalizedPermissionKey) {
        return Promise.resolve({
          ok: false,
          allowed: false,
          permissionKey: "",
          reasons: ["MISSING_PERMISSION_KEY"],
          entitlement: null,
          raw: null,
          error: "permissionKey is required"
        });
      }
      if (!matchesIdentity(identity)) {
        return Promise.resolve(missingIdentityResult(normalizedPermissionKey, identity.accountId, identity.accountEmail, identity.profileId));
      }
      return requestFromResolver(normalizedPermissionKey, isObject(context) ? context : {}, identity);
    },
    requirePermission: function (permissionKey, context, accountId, accountEmail, profileId) {
      return this.canUse(permissionKey, context, accountId, accountEmail, profileId);
    },
    clearCache: function () {
      permissionResultCache = {};
      permissionRequestInFlight = {};
      return true;
    }
  };
})();
