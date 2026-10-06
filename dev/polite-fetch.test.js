/* lib/gd-polite-fetch: the manners every scorecard page read keeps.
 *
 * No network. fetch is injected and every host is a literal public IP, so
 * safe-remote-url's DNS check is satisfied without a lookup.
 *
 * Run: node dev/polite-fetch.test.js */

const assert = require("assert");
const path = require("path");
const polite = require(path.join(__dirname, "..", "functions", "lib", "gd-polite-fetch"));

const { isBlockedHost, parseRobots, robotsAllows, createPoliteHtmlFetcher } = polite;

function response(status, body, headers) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: name => (headers || {})[name.toLowerCase()] || null },
    text: async () => body || ""
  };
}

/* ---------- the do-not-fetch list ---------- */

assert(isBlockedHost("https://www.bluegolf.com/bluegolf/course/scorecard.htm"), "bluegolf is blocked");
assert(isBlockedHost("https://bluegolf.com/x"), "bare bluegolf host is blocked");
assert(isBlockedHost("https://course.bluegolf.com/x/club/detailedscorecard.htm"), "bluegolf subdomains are blocked");
assert(!isBlockedHost("https://www.mscorecard.com/cards/cebucc.png"), "a site that only refuses us is handled by the refusal memory, not the list");
assert(!isBlockedHost("https://notbluegolf.com/x"), "a host that merely ends in the letters is not blocked");
assert(!isBlockedHost("https://www.golfpass.com/travel-advisor/courses/1"), "other aggregators are not blocked");
assert(!isBlockedHost("not a url"), "garbage is not blocked, just unusable");

/* ---------- robots.txt ---------- */

const robots = parseRobots(`
# a comment
User-agent: *
Disallow: /private/
Disallow: /tmp
Allow: /private/public-card.html

User-agent: ClarityCaddie
Disallow: /courses/

User-agent: Googlebot
User-agent: Bingbot
Disallow:
`);
assert.strictEqual(robots.length, 3, "three groups, consecutive agents share one");
assert.deepStrictEqual(robots[2].agents, ["googlebot", "bingbot"]);

assert(robotsAllows(robots, "/private/secret.html", "ClarityCaddie"), "the group naming us wins: /private is only closed to *");
assert(!robotsAllows(robots, "/courses/te-arai", "ClarityCaddie"), "our own group's Disallow applies to us");
assert(robotsAllows(robots, "/courses/te-arai", "SomeoneElse"), "the * group does not close /courses");
assert(!robotsAllows(robots, "/private/secret.html", "SomeoneElse"), "the * group closes /private to everyone else");
assert(robotsAllows(robots, "/private/public-card.html", "SomeoneElse"), "a longer Allow beats a shorter Disallow");
assert(!robotsAllows(robots, "/tmpfile", "SomeoneElse"), "Disallow is a prefix match");
assert(robotsAllows(robots, "/anything", "Googlebot"), "an empty Disallow allows everything");
assert(robotsAllows([], "/anything", "ClarityCaddie"), "no rules at all means allowed");

const wildcards = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*\nAllow: /searchable");
assert(!robotsAllows(wildcards, "/cards/south.pdf", "x"), "* wildcard with $ anchor");
assert(robotsAllows(wildcards, "/cards/south.pdf?v=2", "x"), "$ pins the end, so a query string escapes it");
assert(!robotsAllows(wildcards, "/search?q=1", "x"), "trailing * is a prefix");
assert(robotsAllows(wildcards, "/searchable", "x"), "longer Allow wins over the wildcard Disallow");

/* ---------- the fetcher ---------- */

(async () => {
  /* Every fetch the stub sees, so the tests can say what was NOT requested. */
  let calls = [];
  let clock = 1000;
  const world = {
    "https://8.8.8.8/robots.txt": () => response(200, "User-agent: *\nDisallow: /members/\n"),
    "https://8.8.8.8/scorecard": () => response(200, "<html>card</html>"),
    "https://8.8.8.8/members/card": () => response(200, "<html>should never be read</html>"),
    "https://8.8.4.4/robots.txt": () => response(404, ""),
    "https://8.8.4.4/scorecard": () => response(403, ""),
    "https://8.8.4.4/other": () => response(200, "<html>should never be read</html>"),
    "https://1.1.1.1/robots.txt": () => response(503, ""),
    "https://1.1.1.1/scorecard": () => response(200, "<html>should never be read</html>"),
    "https://9.9.9.9/robots.txt": () => response(404, ""),
    "https://9.9.9.9/a": () => response(200, "<html>a</html>"),
    "https://9.9.9.9/b": () => response(200, "<html>b</html>"),
    "https://9.9.9.9/c": () => response(200, "<html>c</html>")
  };
  const fetchImpl = async url => {
    calls.push({ url: String(url), at: clock });
    const answer = world[String(url)];
    if (!answer) throw new Error("unexpected fetch " + url);
    return answer();
  };
  /* A virtual clock: the gap is enforced by comparing timestamps, and the stub
     advances time instead of really sleeping. */
  const fetchHtml = createPoliteHtmlFetcher({ fetchImpl, minGapMs: 1000, now: () => clock });
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => { clock += ms; return realSetTimeout(fn, 0); };

  try {
    /* 1. Blocked hosts: refused before any request. */
    await assert.rejects(fetchHtml("https://www.bluegolf.com/bluegolf/course/x.htm"), /do-not-fetch/);
    assert.strictEqual(calls.length, 0, "a blocked host is never fetched, not even its robots.txt");

    /* 2. robots.txt is read once and obeyed. */
    assert.strictEqual(await fetchHtml("https://8.8.8.8/scorecard"), "<html>card</html>");
    await assert.rejects(fetchHtml("https://8.8.8.8/members/card"), /robots\.txt/);
    assert.deepStrictEqual(calls.map(c => c.url), ["https://8.8.8.8/robots.txt", "https://8.8.8.8/scorecard"],
      "robots.txt once, the allowed page once, the disallowed page never");

    /* 3. A 403 marks the host refused for the rest of the run. */
    calls = [];
    await assert.rejects(fetchHtml("https://8.8.4.4/scorecard"), /HTTP 403/);
    await assert.rejects(fetchHtml("https://8.8.4.4/other"), /refused us earlier/);
    assert.deepStrictEqual(calls.map(c => c.url), ["https://8.8.4.4/robots.txt", "https://8.8.4.4/scorecard"],
      "after a 403 the host is not asked again");
    assert.deepStrictEqual(fetchHtml.refusedHosts().map(h => h.host), ["8.8.4.4"]);

    /* 4. A host whose robots.txt is down is left alone. */
    calls = [];
    await assert.rejects(fetchHtml("https://1.1.1.1/scorecard"), /robots\.txt unreachable/);
    assert.deepStrictEqual(calls.map(c => c.url), ["https://1.1.1.1/robots.txt"], "no page read behind a 5xx robots.txt");

    /* 5. Requests to one host are spaced; different hosts are not held up by each other. */
    calls = [];
    const pages = await Promise.all([fetchHtml("https://9.9.9.9/a"), fetchHtml("https://9.9.9.9/b"), fetchHtml("https://9.9.9.9/c")]);
    assert.deepStrictEqual(pages, ["<html>a</html>", "<html>b</html>", "<html>c</html>"], "concurrent callers all get their page");
    const times = calls.map(c => c.at);
    for (let i = 1; i < times.length; i++) {
      assert(times[i] - times[i - 1] >= 1000, "requests " + (i - 1) + " and " + i + " to one host are at least a second apart (" + (times[i] - times[i - 1]) + "ms)");
    }
    assert.deepStrictEqual(calls.map(c => c.url), ["https://9.9.9.9/robots.txt", "https://9.9.9.9/a", "https://9.9.9.9/b", "https://9.9.9.9/c"],
      "robots.txt first, then the pages in order");

    /* 6. The User-Agent names us. */
    let seenHeaders = null;
    const named = createPoliteHtmlFetcher({ fetchImpl: async (url, opts) => { seenHeaders = opts.headers; return response(404, ""); }, minGapMs: 0 });
    await assert.rejects(named("https://8.8.8.8/x"), /HTTP 404/);
    assert.match(seenHeaders["User-Agent"], /^ClarityCaddie\/1\.0 \(\+https:\/\/caddy\.claritygolf\.app\)$/, "every request says who we are");
  } finally {
    global.setTimeout = realSetTimeout;
  }

  console.log("polite-fetch: ok");
})().catch(error => { console.error(error); process.exit(1); });
