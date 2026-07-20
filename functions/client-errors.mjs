/* Client error intake.
 *
 * Accepts small batches of already-deduplicated errors from the app and upserts
 * them by fingerprint, so a bug firing in a loop becomes one row with a rising
 * count rather than thousands of rows.
 *
 * Deliberately unauthenticated: the errors worth catching happen before sign-in
 * or when auth itself is broken - a CORS failure that blocked the auth config is
 * exactly the case this exists for, and requiring a session would have hidden
 * it. Abuse is bounded by hard caps on batch size and field lengths, and by the
 * fingerprint dedupe, which makes flooding produce one row rather than many.
 */

const TABLE = "client_error_events";
const MAX_EVENTS_PER_REQUEST = 20;
const MAX_MESSAGE = 600;
const MAX_DETAIL = 1200;
const MAX_BODY_BYTES = 64 * 1024;

function env(name) {
  return process.env[name] || "";
}

function supabaseBase() {
  return env("SUPABASE_URL").replace(/\/+$/, "");
}

function supabaseKey() {
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

function hasSupabase() {
  return !!(supabaseBase() && supabaseKey());
}

async function supabaseFetch(path, options = {}) {
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const bodyText = await response.text();
  let body = null;
  if (bodyText) {
    try { body = JSON.parse(bodyText); } catch (_error) { body = bodyText; }
  }
  if (!response.ok) {
    const error = new Error("Supabase request failed");
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept"
    }
  });
}

function text(value, max) {
  const clean = value == null ? "" : String(value);
  return max ? clean.slice(0, max) : clean;
}

function integer(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/* Strip the parts of a message that differ between occurrences of the same bug -
   ids, hashes, timestamps, numbers, quoted values - so one bug produces one
   fingerprint rather than one per occurrence. */
function normaliseForFingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\b\d{4}-\d{2}-\d{2}t[\d:.]+z?\b/g, "<time>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/["'`][^"'`]{0,80}["'`]/g, "<str>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

async function fingerprintOf(parts) {
  const input = parts.join("|");
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

export default async function clientErrors(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  /* Accept and discard when unconfigured rather than erroring: a reporting
     endpoint that fails loudly would add noise to the very sessions it is meant
     to observe, and the client must never treat reporting as important. */
  if (!hasSupabase()) return json(202, { accepted: 0, configured: false });

  let payload;
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Payload too large" });
    payload = JSON.parse(raw || "{}");
  } catch (_error) {
    return json(400, { error: "Invalid JSON" });
  }

  const incoming = Array.isArray(payload && payload.events) ? payload.events.slice(0, MAX_EVENTS_PER_REQUEST) : [];
  if (!incoming.length) return json(200, { accepted: 0 });

  const platform = text(payload.platform, 20) || "web";
  const appVersion = text(payload.appVersion, 40);
  const accountId = text(payload.accountId, 120) || null;
  const userAgent = text(req.headers.get("user-agent"), 300) || null;
  const now = new Date().toISOString();

  let accepted = 0;
  const failures = [];

  for (const event of incoming) {
    const message = text(event && event.message, MAX_MESSAGE);
    if (!message) continue;
    const source = text(event && event.source, 40) || "unknown";
    const level = text(event && event.level, 20) || "error";
    const detail = text(event && event.detail, MAX_DETAIL) || null;
    const route = text(event && event.route, 80) || null;
    const count = integer(event && event.count, 1);

    try {
      const fingerprint = await fingerprintOf([
        source,
        normaliseForFingerprint(message),
        platform,
        appVersion
      ]);

      /* Upsert by fingerprint. An existing row has its count incremented and
         last_seen_at moved; first_seen_at is left alone so "when did this start"
         survives. */
      const existing = await supabaseFetch(
        TABLE + "?select=id,count&fingerprint=eq." + encodeURIComponent(fingerprint) + "&limit=1",
        { method: "GET" }
      );
      const row = Array.isArray(existing) ? existing[0] : null;

      if (row && row.id) {
        await supabaseFetch(TABLE + "?id=eq." + encodeURIComponent(row.id), {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({
            count: (Number(row.count) || 0) + count,
            last_seen_at: now,
            updated_at: now,
            route: route,
            account_id: accountId,
            detail: detail
          })
        });
      } else {
        await supabaseFetch(TABLE + "?on_conflict=fingerprint", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            fingerprint,
            source,
            level,
            message,
            detail,
            count,
            platform,
            app_version: appVersion || null,
            route,
            account_id: accountId,
            user_agent: userAgent,
            first_seen_at: now,
            last_seen_at: now,
            updated_at: now
          })
        });
      }
      accepted += 1;
    } catch (error) {
      failures.push(error && error.message || String(error));
    }
  }

  return json(200, { accepted, failed: failures.length });
}

export const config = {
  path: "/api/client-errors"
};
