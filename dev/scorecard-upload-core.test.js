/* lib/gd-scorecard-upload-core: what an admin drops on a course row, as cards.
 *
 * No network. The tab-separated fixture is a card pasted straight out of a web
 * table, exactly as it arrived - two stacked nines, Out/In/Total columns, "SI" for
 * stroke index and a thousands separator in the yardage.
 *
 * Run: node dev/scorecard-upload-core.test.js */

const assert = require("assert");
const path = require("path");
const CORE = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-scorecard-upload-core.mjs");

const PASTED = [
  "Hole\t1\t2\t3\t4\t5\t6\t7\t8\t9\tOut\t",
  "Par\t4\t3\t4\t4\t3\t4\t4\t5\t4\t35\t",
  "SI\t11\t15\t9\t5\t17\t3\t13\t7\t1\t\t",
  "Yards\t300\t119\t333\t381\t141\t405\t360\t492\t455\t2,986\t",
  "Hole\t10\t11\t12\t13\t14\t15\t16\t17\t18\tIn\tTotal",
  "Par\t4\t4\t4\t4\t3\t5\t4\t3\t4\t35\t70",
  "SI\t8\t6\t10\t18\t4\t2\t16\t12\t14\t\t",
  "Yards\t334\t317\t341\t325\t241\t475\t290\t237\t301\t2,861\t5,847"
].join("\n");

(async () => {
  const core = await import(CORE);

  /* ---------- classification ---------- */
  assert.strictEqual(core.classifyUpload({ name: "card.jpg", mediaType: "image/jpeg" }), "image");
  assert.strictEqual(core.classifyUpload({ name: "card.PNG", mediaType: "" }), "image", "an image by extension alone");
  assert.strictEqual(core.classifyUpload({ name: "card.pdf", mediaType: "application/pdf" }), "pdf");
  assert.strictEqual(core.classifyUpload({ name: "page.html", mediaType: "text/html" }), "html");
  assert.strictEqual(core.classifyUpload({ name: "card.csv", mediaType: "text/csv" }), "text");
  assert.strictEqual(core.classifyUpload({ name: "card.tsv", mediaType: "" }), "text");
  assert.strictEqual(core.classifyUpload({ name: "card.json", mediaType: "application/json" }), "json");
  assert.strictEqual(core.classifyUpload({ name: "", mediaType: "", text: "Hole 1 2 3" }), "text", "pasted text with no file behind it");
  assert.strictEqual(core.classifyUpload({ name: "card.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), null, "spreadsheets are refused so the admin hears to export CSV");

  /* ---------- line splitting ---------- */
  assert.deepStrictEqual(core.splitDelimitedLine("Yards\t300\t2,986\t"), ["Yards", "300", "2,986", ""], "tabs win, so a thousands separator survives");
  assert.deepStrictEqual(core.splitDelimitedLine('Yards,300,"2,986"'), ["Yards", "300", "2,986"], "CSV honours quotes");
  assert.deepStrictEqual(core.splitDelimitedLine("Par   4  3   4"), ["Par", "4", "3", "4"], "space-aligned text splits on runs of spaces");

  /* ---------- the pasted card ---------- */
  assert.strictEqual(core.textToGrid(PASTED).length, 8, "one row per non-empty line");
  const cards = core.cardsFromText(PASTED, { name: "Pasted Links" });
  assert.strictEqual(cards.length, 1, "the two nines merge into one card: " + JSON.stringify(cards.map(c => c.holes.length)));
  const card = cards[0];
  assert.strictEqual(card.holes.length, 18);
  assert.strictEqual(card.par, 70, "par from the per-hole pars, not the printed total");
  assert.strictEqual(card.holes[0].par, 4);
  assert.strictEqual(card.holes[0].strokeIndex, 11);
  assert.strictEqual(card.holes[17].strokeIndex, 14);
  assert.strictEqual(card.holes[13].par, 3);
  assert.strictEqual(card.holes[13].strokeIndex, 4);
  /* 300 yards is 274 m. Yards are declared by the row label, so no guessing. */
  assert.strictEqual(card.holes[0].distanceM, 274, "yards converted to metres: " + card.holes[0].distanceM);
  assert.strictEqual(card.holes[17].distanceM, 275);
  assert.strictEqual(card.name, "Pasted Links");

  /* The same card as CSV with quoted totals. */
  const csv = PASTED.split("\n").map(line => line.split("\t").map(cell => /,/.test(cell) ? '"' + cell + '"' : cell).join(",")).join("\n");
  const fromCsv = core.cardsFromText(csv, { name: "Pasted Links" });
  assert.strictEqual(fromCsv.length, 1);
  assert.strictEqual(fromCsv[0].holes.length, 18);
  assert.strictEqual(fromCsv[0].holes[8].distanceM, card.holes[8].distanceM);

  /* ---------- the same card printed down the page ---------- */
  const across = core.textToGrid(PASTED);
  const front = across.slice(0, 4), back = across.slice(4);
  const downLines = ["Hole\tPar\tSI\tYards"];
  for (let c = 1; c < front[0].length; c++) if (front[0][c]) downLines.push(front.map(row => row[c]).join("\t"));
  for (let c = 1; c < back[0].length; c++) if (back[0][c]) downLines.push(back.map(row => row[c]).join("\t"));
  const down = core.cardsFromText(downLines.join("\n"), { name: "Pasted Links" });
  assert.strictEqual(down.length, 1, "a holes-down card reads as one card");
  assert.strictEqual(down[0].holes.length, 18, "Out / In / Total rows are not holes");
  assert.deepStrictEqual(down[0].holes.map(h => h.par), card.holes.map(h => h.par));
  assert.deepStrictEqual(down[0].holes.map(h => h.strokeIndex), card.holes.map(h => h.strokeIndex));
  assert.deepStrictEqual(down[0].holes.map(h => h.distanceM), card.holes.map(h => h.distanceM));

  /* ---------- no labels at all: rows known by their numbers ---------- */
  const bare = [
    "1 2 3 4 5 6 7 8 9",
    "4 3 4 4 3 4 4 5 4",
    "11 15 9 5 17 3 13 7 1",
    "300 119 333 381 141 405 360 492 455"
  ].join("\n");
  const bareCards = core.cardsFromText(bare, { name: "Bare" });
  assert.strictEqual(bareCards.length, 1);
  assert.deepStrictEqual(bareCards[0].holes.map(h => h.par), [4, 3, 4, 4, 3, 4, 4, 5, 4], "the all-3s-4s-5s row is par");
  assert.strictEqual(bareCards[0].holes[0].strokeIndex, 11, "distinct 1-18 is the index");
  assert.ok(bareCards[0].holes[0].distanceM > 0, "the 100+ row is a tee");
  const bareDown = core.cardsFromText(bare.split("\n").map(l => l.split(" ")).reduce((cols, row) => row.map((v, i) => (cols[i] || []).concat(v)), []).map(r => r.join(" ")).join("\n"), { name: "Bare" });
  assert.deepStrictEqual(bareDown[0].holes.map(h => h.par), bareCards[0].holes.map(h => h.par), "and the same numbers turned round");

  /* ---------- HTML and JSON routes ---------- */
  const html = "<html><body><h1>Pasted Links Golf Club</h1><table>" + PASTED.split("\n").map(line => "<tr>" + line.split("\t").map(c => "<td>" + c + "</td>").join("") + "</tr>").join("") + "</table></body></html>";
  const fromHtml = core.cardsFromHtml(html, { name: "Pasted Links" });
  assert.strictEqual(fromHtml.length, 1);
  assert.strictEqual(fromHtml[0].holes.length, 18, "one table holding both nines still reads as one card");

  const json = JSON.stringify({ courseName: "Stored Links", holes: card.holes.map(h => ({ hole: h.hole, par: h.par, index: h.strokeIndex, metres: h.distanceM })) });
  const fromJson = core.cardFromJson(json);
  assert(fromJson, "a card in the stored shape round-trips");
  assert.strictEqual(fromJson.name, "Stored Links");
  assert.strictEqual(fromJson.holes.length, 18);
  assert.strictEqual(fromJson.holes[0].distanceM, 274);
  assert.strictEqual(core.cardFromJson("not json"), null);
  assert.strictEqual(core.cardFromJson({ holes: [{ hole: 1, par: 4 }] }), null, "fewer than nine holes is not a card");

  /* ---------- a whole upload ---------- */
  const upload = core.cardsFromUpload([
    { name: "", mediaType: "", text: PASTED },
    { name: "photo.jpg", mediaType: "image/jpeg", data: "..." },
    { name: "card.pdf", mediaType: "application/pdf", data: "..." },
    { name: "notes.txt", mediaType: "text/plain", text: "Lovely course, par 72." },
    { name: "card.xlsx", mediaType: "", data: "..." }
  ], { name: "Pasted Links" });
  assert.strictEqual(upload.cards.length, 1);
  assert.strictEqual(upload.cards[0].from, "pasted text");
  assert.deepStrictEqual(upload.deferred.map(f => f.kind), ["image", "pdf"], "pictures and PDFs are handed back for the caller to decide");
  assert.deepStrictEqual(upload.rejected, [{ name: "notes.txt", reason: "no-card-found" }, { name: "card.xlsx", reason: "unsupported-format" }]);

  console.log("scorecard-upload-core: ok");
})().catch(error => { console.error(error); process.exit(1); });
