/* The terrain renderer's contract with painter.js, in a real WebGL context.

   painter.js treats the mesh as strictly optional - every failure leaves the flat frame up -
   so what has to hold is narrow and specific: create/render/dispose exist, dispose can be
   called twice, and the in-frame shear behaves. The shear invariant is the one worth having:
   with no tilt there is no height offset, so rotating the frame must change nothing, and with
   tilt on it must change something. That isolates the geometry from the lighting, which also
   reads exaggeration and would otherwise hide a broken shear.

   Needs playwright + a static server; run from the repo root:
     npx playwright install chromium   (once)
     node dev/terrain-mesh-contract.test.js
*/

import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.MESH_TEST_BASE || 'http://127.0.0.1:8731';
fs.writeFileSync('contract.html', `<!doctype html><html><body>
<canvas id="c" width="512" height="512"></canvas>
<script src="../app/js/gd-terrain-mesh.js"></script>
<script>
window.run=(async()=>{
  const out={};
  out.supported = GDTerrainMesh.supported();
  const load=s=>new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src=s;});
  const [aerial,elevation]=await Promise.all([load('./aerial.png'),load('./elevation.png')]);
  const c=document.getElementById('c');
  const v=GDTerrainMesh.create(c,{aerial,elevation,metres:[300,300],demSize:[1024,1024],imagePx:[512,512],seaLevel:-0.87});
  out.api = ['state','render','dispose'].every(k=>k in v);
  // untilted must be pixel-identical to a plain textured quad: zero shear, zero displacement
  v.state.tiltDeg=0; v.state.frameRotationDeg=0; v.state.exaggeration=2.5; v.render();
  out.flat = c.toDataURL().length;
  v.state.tiltDeg=32; v.render();
  out.tilted = c.toDataURL().length;
  out.tiltChangesPixels = out.flat !== out.tilted;
  // rotation must change where height goes
  v.state.frameRotationDeg=90; v.render();
  out.rotated = c.toDataURL().length;
  out.rotationChangesPixels = out.tilted !== out.rotated;
  // With no tilt the shear is zero, so there is nothing for the frame rotation to rotate:
  // rotating the frame must then change nothing at all. That isolates the shear maths from
  // the lighting, which also reads exaggeration and would otherwise mask it.
  v.state.tiltDeg=0; v.state.exaggeration=2.5;
  v.state.frameRotationDeg=0;   v.render(); const r0=c.toDataURL();
  v.state.frameRotationDeg=137; v.render(); const r1=c.toDataURL();
  out.rotationIsInertWithoutTilt = (r0===r1);
  // ...and with tilt on, it must NOT be inert.
  v.state.tiltDeg=32; v.state.frameRotationDeg=0;   v.render(); const t0=c.toDataURL();
  v.state.frameRotationDeg=137; v.render(); const t1=c.toDataURL();
  out.rotationMattersWithTilt = (t0!==t1);
  v.dispose();
  out.disposedCleanly = true;
  try { v.render(); out.renderAfterDispose='did not throw'; } catch(e){ out.renderAfterDispose='threw'; }
  v.dispose(); out.doubleDisposeSafe = true;
  return out;
})();
</script></body></html>`);
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p=await b.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(BASE + '/contract.html');
const r=await p.evaluate(()=>window.run);
await b.close();
console.log(JSON.stringify(r,null,1));
if(errs.length) console.log('PAGE ERRORS:',errs);
const must=['supported','api','tiltChangesPixels','rotationChangesPixels','rotationIsInertWithoutTilt','rotationMattersWithTilt','disposedCleanly','doubleDisposeSafe'];
const bad=must.filter(k=>!r[k]);
console.log(bad.length ? '\nFAILED: '+bad.join(', ') : '\nrenderer contract: all checks passed');
process.exit(bad.length?1:0);
