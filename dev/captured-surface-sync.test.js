const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");

function storage(initial = {}) {
  const data = Object.assign({}, initial);
  return {
    data,
    getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
    setItem(key, value) { data[key] = String(value); },
    removeItem(key) { delete data[key]; }
  };
}

function cloudScan() {
  return {
    client_scan_id: "cromwell-cloud-h1",
    course_key: "cromwell",
    course_name: "Cromwell Golf Club",
    hole_number: 1,
    source_type: "leaflet-tile-capture",
    status: { latest: true },
    interaction: { owner: "captured-surface" },
    projection: { type: "leaflet-pixel-origin", captureZoom: 19, originPx: { x: 10, y: 20 }, imageWidth: 800, imageHeight: 1100 },
    pins: {
      tee: { lat: -45.041, lng: 169.204 },
      green: { lat: -45.039, lng: 169.205 },
      route: [{ lat: -45.041, lng: 169.204 }, { lat: -45.040, lng: 169.2045 }, { lat: -45.039, lng: 169.205 }],
      greenShape: [{ lat: -45.0391, lng: 169.2049 }, { lat: -45.0391, lng: 169.2051 }, { lat: -45.0389, lng: 169.2051 }]
    },
    manifest: {
      key: "gd_captured_hole_frame_v19_cromwell:h1",
      courseKey: "cromwell",
      courseName: "Cromwell Golf Club",
      holeNumber: 1,
      captureZoom: 19,
      tileCount: 12,
      tiles: [],
      originPx: { x: 10, y: 20 },
      imageWidth: 800,
      imageHeight: 1100
    },
    created_at: "2026-07-14T21:33:15.000Z",
    updated_at: "2026-07-14T22:12:40.000Z"
  };
}

function loadClient(fetchImpl) {
  const localStorage = storage();
  const events = [];
  const win = {
    localStorage,
    document: { readyState: "complete", addEventListener() {} },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
    dispatchEvent(event) { events.push(event); },
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
    fetch: fetchImpl
  };
  win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "scripts", "gd-captured-surface-sync.js"), "utf8"), {
    window: win,
    document: win.document,
    CustomEvent: win.CustomEvent,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    fetch: win.fetch
  }, { filename: "gd-captured-surface-sync.js" });
  return { win, localStorage, events };
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function text(value, limit) {
  const input = String(value || "").trim();
  return input.length > limit ? input.slice(0, limit) : input;
}

function loadFunctionWithMocks(payment, alert) {
  const target = path.join(__dirname, "..", "functions", "captured-surface-sync.js");
  delete require.cache[require.resolve(target)];
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === "./payment-utils") return payment;
    if (request === "./alert-utils") return alert;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(target);
  } finally {
    Module._load = originalLoad;
  }
}

async function main() {
  let posted = null;
  const client = loadClient(async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ synced: true, scans: [cloudScan()] }) };
  });
  const result = await client.win.GolfDaddyCapturedSurfaceSync.pullCourse("cromwell", { reason: "test-pull" });
  assert.strictEqual(posted.url, "/api/captured-surface-sync", "client pull uses captured-surface endpoint");
  assert.strictEqual(posted.body.action, "pull", "client pull sends pull action");
  assert.strictEqual(posted.body.courseKey, "cromwell", "client pull scopes by course key");
  assert.strictEqual(result.imported.count, 1, "client imports pulled scan metadata");
  const registry = JSON.parse(client.localStorage.getItem("gd_captured_surface_scans_v1"));
  assert.strictEqual(registry.scans.length, 1, "client writes cloud scan into local registry");
  assert.strictEqual(client.localStorage.getItem("gd_captured_surface_active_v1_cromwell:h1"), "cromwell-cloud-h1", "client marks pulled scan active when no local frame is active");
  assert.strictEqual(client.win.GolfDaddyCapturedSurfaceSync.status().label, "Course map loaded", "client exposes truthful cloud-loaded status");

  const alerts = [];
  let fetchedPath = "";
  let mod = loadFunctionWithMocks({
    encodeFilter: encodeURIComponent,
    hasSupabase: () => true,
    json,
    supabaseFetch: async (requestPath) => {
      fetchedPath = requestPath;
      return [cloudScan()];
    },
    text
  }, {
    sendSystemAlert: async (input) => { alerts.push(input); return { sent: true }; }
  });
  let response = await mod.handler({ httpMethod: "POST", body: JSON.stringify({ action: "pull", courseKey: "cromwell" }) });
  assert.strictEqual(response.statusCode, 200, "function returns pulled scans");
  assert(fetchedPath.includes("course_key=eq.cromwell"), "function scopes Supabase pull by course key");
  assert.strictEqual(alerts.length, 0, "successful pull does not send warning email");

  mod = loadFunctionWithMocks({
    encodeFilter: encodeURIComponent,
    hasSupabase: () => true,
    json,
    supabaseFetch: async () => {
      const error = new Error("database unavailable");
      error.status = 503;
      throw error;
    },
    text
  }, {
    sendSystemAlert: async (input) => { alerts.push(input); return { sent: true }; }
  });
  response = await mod.handler({ httpMethod: "POST", body: JSON.stringify({ action: "pull", courseKey: "cromwell", holeNumber: 1 }) });
  assert.strictEqual(response.statusCode, 503, "function preserves failing pull status");
  const alert = alerts[alerts.length - 1];
  assert.strictEqual(alert.eventType, "captured_surface_pull_failed", "failing pull sends system alert");
  assert.strictEqual(alert.context.courseKey, "cromwell", "alert includes course key");
  assert.strictEqual(alert.context.holeNumber, 1, "alert includes requested hole");

  console.log("captured-surface-sync tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
