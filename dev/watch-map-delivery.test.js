#!/usr/bin/env node
"use strict";

/* Covers the phone half of Watch lite-map delivery: what gets turned into a
   manifest, what is refused, and what is re-sent versus skipped.

   The spatial reference below is a real one — the frame gd-watch-map-core.js
   bakes for Millbrook's 1st from its published tee and green — so the manifest
   this module hands the wrist is pinned against numbers the generator actually
   produces, not a hand-invented transform. The same file also re-derives it
   from the generator, so a change to either side fails here rather than
   silently putting the player in the wrong fairway. */

const assert = require("assert");
const path = require("path");

const delivery = require(path.join(__dirname, "..", "app", "js", "watch-map-delivery.js"));
const watchMapCore = require(path.join(__dirname, "..", "scripts", "gd-watch-map-core.js"));

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error }); }
}

const MILLBROOK_TEE = { lat: -44.9492751, lng: 168.8142384 };
const MILLBROOK_GREEN = { lat: -44.946232370000004, lng: 168.81902248500003 };

function millbrookFirst() {
  return watchMapCore.buildWatchHoleFrame(watchMapCore.WATCH_MAP_RECIPE_V1, {
    tee: MILLBROOK_TEE,
    green: MILLBROOK_GREEN,
    greenShape: null,
    fairways: [], bunkers: [], water: []
  });
}

function reportFor(frame, holeNumbers) {
  return {
    courseId: "millbrook-remarkables-18",
    status: "ready",
    watchPackageVersion: 1788278423353,
    holes: holeNumbers.map(n => ({
      holeNumber: n,
      path: "millbrook-remarkables-18/v1788278423353/h" + n + ".webp",
      width: frame.width,
      height: frame.height,
      format: "webp",
      bytes: 4700,
      spatialReference: frame.spatialReference
    }))
  };
}

function fakeEnvironment(report, options) {
  options = options || {};
  const calls = { manifests: [], assets: [], fetched: [] };
  const clock = { at: 1_000_000 };
  const plugin = {
    publishWatchMap: async manifest => { calls.manifests.push(manifest); },
    publishWatchMapAsset: async asset => { calls.assets.push(asset); },
    watchMapInventory: async () => options.inventory || null
  };
  const fetchImpl = async url => {
    calls.fetched.push(url);
    if (url.indexOf("/api/course-watch-maps") === 0) {
      return { ok: true, json: async () => report };
    }
    if (options.assetStatus === "fail") return { ok: false };
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  };
  const instance = delivery.createDelivery({
    plugin,
    fetch: fetchImpl,
    now: () => clock.at,
    toBase64: bytes => "b64:" + bytes.length
  });
  return { instance, calls, clock };
}

(async function run() {
  const frame = millbrookFirst();

  await (async () => {
    check("Millbrook's 1st still bakes the pinned frame", () => {
      assert.ok(frame.ok, "the frame should build from published tee/green");
      assert.strictEqual(frame.spatialReference.refZoom, 20);
      assert.strictEqual(frame.spatialReference.version, 1);
      const tee = watchMapCore.projectLatLngToImage(frame.spatialReference, MILLBROOK_TEE.lat, MILLBROOK_TEE.lng);
      const green = watchMapCore.projectLatLngToImage(frame.spatialReference, MILLBROOK_GREEN.lat, MILLBROOK_GREEN.lng);
      assert.ok(tee.y > green.y, "the tee must sit below the green in image space");
      assert.ok(Math.abs(tee.x - green.x) < 0.5, "tee and green share a column once the hole is rotated upright");
    });
  })();

  await (async () => {
    const { instance, calls } = fakeEnvironment(reportFor(frame, [1, 2, 3]));
    const result = await instance.deliver("millbrook-remarkables-18");
    check("a fresh course sends the manifest first, then every hole image", () => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(result.sent, 3);
      assert.strictEqual(calls.manifests.length, 1);
      const manifest = calls.manifests[0].manifest;
      assert.strictEqual(manifest.courseKey, "millbrook-remarkables-18");
      assert.strictEqual(manifest.version, 1788278423353);
      assert.deepStrictEqual(manifest.holes.map(h => h.asset), ["h1.webp", "h2.webp", "h3.webp"]);
      assert.deepStrictEqual(manifest.holes[0].spatialReference.transform, {
        a: frame.spatialReference.transform.a,
        b: frame.spatialReference.transform.b,
        tx: frame.spatialReference.transform.tx,
        ty: frame.spatialReference.transform.ty
      });
      assert.strictEqual(calls.assets.length, 3);
      assert.strictEqual(calls.assets[0].version, "1788278423353", "the version crosses the bridge as a string, never a rounded number");
      assert.strictEqual(calls.assets[0].base64, "b64:4");
    });
  })();

  await (async () => {
    const { instance, calls } = fakeEnvironment(reportFor(frame, [1, 2, 3]), {
      inventory: { inventory: { courseKey: "millbrook-remarkables-18", version: "1788278423353", holes: [1, 3] } }
    });
    const result = await instance.deliver("millbrook-remarkables-18");
    check("holes already on the wrist are not sent again", () => {
      assert.strictEqual(result.sent, 1);
      assert.strictEqual(result.skipped, 2);
      assert.deepStrictEqual(calls.assets.map(a => a.holeNumber), [2]);
    });
  })();

  await (async () => {
    const { instance, calls } = fakeEnvironment(reportFor(frame, [1, 2]), {
      inventory: { inventory: { courseKey: "millbrook-remarkables-18", version: "1788278329227", holes: [1, 2] } }
    });
    await instance.deliver("millbrook-remarkables-18");
    check("an older package version on the wrist is replaced, not merged", () => {
      assert.deepStrictEqual(calls.assets.map(a => a.holeNumber), [1, 2]);
    });
  })();

  await (async () => {
    const { instance, calls } = fakeEnvironment(reportFor(frame, [1, 2]), {
      inventory: { inventory: { courseKey: "millbrook-remarkables-18", version: "1788278423353", holes: [1, 2] } }
    });
    const result = await instance.deliver("millbrook-remarkables-18");
    check("a complete package costs no network fetches beyond the report", () => {
      assert.strictEqual(result.delivered, true);
      assert.strictEqual(result.sent, 0);
      assert.strictEqual(calls.manifests.length, 0);
      assert.strictEqual(calls.fetched.length, 1);
    });
  })();

  await (async () => {
    const { instance, calls } = fakeEnvironment(reportFor(frame, [1, 2, 3]));
    await instance.deliver("millbrook-remarkables-18");
    const first = calls.assets.length;
    await instance.deliver("millbrook-remarkables-18");
    check("a settled delivery is not repeated on every Scene", () => {
      assert.strictEqual(calls.assets.length, first, "the second call must not re-send anything");
      assert.strictEqual(calls.fetched.filter(u => u.indexOf("/api/course-watch-maps") === 0).length, 1);
    });
  })();

  await (async () => {
    const { instance, calls, clock } = fakeEnvironment(reportFor(frame, [1, 2]), { assetStatus: "fail" });
    const result = await instance.deliver("millbrook-remarkables-18");
    const afterFirst = calls.fetched.length;
    const immediate = await instance.deliver("millbrook-remarkables-18");
    const afterCooldownBlocked = calls.fetched.length;
    clock.at += 61_000;
    const later = await instance.deliver("millbrook-remarkables-18");
    const afterRetry = calls.fetched.length;
    check("an unreachable image is a gap to retry, never a thrown round", () => {
      assert.strictEqual(result.delivered, false);
      assert.strictEqual(result.failed, 2);
      assert.strictEqual(calls.assets.length, 0);
    });
    check("a failed delivery waits out a cooldown instead of retrying on every Scene", () => {
      assert.strictEqual(immediate.reason, "cooling-down");
      assert.strictEqual(afterCooldownBlocked, afterFirst, "the cooling-down call must not touch the network");
      assert.strictEqual(later.failed, 2, "after the cooldown the gap is retried");
      assert.ok(afterRetry > afterFirst, "after the cooldown the network is tried again");
    });
  })();

  await (async () => {
    const report = reportFor(frame, [1]);
    report.holes[0].spatialReference = Object.assign({}, frame.spatialReference, { transform: { a: 0, b: 0, tx: 1, ty: 1 } });
    const { instance } = fakeEnvironment(report);
    const result = await instance.deliver("millbrook-remarkables-18");
    check("a degenerate transform is dropped rather than drawn against", () => {
      assert.strictEqual(result.delivered, false);
      assert.strictEqual(result.reason, "no-package");
    });
  })();

  await (async () => {
    const report = reportFor(frame, [1]);
    report.holes[0].path = "millbrook-remarkables-18/v1/../../secrets.webp";
    const { instance } = fakeEnvironment(report);
    const result = await instance.deliver("millbrook-remarkables-18");
    check("an asset name outside the generator's vocabulary never becomes a path", () => {
      assert.strictEqual(result.delivered, false);
      assert.strictEqual(result.reason, "no-package");
    });
  })();

  await (async () => {
    const instance = delivery.createDelivery({ plugin: null, fetch: async () => { throw new Error("must not fetch"); } });
    const result = await instance.deliver("millbrook-remarkables-18");
    check("without a native bridge nothing is fetched at all", () => {
      assert.strictEqual(result.delivered, false);
      assert.strictEqual(result.reason, "no-native-bridge");
    });
  })();

  check("a report with no package version delivers nothing", () => {
    assert.strictEqual(delivery.__test.assetName("course/v1/h19.webp"), "h19.webp");
    assert.strictEqual(delivery.__test.assetName("course/v1/h0.webp"), null);
    assert.strictEqual(delivery.__test.assetName("course/v1/manifest.json"), null);
    assert.deepStrictEqual(delivery.__test.alreadyDelivered({ courseKey: "a", version: "2", holes: [4] }, "a", "2"), { 4: true });
    assert.deepStrictEqual(delivery.__test.alreadyDelivered({ courseKey: "a", version: "2", holes: [4] }, "a", "3"), {});
  });

  report();
})();

function report() {
  console.log("— Watch lite-map delivery —");
  let failed = 0;
  results.forEach(result => {
    if (result.ok) console.log("  PASS  " + result.name);
    else { failed += 1; console.log("  FAIL  " + result.name + "\n        " + (result.error && result.error.message)); }
  });
  console.log("");
  if (failed) { console.log(failed + " check(s) failed."); process.exit(1); }
  console.log(results.length + " Watch lite-map delivery checks passed.");
}
