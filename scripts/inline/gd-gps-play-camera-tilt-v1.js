/* GPS Play camera tilt: simple presentation-layer candidates for published hole surfaces. */
(function(){
  if(window.__gdGpsPlayCameraTiltV1)return;
  window.__gdGpsPlayCameraTiltV1=true;

  var STORAGE_KEY="gd_gps_play_camera_tilt_deg_v1";
  var STEPS=[0,8,14,20,26,32];

  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function nearestStep(value){
    value=Number(value);
    if(!Number.isFinite(value))value=0;
    var best=STEPS[0],bestDiff=Infinity;
    STEPS.forEach(function(step){
      var diff=Math.abs(step-value);
      if(diff<bestDiff){best=step;bestDiff=diff;}
    });
    return best;
  }
  function readTilt(){
    return nearestStep(safe(function(){return localStorage.getItem(STORAGE_KEY);},0));
  }
  function labelFor(deg){
    deg=nearestStep(deg);
    return deg>0?String(deg)+" deg":"Flat";
  }
  function scaleFor(deg){
    deg=nearestStep(deg);
    return (1+deg/150).toFixed(3);
  }
  function setButtonState(button,deg){
    if(!button)return;
    var label=labelFor(deg);
    button.dataset.gdTiltLabel=label;
    button.setAttribute("aria-label","Camera tilt "+label);
    button.title="Camera tilt: "+label;
    var text=button.querySelector("[data-gd-tilt-value]");
    if(text)text.textContent=label;
  }
  function syncControls(){
    var deg=readTilt();
    var fab=document.getElementById("gdGpsPlayCameraTiltBtn");
    var settings=document.getElementById("gdGpsCameraTiltToggle");
    setButtonState(fab,deg);
    setButtonState(settings,deg);
    var sub=document.getElementById("gdGpsCameraTiltSub");
    if(sub)sub.textContent=deg>0?"Testing "+labelFor(deg):"Flat view";
  }
  function applyTilt(deg){
    deg=nearestStep(deg);
    safe(function(){localStorage.setItem(STORAGE_KEY,String(deg));});
    if(document.documentElement){
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-deg",String(deg)+"deg");
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-scale",scaleFor(deg));
    }
    if(document.body){
      document.body.classList.toggle("gdGpsPlayCameraTiltOn",deg>0);
      document.body.dataset.gdGpsPlayCameraTiltDeg=String(deg);
    }
    syncControls();
    return deg;
  }
  function cycleTilt(event){
    if(event){
      event.preventDefault();
      event.stopPropagation();
    }
    var current=readTilt();
    var index=STEPS.indexOf(current);
    var next=STEPS[(index+1)%STEPS.length];
    applyTilt(next);
    return false;
  }
  function iconMarkup(){
    return '<svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><path d="M7 31h34" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M11 25l26-9" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M16 35h16" stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity=".72"/></svg><span data-gd-tilt-value></span>';
  }
  function ensureFab(){
    if(!document.body)return null;
    var button=document.getElementById("gdGpsPlayCameraTiltBtn");
    if(button)return button;
    button=document.createElement("button");
    button.id="gdGpsPlayCameraTiltBtn";
    button.className="gdGpsPlayCameraTiltBtn";
    button.type="button";
    button.innerHTML=iconMarkup();
    button.addEventListener("click",cycleTilt);
    document.body.appendChild(button);
    return button;
  }
  function ensureSettingsRow(){
    var panel=document.getElementById("settingsPanel");
    if(!panel||document.getElementById("gdGpsCameraTiltRow"))return;
    var anchor=safe(function(){return document.getElementById("shotUpToggle").closest(".row");},null)||
      document.getElementById("gdMappedPlayModeRow");
    if(!anchor||!anchor.parentNode)return;
    var row=document.createElement("div");
    row.className="row";
    row.id="gdGpsCameraTiltRow";
    row.innerHTML='<div><strong>Camera tilt</strong><span id="gdGpsCameraTiltSub">Flat view</span></div><button class="toggle" id="gdGpsCameraTiltToggle" type="button"><span data-gd-tilt-value>Flat</span></button>';
    row.querySelector("button").addEventListener("click",cycleTilt);
    anchor.parentNode.insertBefore(row,anchor.nextSibling);
  }
  function init(){
    ensureFab();
    ensureSettingsRow();
    applyTilt(readTilt());
  }

  window.gdCycleGpsPlayCameraTilt=cycleTilt;
  window.gdSetGpsPlayCameraTilt=function(deg){return applyTilt(deg);};
  window.gdGetGpsPlayCameraTilt=function(){return readTilt();};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
  [300,900,1800].forEach(function(delay){setTimeout(init,delay);});
})();
