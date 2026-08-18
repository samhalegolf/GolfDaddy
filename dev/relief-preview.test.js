/* The relief preview endpoint, exercised with stubbed tiles and a stubbed Supabase.

   Worth testing offline because the endpoint's failure modes are the interesting part: a
   preview that silently shades a rendered picture instead of elevation looks completely
   plausible, and the only thing standing between us and that is pipeline=terrain-rgb staying
   on the URL. Check 1 asserts we never once asked for elevation without it. */

/* Exercise the preview handler with stubbed tiles + Supabase - no network, no key. */
import assert from 'node:assert/strict';
import sharp from 'sharp';
process.env.SUPABASE_URL='https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY='stub';
process.env.LINZ_BASEMAPS_API_KEY='TESTKEY';

const TILE=256;
const enc=h=>{const v=Math.round((h+10000)/0.1);return [(v>>16)&255,(v>>8)&255,v&255];};
async function tile(kind,z,x,y){
  const b=Buffer.alloc(TILE*TILE*3);
  const S=TILE*2**z;
  for(let py=0;py<TILE;py++)for(let px=0;px<TILE;px++){
    const i=(py*TILE+px)*3;
    if(kind==='dem'){
      const wx=(x*TILE+px)/S, wy=(y*TILE+py)/S;
      const dx=(wx-0.9854223)*3.2e7, dy=(wy-0.6099068)*3.2e7;
      const h=45+10*Math.exp(-(dx*dx+dy*dy)/9000)+1.5*Math.sin(dx/38);
      const [r,g,bb]=enc(h); b[i]=r;b[i+1]=g;b[i+2]=bb;
    } else { const c=((px>>5)+(py>>5))&1; b[i]=c?92:80;b[i+1]=c?118:104;b[i+2]=58; }
  }
  return sharp(b,{raw:{width:TILE,height:TILE,channels:3}}).png().toBuffer();
}

/* Two stubbed courses: Pupuke exercises the NZ tiled path, "pebble" the US exportImage one. */
const COURSES={
  pupuke:{course_id:'pupuke',course_name:'Pupuke',
    objects_json:{ t1:{id:'t1',type:'tee',holeNumber:1,position:{lat:-36.7525,lng:174.7515}},
                   g1:{id:'g1',type:'green',holeNumber:1,position:{lat:-36.7505,lng:174.7530}} } },
  pebble:{course_id:'pebble',course_name:'Pebble Beach',
    objects_json:{ t1:{id:'t1',type:'tee',holeNumber:1,position:{lat:36.5680,lng:-121.9400}},
                   g1:{id:'g1',type:'green',holeNumber:1,position:{lat:36.5660,lng:-121.9380}} } }
};
const { float32Tiff } = await import('./float32-tiff-fixture.mjs');
const calls={dem:0,aerial:0,noPipeline:0,usDem:0,usAerial:0};
globalThis.fetch=async(url)=>{
  const u=String(url);
  if(u.includes('/rest/v1/course_maps')){
    const id=(u.match(/course_id=eq\.([a-z-]+)/)||[])[1];
    return { ok:true, json:async()=>COURSES[id]?[COURSES[id]]:[] };
  }
  /* US exportImage blocks: one request per layer, sized in the URL. The elevation answer is a
     float32 TIFF - measurements, exactly what 3DEP serves - so a preview that renders it had
     to transcode, not composite. */
  if(u.includes('nationalmap.gov')){
    const size=(u.match(/size=(\d+)%2C(\d+)/)||u.match(/size=(\d+),(\d+)/)||[]).slice(1).map(Number);
    if(size.length!==2) return {ok:false};
    const [W,H]=size;
    let buf;
    if(u.includes('elevation.nationalmap.gov')){
      if(!/format=tiff/.test(u)) return {ok:false};
      calls.usDem++;
      const heights=new Float32Array(W*H);
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const dx=x-W/2, dy=y-H/2;
        heights[y*W+x]=52+11*Math.exp(-(dx*dx+dy*dy)/(W*H/40))+1.2*Math.sin(x/17);
      }
      heights[0]=-3.4028234663852886e38; // one nodata corner - must be filled, not shaded
      buf=float32Tiff(heights,W,H);
    } else {
      calls.usAerial++;
      buf=await sharp({create:{width:W,height:H,channels:3,background:{r:96,g:120,b:60}}}).jpeg().toBuffer();
    }
    return {ok:true, arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)};
  }
  const m=u.match(/\/(\d+)\/(\d+)\/(\d+)\.(png|webp)/);
  if(!m) return {ok:false};
  const z=+m[1],x=+m[2],y=+m[3];
  const isDem=u.includes('/elevation/');
  if(isDem && !u.includes('pipeline=terrain-rgb')){calls.noPipeline++; return {ok:false};}
  if(isDem && z>17) return {ok:false};
  isDem?calls.dem++:calls.aerial++;
  const buf=await tile(isDem?'dem':'aerial',z,x,y);
  return {ok:true, arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)};
};

const { default: handler } = await import('../functions/relief-preview.mjs');
const call = q => handler(new Request('https://x/api/relief-preview?'+q, {method:'GET'}));

// 1. happy path
let res = await call('courseId=pupuke&hole=1&size=512');
assert.equal(res.status,200, 'expected 200, got '+res.status+' '+(res.status!==200?await res.text():''));
assert.equal(res.headers.get('Content-Type'),'image/jpeg');
console.log('1. 200 OK', res.headers.get('X-Relief-Zoom'), '|', res.headers.get('X-Relief-Elevation'), '|', res.headers.get('X-Relief-Shade'));
assert.equal(calls.noPipeline,0,'must never request elevation without pipeline=terrain-rgb');

// 2. the knobs actually change the image
const bytes = async q => Buffer.from(await (await call(q)).arrayBuffer());
const base = await bytes('courseId=pupuke&hole=1&size=512&strength=0.9&exaggeration=5');
const flat = await bytes('courseId=pupuke&hole=1&size=512&strength=0.9&exaggeration=1');
const off  = await bytes('courseId=pupuke&hole=1&size=512&strength=0');
const lit  = await bytes('courseId=pupuke&hole=1&size=512&strength=0.9&exaggeration=5&azimuth=135');
assert.ok(!base.equals(flat), 'exaggeration must change the picture');
assert.ok(!base.equals(off),  'strength must change the picture');
assert.ok(!base.equals(lit),  'azimuth must change the picture');
console.log('2. exaggeration / strength / azimuth all move pixels');

// 3. shade-only debug mode
res = await call('courseId=pupuke&hole=1&size=512&mode=shade');
assert.equal(res.status,200);
const g=await sharp(Buffer.from(await res.arrayBuffer())).stats();
assert.ok(g.channels[0].stdev>5,'shade view must have structure, sd='+g.channels[0].stdev.toFixed(1));
console.log('3. mode=shade returns the raw hillshade (sd %s)', g.channels[0].stdev.toFixed(1));

// 4. failure modes are explicit, not silent
assert.equal((await call('courseId=../etc&hole=1')).status, 400);
assert.equal((await call('courseId=pupuke&hole=17')).status, 404);
console.log('4. bad courseId -> 400, unmapped hole -> 404');

// 5. the US path: one exportImage request per layer, and the float32 elevation is transcoded
//    to terrain-RGB before shading - the whole 3DEP leg end to end, nodata included.
res = await call('courseId=pebble&hole=1&size=512');
assert.equal(res.status,200,'US preview must render, got '+res.status+' '+(res.status!==200?await res.text():''));
assert.equal(res.headers.get('X-Relief-Source'),'naip-us');
assert.equal(res.headers.get('X-Relief-Encoding'),'terrain-rgb','the shaded bytes must be the transcode, not raw floats');
const [usLo,usHi]=String(res.headers.get('X-Relief-Elevation')).split('..').map(parseFloat);
assert.ok(usLo>45&&usHi<70&&usHi>usLo+5,'elevation must be the fixture ground, not the nodata sentinel: '+usLo+'..'+usHi);
assert.equal(calls.usAerial,1,'imagery is one exportImage block, not a tile grid');
assert.equal(calls.usDem,1,'and so is elevation');
console.log('5. US 3DEP preview: %s | %s (1 aerial + 1 dem exportImage)',
  res.headers.get('X-Relief-Elevation'), res.headers.get('X-Relief-Zoom'));

console.log('\nrelief-preview passed: 18 checks   (%d aerial + %d dem tiles fetched)', calls.aerial, calls.dem);
