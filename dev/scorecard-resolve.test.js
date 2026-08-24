/* The resolver: which page to read, and what to do with the answer.
 *
 * No network. Every dependency is injected, so this exercises the ordering, the
 * quality gate and the store payload against HTML shaped like the real pages
 * rather than against the real pages themselves.
 *
 * Run: node dev/scorecard-resolve.test.js */

const assert = require("assert");
const path = require("path");
const RESOLVE = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-scorecard-resolve.mjs");

const SOUTH_ROWS = [
  ["Handicap", 15, 1, 11, 7, 9, 3, 5, 17, 13, "", 4, 2, 12, 14, 16, 6, 8, 18, 10],
  ["Par", 5, 4, 4, 4, 3, 4, 5, 3, 4, 36, 4, 4, 3, 5, 4, 4, 4, 3, 5],
  ["Championship", 530, 444, 355, 484, 170, 381, 571, 156, 342, 3433, 433, 434, 226, 496, 317, 409, 340, 119, 571],
  ["Back Combo", 530, 444, 355, 484, 153, 367, 550, 156, 342, 3381, 421, 416, 226, 480, 317, 383, 335, 119, 557]
];

function scorecardHtml(rows) {
  const header = ["Hole", 1, 2, 3, 4, 5, 6, 7, 8, 9, "Out", 10, 11, 12, 13, 14, 15, 16, 17, 18];
  const tr = cells => "<tr>" + cells.map(c => "<td>" + c + "</td>").join("") + "</tr>";
  /* Real aggregator pages always name the club - the resolver now checks that the
     card is for the course it asked about, after a Brave search for "Te Arai Links"
     returned a cleanly-parsing scorecard for AYREN Links Golf Club. */
  return "<html><body><h1>Te Arai Links Golf Club - South Course Scorecard</h1><table>"
    + tr(header) + rows.map(tr).join("")
    + "</table><p>The 18 hole, par 72 golf course.</p></body></html>";
}

(async () => {
  const r = await import(RESOLVE);

  /* ---------- the key format that must not drift ---------------------- */
  assert.strictEqual(r.scorecardCourseKey("  Te Arai Links   Golf Club "), "te arai links golf club",
    "display name, lowercased, whitespace collapsed - NOT the dash slug other tables use");

  /* ---------- source classification ----------------------------------- */
  assert.strictEqual(r.classifySource("https://www.golfpass.com/travel-advisor/courses/43275-x/scorecard-and-layout").id, "golfpass");
  assert.strictEqual(r.classifySource("https://18birdies.com/golf-courses/club/abc/te-arai-links").id, "18birdies");
  assert.strictEqual(r.classifySource("https://tearai.com/golf/south-course/").id, "club-site");
  assert.strictEqual(r.classifySource("not a url").id, "club-site", "garbage does not throw");
  assert.strictEqual(r.classifySource("https://www.golfpass.com/x").unit, "yards", "GolfPass prints yards by default");

  /* ---------- aggregators are read before club sites ------------------ */
  const order = [];
  const result = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [
      { url: "https://tearai.com/golf/south-course/" },
      { url: "https://www.golfpass.com/travel-advisor/courses/43275-te-arai-links-golf-club-south-course/scorecard-and-layout" }
    ],
    fetchHtml: async url => { order.push(r.classifySource(url).id); return scorecardHtml(SOUTH_ROWS); }
  });
  assert.deepStrictEqual(order, ["golfpass", "club-site"],
    "GolfPass is read first even though search returned the club site first");
  assert.strictEqual(result.cards.length, 2, "both readable pages kept - a two-course site needs both cards");
  assert.strictEqual(result.cards[0].holes.length, 18);
  assert.strictEqual(result.cards[0].par, 72);

  /* ---------- a two-course site yields two cards ---------------------- */
  /* Brave returns the South and stops; the North has its own internal id (43601 vs
     43275) that no query rule derives. The South's own page links to it, and that
     link is the only route to the second card the loop matcher needs. */
  const GP = "https://www.golfpass.com/travel-advisor/courses/";
  const withSiblings = html => html.replace("</body>",
    '<a href="' + GP + '43601-te-arai-links-golf-club-north-course">North</a>'
    + '<a href="' + GP + '38461-tara-iti-golf-club">Tara Iti</a>'
    + '<a href="' + GP + '17220-omaha-beach-golf-club">Omaha Beach</a></body>');
  const visited = [];
  const twoCourse = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: GP + "43275-te-arai-links-golf-club-south-course" }],
    fetchHtml: async url => {
      visited.push(url);
      const which = /north/.test(url) ? "North" : "South";
      return withSiblings(scorecardHtml(SOUTH_ROWS).replace("South Course Scorecard", which + " Course Scorecard")
        .replace("<html>", '<html><head><meta property="og:title" content="Te Arai Links Golf Club - ' + which + ' Course"></head>'));
    }
  });
  assert.strictEqual(visited.length, 2, "the sibling was followed, and only the sibling");
  assert(visited[1].includes("43601"), "specifically the North Course");
  assert.strictEqual(twoCourse.cards.length, 2, "two courses, two cards");
  assert.deepStrictEqual(twoCourse.cards.map(c => c.name).sort(),
    ["Te Arai Links Golf Club - North Course", "Te Arai Links Golf Club - South Course"],
    "named from the page's own og:title, not the search result title");
  assert(!visited.some(url => /tara-iti|omaha/.test(url)),
    "neighbouring clubs in the same Nearby Courses block are not followed");

  /* ---------- names come from the page ------------------------------- */
  assert.strictEqual(
    r.courseNameFromHtml('<meta property="og:title" content="Te Arai Links Golf Club - South Course">'),
    "Te Arai Links Golf Club - South Course");
  assert.strictEqual(
    r.courseNameFromHtml("<h1>Te Arai Links Golf Club - South Course in Tomarata, Auckland | GolfPass</h1>"),
    "Te Arai Links Golf Club - South Course", "the location and site suffix are trimmed");

  /* ---------- a card for a DIFFERENT club is rejected ----------------- */
  assert.strictEqual(r.cardNameMatchesCourse("Te Arai Links Golf Club - North Course", "Te Ārai Links"), true,
    "macron in the query, none on the page - still the same club");
  assert.strictEqual(r.cardNameMatchesCourse("Ayren Links Golf Club - Detailed Scorecard", "Te Arai Links"), false,
    "the real false positive: a cleanly-parsing card for another club entirely");
  assert.strictEqual(r.cardNameMatchesCourse("Tara Iti Golf Club", "Te Arai Links"), false, "the neighbour is not the course");
  const wrongClub = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://course.bluegolf.com/x/ayrenlinksgc/detailedscorecard.htm" }],
    fetchHtml: async () => scorecardHtml(SOUTH_ROWS).replace("Te Arai Links Golf Club - South Course", "Ayren Links Golf Club")
  });
  assert.strictEqual(wrongClub.cards.length, 0, "a wrong-club card must never reach the pool the matcher chooses from");
  assert(String(wrongClub.attempts[0].rejected || "").startsWith("name-mismatch"), "and the job row must say why");

  /* ---------- the cache short-circuits everything ---------------------- */
  let fetched = false;
  const cached = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    readStore: async () => ({ holes: [{ hole: 1, par: 4 }] }),
    fetchHtml: async () => { fetched = true; return ""; }
  });
  assert.strictEqual(cached.fromCache, true);
  assert.strictEqual(fetched, false, "a cached card must not cost a fetch");

  /* ---------- quality: gaps are fine, missing par is not -------------- */
  const full = { holes: Array.from({ length: 18 }, (_, i) => ({ hole: i + 1, par: 4, distanceM: 300 })) };
  const gappy = { holes: Array.from({ length: 12 }, (_, i) => ({ hole: i + 1, par: 4, distanceM: null })) };
  const thin = { holes: Array.from({ length: 5 }, (_, i) => ({ hole: i + 1, par: 4 })) };
  assert.strictEqual(r.cardQuality(full).usable, true);
  assert.strictEqual(r.cardQuality(gappy).usable, true, "twelve pars with no distances still identifies a course");
  assert.strictEqual(r.cardQuality(thin).usable, false, "five holes is not a card");
  assert.strictEqual(r.cardQuality(thin).reason, "fewer-than-nine-pars");
  assert(r.cardQuality(full).score > r.cardQuality(gappy).score, "distances raise the score without gating it");

  /* ---------- a page with no card still yields the hole count --------- */
  const proseOnly = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => "<html><body><p>The 18 hole, par 72 golf course has been designed as a walking links.</p></body></html>"
  });
  assert.strictEqual(proseOnly.cards.length, 0, "no table, no card");
  assert.strictEqual(proseOnly.statedHoleCount, 18,
    "but the expectedHoles that three of the mapper's guards depend on is still recovered");

  /* ---------- store payload ------------------------------------------- */
  const card = result.cards[0];
  const payload = r.toStorePayload(card, "Te Arai Links");
  assert.strictEqual(payload.holes.length, 18);
  assert.strictEqual(payload.holes[0].hole, 1);
  assert.strictEqual(payload.holes[0].par, 5);
  assert.strictEqual(payload.holes[0].index, 15, "stroke index carried through");
  assert.strictEqual(payload.courseKey, "te arai links");
  assert.strictEqual(
    r.toStorePayload({ holes: [{ hole: 1, par: 4 }, { hole: 3, par: 4 }] }, "x"), null,
    "a card with gaps is usable in memory but must not be shared as a complete one"
  );

  /* ---------- failures are reported, not swallowed -------------------- */
  const dead = await r.resolveScorecard({ courseName: "Nowhere GC" }, {
    search: async () => [{ url: "https://example.com/a" }],
    fetchHtml: async () => { throw new Error("HTTP 404"); }
  });
  assert.strictEqual(dead.cards.length, 0);
  assert.strictEqual(dead.reason, "no-readable-card");
  assert.strictEqual(dead.attempts[0].ok, false);
  assert(dead.attempts[0].reason.includes("404"), "the job row can say why, not just that it failed");

  console.log("scorecard resolve tests passed");
})().catch(error => { console.error(error); process.exit(1); });
