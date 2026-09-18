/* Studio > Course Database > Snapshots - seeing and downloading a course's imagery.
 *
 * Run: npm run test:course-snapshots
 *
 * The zip writer is the reason this suite exists. It emits a container format by hand, and
 * a wrong offset or a wrong CRC produces a file that downloads happily and only fails when
 * someone tries to open it - possibly weeks later, which is exactly when the images were
 * wanted. So the zip it produces is unpacked again here with a real unzip. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const checks = [];
function test(name, fn) { checks.push([name, fn]); }

/* The panel is a browser script. Loaded under a stub window with the Blob/TextEncoder it
   actually uses, which is enough for everything that is not DOM drawing. */
const chunksOf = new WeakMap();
class FakeBlob {
  constructor(parts, opts) {
    const flat = [];
    (parts || []).forEach(p => {
      if (p instanceof FakeBlob) chunksOf.get(p).forEach(b => flat.push(b));
      else flat.push(Buffer.from(p.buffer ? new Uint8Array(p.buffer, p.byteOffset, p.byteLength) : p));
    });
    chunksOf.set(this, flat);
    this.type = (opts && opts.type) || "";
    this.size = flat.reduce((n, b) => n + b.length, 0);
  }
  buffer() { return Buffer.concat(chunksOf.get(this)); }
}

const window = { TextEncoder, Blob: FakeBlob, Image: function () {}, document: { createElement: () => ({}) } };
vm.runInNewContext(
  fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-snapshots.js"), "utf8"),
  Object.assign(window, { window, TextEncoder, Blob: FakeBlob, URL: { createObjectURL: () => "", revokeObjectURL: () => {} }, fetch: () => Promise.reject(new Error("no network in tests")), setTimeout })
);
const api = window.__gdAdminCourseSnapshotsInternals;

test("frames become one image per hole, overview first", () => {
  const items = api.sortItems(api.normalizeFrames({
    overview: { path: "c/frames/r1/overview.jpg", width: 2000, height: 1400 },
    holes: [
      { holeNumber: 3, path: "c/frames/r1/h3.jpg", width: 2975, height: 1891 },
      { holeNumber: 1, path: "c/frames/r1/h1.jpg", width: 2975, height: 1891 }
    ]
  }));
  /* Array.from, not .map: the panel builds its arrays inside the vm realm, and
     deepStrictEqual compares prototypes - a realm-crossed Array fails against a plain one
     even when every element matches. */
  assert.deepStrictEqual(Array.from(items, i => i.label), ["Course overview", "Hole 1", "Hole 3"]);
  assert.strictEqual(items[1].hole, 1);
});

test("captures keep a hole's several images together, and name their role", () => {
  const items = api.sortItems(api.normalizeCaptures({
    captures: [
      { holeNumber: 2, role: "green-surround", path: "c/captures/g2.jpg", pathExport: "c/captures/3072/g2.jpg", width: 2048, height: 2048 },
      { holeNumber: null, role: "course-backdrop", path: "c/captures/bd.jpg", width: 2003, height: 1868 },
      { holeNumber: 2, role: "play-corridor", segmentIndex: 1, path: "c/captures/p2b.jpg", width: 2048, height: 1400 },
      { holeNumber: 2, role: "play-corridor", segmentIndex: 0, path: "c/captures/p2a.jpg", width: 2048, height: 1400 }
    ]
  }));
  assert.deepStrictEqual(Array.from(items, i => i.label), [
    "course-backdrop", "Hole 2 · green-surround", "Hole 2 · play-corridor", "Hole 2 · play-corridor"
  ]);
  assert.deepStrictEqual(Array.from(items.filter(i => i.segment != null), i => i.segment), [0, 1],
    "a hole's corridor segments must stay in capture order");
  /* The export rendition, not the full-size master - the master runs to 17 megapixels and
     a contact sheet that downloads fifty of them is not a contact sheet. */
  assert.strictEqual(items[1].path, "c/captures/3072/g2.jpg");
  assert.strictEqual(items[0].path, "c/captures/bd.jpg", "falls back to the master when there is no rendition");
});

test("filenames sort by hole and carry the role", () => {
  assert.strictEqual(api.memberName({ hole: 7, role: "hole frame", path: "x/h7.jpg", key: "h7" }), "h07.jpg");
  assert.strictEqual(api.memberName({ hole: 12, role: "play-corridor", segment: 1, path: "x/a.jpg", key: "c1" }), "h12-play-corridor-1.jpg");
  assert.strictEqual(api.memberName({ hole: null, role: "overview", path: "x/o.jpg", key: "overview" }), "overview-overview.jpg");
  assert.strictEqual(api.memberName({ hole: 3, role: "terrain", path: "x/t.png", key: "c9" }), "h03-terrain.png",
    "a png member must not be named .jpg");
  /* Zero padded so a file manager sorts h02 before h10. */
  assert.ok(api.memberName({ hole: 2, role: "hole frame", path: "x/h2.jpg", key: "h2" }) < api.memberName({ hole: 10, role: "hole frame", path: "x/h10.jpg", key: "h10" }));
});

test("the sheet lays out wide for a hole set and tight for a capture set", () => {
  const holes = Array.from({ length: 18 }, () => ({ width: 2975, height: 1891 }));
  const captures = Array.from({ length: 50 }, () => ({ width: 2048, height: 1400 }));
  const a = api.sheetLayout(holes), b = api.sheetLayout(captures);
  assert.strictEqual(a.cols, 3);
  assert.strictEqual(b.cols, 5);
  assert.ok(b.tileW < a.tileW, "fifty tiles at full width is a canvas nobody can open");
  /* Tile height follows the median aspect, so the common frame fills its box. */
  assert.strictEqual(a.tileH, Math.round(a.tileW / (2975 / 1891)));
});

test("a tall tile box is clamped, so mixed orientations cannot run the sheet away", () => {
  /* Real courses mix portrait and landscape holes. Before the clamp an 18-hole sheet came
     out 7044px tall; the tile box is now capped regardless of what the median says. */
  const portrait = Array.from({ length: 18 }, () => ({ width: 1200, height: 3000 }));
  const layout = api.sheetLayout(portrait);
  assert.strictEqual(layout.tileH, Math.round(layout.tileW * 1.35));
  assert.ok(layout.tileH < Math.round(layout.tileW / (1200 / 3000)),
    "the clamp must actually bite on an extreme aspect");
});

test("a square capture among wide ones does not distort the box", () => {
  const mixed = [{ width: 2000, height: 2000 }, { width: 2975, height: 1891 }, { width: 2975, height: 1891 }];
  const layout = api.sheetLayout(mixed);
  assert.strictEqual(layout.tileH, Math.round(layout.tileW / (2975 / 1891)),
    "the median wins - the odd square letterboxes inside the box instead of resizing it");
});

test("crc32 matches zlib's", () => {
  [Buffer.from(""), Buffer.from("hello"), Buffer.from([0, 255, 128, 7, 7, 7])].forEach(buf => {
    assert.strictEqual(api.crc32(new Uint8Array(buf)) >>> 0, zlib.crc32 ? zlib.crc32(buf) >>> 0 : api.crc32(new Uint8Array(buf)) >>> 0);
  });
  /* Known-good vector, so this still means something on a node without zlib.crc32. */
  assert.strictEqual(api.crc32(new TextEncoder().encode("123456789")) >>> 0, 0xCBF43926);
});

test("the zip it writes is a zip a real unzip can open", () => {
  const files = [
    { name: "h01.jpg", data: new Uint8Array(Buffer.from("first hole bytes")) },
    { name: "h02-play-corridor-0.jpg", data: new Uint8Array(Buffer.from("second hole bytes, a little longer")) },
    { name: "overview-overview.jpg", data: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]) }
  ];
  const blob = api.zipStore(files);
  assert.strictEqual(blob.type, "application/zip");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-snap-zip-"));
  const zipPath = path.join(dir, "images.zip");
  try {
    fs.writeFileSync(zipPath, blob.buffer());
    /* -t is the whole point: it verifies every member's CRC against its stored bytes, which
       is what catches a miscomputed checksum or a wrong local-header offset. */
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir], { stdio: "pipe" });
    files.forEach(file => {
      const out = fs.readFileSync(path.join(dir, file.name));
      assert.deepStrictEqual(new Uint8Array(out), file.data, file.name + " must round-trip byte for byte");
    });
    const listed = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n");
    assert.deepStrictEqual(listed.sort(), files.map(f => f.name).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the panel is read-only - it can look at a course but never change one", () => {
  const src = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-snapshots.js"), "utf8");
  assert.ok(!/method:\s*["'](POST|PATCH|PUT|DELETE)["']/i.test(src),
    "Snapshots must never write - looking at a course's imagery cannot be allowed to change it");
  ["course_maps", "course_visuals", "course-visual-jobs", "course-mapper-jobs"].forEach(name => {
    assert.ok(!src.includes(name), "must not reach for " + name + " - it reads the asset proxy and nothing else");
  });
});

test("the Course Database opens it, and the studio page loads it", () => {
  const db = fs.readFileSync(path.join(root, "scripts", "studio", "gd-admin-course-db.js"), "utf8");
  assert.ok(/gdAdminCourseDbShowSnapshots/.test(db), "the rail needs a Snapshots button");
  assert.ok(/gdAdminCourseDatabaseTab==="snapshots"/.test(db), "and a tab that renders it");
  assert.ok(/gdAdminCourseSnapshotsMarkup/.test(db), "delegating to the viewer, same as Watch Maps");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/data-gd-surface="studio"[^>]*gd-admin-course-snapshots\.js/.test(html),
    "the panel must be studio-only - it is an operator surface, not something the app ships");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of checks) {
    try { await fn(); console.log("  ok  " + name); }
    catch (error) { failed++; console.log("  FAIL  " + name + "\n        " + (error && error.message)); }
  }
  if (failed) { console.log("course-snapshots FAILED: " + failed + " of " + checks.length); process.exit(1); }
  console.log("course-snapshots passed: " + checks.length + " checks");
})();
