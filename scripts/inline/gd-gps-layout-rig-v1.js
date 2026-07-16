/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsLayoutRigV1)return;
  window.__gdGpsLayoutRigV1=true;
  function ensureRig(){
    var rig=document.getElementById("gdGpsLayoutRig");
    if(rig)return rig;
    rig=document.createElement("div");
    rig.id="gdGpsLayoutRig";
    rig.className="gdGpsLayoutRig";
    rig.innerHTML=[
      '<button class="gdRigToggle" type="button">Preview Shot End</button>',
      '<div class="gdRigZone gdRigTop"><span>top controls</span></div>',
      '<div class="gdRigZone gdRigRail"><span>tool rail</span></div>',
      '<div class="gdRigZone gdRigShot"><span>shot card</span></div>',
      '<div class="gdRigZone gdRigHole"><span>hole nav</span></div>',
      '<div class="gdRigZone gdRigUnlock"><span>unlock</span></div>',
      '<div class="gdRigZone gdRigAction"><span>shot end</span></div>',
      '<div class="gdRigZone gdRigMap"><span>map focus</span></div>'
    ].join("");
    document.body.appendChild(rig);
    rig.querySelector(".gdRigToggle").addEventListener("click",function(event){
      event.preventDefault();
      event.stopPropagation();
      document.body.classList.toggle("gdGpsLayoutPreviewLogShot");
      try{ if(typeof window.gdSyncNewShotButtonState==="function")window.gdSyncNewShotButtonState(); }catch(e){}
      renderPreviewButton();
    });
    return rig;
  }
  function renderPreviewButton(){
    var btn=document.getElementById("gdV62LogShotBtn");
    if(!btn||!document.body.classList.contains("gdGpsLayoutRigOn"))return;
    if(!document.body.classList.contains("gdGpsLayoutPreviewLogShot"))return;
    btn.classList.add("pending");
    btn.classList.remove("unlock-ready");
    btn.innerHTML='<svg class="gdLogShotIcon" viewBox="0 0 100 100" aria-hidden="true"><path class="gdShakeEcho faint" d="M25 25c-5 1-8 4-8 9l9 41c1 5 4 8 9 8h3"/><path class="gdShakeEcho" d="M32 24c-5 1-8 4-8 9l5 42c1 5 4 8 9 8h4"/><path class="gdShakeEcho" d="M68 24c5 1 8 4 8 9l-5 42c-1 5-4 8-9 8h-4"/><path class="gdShakeEcho faint" d="M75 25c5 1 8 4 8 9l-9 41c-1 5-4 8-9 8h-3"/><rect class="gdPhoneFace" x="36" y="22" width="28" height="58" rx="7"/><rect class="gdPhoneIsland" x="46" y="27.2" width="8" height="2.8" rx="1.4"/><circle class="gdCameraLens" cx="52.6" cy="28.6" r=".65"/><rect class="gdSideButton" x="33.9" y="34.5" width="2.1" height="5.8" rx="1"/><rect class="gdSideButton" x="33.9" y="42.6" width="2.1" height="5.4" rx="1"/><rect class="gdSideButton" x="64" y="35.5" width="2.1" height="7.5" rx="1"/><path class="gdTopArrow" d="M35 16c9-7 21-7 30 0"/><path class="gdTopArrowHead" d="M35.8 11.6 29.8 17l7.6 2.4Z"/><path class="gdTopArrowHead" d="M64.2 11.6 70.2 17l-7.6 2.4Z"/></svg><span class="gdLogShotText">Shot End</span>';
    btn.title="Tap where the shot finished. You can also shake your phone to log it.";
  }
  function setRig(on){
    ensureRig();
    document.body.classList.toggle("gdGpsLayoutRigOn",!!on);
    if(!on)document.body.classList.remove("gdGpsLayoutPreviewLogShot");
    try{localStorage.setItem("gd_gps_layout_rig_v1",on?"1":"0");}catch(e){}
    setTimeout(renderPreviewButton,60);
    return !!on;
  }
  window.gdGpsLayoutRig=function(on){
    if(typeof on==="undefined")on=!document.body.classList.contains("gdGpsLayoutRigOn");
    return setRig(!!on);
  };
  function boot(){
    var should=false;
    try{should=new URLSearchParams(location.search).get("gdGpsLayout")==="1"||localStorage.getItem("gd_gps_layout_rig_v1")==="1";}catch(e){}
    if(should)setRig(true);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
  else boot();
  setInterval(renderPreviewButton,700);
})();
