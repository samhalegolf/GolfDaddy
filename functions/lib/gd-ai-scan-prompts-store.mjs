/* The operator's saved words per AI help task (table ai_scan_prompts), read by the scan
 * background function and by the admin endpoint that edits them. One place, so a scan and
 * the editor cannot disagree about what is stored. */
import { createSupabaseFetch } from "./gd-supabase-fetch.mjs";
import { AI_SCAN_TASKS, defaultTaskId } from "./gd-ai-scan-core.mjs";

export const AI_SCAN_PROMPTS_TABLE = "ai_scan_prompts";

function env(name) { return process.env[name] || ""; }
const supabaseFetch = createSupabaseFetch({
  base: () => env("SUPABASE_URL").replace(/\/+$/, ""),
  key: () => env("SUPABASE_SERVICE_ROLE_KEY"),
  label: "ai-scan-prompts"
});

/* Every stored override, by task id. A missing table or a transient fault reads as "nothing
   stored" - the defaults run - never as a failed scan. */
export async function storedTasks() {
  const rows = await supabaseFetch(AI_SCAN_PROMPTS_TABLE + "?select=task_id,prompt,output,updated_at,updated_by").catch(() => []);
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.task_id, row]));
}

/* The stored override for one task, or for the task that fits the view when none is named. */
export async function storedTask(taskId, shapes) {
  const id = AI_SCAN_TASKS.some(task => task.id === taskId) ? taskId : defaultTaskId(shapes);
  const row = (await storedTasks()).get(id) || null;
  return row ? { prompt: row.prompt, output: row.output } : null;
}

export async function writeStoredTask(row) {
  const written = await supabaseFetch(AI_SCAN_PROMPTS_TABLE + "?on_conflict=task_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(row)
  });
  return Array.isArray(written) && written[0] ? written[0] : row;
}

export async function deleteStoredTask(taskId) {
  await supabaseFetch(AI_SCAN_PROMPTS_TABLE + "?task_id=eq." + encodeURIComponent(taskId), { method: "DELETE" });
}
