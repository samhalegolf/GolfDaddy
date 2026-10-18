/* The second pass of a pin scan: every green and tee pin the first pass dropped is looked at
 * again in close-up before it is kept. Pure - no sharp, no SDK - so the windows, the prompt,
 * the parser and the corrections are testable; gd-ai-scan-crops.mjs cuts the pictures and
 * the background function calls the model.
 *
 * Why: a scan that works from the club's course map knows roughly where each hole is and
 * will happily put a pin there whether or not the picture shows a green - Karana Downs got
 * pins on the river. In the full scan picture a tee is 15-30 px long, too small to judge. A
 * crop a couple of hundred metres across, scaled up, with the pin marked, asks a narrower
 * question the model answers well: is there an actual green (or tee) here, and if so where
 * exactly? The answer moves a pin onto the shape it can see, confirms it, or drops it with
 * what the ground really is. Fairway pins are not checked themselves, but their ends follow
 * their hole's green and tee when those move. */

export const VERIFY_WINDOW_M = 220;
export const VERIFY_CROP_PX = 640;
export const VERIFY_GRID_PX = 128;
export const VERIFY_MAX_CROPS = 40;
export const VERIFY_VERDICTS = ["confirmed", "moved", "missing"];

/* The answer, one check per crop. Same schema dialect as the scan's: no minItems/maximum. */
export const VERIFY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["checks", "notes"],
  properties: {
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["crop", "verdict", "seen", "confidence"],
        properties: {
          crop: { type: "integer" },
          verdict: { type: "string", enum: VERIFY_VERDICTS },
          point: { type: "array", items: { type: "integer" } },
          seen: { type: "string" },
          confidence: { type: "number" }
        }
      }
    },
    notes: { type: "string" }
  }
};

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function pinPoint(feature) {
  const p = feature && Array.isArray(feature.points) ? feature.points[0] : null;
  if (!p) return null;
  const x = num(Array.isArray(p) ? p[0] : p.x), y = num(Array.isArray(p) ? p[1] : p.y);
  return x == null || y == null ? null : { x, y };
}

/* The pins worth a close-up: single-point green and tee pins, in answer order, capped. */
export function verifyTargets(features) {
  return (Array.isArray(features) ? features : [])
    .filter(f => f && f.pin && (f.kind === "green" || f.kind === "tee"))
    .map(f => { const p = pinPoint(f); return p ? { id: f.id, kind: f.kind, hole: f.hole || null, seen: f.seen || "", x: p.x, y: p.y } : null; })
    .filter(Boolean)
    .slice(0, VERIFY_MAX_CROPS);
}

/* Where each crop is cut from the scan picture: a square VERIFY_WINDOW_M across, centred on
   the pin, slid (not shrunk) to stay inside the image, and scaled to VERIFY_CROP_PX. `pin`
   is where the pin lands inside the crop; `scale` crop px per image px. */
export function cropWindows(targets, georef, options = {}) {
  const windowM = options.windowM || VERIFY_WINDOW_M;
  const outPx = options.cropPx || VERIFY_CROP_PX;
  const width = Math.round(georef.width), height = Math.round(georef.height);
  const mpp = georef.metresPerPixel;
  let side = Math.round(windowM / mpp);
  side = Math.max(32, Math.min(side, width, height));
  return targets.map((t, i) => {
    let left = Math.round(t.x - side / 2), top = Math.round(t.y - side / 2);
    left = Math.max(0, Math.min(left, width - side));
    top = Math.max(0, Math.min(top, height - side));
    const scale = outPx / side;
    return {
      crop: i + 1, id: t.id, kind: t.kind, hole: t.hole, seen: t.seen,
      left, top, side, scale, outPx,
      metresPerPixel: mpp / scale,
      pin: { x: Math.round((t.x - left) * scale), y: Math.round((t.y - top) * scale) }
    };
  });
}

/* What is drawn over a crop so the model can read coordinates and see the pin: a labelled
   grid like the scan picture's, and a magenta crosshair on the pin (magenta because nothing
   on a golf course is). Returned as SVG for sharp to composite. */
export function cropOverlaySvg(window, grid = VERIFY_GRID_PX) {
  const size = window.outPx;
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '">'];
  for (let v = grid; v < size; v += grid) {
    parts.push('<line x1="' + v + '" y1="0" x2="' + v + '" y2="' + size + '" stroke="white" stroke-opacity="0.55" stroke-width="1"/>');
    parts.push('<line x1="0" y1="' + v + '" x2="' + size + '" y2="' + v + '" stroke="white" stroke-opacity="0.55" stroke-width="1"/>');
    parts.push('<text x="' + (v + 3) + '" y="14" font-family="sans-serif" font-size="13" font-weight="bold" fill="#ffe84c" stroke="black" stroke-width="0.6">' + v + "</text>");
    parts.push('<text x="3" y="' + (v - 3) + '" font-family="sans-serif" font-size="13" font-weight="bold" fill="#ffe84c" stroke="black" stroke-width="0.6">' + v + "</text>");
  }
  const { x, y } = window.pin;
  const r = 22;
  parts.push('<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="none" stroke="#ff2fd6" stroke-width="3"/>');
  parts.push('<line x1="' + (x - r * 2) + '" y1="' + y + '" x2="' + (x - r) + '" y2="' + y + '" stroke="#ff2fd6" stroke-width="3"/>');
  parts.push('<line x1="' + (x + r) + '" y1="' + y + '" x2="' + (x + r * 2) + '" y2="' + y + '" stroke="#ff2fd6" stroke-width="3"/>');
  parts.push('<line x1="' + x + '" y1="' + (y - r * 2) + '" x2="' + x + '" y2="' + (y - r) + '" stroke="#ff2fd6" stroke-width="3"/>');
  parts.push('<line x1="' + x + '" y1="' + (y + r) + '" x2="' + x + '" y2="' + (y + r * 2) + '" stroke="#ff2fd6" stroke-width="3"/>');
  parts.push("</svg>");
  return parts.join("");
}

const GREEN_CLOSE = "a putting green: a smooth, evenly mown, usually lighter patch, round or kidney-shaped, with a mown fringe and often bunkers cut into its edge";
const TEE_CLOSE = "a tee: one or more small flat mown pads, rectangular or oval, often two to four in a line, at the start of a hole";

/* The question put with the crops. Each crop is described by number so the answer can name
   it; the scale is given so the model knows how big a green should look. */
export function buildVerifyPrompt({ course, windows, grid = VERIFY_GRID_PX }) {
  const name = String(course && course.name || "the course");
  const first = windows[0];
  const mpp = first ? first.metresPerPixel : 0.35;
  const px = m => Math.round(m / mpp);
  const lines = windows.map(w => "Crop " + w.crop + ": the " + w.kind + " pin" + (w.hole ? " for hole " + w.hole : "") + ", marked at (" + w.pin.x + ", " + w.pin.y + ")" + (w.seen ? ' - the first pass said it saw "' + String(w.seen).slice(0, 120) + '"' : ""));
  return [
    "These " + windows.length + " crops are close-ups cut from the satellite image of " + name + " that you just scanned. Each is a square " + Math.round(first ? first.side * (mpp * first.scale) : VERIFY_WINDOW_M) + " m across, scaled to " + (first ? first.outPx : VERIFY_CROP_PX) + " x " + (first ? first.outPx : VERIFY_CROP_PX) + " pixels (about " + mpp.toFixed(2) + " m per pixel), north up, centred on one of the pins you placed. The pin is marked with a magenta ring and crosshair. A white grid every " + grid + " pixels has its x values printed in yellow along the top and y values down the left; read every coordinate off it.",
    "At this scale " + GREEN_CLOSE + " is " + px(20) + "-" + px(40) + " px across, and " + TEE_CLOSE + " is " + px(8) + "-" + px(20) + " px long per pad. Water is dark, flat and textureless; roofs are hard-edged with shadows; trees are rough, lumpy canopy; rough and scrub are coarse and patchy; a fairway is mown but wider and longer than a green.",
    "For each crop, look at the ground under the crosshair and across the whole crop, then answer: \"confirmed\" when the feature of that kind IS under the crosshair (its centre within about " + px(15) + " px of it); \"moved\" when a feature of that kind is visible elsewhere in the crop - give \"point\", its centre in crop pixels; \"missing\" when nothing of that kind is visible anywhere in the crop. Say in \"seen\" what the ground under the crosshair actually is, in a few words. Judge by what you can see, never by where the pin is or what the first pass said: a pin on water, a roof, a road, bare earth or tree canopy is wrong, and if the real feature is not in the crop the answer is \"missing\". When two shapes in a crop could be the feature, prefer the one nearest the crosshair.",
    "The crops:\n" + lines.join("\n"),
    "Answer with one check per crop, every crop answered, \"confidence\" 0 to 1 for the verdict, and anything else worth knowing in \"notes\"."
  ].join("\n\n");
}

/* The model's checks, by crop number, with a moved point converted back to scan-image
   pixels. Tolerant of JSON in text as the scan parser is. A crop with no check, an unknown
   verdict, or a "moved" without a usable point inside the crop reads as unanswered - the
   pin is then left as it was, never dropped on a formatting slip. */
export function parseVerifyAnswer(answer, windows) {
  let value = answer;
  if (typeof value === "string") {
    const text = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try { value = JSON.parse(text); }
    catch (e) {
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return { checks: {}, notes: "", error: "answer was not JSON" };
      try { value = JSON.parse(text.slice(start, end + 1)); } catch (e2) { return { checks: {}, notes: "", error: "answer was not JSON" }; }
    }
  }
  if (!value || typeof value !== "object") return { checks: {}, notes: "", error: "answer was empty" };
  const byCrop = new Map(windows.map(w => [w.crop, w]));
  const checks = {};
  (Array.isArray(value.checks) ? value.checks : []).forEach(c => {
    const crop = num(c && c.crop);
    const w = crop != null ? byCrop.get(crop) : null;
    if (!w || checks[crop]) return;
    const verdict = VERIFY_VERDICTS.includes(c.verdict) ? c.verdict : null;
    if (!verdict) return;
    const confidence = num(c.confidence);
    const check = { crop, id: w.id, verdict, seen: String(c.seen || "").slice(0, 160), confidence: confidence == null ? null : Math.max(0, Math.min(1, confidence)) };
    if (verdict === "moved") {
      const p = Array.isArray(c.point) ? c.point : [];
      const cx = num(p[0]), cy = num(p[1]);
      if (cx == null || cy == null || cx < 0 || cy < 0 || cx > w.outPx || cy > w.outPx) return;
      check.point = { x: Math.round(w.left + cx / w.scale), y: Math.round(w.top + cy / w.scale) };
      /* A "moved" that lands back on the pin is a confirmation. */
      if (Math.hypot(check.point.x - (w.left + w.pin.x / w.scale), check.point.y - (w.top + w.pin.y / w.scale)) * w.metresPerPixel * w.scale < 8) { check.verdict = "confirmed"; delete check.point; }
    }
    checks[crop] = check;
  });
  return { checks, notes: String(value.notes || "").slice(0, 2000) };
}

/* The first pass's features after the checks: a moved green or tee takes its new point, a
   missing one is dropped with what the ground was, everything else is kept. A fairway pin's
   two points follow its hole's tee (start) and green (end) by the same shift, so a corridor
   stays joined to the shapes it runs between. Returns the new list, the drops in the scan's
   {index, reason} form, and counts for the outcome row. */
export function applyVerification(features, parsed, windows) {
  const list = Array.isArray(features) ? features : [];
  const checks = parsed && parsed.checks ? parsed.checks : {};
  const byId = {};
  windows.forEach(w => { const c = checks[w.crop]; if (c) byId[w.id] = c; });
  const summary = { checked: windows.length, confirmed: 0, moved: 0, missing: 0, unanswered: 0 };
  const shift = {};
  windows.forEach(w => {
    const c = byId[w.id];
    if (!c) { summary.unanswered += 1; return; }
    summary[c.verdict] += 1;
    if (c.verdict === "moved" && w.hole) shift[w.kind + ":" + w.hole] = { dx: c.point.x - Math.round(w.left + w.pin.x / w.scale), dy: c.point.y - Math.round(w.top + w.pin.y / w.scale) };
  });
  const dropped = [];
  const out = [];
  list.forEach((f, index) => {
    const c = f && byId[f.id];
    if (c && c.verdict === "missing") {
      dropped.push({ index, reason: "close-up: no " + f.kind + (f.hole ? " for hole " + f.hole : "") + " at the pin" + (c.seen ? " - " + c.seen : "") });
      return;
    }
    const copy = Object.assign({}, f);
    if (c) copy.seen = c.seen || copy.seen;
    if (c && c.verdict === "moved") {
      copy.points = [[c.point.x, c.point.y]];
      copy.moved = true;
    } else if (f && f.pin && f.kind === "fairway" && f.hole && Array.isArray(f.points) && f.points.length === 2) {
      const start = shift["tee:" + f.hole], end = shift["green:" + f.hole];
      if (start || end) {
        const p = f.points.map(pt => Array.isArray(pt) ? [num(pt[0]), num(pt[1])] : [num(pt.x), num(pt.y)]);
        if (start) p[0] = [p[0][0] + start.dx, p[0][1] + start.dy];
        if (end) p[1] = [p[1][0] + end.dx, p[1][1] + end.dy];
        copy.points = p;
        copy.moved = true;
      }
    }
    out.push(copy);
  });
  return { features: out, dropped, summary };
}
