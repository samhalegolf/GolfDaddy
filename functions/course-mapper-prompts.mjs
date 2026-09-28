/* GET/POST /api/course-mapper-prompts - the operator's prompt per kind of mapping failure.
 *
 * The kinds, their defaults and the text the Routine is fired with all come from
 * functions/lib/gd-mapper-failure-kinds.mjs; this endpoint only stores an override per
 * kind in mapper_failure_prompts and hands Studio what it needs to edit them: each kind,
 * its stored or default prompt, the placeholders, and an outline of the full payload so
 * the operator sees what follows their words.
 *
 * Admin only, both ways, with the same bearer check course-visual-recipes.mjs uses. */
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";
import { FAILURE_KINDS, PROMPT_PLACEHOLDERS, routineTextOutline } from "./lib/gd-mapper-failure-kinds.mjs";

const TABLE = "mapper_failure_prompts";
const PROMPT_MAX = 8000;
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
const supabaseFetch = createSupabaseFetch({ base: supabaseBase, key: supabaseKey, label: "course-mapper-prompts" });

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function verifiedUser(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token || !supabaseBase()) return null;
  try {
    const key = anonKey() || supabaseKey();
    const response = await fetch(supabaseBase() + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !user.id) return null;
    const email = String(user.email || "").trim().toLowerCase();
    return { id: String(user.id), email, isAdmin: ADMIN_EMAILS.has(email) };
  } catch (_error) {
    return null;
  }
}

async function storedRows() {
  const rows = await supabaseFetch(TABLE + "?select=kind,prompt,updated_at,updated_by").catch(() => []);
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.kind, row]));
}

function entry(kind, stored) {
  const row = stored.get(kind.kind) || null;
  return {
    kind: kind.kind, label: kind.label, when: kind.when,
    defaultPrompt: kind.defaultPrompt,
    prompt: row ? row.prompt : kind.defaultPrompt,
    stored: !!row,
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null,
    outline: routineTextOutline(kind.kind)
  };
}

export default async function courseMapperPrompts(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!supabaseBase() || !supabaseKey()) return json(503, { error: "Supabase is not configured" });
  let payload = null;
  if (req.method === "POST") {
    try { payload = await req.json(); } catch (_error) { payload = null; }
  }
  const user = await verifiedUser(req, payload);
  if (!user || !user.isAdmin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const stored = await storedRows();
    return json(200, { kinds: FAILURE_KINDS.map(kind => entry(kind, stored)), placeholders: PROMPT_PLACEHOLDERS, promptMax: PROMPT_MAX });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const kind = FAILURE_KINDS.find(candidate => candidate.kind === String(payload && payload.kind || ""));
  if (!kind) return json(400, { error: "unknown failure kind" });

  if (payload.reset) {
    await supabaseFetch(TABLE + "?kind=eq." + encodeURIComponent(kind.kind), { method: "DELETE", headers: { Prefer: "return=representation" } });
    return json(200, { saved: entry(kind, new Map()) });
  }
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) return json(400, { error: "prompt required (or reset: true to go back to the default)" });
  if (prompt.length > PROMPT_MAX) return json(400, { error: "prompt is over " + PROMPT_MAX + " characters" });
  const row = { kind: kind.kind, prompt, updated_at: new Date().toISOString(), updated_by: user.email };
  const written = await supabaseFetch(TABLE + "?on_conflict=kind", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
  const saved = Array.isArray(written) && written[0] ? written[0] : row;
  return json(200, { saved: entry(kind, new Map([[kind.kind, saved]])) });
}

export const config = { path: "/api/course-mapper-prompts" };
