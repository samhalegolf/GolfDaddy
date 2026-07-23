"use strict";

const crypto = require("crypto");
const {
  encodeFilter,
  env,
  hasSupabase,
  json,
  supabaseFetch,
  text
} = require("./payment-utils");
const {
  createId,
  createPracticeImportBatch,
  parsePracticeImportText
} = require("./practice-data-parser");

const RESEND_API_BASE = "https://api.resend.com";
const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_PHOTO_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const PRACTICE_PHOTO_BUCKET = "practice-photos";
const PHOTO_SIGNED_URL_TTL_SECONDS = 30 * 60;

function storageBase() {
  return String(env("SUPABASE_URL") || "").replace(/\/+$/, "");
}

function storageServiceKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function storagePathSegment(value, fallback) {
  const clean = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback || "file";
}

function encodeStoragePath(path) {
  return String(path || "").split("/").map(encodeURIComponent).join("/");
}

async function uploadPhotoToStorage(path, buffer, contentType) {
  const base = storageBase();
  const key = storageServiceKey();
  if (!base || !key) {
    const error = new Error("Supabase storage is not configured for practice photo intake");
    error.status = 503;
    throw error;
  }
  const response = await fetch(base + "/storage/v1/object/" + PRACTICE_PHOTO_BUCKET + "/" + encodeStoragePath(path), {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": contentType || "application/octet-stream",
      "x-upsert": "true"
    },
    body: buffer
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(function () { return ""; });
    const error = new Error("Could not store practice photo");
    error.status = response.status;
    error.body = bodyText;
    throw error;
  }
  return path;
}

async function signPhotoUrl(path) {
  const base = storageBase();
  const key = storageServiceKey();
  if (!base || !key || !path) return "";
  try {
    const response = await fetch(base + "/storage/v1/object/sign/" + PRACTICE_PHOTO_BUCKET + "/" + encodeStoragePath(path), {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: PHOTO_SIGNED_URL_TTL_SECONDS })
    });
    if (!response.ok) return "";
    const body = await response.json().catch(function () { return null; });
    const signedPath = body && (body.signedURL || body.signedUrl || body.signedPath);
    if (!signedPath) return "";
    if (/^https?:\/\//i.test(signedPath)) return signedPath;
    return base + "/storage/v1" + (signedPath.indexOf("/") === 0 ? signedPath : "/" + signedPath);
  } catch (_error) {
    return "";
  }
}

function cleanDomain(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9.-]/g, "");
  return clean && clean.includes(".") ? clean : "claritygolf.app";
}

function intakeDomain() {
  return cleanDomain(env("CLARITY_PRACTICE_EMAIL_DOMAIN") || env("CLARITY_EMAIL_INTAKE_DOMAIN"));
}

function slug(value, fallback) {
  const clean = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback || "player";
}

function query(event) {
  return event && event.queryStringParameters || {};
}

function header(event, name) {
  const headers = event && event.headers || {};
  const key = Object.keys(headers).find(function (item) {
    return item.toLowerCase() === name.toLowerCase();
  });
  return key ? headers[key] : "";
}

function rawBody(event) {
  const raw = event && event.body || "";
  if (event && event.isBase64Encoded) return Buffer.from(raw, "base64").toString("utf8");
  return String(raw || "");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signatureCandidates(value) {
  const candidates = [];
  String(value || "").split(/\s+/).forEach(function (part) {
    if (!part) return;
    const pieces = part.split(",");
    if (pieces.length >= 2 && pieces[0] === "v1") candidates.push(pieces[1]);
    else candidates.push(part);
  });
  return candidates;
}

function verifyResendSignature(event) {
  const secret = env("RESEND_WEBHOOK_SECRET");
  if (!secret) return false;
  const id = header(event, "svix-id");
  const timestamp = header(event, "svix-timestamp");
  const signature = header(event, "svix-signature");
  if (!id || !timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 10 * 60) return false;
  const keyPart = secret.indexOf("whsec_") === 0 ? secret.slice("whsec_".length) : secret;
  let secretBytes;
  try {
    secretBytes = Buffer.from(keyPart, "base64");
  } catch (_error) {
    return false;
  }
  if (!secretBytes.length) return false;
  const signedContent = id + "." + timestamp + "." + rawBody(event);
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return signatureCandidates(signature).some(function (candidate) {
    return safeEqual(candidate, expected);
  });
}

function authorized(event) {
  const secret = env("CLARITY_PRACTICE_EMAIL_SECRET");
  if (secret && (safeEqual(header(event, "x-clarity-email-secret"), secret) || safeEqual(query(event).secret, secret))) return true;
  return verifyResendSignature(event);
}

function playerKey(input) {
  return slug(
    input.playerKey ||
      input.player_key ||
      input.profileId ||
      input.profile_id ||
      input.viewedProfileId ||
      input.playerId ||
      input.player_id ||
      input.accountId ||
      input.account_id ||
      input.email ||
      input.name,
    "player"
  );
}

function practiceEmailAddress(input) {
  return "practice+" + playerKey(input || {}) + "@" + intakeDomain();
}

function parseBody(event) {
  const raw = rawBody(event);
  const contentType = String(header(event, "content-type") || "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) return parseForm(raw);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (_error) {
    return parseForm(raw);
  }
}

async function resendFetch(path) {
  const apiKey = env("RESEND_API_KEY");
  if (!apiKey) {
    const error = new Error("RESEND_API_KEY is required to read Resend inbound email content");
    error.status = 503;
    throw error;
  }
  const response = await fetch(RESEND_API_BASE + path, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer " + apiKey
    }
  });
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch (_error) {
      body = bodyText;
    }
  }
  if (!response.ok) {
    const error = new Error("Resend receiving API request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function isResendReceivedEvent(payload) {
  return !!(payload && payload.type === "email.received" && payload.data && (payload.data.email_id || payload.data.id));
}

async function resendReceivedEmail(emailId) {
  const body = await resendFetch("/emails/receiving/" + encodeURIComponent(emailId));
  return body && body.data && body.data.id ? body.data : body;
}

async function resendReceivedAttachments(emailId) {
  const body = await resendFetch("/emails/receiving/" + encodeURIComponent(emailId) + "/attachments");
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  return [];
}

async function downloadTextAttachment(url, filename) {
  if (!url) return "";
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const error = new Error("Could not download Resend attachment " + (filename || ""));
    error.status = response.status;
    throw error;
  }
  const declaredSize = Number(response.headers && response.headers.get && response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_TEXT_ATTACHMENT_BYTES) {
    const error = new Error("Resend attachment is too large to parse as practice text");
    error.status = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_TEXT_ATTACHMENT_BYTES) {
    const error = new Error("Resend attachment is too large to parse as practice text");
    error.status = 413;
    throw error;
  }
  return buffer.toString("utf8");
}

async function downloadBinaryAttachment(url, filename) {
  if (!url) return null;
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const error = new Error("Could not download Resend attachment " + (filename || ""));
    error.status = response.status;
    throw error;
  }
  const declaredSize = Number(response.headers && response.headers.get && response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PHOTO_ATTACHMENT_BYTES) {
    const error = new Error("Resend photo attachment is too large to store");
    error.status = 413;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PHOTO_ATTACHMENT_BYTES) {
    const error = new Error("Resend photo attachment is too large to store");
    error.status = 413;
    throw error;
  }
  return buffer;
}

function resendRecipients(email, data) {
  return []
    .concat(email && email.to || [])
    .concat(email && email.received_for || [])
    .concat(data && data.to || [])
    .concat(data && data.received_for || []);
}

function normalizeResendAttachment(item, index) {
  return {
    index,
    id: text(item && item.id, 160),
    filename: text(item && (item.filename || item.name) || ("attachment-" + (index + 1)), 180),
    contentType: text(item && (item.content_type || item.contentType || item.type), 120).toLowerCase(),
    content: "",
    base64: "",
    size: Number(item && item.size || 0) || 0,
    url: text(item && (item.download_url || item.url || item.href), 1200)
  };
}

async function normalizeResendPayload(payload) {
  if (!isResendReceivedEvent(payload)) return payload;
  const data = payload.data || {};
  const emailId = text(data.email_id || data.id, 180);
  const email = await resendReceivedEmail(emailId);
  const attachmentSource = await resendReceivedAttachments(emailId).catch(function () {
    return Array.isArray(email && email.attachments) ? email.attachments : (Array.isArray(data.attachments) ? data.attachments : []);
  });
  const attachments = [];
  for (const source of attachmentSource) {
    const normalized = normalizeResendAttachment(source, attachments.length);
    const lane = laneForAttachment(normalized);
    if ((lane.lane === "email_csv" || lane.lane === "email_json") && normalized.url) {
      normalized.content = await downloadTextAttachment(normalized.url, normalized.filename);
    } else if (lane.lane === "email_photo" && normalized.url) {
      try {
        normalized.buffer = await downloadBinaryAttachment(normalized.url, normalized.filename);
      } catch (_error) {
        // Leave normalized.buffer unset - parseAttachmentRows treats it as unsupported below.
      }
    }
    attachments.push(Object.assign(normalized, lane));
  }
  return {
    provider: "resend",
    providerEmailId: emailId,
    id: text(data.message_id || email && email.message_id || emailId, 180),
    messageId: text(data.message_id || email && email.message_id || emailId, 180),
    to: resendRecipients(email, data),
    recipient: resendRecipients(email, data),
    from: email && email.from || data.from || "",
    sender: email && email.from || data.from || "",
    subject: email && email.subject || data.subject || "",
    text: email && email.text || data.text || "",
    bodyText: email && email.text || data.text || "",
    html: email && email.html || data.html || "",
    headers: email && email.headers || data.headers || {},
    attachments
  };
}

function parseForm(raw) {
  const parsed = {};
  String(raw || "").split("&").forEach(function (pair) {
    const index = pair.indexOf("=");
    if (index < 0) return;
    const key = decodeURIComponent(pair.slice(0, index).replace(/\+/g, " "));
    const value = decodeURIComponent(pair.slice(index + 1).replace(/\+/g, " "));
    if (!key) return;
    parsed[key] = value;
  });
  return parsed;
}

function extractEmails(value) {
  const input = Array.isArray(value) ? value.join(", ") : String(value || "");
  const matches = input.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || [];
  return matches.map(function (item) { return item.toLowerCase(); });
}

function recipientEmails(payload) {
  const envelopeTo = payload && payload.envelope && payload.envelope.to;
  return Array.from(new Set([]
    .concat(extractEmails(payload && payload.to))
    .concat(extractEmails(payload && payload.recipient))
    .concat(extractEmails(envelopeTo))));
}

function playerKeyFromRecipients(recipients) {
  const domain = intakeDomain();
  for (const address of recipients || []) {
    const lower = String(address || "").toLowerCase();
    const suffix = "@" + domain;
    if (!lower.endsWith(suffix)) continue;
    const local = lower.slice(0, -suffix.length);
    const match = local.match(/^practice\+(.+)$/);
    if (match && match[1]) return slug(match[1], "player");
  }
  return "";
}

function senderEmail(payload) {
  const envelopeFrom = payload && payload.envelope && payload.envelope.from;
  return extractEmails(payload && (payload.from || payload.sender) || envelopeFrom)[0] || "";
}

function attachmentList(payload) {
  let candidates = payload.attachments || payload.attachment || payload.files || payload.file || payload.inboundAttachments || [];
  if (typeof candidates === "string") {
    try {
      candidates = JSON.parse(candidates);
    } catch (_error) {
      candidates = [];
    }
  }
  if (!Array.isArray(candidates)) candidates = candidates ? [candidates] : [];
  return candidates.map(function (item, index) {
    if (!item || typeof item !== "object") return null;
    const filename = text(item.filename || item.fileName || item.name || item.originalname || ("attachment-" + (index + 1)), 180);
    const contentType = text(item.contentType || item.content_type || item.type || item.mime || item.mimetype, 120).toLowerCase();
    return {
      index,
      filename,
      contentType,
      content: typeof item.content === "string" ? item.content : (typeof item.data === "string" ? item.data : (typeof item.text === "string" ? item.text : "")),
      base64: typeof item.base64 === "string" ? item.base64 : (typeof item.contentBase64 === "string" ? item.contentBase64 : (typeof item.content_base64 === "string" ? item.content_base64 : "")),
      size: Number(item.size || item.length || 0) || 0,
      url: text(item.url || item.href || "", 600)
    };
  }).filter(Boolean);
}

function laneForAttachment(item) {
  const name = String(item && item.filename || "").toLowerCase();
  const type = String(item && item.contentType || "").toLowerCase();
  if (/(\.csv|\.txt|\.tsv)$/.test(name) || /text\/|csv|tab-separated/.test(type)) return { lane: "email_csv", reason: "text attachment" };
  if (/(\.png|\.jpg|\.jpeg|\.webp|\.heic|\.gif)$/.test(name) || /^image\//.test(type)) return { lane: "email_photo", reason: "image attachment" };
  if (/\.json$/.test(name) || /json/.test(type)) return { lane: "email_json", reason: "json attachment" };
  return { lane: "unsupported", reason: "unsupported attachment type" };
}

function looksLikeCsvBody(value) {
  const input = String(value || "").trim();
  if (!input) return false;
  const lines = input.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
  if (lines.length < 2) return false;
  return /,|\t|\|/.test(lines[0]) && /(club|carry|total|offline|face|path|start|ball|spin)/i.test(lines[0]);
}

function decodeBase64(value) {
  const raw = String(value || "");
  if (!raw) return "";
  try {
    return Buffer.from(raw.includes(",") ? raw.split(",").pop() : raw, "base64").toString("utf8");
  } catch (_error) {
    return "";
  }
}

function textFromAttachment(item) {
  if (item.content) return String(item.content || "");
  if (item.base64) return decodeBase64(item.base64);
  return "";
}

function bufferFromAttachment(item) {
  if (item && Buffer.isBuffer(item.buffer)) return item.buffer;
  if (item && item.base64) {
    const raw = String(item.base64);
    try {
      return Buffer.from(raw.includes(",") ? raw.split(",").pop() : raw, "base64");
    } catch (_error) {
      return null;
    }
  }
  return null;
}

function normalizeInbound(payload) {
  const recipients = recipientEmails(payload);
  const receivedAt = new Date().toISOString();
  const bodyText = text(payload.text || payload.bodyText || payload.plain || payload.strippedText || payload.body || "", 200000);
  const attachments = attachmentList(payload).map(function (item) {
    return Object.assign({}, item, laneForAttachment(item));
  });
  if (!attachments.length && looksLikeCsvBody(bodyText)) {
    attachments.push({
      index: 0,
      filename: "email-body.csv",
      contentType: "text/plain",
      content: bodyText,
      base64: "",
      size: bodyText.length,
      url: "",
      lane: "email_csv",
      reason: "email body looks like CSV"
    });
  }
  const key = playerKeyFromRecipients(recipients) || playerKey(payload);
  return {
    intakeId: text(payload.messageId || payload.message_id || payload["message-id"] || payload.id, 160) || createId("practice-email"),
    receivedAt,
    recipients,
    to: recipients.join(", "),
    from: senderEmail(payload),
    subject: text(payload.subject, 240),
    playerKey: key,
    accountId: text(payload.accountId || payload.account_id, 120),
    profileId: text(payload.profileId || payload.profile_id || payload.playerId || payload.player_id, 120),
    playerName: text(payload.playerName || payload.player_name || payload.name, 160) || "Player",
    provider: text(payload.provider, 80),
    providerEmailId: text(payload.providerEmailId || payload.provider_email_id, 180),
    attachments,
    bodyText,
    routing: {
      email_csv: attachments.filter(function (item) { return item.lane === "email_csv" || item.lane === "email_json"; }).length,
      email_photo: attachments.filter(function (item) { return item.lane === "email_photo"; }).length,
      unsupported: attachments.filter(function (item) { return item.lane === "unsupported"; }).length
    }
  };
}

function parseAttachmentRows(inbound) {
  const imports = [];
  const pendingPhotos = [];
  const unsupported = [];
  const errors = [];

  inbound.attachments.forEach(function (item) {
    if (item.lane === "email_csv" || item.lane === "email_json") {
      const content = textFromAttachment(item);
      if (!content.trim()) {
        errors.push((item.filename || "attachment") + " had no readable text");
        return;
      }
      const parsed = parsePracticeImportText(content, { sourceType: item.lane, sourceName: item.filename || "practice email" });
      const batch = createPracticeImportBatch(parsed.rows || [], {
        sourceType: item.lane,
        sourceName: item.filename || "practice email",
        rawText: content
      }, {
        accountId: inbound.accountId,
        profileId: inbound.profileId || inbound.playerKey,
        playerId: inbound.profileId || inbound.playerKey,
        playerName: inbound.playerName
      });
      imports.push({ attachment: item, parsed, batch });
      if (!batch.rows.length) errors.push((item.filename || "attachment") + " produced no rows");
      return;
    }
    if (item.lane === "email_photo") {
      const buffer = bufferFromAttachment(item);
      if (buffer && buffer.length) {
        pendingPhotos.push(Object.assign({}, item, { buffer: buffer }));
      } else {
        unsupported.push(item);
        errors.push((item.filename || "photo attachment") + " could not be downloaded for storage");
      }
      return;
    }
    unsupported.push(item);
  });

  return { imports, pendingPhotos, unsupported, errors };
}

function eventStatus(parsed) {
  const validRows = parsed.imports.reduce(function (sum, item) { return sum + Number(item.batch.batch.validCount || 0); }, 0);
  const totalRows = parsed.imports.reduce(function (sum, item) { return sum + Number(item.batch.batch.rowCount || 0); }, 0);
  if (validRows) return "staged";
  if (totalRows || parsed.errors.length) return "needs_review";
  if (parsed.pendingPhotos.length) return "pending_photo";
  return "unsupported";
}

function stableId(prefix, seed) {
  const hash = crypto.createHash("sha1").update(String(seed || "")).digest("hex").slice(0, 24);
  return prefix + "-" + hash;
}

async function storePendingPhotos(inbound, parsed) {
  if (!parsed.pendingPhotos.length) return;
  const photoRecords = [];
  for (const photo of parsed.pendingPhotos) {
    const safeName = storagePathSegment(photo.filename, "photo-" + (photo.index + 1) + ".jpg");
    const path = inbound.playerKey + "/" + storagePathSegment(inbound.intakeId, "email") + "/" + photo.index + "-" + safeName;
    try {
      await uploadPhotoToStorage(path, photo.buffer, photo.contentType || "image/jpeg");
      photoRecords.push({ path: path, filename: photo.filename, contentType: photo.contentType || "", size: photo.buffer.length });
    } catch (error) {
      parsed.errors.push((photo.filename || "photo") + " could not be stored: " + (error.message || "upload failed"));
    }
  }
  if (!photoRecords.length) return;
  const batchId = stableId("practice-email-photo-batch", inbound.intakeId);
  const now = new Date().toISOString();
  await supabaseFetch("practice_import_batches?on_conflict=import_batch_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      import_batch_id: batchId,
      session_id: batchId,
      intake_id: inbound.intakeId,
      account_id: inbound.accountId || null,
      profile_id: inbound.profileId || null,
      player_key: inbound.playerKey,
      player_id: inbound.profileId || inbound.playerKey,
      player_name: inbound.playerName,
      source_type: "email_photo",
      source_name: inbound.subject || "Practice email photo",
      row_count: 0,
      valid_count: 0,
      invalid_count: 0,
      status: "needs_review",
      metadata: {
        subject: inbound.subject,
        from: inbound.from,
        photos: photoRecords
      },
      created_at: inbound.receivedAt,
      updated_at: now
    })
  });
}

async function storeInbound(inbound, parsed) {
  if (!hasSupabase()) {
    const error = new Error("Supabase is not configured for practice email intake");
    error.status = 503;
    throw error;
  }
  await storePendingPhotos(inbound, parsed);
  const status = eventStatus(parsed);
  const now = new Date().toISOString();
  const eventRow = {
    intake_id: inbound.intakeId,
    account_id: inbound.accountId || null,
    profile_id: inbound.profileId || null,
    player_key: inbound.playerKey,
    recipient_email: inbound.to || null,
    sender_email: inbound.from || null,
    subject: inbound.subject || null,
    provider_message_id: inbound.intakeId,
    status,
    routing_json: Object.assign({}, inbound.routing, {
      pendingPhotos: parsed.pendingPhotos.length,
      unsupported: parsed.unsupported.length,
      errors: parsed.errors
    }),
    payload_json: {
      provider: inbound.provider || null,
      providerEmailId: inbound.providerEmailId || null,
      receivedAt: inbound.receivedAt,
      attachments: inbound.attachments.map(function (item) {
        return {
          index: item.index,
          filename: item.filename,
          contentType: item.contentType,
          size: item.size,
          lane: item.lane,
          reason: item.reason,
          hasContent: !!(item.content || item.base64),
          hasUrl: !!item.url
        };
      })
    },
    created_at: inbound.receivedAt,
    updated_at: now
  };

  await supabaseFetch("practice_email_intake_events?on_conflict=intake_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(eventRow)
  });

  for (const item of parsed.imports) {
    const batch = item.batch.batch;
    const session = item.batch.session;
    await supabaseFetch("practice_import_batches?on_conflict=import_batch_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        import_batch_id: batch.importBatchId,
        session_id: batch.sessionId,
        intake_id: inbound.intakeId,
        account_id: inbound.accountId || null,
        profile_id: inbound.profileId || null,
        player_key: inbound.playerKey,
        player_id: session.playerId || inbound.profileId || inbound.playerKey,
        player_name: session.playerName || inbound.playerName,
        source_type: batch.sourceType,
        source_name: batch.sourceName,
        row_count: batch.rowCount,
        valid_count: batch.validCount,
        invalid_count: batch.invalidCount,
        status: batch.validCount ? "staged" : "needs_review",
        metadata: {
          subject: inbound.subject,
          from: inbound.from,
          warnings: item.parsed.warnings || [],
          parseErrors: item.parsed.errors || []
        },
        created_at: batch.createdAt,
        updated_at: batch.updatedAt
      })
    });

    const shotRows = item.batch.rows.map(function (row) {
      return {
        shot_id: row.shotId,
        import_batch_id: row.importBatchId,
        session_id: row.sessionId,
        intake_id: inbound.intakeId,
        account_id: inbound.accountId || null,
        profile_id: inbound.profileId || null,
        player_key: inbound.playerKey,
        player_id: row.playerId || inbound.profileId || inbound.playerKey,
        player_name: row.playerName || inbound.playerName,
        club: row.club || null,
        shot_number: Number.isFinite(Number(row.shotNumber)) ? Number(row.shotNumber) : null,
        metrics_json: {
          ballSpeed: row.ballSpeed,
          clubSpeed: row.clubSpeed,
          launchAngle: row.launchAngle,
          spin: row.spin,
          carryDistance: row.carryDistance,
          totalDistance: row.totalDistance,
          offlineDistance: row.offlineDistance,
          side: row.side,
          faceAngle: row.faceAngle,
          pathAngle: row.pathAngle,
          faceToPath: row.faceToPath,
          startDirection: row.startDirection,
          curve: row.curve,
          targetLine: row.targetLine,
          sideSpin: row.sideSpin,
          totalSpin: row.totalSpin,
          backspin: row.backspin,
          spinAxis: row.spinAxis,
          derivedMetrics: row.derivedMetrics || {}
        },
        raw_source_json: row.rawSource || {},
        unknown_fields_json: row.unknownFields || {},
        warnings_json: row.warnings || [],
        errors_json: row.errors || [],
        status: row.errors && row.errors.length ? "native_invalid" : "ready_for_gate",
        source_type: row.sourceType,
        schema_version: row.schemaVersion || 1,
        created_at: row.createdAt,
        updated_at: row.updatedAt
      };
    });
    if (shotRows.length) {
      await supabaseFetch("practice_native_shots?on_conflict=shot_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(shotRows)
      });
    }
  }

  return { stored: true, status };
}

async function recentFor(params) {
  const key = playerKey(params);
  if (!hasSupabase()) return { configured: false, batches: [] };
  const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 20);
  const batches = await supabaseFetch(
    "practice_import_batches?select=*&player_key=eq." + encodeFilter(key) + "&status=neq.deleted&order=created_at.desc&limit=" + limit,
    { method: "GET" }
  );
  const batchIds = (Array.isArray(batches) ? batches : []).map(function (batch) { return batch.import_batch_id; }).filter(Boolean);
  let shots = [];
  if (batchIds.length) {
    const inList = batchIds.map(function (id) {
      return encodeURIComponent("\"" + id + "\"");
    }).join(",");
    shots = await supabaseFetch(
      "practice_native_shots?select=*&import_batch_id=in.(" + inList + ")&status=neq.deleted&order=shot_number.asc",
      { method: "GET" }
    );
  }
  const shotsByBatch = {};
  (Array.isArray(shots) ? shots : []).forEach(function (shot) {
    const id = shot.import_batch_id;
    shotsByBatch[id] = shotsByBatch[id] || [];
    shotsByBatch[id].push(shot);
  });
  const enrichedBatches = await Promise.all((Array.isArray(batches) ? batches : []).map(async function (batch) {
    const photos = Array.isArray(batch && batch.metadata && batch.metadata.photos) ? batch.metadata.photos : [];
    const signedPhotos = photos.length
      ? await Promise.all(photos.map(async function (photo) {
          const url = await signPhotoUrl(photo.path);
          return Object.assign({}, photo, { url: url });
        }))
      : [];
    return Object.assign({}, batch, { shots: shotsByBatch[batch.import_batch_id] || [], photos: signedPhotos });
  }));
  return {
    configured: true,
    batches: enrichedBatches
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") return json(204, {});
  if (event.httpMethod === "GET") {
    const params = query(event);
    const input = {
      playerKey: params.playerKey || params.player_key,
      profileId: params.profileId || params.profile_id,
      accountId: params.accountId || params.account_id,
      email: params.email,
      name: params.name
    };
    const response = {
      address: practiceEmailAddress(input),
      localPart: "practice+" + playerKey(input),
      domain: intakeDomain(),
      playerKey: playerKey(input),
      configured: hasSupabase(),
      status: hasSupabase() ? "ready" : "storage_not_configured"
    };
    if (params.recent === "1" || params.includeRecent === "1" || params.action === "recent") {
      response.recent = await recentFor(input);
    }
    return json(200, response);
  }
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!env("CLARITY_PRACTICE_EMAIL_SECRET") && !env("RESEND_WEBHOOK_SECRET")) {
    return json(503, { error: "Practice email intake authorization is not configured", code: "secret_not_configured" });
  }
  if (!authorized(event)) return json(401, { error: "Practice email intake is not authorized" });

  try {
    const payload = await normalizeResendPayload(parseBody(event));
    const inbound = normalizeInbound(payload);
    const parsed = parseAttachmentRows(inbound);
    const storage = await storeInbound(inbound, parsed);
    const validRows = parsed.imports.reduce(function (sum, item) { return sum + Number(item.batch.batch.validCount || 0); }, 0);
    const invalidRows = parsed.imports.reduce(function (sum, item) { return sum + Number(item.batch.batch.invalidCount || 0); }, 0);
    return json(200, {
      accepted: true,
      stored: storage.stored,
      status: storage.status,
      playerKey: inbound.playerKey,
      intakeId: inbound.intakeId,
      counts: {
        batches: parsed.imports.length,
        validRows,
        invalidRows,
        pendingPhotos: parsed.pendingPhotos.length,
        unsupported: parsed.unsupported.length,
        errors: parsed.errors.length
      },
      batches: parsed.imports.map(function (item) {
        return {
          importBatchId: item.batch.batch.importBatchId,
          sessionId: item.batch.batch.sessionId,
          sourceName: item.batch.batch.sourceName,
          rowCount: item.batch.batch.rowCount,
          validCount: item.batch.batch.validCount,
          invalidCount: item.batch.batch.invalidCount,
          warnings: item.parsed.warnings || [],
          errors: item.parsed.errors || []
        };
      }),
      errors: parsed.errors
    });
  } catch (error) {
    return json(error.status || 502, {
      accepted: false,
      error: error.message || "Practice email intake failed",
      details: error.body || null
    });
  }
};
