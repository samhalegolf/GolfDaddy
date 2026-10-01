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
 *   - load() refuses an answer for a different window, a failed layer, or an elevation with no
 *     size/range, and revokes anything it made when it does.
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
  await ok('only the admin, on Clarity 3D Mesh, with relief on and WebGL, gets the mode', () => {
    const on = { override: 'mesh', admin: true, relief: 2.5, webgl: true };
    assert.strictEqual(lt.wanted(on), true);
    assert.strictEqual(lt.wanted({ ...on, override: 'mapbox' }), false, 'plain Mapbox stays the flat live map');
    assert.strictEqual(lt.wanted({ ...on, override: 'auto' }), false);
    assert.strictEqual(lt.wanted({ ...on, admin: false }), false, 'never for a player');
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

  function fakeDeps(answers) {
    const made = [], revoked = [], asked = [];
    return {
      made, revoked, asked,
      deps: {
        fetch: (url, opts) => {
          asked.push({ url, auth: opts && opts.headers && opts.headers.Authorization });
          const layer = /layer=(\w+)/.exec(url)[1];
          return Promise.resolve(answers[layer](url));
        },
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
  const goodAerial = () => answer(200, { 'X-Window': echo, 'X-Live-Imagery': 'mapbox.satellite' });

  await ok('load: both layers, signed in, into the published shape with a readout', async () => {
    const f = fakeDeps({ aerial: goodAerial, elevation: goodElevation });
    const entry = await lt.load(WIN, f.deps);
    assert.strictEqual(f.asked.length, 2);
    f.asked.forEach((a) => {
      assert.strictEqual(a.auth, 'Bearer tok');
      assert.ok(a.url.includes('&z=' + WIN.z + '&x=' + WIN.x + '&y=' + WIN.y + '&w=' + WIN.w + '&h=' + WIN.h));
    });
    assert.strictEqual(entry.asset.live, true);
    assert.strictEqual(entry.asset.url, 'blob:0');
    const m = entry.asset.playSurface;
    assert.strictEqual(m.liveTerrain, true);
    assert.deepStrictEqual(m.outputDimensions, { width: WIN.w, height: WIN.h });
    assert.strictEqual(m.elevation.url, 'blob:1');
    assert.deepStrictEqual(m.elevation.elevationRange, { min: 20.5, max: 61 });
    assert.deepStrictEqual(entry.urls, ['blob:0', 'blob:1']);
    assert.strictEqual(entry.debug.elevation, 'linz-nz');
    assert.strictEqual(entry.debug.elevationCredit, 'LINZ CC BY');
    const label = lt.debugLabel(Object.assign(entry.debug, { rebuild: 'hole change', loadMs: 412 }), 2.5);
    ['3D mesh', 'Mapbox z' + WIN.z, 'DEM linz-nz z17 300x400', '2.5x', 'hole change', '412ms'].forEach((bit) =>
      assert.ok(label.includes(bit), label + ' has ' + bit));
    lt.release(entry, f.deps.revokeObjectURL);
    assert.deepStrictEqual(f.revoked, ['blob:0', 'blob:1'], 'release revokes both');
  });

  await ok('load: an answer for another window is refused, and nothing is left behind', async () => {
    const f = fakeDeps({ aerial: goodAerial, elevation: () => answer(200, { 'X-Window': '18/1/1/1/1' }) });
    await assert.rejects(lt.load(WIN, f.deps), /different window/);
    assert.strictEqual(f.made.length, 0);
  });

  await ok('load: a failed elevation is a reason, not a flat mesh', async () => {
    const f = fakeDeps({ aerial: goodAerial, elevation: () => answer(502, {}, { error: 'no elevation for this window' }) });
    await assert.rejects(lt.load(WIN, f.deps), /elevation 502: no elevation/);
    assert.strictEqual(f.made.length, 0);
  });

  await ok('load: an elevation with no size or range is refused', async () => {
    const f = fakeDeps({ aerial: goodAerial, elevation: () => answer(200, { 'X-Window': echo, 'X-Elevation-Min': '1' }) });
    await assert.rejects(lt.load(WIN, f.deps), /size or range/);
  });

  await ok('load: a network failure is a reason too', async () => {
    const f = fakeDeps({ aerial: goodAerial, elevation: goodElevation });
    f.deps.fetch = () => Promise.reject(new Error('offline'));
    await assert.rejects(lt.load(WIN, f.deps), /request failed: offline/);
  });

  console.log('\nlive-terrain: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
