/* The picture fallback: scorecards that only exist as images.
 *
 * No network and no model. The vision reader is faked with transcriptions shaped
 * like the model's structured output, so this exercises which images are picked,
 * the golf checks a read is held to, and how the resolver reports each outcome.
 *
 * Run: node dev/scorecard-visual-fallback.test.js */

const assert = require("assert");
const path = require("path");
const lib = name => "file://" + path.join(__dirname, "..", "functions", "lib", name);

/* Te Arai South, as printed. */
const PAR = [5, 4, 4, 4, 3, 4, 5, 3, 4, 4, 4, 3, 5, 4, 4, 4, 3, 5];
const SI = [15, 1, 11, 7, 9, 3, 5, 17, 13, 4, 2, 12, 14, 16, 6, 8, 18, 10];
const CHAMP = [530, 444, 355, 484, 170, 381, 571, 156, 342, 433, 434, 226, 496, 317, 409, 340, 119, 571];
const COMBO = [530, 444, 355, 484, 153, 367, 550, 156, 342, 421, 416, 226, 480, 317, 383, 335, 119, 557];
const sum = (list, from, to) => list.slice(from, to).reduce((s, v) => s + v, 0);

function read(holes, extra = {}) {
  const pick = list => holes.map(h => list[h - 1]);
  const tee = (name, list) => ({
    name,
    distances: holes.map(h => ({ hole: h, value: list[h - 1] })),
    printedOut: holes.includes(1) && holes.includes(9) ? sum(list, 0, 9) : null,
    printedIn: holes.includes(10) && holes.includes(18) ? sum(list, 9, 18) : null,
    printedTotal: holes.length === 18 ? sum(list, 0, 18) : null
  });
  return Object.assign({
    imageIndex: 1, isScorecard: true, kind: holes.length === 18 ? "full-card" : holes[0] === 1 ? "front-nine" : "back-nine",
    legibility: "clear", courseName: "Te Arai Links South", unit: "yards",
    holes: holes.map((h, i) => ({ hole: h, par: pick(PAR)[i], strokeIndex: pick(SI)[i] })),
    tees: [tee("Championship", CHAMP), tee("Back Combo", COMBO)],
    printedParOut: holes.includes(1) && holes.includes(9) ? sum(PAR, 0, 9) : null,
    printedParIn: holes.includes(10) && holes.includes(18) ? sum(PAR, 9, 18) : null,
    printedParTotal: holes.length === 18 ? sum(PAR, 0, 18) : null
  }, extra);
}
const ALL = Array.from({ length: 18 }, (_, i) => i + 1);
const FRONT = ALL.slice(0, 9), BACK = ALL.slice(9);

function holeGraphic(h, extra = {}) {
  return Object.assign({
    imageIndex: 1, isScorecard: true, kind: "single-hole", legibility: "clear", courseName: "", unit: "yards",
    holes: [{ hole: h, par: PAR[h - 1], strokeIndex: SI[h - 1] }],
    tees: [{ name: "Championship", distances: [{ hole: h, value: CHAMP[h - 1] }], printedOut: null, printedIn: null, printedTotal: null }],
    printedParOut: null, printedParIn: null, printedParTotal: null
  }, extra);
}

(async () => {
  const v = await import(lib("gd-scorecard-visual-core.mjs"));
  const r = await import(lib("gd-scorecard-resolve.mjs"));

  /* ---------- finding images ------------------------------------------ */
  const page = `<html><body>
    <img src="/wp-content/uploads/logo.png" alt="Te Arai logo">
    <img src="/img/hero.jpg" alt="Sunset over the dunes" width="1600">
    <img src="/img/south-small.jpg" srcset="/img/south-600.jpg 600w, /img/south-1800.jpg 1800w" alt="South Course scorecard">
    <a href="/files/front-nine-card.png">Front nine yardages</a>
    <img data-src="/img/back-9.webp" alt="Back 9" class="lazy">
    <img src="/icons/facebook.png" alt="Scorecard on Facebook">
    <a href="/golf/south/hole-1">Hole 1</a><a href="/golf/south/hole-2/">Hole 2</a>
    <a href="https://other.example/hole-3">Hole 3</a><a href="/golf/south/holes/4">Hole 4</a>
  </body></html>`;
  const images = v.scorecardImageCandidates(page, "https://tearai.com/golf/south/");
  const urls = images.map(i => i.url);
  assert.strictEqual(urls[0], "https://tearai.com/img/south-1800.jpg", "the scorecard leads, at its largest srcset width");
  assert.ok(urls.includes("https://tearai.com/files/front-nine-card.png"), "a link straight to a card image counts");
  assert.strictEqual(images.find(i => /front-nine/.test(i.url)).kind, "front-nine");
  assert.strictEqual(images.find(i => /back-9/.test(i.url)).kind, "back-nine", "lazy-loaded data-src is read");
  assert.ok(!urls.some(u => /logo|facebook/.test(u)), "logos and social icons are never candidates");
  assert.ok(!urls.some(u => /hero/.test(u)), "an unlabelled photo is not a candidate on a normal page");
  const onHolePage = v.scorecardImageCandidates('<img src="/img/hero.jpg" width="1600">', "https://tearai.com/golf/south/hole-7", { holeNumber: 7 });
  assert.deepStrictEqual([onHolePage[0].kind, onHolePage[0].hole], ["single-hole", 7], "a hole page's main picture is that hole's graphic");

  const holes = v.holePageLinks(page, "https://tearai.com/golf/south/");
  assert.deepStrictEqual(holes.map(h => h.hole), [1, 2, 4], "same host only, one link per hole");

  /* ---------- a single read, checked on its own ----------------------- */
  const good = v.validateVisualRead(read(ALL));
  assert.ok(good.ok, "a clean full card validates: " + good.reason);
  assert.strictEqual(good.read.checks.parTotals, 3, "OUT, IN and TOTAL all matched");
  assert.strictEqual(good.read.checks.teeTotals, 2);

  const badTotal = read(ALL, { printedParOut: 35 });
  assert.strictEqual(v.validateVisualRead(badTotal).ok, false, "a printed par total that disagrees sinks the read");
  assert.match(v.validateVisualRead(badTotal).reason, /par-out-total-mismatch/);

  const misreadPar = read(ALL);
  misreadPar.holes[3].par = 1;
  assert.match(v.validateVisualRead(misreadPar).reason, /impossible-par-1/);

  const dupHoles = read(ALL);
  dupHoles.holes[4].hole = 4;
  assert.strictEqual(v.validateVisualRead(dupHoles).reason, "duplicate-hole-numbers");

  const misreadTee = read(ALL);
  misreadTee.tees[0].distances[2].value = 855; /* 355 read as 855: impossible for a par 4 */
  const dropped = v.validateVisualRead(misreadTee);
  assert.ok(dropped.ok && !("3" in dropped.read.tees[0].distances), "an implausible length is dropped, not believed");

  const teeTotalOff = read(ALL);
  teeTotalOff.tees[1].distances[0].value = 503; /* plausible, but OUT no longer adds up */
  const teeChecked = v.validateVisualRead(teeTotalOff);
  assert.ok(teeChecked.ok, "the read survives a bad tee row");
  assert.deepStrictEqual(teeChecked.read.tees.map(t => t.name), ["Championship"], "the tee row whose total disagrees is dropped");

  const dupSi = read(ALL);
  dupSi.holes[0].strokeIndex = 1;
  const siChecked = v.validateVisualRead(dupSi);
  assert.ok(siChecked.ok && !Object.keys(siChecked.read.handicap).length, "a duplicated stroke index strips the row, keeps the pars");

  /* ---------- assembly and confidence --------------------------------- */
  const full = v.assembleVisualCards([{ raw: read(ALL), image: { url: "https://x/card.jpg" } }], { name: "Te Arai Links" });
  assert.strictEqual(full.accepted.length, 1);
  assert.ok(full.accepted[0].confidence >= 0.8, "a full card with matching totals is high confidence: " + full.accepted[0].confidence);
  assert.strictEqual(full.accepted[0].card.holes.length, 18);
  assert.strictEqual(full.accepted[0].card.par, 72);
  assert.strictEqual(full.accepted[0].card.holes[1].strokeIndex, 1);
  assert.strictEqual(full.accepted[0].card.holes[0].distanceM, Math.round(530 * 0.9144), "second-longest tee in metres, like the HTML path");

  const pair = v.assembleVisualCards([
    { raw: read(BACK, { imageIndex: 2 }), image: { url: "https://x/back.jpg" } },
    { raw: read(FRONT), image: { url: "https://x/front.jpg" } }
  ]);
  assert.strictEqual(pair.accepted.length, 1, "separate front and back cards make one card");
  assert.deepStrictEqual(pair.accepted[0].layout, ["front-nine", "back-nine"]);
  assert.strictEqual(pair.accepted[0].card.holes.length, 18);

  const graphics = v.assembleVisualCards(ALL.map(h => ({ raw: holeGraphic(h), image: { url: "https://x/h" + h + ".jpg", kind: "single-hole", hole: h, fromHolePage: true } })));
  assert.strictEqual(graphics.accepted.length, 1, "eighteen hole graphics with a complete stroke index resolve");
  assert.ok(graphics.accepted[0].checks.strokeIndexComplete);
  assert.ok(graphics.accepted[0].confidence < full.accepted[0].confidence, "but with less confidence than a card with printed totals");

  const unchecked = v.assembleVisualCards(ALL.map(h => ({ raw: holeGraphic(h, { holes: [{ hole: h, par: PAR[h - 1], strokeIndex: null }] }), image: { url: "https://x/h" + h + ".jpg", fromHolePage: true, hole: h } })));
  assert.strictEqual(unchecked.accepted.length, 0, "OCR alone, with nothing to corroborate it, is rejected");
  assert.strictEqual(unchecked.rejected.find(x => x.layout === "hole-graphics").reason, "no-independent-check");

  const wrongHole = v.assembleVisualCards([{ raw: holeGraphic(8), image: { url: "https://x/h7.jpg", fromHolePage: true, hole: 7 } }]);
  assert.strictEqual(wrongHole.rejected[0].reason, "hole-number-disagrees-with-page");

  const blurry = v.assembleVisualCards(ALL.map(h => ({ raw: holeGraphic(h, { legibility: "poor" }), image: { url: "https://x/h" + h + ".jpg", fromHolePage: true, hole: h } })));
  assert.strictEqual(blurry.accepted.length, 0, "the model saying it was guessing pulls confidence below the bar");
  assert.match(blurry.rejected.find(x => x.layout === "hole-graphics").reason, /^low-confidence/);

  const conflict = read(BACK, { imageIndex: 2 });
  conflict.printedParIn = null;
  conflict.holes[0].par = 5; /* hole 10 */
  const disagree = v.assembleVisualCards([
    { raw: read(ALL), image: { url: "https://x/card.jpg" } },
    { raw: conflict, image: { url: "https://x/back.jpg" } }
  ]);
  assert.ok(disagree.accepted[0].problems.includes("another-image-disagrees-on-par"), "a second image that disagrees is recorded");
  assert.ok(disagree.accepted[0].confidence < full.accepted[0].confidence, "and costs confidence");

  /* ---------- through the resolver ------------------------------------ */
  const imagePage = `<html><head><meta property="og:title" content="Te Arai Links Golf Club - South Course"></head><body>
    <h1>Te Arai Links Golf Club - South Course</h1><img src="/img/south-scorecard.jpg" alt="South Course scorecard"></body></html>`;
  const fakeVisual = answerFor => {
    const calls = [];
    return {
      calls,
      fetchHtml: async url => answerFor.pages[url] || Promise.reject(new Error("HTTP 404")),
      readImages: async batch => { calls.push(batch.map(i => i.url)); return batch.map((image, index) => ({ image, raw: answerFor.read(image, index) })); }
    };
  };

  const visual = fakeVisual({ pages: {}, read: () => read(ALL) });
  const resolved = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => imagePage,
    visual
  });
  assert.strictEqual(resolved.cards.length, 1, "a page with only a scorecard image now resolves");
  assert.deepStrictEqual(resolved.debug.stages, ["html-extraction-failed", "scorecard-image-found", "visual-scorecard-resolved"]);
  assert.strictEqual(resolved.debug.stage, "visual-scorecard-resolved");
  assert.strictEqual(resolved.visual.status, "visual-scorecard-resolved");
  assert.strictEqual(resolved.cards[0].source, "visual-club-site");
  assert.strictEqual(resolved.cards[0].resolution.method, "visual");
  assert.ok(resolved.cards[0].resolution.confidence <= v.VISUAL_STORED_CONFIDENCE_CAP, "a picture read is never stored as a sticky, confirmed card");
  assert.strictEqual(resolved.attempts[0].stage, "html-extraction-failed");
  assert.ok(!resolved.reason, "no shortfall reason when a card was found");

  const liar = fakeVisual({ pages: {}, read: () => read(ALL, { printedParTotal: 70 }) });
  const failed = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => imagePage,
    visual: liar
  });
  assert.strictEqual(failed.cards.length, 0, "a transcription whose totals do not add up is not stored");
  assert.strictEqual(failed.reason, "visual-extraction-failed");
  assert.deepStrictEqual(failed.debug.stages, ["html-extraction-failed", "scorecard-image-found", "visual-extraction-failed"]);
  assert.match(failed.visual.rejected[0].reason, /par-total-mismatch/);

  const noImages = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => "<html><h1>Te Arai Links</h1><p>Welcome</p></html>",
    visual: fakeVisual({ pages: {}, read: () => read(ALL) })
  });
  assert.strictEqual(noImages.reason, "no-readable-card");
  assert.deepStrictEqual(noImages.debug.stages, ["html-extraction-failed"]);
  assert.strictEqual(noImages.visual.status, "no-scorecard-image");

  const unavailable = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => imagePage
  });
  assert.strictEqual(unavailable.visual.status, "unavailable", "without a vision reader the fallback says so");

  /* Per-hole pages: the course page links to eighteen hole pages, each with one graphic. */
  const coursePage = `<html><h1>Te Arai Links Golf Club - South Course</h1>${ALL.map(h => `<a href="/golf/south/hole-${h}">Hole ${h}</a>`).join("")}</html>`;
  const holePages = {};
  ALL.forEach(h => { holePages["https://tearai.com/golf/south/hole-" + h] = `<html><img src="/img/south-${h}.jpg" width="1200"></html>`; });
  const holeVisual = fakeVisual({ pages: holePages, read: image => holeGraphic(image.hole) });
  const byHole = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south/" }],
    fetchHtml: async () => coursePage,
    visual: holeVisual
  });
  assert.strictEqual(byHole.cards.length, 1, "individual hole graphics resolve a card");
  assert.strictEqual(byHole.cards[0].holes.length, 18);
  assert.strictEqual(byHole.visual.holePages, 18);
  assert.strictEqual(holeVisual.calls.length, 1, "all eighteen graphics go in one model call");
  assert.deepStrictEqual(byHole.cards[0].resolution.visualLayout.length, 18);

  /* A card printed with another club's name is not this course's card. */
  const other = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => imagePage,
    visual: fakeVisual({ pages: {}, read: () => read(ALL, { courseName: "Ayren Links Golf Club" }) })
  });
  assert.strictEqual(other.cards.length, 0);
  assert.match(other.visual.rejected.map(x => x.reason).join(" "), /name-mismatch/);

  /* HTML that reads never touches the visual path. */
  const htmlFirst = fakeVisual({ pages: {}, read: () => read(ALL) });
  const tr = cells => "<tr>" + cells.map(c => "<td>" + c + "</td>").join("") + "</tr>";
  const tablePage = "<html><h1>Te Arai Links Golf Club - South Course Scorecard</h1><table>"
    + tr(["Hole"].concat(ALL)) + tr(["Par"].concat(PAR)) + tr(["Championship"].concat(CHAMP)) + "</table></html>";
  const viaHtml = await r.resolveScorecard({ courseName: "Te Arai Links" }, {
    search: async () => [{ url: "https://tearai.com/golf/south-course/" }],
    fetchHtml: async () => tablePage,
    visual: htmlFirst
  });
  assert.strictEqual(viaHtml.cards.length, 1);
  assert.deepStrictEqual(viaHtml.debug.stages, ["html-resolved"]);
  assert.strictEqual(htmlFirst.calls.length, 0, "no model call when the HTML already answered");

  /* ---------- image search: Cebu Country Club ------------------------ */
  /* The real case. The card is on BlueGolf and mScorecard, which both refuse the
     page fetch, and the club's own pages show no card - so only an image search
     finds it. Read from a small screenshot of it: the Blue and White back-nine
     figures as read do not add up to the printed IN (3301, 3148), which is exactly
     the misread the totals are there to catch. Par, HCP and Red all add up. */
  const cebuHoles = Array.from({ length: 18 }, (_, i) => i + 1);
  const cebu = {
    par: [4, 5, 3, 4, 3, 4, 5, 4, 4, 4, 5, 4, 3, 4, 3, 5, 4, 4],
    hcp: [11, 1, 17, 7, 15, 5, 3, 13, 9, 10, 2, 12, 18, 8, 16, 4, 14, 6],
    blue: [390, 510, 175, 371, 156, 311, 524, 424, 384, 344, 513, 413, 197, 354, 192, 529, 383, 366],
    white: [375, 498, 165, 363, 152, 300, 482, 374, 376, 329, 503, 407, 191, 335, 165, 495, 383, 360],
    red: [361, 337, 160, 351, 127, 292, 450, 305, 305, 325, 460, 326, 152, 323, 149, 430, 343, 297]
  };
  const cebuTee = (name, list, printedOut, printedIn) => ({
    name, distances: cebuHoles.map(h => ({ hole: h, value: list[h - 1] })), printedOut, printedIn, printedTotal: null
  });
  const cebuRead = {
    imageIndex: 1, isScorecard: true, kind: "full-card", legibility: "clear", courseName: "Cebu Country Club", unit: "yards",
    holes: cebuHoles.map(h => ({ hole: h, par: cebu.par[h - 1], strokeIndex: cebu.hcp[h - 1] })),
    tees: [cebuTee("Blue", cebu.blue, 3245, 3301), cebuTee("White", cebu.white, 3085, 3148), cebuTee("Red", cebu.red, 2688, 2805)],
    printedParOut: 36, printedParIn: 36, printedParTotal: 72
  };
  const cebuPages = "<html><h1>Cebu Country Club</h1><p>Championship golf in Cebu.</p></html>";
  const searched = [];
  const cebuVisual = {
    calls: [],
    fetchHtml: async () => { throw new Error("HTTP 404"); },
    searchImages: async query => {
      searched.push(query);
      return [
        { imageUrl: "https://img.example/cebu-golf-sunset.jpg", pageUrl: "https://travel.example/cebu", title: "Cebu Country Club fairway at sunset", width: 1600, confidence: "high" },
        { imageUrl: "https://img.example/alta-vista.png", pageUrl: "https://cards.example/alta", title: "Scorecard: Alta Vista Golf and Country Club", width: 620, confidence: "high" },
        { imageUrl: "https://img.example/cebu-thumb.png", pageUrl: "https://cards.example/cebu-small", title: "Cebu Country Club scorecard", width: 120, confidence: "medium" },
        { imageUrl: "https://www.mscorecard.com/cards/cebucc.png", thumbnailUrl: "https://imgs.search.brave.com/x.png", pageUrl: "https://www.mscorecard.com/mscorecard/showcourse.php?cid=1177285338650", title: "Scorecard: Cebu Country Club", width: 620, confidence: "high" }
      ];
    },
    readImages: async batch => { cebuVisual.calls.push(batch.map(i => i.url)); return batch.map(image => ({ image, raw: cebuRead })); }
  };

  const picked = r.imageSearchCandidates(await cebuVisual.searchImages("x"), { aliases: ["Cebu Country Club"] }, "Cebu Country Club");
  assert.deepStrictEqual(picked.map(p => p.url), ["https://www.mscorecard.com/cards/cebucc.png"],
    "only the card titled for this course: not a photo, not another club's card, not a thumbnail");
  assert.strictEqual(picked[0].thumbnailUrl, "https://imgs.search.brave.com/x.png", "the search engine's copy rides along in case the original is refused");

  const viaSearch = await r.resolveScorecard({ courseName: "Cebu Country Club" }, {
    search: async () => [{ url: "https://www.cebucountryclub.com/golf" }],
    fetchHtml: async () => cebuPages,
    visual: cebuVisual
  });
  assert.strictEqual(searched[searched.length - 1], "Cebu Country Club scorecard");
  assert.strictEqual(viaSearch.cards.length, 1, "Cebu resolves from an image search when no page shows the card");
  assert.deepStrictEqual(viaSearch.debug.stages, ["html-extraction-failed", "scorecard-image-found", "visual-scorecard-resolved"]);
  const cebuCard = viaSearch.cards[0];
  assert.strictEqual(cebuCard.name, "Cebu Country Club", "named for the course, not the printed 'Scorecard:' heading");
  assert.strictEqual(cebuCard.par, 72);
  assert.strictEqual(cebuCard.source, "visual-image-search");
  assert.strictEqual(cebuCard.sourceUrl, "https://www.mscorecard.com/mscorecard/showcourse.php?cid=1177285338650");
  assert.deepStrictEqual(cebuCard.teeOptions, ["Red"], "Blue and White are dropped: their back nine does not add up to the printed IN");
  assert.strictEqual(cebuCard.holes[0].distanceM, Math.round(361 * 0.9144));
  assert.ok(cebuCard.resolution.visualChecks.parTotalsMatched && cebuCard.resolution.visualChecks.strokeIndexComplete);
  assert.strictEqual(viaSearch.visual.imageSearch.kept.length, 1);
  assert.strictEqual(cebuVisual.calls.length, 1, "one model call");

  console.log("scorecard visual fallback tests passed");
})().catch(error => { console.error(error); process.exit(1); });
