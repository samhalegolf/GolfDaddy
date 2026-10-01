/* The live map's relief tiles, exercised with stubbed DEM tiles - no network, no key.

   What matters about a tile layer is mostly what happens at its edges: two neighbouring tiles
   must agree along the line they share, or the shading draws the tile grid over the hole.
   The rest is the contract the map relies on: flat ground is the bake's flat grey, the light
   follows az, a missing DEM tile is neutral rather than a cliff, and the global DEM covers a
   course no national entry does. */
import assert from 'node:assert/strict';
import sharp from 'sharp';
process.env.LINZ_BASEMAPS_API_KEY='TESTKEY';

const TILE=256;
const encRgb=h=>{const v=Math.round((h+10000)/0.1);return [(v>>16)&255,(v>>8)&255,v&255];};
const encTerrarium=h=>{const v=h+32768;return [Math.floor(v/256)&255,Math.floor(v)&255,Math.round((v%1)*256)&255];};
let flat=false;
/* A mound on a gentle swell, in world-mercator units so every zoom and every source agrees. */
function ground(wx,wy){
  if(flat) return 40;
  const dx=(wx-0.9854223)*3.2e7, dy=(wy-0.6099068)*3.2e7;
  return 45+10*Math.exp(-(dx*dx+dy*dy)/9000)+1.5*Math.sin(dx/38)+2*Math.sin(wx*4e5)+2*Math.cos(wy*5e5);
}
async function demTile(z,x,y,enc){
  const b=Buffer.alloc(TILE*TILE*3), S=TILE*2**z;
  for(let py=0;py<TILE;py++)for(let px=0;px<TILE;px++){
    const [r,g,bb]=enc(ground((x*TILE+px+0.5)/S,(y*TILE+py+0.5)/S));
    const i=(py*TILE+px)*3; b[i]=r;b[i+1]=g;b[i+2]=bb;
  }
  return sharp(b,{raw:{width:TILE,height:TILE,channels:3}}).png().toBuffer();
}
const calls={linz:0,terrarium:0,noPipeline:0};
let dropDem=null;
globalThis.fetch=async(url)=>{
  const u=String(url);
  const m=u.match(/\/(\d+)\/(\d+)\/(\d+)\.(png|webp)/);
  if(!m) return {ok:false};
  const z=+m[1],x=+m[2],y=+m[3];
  if(dropDem && dropDem(z,x,y)) return {ok:false};
  let buf;
  if(u.includes('elevation-tiles-prod/terrarium')){ calls.terrarium++; buf=await demTile(z,x,y,encTerrarium); }
  else if(u.includes('/elevation/')){
    if(!u.includes('pipeline=terrain-rgb')){calls.noPipeline++; return {ok:false};}
    calls.linz++; buf=await demTile(z,x,y,encRgb);
  } else return {ok:false};
  return {ok:true, arrayBuffer:async()=>buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)};
};

const { default: handler } = await import('../functions/relief-tile.mjs');
const call=q=>handler(new Request('https://x/api/relief-tile?'+q,{method:'GET'}));
const lonToX=(lng,z)=>Math.floor((lng+180)/360*2**z);
const latToY=(lat,z)=>{const s=Math.sin(lat*Math.PI/180);return Math.floor((0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*2**z);};
const pixels=async res=>{const {data,info}=await sharp(Buffer.from(await res.arrayBuffer())).greyscale().raw().toBuffer({resolveWithObject:true});return {data,w:info.width,h:info.height};};

/* Pupuke, NZ: the LINZ terrain-RGB path. */
const z=16, x=lonToX(174.7515,z), y=latToY(-36.7515,z);

// 1. a shaded tile
let res=await call(`z=${z}&x=${x}&y=${y}&az=315`);
assert.equal(res.status,200);
assert.equal(res.headers.get('Content-Type'),'image/png');
assert.equal(res.headers.get('X-Relief-Tile'),'shaded');
assert.match(res.headers.get('Cache-Control'),/immutable/,'a shaded tile is immutable and cached hard');
const A=await pixels(res);
assert.equal(A.w,256); assert.equal(A.h,256);
const mean=A.data.reduce((s,v)=>s+v,0)/A.data.length;
const sd=Math.sqrt(A.data.reduce((s,v)=>s+(v-mean)**2,0)/A.data.length);
assert.ok(sd>2,'a tile over a mound must have structure, sd='+sd.toFixed(2));
assert.equal(calls.noPipeline,0,'elevation must never be requested without pipeline=terrain-rgb');
console.log('1. shaded LINZ tile (sd %s)',sd.toFixed(1));

// 2. seams: the shared edge of two neighbours agrees as closely as two columns inside one tile
const B=await pixels(await call(`z=${z}&x=${x+1}&y=${y}&az=315`));
const col=(t,c)=>Array.from({length:256},(_,r)=>t.data[r*256+c]);
const diff=(p,q)=>p.reduce((s,v,i)=>s+Math.abs(v-q[i]),0)/p.length;
const seam=diff(col(A,255),col(B,0)), inside=diff(col(A,254),col(A,255));
assert.ok(seam<=inside+1.5,'the seam must be no rougher than the inside of a tile: seam '+seam.toFixed(2)+' vs inside '+inside.toFixed(2));
console.log('2. seam %s vs inside %s (grey levels per pixel)',seam.toFixed(2),inside.toFixed(2));

// 3. the light follows az
const lit=await pixels(await call(`z=${z}&x=${x}&y=${y}&az=135`));
assert.ok(diff(Array.from(A.data),Array.from(lit.data))>1,'az must move the light');
console.log('3. az moves the light');

// 4. flat ground is the bake's flat grey: sin(altitude) folded through the bake's opacity
flat=true;
const F=await pixels(await call(`z=${z}&x=${x}&y=${y+2}&az=315`));
flat=false;
const expected=Math.round((0.5+(Math.sin(42*Math.PI/180)-0.5)*0.54)*255);
assert.ok(F.data.every(v=>Math.abs(v-expected)<=1),'flat ground must shade to '+expected+', got '+F.data[0]);
console.log('4. flat ground = %d, the bake\'s flat grey',expected);

// 5. a missing DEM tile is a neutral tile, briefly cached - never a cliff
dropDem=(dz,dx,dy)=>dx%2===0;
res=await call(`z=${z}&x=${x+4}&y=${y}&az=315`);
dropDem=null;
assert.equal(res.headers.get('X-Relief-Tile'),'neutral');
assert.match(res.headers.get('Cache-Control'),/max-age=300/);
const N=await pixels(res);
assert.ok(N.data.every(v=>v===128),'neutral is mid-grey, which soft-light leaves untouched');
console.log('5. missing DEM -> neutral, cached 5 min');

// 6. outside every national region the global terrain tiles shade it (St Andrews, z13 DEM)
const sz=17, sx=lonToX(-2.8133,sz), sy=latToY(56.3433,sz);
const before=calls.terrarium;
res=await call(`z=${sz}&x=${sx}&y=${sy}&az=315`);
assert.equal(res.headers.get('X-Relief-Tile'),'shaded');
assert.ok(calls.terrarium>before,'the global DEM must be fetched');
const credit=await (await call('credit=1&lat=56.3433&lng=-2.8133')).json();
assert.match(credit.text,/Mapzen/,'and credited');
const nzCredit=await (await call('credit=1&lat=-36.7515&lng=174.7515')).json();
assert.ok(nzCredit.text && !/Mapzen/.test(nzCredit.text),'a national DEM is credited as itself: '+nzCredit.text);
console.log('6. global DEM fallback + credit: %s | NZ: %s',credit.text.slice(0,40)+'...',nzCredit.text.slice(0,40));

// 7. bad requests
for(const q of ['z=20&x=1&y=1','z=16&x=-1&y=0','z=16&x=1.5&y=0',`z=12&x=${2**12}&y=0`,'credit=1&lat=x&lng=1'])
  assert.equal((await call(q)).status,400,q);
console.log('7. out-of-range tiles and points -> 400');

console.log('\nrelief-tile passed (%d LINZ + %d terrarium DEM tiles fetched)',calls.linz,calls.terrarium);
