/* AI scan of a satellite picture: what we ask, what shape the answer must take, and how the
 * answer is read. Pure - no network, no SDK - so the prompt and the parser are testable and
 * the endpoint that calls the model stays thin.
 *
 * The job the model is given is deliberately narrow. It does NOT number holes: the native
 * resolver numbers from the scorecard once the shapes exist, and a wrong number from a model
 * would be a confident lie the resolver then has to argue with. It does NOT need an exact
 * green: the green is an estimate of shape and centre, enough for the resolver to link a
 * fairway to it and for the mapper to write a polygon. What it must get right is which
 * mown corridors are fairways and roughly where each one ends.
 *
 * The scorecard goes in as context for FINDING things - "there are 18 holes, four of them
 * par 3s, the longest is 520 yards" tells a model how many corridors to look for and how
 * long they should be - not as a numbering key. */

export const AI_SCAN_MAX_FEATURES = 60;
export const AI_SCAN_MAX_POINTS = 24;

/* The answer, as a JSON schema for structured output. Pixels as [x, y] integer pairs in the
   image the model was shown; kind limited to what the overlay stores. `hole` is allowed but
   optional and the prompt says not to guess it. `confidence` is the model's own, kept on the
   feature for the operator to read, never used to filter here. */
export const AI_SCAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["features", "notes"],
  properties: {
    features: {
      type: "array",
      maxItems: AI_SCAN_MAX_FEATURES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "points", "confidence"],
        properties: {
          kind: { type: "string", enum: ["fairway", "green"] },
          points: {
            type: "array",
            minItems: 3,
            maxItems: AI_SCAN_MAX_POINTS,
            items: { type: "array", minItems: 2, maxItems: 2, items: { type: "integer" } }
          },
          hole: { type: ["integer", "null"], minimum: 1, maximum: 36 },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    },
    notes: { type: "string" }
  }
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

/* One line per hole from the shared scorecard, in the units the card carries. Tolerant on
   field names because cards arrive from several parsers (holeNumber/hole/number,
   distanceM/yards/metres). */
export function scorecardLines(evidence) {
  const holes = evidence && Array.isArray(evidence.holes) ? evidence.holes : [];
  return holes.map(row => {
    const n = num(row && (row.holeNumber ?? row.hole ?? row.number));
    if (!n) return null;
    const par = num(row.par);
    const metres = num(row.distanceM ?? row.metres ?? row.meters);
    const yards = num(row.yards ?? row.distanceYd);
    const length = metres != null ? Math.round(metres) + "m" : yards != null ? Math.round(yards) + "yd" : "";
    return "hole " + n + (par ? " par " + par : "") + (length ? " " + length : "");
  }).filter(Boolean);
}

export function buildScanPrompt({ course, scorecard, georef, existing, notes }) {
  const name = String(course && course.name || "the course");
  const lines = scorecardLines(scorecard);
  const parts = [];
  parts.push("This is a satellite image of " + name + ", a golf course. Trace the golf features you can see in it.");
  parts.push("Image: " + georef.width + " x " + georef.height + " pixels, about " + georef.metresPerPixel.toFixed(2) +
    " metres per pixel, north up. Pixel (0,0) is the top-left corner; x runs right, y runs down. " +
    "For scale: a green is typically 20-40 m across (" + Math.round(20 / georef.metresPerPixel) + "-" + Math.round(40 / georef.metresPerPixel) +
    " px) and a fairway 25-50 m wide.");
  if (lines.length) {
    parts.push("The course's scorecard, for context about how many holes there are and how long they are (NOT for numbering - do not try to match holes to numbers):\n" + lines.join("\n"));
  } else {
    parts.push("No scorecard is available; use what you can see.");
  }
  if (existing && existing.length) {
    parts.push("Shapes already recorded for this course (do not repeat these, but you may trace the ground around them): " + existing.join("; ") + ".");
  }
  parts.push([
    "Return:",
    "- one \"fairway\" polygon for each mown fairway corridor, from the landing area to the approach, stopping short of the green (do not include the green or the tee box in a fairway),",
    "- one \"green\" polygon for each putting green, as an estimate of its shape and position - the centre matters more than the exact edge,",
    "- nothing for tees, bunkers, water, practice greens, driving ranges, or ground you cannot see clearly.",
    "Polygons are lists of [x, y] integer pixel corners, 4 to " + AI_SCAN_MAX_POINTS + " points, in order around the shape, entirely inside the image. Leave \"hole\" null unless a number is painted on the ground. Set \"confidence\" between 0 and 1 for each shape. Put anything you want the operator to know in \"notes\" - cut-off holes at the image edge, areas you were unsure about."
  ].join("\n"));
  if (notes) parts.push("From the operator: " + String(notes).slice(0, 600));
  return parts.join("\n\n");
}

/* Short descriptions of saved shapes for the prompt, so a second picture over the same
   ground does not re-trace what the first one found. Pixel positions in THIS image, from the
   caller's projector, so the model can relate them to what it sees. */
export function describeExisting(features, toPx) {
  return (features || []).map(f => {
    const pts = (f.points || []).map(toPx).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pts.length) return null;
    const cx = Math.round(pts.reduce((s, p) => s + p.x, 0) / pts.length);
    const cy = Math.round(pts.reduce((s, p) => s + p.y, 0) / pts.length);
    return f.kind + (f.hole ? " (hole " + f.hole + ")" : "") + " around (" + cx + ", " + cy + ")";
  }).filter(Boolean);
}

/* The model's answer as the feature list aiShapesToOverlay reads. Structured output means
   the shape is normally exact, but the parser stays tolerant - a text block holding JSON, a
   fenced block, an answer wrapped in {features} or a bare array - because the cost of being
   strict here is a whole scan thrown away over a formatting slip. */
export function parseScanAnswer(answer) {
  let value = answer;
  if (typeof value === "string") {
    const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(text); }
    catch (e) {
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return { features: [], notes: "", error: "answer was not JSON" };
      try { value = JSON.parse(text.slice(start, end + 1)); } catch (e2) { return { features: [], notes: "", error: "answer was not JSON" }; }
    }
  }
  if (Array.isArray(value)) value = { features: value };
  if (!value || typeof value !== "object") return { features: [], notes: "", error: "answer was empty" };
  const features = (Array.isArray(value.features) ? value.features : []).slice(0, AI_SCAN_MAX_FEATURES).map((f, i) => ({
    id: (f && f.kind === "green" ? "green" : "fairway") + "-ai-" + (i + 1),
    kind: f && f.kind,
    points: f && f.points,
    hole: f && f.hole != null ? f.hole : null,
    confidence: f && Number.isFinite(Number(f.confidence)) ? Number(f.confidence) : null
  }));
  return { features, notes: String(value.notes || "").slice(0, 2000) };
}
