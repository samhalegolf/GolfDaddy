/*
 * The hybrid Esri + Mapbox hole picture (app/js/live-hybrid.js).
 *
 * Pinned here:
 *   - the playing-area mask covers tee, route and green, stays inside the frame, is 1 inside the
 *     area and 0 beyond the feather, has no hard step, and widens with the feather;
 *   - Mapbox is asked only for tiles the mask touches - each once - and far fewer than the frame;
 *   - a neighbouring hole reuses the round's tiles and only fetches what it does not share;
 *   - Mapbox failing still gives an Esri surface; no Esri key makes Mapbox the whole frame;
 *     Esri failing is a rejection (the live map takes over);
 *   - colour correction is bounded, and needs enough shared samples to apply at all;
 *   - the composite is Mapbox inside, corrected Esri outside, and every debug view draws;
 *   - the same hole always gives the same mask (no dependence on GPS, aim or camera).
 *
 * Run: node dev/live-hybrid.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const hy = require(path.join(ROOT, 'app', 'js', 'live-hybrid.js'));
const lt = require(path.join(ROOT, 'app', 'js', 'live-terrain.js'));

/* Akarana hole 1, with a fairway and a bunker of its own and one belonging to nothing nearby. */
const H1 = {
  tee: { lat: -36.9133686, lng: 174.7409167 },
  green: { lat: -36.91669425625, lng: 174.7393568875 },
  route: [{ lat: -36.9150, lng: 174.7402 }],
  greenShape: [{ lat: -36.9165816, lng: 174.7393482 }, { lat: -36.9168245, lng: 174.7393724 }, { lat: -36.9167, lng: 174.73948 }]
};
const PKG_H1 = { holeNumber: 1, surfaces: {
  bunkers: [{ shape: [{ lat: -36.9160, lng: 174.7404 }, { lat: -36.9161, lng: 174.7406 }, { lat: -36.9162, lng: 174.7404 }] }],
  water: [{ shape: [{ lat: -36.9100, lng: 174.7500 }, { lat: -36.9101, lng: 174.7502 }, { lat: -36.9102, lng: 174.7500 }] }]
} };
const H2 = {
  tee: { lat: -36.9172, lng: 174.7398 },
  green: { lat: -36.9188, lng: 174.7432 },
  route: [], greenShape: []
};

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log('ok  - ' + name); }

function pxOf(win, p) {
  const scale = 256 * Math.pow(2, win.z), r = p.lat * Math.PI / 180;
  return {
    x: ((p.lng + 180) / 360) * scale - win.x,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale - win.y
  };
}

(async () => {
  const win = lt.frameWindow(H1);
  const geom = hy.holeGeometry(H1, PKG_H1);
  const field = hy.maskField(win, geom);

  await ok('hole geometry comes from the course record and package, nothing else', () => {
    assert.strictEqual(geom.rings.length, 2);
    assert.ok(geom.tee && geom.green && geom.route.length === 1 && geom.greenShape.length === 3);
    const lite = hy.holeGeometry(H1, { holeNumber: 1, geometry: { surfaces: { fairways: [{ shape: [[-36.915, 174.74], [-36.9151, 174.7402], [-36.9152, 174.74]] }] } } });
    assert.strictEqual(lite.rings.length, 1, 'full-package geometry and [lat,lng] pairs both read');
  });

  await ok('the mask covers tee, route and green at full strength', () => {
    [H1.tee, H1.green, H1.route[0], H1.greenShape[1]].forEach((p) => {
      const at = pxOf(win, p);
      assert.ok(at.x > 0 && at.y > 0 && at.x < win.w && at.y < win.h, 'point is on the frame');
      assert.strictEqual(hy.alphaAt(field, at.x, at.y), 1);
    });
    const bunker = pxOf(win, { lat: -36.9161, lng: 174.74050 });
    assert.strictEqual(hy.alphaAt(field, bunker.x, bunker.y), 1, 'a bunker by the line of play is premium ground');
  });

  await ok('the mask is the frame\'s, and empty in the corners', () => {
    assert.strictEqual(field.gw * field.cell >= win.w && field.gh * field.cell >= win.h, true);
    assert.strictEqual(field.alpha.length, field.gw * field.gh);
    [[1, 1], [win.w - 2, 1], [1, win.h - 2], [win.w - 2, win.h - 2]].forEach(([x, y]) =>
      assert.strictEqual(hy.alphaAt(field, x, y), 0, 'corner ' + x + ',' + y));
    assert.ok(field.framePct > 5 && field.framePct < 80, 'mask ' + field.framePct.toFixed(1) + '% of the frame');
    assert.ok(field.maskM2 > field.innerM2 && field.innerM2 > 0);
  });

  await ok('the feather runs 1 to 0 over its width with no hard step', () => {
    /* Walk sideways from the tee, square to the line of play. */
    const tee = pxOf(win, H1.tee), green = pxOf(win, H1.green);
    const len = Math.hypot(green.x - tee.x, green.y - tee.y);
    const nx = -(green.y - tee.y) / len, ny = (green.x - tee.x) / len;
    const mid = { x: (tee.x + green.x) / 2, y: (tee.y + green.y) / 2 };
    const mpp = field.metresPerPx;
    let prev = 1, worst = 0, seenBand = false;
    for (let m = 0; m <= 140; m += 1) {
      const a = hy.alphaAt(field, mid.x + nx * m / mpp, mid.y + ny * m / mpp);
      assert.ok(a <= prev + 1e-6, 'never rises walking out');
      worst = Math.max(worst, prev - a);
      if (a > 0 && a < 1) seenBand = true;
      prev = a;
    }
    assert.ok(seenBand, 'there is a transition band');
    assert.strictEqual(prev, 0, 'nothing past corridor + feather');
    assert.ok(worst < 0.06, 'no step bigger than 6% per metre: ' + worst.toFixed(3));
  });

  await ok('a wider feather reaches further', () => {
    const narrow = hy.maskField(win, geom, { featherM: 30 });
    const wide = hy.maskField(win, geom, { featherM: 80 });
    assert.ok(wide.maskM2 > narrow.maskM2 * 1.2, narrow.maskM2 + ' < ' + wide.maskM2);
    assert.strictEqual(Math.round(narrow.innerM2), Math.round(wide.innerM2), 'the full-strength area does not move');
  });

  await ok('the defaults keep Mapbox to the playing area: 30m corridor, 30m green, 40m feather', () => {
    assert.deepStrictEqual([hy.DEFAULTS.corridorM, hy.DEFAULTS.greenM, hy.DEFAULTS.featherM], [30, 30, 40]);
    assert.ok(field.framePct < 40, 'Mapbox mask ' + field.framePct.toFixed(1) + '% of the frame');
  });

  await ok('the same hole always gives the same mask', () => {
    const again = hy.maskField(lt.frameWindow(JSON.parse(JSON.stringify(H1))), hy.holeGeometry(JSON.parse(JSON.stringify(H1)), PKG_H1));
    assert.deepStrictEqual(Array.from(again.alpha), Array.from(field.alpha));
  });

  await ok('Mapbox is asked only for the tiles the mask touches, each once', () => {
    const all = hy.frameTiles(win), some = hy.maskTiles(field);
    const keys = some.map((t) => t.x + ',' + t.y);
    assert.strictEqual(new Set(keys).size, keys.length, 'no duplicates');
    const frameKeys = new Set(all.map((t) => t.x + ',' + t.y));
    keys.forEach((k) => assert.ok(frameKeys.has(k), 'inside the frame'));
    assert.ok(some.length < all.length * 0.8, some.length + ' of ' + all.length + ' frame tiles');
    /* Every lit pixel has its Mapbox tile. */
    const lit = new Set(keys);
    for (let y = 0; y < win.h; y += 7) for (let x = 0; x < win.w; x += 7) {
      if (hy.alphaAt(field, x + 0.5, y + 0.5) > 0) {
        assert.ok(lit.has(Math.floor((win.x + x) / 256) + ',' + Math.floor((win.y + y) / 256)), 'lit pixel ' + x + ',' + y + ' has a tile');
      }
    }
  });

  await ok('colour correction is bounded and needs real overlap', () => {
    const wild = { samples: 5000,
      esri: { median: [40, 60, 30], luma: 50, iqr: 10, saturation: 10 },
      mapbox: { median: [200, 200, 200], luma: 200, iqr: 90, saturation: 90 } };
    const c = hy.colourCorrection(wild);
    c.gain.forEach((g) => assert.ok(g >= 0.8 && g <= 1.25));
    assert.ok(c.contrast >= 0.85 && c.contrast <= 1.2 && c.saturation >= 0.85 && c.saturation <= 1.2);
    assert.strictEqual(c.applied, true);
    const few = hy.colourCorrection(Object.assign({}, wild, { samples: 50 }));
    assert.deepStrictEqual([few.applied, few.gain, few.contrast, few.saturation], [false, [1, 1, 1], 1, 1]);
    assert.strictEqual(hy.colourCorrection(null).applied, false);
  });

  /* Two flat providers: Esri a dull blue-green, Mapbox a brighter green. */
  function solid(w, h, rgb) {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { a[i * 4] = rgb[0]; a[i * 4 + 1] = rgb[1]; a[i * 4 + 2] = rgb[2]; a[i * 4 + 3] = 255; }
    return a;
  }
  const ESRI = [70, 95, 90], MAPBOX = [80, 120, 70];

  await ok('the overlap statistics pull Esri toward Mapbox', () => {
    const stats = hy.overlapStats(solid(win.w, win.h, ESRI), solid(win.w, win.h, MAPBOX), field);
    assert.ok(stats.samples > 400, stats.samples + ' samples');
    const c = hy.colourCorrection(stats);
    assert.ok(c.gain[1] > 1 && c.gain[2] < 1, 'more green, less blue: ' + c.gain.map((g) => g.toFixed(2)));
  });

  await ok('the composite is Mapbox inside and corrected Esri outside', () => {
    const esri = solid(win.w, win.h, ESRI), mapbox = solid(win.w, win.h, MAPBOX);
    const corr = hy.colourCorrection(hy.overlapStats(esri, mapbox, field));
    const out = hy.compose(esri, mapbox, field, corr, { view: 'composite' });
    const px = (p) => { const i = (Math.floor(p.y) * win.w + Math.floor(p.x)) * 4; return [out[i], out[i + 1], out[i + 2]]; };
    assert.deepStrictEqual(px(pxOf(win, H1.tee)), MAPBOX, 'tee is Mapbox');
    const corner = px({ x: 2, y: 2 });
    assert.notDeepStrictEqual(corner, ESRI, 'the corner is corrected Esri, not raw');
    assert.ok(Math.abs(corner[1] - MAPBOX[1]) < Math.abs(ESRI[1] - MAPBOX[1]), 'and closer to Mapbox');
  });

  await ok('every debug view draws, and they differ where they should', () => {
    const esri = solid(win.w, win.h, ESRI), mapbox = solid(win.w, win.h, MAPBOX);
    const corr = hy.colourCorrection(hy.overlapStats(esri, mapbox, field));
    const tee = pxOf(win, H1.tee), at = (Math.floor(tee.y) * win.w + Math.floor(tee.x)) * 4, corner = (2 * win.w + 2) * 4;
    const views = {};
    hy.VIEWS.forEach((v) => { views[v] = hy.compose(esri, mapbox, field, corr, { view: v }); });
    assert.deepStrictEqual(Array.from(views['esri-raw'].slice(corner, corner + 3)), ESRI);
    assert.deepStrictEqual(Array.from(views['mapbox-raw'].slice(corner, corner + 3)), [0, 0, 0], 'Mapbox raw is black where none was fetched');
    assert.deepStrictEqual(Array.from(views['mapbox-raw'].slice(at, at + 3)), MAPBOX);
    assert.ok(views.mask[at] > views.composite[at] + 50, 'mask view tints Mapbox ground');
    assert.notDeepStrictEqual(Array.from(views['esri-corrected'].slice(at, at + 3)), ESRI, 'corrected Esri is corrected even under Mapbox');
  });

  /* ---- build(): fetching, the round's cache, and the fallbacks ---- */

  function fakeDeps({ failMapbox = false, mapboxStatus = 503, failEsri = false, noEsri = false, session, budget } = {}) {
    const asked = [];
    return {
      asked,
      deps: {
        session: session || hy.createSession('akarana'),
        budget,
        tileUrl: (kind, z, x, y) => (kind === 'esri' && noEsri ? null : kind + ':' + z + '/' + x + '/' + y),
        fetch: (url) => {
          asked.push(url);
          const kind = url.split(':')[0];
          const fail = (kind === 'mapbox' && failMapbox) || (kind === 'esri' && failEsri);
          return Promise.resolve(fail ? { ok: false, status: kind === 'mapbox' ? mapboxStatus : 503 } : { ok: true, blob: () => Promise.resolve({ kind }) });
        },
        decode: (blob) => Promise.resolve(blob),
        canvas: (w, h) => {
          let kind = null;
          return {
            draw: (img) => { kind = img.kind; },
            read: () => solid(w, h, kind === 'mapbox' ? MAPBOX : ESRI),
            write: () => {},
            toBlob: () => Promise.resolve({ composite: true }),
            free: () => {}
          };
        }
      }
    };
  }

  await ok('build: Esri for the frame, Mapbox for the playing area, one picture out', async () => {
    const f = fakeDeps();
    const res = await hy.build(win, geom, f.deps);
    const esri = f.asked.filter((u) => u.startsWith('esri')), mapbox = f.asked.filter((u) => u.startsWith('mapbox'));
    assert.strictEqual(esri.length, hy.frameTiles(win).length);
    assert.strictEqual(mapbox.length, hy.maskTiles(field).length);
    assert.ok(mapbox.length < esri.length);
    assert.deepStrictEqual(res.blob, { composite: true });
    const d = res.debug;
    assert.strictEqual(d.context, 'esri');
    assert.strictEqual(d.mapbox.network, mapbox.length);
    assert.strictEqual(d.sessionMapbox, mapbox.length);
    assert.ok(d.colour.applied && d.maskPct > 0 && d.featherM === hy.DEFAULTS.featherM && d.composeMs >= 0);
    console.log('      hole 1: Esri ' + esri.length + ' tiles, Mapbox ' + mapbox.length + ' of ' + esri.length
      + ' (' + d.maskPct + '% of the frame masked)');
  });

  await ok('build: the next hole reuses the round\'s tiles and only fetches the new ones', async () => {
    const session = hy.createSession('akarana');
    const first = fakeDeps({ session });
    await hy.build(win, geom, first.deps);
    const win2 = lt.frameWindow(H2);
    const second = fakeDeps({ session });
    const res = await hy.build(win2, hy.holeGeometry(H2, null), second.deps);
    const want = hy.maskTiles(hy.maskField(win2, hy.holeGeometry(H2, null)));
    const firstSet = new Set(first.asked);
    const shared = want.filter((t) => firstSet.has('mapbox:' + t.z + '/' + t.x + '/' + t.y)).length;
    assert.ok(win2.z === win.z, 'same zoom, or nothing could be shared');
    assert.ok(shared > 0, 'the neighbouring holes overlap');
    assert.strictEqual(res.debug.mapbox.reused, shared);
    assert.strictEqual(res.debug.mapbox.network, want.length - shared);
    assert.strictEqual(second.asked.filter((u) => firstSet.has(u)).length, 0, 'nothing fetched twice');
    assert.strictEqual(session.network.mapbox, first.asked.filter((u) => u.startsWith('mapbox')).length + res.debug.mapbox.network);
    console.log('      hole 2: Mapbox ' + res.debug.mapbox.network + ' new + ' + shared + ' reused; Esri '
      + res.debug.esri.network + ' new + ' + res.debug.esri.reused + ' reused');
  });

  await ok('build: Mapbox failing still gives an Esri surface, and says why', async () => {
    const res = await hy.build(win, geom, fakeDeps({ failMapbox: true }).deps);
    assert.match(res.debug.mapboxFailed, /mapbox tile 503/);
    assert.strictEqual(res.debug.colour.applied, false);
  });

  await ok('build: a failed Mapbox tile is not cached, so the next try asks again', async () => {
    const session = hy.createSession('x');
    await hy.build(win, geom, fakeDeps({ failMapbox: true, session }).deps);
    await new Promise((r) => setTimeout(r, 0));
    const retry = fakeDeps({ session });
    const res = await hy.build(win, geom, retry.deps);
    assert.strictEqual(res.debug.mapbox.reused, 0);
    assert.ok(!res.debug.mapboxFailed);
  });

  function memoryBudget(limit, day = () => 'd1') {
    let saved = null;
    return hy.createBudget({ get: () => saved, set: (v) => { saved = JSON.parse(JSON.stringify(v)); } }, limit, day);
  }

  await ok('the daily budget counts Mapbox network tiles only, and starts again the next day', async () => {
    let today = 'd1';
    const budget = memoryBudget(1000, () => today);
    const session = hy.createSession('x');
    const f = fakeDeps({ session, budget });
    await hy.build(win, geom, f.deps);
    const mapbox = f.asked.filter((u) => u.startsWith('mapbox')).length;
    assert.strictEqual(budget.remaining(), 1000 - mapbox, 'Esri tiles are not counted');
    await hy.build(win, geom, fakeDeps({ session, budget }).deps);
    assert.strictEqual(budget.remaining(), 1000 - mapbox, 'cache hits are free');
    today = 'd2';
    assert.strictEqual(budget.remaining(), 1000);
  });

  await ok('build: over the daily Mapbox limit, the hole is Esri alone and Mapbox is never asked', async () => {
    const f = fakeDeps({ budget: memoryBudget(hy.maskTiles(field).length - 1) });
    const res = await hy.build(win, geom, f.deps);
    assert.strictEqual(f.asked.filter((u) => u.startsWith('mapbox')).length, 0);
    assert.strictEqual(f.asked.length, hy.frameTiles(win).length, 'the whole frame from Esri');
    assert.match(res.debug.mapboxSkipped, /daily Mapbox limit/);
    assert.strictEqual(res.debug.colour.applied, false);
    const label = lt.debugLabel(Object.assign(res.debug, { window: win }), 2.5, 'on');
    assert.ok(label.includes('Mapbox off (daily Mapbox limit reached)'), label);
  });

  await ok('build: a 503 costs one hole its Mapbox, a refusal (401/403/429) costs the round', async () => {
    const session = hy.createSession('x');
    await hy.build(win, geom, fakeDeps({ session, failMapbox: true }).deps);
    assert.strictEqual(session.mapboxOff, null, 'a plain failure is tried again next hole');
    await new Promise((r) => setTimeout(r, 0));
    await hy.build(win, geom, fakeDeps({ session, failMapbox: true, mapboxStatus: 429 }).deps);
    assert.match(session.mapboxOff, /429/);
    await new Promise((r) => setTimeout(r, 0));
    const next = fakeDeps({ session });
    const res = await hy.build(win, geom, next.deps);
    assert.strictEqual(next.asked.filter((u) => u.startsWith('mapbox')).length, 0, 'not asked again this round');
    assert.match(res.debug.mapboxSkipped, /refused \(429\)/);
  });

  await ok('build: no Esri and no Mapbox allowance is a rejection, for the live map', async () => {
    const f = fakeDeps({ noEsri: true, budget: memoryBudget(0) });
    await assert.rejects(hy.build(win, geom, f.deps), /Mapbox is off: daily Mapbox limit/);
    assert.strictEqual(f.asked.length, 0);
  });

  await ok('build: no Esri key makes Mapbox the whole frame', async () => {
    const f = fakeDeps({ noEsri: true });
    const res = await hy.build(win, geom, f.deps);
    assert.strictEqual(res.debug.context, 'mapbox');
    assert.strictEqual(f.asked.length, hy.frameTiles(win).length);
    assert.ok(f.asked.every((u) => u.startsWith('mapbox')));
  });

  await ok('build: Esri failing is a rejection, for the live map to take over', async () => {
    await assert.rejects(hy.build(win, geom, fakeDeps({ failEsri: true }).deps), /esri tile 503/);
  });

  await ok('the settings panel offers exactly the views the compositor draws', () => {
    const src = require('fs').readFileSync(path.join(ROOT, 'app', 'js', 'gps-settings.js'), 'utf8');
    const list = JSON.parse(/var HYBRID_VIEWS = (\[[^\]]+\])/.exec(src)[1]);
    assert.deepStrictEqual(list, hy.VIEWS);
  });

  console.log('\nlive-hybrid: ' + passed + ' passed');
})().catch((e) => { console.error(e); process.exit(1); });
