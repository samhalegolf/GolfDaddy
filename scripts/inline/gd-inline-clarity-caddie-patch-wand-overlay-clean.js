/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddie patch: Wand overlay clean v1
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
