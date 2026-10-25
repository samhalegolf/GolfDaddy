/* "Ask AI for this card", the half that asks. Netlify background function: POST {courseId}
 * answers 202 at once and keeps running.
 *
 * Reads the queued ask course-scorecard-ask.mjs parked on the course's row, asks Claude -
 * with web search, so the numbers come from the club's own card and not from memory - for
 * the course's pars and lengths in the paste box's own tab-separated layout, runs the paste
 * box's parser over the answer, and writes the text and what the parser made of it back on
 * the row. Studio polls the row and drops the text into the paste box; the operator Imports.
 *
 * Trusts nothing from its own request but the course id. */

import Anthropic from "@anthropic-ai/sdk";
import { buildScorecardAskPrompt, readAskAnswer } from "./lib/gd-scorecard-ask-core.mjs";
import { hasSupabase, loadAsk, writeAsk, supabaseFetch } from "./lib/gd-scorecard-ask-store.mjs";
import { loadCourse, json } from "./lib/gd-map-overlay-store.mjs";
import { loadFacilityChildren } from "./lib/gd-facility-scorecards.mjs";
import { courseSlug } from "./lib/gd-course-slug.mjs";

/* Claude Opus 5.5, as the other model calls here: reading a club's card off its site and
   telling the men's tee from the ladies' is judgement work, and it runs once a course. */
const DEFAULT_MODEL = "claude-opus-5-5";
function askModel() { return process.env.CLARITY_SCORECARD_ASK_MODEL || DEFAULT_MODEL; }
/* How many times the model may come back with pause_turn (a long web search) and be let
   carry on before we call it a day. */
const MAX_CONTINUES = 4;

function slug(value) { return courseSlug(value).slice(0, 90); }

async function callModel(prompt) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [{ role: "user", content: prompt }];
  let message = null;
  const usage = { inputTokens: 0, outputTokens: 0, searches: 0 };
  for (let round = 0; round <= MAX_CONTINUES; round++) {
    /* Streamed so a long search cannot hit an HTTP timeout; server-side fallback so a safety
       decline re-runs on another model rather than arriving as an empty 200. */
    const stream = client.beta.messages.stream({
      model: askModel(),
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
      messages
    });
    message = await stream.finalMessage();
    if (message.usage) {
      usage.inputTokens += message.usage.input_tokens || 0;
      usage.outputTokens += message.usage.output_tokens || 0;
      usage.searches += (message.usage.server_tool_use && message.usage.server_tool_use.web_search_requests) || 0;
    }
    if (message.stop_reason !== "pause_turn") break;
    /* The server paused a long tool turn: hand the content back and let it continue. */
    messages.push({ role: "assistant", content: message.content });
  }
  const text = (message.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  return { text, model: message.model, stopReason: message.stop_reason, stopDetails: message.stop_details || null, usage };
}

async function runAsk(courseId) {
  const ask = await loadAsk(courseId);
  if (!ask || ask.status !== "queued") return { ran: false, reason: ask ? "status " + ask.status : "no request" };
  await writeAsk(courseId, { status: "running", started_at: new Date().toISOString() });
  const finish = columns => writeAsk(courseId, Object.assign({ finished_at: new Date().toISOString() }, columns));
  try {
    const course = await loadCourse(courseId);
    if (!course) return await finish({ status: "failed", error: "no course_maps row for " + courseId });
    const facility = await loadFacilityChildren(supabaseFetch, courseId).catch(() => null);
    const siblings = facility ? facility.children.map(row => row.course_name).filter(Boolean) : [];
    const prompt = buildScorecardAskPrompt({ course, siblings });
    const answer = await callModel(prompt);
    if (answer.stopReason === "refusal") {
      return await finish({ status: "failed", error: "the model declined: " + String(answer.stopDetails && (answer.stopDetails.explanation || answer.stopDetails.category) || "refusal"), model: answer.model, usage: answer.usage });
    }
    if (answer.stopReason === "max_tokens") return await finish({ status: "failed", error: "the answer was cut off at max_tokens", model: answer.model, usage: answer.usage });
    if (answer.stopReason === "pause_turn") return await finish({ status: "failed", error: "the search did not finish in " + (MAX_CONTINUES + 1) + " rounds", model: answer.model, usage: answer.usage });
    const read = readAskAnswer(answer.text);
    if (read.error) return await finish({ status: "failed", error: read.error, model: answer.model, usage: answer.usage });
    /* Stored whether or not the paste box can read it: a card the parser rejected is still
       worth a look, and the operator can fix a line and Import. The notes say so. */
    const notes = (read.readable ? "" : "The paste box could not read this as a card - check the rows. ") + (read.notes || "");
    return await finish({
      status: "done", card_text: read.cardText, unit: read.unit || null, source: read.source || null,
      confidence: read.confidence || null, notes: notes.trim() || null, error: null, model: answer.model, usage: Object.assign({}, answer.usage, { cards: read.cards, holes: read.holes, tees: read.tees })
    });
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 400);
    const status = error && Number.isFinite(Number(error.status)) ? " (HTTP " + error.status + ")" : "";
    return await finish({ status: "failed", error: message + status });
  }
}

export default async function courseScorecardAskBackground(req) {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  let payload;
  try { payload = await req.json(); } catch (e) { payload = {}; }
  const courseId = slug(payload && payload.courseId);
  if (!courseId) return json(400, { error: "courseId required" });
  return json(200, { courseId, result: await runAsk(courseId) });
}

export const __courseScorecardAskTest = { runAsk, DEFAULT_MODEL };
