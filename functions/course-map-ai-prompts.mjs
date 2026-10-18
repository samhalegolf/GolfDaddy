/* GET/POST /api/course-map-ai-prompts - the operator's words for each AI help task on the
 * Mapping Overlay page.
 *
 * The tasks, their default prompts and their default answer shape (pins or outlines) come
 * from functions/lib/gd-ai-scan-core.mjs; this endpoint stores an override per task in
 * ai_scan_prompts and hands Studio what it needs to edit them: each task, its stored or
 * default words and output, and an outline of the whole prompt so the operator sees what
 * surrounds their words. The scan itself reads the same table when a request names a task
 * without carrying its words (lib/gd-ai-scan-prompts-store.mjs).
 *
 * Admin only, both ways, by the same proof the overlay API uses. */
import { AI_SCAN_TASKS, AI_SCAN_OUTPUTS, AI_SCAN_PROMPT_MAX, scanTask, scanPromptOutline } from "./lib/gd-ai-scan-core.mjs";
import { storedTasks, writeStoredTask, deleteStoredTask } from "./lib/gd-ai-scan-prompts-store.mjs";
import { hasSupabase, verifiedAdminEmail, json } from "./lib/gd-map-overlay-store.mjs";

function entry(task, stored) {
  const row = stored.get(task.id) || null;
  return {
    id: task.id, label: task.label, when: task.when,
    defaultPrompt: task.defaultPrompt, defaultOutput: task.output,
    prompt: row ? row.prompt : task.defaultPrompt,
    output: row && AI_SCAN_OUTPUTS.includes(row.output) ? row.output : task.output,
    newShapes: task.newShapes !== false,
    needsCourseMap: task.needsCourseMap === true,
    stored: !!row,
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null,
    outline: scanPromptOutline({ id: task.id, output: row && AI_SCAN_OUTPUTS.includes(row.output) ? row.output : task.output })
  };
}

export default async function courseMapAiPrompts(req) {
  if (req.method === "OPTIONS") return json(204, null);
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  const admin = await verifiedAdminEmail(req);
  if (!admin) return json(403, { error: "Admin verification failed" });

  if (req.method === "GET") {
    const stored = await storedTasks();
    return json(200, { tasks: AI_SCAN_TASKS.map(task => entry(task, stored)), outputs: AI_SCAN_OUTPUTS, promptMax: AI_SCAN_PROMPT_MAX });
  }
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "Invalid JSON" }); }
  const task = scanTask(payload && (payload.taskId || payload.id));
  if (!task) return json(400, { error: "unknown task" });

  if (payload.reset) {
    await deleteStoredTask(task.id);
    return json(200, { saved: entry(task, new Map()) });
  }
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) return json(400, { error: "prompt required (or reset: true to go back to the default)" });
  if (prompt.length > AI_SCAN_PROMPT_MAX) return json(400, { error: "prompt is over " + AI_SCAN_PROMPT_MAX + " characters" });
  const output = AI_SCAN_OUTPUTS.includes(payload.output) ? payload.output : task.output;
  const row = { task_id: task.id, prompt, output, updated_at: new Date().toISOString(), updated_by: admin };
  const saved = await writeStoredTask(row);
  return json(200, { saved: entry(task, new Map([[task.id, saved]])) });
}

export const config = { path: "/api/course-map-ai-prompts" };
