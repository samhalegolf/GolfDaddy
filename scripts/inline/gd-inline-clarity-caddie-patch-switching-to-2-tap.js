/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddie patch: switching to 2-Tap unlocks the soft-locked frame v1 --- */
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
