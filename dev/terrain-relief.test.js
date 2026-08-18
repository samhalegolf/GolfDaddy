/* Relief: elevation in, shading out, and a slider that actually moves pixels.

   This file exists because the terrain slider shipped wired to nothing for months and the
   test suite said it was fine. The old test hand-fed a fake terrain capture straight into
   the shader, so it passed while the plan never asked for a capture, the source never
   offered one, and every rendered frame was byte-identical at strength 0 and 1.6. The rule
   this file follows: assert on the pixels that reach the player, and assert on the wiring
   in between - never on a stub standing in for it. */

import assert from 'node:assert/strict';
import sharp from 'sharp';
import { resolveEndpoints, IMAGERY_SOURCES, resolveImagerySource } from "../functions/lib/gd-imagery-sources.mjs";
import { planCourseCaptures } from "../functions/lib/gd-visual-plan-core.mjs";
import { renderHoleSurfaceMercator } from "../functions/lib/gd-visual-export-core.mjs";
import { reliefFromTerrainRgb, decodeElevation, heightsFromFloat32Tiff, terrainRgbPngFromHeights, fillNoData } from "../functions/lib/gd-relief-core.mjs";

const envs = { LINZ_BASEMAPS_API_KEY: 'TESTKEY' };

// ---- 1. LINZ now exposes a relief source, derived from its DEM
const linz = IMAGERY_SOURCES.find(e => e.key === 'linz-nz');
const r = resolveEndpoints(linz, envs);
assert.ok(r.terrain, 'LINZ must expose a relief source');
assert.equal(r.terrain.adapter, 'xyz');
assert.equal(r.terrain.encoding, 'terrain-rgb');
assert.ok(r.terrain.urlTemplate.includes('pipeline=terrain-rgb'),
  'relief tiles must keep pipeline=terrain-rgb or they return a picture, not heights');
assert.ok(r.terrain.urlTemplate.includes('TESTKEY'), 'key must be substituted');
assert.equal(r.terrain.computed, 'hillshade-from-dem');
console.log('1. LINZ relief source:', r.terrain.urlTemplate.replace('TESTKEY','<key>').slice(0,78)+'…');

// ---- 2. Float32 export DEMs (US 3DEP, AU ELVIS) are offered as relief too, tagged with
//         their encoding so the capture path decodes floats and transcodes to terrain-RGB
//         instead of feeding measurement bytes to an image compositor. This used to assert
//         the opposite - that these DEMs were refused - back when no float decode existed.
let arcgisChecked = 0;
for (const e of IMAGERY_SOURCES) {
  if (!e.dem || e.dem.adapter === 'xyz') continue;
  arcgisChecked++;
  const res = resolveEndpoints(e, { ...envs, USGS_API_KEY:'x', QLD_API_KEY:'x' });
  if (!res || !res.dem) continue;
  assert.ok(res.terrain, e.key + ' has a licensed float32 DEM - it must be offered as relief');
  assert.equal(res.terrain.encoding, 'float32', e.key + ' relief must carry the float32 tag or the fetcher decodes it as an image');
  assert.equal(res.terrain.computed, 'hillshade-from-dem');
}
console.log('2. offered', arcgisChecked, 'float32 DEM(s) as relief sources, tagged for transcode');
// A DEM shape with no decode at all must still be refused rather than guessed at.
assert.equal(
  (await import("../functions/lib/gd-imagery-sources.mjs")).resolveImagerySource(
    { south: -36.76, west: 174.74, north: -36.75, east: 174.76 },
    { sources: [{
      key: 'mystery-dem', label: 'Mystery DEM',
      region: { bbox: { south: -90, west: -180, north: 90, east: 180 } },
      license: { name: 'Open', storage: true, derivatives: true, redistribution: true },
      imagery: { adapter: 'xyz', urlTemplate: 'https://example.test/{z}/{x}/{y}.jpg' },
      dem: { adapter: 'xyz', urlTemplate: 'https://example.test/dem/{z}/{x}/{y}.png', encoding: 'lerc' },
      attribution: {}
    }], env: {} }
  ).terrain, null, 'an encoding without a decode must not be offered as relief');

// ---- 3. The planner now plans a terrain capture when given one
const pkg = { courseId:'test', courseName:'Test', holes:{ 1:{holeNumber:1} },
  objects:{ t1:{id:'t1',type:'tee',holeNumber:1,confirmed:true,position:{lat:-36.7525,lng:174.7515}},
            g1:{id:'g1',type:'green',holeNumber:1,confirmed:true,position:{lat:-36.7505,lng:174.7530}} } };
const withTerrain = planCourseCaptures(pkg, { terrainSource: r.terrain, source: r, maxOutputPx: 3072 });
const without    = planCourseCaptures(pkg, { terrainSource: null,      source: r, maxOutputPx: 3072 });
const tItem = withTerrain.find(i => i.role === 'terrain-reference');
assert.ok(tItem, 'terrain-reference must now be planned');
assert.ok(!without.find(i => i.role === 'terrain-reference'), 'and must stay unplanned without a source');
console.log('3. planned terrain-reference (%d items with, %d without)', withTerrain.length, without.length);

// ---- 4. Relief actually changes exported pixels, and strength scales it
const D = 512;
const enc = h => { const v = Math.round((h + 10000) / 0.1); return [(v>>16)&255,(v>>8)&255,v&255]; };
const demRaw = Buffer.alloc(D*D*3);
for (let y=0;y<D;y++) for (let x=0;x<D;x++){
  const dx=(x-256)*1.9, dy=(y-256)*1.9;
  const h = 40 + 9*Math.exp(-(dx*dx+dy*dy)/12000) + 1.4*Math.sin(dx/40);
  const [a,b,c]=enc(h); const i=(y*D+x)*3; demRaw[i]=a; demRaw[i+1]=b; demRaw[i+2]=c;
}
const demPng = await sharp(demRaw,{raw:{width:D,height:D,channels:3}}).png().toBuffer();
const relief = await reliefFromTerrainRgb(demPng, { latitude:-36.752, zoom:16 });
assert.equal(relief.encoding,'terrain-rgb');

const bounds = { north:-36.7495, west:174.7500, south:-36.7535, east:174.7545 };
const aerial = await sharp({ create:{ width:D, height:D, channels:3, background:{r:88,g:112,b:58} } }).jpeg().toBuffer();
const captures = [{ entry:{ role:'course-backdrop', bounds, width:D, height:D, stitchLayer:0, captureZoom:18 }, buffer:aerial }];
const terrain  = { entry:{ role:'terrain-reference', bounds, width:relief.width, height:relief.height }, buffer:relief.png };
const pins = { 1:{ tee:{lat:-36.7525,lng:174.7515}, green:{lat:-36.7505,lng:174.7530}, route:[], greenShape:[] } };

const render = async strength => {
  const out = await renderHoleSurfaceMercator({ pins, captures,
    terrain: strength > 0 ? terrain : null,
    settings:{ visualTools:{ holeTerrainStrength: strength } }, maxDim: D, quality: 95 });
  return sharp(out.jpeg).raw().toBuffer();
};
const [off, low, high] = await Promise.all([render(0), render(0.3), render(1.4)]);
const diff = (a,b) => { let s=0; for (let i=0;i<a.length;i++) s+=Math.abs(a[i]-b[i]); return s/a.length; };
const dLow = diff(off,low), dHigh = diff(off,high);
assert.ok(dLow > 1, 'relief at strength 0.3 must change pixels, got '+dLow.toFixed(2));
assert.ok(dHigh > dLow*1.3, `strength must scale relief: 0.3->${dLow.toFixed(2)} 1.4->${dHigh.toFixed(2)}`);
console.log('4. slider moves pixels: strength 0.3 -> %s, 1.4 -> %s (mean abs/255)', dLow.toFixed(2), dHigh.toFixed(2));

// ---- 5. Soft-light must both darken AND lighten. Multiply could only darken.
const mean = b => { let s=0; for (let i=0;i<b.length;i++) s+=b[i]; return s/b.length; };
let lighter=0, darker=0;
for (let i=0;i<off.length;i+=997){ if (high[i]>off[i]+2) lighter++; else if (high[i]<off[i]-2) darker++; }
assert.ok(lighter > 0, 'soft-light must produce highlights - multiply never did');
assert.ok(darker  > 0, 'and shadows');
console.log('5. highlights %d / shadows %d (multiply would give 0 highlights); mean %s -> %s',
  lighter, darker, mean(off).toFixed(1), mean(high).toFixed(1));

// ---- 6. A rendered picture must never decode as elevation.
//         This is the whole reason pipeline=terrain-rgb is pinned in the DEM urlTemplate:
//         drop it and LINZ returns its own hillshade rendering, which would otherwise be
//         read as heights and shaded into confident nonsense.
const picture = Buffer.alloc(256*256*3);
for (let i=0;i<picture.length;i++) picture[i] = 110 + ((i*13) % 60);
assert.throws(() => decodeElevation(picture, 256, 256, 3, 'terrain-rgb'), /decode failed/,
  'greys from a rendered hillshade must be refused, not shaded');
console.log('6. a rendered picture is refused as elevation');

// ---- 7. Exaggeration is monotonic - the drawing knob has to behave like one.
const spread = async e => {
  const x = await reliefFromTerrainRgb(demPng, { latitude:-36.752, zoom:16 }, { exaggeration:e });
  const b = await sharp(x.png).raw().toBuffer();
  const m = b.reduce((a,c)=>a+c,0)/b.length;
  return Math.sqrt(b.reduce((a,c)=>a+(c-m)**2,0)/b.length);
};
const [e2,e5,e9] = await Promise.all([spread(2), spread(5), spread(9)]);
assert.ok(e2 < e5 && e5 < e9, `exaggeration must deepen relief: ${e2.toFixed(1)} ${e5.toFixed(1)} ${e9.toFixed(1)}`);
console.log('7. exaggeration 2x/5x/9x -> sd %s / %s / %s', e2.toFixed(1), e5.toFixed(1), e9.toFixed(1));

// ---- 8. The float32 leg: a 3DEP-shaped GeoTIFF decodes to the metres it carries.
//         Fixture shape documented in dev/float32-tiff-fixture.mjs.
const { float32Tiff } = await import('./float32-tiff-fixture.mjs');
const FW = 128, FH = 96;
const truth = new Float32Array(FW * FH);
for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
  truth[y * FW + x] = 312 + 7 * Math.exp(-((x - 64) ** 2 + (y - 48) ** 2) / 900) + 0.8 * Math.sin(x / 9);
}
const dec = await heightsFromFloat32Tiff(float32Tiff(truth, FW, FH));
assert.equal(dec.width, FW); assert.equal(dec.height, FH);
let worst = 0;
for (let i = 0; i < truth.length; i++) worst = Math.max(worst, Math.abs(dec.heights[i] - truth[i]));
assert.ok(worst < 0.001, 'floats must survive the TIFF round-trip exactly, got err ' + worst);
console.log('8. float32 TIFF decode: %dx%d, max error %sm', FW, FH, worst.toExponential(1));

// ---- 9. Transcode to terrain-RGB round-trips within the encoding's own 0.1m step, so the
//         stored artefact for a US course is the same kind of thing a LINZ course stores.
const rgbPng = await terrainRgbPngFromHeights(Float32Array.from(truth), FW, FH);
const rgbRaw = await sharp(rgbPng).raw().toBuffer({ resolveWithObject: true });
const round = decodeElevation(rgbRaw.data, FW, FH, rgbRaw.info.channels, 'terrain-rgb');
assert.equal(round.encoding, 'terrain-rgb');
let packErr = 0;
for (let i = 0; i < truth.length; i++) packErr = Math.max(packErr, Math.abs(round.heights[i] - truth[i]));
assert.ok(packErr <= 0.05 + 1e-6, 'terrain-RGB packing must round-trip within its 0.1m step, got ' + packErr);
const usRelief = await reliefFromTerrainRgb(rgbPng, { latitude: 36.566, zoom: 17 });
assert.equal(usRelief.encoding, 'terrain-rgb');
assert.ok(Math.abs(usRelief.elevation.min - round.min) < 0.2 && Math.abs(usRelief.elevation.max - round.max) < 0.2,
  'shading a transcoded mosaic must see the same ground');
console.log('9. transcode round-trip err %sm; shaded %s..%sm', packErr.toFixed(3),
  usRelief.elevation.min.toFixed(1), usRelief.elevation.max.toFixed(1));

// ---- 10. NoData: 3DEP marks water with a huge negative sentinel. It must be filled with
//          real ground, not shaded as a kilometre-deep pit - and a block that is ALL sentinel
//          (an error page read as floats) must be refused outright.
const wet = Float32Array.from(truth);
for (let x = 0; x < FW; x++) wet[x] = -3.4028234663852886e38; // top row "ocean"
const wetRange = fillNoData(wet);
assert.ok(wetRange.min > 300 && wet[0] === wetRange.min, 'nodata must be filled with the lowest real ground');
await terrainRgbPngFromHeights(wet, FW, FH); // and must encode without throwing
assert.throws(() => fillNoData(new Float32Array(64).fill(-3.4e38)), /no plausible ground/,
  'a block with no real ground must be refused, not filled');
console.log('10. nodata filled at %sm; all-nodata refused', wetRange.min.toFixed(1));

console.log('\nterrain-relief passed: 14 checks + float32 path (8-10)');
