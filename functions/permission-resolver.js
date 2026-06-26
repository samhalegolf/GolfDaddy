"use strict";

const { encodeFilter, hasSupabase, json, text, email, supabaseFetch } = require("./payment-utils");

const PERMISSIONS = [
  "gps_round_start",
  "gps_round_pass",
  "gps_live_bubble",
  "practice_bubble_view",
  "my_bubble_view",
  "course_data_view",
  "course_bubble_view",
  "coach_admin_grant",
  "trial_access"
];

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed", allowed: ["POST"] });
  }

  if (!hasSupabase()) {
    return json(503, {
      ok: false,
      allowed: false,
      permissionKey: null,
      reasons: ["SUPABASE_MISCONFIGURED"],
      details: "Resolver storage dependency is not configured yet."
    });
  }

  const payload = safeParseBody(event.body);
  const permissionKey = text(payload.permissionKey, 80);
  const accountId = text(payload.accountId, 120);
  const profileId = text(payload.profileId, 120);
  const accountEmail = email(payload.accountEmail || payload.account_email || "");
  const requestContext = payload.context || {};

  if (!permissionKey || PERMISSIONS.indexOf(permissionKey) === -1) {
    return json(400, {
      ok: false,
      allowed: false,
      permissionKey,
      reasons: ["INVALID_PERMISSION_KEY"]
    });
  }

  if (!accountId && !accountEmail && !profileId) {
    return json(400, {
      ok: false,
      allowed: false,
      permissionKey,
      reasons: ["MISSING_ACCOUNT_ID_OR_EMAIL_OR_PROFILE"]
    });
  }

  const filters = [];
  if (permissionKey) filters.push("entitlement_type=eq." + encodeFilter(permissionKey));
  if (accountId || accountEmail || profileId) {
    const subjectFilters = [];
    if (accountId) subjectFilters.push("user_id=eq." + encodeFilter(accountId));
    if (accountEmail) subjectFilters.push("account_email=eq." + encodeFilter(accountEmail));
    if (profileId) subjectFilters.push("profile_id=eq." + encodeFilter(profileId));
    filters.push("or=(" + subjectFilters.join(",") + ")");
  }

  const query = "user_entitlements?select=id,user_id,account_email,profile_id,entitlement_type,status,starts_at,expires_at,metadata,usage_count&" + filters.join("&") + "&order=created_at.desc,expires_at.desc&limit=20";
  let rows = [];
  try {
    const data = await supabaseFetch(query, { method: "GET" });
    rows = Array.isArray(data) ? data : [];
  } catch (error) {
    return json(502, {
      ok: false,
      allowed: false,
      permissionKey,
      reasons: ["ENTITLEMENT_LOOKUP_FAILED"],
      accountId,
      profileId,
      requestContext: sanitizeContext(requestContext),
      detail: error && (error.body || error.message) ? (error.body || error.message) : String(error || "Unable to read entitlements")
    });
  }

  const evaluation = evaluatePermission(rows, permissionKey, profileId);
  return json(200, {
    ok: true,
    permissionKey,
    allowed: evaluation.allowed,
    reasons: evaluation.reasons,
    accountId,
    accountEmail,
    profileId,
    entitlement: evaluation.entitlement,
    requestContext: sanitizeContext(requestContext),
    evaluatedAt: new Date().toISOString()
  });
};

function evaluatePermission(rows, permissionKey, profileId) {
  const now = Date.now();
  const candidates = (rows || []).filter(function (row) {
    return String(row && row.entitlement_type || "") === permissionKey;
  });
  if (!candidates.length) {
    return {
      allowed: false,
      reasons: ["NO_ENTITLEMENT_FOUND"],
      entitlement: null
    };
  }

  const activeCandidates = candidates.filter(function (row) {
    return String(row.status || "").toLowerCase() === "active";
  });
  if (!activeCandidates.length) {
    return {
      allowed: false,
      reasons: ["ENTITLEMENT_NOT_ACTIVE"],
      entitlement: sanitizeEntitlement(candidates[0])
    };
  }

  const unexpiredCandidates = activeCandidates.filter(function (row) {
    if (!row.expires_at) return true;
    const expiresAt = new Date(row.expires_at).getTime();
    return Number.isFinite(expiresAt) ? expiresAt >= now : false;
  });
  if (!unexpiredCandidates.length) {
    return {
      allowed: false,
      reasons: ["ENTITLEMENT_EXPIRED"],
      entitlement: sanitizeEntitlement(activeCandidates[0])
    };
  }

  if (!profileId) {
    return {
      allowed: true,
      reasons: [],
      entitlement: sanitizeEntitlement(unexpiredCandidates[0])
    };
  }

  const profileCandidates = unexpiredCandidates.filter(function (row) {
    return !row.profile_id || row.profile_id === profileId;
  });
  if (!profileCandidates.length) {
    return {
      allowed: false,
      reasons: ["PROFILE_MISMATCH"],
      entitlement: sanitizeEntitlement(unexpiredCandidates[0])
    };
  }

  return {
    allowed: true,
    reasons: [],
    entitlement: sanitizeEntitlement(profileCandidates[0])
  };
}

function sanitizeEntitlement(row) {
  return {
    id: row && row.id || null,
    entitlement_type: row && row.entitlement_type || null,
    status: row && row.status || null,
    user_id: row && row.user_id || null,
    account_email: row && row.account_email || null,
    profile_id: row && row.profile_id || null,
    starts_at: row && row.starts_at || null,
    expires_at: row && row.expires_at || null,
    usage_count: row && row.usage_count
  };
}

function safeParseBody(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw || {};
  } catch (_error) {
    return {};
  }
}

function sanitizeContext(context) {
  return {
    route: text(context.route, 120),
    resourceId: text(context.resourceId || context.resource_id, 120),
    requestId: text(context.requestId || context.request_id, 120),
    scope: text(context.scope, 80)
  };
}
