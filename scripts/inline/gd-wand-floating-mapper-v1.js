/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  'use strict';
  function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
  function panel(){return document.getElementById('gdWandPanel');}
  let userMoved=false;
  let floatObserver=null;
  let dragInstalled=false;
  function bounds(p){
    return {
      minLeft:8,
      minTop:8,
      maxLeft:Math.max(8,window.innerWidth-p.offsetWidth-8),
      maxTop:Math.max(8,window.innerHeight-p.offsetHeight-10)
    };
  }
  function setPanelPos(p,left,top){
    p.style.setProperty('left',`${left}px`,'important');
    p.style.setProperty('top',`${top}px`,'important');
    p.style.setProperty('right','auto','important');
    p.style.setProperty('bottom','auto','important');
  }
  function clearPanelPos(p){
    ['left','top','right','bottom','width'].forEach(prop=>p.style.removeProperty(prop));
  }
  function keepInView(p,force=false){
    if(!p||p.classList.contains('hidden'))return;
    if(p.classList.contains('gdWandDragging'))return;
    if(userMoved&&!force)return;
    const rect=p.getBoundingClientRect();
    const b=bounds(p);
    const left=clamp(rect.left,b.minLeft,b.maxLeft);
    const top=clamp(rect.top,b.minTop,b.maxTop);
    if(Math.abs(left-rect.left)>1||Math.abs(top-rect.top)>1){
      p.classList.add('gdWandFloatingMoved');
      setPanelPos(p,left,top);
    }
  }
  function resetDefaultPosition(p){
    if(!p||userMoved)return;
    p.classList.remove('gdWandFloatingMoved');
    clearPanelPos(p);
  }
  function positionDefault(p){
    if(!p||userMoved||p.classList.contains('hidden'))return;
    p.classList.remove('gdWandFloatingMoved');
    clearPanelPos(p);
  }
  function install(){
    const p=panel();
    if(!p)return;
    if(!floatObserver){
      floatObserver=new MutationObserver(()=>setTimeout(()=>{positionDefault(p);},20));
      floatObserver.observe(p,{attributes:true,attributeFilter:['class']});
      window.addEventListener('resize',()=>keepInView(p,true));
    }
    const handle=p;
    if(!handle||dragInstalled)return;
    dragInstalled=true;
    let drag=null;
    handle.addEventListener('pointerdown',ev=>{
      if(ev.target.closest('button,input,summary,details,label,select,textarea'))return;
      const rect=p.getBoundingClientRect();
      drag={dx:ev.clientX-rect.left,dy:ev.clientY-rect.top};
      userMoved=true;
      p.classList.add('gdWandDragging','gdWandFloatingMoved');
      setPanelPos(p,rect.left,rect.top);
      p.style.setProperty('width',`${rect.width}px`,'important');
      try{p.setPointerCapture(ev.pointerId);}catch(e){}
      ev.preventDefault();
    });
    handle.addEventListener('pointermove',ev=>{
      if(!drag)return;
      const b=bounds(p);
      setPanelPos(p,clamp(ev.clientX-drag.dx,b.minLeft,b.maxLeft),clamp(ev.clientY-drag.dy,b.minTop,b.maxTop));
    });
    function endDrag(ev){
      if(!drag)return;
      drag=null;
      p.classList.remove('gdWandDragging');
      try{p.releasePointerCapture(ev.pointerId);}catch(e){}
    }
    handle.addEventListener('pointerup',endDrag);
    handle.addEventListener('pointercancel',endDrag);
    setTimeout(()=>{positionDefault(p);},80);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
  setTimeout(install,300);
  setTimeout(install,1200);
})();
