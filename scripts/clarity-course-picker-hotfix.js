(function(){
  "use strict";
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function currentPoint(){
    return safe(function(){
      if(typeof window.gdCoursePickerDefaultPoint==="function")return window.gdCoursePickerDefaultPoint();
      if(window.start&&Number.isFinite(Number(start.lat))&&Number.isFinite(Number(start.lng)))return {lat:Number(start.lat),lng:Number(start.lng)};
      if(window.map&&typeof map.getCenter==="function"){
        var c=map.getCenter();
        if(c&&Number.isFinite(Number(c.lat))&&Number.isFinite(Number(c.lng)))return {lat:Number(c.lat),lng:Number(c.lng)};
      }
      return {lat:-36.9149,lng:174.7255};
    },{lat:-36.9149,lng:174.7255});
  }
  function openManualGps(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();if(ev.stopImmediatePropagation)ev.stopImmediatePropagation();}
    var p=currentPoint();
    var payload={name:"Manual GPS",courseName:"Manual GPS",lat:p.lat,lng:p.lng,source:"manual-gps"};
    if(typeof window.gdOpenCoursePickerCourse==="function")return window.gdOpenCoursePickerCourse(payload);
    if(typeof window.openCourse==="function")return window.openCourse(payload);
    return false;
  }
  function ensureManualButton(){
    var screen=document.getElementById("courseScreen");
    var card=screen&&screen.querySelector(".courseCard");
    if(!card)return;
    var btn=document.getElementById("gdManualGpsSubtleBtn");
    if(!btn){
      btn=document.createElement("button");
      btn.id="gdManualGpsSubtleBtn";
      btn.className="gdManualGpsSubtleBtn";
      btn.type="button";
      btn.innerHTML='<span>Manual GPS</span>';
      btn.addEventListener("click",openManualGps,true);
      card.appendChild(btn);
    }
    // If the recommender has fallen back to Manual GPS, keep that as a quiet fallback action
    // instead of a large top recommendation card.
    var option=document.getElementById("gdCourseAssumedOption");
    var manual=!!(option&&/manual gps/i.test(option.dataset.gdCourseName||option.textContent||""));
    if(option)option.classList.toggle("gdManualOnlySuggestion",manual);
    document.body.classList.toggle("gdCoursePickerManualOnly",manual);
  }
  function sync(){ensureManualButton();}
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",sync); else sync();
  [80,300,900,1800].forEach(function(ms){setTimeout(sync,ms)});
  document.addEventListener("click",function(){setTimeout(sync,0);},true);
  window.gdSyncCoursePickerHotfix=sync;
})();
