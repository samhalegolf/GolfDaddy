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
