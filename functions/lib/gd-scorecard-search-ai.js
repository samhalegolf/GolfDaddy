"use strict";

/* Scorecard page search by Claude instead of a search engine.

   The engine route in ../scorecard-search.js runs a ladder of a dozen queries through
   Brave or Google CSE and ranks whatever comes back. This asks Claude once, with web
   search, for the pages most likely to carry the course's hole-by-hole table, and hands
   back the same {url, title, snippet} rows so the caller's ranking and the fetch path
   stay exactly as they were. Nothing here writes anywhere; it only finds URLs.

   On while SCORECARD_SEARCH_PROVIDER is unset or "ai" and ANTHROPIC_API_KEY is set.
   Set SCORECARD_SEARCH_PROVIDER=web to go back to the search engines. */

const Anthropic = require("@anthropic-ai/sdk");

/* Finding URLs is lookup work, not judgement, and it runs on every mapper job. */
const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_CONTINUES = 2;
const MAX_RESULTS = 12;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["url", "title", "snippet"],
        properties: {
          url: { type: "string" },
          title: { type: "string" },
          snippet: { type: "string" }
        }
      }
    }
  }
};

function searchModel() { return process.env.CLARITY_SCORECARD_SEARCH_MODEL || DEFAULT_MODEL; }

function aiSearchEnabled() {
  const choice = String(process.env.SCORECARD_SEARCH_PROVIDER || "ai").toLowerCase();
  return choice === "ai" && !!process.env.ANTHROPIC_API_KEY;
}

function buildPrompt(identity) {
  const names = [...new Set([identity.rawName].concat(identity.aliases || [], identity.transliterations || []).filter(Boolean))];
  const where = [identity.city, identity.region, identity.country].filter(Boolean).join(", ");
  const pin = Number.isFinite(identity.lat) && Number.isFinite(identity.lng)
    ? " It is at latitude " + identity.lat.toFixed(5) + ", longitude " + identity.lng.toFixed(5) + "."
    : "";
  const loops = (identity.candidateLoopNames || []).filter(Boolean);
  return [
    "Find web pages that publish the scorecard of " + (names[0] || "a golf course") + ", a golf course" + (where ? " in " + where : "") + "." + pin +
    (names.length > 1 ? " The course is also written as: " + names.slice(1).join("; ") + "." : "") +
    (loops.length ? " It may have more than one course or nine, named: " + loops.join(", ") + "." : ""),
    "A scorecard page is one that lists every hole with its par and length (yards or metres), usually with the stroke index. Look for, in this order: the club's own website (scorecard, hole-by-hole, course guide or course page), the national golf federation or union's course entry, then a reputable course directory. Skip Facebook, Instagram, X, YouTube, TripAdvisor, news and blog posts.",
    "Search the web and return up to " + MAX_RESULTS + " candidate pages, best first. Only return URLs that actually appeared in your search results; never invent or guess a URL. For each give the page title and one short line on why it is likely to hold the hole-by-hole table. Return an empty list if you find nothing."
  ].join("\n\n");
}

/* identity - from gd-course-search-identity buildCourseSearchIdentity. Resolves to
   {results: [{url, title, snippet}], model, usage}. Throws on a model refusal or a cut-off
   answer, same as a search engine error, so the caller reports it. */
async function searchScorecardPagesWithAi(identity) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const messages = [{ role: "user", content: buildPrompt(identity || {}) }];
  const usage = { inputTokens: 0, outputTokens: 0, searches: 0 };
  let message = null;
  for (let round = 0; round <= MAX_CONTINUES; round++) {
    const stream = client.beta.messages.stream({
      model: searchModel(),
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages
    });
    message = await stream.finalMessage();
    if (message.usage) {
      usage.inputTokens += message.usage.input_tokens || 0;
      usage.outputTokens += message.usage.output_tokens || 0;
      usage.searches += (message.usage.server_tool_use && message.usage.server_tool_use.web_search_requests) || 0;
    }
    if (message.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: message.content });
  }
  if (message.stop_reason === "refusal") throw new Error("the model declined to search");
  if (message.stop_reason === "max_tokens") throw new Error("the answer was cut off at max_tokens");
  if (message.stop_reason === "pause_turn") throw new Error("the search did not finish in " + (MAX_CONTINUES + 1) + " rounds");
  const text = (message.content || []).filter(block => block.type === "text").map(block => block.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error("the model answered with something other than JSON"); }
  const results = (Array.isArray(parsed && parsed.results) ? parsed.results : []).slice(0, MAX_RESULTS).map(row => ({
    url: String(row && row.url || "").trim(),
    title: String(row && row.title || "").trim(),
    snippet: String(row && row.snippet || "").trim()
  })).filter(row => row.url);
  return { results, model: message.model, usage };
}

module.exports = { aiSearchEnabled, buildPrompt, searchScorecardPagesWithAi, DEFAULT_MODEL };
