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
