/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy GPS bag prompt return path v1 --- */
(function(){
  'use strict';
  function safe(fn){ try{return fn();}catch(e){} }
  function setGpsMapVisible(){
    safe(()=>document.body.classList.add('gdGpsActive','gps-active','shell-gps'));
    safe(()=>document.body.classList.remove('shell-home','shell-module'));
    safe(()=>document.getElementById('shellHome')?.classList.add('hidden'));
    safe(()=>document.getElementById('shellTop')?.classList.add('visible'));
    safe(()=>document.getElementById('shellDock')?.classList.add('visible'));
    safe(()=>document.getElementById('courseScreen')?.classList.add('hidden'));
    safe(()=>{ if(typeof setDockActive==='function') setDockActive('gps'); });
    safe(()=>{ if(typeof pushShellRoute==='function') pushShellRoute('gps'); });
    safe(()=>{ if(typeof map!=='undefined'&&map&&map.invalidateSize){ setTimeout(()=>map.invalidateSize(),60); setTimeout(()=>map.invalidateSize(),240); } });
    safe(()=>{ if(typeof renderShot==='function') renderShot(); });
    safe(()=>{ if(typeof gdV62Refresh==='function') gdV62Refresh(); });
  }
  window.gdReturnToGpsMapFromBag=function(){
    safe(()=>sessionStorage.removeItem('gd_return_from_bag_to_gps'));
    safe(()=>document.querySelectorAll('.panel.open,.modulePanel.open').forEach(p=>p.classList.remove('open')));
    setGpsMapVisible();
  };
  window.gdOpenBagFromGps=function(ev){
    if(ev){ ev.preventDefault(); ev.stopPropagation(); }
    safe(()=>sessionStorage.setItem('gd_return_from_bag_to_gps','1'));
    if(typeof openBag==='function') openBag();
    return false;
  };
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
