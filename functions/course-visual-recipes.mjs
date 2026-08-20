const TABLE = "course_visual_recipes";
const ADMIN_EMAILS = new Set(["samhalegolf@gmail.com", "admin@clarity.local"]);

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function anonKey() { return env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY") || env("SUPABASE_PUBLIC_ANON_KEY") || ""; }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

async function supabaseFetch(path, options = {}) {
  if (!hasSupabase()) throw new Error("Supabase is not configured");
  const headers = Object.assign({
    apikey: supabaseKey(),
    Authorization: "Bearer " + supabaseKey(),
    "Content-Type": "application/json"
  }, options.headers || {});
  const response = await fetch(supabaseBase() + "/rest/v1/" + path, Object.assign({}, options, { headers }));
  const textBody = await response.text();
  let body = null;
  try { body = textBody ? JSON.parse(textBody) : null; } catch (_error) { body = textBody; }
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + (typeof body === "string" ? body : JSON.stringify(body)));
  return body;
}

async function verifiedUser(req, payload) {
  const header = String((req && req.headers && typeof req.headers.get === "function" && req.headers.get("authorization")) || "");
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const token = bearer || String(payload && (payload.accessToken || payload.access_token) || "").trim();
  if (!token) return null;
  const base = supabaseBase();
  const key = anonKey() || supabaseKey();
  if (!base || !key) return null;
  try {
    const response = await fetch(base + "/auth/v1/user", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + token } });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !user.id) return null;
    const email = String(user.email || "").trim().toLowerCase();
    return { id: String(user.id), email, isAdmin: ADMIN_EMAILS.has(email) };
  } catch (_error) {
    return null;
  }
}

function slug(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
}

function text(value, limit = 160) {
  return String(value || "").trim().slice(0, limit);
}

function integer(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function rowToRecipe(row) {
  return {
    id: text(row && row.id, 180),
    name: text(row && row.name, 160),
    preset_id: text(row && row.preset_id, 160),
    presetId: text(row && row.preset_id, 160),
    course_overrides: jsonObject(row && row.course_overrides),
    courseOverrides: jsonObject(row && row.course_overrides),
    sample_course_id: text(row && row.sample_course_id, 160),
    sampleCourseId: text(row && row.sample_course_id, 160),
    sample_hole_number: integer(row && row.sample_hole_number),
    sampleHoleNumber: integer(row && row.sample_hole_number),
    is_active: row && row.is_active === true,
    isActive: row && row.is_active === true,
    created_by: text(row && row.created_by, 160),
    createdBy: text(row && row.created_by, 160),
    created_at: text(row && row.created_at, 80),
    createdAt: text(row && row.created_at, 80),
    updated_at: text(row && row.updated_at, 80),
    updatedAt: text(row && row.updated_at, 80)
  };
}

function recipePayload(input) {
  const name = text(input && input.name, 160);
  if (!name) return null;
  const id = text(input && input.id, 180) || ("recipe-" + slug(name) + "-" + Date.now().toString(36));
  return {
    id,
    name,
    preset_id: text(input && (input.preset_id || input.presetId), 160) || "clarity-course-natural-v1",
    course_overrides: jsonObject(input && (input.course_overrides || input.courseOverrides)),
    sample_course_id: slug(input && (input.sample_course_id || input.sampleCourseId)),
    sample_hole_number: integer(input && (input.sample_hole_number ?? input.sampleHoleNumber)),
    updated_at: new Date().toISOString()
  };
}

async function loadRecipes() {
  const rows = await supabaseFetch(TABLE + "?select=*&order=is_active.desc,updated_at.desc", { method: "GET" });
  const recipes = (Array.isArray(rows) ? rows : []).map(rowToRecipe);
  return { recipes, activeRecipe: recipes.find(recipe => recipe.isActive) || null };
}

async function clearActiveRecipe() {
  await supabaseFetch(TABLE + "?is_active=eq.true", {
    method: "PATCH",
    body: JSON.stringify({ is_active: false, updated_at: new Date().toISOString() })
  });
}

async function saveRecipe(payload, user) {
  const recipe = recipePayload(payload && payload.recipe);
  if (!recipe) return { status: 400, body: { error: "Recipe name is required" } };
  const setActive = payload && (payload.setActive === true || payload.action === "activate-current");
  if (setActive) await clearActiveRecipe();
  const rows = await supabaseFetch(TABLE + "?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([Object.assign({}, recipe, { is_active: !!setActive, created_by: user && user.email || "" })])
  });
  return { status: 200, body: Object.assign({ recipe: rowToRecipe(Array.isArray(rows) ? rows[0] : rows) }, await loadRecipes()) };
}

async function activateRecipe(payload) {
  const recipeId = text(payload && payload.recipeId, 180);
  if (!recipeId) return { status: 400, body: { error: "recipeId is required" } };
  await clearActiveRecipe();
  const rows = await supabaseFetch(TABLE + "?id=eq." + encodeURIComponent(recipeId), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ is_active: true, updated_at: new Date().toISOString() })
  });
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row) return { status: 404, body: { error: "Recipe not found" } };
  return { status: 200, body: Object.assign({ recipe: rowToRecipe(row) }, await loadRecipes()) };
}

export default async function courseVisualRecipes(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (!hasSupabase()) return json(200, { recipes: [], activeRecipe: null, storage: "unconfigured" });

  if (req.method === "GET") {
    try {
      const data = await loadRecipes();
      return json(200, Object.assign({ storage: "supabase" }, data));
    } catch (error) {
      return json(503, { error: String(error && error.message || error), recipes: [], activeRecipe: null });
    }
  }

  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  let payload;
  try { payload = await req.json(); } catch (_error) { return json(400, { error: "Invalid JSON" }); }

  const user = await verifiedUser(req, payload);
  if (!user || !user.isAdmin) return json(403, { error: "Admin verification failed" });

  try {
    const action = text(payload && payload.action, 40) || "save";
    if (action === "activate") {
      const result = await activateRecipe(payload);
      return json(result.status, result.body);
    }
    const result = await saveRecipe(payload, user);
    return json(result.status, result.body);
  } catch (error) {
    return json(503, { error: String(error && error.message || error) });
  }
}

export const config = {
  path: "/api/course-visual-recipes",
};

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

export const __test = {
  recipePayload,
  rowToRecipe
};
