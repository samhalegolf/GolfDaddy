/* ============================================================================
 * CADDIE GPS PATCHES — consolidated from 6 legacy patch files (Phase A, 2026-07-19).
 * Sections in original load order, each an unchanged self-contained IIFE.
 * These behaviors belong in the GPS owner long-term (Phase B carve).
 * ============================================================================ */

/* ==== section: gd-inline-clarity-caddie-core-patch-soft-lock.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* Clarity Caddy Core Patch: Soft Lock Replace Green Centre Workflow v1 */
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
      if(!rail){ console.warn('[Clarity Caddy] right rail shell is missing'); return; }
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

/* ==== section: gd-inline-clarity-caddie-v-next-patch-gps-locate.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy vNext patch: GPS locate button recenters when unlocked, stays live-only when locked --- */
(function(){
  function safeToast(msg){ try{ if(typeof toast==='function') toast(msg); }catch(e){} }
  function setGpsLabelSafe(ok,label){ try{ if(typeof setGps==='function') setGps(ok,label); }catch(e){}; try{ if(typeof setGpsLabel==='function') setGpsLabel(ok,label); }catch(e){} }
  function setStateSafe(label){ try{ if(typeof setState==='function') setState(label); }catch(e){}; try{ if(typeof setStateLabel==='function') setStateLabel(label); }catch(e){} }
  function hideHint(){ try{ if(typeof hideHintSafe==='function') hideHintSafe(); else if(typeof hideHint==='function') hideHint(); }catch(e){} }
  function showHintSafe(msg){ try{ if(typeof hint==='function') hint(msg); else if(typeof showHint==='function') showHint(msg); }catch(e){} }
  function curStart(){ try{return typeof start!=='undefined'&&start?start:null}catch(e){return null} }
  function curTarget(){ try{return typeof target!=='undefined'&&target?target:null}catch(e){return null} }
  function isLocked(){ try{return !!lockedFrame}catch(e){return false} }
  function currentZoom(){ try{return (map&&map.getZoom)?map.getZoom():18}catch(e){return 18} }
	  function jumpCameraTo(here){
	    return false;
	  }
	  function applyLiveGpsPosition(here, opts){
	    opts=opts||{};
	    setGpsLabelSafe(true,'GPS');
	    try{ gpsOk=true; }catch(e){}
	    try{ if(typeof window.gdRememberLiveGpsOnly==='function')window.gdRememberLiveGpsOnly(here,opts.accuracy,opts.source||'gps-live'); }catch(e){}

	    if(isLocked()){
	      try{ if(typeof updateGpsInsideLockedFrame==='function'&&curStart()) updateGpsInsideLockedFrame(here, opts.label||'GPS live'); }catch(e){}
	      setStateSafe('Live locked');
	      hideHint();
	      if(opts.toast) safeToast('GPS refreshed');
	      return;
	    }

	    setStateSafe('GPS live');
	    hideHint();
	    if(opts.toast) safeToast('GPS located');
	  }
  function requestLiveGps(opts){
    opts=opts||{};
    if(!navigator.geolocation){ setGpsLabelSafe(false,'GPS unavailable'); safeToast('GPS unavailable'); return; }
    setGpsLabelSafe(true,'GPS…');
    navigator.geolocation.getCurrentPosition(pos=>{
      const here=L.latLng(pos.coords.latitude,pos.coords.longitude);
      applyLiveGpsPosition(here, opts);
      try{ if(typeof startWatch==='function') startWatch(); }catch(e){}
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    },err=>{
      const denied=err&&err.code===1;
      setGpsLabelSafe(false,denied?'GPS denied':'GPS weak');
      setStateSafe(denied?'GPS permission needed':'GPS is searching');
      if(denied)hideHint();
      else showHintSafe('GPS is searching. Try again near the tee.');
      safeToast(err&&err.message?err.message:(denied?'Location permission needed':'GPS is searching'));
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
  }

  window.refreshGPS=function(){ requestLiveGps({jump:true,toast:true,label:'GPS refreshed'}); };
  window.gdGpsLocateNow=function(){ requestLiveGps({jump:true,toast:true,label:'GPS locate'}); };

  const oldEnterLive=window.setGpsPlayMode;
  if(typeof oldEnterLive==='function'&&!oldEnterLive.__gdLocateJumpWrapped){
    const wrapped=function(next){
      if(next==='live') { requestLiveGps({jump:true,toast:false,label:'GPS live'}); return; }
      return oldEnterLive.apply(this,arguments);
    };
    wrapped.__gdLocateJumpWrapped=true;
    window.setGpsPlayMode=wrapped;
  }

  const oldInit=window.initGPS;
  if(typeof oldInit==='function'&&!oldInit.__gdLocateJumpWrapped){
    const wrapped=function(){
      const res=oldInit.apply(this,arguments);
      try{
        const saved=localStorage.getItem('gd_gps_play_mode');
        if(saved==='live'&&!isLocked()) setTimeout(()=>requestLiveGps({jump:true,toast:false,label:'GPS live'}),250);
      }catch(e){}
      return res;
    };
    wrapped.__gdLocateJumpWrapped=true;
    window.initGPS=wrapped;
  }
})();

/* ==== section: gd-inline-clarity-caddie-patch-location-permission-fix.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: location permission/fix state is based on last successful GPS fix --- */
(function(){
  const CACHE_MAX_MS = 90000;
  const REQUEST_TIMEOUT_MS = 18000;

  window.gdGpsState = window.gdGpsState || {
    permissionKnown:false,
    permissionGranted:false,
    lastFix:null,
    lastFixAt:0,
    lastError:null,
    activeRequest:false
  };

  function now(){ return Date.now(); }
  function safeToast(msg){ try{ if(typeof toast==='function') toast(msg); }catch(e){} }
  function setGpsLabelSafe(ok,label){
    try{ if(typeof setGps==='function') setGps(ok,label); }catch(e){}
    try{ if(typeof setGpsLabel==='function') setGpsLabel(ok,label); }catch(e){}
  }
  function setStateSafe(label){
    try{ if(typeof setState==='function') setState(label); }catch(e){}
    try{ if(typeof setStateLabel==='function') setStateLabel(label); }catch(e){}
  }
  function hintSafe(msg){ try{ if(typeof hint==='function') hint(msg); else if(typeof showHint==='function') showHint(msg); }catch(e){} }
  function hideHintSafe2(){ try{ if(typeof hideHintSafe==='function') hideHintSafe(); else if(typeof hideHint==='function') hideHint(); }catch(e){} }
  function isLocked(){ try{return !!lockedFrame}catch(e){return false} }
  function curStart(){ try{return typeof start!=='undefined'&&start?start:null}catch(e){return null} }
  function curTarget(){ try{return typeof target!=='undefined'&&target?target:null}catch(e){return null} }
  function asLatLng(posOrFix){
    if(!posOrFix) return null;
    if(posOrFix.lat!=null && posOrFix.lng!=null) return L.latLng(posOrFix.lat,posOrFix.lng);
    if(posOrFix.coords) return L.latLng(posOrFix.coords.latitude,posOrFix.coords.longitude);
    return null;
  }
  function rememberFix(pos, source){
    const ll = asLatLng(pos);
    if(!ll) return null;
    window.gdGpsState.permissionKnown = true;
    window.gdGpsState.permissionGranted = true;
    window.gdGpsState.lastError = null;
    window.gdGpsState.lastFix = {
      lat: ll.lat,
      lng: ll.lng,
      accuracy: pos && pos.coords ? pos.coords.accuracy : undefined,
      source: source || 'gps'
    };
    window.gdGpsState.lastFixAt = now();
    try{ gpsOk = true; }catch(e){}
    return ll;
  }
  function cacheFresh(){
    return !!(window.gdGpsState.lastFix && (now()-window.gdGpsState.lastFixAt) < CACHE_MAX_MS);
  }
	  function jumpCameraTo(ll){
	    return false;
	  }
	  function applyFix(ll, opts){
	    opts = opts || {};
	    if(!ll) return false;
	    setGpsLabelSafe(true, opts.label || 'GPS');
	    try{ gpsOk=true; }catch(e){}
	    try{ if(typeof window.gdRememberLiveGpsOnly==='function')window.gdRememberLiveGpsOnly(ll,opts.accuracy,opts.cache?'gps-cache':'gps-live'); }catch(e){}

	    if(isLocked()){
	      try{ if(typeof updateGpsInsideLockedFrame==='function' && curStart()) updateGpsInsideLockedFrame(ll, opts.label || 'GPS live'); }catch(e){}
	      setStateSafe('Live locked');
	      hideHintSafe2();
	      if(opts.toast) safeToast('GPS refreshed');
	      return true;
	    }

	    setStateSafe(opts.cache ? 'GPS cached' : 'GPS live');
	    hideHintSafe2();
	    if(opts.toast) safeToast(opts.cache ? 'GPS refreshed from recent fix' : 'GPS located');
	    return true;
	  }

  // Intercept every successful geolocation result, including old app code, so the whole app agrees permission is working.
  try{
    if(navigator.geolocation && !navigator.geolocation.__gdFixCachePatched){
      const geo = navigator.geolocation;
      const rawGet = geo.getCurrentPosition.bind(geo);
      const rawWatch = geo.watchPosition.bind(geo);
      geo.getCurrentPosition = function(success, error, options){
        return rawGet(function(pos){ rememberFix(pos,'getCurrentPosition'); if(typeof success==='function') success(pos); }, function(err){ window.gdGpsState.lastError = err || null; if(typeof error==='function') error(err); }, options);
      };
      geo.watchPosition = function(success, error, options){
        return rawWatch(function(pos){ rememberFix(pos,'watchPosition'); if(typeof success==='function') success(pos); }, function(err){ window.gdGpsState.lastError = err || null; if(typeof error==='function') error(err); }, options);
      };
      geo.__gdFixCachePatched = true;
    }
  }catch(e){}

  function requestGpsRobust(opts){
    opts = opts || {};
    if(!navigator.geolocation){ setGpsLabelSafe(false,'GPS unavailable'); safeToast('GPS unavailable'); return; }

    // If the dot has already moved, permission is effectively working. Use that immediately while asking for a fresher fix.
    if(cacheFresh() && opts.allowCacheFirst !== false){
      applyFix(asLatLng(window.gdGpsState.lastFix), Object.assign({}, opts, {cache:true, toast:opts.toast}));
    }

    if(window.gdGpsState.activeRequest) return;
    window.gdGpsState.activeRequest = true;
    setGpsLabelSafe(true,'GPS…');

    navigator.geolocation.getCurrentPosition(function(pos){
      window.gdGpsState.activeRequest = false;
      const ll = rememberFix(pos,'gpsButton');
      applyFix(ll, Object.assign({}, opts, {cache:false}));
      try{ if(typeof startWatch==='function') startWatch(); }catch(e){}
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    }, function(err){
      window.gdGpsState.activeRequest = false;
      window.gdGpsState.lastError = err || null;
      // Do not call this denied if a successful fix exists. This handles timeout/slow GPS after permission was granted.
      if(cacheFresh()){
        setGpsLabelSafe(true,'GPS cached');
        applyFix(asLatLng(window.gdGpsState.lastFix), Object.assign({}, opts, {cache:true, toast:true}));
        try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
        return;
      }
      const code = err && err.code;
      const msg = code === 1 ? 'GPS permission needed' : (code === 3 ? 'GPS timeout · try again outside' : 'GPS weak');
      setGpsLabelSafe(false, code === 1 ? 'GPS denied' : 'GPS weak');
      setStateSafe(msg);
      if(code === 1) hideHintSafe2();
      else hintSafe('GPS is searching. Try again near the tee.');
      safeToast(err && err.message ? err.message : msg);
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    }, {enableHighAccuracy:true, maximumAge:15000, timeout:REQUEST_TIMEOUT_MS});
  }

  window.gdGpsRememberFix = rememberFix;
  window.gdGpsApplyFix = applyFix;
  window.gdGpsLocateNow = function(){ requestGpsRobust({jump:true, toast:true, label:'GPS locate'}); };
  window.refreshGPS = function(){ requestGpsRobust({jump:true, toast:true, label:'GPS refreshed'}); };

  function patchButton(){
    const btn = document.getElementById('gpsRailBtn');
    if(btn && !btn.__gdRobustGpsClick){
      btn.__gdRobustGpsClick = true;
      btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); window.gdGpsLocateNow(); };
    }
  }
  patchButton();
  document.addEventListener('DOMContentLoaded',()=>setTimeout(patchButton,80));
  setTimeout(patchButton,300);
  setTimeout(patchButton,1000);
})();

/* ==== section: gd-inline-clarity-caddie-patch-next-shot-unlock.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: Next Shot unlock + Undo unlock fallback v1 --- */
(function(){
  'use strict';
  function gdToast(msg){ try{ if(typeof toast === 'function') toast(msg); }catch(e){} }
  function gdState(msg){ try{ if(typeof setState === 'function') setState(msg); }catch(e){} }
  function gdHint(msg){ try{ if(typeof showHint === 'function') showHint(msg); }catch(e){} }
  function isLocked(){ try{ return !!lockedFrame; }catch(e){ return false; } }
  function hasUndo(){ try{ return Array.isArray(undoStack) && undoStack.length > 0; }catch(e){ return false; } }

  function unlockOnly(reason){
    try{ if(typeof clearReplaceGreenMode === 'function') clearReplaceGreenMode(); }catch(e){}
    try{ if(typeof unlockFrameForReset === 'function') unlockFrameForReset(); else if(typeof setBubbleOnlyLock === 'function') setBubbleOnlyLock(false); }catch(e){}
    try{ lockedFrame = false; }catch(e){}
    try{ if(typeof app !== 'undefined') app.classList.remove('framed'); }catch(e){}
    gdState('Frame unlocked');
    gdToast(reason || 'Frame unlocked');
  }

  // Full new-shot flow: unlock frame and clear the green/bubble target while keeping the live start/GPS point.
  window.newShotUnlock = function newShotUnlock(){
    try{
      try{ if(typeof clearReplaceGreenMode === 'function') clearReplaceGreenMode(); }catch(e){}
      unlockOnly('Frame unlocked · next shot');
      try{ if(typeof clearShot === 'function') clearShot(); }catch(e){}
      try{
        if(typeof map !== 'undefined'){
          [targetMarker, greenMarker, pinDirectionLine].forEach(function(l){ try{ if(l) map.removeLayer(l); }catch(e){} });
        }
      }catch(e){}
      try{ targetMarker = null; greenMarker = null; pinDirectionLine = null; }catch(e){}
      try{ target = null; greenCentre = null; pin = null; }catch(e){}
      const mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
      try{ mode = mapped ? 'start' : (start ? 'green' : 'start'); }catch(e){}
      try{ undoStack = []; }catch(e){}
      try{ if(document.getElementById('shotTile')) document.getElementById('shotTile').classList.remove('visible'); }catch(e){}
      gdState(mapped ? 'Mapped: set position' : (start ? 'Set green' : 'Set start'));
      gdHint(mapped ? 'Tap where you are standing' : (start ? 'Tap green centre' : 'Tap ball/start'));
    }catch(e){ console.warn('newShotUnlock patch failed', e); }
  };

  // Keep the softer escape available for long-press / test use.
  window.softUnlockFrame = function softUnlockFrame(){ unlockOnly('Frame unlocked'); };

  const originalUndo = window.undoLast;
  window.undoLast = function undoLastPatched(){
    try{
      if(!hasUndo() && isLocked()){
        if(typeof gdReframeShotAfterUndo === 'function' && gdReframeShotAfterUndo({refit:true})){
          gdToast('Frame restored');
          return;
        }
        unlockOnly('Undo: frame unlocked');
        return;
      }
    }catch(e){}
    if(typeof originalUndo === 'function') return originalUndo.apply(this, arguments);
    gdToast('Nothing to undo');
  };

  function patchButtons(){
    try{
      const btn = document.getElementById('newShotUnlockBtn');
      if(btn){
        btn.title = 'Next shot / unlock frame';
        btn.setAttribute('aria-label','Next shot / unlock frame');
        btn.innerHTML = '<span class="gdLockTxt">Next</span>';
        btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); window.newShotUnlock(); };
      }
      ['gdV62UndoBtn','gdGpsUndoBtn','undoBtn'].map(id=>document.getElementById(id)).filter(Boolean).forEach(function(b){ b.remove(); });
    }catch(e){}
  }
  patchButtons();
  document.addEventListener('DOMContentLoaded',()=>setTimeout(patchButtons,80));
  setTimeout(patchButtons,400);
  setTimeout(patchButtons,1400);
})();

/* ==== section: gd-inline-clarity-caddie-patch-switching-to-2-tap.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: switching to 2-Tap unlocks the soft-locked frame v1 --- */
(function(){
  'use strict';
  function gdToast(msg){ try{ if(typeof toast === 'function') toast(msg); }catch(e){} }
  function gdState(msg){ try{ if(typeof setState === 'function') setState(msg); }catch(e){} try{ if(typeof setStateLabel === 'function') setStateLabel(msg); }catch(e){} }
  function gdHint(msg){ try{ if(typeof showHint === 'function') showHint(msg); else if(typeof hint === 'function') hint(msg); }catch(e){} }
  function isLocked(){ try{ return !!lockedFrame; }catch(e){ return false; } }
  function unlockFrameForModeSwitch(){
    try{ if(typeof clearReplaceGreenMode === 'function') clearReplaceGreenMode(); }catch(e){}
    try{ if(typeof unlockFrameForReset === 'function') unlockFrameForReset(); else if(typeof setBubbleOnlyLock === 'function') setBubbleOnlyLock(false); }catch(e){}
    try{ lockedFrame = false; }catch(e){}
    try{ if(typeof app !== 'undefined') app.classList.remove('framed'); }catch(e){}
    try{ document.body.classList.remove('gd-replacing-green-centre'); }catch(e){}
  }
  function clearLockedShotOverlays(){
    try{ if(typeof clearShot === 'function') clearShot(); }catch(e){}
    try{ if(typeof map !== 'undefined' && map){ [targetMarker, greenMarker, pinDirectionLine].forEach(function(l){ try{ if(l) map.removeLayer(l); }catch(e){} }); } }catch(e){}
    try{ targetMarker = null; greenMarker = null; pinDirectionLine = null; }catch(e){}
    try{ target = null; greenCentre = null; pin = null; }catch(e){}
    try{ if(document.getElementById('shotTile')) document.getElementById('shotTile').classList.remove('visible'); }catch(e){}
  }
  function unlockForTwoTap(){
    var wasLocked = isLocked();
    unlockFrameForModeSwitch();
    if(wasLocked) clearLockedShotOverlays();
    try{ undoStack = []; }catch(e){}
    var mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
    gdState(mapped?'Mapped: set position':'Manual: set start');
    gdHint(mapped?'Tap where you are standing':'Tap twice: ball then green');
    if(wasLocked) gdToast('Frame unlocked · Manual mode');
  }

  const previousSetGpsPlayMode = window.setGpsPlayMode;
  window.setGpsPlayMode = function patchedSetGpsPlayMode(next){
    if(next === 'twoTap'){
      unlockForTwoTap();
      if(typeof previousSetGpsPlayMode === 'function') return previousSetGpsPlayMode.call(this, next);
      return;
    }
    if(typeof previousSetGpsPlayMode === 'function') return previousSetGpsPlayMode.call(this, next);
  };

  function patchTwoTapButton(){
    const btn = document.getElementById('gpsTwoTapBtn');
    if(btn && !btn.__gdTwoTapUnlockPatched){
      btn.__gdTwoTapUnlockPatched = true;
      btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); window.setGpsPlayMode('twoTap'); };
    }
  }
  patchTwoTapButton();
  document.addEventListener('DOMContentLoaded',()=>setTimeout(patchTwoTapButton,80));
  setTimeout(patchTwoTapButton,400);
  setTimeout(patchTwoTapButton,1400);
})();

/* ==== section: gd-inline-clarity-caddie-patch-2-tap-must-work.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: 2-Tap must work with no location permission v1 --- */
(function(){
  'use strict';
  function safe(fn){ try{return fn()}catch(e){ console.warn('[GD 2tap no-location fix]', e); } }
  function say(msg){ safe(function(){ if(typeof toast==='function') toast(msg); }); }
  function state(msg){ safe(function(){ if(typeof setState==='function') setState(msg); }); safe(function(){ if(typeof setStateLabel==='function') setStateLabel(msg); }); }
  function hintMsg(msg){ safe(function(){ if(typeof showHint==='function') showHint(msg); else if(typeof hint==='function') hint(msg); }); }
  function hideCoursePicker(){ safe(function(){ var cs=document.getElementById('courseScreen'); if(cs) cs.classList.add('hidden'); }); }
  function showGpsSurface(){
    hideCoursePicker();
    safe(function(){ document.body.classList.add('shell-gps','gps-active','gdModeTwoTap'); document.body.classList.remove('gdModeLive'); });
    safe(function(){ if(typeof setShellLayer==='function') setShellLayer('gps'); });
    safe(function(){ if(typeof setDockActive==='function') setDockActive('gps'); });
    safe(function(){ var h=document.getElementById('shellHome'); if(h) h.classList.add('hidden'); });
    safe(function(){ if(typeof showShellChrome==='function') showShellChrome(true); });
    safe(function(){ if(typeof map!=='undefined'&&map&&map.invalidateSize) setTimeout(function(){map.invalidateSize();},80); });
  }
  function enableMapGestures(){
    safe(function(){ if(typeof map!=='undefined'&&map){ ['dragging','touchZoom','doubleClickZoom','scrollWheelZoom','boxZoom','keyboard'].forEach(function(k){ try{ map[k]&&map[k].enable&&map[k].enable(); }catch(e){} }); }});
  }
  function stopGpsWatch(){ safe(function(){ if(typeof gpsWatch!=='undefined' && gpsWatch && navigator.geolocation){ navigator.geolocation.clearWatch(gpsWatch); gpsWatch=null; } }); }
  function fullUnlockForManual(){
    safe(function(){ if(typeof clearReplaceGreenMode==='function') clearReplaceGreenMode(); });
    safe(function(){ if(typeof unlockFrameForReset==='function') unlockFrameForReset(); else if(typeof setBubbleOnlyLock==='function') setBubbleOnlyLock(false); });
    safe(function(){ lockedFrame=false; });
    safe(function(){ var a=(typeof app!=='undefined'&&app)||document.getElementById('app'); if(a) a.classList.remove('framed'); });
    enableMapGestures();
  }
  function removeLayerByName(name){ safe(function(){ if(typeof map!=='undefined'&&map&&typeof window[name]!=='undefined'&&window[name]){ map.removeLayer(window[name]); window[name]=null; } }); }
  function clearManualShotState(){
    safe(function(){ if(typeof clearShot==='function') clearShot(); });
    ['targetMarker','greenMarker','pinMarker','pinDirectionLine','aimLine','bubbleOuter','bubbleMain','bubbleCore','bubbleShadow','bubbleShade','heatLayer'].forEach(removeLayerByName);
    safe(function(){ target=null; greenCentre=null; pin=null; });
    safe(function(){ mode='start'; });
    safe(function(){ undoStack=[]; });
    safe(function(){ var tile=document.getElementById('shotTile'); if(tile) tile.classList.remove('visible'); });
  }
  function refreshModeButtons(){
    safe(function(){ var two=document.getElementById('gpsTwoTapBtn'), live=document.getElementById('gpsLiveModeBtn'); if(two) two.classList.add('active'); if(live) live.classList.remove('active'); });
    safe(function(){ localStorage.setItem('gd_gps_play_mode','twoTap'); localStorage.setItem('gdGpsPlayMode','twoTap'); });
  }
  function enterTwoTapNoLocation(){
    stopGpsWatch();
    fullUnlockForManual();
    showGpsSurface();
    refreshModeButtons();
    clearManualShotState();
    safe(function(){ if(typeof setGps==='function') setGps(false,'Manual'); });
    safe(function(){ if(typeof setGpsLabel==='function') setGpsLabel(false,'Manual'); });
    var mapped=!!(window.gdMappedCourseAssistActive&&window.gdMappedCourseAssistActive());
    state(mapped?'Mapped: set position':'Manual: set start');
    hintMsg(mapped?'Tap where you are standing':'Tap twice: ball then green');
    return true;
  }

  var previousSetGpsPlayMode = window.setGpsPlayMode;
  window.setGpsPlayMode = function(next){
    if(next==='twoTap') return enterTwoTapNoLocation();
    if(typeof previousSetGpsPlayMode==='function') return previousSetGpsPlayMode.apply(this, arguments);
  };

  function patchTwoTapButton(){
    var btn=document.getElementById('gpsTwoTapBtn');
    if(btn){
      btn.onclick=function(ev){ if(ev){ev.preventDefault();ev.stopPropagation();} enterTwoTapNoLocation(); };
    }
  }
  patchTwoTapButton();
  document.addEventListener('DOMContentLoaded', function(){ setTimeout(patchTwoTapButton,60); setTimeout(patchTwoTapButton,400); setTimeout(patchTwoTapButton,1400); });

  window.gdEnterTwoTapNoLocation = enterTwoTapNoLocation;
})();
