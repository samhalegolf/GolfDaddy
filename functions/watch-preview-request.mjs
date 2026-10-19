/* The watch preview's sign-up request gate.
 *
 * watch-preview.html (the public page linked from the landing page) lets a visitor see the
 * Garmin and Apple Watch faces on a real course before they have an account. The page asks
 * for a name, an email and which watch they wear first, and that lands here as
 * POST {name, email, watch, note}. The request is one support_tickets row tagged with its
 * own source, so it sits beside beta reports and Garmin feedback without a table of its
 * own, and one email to the support inbox, the same two channels support-ticket.js uses.
 *
 * Nothing is unlocked server-side: the page remembers that a request was sent and shows the
 * preview from then on. The gate is a request to be contacted, not a credential - what it
 * guards is a demo. */

const SOURCE = "clarity-caddy-watch-preview-request";
const WATCHES = { garmin: "Garmin", apple: "Apple Watch" };

function env(name) { return process.env[name] || ""; }
function text(value, limit) { const input = String(value || "").trim(); return input.length > limit ? input.slice(0, limit) : input; }
function cleanEmail(value) { const input = text(value, 240).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? input : ""; }
function escapeHTML(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

export function json(status, body) {
  return new Response(JSON.stringify(body), {
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

/* The request as a support ticket, or {error, code} when it is not one worth keeping. */
export function buildTicket(payload, meta) {
  const name = text(payload && payload.name, 120);
  const email = cleanEmail(payload && payload.email);
  const watchKey = text(payload && payload.watch, 20).toLowerCase();
  const watch = WATCHES[watchKey] || "";
  const note = text(payload && payload.note, 1200);
  if (!name) return { error: "Enter your name", code: "name_required" };
  if (!email) return { error: "Enter a valid email address", code: "invalid_email" };
  return {
    ticket: {
      happened: "Watch preview sign-up request from " + name + (watch ? " (" + watch + ")" : ""),
      expected: note,
      contact: email,
      context: {
        name,
        email,
        watch: watchKey && WATCHES[watchKey] ? watchKey : "",
        userAgent: text(meta && meta.userAgent, 400),
        referer: text(meta && meta.referer, 400),
        locale: text(payload && payload.locale, 20)
      },
      status: "new",
      source: SOURCE,
      created_at: new Date().toISOString()
    }
  };
}

async function storeTicket(ticket, fetchFn) {
  const base = env("SUPABASE_URL").replace(/\/+$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY") || env("SUPABASE_ANON_KEY");
  if (!base || !key) return { stored: false, ticketId: null, status: "storage_not_configured" };
  try {
    const response = await fetchFn(base + "/rest/v1/support_tickets", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(ticket)
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) return { stored: false, ticketId: null, status: "storage_rejected" };
    const created = Array.isArray(body) ? body[0] : body;
    return { stored: true, ticketId: created && created.id || null, status: "stored" };
  } catch (error) {
    return { stored: false, ticketId: null, status: "storage_error" };
  }
}

export function renderEmail(ticket, ticketId) {
  const c = ticket.context || {};
  const watch = WATCHES[c.watch] || "not said";
  const subject = "Clarity Caddy watch preview request · " + c.name + (ticketId ? " · " + ticketId : "");
  const rows = [["Name", c.name], ["Email", ticket.contact], ["Watch", watch], ["Note", ticket.expected || "none"], ["Sent", ticket.created_at], ["From page", c.referer || ""], ["Ticket", ticketId || "email-only"]];
  const textBody = ["Clarity Caddy watch preview request", ""].concat(rows.map((r) => r[0] + ": " + r[1])).join("\n");
  const html = "<h2>Clarity Caddy watch preview request</h2><table>" + rows.map((r) => "<tr><th align=\"left\">" + escapeHTML(r[0]) + "</th><td>" + escapeHTML(r[1]) + "</td></tr>").join("") + "</table>";
  return { subject, text: textBody, html };
}

async function sendEmail(ticket, ticketId, fetchFn) {
  const resendKey = env("RESEND_API_KEY");
  if (!resendKey) return { sent: false, status: "email_not_configured" };
  const to = cleanEmail(env("CLARITY_SUPPORT_EMAIL") || env("CLARITY_DEBUG_REPORT_TO") || env("CLARITY_OWNER_EMAIL") || env("SUPPORT_EMAIL") || "sam@claritygolf.app");
  if (!to) return { sent: false, status: "email_recipient_missing" };
  const from = env("CLARITY_EMAIL_FROM") || "Clarity Golf Systems <notifications@claritygolf.systems>";
  const rendered = renderEmail(ticket, ticketId);
  try {
    const response = await fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + resendKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], reply_to: ticket.contact, subject: rendered.subject, html: rendered.html, text: rendered.text })
    });
    if (!response.ok) return { sent: false, status: "email_rejected" };
    return { sent: true, status: "sent" };
  } catch (error) {
    return { sent: false, status: "email_error" };
  }
}

export async function handleRequest(req, fetchFn) {
  fetchFn = fetchFn || fetch;
  if (req.method === "OPTIONS") return json(204, {});
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload = {};
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }
  const headers = req.headers && typeof req.headers.get === "function" ? req.headers : { get: () => "" };
  const built = buildTicket(payload, { userAgent: headers.get("user-agent"), referer: headers.get("referer") });
  if (built.error) return json(400, { error: built.error, code: built.code });
  const storage = await storeTicket(built.ticket, fetchFn);
  const mail = await sendEmail(built.ticket, storage.ticketId, fetchFn);
  if (!storage.stored && !mail.sent) {
    return json(503, { error: "Your request could not be sent right now", storage: storage.status, email: mail.status });
  }
  return json(200, { ok: true, requestId: storage.ticketId, stored: storage.stored, emailed: mail.sent });
}

export default function watchPreviewRequest(req) { return handleRequest(req); }

export const config = { path: "/api/watch-preview-request" };
