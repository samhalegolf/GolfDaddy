/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsAutoSessionV1)return;
  window.__gdGpsAutoSessionV1=true;
  var KEY="gd_gps_auto_session_v1";
  var STALE_MS=35*60*1000;
  var RECENT_MS=2*60*60*1000;
  var MOVED_M=90;
  var ON_COURSE_M=650;
  var promptOpen=false;
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function isGps(){
    return document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
  }
  function plainPoint(value){
    if(!value)return null;
    var ll=safe(function(){return typeof value.getLatLng==="function"?value.getLatLng():value;},value);
    var lat=Number(ll&&ll.lat),lng=Number(ll&&ll.lng);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat:lat,lng:lng}:null;
  }
  function distanceM(a,b){
    if(!a||!b)return 0;
    var R=6371000,rad=function(x){return Number(x)*Math.PI/180;};
    var dLat=rad(b.lat-a.lat),dLng=rad(b.lng-a.lng);
    var lat1=rad(a.lat),lat2=rad(b.lat);
    var h=Math.sin(dLat/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
    return 2*R*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
  }
  function read(){
    try{return JSON.parse(localStorage.getItem(KEY)||"null");}catch(e){return null;}
  }
  function write(payload){
    try{localStorage.setItem(KEY,JSON.stringify(payload));}catch(e){}
  }
  function courseLabel(){
    return String(
      safe(function(){return document.getElementById("courseLine").textContent;},"")||
      safe(function(){return sessionStorage.getItem("gd_assumed_course_name");},"")||
      "GPS round"
    ).trim();
  }
  function activeCourse(){
    return safe(function(){
      var api=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
      var course=null;
      if(typeof api.loadUserCourseData==="function")course=api.loadUserCourseData();
      if(!course&&window.gdActiveCourse)course=window.gdActiveCourse;
      if(!course&&window.currentCourse)course=window.currentCourse;
      if(!course&&typeof currentCourse!=="undefined")course=currentCourse;
      return course||null;
    },null);
  }
  function holeCount(){
    return safe(function(){
      if(typeof scorecard!=="undefined"&&scorecard&&Array.isArray(scorecard.holes)&&scorecard.holes.length)return scorecard.holes.length;
      var course=activeCourse();
      if(course&&Array.isArray(course.holes)&&course.holes.length)return course.holes.length;
      return 18;
    },18)||18;
  }
  function collectPoints(value,points,depth){
    points=points||[];
    depth=depth||0;
    if(!value||depth>5)return points;
    var direct=plainPoint(value);
    if(direct){
      points.push(direct);
      return points;
    }
    if(Array.isArray(value)){
      if(value.length===2&&Number.isFinite(Number(value[0]))&&Number.isFinite(Number(value[1]))){
        points.push({lat:Number(value[0]),lng:Number(value[1])});
        return points;
      }
      value.forEach(function(item){collectPoints(item,points,depth+1);});
      return points;
    }
    if(typeof value==="object"){
      if(Number.isFinite(Number(value.latitude))&&Number.isFinite(Number(value.longitude))){
        points.push({lat:Number(value.latitude),lng:Number(value.longitude)});
      }
      if(Number.isFinite(Number(value.lat))&&Number.isFinite(Number(value.lon))){
        points.push({lat:Number(value.lat),lng:Number(value.lon)});
      }
      ["position","center","centre","green","tee","pin","front","middle","back","route","shape","greenShape","points","path","markers"].forEach(function(key){
        if(Object.prototype.hasOwnProperty.call(value,key))collectPoints(value[key],points,depth+1);
      });
    }
    return points;
  }
  function mappedHoleData(course,hole){
    var api=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
    return safe(function(){
      if(course&&typeof api.mappedHolePlayData==="function")return api.mappedHolePlayData(course,hole);
      if(course&&typeof window.gdMappedHolePlayData==="function")return window.gdMappedHolePlayData(course,hole);
      if(course&&Array.isArray(course.holes))return course.holes[hole-1]||null;
      if(typeof scorecard!=="undefined"&&scorecard&&Array.isArray(scorecard.holes))return scorecard.holes[hole-1]||null;
      return null;
    },null);
  }
  function nearestHoleTo(point){
    if(!point)return null;
    var course=activeCourse();
    var count=holeCount();
    var best=null;
    for(var h=1;h<=count;h++){
      var points=collectPoints(mappedHoleData(course,h),[]);
      for(var i=0;i<points.length;i++){
        var d=distanceM(point,points[i]);
        if(!best||d<best.distance)best={hole:h,distance:d};
      }
    }
    return best;
  }
  function currentHoleNumber(){
    return Number(safe(function(){
      return currentPlayingHole||selectedHole||sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole")||1;
    },1))||1;
  }
  function gdCanAutoSwitchHole(context){
    return !!(context&&context.explicitUserAction===true);
  }
  window.gdCanAutoSwitchHole=gdCanAutoSwitchHole;
  function playHole(h,reason){
    if(!h)return false;
    safe(function(){sessionStorage.setItem("gd_active_playing_hole",String(h));sessionStorage.setItem("gd_mapper_active_hole",String(h));});
    safe(function(){currentPlayingHole=selectedHole=Number(h)||1;});
    if(typeof window.gdPlayHoleFromScorecard==="function"){
      safe(function(){window.gdPlayHoleFromScorecard(h,{source:reason||"gps-auto-nearest"});});
    }else{
      safe(function(){if(typeof setHole==="function")setHole({hole:h});});
      safe(function(){if(typeof window.enterGpsModule==="function")window.enterGpsModule({fromBack:true,preserve:true,replace:true});});
    }
    safe(function(){if(typeof toast==="function")toast("Continuing on H"+h);});
    snapshot("nearest-hole-resume");
    return true;
  }
  function ensureNearestSuggestion(){
    var el=document.getElementById("gdGpsNearestSuggestion");
    if(el)return el;
    el=document.createElement("button");
    el.id="gdGpsNearestSuggestion";
    el.className="gdGpsNearestSuggestion";
    el.type="button";
    document.body.appendChild(el);
    return el;
  }
  function showNearestHoleSuggestion(match,source){
    var h=Number(match&&match.hole)||0;
    if(!h||h===currentHoleNumber())return false;
    var el=ensureNearestSuggestion();
    el.textContent="Nearest hole found - tap to switch to H"+h;
    el.dataset.hole=String(h);
    el.dataset.source=source||"gps-auto-nearest";
    el.onclick=function(event){
      event.preventDefault();
      event.stopPropagation();
      el.classList.remove("open");
      playHole(h,"nearest-hole-suggestion");
    };
    el.classList.add("open");
    safe(function(){if(typeof toast==="function")toast("Nearest hole found - tap to switch to H"+h);});
    return true;
  }
	  function autoResumeNearest(saved,here,age){
	    if(window.__gdGpsLocateQuarantineV1!==false)return false;
	    if(!saved||!here||age>RECENT_MS)return false;
	    var nearest=nearestHoleTo(here);
    if(!nearest||!Number.isFinite(nearest.distance)||nearest.distance>ON_COURSE_M)return false;
    return showNearestHoleSuggestion(nearest,"gps-auto-nearest");
  }
  function snapshot(reason){
    if(!isGps())return null;
    var startPoint=plainPoint(safe(function(){return start;},null)||safe(function(){return window.start;},null));
    var targetPoint=plainPoint(safe(function(){return target;},null)||safe(function(){return window.target;},null));
    var hole=safe(function(){return currentPlayingHole||selectedHole||sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole")||1;},1);
    var payload={
      version:1,
      reason:reason||"auto",
      updatedAt:Date.now(),
      course:courseLabel(),
      hole:Number(hole)||1,
      mode:safe(function(){return mode;},""),
      start:startPoint,
      target:targetPoint,
      hasShot:!!(startPoint||targetPoint),
      route:"gps"
    };
    write(payload);
    return payload;
  }
  function ensurePrompt(){
    var el=document.getElementById("gdGpsResumePrompt");
    if(el)return el;
    el=document.createElement("div");
    el.id="gdGpsResumePrompt";
    el.className="gdGpsResumePrompt";
    el.innerHTML='<div><strong>Continue last round?</strong><span></span></div><div class="gdGpsResumePromptActions"><button class="gdGpsResumeNew" type="button">Start new round</button><button class="gdGpsResumeContinue" type="button">Continue</button></div>';
    document.body.appendChild(el);
    el.querySelector(".gdGpsResumeContinue").onclick=function(event){
      event.preventDefault();
      event.stopPropagation();
      promptOpen=false;
      el.classList.remove("open");
      restore(read());
    };
    el.querySelector(".gdGpsResumeNew").onclick=function(event){
      event.preventDefault();
      event.stopPropagation();
      promptOpen=false;
      el.classList.remove("open");
      try{localStorage.removeItem(KEY);}catch(e){}
      safe(function(){if(typeof resetPlay==="function")resetPlay(true);});
      snapshot("new-round");
    };
    return el;
  }
  function restore(saved){
    if(!saved)return;
    safe(function(){sessionStorage.setItem("gd_active_playing_hole",String(saved.hole||1));sessionStorage.setItem("gd_mapper_active_hole",String(saved.hole||1));});
    safe(function(){currentPlayingHole=selectedHole=Number(saved.hole||1)||1;});
    if(saved.start)safe(function(){
      var ll=L.latLng(saved.start.lat,saved.start.lng);
      if(typeof setStart==="function")setStart(ll,false);
      else start=ll;
    });
    if(saved.target)safe(function(){
      target=L.latLng(saved.target.lat,saved.target.lng);
      if(typeof createTargetMarker==="function")createTargetMarker(target);
      if(typeof renderShot==="function")renderShot();
    });
    safe(function(){if(typeof toast==="function")toast("Last round restored");});
    snapshot("continue-round");
  }
  function showPrompt(saved,moved){
    if(promptOpen||!saved)return;
    promptOpen=true;
    var el=ensurePrompt();
    var age=Math.max(1,Math.round((Date.now()-Number(saved.updatedAt||0))/60000));
    var detail=String(saved.course||"Last round")+" · H"+(saved.hole||1)+" · "+age+" min ago";
    if(Number.isFinite(moved)&&moved>0)detail+=" · moved "+Math.round(moved)+"m";
    var line=el.querySelector("span");
    if(line)line.textContent=detail;
    el.classList.add("open");
  }
  function maybePrompt(savedOverride){
    var saved=savedOverride||read();
    if(!saved||!saved.updatedAt||!saved.hasShot)return;
    var age=Date.now()-Number(saved.updatedAt||0);
    if(!navigator.geolocation){
      if(age>=STALE_MS)showPrompt(saved,0);
      return;
    }
    navigator.geolocation.getCurrentPosition(function(pos){
      var here={lat:pos.coords.latitude,lng:pos.coords.longitude};
      if(autoResumeNearest(saved,here,age))return;
      var moved=distanceM(saved.start||saved.target,here);
      if(age>=STALE_MS&&(moved>MOVED_M||age>2*STALE_MS))showPrompt(saved,moved);
    },function(){
      if(age>=STALE_MS)showPrompt(saved,0);
    },{enableHighAccuracy:false,maximumAge:60000,timeout:3500});
  }
  function wrapGpsEntry(){
    if(typeof window.enterGpsModule!=="function"||window.enterGpsModule.__gdAutoSessionWrapped)return;
    var old=window.enterGpsModule;
    var wrapped=function(opts){
      var previous=read();
      var result=old.apply(this,arguments);
      setTimeout(function(){
        if(!(opts&&(opts.fromBack||opts.preserve||opts.preserveState||opts.keepGps)))maybePrompt(previous);
        snapshot("enter-gps");
      },350);
      return result;
    };
    wrapped.__gdAutoSessionWrapped=true;
    window.enterGpsModule=wrapped;
    safe(function(){enterGpsModule=wrapped;});
  }
  window.gdSaveGpsSession=function(reason){return snapshot(reason||"manual");};
  window.gdPromptGpsSessionResume=maybePrompt;
  setInterval(function(){snapshot("interval");},8000);
  ["pointerup","touchend","click"].forEach(function(type){
    document.addEventListener(type,function(){if(isGps())setTimeout(function(){snapshot(type);},120);},true);
  });
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wrapGpsEntry);
  else wrapGpsEntry();
  setTimeout(wrapGpsEntry,600);
  setTimeout(wrapGpsEntry,1600);
})();
