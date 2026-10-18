/* AI scan of a satellite picture: what we ask, what shape the answer must take, and how the
 * answer is read. Pure - no network, no SDK - so the prompt and the parser are testable and
 * the endpoint that calls the model stays thin.
 *
 * The prompt has two halves. The SCAFFOLD is fixed and mechanical: what the picture is, its
 * size and scale, the coordinate grid, what Studio drew on it (known greens, recorded shapes,
 * pins) and where, the course map, the scorecard, and the exact shape the answer must come
 * back in. The TASK is the operator's words - what to look for and how - and is the part
 * edited in Studio (Mapping Overlay > AI help), stored per task in ai_scan_prompts
 * (functions/course-map-ai-prompts.mjs) and falling back to the defaults here.
 *
 * Each task also says how it answers:
 *   pins     - one point for a green, tee or bunker (its centre), two for a fairway (start,
 *              end). Saved as overlay pins, which the operator shapes afterwards with the
 *              wands - the AI does the finding, the native tools do the drawing.
 *   outlines - polygons, as the first scans worked: a traced, completed or refitted shape.
 * A shape that replaces a recorded one names it by its label on the picture (S1.., P1..) and
 * is saved under that shape's id, kind and hole number. Pins never replace anything.
 *
 * The scorecard goes in as context for FINDING things - "there are 18 holes, four of them
 * par 3s" tells a model how many corridors to look for - never as a numbering key: the
 * native resolver numbers from the card once the shapes exist. Two exceptions, both pin
 * tasks: find-greens lets the model follow the routing from a pin the operator has already
 * numbered, because that is what a numbered sample is for; and pin-from-map (needsCourseMap)
 * is the task whose whole point is the club's course map - it reads the routing off image 2,
 * matches it to the ground with the scorecard's pars and lengths, and numbers every pin. The
 * scaffold says so for that task, and the background half refuses to run it without a map. */

import { OVERLAY_PIN_POINTS } from "./gd-map-overlay-core.mjs";

export const AI_SCAN_MAX_FEATURES = 100;
export const AI_SCAN_MAX_POINTS = 24;
export const AI_SCAN_PROMPT_MAX = 8000;
export const AI_SCAN_OUTPUTS = ["pins", "outlines"];

/* The answer, as a JSON schema for structured output. Pixels as [x, y] integer pairs in the
   image the model was shown; kind limited to what the overlay stores. `hole` is optional and
   the prompt says when (if ever) to give it. `confidence` is the model's own, kept on the
   feature for the operator to read, never used to filter here.

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
          kind: { type: "string", enum: ["fairway", "green", "tee", "bunker"] },
          points: {
            type: "array",
            items: { type: "array", items: { type: "integer" } }
          },
          hole: { type: "integer" },
          replaces: { type: "string" },
          seen: { type: "string" },
          confidence: { type: "number" }
        }
      }
    },
    notes: { type: "string" }
  }
};

/* What a green, fairway and tee look like from above, said once: the pin task and the
   outline tasks both look for the same things. */
const GREEN_LOOKS = "a small, smooth, very evenly mown area, usually lighter or finer in texture than the fairway, roughly round or kidney-shaped, 20-40 m across, often with bunkers cut into its edge and a mown fringe around it";
const FAIRWAY_LOOKS = "a mown corridor 25-50 m wide that leads to a green";
const TEE_LOOKS = "small flat mown pads, rectangular or oval, 8-20 m long, often two to four in a line, at the far end of the fairway from its green";

const TRACE_STEPS = [
  "1. GREENS. Find every putting green by appearance alone: " + GREEN_LOOKS + ". Return a \"green\" only when you can see one. Never place a green because the routing suggests one should be there - if a hole seems to need a green you cannot see, leave it out and say so in notes.",
  "2. FAIRWAYS. Find every mown corridor 25-50 m wide that leads to a green (one you found, or a confirmed one). Return a \"fairway\" polygon from the landing area to the approach, stopping short of the green - do not include the green or the tee in it.",
  "3. TEES. At the far end of each fairway from its green, look for the tee boxes: small flat mown pads, rectangular or oval, 8-20 m long, often two to four in a line. Return a \"tee\" polygon around the group where you can see them.",
  "4. CHECK. If you have more greens or fairways than the course has holes, or two shapes claim the same ground, use the course map (if given) and the scorecard to decide which to drop. Return nothing for bunkers, water, practice greens, driving ranges, or ground you cannot see clearly."
];

/* What "fits" means, said once for the two tasks that adjust shapes. */
const FIT_RULES = "A good fit follows the edge you can see: a green's outline runs along the change from the smooth putting surface to the coarser fringe; a fairway's along the change from mown fairway to longer rough, stopping short of the green; a tee's around the flat mown pad(s); a bunker's around the sand.";

/* The tasks, in the order Studio lists them. `output` says how the task answers, `when`
   is the one-line hint under its name, `defaultPrompt` the words used until an operator
   saves their own. `newShapes: false` means the parser drops anything that does not replace
   a recorded shape - the refit task corrects, it never adds. */
export const AI_SCAN_TASKS = [
  {
    id: "find-greens",
    label: "Find greens, tees and fairways",
    output: "pins",
    when: "Pins only: the AI finds them, you shape them with the wands. Works on an empty view; works better with a green and a tee already pinned as samples, and best when a sample carries its hole number.",
    defaultPrompt:
      "Find every putting green, every tee and every fairway you can see in image 1 and mark each one with a pin: a green or a tee is ONE point at its centre; a fairway is TWO points, where the mown corridor starts (the end nearest the tee) and where it ends (the end nearest the green). Pins only, no outlines - the operator shapes them afterwards.\n\n" +
      "Work from what you can SEE, in this order. Greens first, by appearance alone: " + GREEN_LOOKS + ". Then the fairways: each is " + FAIRWAY_LOOKS + ". Then the tees: " + TEE_LOOKS + " - one tee pin per hole, on the main group. Never place a green because the routing suggests one should be there; if you cannot see it, leave it out and say so in notes.\n\n" +
      "Anything already pinned or drawn on the picture is a sample. It shows you exactly what a green, a tee or a fairway looks like in this imagery, so match that appearance when you look for the rest, and do not return the samples again. A sample that carries a hole number tells you where that hole is, and the next hole's tee is usually near its green: use it to work out the routing, and give a hole number to the pins you are confident about from it. Leave \"hole\" out when you are not sure - a wrong number costs more than none.\n\n" +
      "Pin everything in view, including holes cut off at the edge. Use the scorecard to check your count: 18 holes means up to 18 greens and 18 tee groups and about 14 fairways, since par 3s have none. Skip practice greens, the driving range and anything you cannot see clearly, and say what you left out in notes."
  },
  {
    id: "pin-from-map",
    label: "Pin holes from the course map",
    output: "pins",
    needsCourseMap: true,
    verify: true,
    when: "Needs a course map saved on this course. The AI reads the routing off the club's map to know where to look, finds each hole's actual green and tee in the picture, and pins green, tee and fairway WITH the hole number. Every green and tee pin is then checked in close-up before it is kept. Pins only: you shape them with the wands.",
    defaultPrompt:
      "Image 2 is the club's course map and the scorecard lists every hole. The map tells you WHERE TO LOOK in image 1 for each hole, never where to put a pin: a pin goes on a green, tee or fairway you can actually see. Mark every one you find with a pin that carries its hole number. A green or a tee is ONE point at its centre; a fairway is TWO points, where the mown corridor starts (nearest the tee) and where it ends (nearest the green). Pins only, no outlines - the operator shapes them afterwards.\n\n" +
      "Work in this order. 1. ORIENT. Match image 2 to image 1 by the things both show: the boundary of the property, the clubhouse and car park, roads, water, tree lines, and the direction each hole runs. Image 2 is a drawing, not to scale and not north-up, so match shapes and neighbours, never distances. Say in notes how you lined them up. 2. SWEEP, hole by hole. For each hole on the map, work out roughly where it sits in image 1 and which way it runs, then look at that part of image 1 for the real thing: the green is " + GREEN_LOOKS + "; the tee is " + TEE_LOOKS + "; the fairway is " + FAIRWAY_LOOKS + ". The tee and green you pin must sit at the two ends of a mown strip running the way the map draws the hole - if the tee-to-green direction you have disagrees with the map by more than about 30 degrees, you have the wrong shapes. 3. GROUND CHECK every pin before you return it: look at the pixels under it. Mown turf, good. Water, a roof, a road, a car park, bare earth, tree canopy or scrub - wrong, so move along the hole until you find the real shape, or leave that pin out. Write what you see under each pin in \"seen\" in a few words. 4. SCORECARD. A par 3 is a short hole with no fairway, a par 5 a long one; the lengths tell you which of two neighbouring corridors is which. Two pins of the same kind must never share a hole number.\n\n" +
      "Never place a green, tee or fairway because the map says one should be there - if the map shows a hole you cannot find in the picture, leave it out and name it in notes. Anything already pinned or drawn on the picture is a sample: match its appearance, take its hole number as settled, and do not return it again. Holes cut off at the edge of image 1 still get their pins. If you cannot tell which hole a feature belongs to, pin it without a number rather than guess. Skip practice greens, the driving range and anything you cannot see clearly."
  },
  {
    id: "trace",
    label: "Trace outlines",
    output: "outlines",
    when: "Nothing recorded in view: trace the greens, fairways and tees from scratch as polygons.",
    defaultPrompt: ["Work in this order, and return only what the image shows:"].concat(TRACE_STEPS).join("\n")
  },
  {
    id: "shape-pins",
    label: "Shape my pins",
    output: "outlines",
    when: "Pins in view: turn every pin into its full outline, refit any recorded shape that is off, then trace what is still missing.",
    defaultPrompt: [
      "This is a COMPLETE pass. The pins are the human part: they say WHAT is there and roughly WHERE. Your part is the full shape. Work in this order:",
      "1. PINS. For every pin, return the full outline of that feature, of the pin's kind, with \"replaces\" set to its label: the green's edge around its dot, the tee pad(s) around its dot, the bunker's sand around its dot, the fairway corridor along its line from start to end. " + FIT_RULES + " Trust the pins over your own reading of the routing: never drop a pin or move it to other ground. If you cannot see an edge clearly, return your best outline around the pin anyway and say so in notes.",
      "2. RECORDED SHAPES. Where a recorded outline does not fit the ground, return a corrected outline of the same kind with \"replaces\" set to its label; leave out the ones that fit.",
      "3. ANYTHING STILL MISSING. Then trace the greens, fairways and tees nobody has pinned or recorded, by the steps below, without \"replaces\". Never return a new bunker - bunkers only ever come from a pin."
    ].concat(TRACE_STEPS).join("\n")
  },
  {
    id: "refit",
    label: "Refit recorded shapes",
    output: "outlines",
    newShapes: false,
    when: "Shapes in view: correct only the outlines that do not follow the ground. Nothing new is added.",
    defaultPrompt: [
      "This is a REFIT pass. Do not map the course again.",
      "For each recorded shape, compare its outline with what image 1 shows. " + FIT_RULES + " Where a shape is off - an edge cutting into the rough, part of the green left out, a fairway running onto the green or stopping well short of it, a bunker that misses the sand - return a corrected outline of the same kind with \"replaces\" set to its label. A correction stays on the same feature: never move a shape onto different ground.",
      "Leave out every shape that already fits well. Return no new shapes - only corrections, each with \"replaces\"."
    ].join("\n")
  },
  {
    id: "custom",
    label: "Custom",
    output: "outlines",
    when: "Your own words. Pick pins or outlines for the answer.",
    defaultPrompt: ""
  }
];

/* A blank prompt still has to ask for something. */
const BLANK_PROMPT = "Map the golf features you can see in image 1 - greens, fairways and tees - and answer in the shape the output rules below describe.";

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

export function scanTask(id) {
  return AI_SCAN_TASKS.find(task => task.id === String(id || "")) || null;
}

/* Which job a scan is, from the recorded shapes Studio drew onto the picture. Kept for the
   outcome row and for choosing a task when the request names none. */
export function scanJob(shapes) {
  const list = Array.isArray(shapes) ? shapes : [];
  if (list.some(s => s && s.pin)) return "complete";
  return list.length ? "refine" : "trace";
}

/* The task a scan runs when its request did not say: the outline tasks the first scans
   chose by what was in view. */
export function defaultTaskId(shapes) {
  const job = scanJob(shapes);
  return job === "complete" ? "shape-pins" : job === "refine" ? "refit" : "trace";
}

/* The task a request carries, cleaned: a known id (else the default for what is in view),
   an output the parser knows, and the operator's prompt capped. `stored` is the saved
   override for that task, if any, used when the request carries no prompt of its own. */
export function resolveTask(raw, shapes, stored) {
  const base = scanTask(raw && raw.id) || scanTask(defaultTaskId(shapes));
  const saved = stored && typeof stored === "object" ? stored : null;
  const output = AI_SCAN_OUTPUTS.includes(raw && raw.output) ? raw.output
    : AI_SCAN_OUTPUTS.includes(saved && saved.output) ? saved.output : base.output;
  const words = raw && typeof raw.prompt === "string" ? raw.prompt : saved && typeof saved.prompt === "string" ? saved.prompt : base.defaultPrompt;
  return {
    id: base.id,
    label: base.label,
    output,
    newShapes: base.newShapes !== false,
    needsCourseMap: base.needsCourseMap === true,
    verify: base.verify === true,
    prompt: String(words || "").trim().slice(0, AI_SCAN_PROMPT_MAX)
  };
}

function pixelList(pixels) {
  return "[" + (pixels || []).map(p => "[" + Math.round(p.x) + ", " + Math.round(p.y) + "]").join(", ") + "]";
}

/* One line per recorded shape in view, for the prompt: its label, what it is, and where its
   corners (or a pin's points) are in this picture. */
function shapeLine(shape) {
  const what = shape.pin
    ? (shape.kind === "fairway" ? "fairway pin, start and end " : shape.kind + " pin, centre ")
    : shape.kind + " outline ";
  return shape.label + ": " + what + pixelList(shape.pixels) + (shape.hole ? " (hole " + shape.hole + ")" : "");
}

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

/* The fixed tail: exactly how the answer is written, for each output. */
function outputRules(task) {
  const common = " Set \"confidence\" between 0 and 1 for each feature: how sure you are that it IS what you say, judged from the picture. Put anything the operator should know in \"notes\" - holes cut off at the edge, things you expected but could not see, ground you were unsure about.";
  if (task.output === "pins") {
    return "OUTPUT RULES. Answer with pins, not outlines. Each feature's \"points\" is ONE [x, y] integer pixel in image 1 for a green, tee or bunker (its centre), or TWO for a fairway (where it starts, nearest the tee, then where it ends, nearest the green). Read every coordinate off the grid. Never set \"replaces\": a pin never replaces anything. " + (task.needsCourseMap ? "Give \"hole\" to every pin whose hole you can read off the course map with confidence; leave it out rather than guess. " : "Give \"hole\" only when the task above says you may and you are confident of it. ") + "Put what the ground under each pin looks like in \"seen\", a few words." + common;
  }
  return "OUTPUT RULES. Polygons are lists of [x, y] integer pixel corners in image 1, 4 to " + AI_SCAN_MAX_POINTS + " points, in order around the shape, entirely inside the image. A shape that corrects or completes a recorded one sets \"replaces\" to that shape's label. Omit \"hole\" unless a number is painted on the ground." + common;
}

/* shapes - the recorded shapes in view, as Studio labelled them on the picture:
   {label, id, kind, hole, pin, pixels:[{x, y}]}. task - from resolveTask; when missing the
   default task for what is in view is used, with its default words. */
export function buildScanPrompt({ course, scorecard, georef, notes, anchors, grid, courseMap, shapes, task }) {
  const name = String(course && course.name || "the course");
  const lines = scorecardLines(scorecard);
  const holeCount = lines.length || null;
  const recorded = (Array.isArray(shapes) ? shapes : []).filter(s => s && s.label && Array.isArray(s.pixels) && s.pixels.length);
  const pins = recorded.filter(s => s.pin);
  const outlines = recorded.filter(s => !s.pin);
  const chosen = task && task.id ? task : resolveTask(null, recorded);
  const parts = [];
  parts.push("Image 1 is a satellite image of " + name + ", a golf course. Your task is set out below, after a description of what you are looking at.");
  parts.push("Image 1: " + georef.width + " x " + georef.height + " pixels, about " + georef.metresPerPixel.toFixed(2) +
    " metres per pixel, north up. Pixel (0,0) is the top-left corner; x runs right, y runs down. " +
    "For scale: a green is typically 20-40 m across (" + Math.round(20 / georef.metresPerPixel) + "-" + Math.round(40 / georef.metresPerPixel) +
    " px), a fairway 25-50 m wide, a tee box 8-20 m long, a bunker 5-30 m across.");
  if (grid > 0) {
    parts.push("A coordinate grid is drawn over image 1: thin white lines every " + grid + " pixels, with the x value of each vertical line printed in yellow along the top edge and the y value of each horizontal line along the left edge. " +
      "Read every coordinate you return off this grid - it is authoritative. A point midway between the lines labelled 256 and 384 is at 320.");
  }
  const known = (anchors || []).filter(a => a && !a.saved && a.kind === "green");
  if (known.length) {
    parts.push("Greens confirmed by map data are outlined in bright green on image 1 and labelled " + known[0].label + " to " + known[known.length - 1].label +
      ", pixel centres " + known.map(a => a.label + " (" + a.x + ", " + a.y + ")").join(", ") + ". " +
      "They show you what a green looks like in this image. Do not return them" + (chosen.newShapes ? "; find every other green by the same appearance." : "."));
  }
  if (outlines.length) {
    parts.push("Shapes already recorded are drawn on image 1 as thin white outlines labelled " + outlines.map(s => s.label).join(", ") + ". Their exact corners:\n" + outlines.map(shapeLine).join("\n"));
  }
  if (pins.length) {
    parts.push("Pins placed by hand are drawn on image 1 as white-ringed dots (a green, tee or bunker's centre) or a dashed white line (a fairway's start and end), labelled " + pins.map(s => s.label).join(", ") + ". Their exact points:\n" + pins.map(shapeLine).join("\n"));
  }
  if (recorded.length === 0 && !known.length) {
    parts.push("Nothing has been recorded in this view yet.");
  }
  /* For most tasks the map and the card are context for finding things and the numbering is
     the native resolver's job. For a task that needs the course map, they are the key: the
     map says which hole is which, the card says what each hole should look like. */
  const keyed = chosen.needsCourseMap === true;
  if (courseMap && keyed) {
    parts.push("Image 2 is the club's own course map, a schematic drawing of the routing: where every hole starts, runs and ends, with its number. It is NOT to scale and NOT aligned with image 1 - never take a coordinate from it, and expect it to be rotated. It IS the key to hole numbers for this task: line it up with image 1 by the features both show, then read each hole's number off it.");
  } else if (courseMap) {
    parts.push("Image 2 is the club's own course map, a schematic drawing. It is NOT to scale and NOT aligned with image 1: never take a coordinate from it. Use it only to settle doubts - which of two corridors is the fairway, whether a mown patch is a green or a practice area, whether you have found too many or too few holes.");
  } else if (keyed) {
    parts.push("No course map is available for this course, so there is no routing to read hole numbers from: pin what you can see and leave \"hole\" out unless a sample in view settles it.");
  }
  if (lines.length && keyed) {
    parts.push("The scorecard, one line per hole (" + holeCount + " holes). With the course map it tells you what each hole should look like on the ground - a par 3 is short with no fairway, a par 5 is long - so use it to check which hole each green and corridor belongs to:\n" + lines.join("\n"));
  } else if (lines.length) {
    parts.push("The scorecard, for the same purpose - how many holes there are (" + holeCount + ") and how long they are - never for numbering:\n" + lines.join("\n"));
  } else {
    parts.push("No scorecard is available; use what you can see.");
  }
  parts.push("YOUR TASK (" + chosen.label + "):\n" + (chosen.prompt || BLANK_PROMPT));
  parts.push(outputRules(chosen));
  if (notes) parts.push("From the operator, for this scan: " + String(notes).slice(0, 600));
  return parts.join("\n\n");
}

/* What the prompt looks like around an operator's words, for Studio to show next to the
   editor: a sample picture, one recorded shape and one pin, the card. */
export function scanPromptOutline(task) {
  const georef = { width: 1568, height: 1045, metresPerPixel: 0.6 };
  const shapes = [
    { label: "S1", id: "f-3", kind: "green", hole: 7, pixels: [{ x: 290, y: 390 }, { x: 310, y: 390 }, { x: 310, y: 410 }, { x: 290, y: 410 }] },
    { label: "P1", id: "f-9", kind: "tee", hole: 1, pin: true, pixels: [{ x: 500, y: 200 }] }
  ];
  const chosen = Object.assign({}, resolveTask(task, shapes), { prompt: "«your words»" });
  return buildScanPrompt({
    course: { name: "«course name»" },
    scorecard: { holes: [{ holeNumber: 1, par: 4, distanceM: 366 }, { holeNumber: 2, par: 3, distanceM: 150 }] },
    georef, grid: 128, courseMap: true, shapes, task: chosen,
    anchors: [{ kind: "green", label: "G1", x: 900, y: 600 }]
  }).replace("hole 2 par 3 150m", "hole 2 par 3 150m\n…");
}

/* The model's answer as the feature list aiShapesToOverlay reads. Structured output means
   the shape is normally exact, but the parser stays tolerant - a text block holding JSON, a
   fenced block, an answer wrapped in {features} or a bare array - because the cost of being
   strict here is a whole scan thrown away over a formatting slip. */
export function parseScanAnswer(answer, shapes, task) {
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
     shapes, at most AI_SCAN_MAX_POINTS corners each (a pin's count for pins), confidence
     clamped to 0..1, a hole number only when it is one.

     A shape that replaces a recorded one takes that shape's id, kind and hole number, so it is
     saved over it. Anything the task did not ask for is dropped with its reason: a new shape
     on a refit pass, a bunker outline that replaces nothing, a pin that claims to replace, a
     second answer for the same label. */
  const recorded = {};
  (Array.isArray(shapes) ? shapes : []).forEach(s => { if (s && s.label && s.id) recorded[String(s.label).toUpperCase()] = s; });
  const list = Object.values(recorded);
  const job = scanJob(list);
  const chosen = task && task.id ? task : resolveTask(null, list);
  const pins = chosen.output === "pins";
  const used = new Set();
  const dropped = [];
  const features = [];
  (Array.isArray(value.features) ? value.features : []).slice(0, AI_SCAN_MAX_FEATURES).forEach((f, i) => {
    const hole = num(f && f.hole);
    const confidence = num(f && f.confidence);
    const label = String(f && f.replaces || "").trim().toUpperCase();
    const target = label ? recorded[label] : null;
    if (pins && label) { dropped.push({ index: i, reason: "a pin that replaces " + label + " - pins never replace a recorded shape" }); return; }
    if (label && !target) { dropped.push({ index: i, reason: "replaces " + label + ", which is not a recorded shape" }); return; }
    if (target && used.has(target.id)) { dropped.push({ index: i, reason: "a second answer for " + label }); return; }
    if (!target && !chosen.newShapes) { dropped.push({ index: i, reason: "a new shape on a refit pass" }); return; }
    if (!target && !pins && f && f.kind === "bunker") { dropped.push({ index: i, reason: "a bunker that replaces no pin or outline" }); return; }
    if (target) used.add(target.id);
    const kind = target ? target.kind : f && (f.kind === "green" || f.kind === "tee" || f.kind === "bunker") ? f.kind : "fairway";
    const maxPoints = pins ? (OVERLAY_PIN_POINTS[kind] || 1) : AI_SCAN_MAX_POINTS;
    const feature = {
      id: target ? target.id : kind + "-ai-" + (i + 1),
      kind,
      seen: String(f && f.seen || "").slice(0, 160),
      points: (f && Array.isArray(f.points) ? f.points : []).slice(0, maxPoints),
      hole: target ? (target.hole || null) : hole != null && Number.isInteger(hole) && hole >= 1 && hole <= 36 ? hole : null,
      confidence: confidence == null ? null : Math.max(0, Math.min(1, confidence))
    };
    if (pins) feature.pin = true;
    if (target) feature.replaces = target.label;
    features.push(feature);
  });
  return { features, dropped, job, task: { id: chosen.id, label: chosen.label, output: chosen.output }, notes: String(value.notes || "").slice(0, 2000) };
}
