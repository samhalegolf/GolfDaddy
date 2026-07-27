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

    // Hidden recalculation only: redraw geometry and labels, but never refit or pan the map.
    try{ if(typeof renderShot === 'function') renderShot(); }catch(e){}
    try{ if(typeof updatePinLine === 'function') updatePinLine(); }catch(e){}
    try{ if(typeof applyShotUpAfterPlacement === 'function') applyShotUpAfterPlacement(); }catch(e){}
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
	    safe(function(){ window.GDShell?.enterGps?.({source:'two-tap-no-location',replace:true});document.body.classList.add('gdModeTwoTap'); document.body.classList.remove('gdModeLive'); });
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

/* ==== section: gd-inline-clarity-caddie-play-button-rescue-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy Play Button Rescue v1 ---
   Fixes home/play route after a prior script fragment broke.
   Any Play/Open GPS/GPS Module tile now reliably enters the GPS/course picker. */
(function(){
  function qs(id){ return document.getElementById(id); }
  function show(el,on){ if(el) el.classList.toggle('hidden', !on); }
  function closePanels(){
    try{ document.querySelectorAll('.modulePanel.open,.panel.open').forEach(function(p){ p.classList.remove('open'); }); }catch(e){}
    try{ qs('gdProfileV67')?.classList.add('hidden'); document.body.classList.remove('gdProfileOpen'); }catch(e){}
  }
	  function setGpsClasses(){
	    try{ window.GDShell?.enterGps?.({source:'play-button-rescue',replace:true}); }catch(e){}
	  }
  function showShellGpsChrome(){
    try{ qs('shellHome')?.classList.add('hidden'); }catch(e){}
    try{ qs('shellTop')?.classList.add('visible'); }catch(e){}
    try{ qs('shellDock')?.classList.add('visible'); }catch(e){}
    try{ if(typeof setDockActive==='function') setDockActive('gps'); }catch(e){}
    try{ if(typeof pushShellRoute==='function') pushShellRoute('gps'); }catch(e){}
  }
  function revealCoursePicker(){
    var cs=qs('courseScreen');
    if(cs){ cs.classList.remove('hidden'); cs.style.display='flex'; cs.style.pointerEvents='auto'; }
  }
  function refreshMapSoon(){
    try{ if(window.map && map.invalidateSize){ setTimeout(function(){map.invalidateSize();},80); setTimeout(function(){map.invalidateSize();},260); } }catch(e){}
  }
  function rescueActiveCourse(){
    try{if(typeof currentCourse!=="undefined"&&currentCourse&&currentCourse.name)return currentCourse;}catch(e){}
    try{var raw=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");if(raw&&raw.name)return raw;}catch(e){}
    try{var name=String(qs("courseLine")?.textContent||"").trim();if(name&&!/^manual gps$/i.test(name))return {name:name,courseName:name,courseId:name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")};}catch(e){}
    return null;
  }
  function rescueIsManualCourse(course){
    try{if(typeof gdCoursePayloadIsManual==="function")return gdCoursePayloadIsManual(course);}catch(e){}
    return /^manual gps$/i.test(String(course?.name||course?.courseName||""));
  }
  function rescueForceHoleOne(course){
    if(!course||rescueIsManualCourse(course))return false;
    try{if(typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset())return false;}catch(e){}
    try{selectedHole=1;currentPlayingHole=1;}catch(e){}
    try{sessionStorage.setItem("gd_active_playing_hole","1");sessionStorage.setItem("gd_mapper_active_hole","1");}catch(e){}
    try{document.body.classList.add("gdMappedCourseMode");document.body.classList.remove("manual-gps-active");}catch(e){}
    try{if(typeof setHole==="function")setHole({hole:1});}catch(e){}
    try{mode="start";}catch(e){}
    try{if(typeof setState==="function")setState("Mapped: set position");}catch(e){}
    try{
      var h=qs("hint");
      if(h){
        h.classList.add("gdMappedStartPill","visible");
        if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(h);
        else h.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
        if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame();
      }
    }catch(e){}
    return true;
  }
  function rescueScheduleHoleOne(){
    [220,760,1500,2600].forEach(function(delay){
      setTimeout(function(){
        try{if(typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset())return;}catch(e){}
        var cs=qs("courseScreen");
        var pickerOpen=cs&&!cs.classList.contains("hidden")&&getComputedStyle(cs).display!=="none"&&getComputedStyle(cs).visibility!=="hidden";
        if(pickerOpen)return;
        var course=rescueActiveCourse();
        if(!course||rescueIsManualCourse(course))return;
        try{
          if(typeof window.gdScheduleCoursePickerFirstHoleOpen==="function")window.gdScheduleCoursePickerFirstHoleOpen(course);
          else if(typeof window.gdOpenCourseToFirstHole==="function")window.gdOpenCourseToFirstHole(course);
        }catch(e){}
      },delay);
    });
  }
  function enterGps(opts){
    opts=opts||{};
    closePanels();
    setGpsClasses();
    showShellGpsChrome();
    revealCoursePicker();
    refreshMapSoon();
    try{ localStorage.setItem('gd_last_module','gps'); }catch(e){}
    rescueScheduleHoleOne();
  }
  function runPlayRoute(opts){
    opts=opts||{};
    try{
      const current=window.enterGpsModule;
      if(typeof current==="function"&&current!==enterGps)return current.call(window,opts);
    }catch(e){}
    const result=enterGps(opts);
    rescueScheduleHoleOne();
    return result;
  }
  window.enterGpsModule = enterGps;
  window.gdEnterPlay = runPlayRoute;
  window.gdOpenGpsModule = runPlayRoute;
  window.startPlay = runPlayRoute;

  function labelOf(el){ return ((el.getAttribute('aria-label')||'')+' '+(el.title||'')+' '+(el.textContent||'')).toLowerCase().replace(/\s+/g,' ').trim(); }
  function isPlayButton(el){
    if(!el || el.__gdPlayRescueBound) return false;
    if(el.closest&&el.closest('#courseScreen')) return false;
    var t=labelOf(el);
    if(!t) return false;
	    return t==='play' || t.indexOf('clarity caddy')>=0 || t.indexOf('open gps')>=0 || t.indexOf('gps module')>=0 || t.indexOf('player mode')>=0 || t.indexOf('start manual')>=0 || t.indexOf('continue a round')>=0;
  }
  function bindPlayButtons(){
    try{
      document.querySelectorAll('button,.shellTile,[data-action],[role="button"]').forEach(function(el){
        if(!isPlayButton(el)) return;
        el.__gdPlayRescueBound=true;
        el.addEventListener('click',function(ev){
          ev.preventDefault(); ev.stopPropagation();
          runPlayRoute({fromPlay:true});
        },true);
      });
    }catch(e){}
  }
	  bindPlayButtons();
	  setTimeout(bindPlayButtons,120);
	  setTimeout(bindPlayButtons,600);
	  document.addEventListener('DOMContentLoaded',function(){ bindPlayButtons(); setTimeout(bindPlayButtons,120); setTimeout(bindPlayButtons,600); });
	  window.addEventListener('load',function(){ bindPlayButtons(); setTimeout(bindPlayButtons,500); });
  window.gdBindPlayButtons = bindPlayButtons;
})();


function gdGoToPlayManualRound(){
  try{
    if(typeof unlockShotFrame === "function") unlockShotFrame("manual-round");
  }catch(e){}
  try{
    if(typeof enterTwoTapMode === "function"){ enterTwoTapMode(); return; }
  }catch(e){}
  try{
    if(typeof setGpsMode === "function"){ setGpsMode("twoTap"); }
  }catch(e){}
  try{
    if(typeof showScreen === "function"){ showScreen("gps"); }
    else if(typeof showView === "function"){ showView("gps"); }
    else if(typeof navigateTo === "function"){ navigateTo("gps"); }
  }catch(e){}
  try{
    document.body.classList.remove("show-course-search","course-search-open","search-open");
    document.body.classList.add("gps-open");
  }catch(e){}
  try{
    const gps=document.getElementById("gpsScreen")||document.getElementById("gpsView")||document.getElementById("playScreen");
    if(gps) gps.style.display="";
    const home=document.getElementById("homeScreen")||document.getElementById("homeView");
    if(home) home.style.display="none";
  }catch(e){}
}



(function(){
  function wireManualRound(){
    const candidates=[...document.querySelectorAll("button,a,[role='button'],.tile,.home-tile")].filter(el=>{
      const t=(el.textContent||"").toLowerCase();
      const id=((el.id||"")+" "+(el.className||"")+" "+(el.getAttribute("data-action")||"")+" "+(el.getAttribute("data-route")||"")).toLowerCase();
      return t.includes("manual round") || id.includes("manualround") || id.includes("manual-round");
    });
    candidates.forEach(el=>{
      el.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        gdGoToPlayManualRound();
      }, true);
    });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", wireManualRound);
  else wireManualRound();
})();



function gdStartManualGpsFromSearchOverlay(){
  try{
    // Close course/search overlay without resetting the map.
    document.body.classList.remove(
      "show-course-search",
      "course-search-open",
      "search-open",
      "course-picker-open",
      "finding-course"
    );
    document.body.classList.add("gps-open", "manual-gps-active");
  }catch(e){}

  try{
    const overlays=[...document.querySelectorAll(".course-search,.course-search-overlay,.course-picker,.find-course,.search-panel,.course-modal,[data-course-search],[data-course-picker]")];
    overlays.forEach(el=>{
      el.style.display="none";
      el.classList.remove("open","active","visible","show");
    });
  }catch(e){}

  try{
    if(typeof unlockShotFrame === "function") unlockShotFrame("manual-gps-play");
  }catch(e){}

  try{
    if(typeof clearLockedShotState === "function") clearLockedShotState("manual-gps-play");
  }catch(e){}

  try{
    if(typeof enterTwoTapMode === "function"){ enterTwoTapMode(); }
    else if(typeof setGpsMode === "function"){ setGpsMode("twoTap"); }
  }catch(e){}

  try{
    if(typeof showScreen === "function") showScreen("gps");
    else if(typeof showView === "function") showView("gps");
    else if(typeof navigateTo === "function") navigateTo("gps");
  }catch(e){}

  try{
    const manualButtons=[...document.querySelectorAll("button,a,[role='button']")].filter(el=>{
      const text=(el.textContent||"").trim().toLowerCase();
      const card=(el.closest(".manual-gps,.manualGPS,.manual-card,.course-result,.find-course,.course-search,.course-picker")||{}).textContent||"";
      return text==="play" && card.toLowerCase().includes("manual gps");
    });
    manualButtons.forEach(el=>el.classList.add("manual-gps-play-wired"));
  }catch(e){}
}

function gdWireManualGpsPlayButton(){
  const candidates=[...document.querySelectorAll("button,a,[role='button']")].filter(el=>{
    const label=(el.textContent||"").trim().toLowerCase();
    if(label!=="play") return false;
    const parentText=(el.closest("div,section,article,li")||{}).textContent || "";
    const widerText=(el.closest(".course-search,.course-picker,.find-course,.course-modal,.sheet,.panel")||{}).textContent || "";
    return parentText.toLowerCase().includes("manual gps") || widerText.toLowerCase().includes("manual gps");
  });

  candidates.forEach(el=>{
    if(el.dataset.gdManualGpsWired==="1") return;
    el.dataset.gdManualGpsWired="1";
    el.addEventListener("click", function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      gdStartManualGpsFromSearchOverlay();
    }, true);
  });
}

(function(){
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", gdWireManualGpsPlayButton);
  else gdWireManualGpsPlayButton();
  setTimeout(gdWireManualGpsPlayButton, 250);
  setTimeout(gdWireManualGpsPlayButton, 1000);
})();



(function(){
  function gdManualGpsButtonHardWire(){
    var btns=[].slice.call(document.querySelectorAll('#courseScreen .course .play'));
    btns.forEach(function(btn){
      var card=btn.closest('.course');
      if(!card || !/Manual GPS/i.test(card.textContent||'')) return;
      if(btn.dataset.gdHardManualPlay==='1') return;
      btn.dataset.gdHardManualPlay='1';
      btn.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        openCourse({name:'Manual GPS'});
        return false;
      }, true);
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', gdManualGpsButtonHardWire);
  else gdManualGpsButtonHardWire();
  setTimeout(gdManualGpsButtonHardWire,100);
  setTimeout(gdManualGpsButtonHardWire,600);
  setTimeout(gdManualGpsButtonHardWire,1600);
})();

/* ==== section: gd-inline-clarity-caddie-gps-bag-prompt-return.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy GPS bag prompt return path v1 --- */
(function(){
  'use strict';
  function safe(fn){ try{return fn();}catch(e){} }
	  function setGpsMapVisible(){
	    safe(()=>window.GDShell?.enterGps?.({source:'bag-return',replace:true,preserveState:true}));
    safe(()=>document.getElementById('shellHome')?.classList.add('hidden'));
    safe(()=>document.getElementById('shellTop')?.classList.add('visible'));
    safe(()=>document.getElementById('shellDock')?.classList.add('visible'));
    safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
    safe(()=>{ if(typeof setDockActive==='function') setDockActive('gps'); });
    safe(()=>{ if(typeof pushShellRoute==='function') pushShellRoute('gps'); });
    safe(()=>{ if(typeof map!=='undefined'&&map&&map.invalidateSize){ setTimeout(()=>map.invalidateSize(),60); setTimeout(()=>map.invalidateSize(),240); } });
    safe(()=>{ if(typeof renderShot==='function') renderShot(); });
    safe(()=>{ if(typeof gdV62Refresh==='function') gdV62Refresh(); });
    safe(()=>{ if(typeof window.gdApplyGpsMapVisibilityOwner==='function') window.gdApplyGpsMapVisibilityOwner('bag-return'); });
  }
  window.gdReturnToGpsMapFromBag=function(){
    safe(()=>sessionStorage.removeItem('gd_return_from_bag_to_gps'));
    safe(()=>document.querySelectorAll('.panel.open,.modulePanel.open').forEach(p=>p.classList.remove('open')));
    setGpsMapVisible();
  };
  window.gdOpenBagFromGps=function(ev){
    if(ev){ ev.preventDefault(); ev.stopPropagation(); }
    safe(()=>sessionStorage.setItem('gd_return_from_bag_to_gps','1'));
    if(typeof openBag==='function') openBag({fromGps:true});
    return false;
  };
  /* The plays pill slides out beside the main distance, so it needs to be positioned
     against that distance rather than against the card. Anchoring it to the card by
     coordinates would need a top offset that is only right while every row above it
     is present, and the back marker collapses when it has no value - the pill would
     then point at the wrong row.

     It cannot simply be moved INSIDE #tileDist either: gdResetShotDistanceDisplay
     and the per-frame distance render both rewrite that element's innerHTML, which
     would delete the pill the first time the number changed. So a wrapper is
     inserted around the distance and the pill sits in there instead - the wrapper is
     never written to, and #tileDist keeps its id and its own content untouched. */
  safe(()=>{
    const dist=document.getElementById('tileDist');
    const plays=document.getElementById('tilePlays');
    if(!dist||!plays||!dist.parentElement)return;
    let anchor=dist.parentElement;
    if(!anchor.classList.contains('gdDistAnchor')){
      anchor=document.createElement('div');
      anchor.className='gdDistAnchor';
      dist.parentElement.insertBefore(anchor,dist);
      anchor.appendChild(dist);
    }
    if(plays.parentElement!==anchor)anchor.appendChild(plays);
  });
  const previousClosePanel=window.closePanel;
  if(typeof previousClosePanel==='function'&&!previousClosePanel.__gdBagReturnWrapped){
    const wrapped=function(id){
      const shouldReturn=id==='bagPanel'&&safe(()=>sessionStorage.getItem('gd_return_from_bag_to_gps')==='1');
      const result=previousClosePanel.apply(this,arguments);
      if(shouldReturn) setTimeout(()=>window.gdReturnToGpsMapFromBag(),40);
      return result;
    };
    wrapped.__gdBagReturnWrapped=true;
    window.closePanel=wrapped;
  }
})();
