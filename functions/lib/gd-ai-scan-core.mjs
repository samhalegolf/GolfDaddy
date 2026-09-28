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
 * long they should be - not as a numbering key.
 *
 * The order of work is evidence first, routing second: greens by what a green looks like,
 * fairways as the corridors that lead to them, tees at the far ends, and only then the
 * course map and the card to settle clashes and counts. The first live scan did it the
 * other way round - it read the routing off bunker clusters and placed greens where holes
 * "should" end - and a green that is inferred rather than seen is exactly the kind of
 * confident wrong answer the resolver cannot argue with. */

export const AI_SCAN_MAX_FEATURES = 60;
export const AI_SCAN_MAX_POINTS = 24;

/* The answer, as a JSON schema for structured output. Pixels as [x, y] integer pairs in the
   image the model was shown; kind limited to what the overlay stores. `hole` is optional and
   the prompt says not to guess it. `confidence` is the model's own, kept on the feature for
   the operator to read, never used to filter here.

   Deliberately no minItems/maxItems/minimum/maximum: the structured-output schema language
   rejects them ("For 'array' type, property 'maxItems' is not supported" - the first live
   scan died on exactly that). The limits live in the prompt and in parseScanAnswer, which
   caps the list and drops thin shapes, and in the georef core, which drops what is off the
   image. A schema that the API refuses is a scan that never runs. */
export const AI_SCAN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["features", "notes"],
  properties: {
    features: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "points", "confidence"],
        properties: {
          kind: { type: "string", enum: ["fairway", "green", "tee"] },
          points: {
            type: "array",
            items: { type: "array", items: { type: "integer" } }
          },
          hole: { type: "integer" },
          confidence: { type: "number" }
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

export function buildScanPrompt({ course, scorecard, georef, existing, notes, anchors, grid, courseMap }) {
  const name = String(course && course.name || "the course");
  const lines = scorecardLines(scorecard);
  const holeCount = lines.length || null;
  const parts = [];
  parts.push("Image 1 is a satellite image of " + name + ", a golf course. Trace the golf features you can SEE in it.");
  parts.push("Image 1: " + georef.width + " x " + georef.height + " pixels, about " + georef.metresPerPixel.toFixed(2) +
    " metres per pixel, north up. Pixel (0,0) is the top-left corner; x runs right, y runs down. " +
    "For scale: a green is typically 20-40 m across (" + Math.round(20 / georef.metresPerPixel) + "-" + Math.round(40 / georef.metresPerPixel) +
    " px), a fairway 25-50 m wide, a tee box 8-20 m long.");
  if (grid > 0) {
    parts.push("A coordinate grid is drawn over image 1: thin white lines every " + grid + " pixels, with the x value of each vertical line printed in yellow along the top edge and the y value of each horizontal line along the left edge. " +
      "Read every coordinate you return off this grid - it is authoritative. A point midway between the lines labelled 256 and 384 is at 320.");
  }
  const known = (anchors || []).filter(a => a && !a.saved && a.kind === "green");
  const saved = (anchors || []).filter(a => a && a.saved);
  if (known.length) {
    parts.push("Greens confirmed by map data are outlined in bright green on image 1 and labelled " + known[0].label + " to " + known[known.length - 1].label +
      ", pixel centres " + known.map(a => a.label + " (" + a.x + ", " + a.y + ")").join(", ") + ". " +
      "They show you what a green looks like in this image. Do not return them; find every other green by the same appearance.");
  }
  if (saved.length) {
    parts.push("Shapes outlined in white are already recorded (" + saved.map(a => a.kind + " at (" + a.x + ", " + a.y + ")").join(", ") + "); do not return them.");
  }
  if (existing && existing.length && !saved.length) {
    parts.push("Shapes already recorded for this course (do not repeat these, but you may trace the ground around them): " + existing.join("; ") + ".");
  }
  if (courseMap) {
    parts.push("Image 2 is the club's own course map, a schematic drawing. It is NOT to scale and NOT aligned with image 1: never take a coordinate from it. Use it only to settle doubts - which of two corridors is the fairway, whether a mown patch is a green or a practice area, whether you have found too many or too few holes.");
  }
  if (lines.length) {
    parts.push("The scorecard, for the same purpose - how many holes there are (" + holeCount + ") and how long they are - never for numbering:\n" + lines.join("\n"));
  } else {
    parts.push("No scorecard is available; use what you can see.");
  }
  parts.push([
    "Work in this order, and return only what the image shows:",
    "1. GREENS. Find every putting green by appearance alone: a small, smooth, very evenly mown area, usually lighter or finer in texture than the fairway, roughly round or kidney-shaped, 20-40 m across, often with bunkers cut into its edge and a mown fringe around it. Return a \"green\" only when you can see one. Never place a green because the routing suggests one should be there - if a hole seems to need a green you cannot see, leave it out and say so in notes.",
    "2. FAIRWAYS. Find every mown corridor 25-50 m wide that leads to a green (one you found, or a confirmed one). Return a \"fairway\" polygon from the landing area to the approach, stopping short of the green - do not include the green or the tee in it.",
    "3. TEES. At the far end of each fairway from its green, look for the tee boxes: small flat mown pads, rectangular or oval, 8-20 m long, often two to four in a line. Return a \"tee\" polygon around the group where you can see them.",
    "4. CHECK. If you have more greens or fairways than the course has holes, or two shapes claim the same ground, use the course map (if given) and the scorecard to decide which to drop. Return nothing for bunkers, water, practice greens, driving ranges, or ground you cannot see clearly.",
    "Polygons are lists of [x, y] integer pixel corners in image 1, 4 to " + AI_SCAN_MAX_POINTS + " points, in order around the shape, entirely inside the image. Omit \"hole\" unless a number is painted on the ground. Set \"confidence\" between 0 and 1 for each shape: how sure you are that it IS what you say, judged from the picture. Put anything the operator should know in \"notes\" - holes cut off at the edge, greens you expected but could not see, ground you were unsure about."
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
  /* The limits the schema cannot carry are applied here: at most AI_SCAN_MAX_FEATURES
     shapes, at most AI_SCAN_MAX_POINTS corners each, confidence clamped to 0..1, a hole
     number only when it is one. */
  const features = (Array.isArray(value.features) ? value.features : []).slice(0, AI_SCAN_MAX_FEATURES).map((f, i) => {
    const hole = num(f && f.hole);
    const confidence = num(f && f.confidence);
    const kind = f && (f.kind === "green" || f.kind === "tee") ? f.kind : "fairway";
    return {
      id: kind + "-ai-" + (i + 1),
      kind: f && f.kind,
      points: (f && Array.isArray(f.points) ? f.points : []).slice(0, AI_SCAN_MAX_POINTS),
      hole: hole != null && Number.isInteger(hole) && hole >= 1 && hole <= 36 ? hole : null,
      confidence: confidence == null ? null : Math.max(0, Math.min(1, confidence))
    };
  });
  return { features, notes: String(value.notes || "").slice(0, 2000) };
}
