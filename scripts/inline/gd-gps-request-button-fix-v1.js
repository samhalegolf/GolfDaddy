/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  function safe(fn){try{return fn()}catch(e){console.warn("[GolfDaddy] GPS request button",e)}}
  function requestGps(event){
    if(event){
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    }
    if(typeof window.gdGpsLocateNow==="function")return window.gdGpsLocateNow();
    if(typeof window.refreshGPS==="function")return window.refreshGPS();
    if(typeof window.initGPS==="function")return window.initGPS();
    if(navigator.geolocation){
      safe(()=>navigator.geolocation.getCurrentPosition(()=>{},()=>{},{
        enableHighAccuracy:true,
        maximumAge:0,
        timeout:15000
      }));
    }
    return false;
  }
  function ensureGpsRailButton(){
    const rail=document.querySelector(".rightRail");
    if(!rail){console.warn("[Clarity Caddie] right rail shell is missing");return;}
    let btn=document.getElementById("gpsRailBtn");
    if(!btn){
      console.warn("[Clarity Caddie] final rail button missing: gpsRailBtn");
      return;
    }
    btn.type="button";
    btn.classList.add("railBtn","gdGpsRecenterBtn");
    btn.setAttribute("aria-label","GPS locate");
    btn.title="GPS locate";
    if(!btn.querySelector("img")&&!btn.querySelector(".gdGpsRailText")){
      btn.innerHTML='<span class="gdGpsRailText">GPS</span>';
    }
    btn.onclick=requestGps;
  }
  function wireHint(){
    document.querySelectorAll("#hint,.hint").forEach(el=>{
      if(!/Tap GPS and allow location/i.test(el.textContent||""))return;
      el.classList.add("gdGpsRequestHint");
      el.setAttribute("role","button");
      el.setAttribute("tabindex","0");
      el.setAttribute("aria-label","Request GPS location");
      if(!el.__gdGpsRequestHint){
        el.__gdGpsRequestHint=true;
        el.addEventListener("click",requestGps,true);
        el.addEventListener("keydown",event=>{
          if(event.key==="Enter"||event.key===" ")requestGps(event);
        },true);
      }
    });
  }
  function refresh(){ensureGpsRailButton();wireHint();}
  window.gdRequestGpsNow=requestGps;
  refresh();
  document.addEventListener("DOMContentLoaded",()=>setTimeout(refresh,80));
  document.addEventListener("click",event=>{
    const target=event.target&&event.target.closest&&event.target.closest("#hint.gdGpsRequestHint,.hint.gdGpsRequestHint,#gpsRailBtn");
    if(target)requestGps(event);
  },true);
  setInterval(refresh,900);
})();
