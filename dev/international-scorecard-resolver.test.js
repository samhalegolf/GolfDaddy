/* Regression: an OSM-local Korean name can resolve an English-branded official
 * site with three separately named nines. All web responses are fixtures. */

const assert = require("assert");
const path = require("path");
const identityCore = require("../functions/lib/gd-course-search-identity");
const RESOLVE = "file://" + path.join(__dirname, "..", "functions", "lib", "gd-scorecard-resolve.mjs");

function nine(name, pars, start) {
  const header = ["Hole", 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const distances = Array.from({ length: 9 }, (_, i) => start + i * 17);
  const tr = row => "<tr>" + row.map(cell => "<td>" + cell + "</td>").join("") + "</tr>";
  return "<h2>" + name + " Course</h2><table>"
    + tr(header) + tr(["PAR"].concat(pars)) + tr(["Blue Tee"].concat(distances))
    + tr(["HDCP", 9, 3, 7, 1, 5, 8, 2, 6, 4]) + "</table>";
}

const OFFICIAL_HTML = '<html><head><meta property="og:title" content="SOPHIAGREEN COUNTRY CLUB - Course Guide"></head><body>'
  + "<h1>소피아그린 컨트리클럽 코스소개</h1>"
  + nine("Sejong", [4, 4, 3, 5, 4, 4, 5, 3, 4], 295)
  + nine("Yeogang", [4, 3, 4, 5, 4, 5, 3, 4, 4], 282)
  + nine("Hwanghak", [5, 4, 3, 4, 4, 3, 5, 4, 4], 306)
  + "</body></html>";

(async () => {
  const identity = identityCore.buildCourseSearchIdentity({
    courseName: "소피아그린CC",
    osmName: "소피아그린CC",
    localName: "소피아그린CC",
    englishName: "Sophiagreen Country Club",
    aliases: ["Sophia Green CC"],
    country: "South Korea", countryCode: "KR",
    region: "Gyeonggi-do", city: "Yeoju",
    lat: 37.17804, lng: 127.70751,
    expectedHoleCount: 27
  });

  assert(identity.aliases.includes("소피아그린CC"), "the original local-script name is retained");
  assert(identity.aliases.some(alias => /^Sophiagreen CC$/i.test(alias)), "joined English alias generated");
  assert(identity.aliases.some(alias => /^Sophia Green Country Club$/i.test(alias)), "split English alias generated");
  const queries = identityCore.buildSearchQueries(identity, { max: 40 });
  assert(queries.some(item => item.query === "소피아그린CC 코스"), "Korean course term is queried");
  assert(queries.some(item => /Sophia Green CC scorecard/i.test(item.query)), "English alias is queried");
  assert(queries.some(item => /Yeoju golf/i.test(item.query)), "location-strengthened query is generated");

  const resolver = await import(RESOLVE);
  const fetched = [];
  const result = await resolver.resolveScorecard({
    courseName: "소피아그린CC",
    osmName: "소피아그린CC",
    localName: "소피아그린CC",
    englishName: "Sophiagreen Country Club",
    aliases: ["Sophia Green CC"],
    country: "South Korea", countryCode: "KR",
    region: "Gyeonggi-do", city: "Yeoju",
    center: { lat: 37.17804, lng: 127.70751 },
    expectedHoleCount: 27
  }, {
    search: async () => ({
      identity,
      queries: queries.slice(0, 8).map(item => ({ query: item.query, kind: item.kind, results: 1, error: null })),
      domainsDiscovered: ["sophiagreen.co.kr"],
      results: [
        {
          url: "https://unrelated.example.com/resort/course",
          title: "A different resort golf course", snippet: "18 holes far from Yeoju",
          candidateScore: -5, scoreReasons: ["ambiguous-listing"]
        },
        {
          url: "https://sophiagreen.co.kr/swp/course",
          title: "소피아그린 컨트리클럽", snippet: "코스소개 세종 여강 황학",
          official: true, candidateScore: 90,
          scoreReasons: ["name:1.00", "location:Yeoju", "official-domain", "golf-content"]
        }
      ]
    }),
    fetchHtml: async url => {
      fetched.push(url);
      if (url.includes("sophiagreen.co.kr")) return OFFICIAL_HTML;
      return "<html><h1>Different Resort</h1><p>Golf packages and hotel rooms.</p></html>";
    }
  }, { want: 3 });

  assert.strictEqual(result.cards.length, 3, "three scorecards are returned, not no shared scorecard");
  assert.strictEqual(fetched[0], "https://sophiagreen.co.kr/swp/course", "official course page ranks first");
  assert.strictEqual(result.facility.holeCount, 27, "27-hole facility detected");
  assert.deepStrictEqual(result.facility.loops.map(loop => loop.name).sort(), ["Hwanghak", "Sejong", "Yeogang"], "three named nines detected");
  assert.strictEqual(result.facility.loopCount, 3);
  assert(result.searchTrace.queries.length > 0, "query ladder is retained in the debug trace");
  assert(result.attempts[0].scorecardConfidence >= 55, "course guide is detected semantically without the word scorecard");

  assert.strictEqual(resolver.shouldReplaceFacilityCard(
    { source: "scorecard-engine", sources_json: [{ resolution: { confidence: 0.92, confirmed: true } }] },
    { source: "scorecard-engine", sources_json: [{ resolution: { confidence: 0.61 } }] }
  ), false, "lower-confidence discovery cannot overwrite a confirmed cache entry");

  console.log("international scorecard resolver tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
