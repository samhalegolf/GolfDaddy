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

const calls={dem:0,aerial:0,noPipeline:0};
globalThis.fetch=async(url)=>{
  const u=String(url);
  if(u.includes('/rest/v1/course_maps')) return { ok:true, json:async()=>[{course_id:'pupuke',course_name:'Pupuke',
    objects_json:{ t1:{id:'t1',type:'tee',holeNumber:1,position:{lat:-36.7525,lng:174.7515}},
                   g1:{id:'g1',type:'green',holeNumber:1,position:{lat:-36.7505,lng:174.7530}} } }] };
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

console.log('\nrelief-preview passed: 12 checks   (%d aerial + %d dem tiles fetched)', calls.aerial, calls.dem);
