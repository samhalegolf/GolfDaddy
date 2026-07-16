/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- GPS viewport lock v1 ---
   Prevents the oversized Leaflet surface from dragging the shell above the viewport. */
(function(){
  'use strict';
  function safe(fn){try{return fn()}catch(e){console.warn('[GD gps viewport]',e);}}
  function isGpsSurface(){
    return document.body.classList.contains('shell-gps') ||
      document.body.classList.contains('gdGpsActive') ||
      document.body.classList.contains('gps-active');
  }
  function resetScroll(){
    safe(()=>window.scrollTo(0,0));
    safe(()=>{document.documentElement.scrollTop=0;});
    safe(()=>{document.body.scrollTop=0;});
    const app=document.getElementById('app');
    if(app) safe(()=>{app.scrollTop=0;});
  }
  function invalidateMapSoon(){
    safe(()=>{
      if(window.map && typeof window.map.invalidateSize==='function'){
        setTimeout(()=>window.map.invalidateSize(false),40);
      }
    });
  }
  function syncGpsViewport(){
    if(!isGpsSurface()){
      document.documentElement.classList.remove('gdGpsViewportLocked');
      return;
    }
    document.documentElement.classList.add('gdGpsViewportLocked');
    resetScroll();
    const top=document.getElementById('shellTop');
    if(top) top.classList.add('visible');
  }
  function wrapGpsEntry(name){
    const fn=window[name];
    if(typeof fn!=='function'||fn.__gdGpsViewportLockWrapped) return;
    const wrapped=function(){
      const result=fn.apply(this,arguments);
      requestAnimationFrame(syncGpsViewport);
      setTimeout(syncGpsViewport,80);
      setTimeout(invalidateMapSoon,90);
      return result;
    };
    wrapped.__gdGpsViewportLockWrapped=true;
    window[name]=wrapped;
    safe(()=>{if(name==='enterGpsModule')enterGpsModule=wrapped});
    safe(()=>{if(name==='gdEnterTwoTapNoLocation')gdEnterTwoTapNoLocation=wrapped});
    safe(()=>{if(name==='showGpsSurface')showGpsSurface=wrapped});
    safe(()=>{if(name==='ensureGpsSurfaceWithoutReset')ensureGpsSurfaceWithoutReset=wrapped});
  }
  ['enterGpsModule','gdEnterTwoTapNoLocation','showGpsSurface','ensureGpsSurfaceWithoutReset'].forEach(wrapGpsEntry);
  if(document.body){
    new MutationObserver(()=>requestAnimationFrame(syncGpsViewport))
      .observe(document.body,{attributes:true,attributeFilter:['class']});
  }
  window.addEventListener('resize',()=>{syncGpsViewport();invalidateMapSoon();},{passive:true});
  window.addEventListener('orientationchange',()=>setTimeout(()=>{syncGpsViewport();invalidateMapSoon();},80),{passive:true});
  window.addEventListener('scroll',()=>{if(isGpsSurface())resetScroll();},{passive:true});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',syncGpsViewport);
  else syncGpsViewport();
  setTimeout(syncGpsViewport,120);
  setTimeout(syncGpsViewport,600);
})();
