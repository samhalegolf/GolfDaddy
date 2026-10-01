/* Replays the 소피아그린CC (Sophia Green CC) mapper job through the real worker with Supabase
 * and Overpass stubbed at the fetch layer. The site has no OSM hole numbering: the only
 * geometry is the hand-drawn overlay in dev/fixtures/sophia-green-overlay.json, and the three
 * nines come from the club-site cards stored against the facility.
 *
 * course_maps is an in-memory table, so a second write to an id the run already used lands on
 * the first row exactly as PostgREST merge-duplicates would - which is how the live run lost a
 * nine. Returns { job, maps, writes } for the caller to assert on. */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "sophia-green-overlay.json"), "utf8"));

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function overlayFeatures() {
  return fixture.features.map(([id, kind, hole, points]) => ({
    id, kind, hole, points: points.map(([lat, lng]) => ({ lat, lng }))
  }));
}

function scorecardRows() {
  return fixture.cards.map(card => ({
    course_key: card.name.toLowerCase(),
    course_name: card.name,
    holes_json: card.holes.map(([hole, par, metres]) => ({ hole, par, metres, tees: {}, index: null })),
    source: "club-site",
    source_url: "https://sophiagreen.co.kr/swp/course",
    sources_json: []
  }));
}

function queryValue(rest, key) {
  const match = rest.match(new RegExp("[?&]" + key + "=eq\\.([^&]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function replaySophiaGreen(options = {}) {
  const pinnedId = fixture.courseId;
  const maps = new Map([[pinnedId, {
    course_id: pinnedId, course_name: fixture.courseName, course_lat: fixture.centre.lat, course_lng: fixture.centre.lng,
    country: "South Korea", country_code: "KR", region: "Yeoju-si", objects_json: {}, holes_json: {},
    ...(options.pinned || {})
  }]].concat((options.existingMaps || []).map(row => [row.course_id, row])));
  const job = { id: "job-sophia", course_id: pinnedId, kind: "automap", status: "queued", mapper_version: "v2" };
  const writes = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    url = String(url);
    const method = String(init.method || "GET").toUpperCase();
    if (url.includes("overpass")) return jsonResponse(200, { elements: [] });
    if (!url.startsWith("https://stub.supabase.co/")) return jsonResponse(404, {});
    const rest = url.split("/rest/v1/")[1] || "";
    const table = rest.split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    if (table === "course_mapper_jobs") {
      if (method === "GET") return jsonResponse(200, rest.includes("status=eq.queued") && job.status === "queued" ? [Object.assign({}, job)] : (queryValue(rest, "id") ? [Object.assign({}, job)] : []));
      if (method === "PATCH") {
        if (rest.includes("status=eq.queued") && job.status !== "queued") return jsonResponse(200, []);
        Object.assign(job, body);
        return jsonResponse(200, [Object.assign({}, job)]);
      }
      return jsonResponse(200, []);
    }
    if (table === "course_maps") {
      if (method === "GET") {
        const id = queryValue(rest, "course_id");
        const facility = queryValue(rest, "facility_key");
        const ref = queryValue(rest, "osm_course_ref");
        let rows = [...maps.values()];
        if (id != null) rows = rows.filter(row => row.course_id === id);
        if (facility != null) rows = rows.filter(row => row.facility_key === facility);
        if (ref != null) rows = rows.filter(row => row.osm_course_ref === ref);
        return jsonResponse(200, rows.map(row => Object.assign({}, row)));
      }
      if (method === "PATCH") {
        const id = queryValue(rest, "course_id");
        const row = maps.get(id);
        if (row) Object.assign(row, body);
        writes.push({ method, courseId: id, body });
        return jsonResponse(200, row ? [row] : []);
      }
      if (method === "POST") {
        (Array.isArray(body) ? body : [body]).forEach(row => {
          maps.set(row.course_id, Object.assign(maps.get(row.course_id) || {}, row));
          writes.push({ method, courseId: row.course_id, body: row });
        });
        return jsonResponse(201, Array.isArray(body) ? body : [body]);
      }
    }
    if (table === "course_scorecards") {
      if (method === "GET") return jsonResponse(200, queryValue(rest, "facility_key") === pinnedId ? scorecardRows() : []);
      return jsonResponse(201, []);
    }
    if (table === "course_map_overlays") {
      return jsonResponse(200, [{ features: overlayFeatures(), status: "ready" }]);
    }
    return jsonResponse(200, []);
  };
  const realEnv = Object.assign({}, process.env);
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub";
  try {
    const worker = await import(path.join(root, "functions", "course-mapper-worker-background.mjs"));
    await worker.default({ json: async () => ({ jobId: job.id }) });
  } finally {
    global.fetch = realFetch;
    process.env = realEnv;
  }
  return { job, maps, writes };
}

/* Metres from each hole's green to the next hole's tee, per published row - the number that
   says whether a nine is one walk round the ground or holes dealt from across the site. */
function greenToNextTeeHops(row) {
  const objects = Object.values(row.objects_json || {});
  const hole = n => (row.holes_json || {})[n] || {};
  const teeOf = n => {
    const tee = objects.find(object => object && object.type === "tee" && Number(object.holeNumber) === n);
    return tee && tee.position;
  };
  const numbers = Object.keys(row.holes_json || {}).map(Number).sort((a, b) => a - b);
  const hops = [];
  for (let i = 0; i < numbers.length - 1; i++) {
    const green = hole(numbers[i]).greenCenter;
    const tee = teeOf(numbers[i + 1]);
    hops.push(green && tee ? Math.round(metresBetween(green, tee)) : null);
  }
  return hops;
}

function metresBetween(a, b) {
  const rad = v => v * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

module.exports = { replaySophiaGreen, greenToNextTeeHops, fixture };
