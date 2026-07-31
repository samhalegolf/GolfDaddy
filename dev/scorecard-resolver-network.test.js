/* Covers the server side of scorecard resolution: the SSRF guards shared by both
   functions, the redirect handling in scorecard-fetch, and the ranking in
   scorecard-search. Outbound fetch is stubbed and every host is a literal IP, so
   the suite is hermetic - no DNS, no network. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { safeRemoteUrl, resolvesToPublicAddress } = require(path.join(root, "functions", "lib", "safe-remote-url"));

/* ---------- shared SSRF guards ---------- */

[
  ["https://www.akaranagolf.co.nz/hole-by-hole", true, "ordinary club page"],
  ["https://8.8.8.8/scorecard", true, "public literal address"],
  ["http://example.com/", false, "plain http"],
  ["https://localhost/x", false, "localhost"],
  ["https://host.internal/x", false, "internal suffix"],
  ["https://127.0.0.1/x", false, "loopback"],
  ["https://10.0.0.5/x", false, "private class A"],
  ["https://172.16.0.1/x", false, "private class B"],
  ["https://192.168.1.1/x", false, "private class C"],
  ["https://169.254.169.254/latest/meta-data/", false, "cloud metadata"],
  ["https://100.64.0.1/x", false, "carrier-grade NAT"],
  ["https://[::1]/x", false, "IPv6 loopback"],
  ["https://[fd00::1]/x", false, "IPv6 unique local"],
  ["https://[fe80::1]/x", false, "IPv6 link local"],
  ["https://[::ffff:127.0.0.1]/x", false, "IPv4-mapped loopback"],
  ["https://user:pass@example.com/x", false, "embedded credentials"],
  ["https://example.com:8080/x", false, "non-443 port"],
  ["file:///etc/passwd", false, "non-http scheme"],
  ["", false, "empty"]
].forEach(([url, want, label]) => {
  assert.strictEqual(!!safeRemoteUrl(url), want, `safeRemoteUrl ${label}: ${url}`);
});

assert.strictEqual(!!safeRemoteUrl("https://example.com/" + "a".repeat(600)), false, "over-long URL rejected");

/* ---------- scorecard-fetch ---------- */

const scorecardFetch = require(path.join(root, "functions", "scorecard-fetch")).handler;
const realFetch = global.fetch;

function stubResponse(options) {
  const headers = new Map(Object.entries(options.headers || {}));
  return {
    ok: options.status ? options.status >= 200 && options.status < 300 : true,
    status: options.status || 200,
    headers: { get: name => headers.get(String(name).toLowerCase()) || null },
    text: async () => options.text || ""
  };
}

function withStubbedFetch(routes, run) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const route = routes[String(url)];
    if (!route) throw new Error("unstubbed URL " + url);
    return stubResponse(route);
  };
  return run(calls).finally(() => {
    global.fetch = realFetch;
  });
}

function post(url) {
  return scorecardFetch({ httpMethod: "POST", body: JSON.stringify({ url }) });
}

function parse(res) {
  return JSON.parse(res.body || "{}");
}

(async function run() {
  let res = await scorecardFetch({ httpMethod: "GET" });
  assert.strictEqual(res.statusCode, 405, "GET is rejected");

  res = await scorecardFetch({ httpMethod: "POST", body: "{not json" });
  assert.strictEqual(res.statusCode, 400, "invalid JSON is rejected");

  res = await post("https://169.254.169.254/latest/meta-data/");
  assert.strictEqual(res.statusCode, 400, "metadata endpoint is refused before any request");

  await withStubbedFetch({
    "https://8.8.8.8/card": { headers: { "content-type": "text/html" }, text: "<html>card</html>" }
  }, async (calls) => {
    const out = parse(await post("https://8.8.8.8/card"));
    assert.strictEqual(out.html, "<html>card</html>", "html is returned");
    assert.strictEqual(out.url, "https://8.8.8.8/card", "final URL is reported");
    assert.strictEqual(calls.length, 1, "one outbound request");
  });

  /* A redirect into private space must be caught on the hop, not just at entry. */
  await withStubbedFetch({
    "https://8.8.8.8/start": { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data/" } }
  }, async () => {
    const out = parse(await post("https://8.8.8.8/start"));
    assert.match(out.error, /unsupported URL/, "redirect into private space is refused: " + out.error);
  });

  await withStubbedFetch({
    "https://8.8.8.8/a": { status: 301, headers: { location: "https://8.8.4.4/b" } },
    "https://8.8.4.4/b": { headers: { "content-type": "text/html" }, text: "<html>moved</html>" }
  }, async () => {
    const out = parse(await post("https://8.8.8.8/a"));
    assert.strictEqual(out.html, "<html>moved</html>", "public redirect is followed");
    assert.strictEqual(out.url, "https://8.8.4.4/b", "final URL after redirect is reported");
  });

  await withStubbedFetch({
    "https://8.8.8.8/loop": { status: 302, headers: { location: "https://8.8.8.8/loop" } }
  }, async () => {
    const out = parse(await post("https://8.8.8.8/loop"));
    assert.match(out.error, /too many times/, "redirect loop terminates: " + out.error);
  });

  await withStubbedFetch({
    "https://8.8.8.8/logo.png": { headers: { "content-type": "image/png" }, text: "binary" }
  }, async () => {
    const res2 = await post("https://8.8.8.8/logo.png");
    assert.strictEqual(res2.statusCode, 415, "non-document responses are refused");
  });

  await withStubbedFetch({
    "https://8.8.8.8/huge": { headers: { "content-type": "text/html" }, text: "x".repeat(900000) }
  }, async () => {
    const out = parse(await post("https://8.8.8.8/huge"));
    assert.strictEqual(out.html.length, 650000, "oversized documents are capped");
  });

  await withStubbedFetch({
    "https://8.8.8.8/gone": { status: 404, headers: { "content-type": "text/html" } }
  }, async () => {
    const res2 = await post("https://8.8.8.8/gone");
    assert.strictEqual(res2.statusCode, 404, "upstream status is passed through");
  });

  /* ---------- scorecard-search ---------- */

  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GOOGLE_CSE_KEY;
  delete process.env.GOOGLE_CSE_ID;
  const searchPath = path.join(root, "functions", "scorecard-search");
  delete require.cache[require.resolve(searchPath)];
  let scorecardSearch = require(searchPath).handler;

  res = await scorecardSearch({ httpMethod: "POST", body: JSON.stringify({ name: "Akarana Golf Club" }) });
  assert.strictEqual(res.statusCode, 503, "unconfigured search reports itself rather than failing silently");

  res = await scorecardSearch({ httpMethod: "POST", body: JSON.stringify({}) });
  assert.strictEqual(res.statusCode, 400, "a course name is required");

  process.env.BRAVE_SEARCH_API_KEY = "test-key";
  delete require.cache[require.resolve(searchPath)];
  scorecardSearch = require(searchPath).handler;

  let authHeaderSent = false;
  global.fetch = async (url, opts) => {
    authHeaderSent = !!(opts && opts.headers && opts.headers["X-Subscription-Token"]);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { url: "https://www.facebook.com/akaranagolf", title: "Akarana Golf Club", description: "scorecard" },
            { url: "https://www.akaranagolf.co.nz/news", title: "Club news", description: "latest news" },
            { url: "https://www.akaranagolf.co.nz/hole-by-hole", title: "Hole by hole - Akarana Golf Club", description: "par and stroke index" },
            { url: "https://www.akaranagolf.co.nz/hole-by-hole/", title: "duplicate", description: "x" },
            { url: "http://insecure.example/scorecard", title: "insecure", description: "x" },
            { url: "https://192.168.0.9/scorecard", title: "private", description: "x" }
          ]
        }
      })
    };
  };

  try {
    const out = parse(await scorecardSearch({
      httpMethod: "POST",
      body: JSON.stringify({ name: "Akarana Golf Club", region: "Auckland" })
    }));
    assert(authHeaderSent, "the provider key is sent server-side");
    const urls = out.results.map(r => r.url);
    assert.strictEqual(urls[0], "https://www.akaranagolf.co.nz/hole-by-hole", "the hole-by-hole page ranks first");
    assert(!urls.includes("http://insecure.example/scorecard"), "http results are dropped");
    assert(!urls.includes("https://192.168.0.9/scorecard"), "private-address results are dropped");
    assert(!urls.includes("https://www.akaranagolf.co.nz/hole-by-hole/"), "trailing-slash duplicates are collapsed");
    assert(
      urls.indexOf("https://www.facebook.com/akaranagolf") === urls.length - 1,
      "social results rank last"
    );
    assert(out.query.includes("Auckland"), "region narrows the query");
  } finally {
    global.fetch = realFetch;
  }

  /* ---------- client fetch order ---------- */

  const owner = fs.readFileSync(path.join(root, "scripts", "inline", "gd-gps-scorecard-owner-v1.js"), "utf8");
  const body = owner.slice(owner.indexOf("async function gdFetchScorecardText"));
  const proxyAt = body.indexOf("/api/scorecard-fetch");
  const directAt = body.indexOf("await fetch(url,");
  assert(proxyAt > -1 && directAt > -1, "both fetch paths are present");
  assert(proxyAt < directAt, "the proxy is tried before the direct cross-origin fetch");
  assert(
    body.slice(0, directAt).includes("window.GDNative?.isNative"),
    "the direct fetch is gated on the native shell, where it can actually succeed"
  );
  assert(
    owner.includes("gdScorecardSearchCandidates"),
    "the loader can fall back to search when guessed URLs miss"
  );

  /* Resolution order: device cache, then the shared store, then the club website,
     then search. Each step is more expensive than the one before it. */
  const loader = owner.slice(owner.indexOf("async function gdEnsureScorecardForCourse"));
  const localAt = loader.indexOf("gdScorecardReadCache");
  const sharedAt = loader.indexOf("gdScorecardReadShared");
  const websiteAt = loader.indexOf("await trySources(sources)");
  const searchAt = loader.indexOf("gdScorecardSearchCandidates");
  assert(localAt > -1 && sharedAt > -1 && websiteAt > -1 && searchAt > -1, "every resolution step is present");
  assert(localAt < sharedAt, "the device cache is checked before the shared store");
  assert(sharedAt < websiteAt, "the shared store is checked before the club website");
  assert(websiteAt < searchAt, "search is the last resort");

  /* The merge folds in this player's scores, so the share must snapshot first. */
  const shareableAt = loader.indexOf("const shareable=");
  const mergeAt = loader.indexOf("loaded.holes=gdScorecardMergeScores");
  assert(shareableAt > -1 && mergeAt > -1, "both the snapshot and the merge are present");
  assert(shareableAt < mergeAt, "the shared copy is snapshotted before scores are merged in");
  assert(
    /const shareable=[^\n]*score:null,putts:null/.test(loader),
    "the shared copy has scores and putts stripped"
  );

  /* Guards must be shared, not copied - a second copy drifts and the weaker wins. */
  const fetchSource = fs.readFileSync(path.join(root, "functions", "scorecard-fetch.js"), "utf8");
  const searchSource = fs.readFileSync(path.join(root, "functions", "scorecard-search.js"), "utf8");
  assert(fetchSource.includes('require("./lib/safe-remote-url")'), "scorecard-fetch uses the shared guards");
  assert(searchSource.includes('require("./lib/safe-remote-url")'), "scorecard-search uses the shared guards");
  assert(!/function isPublicIPv4/.test(fetchSource + searchSource), "the address checks are not duplicated");

  assert.strictEqual(await resolvesToPublicAddress(new URL("https://127.0.0.1/")), false, "literal loopback fails DNS check");

  console.log("scorecard-resolver-network tests passed");
})().catch(error => {
  global.fetch = realFetch;
  console.error(error);
  process.exit(1);
});
