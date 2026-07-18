/* ============================================================================
 * WAND FLOW LAYERS — consolidated from 3 late wand patch files (Phase A, 2026-07-19).
 * Sections in original load order, each an unchanged self-contained IIFE.
 * Merges into the single Wand owner in a later phase (engine logic stays locked).
 * ============================================================================ */

/* ==== section: gd-wand-compact-flow-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* Compact wand flow: open scans once; Accept keeps it live; Exit rejects and closes. */
(function(){
  'use strict';
  function safe(fn){try{return fn()}catch(e){console.warn('[GD compact wand]',e);}}
  function panel(){return document.getElementById('gdWandPanel');}
  function isOpen(){const p=panel();return !!(p && !p.classList.contains('hidden'));}
  function syncChrome(){
    safe(()=>{if(typeof gdSyncWandLiveChrome==='function') gdSyncWandLiveChrome();});
    safe(()=>{
      const btn=document.getElementById('greenToolBtn');
      if(btn && isOpen()) btn.classList.add('gdWandActive');
    });
  }
  function compactUi(){
    const p=panel();
    if(!p) return;
    p.classList.add('gdWandCompact');
    const title=document.getElementById('gdWandTitleText');
    if(title) title.textContent='Green Wand';
    const details=document.getElementById('gdCalibrationDetails');
    if(details && !details.__gdCompactUserOpened && !details.__gdUserOpened){
      details.open=false;
      details.addEventListener('toggle',()=>{details.__gdCompactUserOpened=true;details.__gdUserOpened=true;},{once:true});
      details.querySelector('summary')?.addEventListener('click',()=>{details.__gdCompactUserOpened=true;details.__gdUserOpened=true;},true);
    }
    const scan=document.getElementById('gdWandScanBtn');
    if(scan) scan.textContent='Scan';
    const accept=document.getElementById('gdWandAcceptBtn');
    if(accept) accept.textContent='Accept';
    const exit=document.getElementById('gdWandExitBtn');
    if(exit) exit.textContent='Exit';
  }
  function hasTarget(){
    return safe(()=>!!((typeof target!=='undefined' && target) || (typeof greenCentre!=='undefined' && greenCentre)));
  }
  function isMappingMode(){
    return !!(window.gdFullMappingMode||document.body.classList.contains('gdFullMappingMode'));
  }
  function openAndScan(evt){
    safe(()=>{if(evt && evt.preventDefault) evt.preventDefault(); if(evt && evt.stopPropagation) evt.stopPropagation();});
    safe(()=>{if(isMappingMode()&&typeof window.gdMapperHydrateGreenForWand==='function') window.gdMapperHydrateGreenForWand();});
    safe(()=>{if(!isMappingMode()&&typeof enterGpsModule==='function' && !document.body.classList.contains('gps-active') && !document.body.classList.contains('gdGpsActive')) enterGpsModule({preserveState:true, fromWand:true});});
    safe(()=>{greenActive=true;});
    const p=panel();
    if(p) p.classList.remove('hidden');
    safe(()=>{if(typeof setWandMode==='function') setWandMode('robustTonal', true);});
    compactUi();
    safe(()=>{if(typeof updateWandStatus==='function') updateWandStatus(hasTarget()?'Scanning green...':'Set the green first, then tap Wand again.');});
    if(hasTarget()){
      window.__gdWandCompactScanPending=true;
      setTimeout(()=>{
        if(!isOpen() || !window.__gdWandCompactScanPending) return;
        window.__gdWandCompactScanPending=false;
        safe(()=>{if(typeof runGreenWandScan==='function') runGreenWandScan();});
      },90);
    }
    setTimeout(compactUi,160);
    setTimeout(syncChrome,180);
    return false;
  }
  function exitReject(evt){
    safe(()=>{if(evt && evt.preventDefault) evt.preventDefault(); if(evt && evt.stopPropagation) evt.stopPropagation();});
    window.__gdWandCompactScanPending=false;
    safe(()=>{if(typeof rejectGreenWand==='function') rejectGreenWand();});
    safe(()=>{greenActive=false;});
    safe(()=>{const p=panel(); if(p) p.classList.add('hidden');});
    safe(()=>{if(typeof clearWandHandles==='function') clearWandHandles();});
    safe(()=>{if(typeof clearWandScaleLock==='function') clearWandScaleLock('compact-exit');});
    setTimeout(syncChrome,40);
    return false;
  }
  function acceptCompact(evt){
    safe(()=>{if(evt && evt.preventDefault) evt.preventDefault(); if(evt && evt.stopPropagation) evt.stopPropagation();});
    safe(()=>{if(typeof saveGreenWandCalibration==='function') saveGreenWandCalibration();});
    safe(()=>{if(typeof acceptGreenWand==='function') acceptGreenWand();});
    safe(()=>{const p=panel(); if(p) p.classList.add('hidden');});
    setTimeout(syncChrome,40);
    return false;
  }
  function install(){
    compactUi();
    const exit=document.getElementById('gdWandExitBtn');
    if(exit) exit.onclick=exitReject;
    const close=document.querySelector('#gdWandPanel .gdWandClose');
    if(close) close.onclick=exitReject;
    const accept=document.getElementById('gdWandAcceptBtn');
    if(accept) accept.onclick=acceptCompact;
    window.gdCompactWandExit=exitReject;
    window.gdCompactWandOpen=openAndScan;
    window.openGpsWand=openAndScan;
    window.toggleGreenWand=function(evt){
      if(isOpen()) return exitReject(evt);
      return openAndScan(evt);
    };
    window.gdToggleWandTool=window.toggleGreenWand;
    const btn=document.getElementById('greenToolBtn');
    if(btn) btn.onclick=window.toggleGreenWand;
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);
})();

/* ==== section: gd-wand-floating-mapper-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  'use strict';
  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function panel(){return document.getElementById('gdWandPanel');}
  let userMoved=false;
  let floatObserver=null;
  let dragInstalled=false;
  function bounds(p){
    return {
      minLeft:8,
      minTop:8,
      maxLeft:Math.max(8,window.innerWidth-p.offsetWidth-8),
      maxTop:Math.max(8,window.innerHeight-p.offsetHeight-10)
    };
  }
  function setPanelPos(p,left,top){
    p.style.setProperty('left',`${left}px`,'important');
    p.style.setProperty('top',`${top}px`,'important');
    p.style.setProperty('right','auto','important');
    p.style.setProperty('bottom','auto','important');
  }
  function clearPanelPos(p){
    ['left','top','right','bottom','width'].forEach(prop=>p.style.removeProperty(prop));
  }
  function keepInView(p,force=false){
    if(!p||p.classList.contains('hidden'))return;
    if(p.classList.contains('gdWandDragging'))return;
    if(userMoved&&!force)return;
    const rect=p.getBoundingClientRect();
    const b=bounds(p);
    const left=clamp(rect.left,b.minLeft,b.maxLeft);
    const top=clamp(rect.top,b.minTop,b.maxTop);
    if(Math.abs(left-rect.left)>1||Math.abs(top-rect.top)>1){
      p.classList.add('gdWandFloatingMoved');
      setPanelPos(p,left,top);
    }
  }
  function resetDefaultPosition(p){
    if(!p||userMoved)return;
    p.classList.remove('gdWandFloatingMoved');
    clearPanelPos(p);
  }
  function positionDefault(p){
    if(!p||userMoved||p.classList.contains('hidden'))return;
    p.classList.remove('gdWandFloatingMoved');
    clearPanelPos(p);
  }
  function install(){
    const p=panel();
    if(!p)return;
    if(!floatObserver){
      floatObserver=new MutationObserver(()=>setTimeout(()=>{positionDefault(p);},20));
      floatObserver.observe(p,{attributes:true,attributeFilter:['class']});
      window.addEventListener('resize',()=>keepInView(p,true));
    }
    const handle=p;
    if(!handle||dragInstalled)return;
    dragInstalled=true;
    let drag=null;
    handle.addEventListener('pointerdown',ev=>{
      if(ev.target.closest('button,input,summary,details,label,select,textarea'))return;
      const rect=p.getBoundingClientRect();
      drag={dx:ev.clientX-rect.left,dy:ev.clientY-rect.top};
      userMoved=true;
      p.classList.add('gdWandDragging','gdWandFloatingMoved');
      setPanelPos(p,rect.left,rect.top);
      p.style.setProperty('width',`${rect.width}px`,'important');
      try{p.setPointerCapture(ev.pointerId);}catch(e){}
      ev.preventDefault();
    });
    handle.addEventListener('pointermove',ev=>{
      if(!drag)return;
      const b=bounds(p);
      setPanelPos(p,clamp(ev.clientX-drag.dx,b.minLeft,b.maxLeft),clamp(ev.clientY-drag.dy,b.minTop,b.maxTop));
    });
    function endDrag(ev){
      if(!drag)return;
      drag=null;
      p.classList.remove('gdWandDragging');
      try{p.releasePointerCapture(ev.pointerId);}catch(e){}
    }
    handle.addEventListener('pointerup',endDrag);
    handle.addEventListener('pointercancel',endDrag);
    setTimeout(()=>{positionDefault(p);},80);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);
})();

/* ==== section: gd-gps-polish-wand-layer-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  function sync(){
    var panel=document.getElementById("gdWandPanel");
    var open=!!(panel&&!panel.classList.contains("hidden"));
    document.body.classList.toggle("gdWandLayerActive",open);
  }
  function install(){
    var panel=document.getElementById("gdWandPanel");
    if(panel&&!panel.__gdLayerObserver){
      panel.__gdLayerObserver=new MutationObserver(sync);
      panel.__gdLayerObserver.observe(panel,{attributes:true,attributeFilter:["class"]});
    }
    sync();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
  setTimeout(install,400);
  setTimeout(sync,1200);
})();
