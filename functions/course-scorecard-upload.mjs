/* The drop zone on a course row: an admin hands us the scorecard.
 *
 * The resolver finds cards on the web when it can. When it cannot - a club with
 * no site, a card that only exists on paper, an aggregator that asked not to be
 * read - the admin has the card in hand and this is where it goes. Anything
 * that is already text is read here: a card pasted straight out of a web table,
 * CSV or tab-separated text, a saved HTML page, or a JSON card in the stored
 * shape (lib/gd-scorecard-upload-core). A photo is read in the browser by the
 * native OCR first and arrives here as text too; nothing in this path calls a
 * model, because an admin who has the card can get it into text faster than a
 * model can guess at a photograph.
 *
 * What it does with a card is exactly what Update Scorecards does with one it
 * found: store it under the course's facility (marked manual, so a later scrape
 * cannot quietly replace it) and, when the facility's cards now cover every
 * sibling course, name the courses from them (lib/gd-facility-scorecards).
 *
 * POST /api/course-scorecard-upload  { courseId, files:[{ name, mediaType, text }] }
 *   admin-auth gated. Returns the cards read, what was rejected and why, and the
 *   relabel outcome. 422 when nothing in the upload held a card.
 */

import { cardsFromUpload } from "./lib/gd-scorecard-upload-core.mjs";
import { loadFacilityChildren, facilityNameOf, fetchFacilityRows, cardsFromRows, storeFacilityCards, relabelFacility } from "./lib/gd-facility-scorecards.mjs";
import { distinctCards } from "./lib/gd-scorecard-resolve.mjs";
import { verifiedAdminEmail } from "./lib/gd-map-overlay-store.mjs";
import { createSupabaseFetch } from "./lib/gd-supabase-fetch.mjs";

const MAX_FILES = 12;
const MAX_FILE_CHARS = 650000;
export const UPLOAD_SOURCE = "manual-upload";

function env(name) { return process.env[name] || ""; }
function supabaseBase() { return env("SUPABASE_URL").replace(/\/+$/, ""); }
function supabaseKey() { return env("SUPABASE_SERVICE_ROLE_KEY"); }
function hasSupabase() { return !!(supabaseBase() && supabaseKey()); }

const supabaseFetch = createSupabaseFetch({
  base: supabaseBase,
  key: supabaseKey,
  label: "course-scorecard-upload"
});

function json(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept,Authorization"
    }
  });
}

/* The body's files, trimmed to what the parsers accept. A file is text here or it
   is nothing: the browser has already OCR'd any picture into text. */
function normaliseFiles(payload) {
  const list = Array.isArray(payload && payload.files) ? payload.files : [];
  return list.slice(0, MAX_FILES).map(file => ({
    name: String((file && file.name) || "").slice(0, 200),
    mediaType: String((file && file.mediaType) || "").slice(0, 100),
    text: typeof (file && file.text) === "string" ? file.text.slice(0, MAX_FILE_CHARS) : "",
    unit: /^(yards|metres)$/.test(String((file && file.unit) || "")) ? file.unit : ""
  })).filter(file => file.text || file.name);
}

/* What the admin sees back for each card: enough to check it is the right one. */
export function summariseCard(card) {
  const holes = card.holes || [];
  return {
    name: card.name || "",
    from: card.from || "",
    holes: holes.length,
    par: Number.isFinite(card.par) ? card.par : holes.reduce((sum, hole) => sum + (Number(hole.par) || 0), 0),
    distances: holes.filter(hole => Number.isFinite(hole.distanceM)).length,
    strokeIndexes: holes.filter(hole => Number.isFinite(hole.strokeIndex)).length,
    tees: card.teeOptions || Object.keys((holes[0] && holes[0].teesM) || {})
  };
}

export default async function courseScorecardUpload(req) {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!hasSupabase()) return json(503, { error: "Not configured" });

  let payload;
  try { payload = await req.json(); } catch (error) { return json(400, { error: "Invalid JSON" }); }

  const adminEmail = await verifiedAdminEmail(req);
  if (!adminEmail) return json(403, { error: "Admin session required" });

  const courseId = String((payload && payload.courseId) || "").trim();
  if (!courseId) return json(400, { error: "courseId required" });
  const files = normaliseFiles(payload);
  if (!files.length) return json(400, { error: "Nothing to read - drop a file or paste the card" });

  const facility = await loadFacilityChildren(supabaseFetch, courseId).catch(() => null);
  if (!facility) return json(404, { error: "No published course found for " + courseId });
  const { facilityKey, children, pinned } = facility;
  const facilityName = facilityNameOf(pinned, courseId);

  const read = cardsFromUpload(files, { name: facilityName });
  /* Pictures and PDFs are not read here: the browser OCRs a picture before it is
     sent, and a PDF is quicker exported as text than guessed at. Say so. */
  const rejected = read.rejected.concat(read.deferred.map(file => ({
    name: file.name, reason: file.kind === "pdf" ? "pdf-export-as-text" : "image-not-read"
  })));
  if (!read.cards.length) {
    return json(422, { error: "No scorecard table found in what was dropped", rejected, cards: [] });
  }

  const cards = read.cards.map(card => Object.assign({}, card, {
    source: UPLOAD_SOURCE,
    sourceUrl: "upload:" + (card.from || "pasted") + " by " + adminEmail,
    resolution: { confirmed: true, confidence: 1, by: adminEmail, at: new Date().toISOString() }
  }));
  const stored = await storeFacilityCards(supabaseFetch, { cards, name: facilityName, facilityKey });

  /* The facility's full evidence now, this upload included, decides the names. */
  const existing = cardsFromRows(await fetchFacilityRows(supabaseFetch, facilityKey));
  const relabel = await relabelFacility(supabaseFetch, { children, cards: distinctCards(existing.concat(cards)) });

  const plural = n => n === 1 ? "" : "s";
  const message = "Read " + cards.length + " card" + plural(cards.length) + " (" + cards.map(card => card.holes.length + " holes").join(", ") + "). "
    + (stored.length ? "Stored. " : "Not stored - a card must run 1..n with par on every hole. ")
    + relabel.message;

  return json(200, Object.assign({ facilityKey, cards: cards.map(summariseCard), stored: stored.length, rejected }, relabel, { message }));
}

export const config = {
  path: "/api/course-scorecard-upload"
};
