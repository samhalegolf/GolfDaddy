/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- GPS wand active chrome sync v1 --- */
(function(){
  'use strict';
  function isWandOpen(){
    const panel=document.getElementById('gdWandPanel');
    const classic=document.getElementById('wandPanel');
    return !!((panel && !panel.classList.contains('hidden')) || (classic && classic.classList.contains('open')));
  }
  function sync(){
    const live=!!window.gdWandAcceptedLive;
    const active=isWandOpen()||live;
    const btn=document.getElementById('greenToolBtn');
    if(btn) btn.classList.toggle('gdWandActive',active);
    if(btn) btn.classList.toggle('gdWandLive',live);
    document.body.classList.toggle('gdWandActive',active);
    document.body.classList.toggle('gdWandLayerActive',isWandOpen());
    document.body.classList.toggle('gdWandLive',live);
  }
  function wrap(name){
    const fn=window[name];
    if(typeof fn!=='function' || fn.__gdWandChromeWrapped) return;
    const wrapped=function(){
      const result=fn.apply(this,arguments);
      setTimeout(sync,20);
      setTimeout(sync,180);
      return result;
    };
    wrapped.__gdWandChromeWrapped=true;
    window[name]=wrapped;
  }
  function install(){
    wrap('openGpsWand');
    wrap('toggleGreenWand');
    wrap('closeWandPanel');
    wrap('acceptGreenWand');
    wrap('rejectGreenWand');
    sync();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',install);
  else install();
  document.addEventListener('click',()=>setTimeout(sync,60),true);
  setTimeout(install,300);
  setTimeout(sync,1000);
})();
