/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* Clarity Caddie Core Patch: Soft Lock Replace Green Centre Workflow v1 */
(function(){
  'use strict';
  let replacingGreenCentre = false;
  let longPressTimer = null;
  let longPressStart = null;
  const LONG_PRESS_MS = 1200;

  function gdToast(msg){ try{ if(typeof toast === 'function') toast(msg); }catch(e){} }
  function gdState(msg){ try{ if(typeof setState === 'function') setState(msg); }catch(e){} }
  function gdHint(msg){ try{ if(typeof showHint === 'function') showHint(msg); }catch(e){} }
  function gdHideHint(){ try{ if(typeof hideHint === 'function') hideHint(); }catch(e){} }
  function isOnGps(){
    try{ return document.getElementById('courseScreen') && document.getElementById('courseScreen').classList.contains('hidden'); }
    catch(e){ return true; }
  }

  function clearReplaceGreenMode(){
    replacingGreenCentre = false;
    document.body.classList.remove('gd-replacing-green-centre');
    const btn = document.getElementById('replaceGreenCentreBtn');
    if(btn) btn.classList.remove('softActive');
  }

  window.replaceGreenCentre = function replaceGreenCentre(ll, opts){
    opts = Object.assign({ preserveFrame:true, preserveZoom:true, preserveRotation:true, hiddenRecalc:true }, opts || {});
    if(!ll) return;
    try{
      if(typeof L !== 'undefined' && !(ll instanceof L.LatLng)) ll = L.latLng(ll.lat, ll.lng);
    }catch(e){}
    try{ if(typeof undoStack !== 'undefined' && greenCentre) undoStack.push({ type:'target', value:L.latLng(target.lat, target.lng) }); }catch(e){}

    try{ greenCentre = ll; }catch(e){}
    try{ target = ll; if(typeof gdHasWindVector==='function'&&gdHasWindVector())gdSyncWindLandingFromAim();else gdWindLandingTarget=null; }catch(e){}
    try{ targetWasMoved = true; }catch(e){}
    try{ if(typeof gdMarkCurrentPlanDirty === 'function') gdMarkCurrentPlanDirty(); }catch(e){}
    try{ mode = 'aim'; }catch(e){}

    try{
      if(typeof greenMarker !== 'undefined' && greenMarker) greenMarker.setLatLng(ll);
      else if(typeof L !== 'undefined' && typeof map !== 'undefined') greenMarker=L.circleMarker(ll,{radius:8,color:'#1fd36d',weight:2,opacity:.82,fillColor:'#1fd36d',fillOpacity:.08,interactive:false}).addTo(map);
    }catch(e){}
    try{
      if(typeof targetMarker !== 'undefined' && targetMarker) targetMarker.setLatLng((typeof gdShotDisplayTarget==='function'&&gdShotDisplayTarget())||ll);
      else if(typeof createTargetMarker === 'function') createTargetMarker(ll);
    }catch(e){}
    try{ if(document.getElementById('shotTile')) document.getElementById('shotTile').classList.add('visible'); }catch(e){}

    // Hidden recalculation only: redraw geometry, green/wand references and labels, but never refit or pan the map.
    try{ if(typeof renderShot === 'function') renderShot(); }catch(e){}
    try{ if(typeof updatePinLine === 'function') updatePinLine(); }catch(e){}
    try{ if(typeof applyShotUpAfterPlacement === 'function') applyShotUpAfterPlacement(); }catch(e){}
    try{ if(typeof greenActive !== 'undefined' && greenActive){ if(typeof establishGreenFromBubble === 'function') establishGreenFromBubble(); if(typeof scanGreen === 'function') scanGreen(); } }catch(e){}
    try{ if(typeof setBubbleOnlyLock === 'function') setBubbleOnlyLock(true); else lockedFrame = true; }catch(e){}
    gdState('Locked · green centre replaced');
    gdHideHint();
  };

  window.startReplaceGreenCentre = function startReplaceGreenCentre(){
    try{
      if(!isOnGps()){ gdToast('Open GPS first'); return; }
      if(typeof start === 'undefined' || !start || typeof target === 'undefined' || !target){ gdToast('Set start and green first'); return; }
      replacingGreenCentre = true;
      document.body.classList.add('gd-replacing-green-centre');
      const btn = document.getElementById('replaceGreenCentreBtn');
      if(btn) btn.classList.add('softActive');
      gdState('Tap new green centre');
      gdHint('Tap the corrected green centre. Frame stays locked.');
      gdToast('Replace green centre: tap new centre');
    }catch(e){ console.warn('startReplaceGreenCentre failed', e); }
  };

  window.newShotUnlock = function newShotUnlock(){
    try{
      clearReplaceGreenMode();
      if(typeof unlockFrameForReset === 'function') unlockFrameForReset();
      else if(typeof setBubbleOnlyLock === 'function') setBubbleOnlyLock(false);
      try{ lockedFrame = false; }catch(e){}
      try{ if(typeof clearShot === 'function') clearShot(); }catch(e){}
      try{ if(typeof map !== 'undefined'){
        [targetMarker, greenMarker, pinDirectionLine].forEach(l=>{ try{ if(l) map.removeLayer(l); }catch(e){} });
      }}catch(e){}
      try{ targetMarker = null; greenMarker = null; pinDirectionLine = null; }catch(e){}
      try{ target = null; greenCentre = null; pin = null; gdWindLandingTarget = null; }catch(e){}
      const mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
      try{ mode = mapped ? 'start' : (start ? 'green' : 'start'); }catch(e){}
      try{ if(document.getElementById('shotTile')) document.getElementById('shotTile').classList.remove('visible'); }catch(e){}
      try{ if(typeof app !== 'undefined') app.classList.remove('framed'); }catch(e){}
      gdState(mapped ? 'Mapped: set position' : (start ? 'Set green' : 'Set start'));
      gdHint(mapped ? 'Tap where you are standing' : (start ? 'Tap green centre' : 'Tap ball/start'));
      gdToast('Frame unlocked · new shot');
    }catch(e){ console.warn('newShotUnlock failed', e); }
  };

  window.softUnlockFrame = function softUnlockFrame(){
    try{
      clearReplaceGreenMode();
      if(typeof unlockFrameForReset === 'function') unlockFrameForReset();
      else if(typeof setBubbleOnlyLock === 'function') setBubbleOnlyLock(false);
      try{ lockedFrame = false; }catch(e){}
      gdState('Frame unlocked');
      gdToast('Frame unlocked');
    }catch(e){ console.warn('softUnlockFrame failed', e); }
  };

  function handleReplaceClick(e){
    try{
      if(!replacingGreenCentre || !e || !e.latlng) return;
      window.replaceGreenCentre(e.latlng, { preserveFrame:true, preserveZoom:true, preserveRotation:true, hiddenRecalc:true });
      clearReplaceGreenMode();
      if(e.originalEvent){ try{ e.originalEvent.preventDefault(); e.originalEvent.stopPropagation(); }catch(_e){} }
    }catch(err){ console.warn('replace green click failed', err); }
  }

  function installMapHooks(){
    try{
      if(typeof map === 'undefined' || !map || map.__gdSoftLockWorkflowInstalled) return;
      map.__gdSoftLockWorkflowInstalled = true;
      map.on('click', handleReplaceClick);
      map.on('mousedown touchstart', function(e){
        try{
          if(!lockedFrame || replacingGreenCentre) return;
          longPressStart = e.latlng || null;
          clearTimeout(longPressTimer);
          longPressTimer = setTimeout(function(){
            if(!longPressStart) return;
            window.softUnlockFrame();
            longPressStart = null;
          }, LONG_PRESS_MS);
        }catch(_e){}
      });
      map.on('mouseup mousemove dragstart touchend touchmove', function(){
        clearTimeout(longPressTimer);
        longPressStart = null;
      });
    }catch(e){ console.warn('installMapHooks failed', e); }
  }

  function makeButton(id, label, title, onClick){
    let btn = document.getElementById(id);
    if(!btn){ btn = document.createElement('button'); btn.id = id; }
    btn.className = 'railBtn gdSoftLockBtn';
    btn.type = 'button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = label;
    btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); onClick(); };
    return btn;
  }

  function ensureControls(){
    try{
      let rail = document.querySelector('.rightRail');
      if(!rail){ console.warn('[Clarity Caddie] right rail shell is missing'); return; }
      ['replaceGreenCentreBtn','newShotUnlockBtn'].forEach(id=>{
        const btn=document.getElementById(id);
        if(btn&&btn.parentElement===rail)btn.remove();
      });
    }catch(e){ console.warn('ensureControls failed', e); }
  }

  function installStyles(){
    if(document.getElementById('gdSoftLockWorkflowStyles')) return;
    const style = document.createElement('style');
    style.id = 'gdSoftLockWorkflowStyles';
    style.textContent = `
      .gdSoftLockBtn .gdLockTxt{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font:800 10px/1 Inter,system-ui,sans-serif;letter-spacing:.02em;color:#fff;text-transform:uppercase}
      .gdSoftLockBtn#replaceGreenCentreBtn.softActive,.gdSoftLockBtn#newShotUnlockBtn:active{box-shadow:0 0 0 2px rgba(31,211,109,.55),0 12px 26px rgba(0,0,0,.35);background:rgba(31,211,109,.24)}
      body.gd-replacing-green-centre #app{cursor:crosshair}
      body.gd-replacing-green-centre .leaflet-container{cursor:crosshair!important}
    `;
    document.head.appendChild(style);
  }

  function boot(){ installStyles(); installMapHooks(); ensureControls(); }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 600);
  setTimeout(boot, 1800);
})();
