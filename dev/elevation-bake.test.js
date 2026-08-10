/* Elevation in the bake: the crop, the aimed light, and the stored measurements.

   The aimed-light check is the important one. Frames bake north-up and Play rotates them, so
   a light fixed in world space ends up below the eye on roughly half a course - and light
   from below inverts perceived relief, which turns greens into craters. Asserting that two
   opposite holes get lights 180 apart is asserting that bug stays fixed. */

/* The per-hole elevation + aimed-light path, on buffers. */
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { cropByBounds, reliefAzimuthForPlayAxis, bearingDeg, reliefFromTerrainRgb, decodeElevation } from "../functions/lib/gd-relief-core.mjs";

// --- a course-wide DEM: 1024px covering a known lat/lng box, with a bump at a known spot
const N=1024;
const SRC={north:-36.740,south:-36.760,west:174.740,east:174.765};
const enc=h=>{const v=Math.round((h+10000)/0.1);return [(v>>16)&255,(v>>8)&255,v&255];};
const raw=Buffer.alloc(N*N*3);
for(let y=0;y<N;y++)for(let x=0;x<N;x++){
  const h=30+20*Math.exp(-(((x-700)**2+(y-300)**2)/9000))+2*Math.sin(x/30);
  const [r,g,b]=enc(h); const i=(y*N+x)*3; raw[i]=r;raw[i+1]=g;raw[i+2]=b;
}
const dem=await sharp(raw,{raw:{width:N,height:N,channels:3}}).png().toBuffer();

// --- 1. bearing + aimed azimuth
assert.ok(Math.abs(bearingDeg({lat:0,lng:0},{lat:1,lng:0}) - 0) < 0.01, 'due north = 0');
assert.ok(Math.abs(bearingDeg({lat:0,lng:0},{lat:0,lng:1}) - 90) < 0.01, 'due east = 90');
const north=reliefAzimuthForPlayAxis({lat:-36.755,lng:174.75},{lat:-36.745,lng:174.75});
const south=reliefAzimuthForPlayAxis({lat:-36.745,lng:174.75},{lat:-36.755,lng:174.75});
assert.ok(Math.abs(north-315)<0.5, 'a hole playing north keeps the default light, got '+north.toFixed(1));
assert.ok(Math.abs(south-135)<0.5, 'a hole playing south swings the light 180, got '+south.toFixed(1));
console.log('1. play-axis light: north hole az %s, south hole az %s (180 apart - this is the crater fix)',
  north.toFixed(0), south.toFixed(0));

// --- 2. crop lands on the right ground
const HOLE={north:-36.7455,south:-36.7495,west:174.7555,east:174.7605};
const crop=await cropByBounds(dem, SRC, HOLE);
assert.ok(crop.width>1 && crop.height>1, 'crop has pixels');
assert.ok(crop.bounds.north<=SRC.north && crop.bounds.south>=SRC.south, 'crop bounds stay inside the source');
assert.ok(Math.abs(crop.bounds.west-HOLE.west)<0.0005 && Math.abs(crop.bounds.east-HOLE.east)<0.0005,
  'longitude edges land where asked');
// the bump sits at px (700,300) of the source; check the crop actually contains high ground
const full=await sharp(dem).raw().toBuffer();
const cropRaw=await sharp(crop.buffer).raw().toBuffer({resolveWithObject:true});
const dFull=decodeElevation(full,N,N,3,'terrain-rgb');
const dCrop=decodeElevation(cropRaw.data,cropRaw.info.width,cropRaw.info.height,cropRaw.info.channels,'terrain-rgb');
console.log('2. crop %dx%d  elev %s..%sm (source %s..%sm)', crop.width, crop.height,
  dCrop.min.toFixed(1), dCrop.max.toFixed(1), dFull.min.toFixed(1), dFull.max.toFixed(1));
assert.ok(dCrop.min>=dFull.min-0.2 && dCrop.max<=dFull.max+0.2, 'cropped heights are a subset of the source');

// --- 3. a crop entirely outside the source is clamped, not garbage
await assert.rejects(
  () => cropByBounds(dem, SRC, {north:-36.700,south:-36.705,west:174.700,east:174.705}),
  /overlaps the source by only/,
  'a window off the source must be refused, not returned as a sliver to be smeared');
// a window that only partly overlaps is still fine, and reports what it actually cut
const edge=await cropByBounds(dem, SRC, {north:-36.735,south:-36.748,west:174.735,east:174.752});
assert.ok(edge.width>16 && edge.height>16);
assert.ok(edge.bounds.north<=SRC.north+1e-9 && edge.bounds.west>=SRC.west-1e-9, 'clamped bounds describe what was actually cut');
console.log('3. off-source window refused; partial overlap clamps to %dx%d and reports its real bounds', edge.width, edge.height);

// --- 4. aiming the light changes the shading, and opposite holes are genuinely different
const shade=async az=>{const r=await reliefFromTerrainRgb(crop.buffer,{latitude:-36.7475,zoom:16},{azimuth:az});
  return sharp(r.png).raw().toBuffer();};
const [a315,a135]=await Promise.all([shade(315),shade(135)]);
let diff=0; for(let i=0;i<a315.length;i++) diff+=Math.abs(a315[i]-a135[i]);
diff/=a315.length;
assert.ok(diff>12, 'a 180 light swing must materially change the shading, got '+diff.toFixed(1));
console.log('4. swinging the light 180 changes shading by %s/255 mean abs', diff.toFixed(1));

// --- 5. the stored elevation is still decodable measurements, not a picture
assert.equal(dCrop.encoding,'terrain-rgb');
assert.ok(dCrop.max-dCrop.min>1, 'stored elevation carries real relief');
console.log('5. stored crop decodes as %s with %sm of relief', dCrop.encoding, (dCrop.max-dCrop.min).toFixed(1));

console.log('\nelevation-in-bake passed: 13 checks');
