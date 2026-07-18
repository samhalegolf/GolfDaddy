/* ============================================================================
 * WAND BELT LAYERS — consolidated from 5 wand patch files (Phase A, 2026-07-19).
 * Sections in original relative load order, each an unchanged self-contained IIFE.
 * Locked Green Wand engine logic (package.json codex.doNotModify) is unchanged.
 * ============================================================================ */

/* ==== section: gd-inline-clarity-caddie-patch-wand-overlay-clean.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: Wand overlay clean v1
   Fix: Wand button must never reveal the course search picker over a locked GPS map.
   It opens only the in-GPS overlay and preserves current map/shot/lock state. */
(function(){
  'use strict';
  function safe(fn){ try{return fn();}catch(e){ console.warn('[GD wand overlay clean]', e); } }
  function hideCoursePicker(){ safe(function(){ var cs=document.getElementById('courseScreen'); if(cs) cs.classList.add('hidden'); }); }
  function ensureGpsSurfaceWithoutReset(){
    hideCoursePicker();
    safe(function(){ document.body.classList.add('shell-gps','gps-active'); document.body.classList.remove('shell-home'); });
    safe(function(){ if(typeof setShellLayer==='function') setShellLayer('gps'); });
    safe(function(){ if(typeof showShellChrome==='function') showShellChrome(true); });
    safe(function(){ if(typeof setDockActive==='function') setDockActive('gps'); });
    safe(function(){ var h=document.getElementById('shellHome'); if(h) h.classList.add('hidden'); });
    safe(function(){ document.querySelectorAll('.modulePanel.open,.panel.open').forEach(function(p){ p.classList.remove('open'); }); });
    safe(function(){ if(typeof map!=='undefined' && map && map.invalidateSize) setTimeout(function(){ map.invalidateSize(); },60); });
  }
  function setStatus(msg){ safe(function(){ if(typeof updateWandStatus==='function') updateWandStatus(msg); else { var s=document.getElementById('gdWandStatus'); if(s) s.textContent=msg; } }); }
  function openPanelOnly(){
    ensureGpsSurfaceWithoutReset();
    safe(function(){ greenActive=true; });
    safe(function(){ var panel=document.getElementById('gdWandPanel'); if(panel) panel.classList.remove('hidden'); });
    safe(function(){ if(typeof setWandMode==='function') setWandMode((typeof wandMode!=='undefined' && wandMode) ? wandMode : 'robustTonal', true); });
    safe(function(){
      if((typeof target!=='undefined' && target) || (typeof greenCentre!=='undefined' && greenCentre)) setStatus('Ready · scan or quick shape');
      else setStatus('Set/lock a green first, then scan. GPS state preserved.');
    });
    return false;
  }
  window.openGpsWand=function(evt){
    safe(function(){ if(evt && evt.preventDefault) evt.preventDefault(); if(evt && evt.stopPropagation) evt.stopPropagation(); });
    return openPanelOnly();
  };
  window.toggleGreenWand=function(evt){
    safe(function(){ if(evt && evt.preventDefault) evt.preventDefault(); if(evt && evt.stopPropagation) evt.stopPropagation(); });
    var panel=document.getElementById('gdWandPanel');
    var isHidden=!panel || panel.classList.contains('hidden') || (typeof greenActive!=='undefined' && !greenActive);
    if(isHidden) return openPanelOnly();
    safe(function(){ greenActive=false; });
    safe(function(){ if(panel) panel.classList.add('hidden'); });
    safe(function(){ if(typeof clearWandHandles==='function') clearWandHandles(); });
    return false;
  };
  window.closeWandPanel=function(){
    safe(function(){ greenActive=false; });
    safe(function(){ var panel=document.getElementById('gdWandPanel'); if(panel) panel.classList.add('hidden'); });
    safe(function(){ if(typeof clearWandHandles==='function') clearWandHandles(); });
    hideCoursePicker();
    return false;
  };
  // Guard against any old click handler bubbling into the search/course view after Wand opens.
  document.addEventListener('click', function(e){
    var t=e.target;
    if(!t || !t.closest) return;
    if(t.closest('#greenToolBtn,#dockGreen,.gdWandPanel')){
      setTimeout(hideCoursePicker,0);
      setTimeout(hideCoursePicker,80);
    }
  }, true);
})();

/* ==== section: gd-wand-diagnostics-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  document.getElementById('gdWandDiagBtn')?.remove();
  document.getElementById('gdWandDiagPanel')?.remove();
  window.collectWandDiagnostics=function(){return ''};
  window.showWandDiagnostics=function(){};
  return;
  function ensureDiagUi(){
    if(!document.getElementById('gdWandDiagBtn')){
      const btn=document.createElement('button');
      btn.id='gdWandDiagBtn';
      btn.textContent='Wand Debug';
      btn.onclick=function(e){e.stopPropagation();showWandDiagnostics();};
      document.body.appendChild(btn);
    }
    if(!document.getElementById('gdWandDiagPanel')){
      const p=document.createElement('div');
      p.id='gdWandDiagPanel';
      p.innerHTML='<div class="diagTop"><span>Green Wand diagnostics</span><button onclick="document.getElementById(\'gdWandDiagPanel\').style.display=\'none\'">Close</button></div><div id="gdWandDiagText">No scan yet.</div>';
      document.body.appendChild(p);
    }
  }
  function cssTransformOf(sel){
    const el=document.querySelector(sel);
    if(!el)return 'missing';
    const cs=getComputedStyle(el);
    return cs.transform && cs.transform!=='none' ? cs.transform : 'none';
  }
  function rectOf(sel){
    const el=document.querySelector(sel);
    if(!el)return null;
    const r=el.getBoundingClientRect();
    return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};
  }
  function safeLatLngToPt(ll){
    try{return map.latLngToContainerPoint(ll)}catch(e){return null}
  }
  window.collectWandDiagnostics=function(){
    const lines=[];
    const now=new Date().toISOString();
    lines.push('time: '+now);
    lines.push('lockedFrame: '+(typeof lockedFrame!=='undefined'?!!lockedFrame:'unknown'));
    lines.push('greenActive: '+(typeof greenActive!=='undefined'?!!greenActive:'unknown'));
    lines.push('wandMode: '+(typeof wandMode!=='undefined'?wandMode:'unknown'));
    lines.push('greenTolerance/sensitivity: '+(typeof greenTolerance!=='undefined'?Math.round((greenTolerance||0)*100):'unknown'));
    lines.push('zoom: '+(map&&map.getZoom?map.getZoom():'unknown'));
    lines.push('map size: '+JSON.stringify(map&&map.getSize?map.getSize():null));
    lines.push('map rect: '+JSON.stringify(rectOf('#map')));
    lines.push('map css transform: '+cssTransformOf('#map'));
    lines.push('leaflet map-pane transform: '+cssTransformOf('.leaflet-map-pane'));
    lines.push('tile-pane transform: '+cssTransformOf('.leaflet-tile-pane'));
    lines.push('marker-pane transform: '+cssTransformOf('.leaflet-marker-pane'));
    lines.push('overlay-pane transform: '+cssTransformOf('.leaflet-overlay-pane'));
    lines.push('tile count loaded: '+document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile-loaded').length);
    if(typeof wandScaleLock!=='undefined' && wandScaleLock){
      lines.push('scaleLock: '+JSON.stringify({mpp:+wandScaleLock.metersPerPixel.toFixed(4),zoom:wandScaleLock.zoom,centre:wandScaleLock.centre,viewport:wandScaleLock.viewport,reason:wandScaleLock.reason,ageMs:Date.now()-wandScaleLock.createdAt}));
    }else lines.push('scaleLock: none');
    if(typeof greenCentre!=='undefined' && greenCentre){
      const p=safeLatLngToPt(greenCentre);
      lines.push('greenCentre latlng: '+JSON.stringify({lat:+greenCentre.lat.toFixed(7),lng:+greenCentre.lng.toFixed(7)}));
      lines.push('greenCentre containerPoint: '+JSON.stringify(p?{x:+p.x.toFixed(1),y:+p.y.toFixed(1)}:null));
    }else lines.push('greenCentre: none');
    if(typeof target!=='undefined' && target){
      const p=safeLatLngToPt(target);
      lines.push('target containerPoint: '+JSON.stringify(p?{x:+p.x.toFixed(1),y:+p.y.toFixed(1)}:null));
    }
    if(typeof lastWandResult!=='undefined' && lastWandResult){
      lines.push('lastWandResult meta: '+JSON.stringify({source:lastWandResult.source,mode:lastWandResult.modeUsed,label:lastWandResult.label,confidence:lastWandResult.confidence,metersPerPixel:lastWandResult.metersPerPixel,baseRadiusMeters:lastWandResult.baseRadiusMeters,clusterPull:lastWandResult.clusterPull}));
      lines.push('last metrics: '+JSON.stringify(lastWandResult.metrics||{}));
      lines.push('debugCounts: '+JSON.stringify(lastWandResult.debugCounts||{}));
      if(lastWandResult.boundaryPoints && greenCentre){
        const pts=lastWandResult.boundaryPoints.map(p=>L.latLng(p.lat,p.lng));
        const cps=pts.map(safeLatLngToPt).filter(Boolean);
        if(cps.length){
          const cp=safeLatLngToPt(greenCentre);
          const cx=cps.reduce((s,p)=>s+p.x,0)/cps.length;
          const cy=cps.reduce((s,p)=>s+p.y,0)/cps.length;
          const dx=cx-(cp?cp.x:cx), dy=cy-(cp?cp.y:cy);
          const radii=cps.map(p=>Math.hypot(p.x-(cp?cp.x:cx),p.y-(cp?cp.y:cy)));
          const avg=radii.reduce((a,b)=>a+b,0)/radii.length;
          const q={right:[],left:[],up:[],down:[]};
          cps.forEach((p,i)=>{const rx=p.x-(cp?cp.x:cx), ry=p.y-(cp?cp.y:cy), rr=radii[i]; if(rx>0)q.right.push(rr); else q.left.push(rr); if(ry>0)q.down.push(rr); else q.up.push(rr);});
          const avgA=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(1):null;
          lines.push('boundary centroid delta px: '+JSON.stringify({dx:+dx.toFixed(1),dy:+dy.toFixed(1),note:'positive dx = visual/right bias'}));
          lines.push('boundary radius px: '+JSON.stringify({avg:+avg.toFixed(1),min:+Math.min(...radii).toFixed(1),max:+Math.max(...radii).toFixed(1)}));
          lines.push('quadrant avg radius px: '+JSON.stringify({right:avgA(q.right),left:avgA(q.left),up:avgA(q.up),down:avgA(q.down),rightMinusLeft:q.right.length&&q.left.length?+(avgA(q.right)-avgA(q.left)).toFixed(1):null}));
        }
      }
    }else lines.push('lastWandResult: none');
    const likely=[];
    const transforms=['.leaflet-map-pane','.leaflet-tile-pane','.leaflet-marker-pane','.leaflet-overlay-pane'].map(cssTransformOf);
    if(transforms.some(t=>t && t!=='none' && !/^matrix\(1, 0, 0, 1,/.test(t))) likely.push('coordinate-frame mismatch likely: Leaflet panes are transformed/rotated, but Wand canvas/seed may be axis-aligned');
    if(typeof lastWandResult!=='undefined' && lastWandResult?.boundaryPoints && typeof greenCentre!=='undefined' && greenCentre){
      // centroid delta warning handled above visually by user screenshot
      likely.push('if dx is consistently positive across modes, the bias is upstream of mode logic, likely seed/canvas/map transform alignment');
    }
    lines.push('read: '+(likely.length?likely.join(' | '):'no obvious warning yet'));
    return lines.join('\n');
  };
  window.showWandDiagnostics=function(){
    ensureDiagUi();
    const p=document.getElementById('gdWandDiagPanel');
    const t=document.getElementById('gdWandDiagText');
    t.textContent=window.collectWandDiagnostics();
    p.style.display='block';
  };
  const oldUpdate=window.updateWandStatus;
  if(typeof oldUpdate==='function'){
    window.updateWandStatus=function(text){
      oldUpdate(text);
      ensureDiagUi();
    };
  }
  setTimeout(ensureDiagUi,500);
})();

/* ==== section: gd-wand-sample-truth-v1.js ==== */
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

/* ==== section: gd-wand-robust-known-good-flow-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  const CAL_KEY="gd_green_wand_robust_calibration_v2_known_good";
  let liveCalibrationDirty=false;

  function courseKey(){
    try{
      const c=window.currentCourse || currentCourse;
      return (c && c.name) ? String(c.name) : "Manual GPS";
    }catch(e){return "Manual GPS";}
  }
  function readAll(){try{return JSON.parse(localStorage.getItem(CAL_KEY)||"{}") || {};}catch(e){return {};}}
  function writeAll(v){try{localStorage.setItem(CAL_KEY, JSON.stringify(v||{}));}catch(e){}}

  window.gdReadGreenWandCalibration=function(){ return readAll()[courseKey()] || null; };
  window.gdHasGreenWandCalibration=function(){
    const c=window.gdReadGreenWandCalibration();
    return !!(c && Number.isFinite(Number(c.sensitivity)) && Number.isFinite(Number(c.sizeM)) && Number.isFinite(Number(c.curve)));
  };

  window.gdMarkGreenWandCalibrationDirty=function(){
    liveCalibrationDirty=true;
    const save=document.getElementById("gdCalibrationSaveBtn");
    const scan=document.getElementById("gdWandScanBtn");
    const hint=document.getElementById("gdWandUserHint");
    if(save) save.textContent="Save Live Calibration";
    if(scan) scan.textContent="Live Scan";
    if(hint) hint.textContent="Live previewing. Save to keep these settings.";
  };

  window.gdApplyGreenWandCalibration=function(options){
    if(liveCalibrationDirty && !(options && options.force)){
      gdSyncWandControlUi();
      return false;
    }
    const c=window.gdReadGreenWandCalibration();
    if(!c) return false;
    wandMode="robustTonal";
    greenTolerance=Number(c.sensitivity)/100;
    sessionGreenTolerance=greenTolerance;
    wandBaseBubbleMetersOverride=Number(c.sizeM);
    wandClusterPullOverride=Number(c.curve);
    gdSyncWandControlUi();
    return true;
  };

  window.gdSyncWandControlUi=function(){
    const sensitivity=Math.round((greenTolerance||0.71)*100);
    const sizeM=Number(wandBaseBubbleMetersOverride ?? 24.5);
    const curve=Math.round(Number(wandClusterPullOverride ?? 60));

    const sens=document.getElementById("gdWandSensitivity"), sensOut=document.getElementById("gdWandSensitivityOut");
    if(sens) sens.value=sensitivity;
    if(sensOut) sensOut.textContent=String(sensitivity);

    const size=document.getElementById("gdWandBaseBubble"), sizeOut=document.getElementById("gdWandBaseBubbleOut");
    if(size) size.value=sizeM;
    if(sizeOut) sizeOut.textContent=sizeM.toFixed(sizeM%1?1:0)+"m";

    const curveEl=document.getElementById("gdWandClusterPull"), curveOut=document.getElementById("gdWandClusterPullOut");
    if(curveEl) curveEl.value=curve;
    if(curveOut) curveOut.textContent=curve+"%";
  };

  window.saveGreenWandCalibration=function(){
    const all=readAll();
    const sensitivity=Math.round((greenTolerance || 0.71)*100);
    const sizeM=Number(wandBaseBubbleMetersOverride ?? 24.5);
    const curve=Math.round(Number(wandClusterPullOverride ?? 60));
    all[courseKey()]={course:courseKey(),sensitivity,sizeM:Number(sizeM.toFixed(1)),curve,mode:"robustTonal",savedAt:new Date().toISOString()};
    writeAll(all);
    liveCalibrationDirty=false;
    gdSyncWandControlUi();
    gdUpdateWandCalibrationUi();
    updateWandStatus(`Calibration saved · Robust · size ${Number(sizeM).toFixed(1)}m · curve ${curve}%`);
    if(typeof toast==="function") toast("Green Wand calibration saved");
  };

  window.gdUpdateWandCalibrationUi=function(){
    const calibrated=gdHasGreenWandCalibration();
    const title=document.getElementById("gdWandTitleText");
    const details=document.getElementById("gdCalibrationDetails");
    const scan=document.getElementById("gdWandScanBtn");
    const hint=document.getElementById("gdWandUserHint");
    const save=document.getElementById("gdCalibrationSaveBtn");

    if(calibrated){
      if(liveCalibrationDirty) gdSyncWandControlUi();
      else gdApplyGreenWandCalibration({force:true});
      if(title) title.textContent="Green Wand";
      if(details && !details.__gdUserOpened && !details.__gdCompactUserOpened) details.open=false;
      if(scan) scan.textContent=liveCalibrationDirty?"Live Scan":"Scan Outline";
      if(save) save.textContent=liveCalibrationDirty?"Save Live Calibration":"Update Calibration";
      if(hint) hint.textContent=liveCalibrationDirty?"Live previewing. Save to keep these settings.":"Using saved Robust calibration.";
    }else{
      // First calibration opens with known-good values.
      wandMode="robustTonal";
      if(!liveCalibrationDirty){
        if(wandBaseBubbleMetersOverride==null) wandBaseBubbleMetersOverride=24.5;
        if(wandClusterPullOverride==null) wandClusterPullOverride=60;
        if(!greenTolerance || Math.round(greenTolerance*100)<58 || Math.round(greenTolerance*100)>79) greenTolerance=0.71;
      }
      gdSyncWandControlUi();

      if(title) title.textContent="Green Wand Calibration";
      if(details) details.open=true;
      if(scan) scan.textContent=liveCalibrationDirty?"Live Scan":"Calibrate / Scan";
      if(save) save.textContent=liveCalibrationDirty?"Save Live Calibration":"Save Calibration";
      if(hint) hint.textContent=liveCalibrationDirty?"Live previewing. Save to keep these settings.":"First green at this location: starts from known-good Robust settings. Tune only if needed.";
    }
  };

  function removeLayerSafe(l){try{if(l && map) map.removeLayer(l);}catch(e){}}
  window.rejectGreenWand=function(){
    try{
      if(typeof clearWandHandles==="function") clearWandHandles();
      if(typeof clearWandDebugLayers==="function") clearWandDebugLayers();
      [greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(removeLayerSafe);
      greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
      greenPolygon=[];
      lastWandResult=null;
      updateWandStatus("Green outline rejected · ready to scan again");
      if(typeof toast==="function") toast("Green outline rejected");
      if(typeof renderShot==="function") renderShot();
    }catch(e){console.warn("Reject Wand failed",e);}
  };

  window.attachGreenOutlineLongPress=function(){
    try{
      if(!greenOutline || greenOutline.__gdLongPressAttached) return;
      greenOutline.__gdLongPressAttached=true;
      let timer=null;
      const arm=()=>{
        clearTimeout(timer);
        timer=setTimeout(()=>{
          try{
            if(typeof makeEditableGreen==="function") makeEditableGreen();
            updateWandStatus("Adjust mode · drag the side handles");
            if(typeof toast==="function") toast("Adjust green outline");
          }catch(e){}
        },850);
      };
      const disarm=()=>{clearTimeout(timer);timer=null;};
      greenOutline.on("mousedown",arm);
      greenOutline.on("touchstart",arm);
      greenOutline.on("mouseup",disarm);
      greenOutline.on("mouseout",disarm);
      greenOutline.on("touchend",disarm);
      greenOutline.on("drag",disarm);
    }catch(e){}
  };

  function install(){
    const details=document.getElementById("gdCalibrationDetails");
    if(details && !details.__gdTrackOpen){
      details.__gdTrackOpen=true;
      details.addEventListener("toggle",()=>{details.__gdUserOpened=true;details.__gdCompactUserOpened=true;});
      details.querySelector("summary")?.addEventListener("click",()=>{details.__gdUserOpened=true;details.__gdCompactUserOpened=true;},true);
    }
    wandMode="robustTonal";
    if(gdHasGreenWandCalibration() && !liveCalibrationDirty) gdApplyGreenWandCalibration();
    gdUpdateWandCalibrationUi();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);

  function wrap(name,before,after){
    const fn=window[name];
    if(typeof fn!=="function" || fn.__gdKnownGoodRobustWrapped) return;
    const wrapped=function(){
      try{before && before();}catch(e){}
      const result=fn.apply(this,arguments);
      Promise.resolve(result).finally(()=>{try{after && after();}catch(e){}});
      return result;
    };
    wrapped.__gdKnownGoodRobustWrapped=true;
    window[name]=wrapped;
  }

  setTimeout(()=>{
    wrap("openGpsWand",()=>{wandMode="robustTonal";},gdUpdateWandCalibrationUi);
    wrap("runGreenWandScan",()=>{wandMode="robustTonal"; if(gdHasGreenWandCalibration() && !liveCalibrationDirty) gdApplyGreenWandCalibration(); else gdUpdateWandCalibrationUi();},gdUpdateWandCalibrationUi);
  },100);
})();

/* ==== section: gd-inline-gps-wand-active-chrome-sync-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- GPS wand active chrome sync v1 --- */
(function(){
  'use strict';
  function isWandOpen(){
    const panel=document.getElementById('gdWandPanel');
    const classic=document.getElementById('wandPanel');
    return !!((panel && !panel.classList.contains('hidden')) || (classic && classic.classList.contains('open')));
  }
  function sync(){
    const live=!!window.gdWandAcceptedLive;
    const active=isWandOpen()||live;
    const btn=document.getElementById('greenToolBtn');
    if(btn) btn.classList.toggle('gdWandActive',active);
    if(btn) btn.classList.toggle('gdWandLive',live);
    document.body.classList.toggle('gdWandActive',active);
    document.body.classList.toggle('gdWandLayerActive',isWandOpen());
    document.body.classList.toggle('gdWandLive',live);
  }
  function wrap(name){
    const fn=window[name];
    if(typeof fn!=='function' || fn.__gdWandChromeWrapped) return;
    const wrapped=function(){
      const result=fn.apply(this,arguments);
      setTimeout(sync,20);
      setTimeout(sync,180);
      return result;
    };
    wrapped.__gdWandChromeWrapped=true;
    window[name]=wrapped;
  }
  function install(){
    wrap('openGpsWand');
    wrap('toggleGreenWand');
    wrap('closeWandPanel');
    wrap('acceptGreenWand');
    wrap('rejectGreenWand');
    sync();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install);
  else install();
  document.addEventListener('click',()=>setTimeout(sync,60),true);
  setTimeout(install,300);
  setTimeout(sync,1000);
})();
