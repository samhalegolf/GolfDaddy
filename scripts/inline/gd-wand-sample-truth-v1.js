/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  document.getElementById('gdWandTruthBtn')?.remove();
  document.getElementById('gdWandSampleTruthPanel')?.remove();
  window.gdShowWandSampleTruth=function(){};
  return;
  function ensureTruthButton(){
    const panel=document.getElementById('gdWandPanel');
    if(!panel || document.getElementById('gdWandTruthBtn')) return;
    const btn=document.createElement('button');
    btn.id='gdWandTruthBtn';
    btn.textContent='Sample Check';
    btn.onclick=function(e){
      e.preventDefault();
      e.stopPropagation();
      gdShowWandSampleTruth();
      return false;
    };
    const actions=panel.querySelector('.gdWandActions');
    if(actions && actions.parentNode) actions.parentNode.insertBefore(btn, actions.nextSibling);
    else panel.appendChild(btn);
  }

  function ensureTruthPanel(){
    let panel=document.getElementById('gdWandSampleTruthPanel');
    if(panel) return panel;
    panel=document.createElement('div');
    panel.id='gdWandSampleTruthPanel';
    panel.className='hidden';
    panel.innerHTML='<div class="truthTop"><span>Wand Sample Source</span><button id="gdWandSampleTruthClose">Close</button></div><canvas id="gdWandSampleTruthCanvas" width="300" height="300"></canvas><div id="gdWandSampleTruthText">No sample yet.</div>';
    document.body.appendChild(panel);
    document.getElementById('gdWandSampleTruthClose').onclick=function(e){
      e.preventDefault();
      e.stopPropagation();
      panel.classList.add('hidden');
    };
    return panel;
  }

  function getPixel(ctx,x,y){
    try{
      const d=ctx.getImageData(Math.round(x),Math.round(y),1,1).data;
      return {r:d[0],g:d[1],b:d[2],a:d[3]};
    }catch(e){return null;}
  }

  window.gdShowWandSampleTruth=function(){
    const outPanel=ensureTruthPanel();
    outPanel.classList.remove('hidden');
    const outCanvas=document.getElementById('gdWandSampleTruthCanvas');
    const outCtx=outCanvas.getContext('2d',{willReadFrequently:true});
    const text=document.getElementById('gdWandSampleTruthText');

    try{
      if(typeof establishGreenFromBubble==='function') establishGreenFromBubble();
      if(!window.greenCentre && typeof greenCentre!=='undefined') window.greenCentre=greenCentre;

      const centre=(typeof greenCentre!=='undefined' && greenCentre) ? greenCentre : null;
      if(!centre){
        text.textContent='No green centre yet. Lock/tap a green first.';
        return;
      }

      const built=typeof tryBuildMapCanvas==='function' ? tryBuildMapCanvas() : null;
      if(!built || !built.canvas || !built.ctx){
        text.textContent='Could not build readable map canvas. Pixel source blocked or missing.';
        return;
      }

      const seed=built.seed
        ? {x:Math.max(2,Math.min(built.canvas.width-3,Number(built.seed.x))),y:Math.max(2,Math.min(built.canvas.height-3,Number(built.seed.y)))}
        : (()=>{const centrePoint=map.latLngToContainerPoint(centre);return {x:Math.max(2,Math.min(built.canvas.width-3,centrePoint.x)),y:Math.max(2,Math.min(built.canvas.height-3,centrePoint.y))};})();

      const cropSize=300;
      const half=cropSize/2;
      outCanvas.width=cropSize;
      outCanvas.height=cropSize;
      outCtx.clearRect(0,0,cropSize,cropSize);
      outCtx.imageSmoothingEnabled=false;
      outCtx.drawImage(built.canvas, seed.x-half, seed.y-half, cropSize, cropSize, 0, 0, cropSize, cropSize);

      // Crosshair and rough metre rings. This is drawn only on the preview canvas, never into the scan.
      outCtx.save();
      outCtx.strokeStyle='rgba(255,255,255,.95)';
      outCtx.lineWidth=1;
      outCtx.beginPath();
      outCtx.moveTo(half-16,half); outCtx.lineTo(half+16,half);
      outCtx.moveTo(half,half-16); outCtx.lineTo(half,half+16);
      outCtx.stroke();

      const mpp=(typeof getWandScaleLock==='function' ? getWandScaleLock().metersPerPixel : null) || 0.238;
      [5,10,15,20,25,30].forEach(m=>{
        const r=m/Math.max(0.05,mpp);
        if(r<half){
          outCtx.beginPath();
          outCtx.strokeStyle=m===10 || m===20 || m===30 ? 'rgba(31,211,109,.72)' : 'rgba(255,255,255,.28)';
          outCtx.arc(half,half,r,0,Math.PI*2);
          outCtx.stroke();
        }
      });
      outCtx.restore();

      const p0=getPixel(built.ctx,seed.x,seed.y);
      const p5=getPixel(built.ctx,seed.x+5/Math.max(0.05,mpp),seed.y);
      const p10=getPixel(built.ctx,seed.x+10/Math.max(0.05,mpp),seed.y);
      const p20=getPixel(built.ctx,seed.x+20/Math.max(0.05,mpp),seed.y);

      const mapCss=getComputedStyle(document.getElementById('map')).transform;
      text.textContent=[
        'This preview is the exact canvas the Wand samples.',
        'If you see labels/bubble/green graphics here, the Wand is sampling overlays.',
        'If the crosshair is not on the green centre, the coordinate frame is wrong.',
        '',
        'coordinateFrame: '+(built.coordinateFrame||'unknown'),
        'usefulPixels: '+String(built.useful),
        'attemptedTiles: '+String(built.attemptedTiles||'—'),
        'drawnTiles: '+(built.drawnTiles||0),
        'canvas: '+built.canvas.width+' x '+built.canvas.height,
        'seed: '+seed.x.toFixed(1)+', '+seed.y.toFixed(1),
        'mpp: '+mpp.toFixed(3),
        'mapCssTransform: '+(mapCss||'none'),
        'centre px: '+JSON.stringify(p0),
        '+5m east px: '+JSON.stringify(p5),
        '+10m east px: '+JSON.stringify(p10),
        '+20m east px: '+JSON.stringify(p20)
      ].join('\n');
    }catch(e){
      text.textContent='Sample check failed: '+(e && e.message ? e.message : e);
    }
  };

  function install(){
    ensureTruthButton();
    ensureTruthPanel();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);
})();
