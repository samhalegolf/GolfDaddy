/* AI scan, the half that runs the model. Netlify background function: POST {courseId}
 * answers 202 at once and keeps running, which is what a vision call with thinking needs.
 *
 * Reads the request course-map-ai-scan.mjs parked on the overlay row (ai_scan, status
 * queued), sends the picture to Claude with the course's scorecard and the picture's scale
 * as context, converts the pixel answer to lat/lng through the same georef core the overlay
 * API uses, saves it as the overlay (append or replace, as asked), and writes the outcome
 * back on the row - what was found, what was dropped and why, what the model said, what it
 * cost. The picture is cleared from the row whatever happens.
 *
 * Trusts nothing from its own request but the course id: the caller was proven by the
 * synchronous half, and everything else comes from the row it wrote. */

import Anthropic from "@anthropic-ai/sdk";
import { imageGeoreference, aiShapesToOverlay } from "./lib/gd-overlay-georef-core.mjs";
import { buildScanPrompt, describeExisting, parseScanAnswer, AI_SCAN_OUTPUT_SCHEMA } from "./lib/gd-ai-scan-core.mjs";
import { scorecardCourseKey } from "./lib/gd-scorecard-resolve.mjs";
import { hasSupabase, slug, loadCourse, loadOverlay, loadScorecard, saveOverlay, writeAiScan, json } from "./lib/gd-map-overlay-store.mjs";

/* Claude Opus 5.5 by default: reading fairway edges out of a satellite picture is the kind
   of visual judgement the smaller tiers get wrong at the margins, and one scan a course is
   not a cost to economise. Thinking is on by default on this model; effort is the lever. */
const DEFAULT_MODEL = "claude-opus-5-5";
function scanModel() { return process.env.CLARITY_AI_SCAN_MODEL || DEFAULT_MODEL; }

async function callModel({ image, prompt }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  /* Streamed so a long answer (dozens of polygons) cannot hit an HTTP timeout; the server
     side fallback re-runs on another model if a safety classifier declines - a golf course
     never should, but the answer is then "no shapes" rather than a 200 with nothing in it. */
  const stream = client.beta.messages.stream({
    model: scanModel(),
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: AI_SCAN_OUTPUT_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
        { type: "text", text: prompt }
      ]
    }]
  });
  const message = await stream.finalMessage();
  const text = (message.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  return {
    text,
    model: message.model,
    stopReason: message.stop_reason,
    stopDetails: message.stop_details || null,
    usage: message.usage ? {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens || 0
    } : null
  };
}

async function runScan(courseId) {
  const saved = await loadOverlay(courseId);
  const request = saved.aiScan;
  if (!request || request.status !== "queued" || !request.image) return { ran: false, reason: request ? "status " + request.status : "no request" };

  const base = { requestedAt: request.requestedAt, requestedBy: request.requestedBy, append: !!request.append, georef: request.georef };
  await writeAiScan(courseId, Object.assign({}, base, { status: "running", startedAt: new Date().toISOString(), image: request.image, notes: request.notes, anchors: request.anchors, grid: request.grid }));

  const finish = async outcome => {
    /* The picture never outlives the scan: the outcome row carries counts and words, not a
       megabyte of JPEG. */
    const written = Object.assign({}, base, outcome, { finishedAt: new Date().toISOString() });
    await writeAiScan(courseId, written);
    return written;
  };

  try {
    const georef = imageGeoreference(request.georef);
    if (georef.error) return await finish({ status: "failed", error: "bad georef: " + georef.error });
    const course = await loadCourse(courseId);
    if (!course) return await finish({ status: "failed", error: "no course_maps row for " + courseId });
    const scorecard = await loadScorecard(course.name, scorecardCourseKey);
    const existing = request.append ? describeExisting(saved.features, p => georef.toPx(p)) : [];
    const prompt = buildScanPrompt({ course, scorecard, georef, existing, notes: request.notes, anchors: request.anchors, grid: request.grid });

    const answer = await callModel({ image: request.image, prompt });
    if (answer.stopReason === "refusal") {
      return await finish({ status: "failed", error: "the model declined: " + String(answer.stopDetails && answer.stopDetails.explanation || answer.stopDetails && answer.stopDetails.category || "refusal"), model: answer.model, usage: answer.usage });
    }
    if (answer.stopReason === "max_tokens") {
      return await finish({ status: "failed", error: "the answer was cut off at max_tokens - capture a smaller view", model: answer.model, usage: answer.usage });
    }
    const parsed = parseScanAnswer(answer.text);
    if (parsed.error) return await finish({ status: "failed", error: parsed.error, model: answer.model, usage: answer.usage, raw: answer.text.slice(0, 2000) });

    const converted = aiShapesToOverlay(parsed.features, georef);
    if (converted.error) return await finish({ status: "failed", error: converted.error, model: answer.model, usage: answer.usage });
    const confidence = {};
    parsed.features.forEach(f => { if (f.confidence != null) confidence[f.id] = f.confidence; });

    const savedResult = converted.features.length
      ? await saveOverlay({ courseId, features: converted.features, savedBy: request.requestedBy, append: request.append })
      : null;
    if (savedResult && savedResult.error) return await finish({ status: "failed", error: savedResult.error + (savedResult.detail ? " - " + savedResult.detail : ""), model: answer.model, usage: answer.usage });

    return await finish({
      status: "done",
      model: answer.model,
      usage: answer.usage,
      found: parsed.features.length,
      saved: converted.features.length,
      summary: savedResult ? savedResult.summary : { features: 0, fairways: 0, holeLines: 0, greens: 0, numbered: 0 },
      overlayTotal: savedResult ? savedResult.overlay.features.length : saved.features.length,
      features: converted.features.map(f => ({ id: f.id, kind: f.kind, confidence: confidence[f.id] != null ? confidence[f.id] : null })),
      pixels: converted.pixels,
      dropped: converted.dropped,
      notes: parsed.notes,
      scorecard: scorecard ? { holes: scorecard.holes.length, source: scorecard.source } : null
    });
  } catch (error) {
    const message = String(error && error.message || error).slice(0, 400);
    const status = error && Number.isFinite(Number(error.status)) ? " (HTTP " + error.status + ")" : "";
    return await finish({ status: "failed", error: message + status });
  }
}

export default async function courseMapAiScanBackground(req) {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Supabase is not configured" });
  let payload;
  try { payload = await req.json(); } catch (e) { payload = {}; }
  const courseId = slug(payload && payload.courseId);
  if (!courseId) return json(400, { error: "courseId required" });
  const result = await runScan(courseId);
  return json(200, { courseId, result });
}

export const __courseMapAiScanTest = { runScan, DEFAULT_MODEL };
