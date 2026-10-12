/* A stored scorecard as the editor shows it, and the editor's answer back as a stored card. — pure.
 *
 * A course_scorecards row keeps its holes as [{hole, par, index, metres, tees: {name: {metres}}}]:
 * par always, the stroke index when the card had one, a distance (metres) for the card's main
 * tee, and every tee's distance by name when the card printed several. The editor works in
 * rows like the printed card - Par, SI, one row a tee - so a card is turned into tee names and
 * per-hole columns here, and back again on save, and nothing else needs to know either shape.
 *
 * A card with distances but no tee names (a pasted "Hole / Par / Metres" table) has one
 * unnamed tee row, "". It saves back as plain metres, as it came. */

export const MAX_HOLES = 36;
export const MAX_TEES = 8;
const TEE_NAME_MAX = 40;
const MAX_DISTANCE_M = 800;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function teesOf(hole) {
  return hole && hole.tees && typeof hole.tees === "object" && !Array.isArray(hole.tees) ? hole.tees : {};
}

/* holes_json -> { tees: [name], holes: [{hole, par, index, distances: [metres|null, one per tee]}] } */
export function editorCard(holesJson) {
  const holes = (Array.isArray(holesJson) ? holesJson : [])
    .filter(hole => hole && Number(hole.hole) > 0)
    .sort((a, b) => Number(a.hole) - Number(b.hole));
  const tees = [];
  holes.forEach(hole => Object.keys(teesOf(hole)).forEach(name => { if (!tees.includes(name)) tees.push(name); }));
  if (!tees.length && holes.some(hole => num(hole.metres) != null)) tees.push("");
  return {
    tees,
    holes: holes.map(hole => ({
      hole: Number(hole.hole),
      par: num(hole.par),
      index: num(hole.index),
      distances: tees.map(name => name === "" ? num(hole.metres) : num(teesOf(hole)[name] && teesOf(hole)[name].metres))
    }))
  };
}

/* The editor's card -> { holes } in the stored shape, or { error } saying what is wrong.
   Holes must run 1..n with a par of 3 to 6 on each; a stroke index, when given, is 1..n and
   used once; a distance is a whole number of metres or blank. The main distance (metres) is
   the first tee that has one - the tee the card leads with. */
export function storedHoles(card) {
  const c = card && typeof card === "object" ? card : {};
  const rawTees = Array.isArray(c.tees) ? c.tees.slice(0, MAX_TEES + 1) : [];
  if (rawTees.length > MAX_TEES) return { error: "At most " + MAX_TEES + " tees." };
  const tees = rawTees.map(name => String(name == null ? "" : name).replace(/\s+/g, " ").trim().slice(0, TEE_NAME_MAX));
  if (tees.length > 1 && tees.includes("")) return { error: "Give every tee a name when the card has more than one." };
  const seen = new Set();
  for (const name of tees) {
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: "Two tees are both called \"" + name + "\"." };
    seen.add(key);
  }
  const rawHoles = Array.isArray(c.holes) ? c.holes : [];
  if (!rawHoles.length) return { error: "The card has no holes." };
  if (rawHoles.length > MAX_HOLES) return { error: "At most " + MAX_HOLES + " holes." };
  const n = rawHoles.length;
  const indexes = new Set();
  const holes = [];
  for (let i = 0; i < n; i++) {
    const raw = rawHoles[i] || {};
    const hole = i + 1;
    if (num(raw.hole) !== hole) return { error: "Holes must run 1 to " + n + " in order." };
    const par = num(raw.par);
    if (par == null || !Number.isInteger(par) || par < 3 || par > 6) return { error: "Hole " + hole + " needs a par of 3 to 6." };
    const index = num(raw.index);
    if (index != null) {
      if (!Number.isInteger(index) || index < 1 || index > n) return { error: "Hole " + hole + "'s stroke index must be 1 to " + n + "." };
      if (indexes.has(index)) return { error: "Stroke index " + index + " is used twice." };
      indexes.add(index);
    }
    const distances = Array.isArray(raw.distances) ? raw.distances : [];
    const out = { hole, par, index };
    const named = {};
    let main = null;
    for (let t = 0; t < tees.length; t++) {
      const d = num(distances[t]);
      if (d == null) continue;
      if (d <= 0 || d > MAX_DISTANCE_M) return { error: "Hole " + hole + (tees[t] ? " from " + tees[t] : "") + ": " + d + "m is not a hole length." };
      const metres = Math.round(d);
      if (main == null) main = metres;
      if (tees[t]) named[tees[t]] = { metres };
    }
    out.metres = main;
    if (Object.keys(named).length) out.tees = named;
    holes.push(out);
  }
  return { holes };
}
