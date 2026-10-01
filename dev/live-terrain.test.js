/*
 * Clarity 3D Mesh, the browser half (app/js/live-terrain.js).
 *
 * Pinned here:
 *   - the mode is on only for the admin, with the map source on "mesh", relief not off and
 *     WebGL present - every other combination is the normal live map;
 *   - the frame window covers the whole hole with an apron, stays inside the size limit, and
 *     depends on the hole alone: GPS fixes and aim changes cannot rebuild it, a different hole
 *     does;
 *   - the metadata is the published playSurface shape, so the published projection works on
 *     it, and the terrain mesh's overlay lift works on it at the player's exaggeration (and is
 *     the identity with relief off);
 *   - load() hands the mesh the composite, drops an elevation for a different window or with no
 *     size/range (a flat picture, not a failure), and rejects only when there is no picture.
 *
 * Run: node dev/live-terrain.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const lt = require(path.join(ROOT, 'app', 'js', 'live-terrain.js'));
const surface = require(path.join(ROOT, 'app', 'js', 'play-surface.js'));

/* gd-terrain-mesh.js attaches to window; run it in a sandbox to reach makeDisplacer. */
const meshCtx = { window: {} };
vm.createContext(meshCtx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', 'js', 'gd-terrain-mesh.js'), 'utf8').replace(
  /typeof window !== "undefined" \? window : this/, 'window'), meshCtx);
const GDTerrainMesh = meshCtx.window.GDTerrainMesh;

const AKARANA_H1 = {
  tee: { lat: -36.9133686, lng: 174.7409167 },
  green: { lat: -36.91669425625, lng: 174.7393568875 },
  greenShape: [{ lat: -36.9165816, lng: 174.7393482 }, { lat: -36.9168245, lng: 174.7393724 }],
  route: []
};
const LONG_PAR5 = {
  tee: { lat: -36.9100, lng: 174.7400 },
  green: { lat: -36.9145, lng: 174.7440 },
  route: [{ lat: -36.9125, lng: 174.7405 }]
};

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('ok  - ' + name); }

(async () => {
  await ok('every signed-in player on auto, with relief on and WebGL, gets the mode', () => {
    const on = { override: 'auto', signedIn: true, relief: 2.5, webgl: true };
    assert.strictEqual(lt.wanted(on), true);
    assert.strictEqual(lt.wanted({ ...on, override: 'mapbox' }), false, 'forced Mapbox stays the flat live map');
    assert.strictEqual(lt.wanted({ ...on, override: 'esri' }), false, 'forced Esri stays the flat live map');
    assert.strictEqual(lt.wanted({ ...on, override: 'mesh' }), false, 'the retired override is not a way in');
    assert.strictEqual(lt.wanted({ ...on, signedIn: false }), false, 'signed out: the live map, no requests');
    assert.strictEqual(lt.wanted({ ...on, relief: 0 }), false, 'terrain off disables the mesh');
    assert.strictEqual(lt.wanted({ ...on, webgl: false }), false);
    assert.strictEqual(lt.wanted(null), false);
    [1, 2.5, 5].forEach((r) => assert.strictEqual(lt.wanted({ ...on, relief: r }), true));
  });

  await ok('the window covers the hole with an apron and keeps inside the size limit', () => {
    for (const hole of [AKARANA_H1, LONG_PAR5]) {
      const win = lt.frameWindow(hole);
      assert.ok(win, 'a window');
      assert.ok(Number.isInteger(win.z) && win.z >= 14 && win.z <= 18);
      assert.ok(win.w <= 2048 && win.h <= 2048 && win.w > 0 && win.h > 0);
      const meta = lt.surfaceMeta(win, { url: 'blob:x', width: 256, height: 256, min: 0, max: 10 });
      [hole.tee, hole.green].forEach((p) => {
        const px = surface.projectToSurface(meta, p.lat, p.lng);
        assert.ok(px, 'tee and green are on the frame');
        /* 90m of apron at least, in pixels at this zoom. */
        const mpp = lt.windowMetres(win).width / win.w;
        const edge = Math.min(px.x, px.y, win.w - px.x, win.h - px.y) * mpp;
        assert.ok(edge >= 85, 'apron ' + edge.toFixed(0) + 'm');
      });
    }
    assert.ok(lt.frameWindow(LONG_PAR5).z <= lt.frameWindow(AKARANA_H1).z, 'a longer hole never asks for a finer zoom');
  });

  await ok('the frame reaches past the green for the tilted lock view, without losing zoom', () => {
    for (const hole of [AKARANA_H1, LONG_PAR5]) {
      const win = lt.frameWindow(hole);
      assert.strictEqual(win.z, 18, 'still z18');
      const meta = lt.surfaceMeta(win, null);
      const mpp = lt.windowMetres(win).width / win.w;
      /* 150m on from the green, along tee -> green, is still on the frame. */
      const dLat = hole.green.lat - hole.tee.lat, dLng = hole.green.lng - hole.tee.lng;
      const lenM = Math.hypot(dLat * 111320, dLng * 111320 * Math.cos(hole.tee.lat * Math.PI / 180));
      const k = 150 / lenM;
      const beyond = { lat: hole.green.lat + dLat * k, lng: hole.green.lng + dLng * k };
      assert.ok(surface.projectToSurface(meta, beyond.lat, beyond.lng), 'ground 150m past the green is pictured');
      assert.ok(mpp < 0.6);
    }
  });

  await ok('no tee or green, no window', () => {
    assert.strictEqual(lt.frameWindow(null), null);
    assert.strictEqual(lt.frameWindow({ tee: AKARANA_H1.tee }), null);
    assert.strictEqual(lt.frameWindow({ tee: { lat: NaN, lng: 1 }, green: AKARANA_H1.green }), null);
  });

  await ok('the window is the hole\'s alone: same hole same key, new hole new key', () => {
    const a = lt.windowKey('akarana', 1, lt.frameWindow(AKARANA_H1));
    /* Nothing about the player or the aim is an input, so this is the whole of "a GPS fix
       does not rebuild": the same record in, the same key out. */
    const again = lt.windowKey('akarana', 1, lt.frameWindow(JSON.parse(JSON.stringify(AKARANA_H1))));
    assert.strictEqual(a, again);
    assert.notStrictEqual(a, lt.windowKey('akarana', 2, lt.frameWindow(AKARANA_H1)), 'another hole number');
    assert.notStrictEqual(a, lt.windowKey('akarana', 1, lt.frameWindow(LONG_PAR5)), 'another hole shape');
    assert.notStrictEqual(a, lt.windowKey('other-course', 1, lt.frameWindow(AKARANA_H1)), 'another course');
  });

  await ok('overlays ride the live mesh at the player\'s exaggeration, flat when it is off', () => {
    const win = lt.frameWindow(AKARANA_H1);
    /* The server's grid keeps the window's aspect (gd-live-terrain-core demPlan). */
    const demW = 256, demH = Math.round(256 * win.h / win.w);
    const meta = lt.surfaceMeta(win, { url: 'blob:e', width: demW, height: demH, min: 20, max: 60 });
    const metres = [meta.elevation.metresPerPixel * meta.elevation.width, meta.elevation.metresPerPixel * meta.elevation.height];
    const framePx = [meta.outputDimensions.width, meta.outputDimensions.height];
    /* A mound in the middle of the frame. */
    const heightAt = (u, v) => 20 + 40 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) * 20);
    const centre = { x: framePx[0] / 2, y: framePx[1] / 2 };
    const lifts = {};
    for (const exaggeration of [0, 1, 2.5, 5]) {
      const state = { tiltDeg: 30, frameRotationDeg: 0, exaggeration, seaLevel: meta.elevation.elevationRange.min };
      const d = GDTerrainMesh.makeDisplacer({ heightAt, framePx, metres, state });
      const lifted = d.lift(centre);
      lifts[exaggeration] = centre.y - lifted.y;
      const back = d.ground(lifted);
      assert.ok(Math.hypot(back.x - centre.x, back.y - centre.y) < 0.05, 'a tap grounds back to where it was drawn');
    }
    assert.strictEqual(lifts[0], 0, 'relief off: overlays stay on the flat plane');
    assert.ok(lifts[1] > 0 && Math.abs(lifts[2.5] / lifts[1] - 2.5) < 1e-6 && Math.abs(lifts[5] / lifts[1] - 5) < 1e-6,
      'the lift scales with the setting: ' + JSON.stringify(lifts));
    assert.ok(Math.abs(metres[0] / metres[1] - win.w / win.h) < 0.01, 'metres keep the frame\'s aspect');
  });

  /* The compositor is live-hybrid.js's job (dev/live-hybrid.test.js); here it is a stub, so
     these cases are about putting picture and elevation together. */
  const PICTURE_DEBUG = () => ({ context: 'esri', esri: { network: 24, reused: 0 }, mapbox: { network: 16, reused: 0 },
    maskPct: 38.3, sessionMapbox: 16, view: 'composite', metresPerPx: 0.46, composeMs: 120, featherM: 50 });
  function fakeDeps(answers, picture) {
    const made = [], revoked = [], asked = [];
    return {
      made, revoked, asked,
      deps: {
        fetch: (url, opts) => {
          asked.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
          const layer = /layer=(\w+)/.exec(url)[1];
          return Promise.resolve(answers[layer](url));
        },
        liveHybrid: { build: () => picture || Promise.resolve({ blob: { composite: true }, debug: PICTURE_DEBUG() }) },
        hybrid: {},
        apiUrl: (u) => u,
        token: () => Promise.resolve('tok'),
        createObjectURL: () => { const u = 'blob:' + made.length; made.push(u); return u; },
        revokeObjectURL: (u) => revoked.push(u)
      }
    };
  }
  function answer(status, headers, body) {
    return { ok: status === 200, status, headers: { get: (k) => (k in headers ? headers[k] : null) },
      blob: () => Promise.resolve({ size: 1 }), json: () => Promise.resolve(body || {}) };
  }
  const WIN = lt.frameWindow(AKARANA_H1);
  const echo = [WIN.z, WIN.x, WIN.y, WIN.w, WIN.h].join('/');
  const goodElevation = () => answer(200, { 'X-Window': echo, 'X-Elevation-Size': '300x400', 'X-Elevation-Min': '20.5',
    'X-Elevation-Max': '61.0', 'X-Elevation-Source': 'linz-nz', 'X-Elevation-Zoom': '17', 'X-Elevation-Credit': 'LINZ%20CC%20BY' });

  await ok('load: the composite and the elevation, signed in, in the published shape', async () => {
    const f = fakeDeps({ elevation: goodElevation });
    const entry = await lt.load(WIN, {}, f.deps, { view: 'composite' });
    assert.strictEqual(f.asked.length, 1, 'only the elevation comes from the server');
    assert.strictEqual(f.asked[0].auth, 'Bearer tok');
    assert.ok(f.asked[0].url.includes('layer=elevation&z=' + WIN.z + '&x=' + WIN.x + '&y=' + WIN.y + '&w=' + WIN.w + '&h=' + WIN.h));
    assert.strictEqual(entry.asset.live, true);
    assert.strictEqual(entry.asset.url, 'blob:0', 'the mesh is given the composite, not a provider image');
    const m = entry.asset.playSurface;
    assert.strictEqual(m.liveTerrain, true);
    assert.deepStrictEqual(m.outputDimensions, { width: WIN.w, height: WIN.h });
    assert.strictEqual(m.elevation.url, 'blob:1');
    assert.deepStrictEqual(m.elevation.elevationRange, { min: 20.5, max: 61 });
    assert.deepStrictEqual(entry.urls, ['blob:0', 'blob:1']);
    assert.strictEqual(entry.debug.elevation, 'linz-nz');
    assert.strictEqual(entry.debug.elevationCredit, 'LINZ CC BY');
    const label = lt.debugLabel(Object.assign(entry.debug, { rebuild: 'hole change', meshMs: 90 }), 2.5, 'on');
    ['3D mesh on', 'z' + WIN.z, 'Esri 24+0r', 'Mapbox 16+0r', '38.3% frame', 'DEM linz-nz 300x400', '2.5x',
      'hole change', 'img 120ms', 'mesh 90ms'].forEach((bit) => assert.ok(label.includes(bit), label + ' has ' + bit));
    lt.release(entry, f.deps.revokeObjectURL);
    assert.deepStrictEqual(f.revoked, ['blob:0', 'blob:1'], 'release revokes both');
  });

  await ok('load: no elevation is a flat picture, not a failure', async () => {
    const f = fakeDeps({ elevation: () => answer(502, {}, { error: 'no elevation for this window' }) });
    const entry = await lt.load(WIN, {}, f.deps);
    assert.strictEqual(entry.asset.playSurface.elevation, undefined, 'no elevation, so no mesh');
    assert.deepStrictEqual(entry.urls, ['blob:0']);
    assert.match(entry.debug.elevationFailed, /elevation 502: no elevation/);
    assert.match(lt.debugLabel(entry.debug, 2.5, 'off'), /DEM none \(elevation 502/);
  });

  await ok('load: an elevation for another window, or with no size, is dropped rather than trusted', async () => {
    for (const bad of [answer(200, { 'X-Window': '18/1/1/1/1' }), answer(200, { 'X-Window': echo, 'X-Elevation-Min': '1' })]) {
      const entry = await lt.load(WIN, {}, fakeDeps({ elevation: () => bad }).deps);
      assert.strictEqual(entry.asset.playSurface.elevation, undefined);
      assert.match(entry.debug.elevationFailed, /different window|size or range/);
    }
  });

  await ok('load: no picture is a rejection, and nothing is left behind', async () => {
    const f = fakeDeps({ elevation: goodElevation }, Promise.reject(new Error('esri tile 503')));
    await assert.rejects(lt.load(WIN, {}, f.deps), /esri tile 503/);
    assert.strictEqual(f.made.length, 0);
  });

  console.log('\nlive-terrain: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
