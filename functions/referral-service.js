"use strict";

const crypto = require("crypto");
const {
  ADMIN_COMPED_MEMBERSHIP_KEY,
  REFERRAL_ACCESS_KEY,
  appUrl,
  email,
  encodeFilter,
  env,
  membershipAccessState,
  readPaidAccess,
  stripeFetch,
  supabaseFetch,
  text
} = require("./payment-utils");

const REFERRAL_STATUS_ACTIVE = {
  accepted: true,
  free_month_active: true,
  free_month_ended: true,
  converted: true,
  reward_earned: true
};

const ACTIVE_INVITE_STATUSES = { open: true, opened: true };

function config() {
  return {
    enabled: env("CLARITY_REFERRALS_ENABLED") !== "0",
    freeAccessDays: intEnv("CLARITY_REFERRAL_FREE_ACCESS_DAYS", 30, 1, 730),
    inviteExpiryDays: intEnv("CLARITY_REFERRAL_INVITE_EXPIRY_DAYS", 30, 1, 365),
    maxOutstandingInvites: intEnv("CLARITY_REFERRAL_MAX_OUTSTANDING_INVITES", 10, 1, 100),
    maxStackedRewards: intEnv("CLARITY_REFERRAL_MAX_UNAPPLIED_REWARDS", intEnv("CLARITY_REFERRAL_MAX_STACKED_REWARDS", 12, 1, 24), 1, 24),
    refundReviewDays: intEnv("CLARITY_REFERRAL_REFUND_REVIEW_DAYS", 14, 0, 365)
  };
}

function intEnv(name, fallback, min, max) {
  const value = Number(env(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function accountId(account) {
  return text(account && (account.account_id || account.accountId), 120);
}

function accountEmail(account) {
  return email(account && (account.email || account.account_email || account.accountEmail));
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(baseMs, days) {
  return new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function newReferralToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function requestHash(event, field) {
  const headers = event && event.headers || {};
  const raw = text(headers[field] || headers[field && field.toLowerCase()] || headers["x-forwarded-for"] || headers["X-Forwarded-For"], 400);
  if (!raw) return null;
  const salt = env("CLARITY_REFERRAL_HASH_SALT") || env("STRIPE_WEBHOOK_SECRET") || "clarity-referral";
  return crypto.createHash("sha256").update(salt + ":" + raw.split(",")[0].trim(), "utf8").digest("hex");
}

function referralUrl(token) {
  const base = (env("CLARITY_REFERRAL_URL_BASE") || appUrl()).replace(/\/+$/, "");
  return base + "/?ref=" + encodeURIComponent(token);
}

function publicInvitation(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    friendName: row.friend_name || "",
    inviterName: row.attribution_metadata && row.attribution_metadata.inviter_name || "",
    inviteeEmail: row.invitee_email || row.invitee_account_email || "",
    inviteeAccountId: row.invitee_account_id || "",
    createdAt: row.created_at || "",
    expiresAt: row.expires_at || "",
    acceptedAt: row.accepted_at || "",
    freeAccessStartedAt: row.free_access_started_at || "",
    freeAccessEndsAt: row.free_access_ends_at || "",
    firstPaidInvoiceAt: row.first_paid_invoice_at || "",
    rewardEarnedAt: row.reward_earned_at || "",
    invalidReason: row.invalid_reason || "",
    revokedReason: row.revoked_reason || "",
    riskFlags: Array.isArray(row.risk_flags) ? row.risk_flags : []
  };
}

function publicReward(row) {
  if (!row) return null;
  return {
    id: row.id,
    referralId: row.referral_id,
    rewardType: row.reward_type,
    status: row.status,
    earnedAt: row.earned_at || "",
    scheduledFor: row.scheduled_for || "",
    appliedAt: row.applied_at || "",
    reversedAt: row.reversed_at || "",
    creditAmount: row.credit_amount || null,
    creditCurrency: row.credit_currency || "",
    reversalReason: row.reversal_reason || ""
  };
}

async function recordReferralEvent(eventType, payload) {
  payload = payload || {};
  await supabaseFetch("referral_analytics_events", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      event_type: text(eventType, 120),
      referral_id: payload.referralId || null,
      account_id: payload.accountId || null,
      actor_account_id: payload.actorAccountId || null,
      metadata: stripSecureMetadata(payload.metadata || {})
    })
  }).catch(function () {});
}

function stripSecureMetadata(metadata) {
  const next = {};
  Object.keys(metadata || {}).forEach(function (key) {
    if (/token|secret|payment_method|card/i.test(key)) return;
    next[key] = metadata[key];
  });
  return next;
}

async function createReferralInvite(account, options) {
  options = options || {};
  const cfg = config();
  if (!cfg.enabled) throw badRequest("Referral programme is not enabled", 503);

  const inviterId = accountId(account);
  const inviterEmail = accountEmail(account);
  if (!inviterId) throw badRequest("Sign in before creating a referral invite", 401);
  const eligibility = await inviterEligibility(account);
  if (!eligibility.eligible) throw badRequest(eligibility.reason || "Monthly Membership required", 403);

  const outstanding = await activeOutstandingInvites(inviterId);
  if (outstanding.length >= cfg.maxOutstandingInvites) {
    throw badRequest("You already have the maximum outstanding referral invites", 429);
  }

  const token = newReferralToken();
  const now = Date.now();
  const payload = options.payload || {};
  const row = {
    inviter_account_id: inviterId,
    inviter_account_email: inviterEmail || null,
    token_hash: hashToken(token),
    status: "open",
    friend_name: text(payload.friendName || payload.friend_name, 160) || null,
    invitee_email: email(payload.friendEmail || payload.inviteeEmail || payload.email) || null,
    expires_at: addDaysIso(now, cfg.inviteExpiryDays),
    created_by_ip_hash: requestHash(options.event, "x-forwarded-for"),
    attribution_metadata: {
      source: "member_referral",
      inviter_name: text(account && (account.name || account.name_display), 160),
      free_access_days: cfg.freeAccessDays,
      invite_expiry_days: cfg.inviteExpiryDays
    },
    audit_metadata: {
      created_by: "referrals_api",
      created_at: new Date(now).toISOString()
    }
  };

  const inserted = await supabaseFetch("referral_invitations", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(row)
  });
  const referral = Array.isArray(inserted) ? inserted[0] : inserted;
  await recordReferralEvent("referral_invite_created", {
    referralId: referral && referral.id,
    accountId: inviterId,
    actorAccountId: inviterId,
    metadata: { status: "open", targeted: !!row.invitee_email }
  });
  return {
    ok: true,
    invitation: publicInvitation(referral),
    shareUrl: referralUrl(token),
    tokenExpiresAt: row.expires_at
  };
}

async function activeOutstandingInvites(inviterId) {
  const rows = await supabaseFetch("referral_invitations?select=*&inviter_account_id=eq." + encodeFilter(inviterId) + "&order=created_at.desc&limit=100", { method: "GET" });
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).filter(function (row) {
    if (!ACTIVE_INVITE_STATUSES[String(row.status || "")]) return false;
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
    return !Number.isFinite(expires) || expires > now;
  });
}

async function inviterEligibility(account) {
  const inviterId = accountId(account);
  const inviterEmail = accountEmail(account);
  const rows = await membershipRows(inviterId, inviterEmail);
  const membership = rows.find(isActivePaidMembership) || null;
  const compedMembership = membership ? null : await activeAdminCompedMembership(inviterId, inviterEmail);
  const eligible = !!(membership || compedMembership);
  return {
    eligible,
    reason: eligible ? "" : "Only active paid or admin-comped Monthly Membership customers can send referral invites.",
    eligibilitySource: membership ? "paid_membership" : compedMembership ? "admin_comped_membership" : "",
    membership,
    compedMembership
  };
}

async function membershipRows(userId, userEmail) {
  const filters = [];
  if (userId) filters.push("user_id.eq." + encodeFilter(userId));
  if (userEmail) filters.push("account_email.eq." + encodeFilter(userEmail));
  if (!filters.length) return [];
  const rows = await supabaseFetch("caddie_memberships?select=*&or=(" + filters.join(",") + ")&order=updated_at.desc&limit=20", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows : [];
}

function isActivePaidMembership(row) {
  if (!row) return false;
  const state = membershipAccessState(row);
  const status = String(row.status || "").toLowerCase();
  return !!(
    state.active &&
    status === "active" &&
    row.stripe_subscription_id &&
    row.last_paid_invoice_id
  );
}

async function activeAdminCompedMembership(userId, userEmail) {
  const filters = [];
  if (userId) filters.push("user_id.eq." + encodeFilter(userId));
  if (userEmail) filters.push("account_email.eq." + encodeFilter(userEmail));
  if (!filters.length) return null;
  const rows = await supabaseFetch("user_entitlements?select=*&or=(" + filters.join(",") + ")&status=eq.active&order=expires_at.desc.nullsfirst,created_at.desc&limit=100", { method: "GET" }).catch(function () { return []; });
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).find(function (row) {
    const key = String(row && (row.product_key || row.entitlement_type || row.metadata && row.metadata.product_key) || "").trim().toLowerCase();
    const reason = String(row && (row.entitlement_reason || row.metadata && row.metadata.entitlement_reason || row.metadata && row.metadata.source) || "").trim().toLowerCase();
    const explicit = row && (row.referral_eligible === true || row.metadata && row.metadata.allow_member_referrals === true);
    if (!explicit) return false;
    if (key !== ADMIN_COMPED_MEMBERSHIP_KEY && reason !== ADMIN_COMPED_MEMBERSHIP_KEY) return false;
    const starts = row.starts_at ? new Date(row.starts_at).getTime() : 0;
    const expires = row.expires_at ? new Date(row.expires_at).getTime() : Infinity;
    return (!Number.isFinite(starts) || starts <= now) && (!Number.isFinite(expires) || expires > now);
  }) || null;
}

async function openReferralToken(token, options) {
  const referral = await referralByToken(token);
  if (!referral) throw badRequest("Referral link is invalid", 404);
  const valid = validateReferralForOpening(referral);
  if (!valid.ok) return { ok: false, invalid: true, reason: valid.reason, invitation: publicInvitation(referral) };
  let row = referral;
  if (row.status === "open") {
    row = await patchReferral(row.id, {
      status: "opened",
      opened_at: nowIso(),
      opened_by_ip_hash: requestHash(options && options.event, "x-forwarded-for"),
      updated_at: nowIso()
    });
    await recordReferralEvent("referral_link_opened", {
      referralId: row.id,
      accountId: row.inviter_account_id,
      metadata: { status: "opened" }
    });
  }
  return { ok: true, invitation: publicInvitation(row), message: "A real free month. No card. No automatic renewal." };
}

function validateReferralForOpening(referral) {
  if (!referral) return { ok: false, reason: "invalid" };
  const status = String(referral.status || "");
  if (status === "revoked") return { ok: false, reason: referral.revoked_reason || "revoked" };
  if (status === "invalid") return { ok: false, reason: referral.invalid_reason || "invalid" };
  if (!ACTIVE_INVITE_STATUSES[status] && !REFERRAL_STATUS_ACTIVE[status]) return { ok: false, reason: "already consumed" };
  if (referral.expires_at && new Date(referral.expires_at).getTime() <= Date.now() && ACTIVE_INVITE_STATUSES[status]) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

async function referralByToken(token) {
  const clean = text(token, 500);
  if (!clean) return null;
  const rows = await supabaseFetch("referral_invitations?select=*&token_hash=eq." + encodeFilter(hashToken(clean)) + "&limit=1", { method: "GET" });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function acceptReferralInvite(account, token, options) {
  const cfg = config();
  if (!cfg.enabled) throw badRequest("Referral programme is not enabled", 503);
  const inviteeId = accountId(account);
  const inviteeEmail = accountEmail(account);
  if (!inviteeId) throw badRequest("Sign in before accepting a referral invite", 401);

  let referral = await referralByToken(token);
  if (!referral) throw badRequest("Referral link is invalid", 404);
  const opened = validateReferralForOpening(referral);
  if (!opened.ok) throw badRequest("Referral link is " + opened.reason, 409);
  if (referral.inviter_account_id === inviteeId) throw badRequest("Self-referrals are not allowed", 409);
  if (canonicalEmail(referral.inviter_account_email) && canonicalEmail(referral.inviter_account_email) === canonicalEmail(inviteeEmail)) {
    throw badRequest("Self-referrals are not allowed", 409);
  }
  if (!ACTIVE_INVITE_STATUSES[String(referral.status || "")] && referral.invitee_account_id !== inviteeId) {
    throw badRequest("Referral link has already been accepted", 409);
  }

  const existingClaim = await claimedReferralForInvitee(inviteeId, inviteeEmail);
  if (existingClaim && existingClaim.id !== referral.id) {
    throw badRequest("This account has already claimed a referral", 409);
  }

  const isSameAcceptedReferral = existingClaim && existingClaim.id === referral.id;
  if (!isSameAcceptedReferral) {
    if (!accountLooksNewForReferral(account, referral)) throw badRequest("Referral access is only for new Clarity accounts", 409);
    if (await hasPriorAccess(inviteeId, inviteeEmail, referral.id)) {
      throw badRequest("This account has already had paid or promotional access", 409);
    }
  }

  const riskFlags = riskFlagsFor(referral, account);
  const start = referral.free_access_started_at || nowIso();
  const end = referral.free_access_ends_at || addDaysIso(new Date(start).getTime(), cfg.freeAccessDays);
  referral = await patchReferral(referral.id, {
    status: "accepted",
    invitee_account_id: inviteeId,
    invitee_account_email: inviteeEmail || null,
    invitee_email: inviteeEmail || referral.invitee_email || null,
    accepted_at: referral.accepted_at || nowIso(),
    free_access_started_at: start,
    free_access_ends_at: end,
    accepted_by_ip_hash: requestHash(options && options.event, "x-forwarded-for"),
    risk_flags: riskFlags,
    attribution_metadata: Object.assign({}, referral.attribution_metadata || {}, {
      accepted_via: "referrals_api",
      invitee_email_alias_key: canonicalEmail(inviteeEmail)
    }),
    updated_at: nowIso()
  });

  await startReferralEntitlement(referral, account, start, end);
  referral = await patchReferral(referral.id, { status: "free_month_active", updated_at: nowIso() });
  await recordReferralEvent("referral_invite_accepted", {
    referralId: referral.id,
    accountId: inviteeId,
    actorAccountId: inviteeId,
    metadata: { inviter_account_id: referral.inviter_account_id, risk_flags: riskFlags }
  });
  await recordReferralEvent("referral_access_started", {
    referralId: referral.id,
    accountId: inviteeId,
    actorAccountId: inviteeId,
    metadata: { free_access_ends_at: end }
  });
  return {
    ok: true,
    invitation: publicInvitation(referral),
    freeAccess: { startsAt: start, endsAt: end, productKey: REFERRAL_ACCESS_KEY }
  };
}

async function claimedReferralForInvitee(inviteeId, inviteeEmail) {
  const filters = [];
  if (inviteeId) filters.push("invitee_account_id.eq." + encodeFilter(inviteeId));
  if (inviteeEmail) filters.push("invitee_account_email.eq." + encodeFilter(inviteeEmail));
  if (!filters.length) return null;
  const rows = await supabaseFetch("referral_invitations?select=*&or=(" + filters.join(",") + ")&order=created_at.desc&limit=20", { method: "GET" }).catch(function () { return []; });
  return (Array.isArray(rows) ? rows : []).find(function (row) {
    return REFERRAL_STATUS_ACTIVE[String(row.status || "")];
  }) || null;
}

function accountLooksNewForReferral(account, referral) {
  const createdAt = account && account.created_at ? new Date(account.created_at).getTime() : NaN;
  const invitedAt = referral && referral.created_at ? new Date(referral.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAt) || !Number.isFinite(invitedAt)) return true;
  return createdAt >= invitedAt - 5 * 60 * 1000;
}

async function hasPriorAccess(inviteeId, inviteeEmail, referralId) {
  const filters = [];
  if (inviteeId) filters.push("user_id.eq." + encodeFilter(inviteeId));
  if (inviteeEmail) filters.push("account_email.eq." + encodeFilter(inviteeEmail));
  if (!filters.length) return false;
  const memberships = await supabaseFetch("caddie_memberships?select=id,user_id,account_email,status&or=(" + filters.join(",") + ")&limit=1", { method: "GET" }).catch(function () { return []; });
  if (Array.isArray(memberships) && memberships.length) return true;
  const entitlements = await supabaseFetch("user_entitlements?select=id,source_referral_id,product_key,entitlement_type,status&or=(" + filters.join(",") + ")&limit=100", { method: "GET" }).catch(function () { return []; });
  return (Array.isArray(entitlements) ? entitlements : []).some(function (row) {
    return String(row.source_referral_id || "") !== String(referralId || "");
  });
}

function canonicalEmail(value) {
  const clean = email(value);
  if (!clean) return "";
  const parts = clean.split("@");
  let local = parts[0];
  let domain = parts[1];
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split("+")[0].replace(/\./g, "");
  return local + "@" + domain;
}

function riskFlagsFor(referral, account) {
  const flags = [];
  if (canonicalEmail(referral && referral.inviter_account_email) === canonicalEmail(accountEmail(account))) flags.push("same_email_alias");
  if (referral && referral.inviter_account_id === accountId(account)) flags.push("same_account_id");
  return flags;
}

async function startReferralEntitlement(referral, account, startsAt, endsAt) {
  const body = {
    user_id: accountId(account),
    account_email: accountEmail(account) || null,
    profile_id: text(account && (account.profile_id || account.profileId), 120) || null,
    entitlement_type: REFERRAL_ACCESS_KEY,
    product_key: REFERRAL_ACCESS_KEY,
    status: "active",
    starts_at: startsAt,
    expires_at: endsAt,
    source_type: "referral",
    source_referral_id: referral.id,
    entitlement_reason: "referral_free_month",
    referral_eligible: false,
    non_renewing: true,
    scheduled_paid_start_at: null,
    metadata: {
      source: "referral",
      entitlement_reason: "referral_free_month",
      source_referral_id: referral.id,
      inviter_account_id: referral.inviter_account_id,
      membership_level: true,
      no_card_required: true,
      non_renewing: true,
      automatic_renewal: false
    },
    updated_at: nowIso()
  };
  const existing = await supabaseFetch("user_entitlements?select=id&source_type=eq.referral&source_referral_id=eq." + encodeFilter(referral.id) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  if (Array.isArray(existing) && existing[0] && existing[0].id) {
    await supabaseFetch("user_entitlements?id=eq." + encodeFilter(existing[0].id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(body)
    });
    return;
  }
  await supabaseFetch("user_entitlements", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(body)
  });
}

async function revokeReferralInvite(account, referralId, reason) {
  const inviterId = accountId(account);
  if (!inviterId) throw badRequest("Sign in before revoking an invite", 401);
  const referral = await referralById(referralId);
  if (!referral || referral.inviter_account_id !== inviterId) throw badRequest("Referral invite not found", 404);
  if (!ACTIVE_INVITE_STATUSES[String(referral.status || "")]) throw badRequest("Only unaccepted referral invites can be revoked", 409);
  const row = await patchReferral(referral.id, {
    status: "revoked",
    revoked_reason: text(reason, 300) || "revoked_by_inviter",
    revoked_at: nowIso(),
    updated_at: nowIso()
  });
  return { ok: true, invitation: publicInvitation(row) };
}

async function referralById(id) {
  const clean = text(id, 80);
  if (!clean) return null;
  const rows = await supabaseFetch("referral_invitations?select=*&id=eq." + encodeFilter(clean) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchReferral(id, patch) {
  const rows = await supabaseFetch("referral_invitations?id=eq." + encodeFilter(id), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(patch)
  });
  if (Array.isArray(rows) && rows[0]) return rows[0];
  return await referralById(id) || Object.assign({ id }, patch);
}

async function patchReward(id, patch) {
  const rows = await supabaseFetch("referral_reward_ledger?id=eq." + encodeFilter(id), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(Object.assign({}, patch, { updated_at: nowIso() }))
  });
  return Array.isArray(rows) ? rows[0] || Object.assign({ id }, patch) : Object.assign({ id }, patch);
}

async function prepareReferredMembershipCheckout(account) {
  const referral = await activeReferralForInvitee(account);
  if (!referral) return null;
  const endsAt = referral.free_access_ends_at;
  const endMs = endsAt ? new Date(endsAt).getTime() : NaN;
  if (!Number.isFinite(endMs) || endMs <= Date.now()) {
    await expireReferral(referral);
    return null;
  }
  const plannedStart = new Date(endMs).toISOString();
  const metadata = Object.assign({}, referral.audit_metadata || {}, {
    checkout_started_at: nowIso(),
    planned_paid_start_at: plannedStart
  });
  await patchReferral(referral.id, {
    status: "free_month_active",
    planned_paid_start_at: plannedStart,
    paid_membership_started_at: referral.paid_membership_started_at || nowIso(),
    audit_metadata: metadata,
    updated_at: nowIso()
  });
  await supabaseFetch("user_entitlements?source_type=eq.referral&source_referral_id=eq." + encodeFilter(referral.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      scheduled_paid_start_at: plannedStart,
      updated_at: nowIso()
    })
  }).catch(function () {});
  await recordReferralEvent("referral_checkout_started", {
    referralId: referral.id,
    accountId: accountId(account),
    actorAccountId: accountId(account),
    metadata: { planned_paid_start_at: plannedStart }
  });
  return {
    referralId: referral.id,
    inviterAccountId: referral.inviter_account_id,
    freeAccessEndsAt: plannedStart,
    trialEnd: Math.floor(endMs / 1000)
  };
}

async function activeReferralForInvitee(account) {
  const inviteeId = accountId(account);
  const inviteeEmail = accountEmail(account);
  const filters = [];
  if (inviteeId) filters.push("invitee_account_id.eq." + encodeFilter(inviteeId));
  if (inviteeEmail) filters.push("invitee_account_email.eq." + encodeFilter(inviteeEmail));
  if (!filters.length) return null;
  const rows = await supabaseFetch("referral_invitations?select=*&or=(" + filters.join(",") + ")&order=created_at.desc&limit=20", { method: "GET" }).catch(function () { return []; });
  const now = Date.now();
  const active = (Array.isArray(rows) ? rows : []).find(function (row) {
    const status = String(row.status || "");
    const end = row.free_access_ends_at ? new Date(row.free_access_ends_at).getTime() : NaN;
    return status === "free_month_active" && Number.isFinite(end) && end > now;
  }) || null;
  return active;
}

async function expireReferral(referral) {
  if (!referral || referral.status === "free_month_ended" || referral.status === "reward_earned") return referral;
  const row = await patchReferral(referral.id, {
    status: "free_month_ended",
    updated_at: nowIso()
  });
  await supabaseFetch("user_entitlements?source_type=eq.referral&source_referral_id=eq." + encodeFilter(referral.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "expired", updated_at: nowIso() })
  }).catch(function () {});
  return row;
}

async function evaluateReferralConversion(input) {
  input = input || {};
  const invoice = input.invoice || {};
  const subscription = input.subscription || {};
  const userId = text(input.userId, 120);
  const userEmail = email(input.accountEmail);
  const amountPaid = Number(invoice.amount_paid);
  if (!invoice.id || !subscription.id || !userId || !Number.isFinite(amountPaid) || amountPaid <= 0) return null;

  const referral = await referralForConvertedInvitee(userId, userEmail);
  if (!referral || referral.reward_earned_at) return null;
  if (referral.first_paid_invoice_id && referral.first_paid_invoice_id !== invoice.id) return null;
  const existingReward = await rewardForReferral(referral.id);
  if (existingReward) return existingReward;

  await patchReferral(referral.id, {
    status: "converted",
    paid_membership_started_at: referral.paid_membership_started_at || nowIso(),
    first_paid_invoice_at: nowIso(),
    first_paid_invoice_id: invoice.id,
    stripe_subscription_id: subscription.id,
    stripe_customer_id: text(subscription.customer || invoice.customer, 200) || null,
    updated_at: nowIso()
  });
  await recordReferralEvent("referral_first_paid_invoice_succeeded", {
    referralId: referral.id,
    accountId: userId,
    actorAccountId: userId,
    metadata: { invoice_id: invoice.id, amount_paid: amountPaid, currency: invoice.currency || "" }
  });

  const reward = await earnReferralReward(referral, invoice, subscription);
  await patchReferral(referral.id, {
    status: "reward_earned",
    reward_earned_at: reward.earned_at || nowIso(),
    updated_at: nowIso()
  });
  await recordReferralEvent("referral_reward_earned", {
    referralId: referral.id,
    accountId: referral.inviter_account_id,
    actorAccountId: userId,
    metadata: { reward_id: reward.id, invoice_id: invoice.id }
  });
  return reward;
}

async function referralForConvertedInvitee(userId, userEmail) {
  const filters = [];
  if (userId) filters.push("invitee_account_id.eq." + encodeFilter(userId));
  if (userEmail) filters.push("invitee_account_email.eq." + encodeFilter(userEmail));
  if (!filters.length) return null;
  const rows = await supabaseFetch("referral_invitations?select=*&or=(" + filters.join(",") + ")&order=created_at.desc&limit=20", { method: "GET" }).catch(function () { return []; });
  return (Array.isArray(rows) ? rows : []).find(function (row) {
    return REFERRAL_STATUS_ACTIVE[String(row.status || "")] && !row.reward_earned_at;
  }) || null;
}

async function rewardForReferral(referralId) {
  const rows = await supabaseFetch("referral_reward_ledger?select=*&referral_id=eq." + encodeFilter(referralId) + "&reward_type=eq.free_membership_month&limit=1", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function earnReferralReward(referral, invoice, subscription) {
  const cfg = config();
  const activeRewards = await rewardBalance(referral.inviter_account_id);
  const baseStatus = activeRewards >= cfg.maxStackedRewards ? "pending" : "available";
  const idempotencyKey = "referral_reward_" + referral.id;
  const inserted = await supabaseFetch("referral_reward_ledger?on_conflict=idempotency_key", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({
      inviter_account_id: referral.inviter_account_id,
      inviter_account_email: referral.inviter_account_email || null,
      referral_id: referral.id,
      reward_type: "free_membership_month",
      reward_quantity: 1,
      reward_duration_days: 30,
      status: baseStatus,
      earned_at: nowIso(),
      qualifying_stripe_invoice_id: invoice.id,
      qualifying_stripe_subscription_id: subscription.id,
      stripe_invoice_id: invoice.id,
      credit_amount: Number(invoice.amount_paid) || null,
      credit_currency: text(invoice.currency, 20) || null,
      idempotency_key: idempotencyKey,
      audit_metadata: {
        source: "stripe_webhook",
        max_stacked_rewards: cfg.maxStackedRewards,
        held_by_max_balance: baseStatus === "pending"
      }
    })
  });
  let reward = Array.isArray(inserted) && inserted[0] ? inserted[0] : await rewardForReferral(referral.id);
  if (baseStatus === "available") reward = await applyReferralReward(reward, referral, invoice);
  return reward;
}

async function rewardBalance(inviterId) {
  const rows = await supabaseFetch("referral_reward_ledger?select=id,status&inviter_account_id=eq." + encodeFilter(inviterId) + "&limit=100", { method: "GET" }).catch(function () { return []; });
  return (Array.isArray(rows) ? rows : []).filter(function (row) {
    return row.status === "available" || row.status === "scheduled";
  }).length;
}

async function applyReferralReward(reward, referral, invoice) {
  if (!reward || reward.status !== "available") return reward;
  const account = await accountById(referral.inviter_account_id);
  const customerId = text(account && account.stripe_customer_id, 200);
  const memberships = await membershipRows(referral.inviter_account_id, referral.inviter_account_email);
  const membership = memberships.find(isActivePaidMembership);
  if (!customerId || !membership || !membership.stripe_subscription_id) {
    return patchReward(reward.id, {
      status: "available",
      audit_metadata: Object.assign({}, reward.audit_metadata || {}, {
        application_blocked: "inviter_membership_not_active",
        blocked_at: nowIso()
      })
    });
  }

  const subscription = await stripeFetch("GET", "/v1/subscriptions/" + encodeURIComponent(membership.stripe_subscription_id), {
    "expand[]": ["items.data.price", "latest_invoice"]
  }).catch(function () { return null; });
  const price = subscription && subscription.items && Array.isArray(subscription.items.data) && subscription.items.data[0] && subscription.items.data[0].price || null;
  const amount = positiveInteger(price && price.unit_amount) || positiveInteger(invoice.amount_paid);
  const currency = text(price && price.currency || invoice.currency, 20).toLowerCase();
  if (!amount || !currency) {
    return patchReward(reward.id, {
      status: "available",
      audit_metadata: Object.assign({}, reward.audit_metadata || {}, {
        application_blocked: "missing_credit_amount",
        blocked_at: nowIso()
      })
    });
  }

  const idempotencyKey = "referral_credit_" + reward.id;
  const transaction = await stripeFetch("POST", "/v1/customers/" + encodeURIComponent(customerId) + "/balance_transactions", {
    amount: -amount,
    currency,
    description: "Clarity Caddy referral reward - one Monthly Membership period",
    "metadata[app]": "clarity-caddie",
    "metadata[referral_id]": referral.id,
    "metadata[referral_reward_id]": reward.id,
    "metadata[reward_type]": "free_membership_month"
  }, { headers: { "Idempotency-Key": idempotencyKey } });

  const scheduled = await patchReward(reward.id, {
    status: "scheduled",
    scheduled_for: membership.current_period_end || membership.access_until || null,
    stripe_customer_id: customerId,
    stripe_subscription_id: membership.stripe_subscription_id,
    stripe_customer_balance_transaction_id: transaction && transaction.id || null,
    credit_amount: amount,
    credit_currency: currency,
    idempotency_key: idempotencyKey,
    audit_metadata: Object.assign({}, reward.audit_metadata || {}, {
      stripe_mechanism: "customer_balance_credit",
      credit_transaction_created_at: nowIso()
    })
  });
  await recordReferralEvent("referral_reward_scheduled", {
    referralId: referral.id,
    accountId: referral.inviter_account_id,
    metadata: { reward_id: reward.id, stripe_customer_balance_transaction_id: transaction && transaction.id || null }
  });
  return scheduled;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

async function accountById(id) {
  const rows = await supabaseFetch("app_accounts?select=*&account_id=eq." + encodeFilter(id) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function markScheduledRewardAppliedForInvoice(input) {
  input = input || {};
  const invoice = input.invoice || {};
  const subscription = input.subscription || {};
  const inviterId = text(input.userId, 120);
  if (!invoice.id || !subscription.id || !inviterId) return null;
  const creditLikelyApplied = Number(invoice.starting_balance) < 0 || (Number(invoice.amount_paid) === 0 && Number(invoice.amount_due) >= 0);
  if (!creditLikelyApplied) return null;
  const rows = await supabaseFetch("referral_reward_ledger?select=*&inviter_account_id=eq." + encodeFilter(inviterId) + "&stripe_subscription_id=eq." + encodeFilter(subscription.id) + "&status=eq.scheduled&order=scheduled_for.asc.nullslast,created_at.asc&limit=1", { method: "GET" }).catch(function () { return []; });
  const reward = Array.isArray(rows) ? rows[0] || null : null;
  if (!reward || reward.qualifying_stripe_invoice_id === invoice.id) return null;
  const applied = await patchReward(reward.id, {
    status: "applied",
    applied_at: nowIso(),
    stripe_invoice_id: invoice.id,
    audit_metadata: Object.assign({}, reward.audit_metadata || {}, {
      applied_by_invoice_paid: invoice.id,
      invoice_amount_paid: invoice.amount_paid || null,
      invoice_starting_balance: invoice.starting_balance || null
    })
  });
  await recordReferralEvent("referral_reward_applied", {
    referralId: reward.referral_id,
    accountId: inviterId,
    metadata: { reward_id: reward.id, invoice_id: invoice.id }
  });
  return applied;
}

async function reversePendingReferralRewardForInvoice(invoiceId, reason) {
  const cleanInvoiceId = text(invoiceId, 200);
  if (!cleanInvoiceId) return null;
  const referralRows = await supabaseFetch("referral_invitations?select=*&first_paid_invoice_id=eq." + encodeFilter(cleanInvoiceId) + "&limit=1", { method: "GET" }).catch(function () { return []; });
  const referral = Array.isArray(referralRows) ? referralRows[0] || null : null;
  if (!referral) return null;
  const reward = await rewardForReferral(referral.id);
  if (!reward) return null;
  if (reward.status === "applied") {
    return patchReward(reward.id, {
      audit_metadata: Object.assign({}, reward.audit_metadata || {}, {
        refund_or_dispute_after_application: true,
        review_reason: reason || "qualifying_payment_reversed",
        review_recorded_at: nowIso()
      })
    });
  }
  if (reward.status === "scheduled" && reward.stripe_customer_id && reward.credit_amount && reward.credit_currency) {
    const reversal = await stripeFetch("POST", "/v1/customers/" + encodeURIComponent(reward.stripe_customer_id) + "/balance_transactions", {
      amount: positiveInteger(reward.credit_amount),
      currency: reward.credit_currency,
      description: "Reversal of Clarity Caddy referral reward credit",
      "metadata[app]": "clarity-caddie",
      "metadata[referral_reward_id]": reward.id,
      "metadata[reversal_reason]": text(reason, 200) || "qualifying_payment_reversed"
    }, { headers: { "Idempotency-Key": "referral_reward_reversal_" + reward.id + "_" + cleanInvoiceId } }).catch(function () { return null; });
    return patchReward(reward.id, {
      status: "reversed",
      reversed_at: nowIso(),
      stripe_reversal_balance_transaction_id: reversal && reversal.id || null,
      reversal_reason: text(reason, 200) || "qualifying_payment_reversed"
    });
  }
  if (reward.status === "pending" || reward.status === "available" || reward.status === "scheduled") {
    const reversed = await patchReward(reward.id, {
      status: "reversed",
      reversed_at: nowIso(),
      reversal_reason: text(reason, 200) || "qualifying_payment_reversed"
    });
    await recordReferralEvent("referral_reward_reversed", {
      referralId: referral.id,
      accountId: reward.inviter_account_id,
      metadata: { reward_id: reward.id, invoice_id: cleanInvoiceId, reason: reason || "qualifying_payment_reversed" }
    });
    return reversed;
  }
  return null;
}

async function getReferralDashboard(account) {
  const id = accountId(account);
  const userEmail = accountEmail(account);
  if (!id && !userEmail) throw badRequest("Sign in before loading referrals", 401);
  const eligibility = await inviterEligibility(account).catch(function (error) {
    return { eligible: false, reason: error && error.message || "Monthly Membership required" };
  });
  const inviteRows = await supabaseFetch("referral_invitations?select=*&inviter_account_id=eq." + encodeFilter(id) + "&order=created_at.desc&limit=50", { method: "GET" }).catch(function () { return []; });
  const rewardRows = await supabaseFetch("referral_reward_ledger?select=*&inviter_account_id=eq." + encodeFilter(id) + "&order=created_at.desc&limit=50", { method: "GET" }).catch(function () { return []; });
  const claimed = await claimedReferralForInvitee(id, userEmail);
  if (claimed && claimed.free_access_ends_at && new Date(claimed.free_access_ends_at).getTime() <= Date.now() && claimed.status === "free_month_active") {
    await expireReferral(claimed);
  }
  const access = await readPaidAccess({ accountId: id, accountEmail: userEmail }).catch(function () { return null; });
  const referralEntitlement = access && Array.isArray(access.entitlements)
    ? access.entitlements.find(function (row) { return String(row.product_key || row.entitlement_type || "") === REFERRAL_ACCESS_KEY; }) || null
    : null;
  const invites = (Array.isArray(inviteRows) ? inviteRows : []).map(publicInvitation);
  const rewards = (Array.isArray(rewardRows) ? rewardRows : []).map(publicReward);
  return {
    ok: true,
    config: {
      enabled: config().enabled,
      freeAccessDays: config().freeAccessDays,
      maxOutstandingInvites: config().maxOutstandingInvites,
      maxStackedRewards: config().maxStackedRewards
    },
    eligibility,
    invites,
    rewards,
    invitee: claimed ? {
      invitation: publicInvitation(claimed),
      referralEntitlement,
      active: !!referralEntitlement,
      freeAccessEndsAt: referralEntitlement && referralEntitlement.expires_at || claimed.free_access_ends_at || ""
    } : null,
    summary: referralSummary(invites, rewards)
  };
}

function referralSummary(invites, rewards) {
  invites = Array.isArray(invites) ? invites : [];
  rewards = Array.isArray(rewards) ? rewards : [];
  const cfg = config();
  const openInvitations = invites.filter(function (row) { return row.status === "open" || row.status === "opened"; }).length;
  return {
    invitesSent: invites.length,
    maxOpenInvitations: cfg.maxOutstandingInvites,
    openInvitations,
    freeMonthsAvailableToGive: Math.max(0, cfg.maxOutstandingInvites - openInvitations),
    friendsUsingFreeMonth: invites.filter(function (row) { return row.status === "free_month_active"; }).length,
    pendingRewards: rewards.filter(function (row) { return row.status === "pending"; }).length,
    freeMonthsAvailable: rewards.filter(function (row) { return row.status === "available"; }).length,
    freeMonthsScheduled: rewards.filter(function (row) { return row.status === "scheduled"; }).length,
    freeMonthsApplied: rewards.filter(function (row) { return row.status === "applied"; }).length
  };
}

function badRequest(message, status) {
  const error = new Error(message);
  error.status = status || 400;
  return error;
}

module.exports = {
  acceptReferralInvite,
  createReferralInvite,
  evaluateReferralConversion,
  getReferralDashboard,
  markScheduledRewardAppliedForInvoice,
  openReferralToken,
  prepareReferredMembershipCheckout,
  reversePendingReferralRewardForInvoice,
  revokeReferralInvite
};
