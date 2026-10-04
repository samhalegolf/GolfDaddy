/* The GPS app must distinguish a real guest from a signed-in session whose access-token
 * refresh failed. Otherwise a member can silently fall onto the guest's one-map allowance. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "app", "js", "course-package.js"), "utf8");
const GUEST = "9f7381c2e4a60b5d1c8e4f0a2b6d7e31";

async function runCase({ signedIn, token, responseBody }) {
  const calls = [];
  const ctx = {
    console,
    document: { body: { dataset: {} } },
    setTimeout,
    clearTimeout,
    AbortController: undefined,
    ClarityApp: {
      courseKey(value) { return String(value || ""); },
      account: { signedIn() { return !!signedIn; } }
    },
    ClaritySupabaseAuth: {
      async freshAccessToken() { return token || ""; }
    },
    GDGuestIdentity: {
      getOrCreateGuestId() { return GUEST; }
    },
    async fetch(url, options) {
      calls.push({ url: String(url), options: options || {} });
      return {
        ok: true,
        status: 200,
        async json() { return Object.assign({}, responseBody || { status: "none" }); }
      };
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: "app/js/course-package.js" });
  const body = await ctx.ClarityApp.fetchCoursePackage({
    courseId: "pupuke",
    courseName: "Pupuke",
    courseLat: -36.8,
    courseLng: 174.7
  });
  return { ctx, calls, body };
}

(async () => {
  {
    const { calls } = await runCase({ signedIn: false, token: "", responseBody: { status: "none" } });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes("guestId=" + encodeURIComponent(GUEST)),
      "a real guest must send the stable installation id that owns the one-map allowance");
    assert.ok(!calls[0].options.headers.Authorization, "a guest request has no bearer token");
  }

  {
    const { calls, body, ctx } = await runCase({ signedIn: true, token: "", responseBody: { status: "none" } });
    assert.strictEqual(calls.length, 1);
    assert.ok(!calls[0].url.includes("guestId="),
      "a signed-in session with a token-refresh problem must never spend the anonymous allowance");
    assert.strictEqual(body.triggerError, "account-verification-unavailable");
    assert.strictEqual(ctx.document.body.dataset.gdCoursePackageDetail, "account-verification-unavailable");
  }

  {
    const { body } = await runCase({
      signedIn: true,
      token: "",
      responseBody: { status: "full-map-ready", packageVersion: 3 }
    });
    assert.strictEqual(body.status, "full-map-ready");
    assert.ok(!body.triggerError,
      "a ready public package remains playable even if account verification is temporarily unavailable");
  }

  {
    const { calls } = await runCase({
      signedIn: true,
      token: "fresh-token",
      responseBody: { status: "none" }
    });
    assert.strictEqual(calls[0].options.headers.Authorization, "Bearer fresh-token");
    assert.ok(!calls[0].url.includes("guestId="), "verified users are always counted as users");
  }

  console.log("course package client identity passed");
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
