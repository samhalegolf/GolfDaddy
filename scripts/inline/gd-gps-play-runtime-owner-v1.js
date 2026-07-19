/* ============================================================================
 * GPS PLAY OWNER — consolidated from 7 patch-layer files (Phase A, 2026-07-19).
 * Sections appear in their original load order; each was a self-contained IIFE
 * and is unchanged. Future GPS-play fixes belong IN this file, not in new layers.
 * ============================================================================ */

/* ==== section: gd-gps-layout-rig-v1.js ==== */
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

/* ==== section: gd-gps-auto-session-v1.js ==== */
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

/* ==== section: gd-gps-mapped-camera-and-green-focus-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdGpsMappedCameraAndGreenFocusV1) return;
  window.__gdGpsMappedCameraAndGreenFocusV1 = true;

  const PRELOCK_PRESETS = [
    { label:"Hole", maxZoom:16, padTop:112, padBottom:150, padX:62 },
    { label:"Ready", maxZoom:17, padTop:74, padBottom:118, padX:48 },
    { label:"Tight", maxZoom:18, padTop:42, padBottom:78, padX:28 }
  ];
  let prelockPresetIndex = 1;
  let framingCamera = false;
  let beforeZoom = null;
  let promptWasActive = false;
  let greenFocusWasActive = false;
  let shotEndPressTimer = null;

	  function safe(fn, fallback){
	    try { return fn(); } catch (_) { return fallback; }
	  }

	  function isGpsActive(){
	    return !!document.body.classList.contains("gdGpsActive") || !!document.body.classList.contains("shell-gps");
	  }

  function mappedAssist(){
    return safe(function(){ return typeof gdMappedCourseAssistActive === "function" && gdMappedCourseAssistActive(); }, false);
  }

  function mappedPromptActive(){
    const h = document.getElementById("hint");
    return !!(isGpsActive() && mappedAssist() && document.body.classList.contains("gdMappedStartPromptActive") && h && h.classList.contains("gdMappedStartPill") && h.classList.contains("visible"));
  }

  function currentHole(){
    const candidates = [
      safe(function(){ return currentPlayingHole; }, null),
      safe(function(){ return selectedHole; }, null),
      safe(function(){ return sessionStorage.getItem("gd_active_playing_hole"); }, null),
      safe(function(){ return sessionStorage.getItem("gd_mapper_active_hole"); }, null),
      safe(function(){ return gdMappedStartHoleNumber(); }, null)
    ];
    for(const raw of candidates){
      const n = Number(raw);
      if(Number.isFinite(n) && n >= 1) return Math.max(1, Math.min(36, Math.round(n)));
    }
    return 1;
  }

  function payload(){
    return safe(function(){ return gdActiveMappedHolePlayData(); }, null) || {};
  }

  function toLatLng(point){
    return safe(function(){ return gdMappedPointToLatLng(point); }, null);
  }

  function routeFor(data){
    const route = safe(function(){ return gdMappedRouteLatLngs(data); }, []);
    return Array.isArray(route) ? route.filter(Boolean) : [];
  }

  function greenShapeFor(data){
    const shape = safe(function(){ return gdMappedGreenShapeLatLngs(data); }, []);
    return Array.isArray(shape) ? shape.filter(Boolean) : [];
  }

  function averageLatLng(points){
    if(!Array.isArray(points) || !points.length) return null;
    let lat = 0, lng = 0, count = 0;
    points.forEach(function(p){
      if(p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))){
        lat += Number(p.lat);
        lng += Number(p.lng);
        count++;
      }
    });
    return count ? L.latLng(lat / count, lng / count) : null;
  }

  function mappedGreen(data, route, shape){
    return toLatLng(data?.green?.position) ||
      toLatLng(data?.green?.center) ||
      toLatLng(data?.green?.centre) ||
      toLatLng(data?.green?.pin) ||
      averageLatLng(shape) ||
      route[route.length - 1] ||
      null;
  }

  function mappedTee(data, route){
    return toLatLng(data?.tee?.position) || route[0] || null;
  }

  function cameraData(){
    const p = payload();
    const data = p && p.data;
    if(!data || !data.complete) return null;
    const route = routeFor(data);
    const shape = greenShapeFor(data);
    const tee = mappedTee(data, route);
    const green = mappedGreen(data, route, shape);
    if(!tee || !green) return null;
    return { hole:p.hole || currentHole(), course:p.course || null, data, route, shape, tee, green };
  }

  function boundsAroundGreen(green, shape){
    const points = (shape && shape.length ? shape.slice() : []).filter(Boolean);
    if(!points.length && green){
      for(let i = 0; i < 10; i++){
        const a = (Math.PI * 2 * i) / 10;
        points.push(project(green, a, 34));
      }
    }
    if(green) points.push(green);
    const live = safe(function(){ return start; }, null);
    if(live && green && map && map.distance && map.distance(live, green) <= 70) points.push(live);
    return points.length >= 2 ? L.latLngBounds(points) : null;
  }

  function removeLayer(layer){
    safe(function(){ if(layer && map && map.removeLayer) map.removeLayer(layer); });
  }

  function removeGreenFocusChrome(){
    if(!document.body.classList.contains("gdGreenArrivalMode")) return;
    [
      { get:function(){ return greenOutline; }, clear:function(){ greenOutline = null; } },
      { get:function(){ return greenSoft; }, clear:function(){ greenSoft = null; } },
      { get:function(){ return greenLabel; }, clear:function(){ greenLabel = null; } },
      { get:function(){ return frontLabel; }, clear:function(){ frontLabel = null; } },
      { get:function(){ return backLabel; }, clear:function(){ backLabel = null; } },
      { get:function(){ return greenMarker; }, clear:function(){ greenMarker = null; } },
      { get:function(){ return middleGuideLine; }, clear:function(){ middleGuideLine = null; } },
      { get:function(){ return middleGuideLabel; }, clear:function(){ middleGuideLabel = null; } },
      { get:function(){ return remainingGreenLine; }, clear:function(){ remainingGreenLine = null; } },
      { get:function(){ return remainingGreenLabel; }, clear:function(){ remainingGreenLabel = null; } }
    ].forEach(function(entry){
      safe(function(){
        removeLayer(entry.get());
        entry.clear();
      });
    });
    document.querySelectorAll(".greenLabel,.yardLabel.edgeLabel,.remainingGreenLabel,.gdMiddleGuideLabel").forEach(function(el){
      const marker = el.closest(".leaflet-marker-icon,.leaflet-marker-pane > *");
      if(marker) marker.style.display = "none";
    });
  }

  function syncMappedGestures(){
    if(typeof map === "undefined" || !map || !isGpsActive() || !mappedAssist()) return;
    const constrained = mappedPromptActive() || document.body.classList.contains("gdGreenArrivalMode");
    try { map.options.zoomSnap = 1; } catch (_) {}
    if(constrained){
      safe(function(){ map.dragging && map.dragging.disable(); });
      safe(function(){ map.touchZoom && map.touchZoom.enable(); });
      safe(function(){ map.scrollWheelZoom && map.scrollWheelZoom.enable(); });
      safe(function(){ map.doubleClickZoom && map.doubleClickZoom.disable(); });
      safe(function(){ map.boxZoom && map.boxZoom.disable(); });
      safe(function(){ map.keyboard && map.keyboard.disable(); });
    }
  }

  function capturedSurfaceOwnsCamera(){
    return safe(function(){
      return document.body.classList.contains("gdCapturedHoleFrameCameraOn") ||
        document.body.dataset.gdCapturedSurfaceOwner === "captured-surface" ||
        !!(window.gdCapturedSurfacePolicy && window.gdCapturedSurfacePolicy.owner === "captured-surface");
    }, false);
  }

  function framePrelockPreset(index, opts){
    opts = opts || {};
    if(typeof map === "undefined" || !map || !mappedAssist()) return false;
    if(capturedSurfaceOwnsCamera()) return true;
    const cam = cameraData();
    if(!cam) return false;
    const preset = PRELOCK_PRESETS[Math.max(0, Math.min(PRELOCK_PRESETS.length - 1, index))] || PRELOCK_PRESETS[1];
    prelockPresetIndex = PRELOCK_PRESETS.indexOf(preset);
    const points = [
      ...cam.route,
      ...cam.shape,
      cam.tee,
      cam.green
    ].filter(Boolean);
    if(points.length < 2) return false;
    framingCamera = true;
    document.body.classList.add("gdMappedSnapCameraActive");
    safe(function(){
      if(typeof gdOrientGpsCameraToBearing === "function") gdOrientGpsCameraToBearing(bearing(cam.tee, cam.green), "pre-lock", { immediate: opts.immediate });
    });
    safe(function(){
      map.fitBounds(L.latLngBounds(points), {
        paddingTopLeft: [preset.padX, preset.padTop],
        paddingBottomRight: [preset.padX, preset.padBottom],
        animate: opts.animate !== false,
        duration: opts.duration || .28,
        maxZoom: preset.maxZoom
      });
    });
    setTimeout(function(){
      safe(function(){
        if(map.getZoom && map.getZoom() > preset.maxZoom) map.setZoom(preset.maxZoom, { animate:false });
      });
      beforeZoom = safe(function(){ return map.getZoom(); }, beforeZoom);
      framingCamera = false;
      document.body.classList.remove("gdMappedSnapCameraActive");
      updateZoomButtonLabel();
    }, 320);
    syncMappedGestures();
    return true;
  }

  function frameGreenFocus(opts){
    opts = opts || {};
    if(typeof map === "undefined" || !map) return false;
    const cam = cameraData();
    const green = opts.green || cam?.green || safe(function(){ return greenCentre || target; }, null);
    if(!green) return false;
    const shape = opts.shape || cam?.shape || [];
    const b = boundsAroundGreen(green, shape);
    if(!b) return false;
    if(capturedSurfaceOwnsCamera() && typeof window.gdFitCapturedHoleFrameToBoxV19 === "function"){
      return !!window.gdFitCapturedHoleFrameToBoxV19(b, "zoom", .016, {
        objectName:"greenFocusCapturedOwner",
        reason:"green-focus-captured-owner",
        fitRatio:.62,
        maxScale:4.8
      });
    }
    framingCamera = true;
    removeGreenFocusChrome();
    safe(function(){
      const orientFrom = cam?.tee || start || null;
      if(orientFrom && typeof gdOrientGpsCameraToBearing === "function") {
        gdOrientGpsCameraToBearing(bearing(orientFrom, green), "green-focus", { immediate: opts.immediate });
      }
    });
    safe(function(){
      map.fitBounds(b, {
        paddingTopLeft: [34, 86],
        paddingBottomRight: [34, 188],
        animate: opts.animate !== false,
        duration: .30,
        maxZoom: 20
      });
    });
    setTimeout(function(){
      removeGreenFocusChrome();
      framingCamera = false;
    }, 260);
    syncMappedGestures();
    return true;
  }

  function recentGpsLatLng(){
    return safe(function(){
      const fix = window.gdGpsState && window.gdGpsState.lastFix;
      if(!fix || !Number.isFinite(Number(fix.lat)) || !Number.isFinite(Number(fix.lng))) return null;
      return L.latLng(Number(fix.lat), Number(fix.lng));
    }, null);
  }

  function activateGreenFocus(reason){
    const cam = cameraData();
    const green = cam?.green || safe(function(){ return greenCentre || target; }, null);
    if(!green){
      safe(function(){ toast("Green is not mapped yet"); });
      return false;
    }
    safe(function(){
      if(Number.isFinite(Number(cam?.hole))){
        currentPlayingHole = selectedHole = Number(cam.hole);
        sessionStorage.setItem("gd_active_playing_hole", String(cam.hole));
        sessionStorage.setItem("gd_mapper_active_hole", String(cam.hole));
      }
    });
    const fix = recentGpsLatLng();
    let live = fix || safe(function(){ return start; }, null);
    if(!live || (map && map.distance && map.distance(live, green) > 90)) live = green;
    safe(function(){ if(typeof setStart === "function") setStart(live, false); else start = live; });
    safe(function(){ greenCentre = green; });
    safe(function(){ if(!target) target = green; });
    safe(function(){
      if(greenMarker) greenMarker.setLatLng(green);
      else greenMarker = L.circleMarker(green, { radius:8, color:"#1fd36d", weight:2, opacity:.82, fillColor:"#1fd36d", fillOpacity:.08, interactive:false }).addTo(map);
    });
    safe(function(){ mode = "aim"; });
    safe(function(){ hideHint(); });
    safe(function(){ document.body.classList.remove("gdMappedStartPromptActive"); });
    safe(function(){ if(typeof renderShot === "function") renderShot(); });
    safe(function(){ if(typeof updatePinLine === "function") updatePinLine(); });
    safe(function(){ if(typeof window.gdSetGreenArrivalMode === "function") window.gdSetGreenArrivalMode(true, reason || "green-focus"); });
    removeGreenFocusChrome();
    frameGreenFocus({ green, shape:cam?.shape || [], animate:true });
    safe(function(){ if(typeof toast === "function") toast("Green focus"); });
    return false;
  }

  window.gdActivateGreenFocusForCurrentHole = activateGreenFocus;
  window.gdFrameMappedPreLockPreset = framePrelockPreset;

  function updateZoomButtonLabel(){
    const btn = document.getElementById("gdGpsSnapZoomBtn");
    if(!btn) return;
    const preset = PRELOCK_PRESETS[prelockPresetIndex] || PRELOCK_PRESETS[1];
    const locked = safe(function(){ return !!(start && target && lockedFrame); }, false);
    btn.title = locked ? "Zoom: locked shot" : "Zoom: " + preset.label;
    btn.setAttribute("aria-label", btn.title);
    btn.dataset.zoomPreset = preset.label.toLowerCase();
  }

  function handleMappedZoomButton(){
    if(document.body.classList.contains("gdGreenArrivalMode")){
      frameGreenFocus({ animate:false, immediate:true });
      return false;
    }
    const hasLockedShot = safe(function(){ return !!(start && target && lockedFrame); }, false);
    const hasActiveShot = safe(function(){ return !!(start && target); }, false);
    if(hasLockedShot || (hasActiveShot && !mappedPromptActive())){
      safe(function(){ if(typeof lockFrame === "function") lockFrame(false); });
      safe(function(){ if(typeof renderShot === "function") renderShot(); });
      updateZoomButtonLabel();
      return false;
    }
    prelockPresetIndex = (prelockPresetIndex + 1) % PRELOCK_PRESETS.length;
    if(mappedPromptActive()){
      framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true });
      return false;
    }
    if(typeof window.gdFocusMappedPreLockHole === "function"){
      window.gdFocusMappedPreLockHole(safe(function(){ return currentPlayingHole || selectedHole || gdMappedStartHoleNumber(); }, 1), { source:"zoom-rail" });
      return false;
    }
    framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true });
    return false;
  }

  function ensureZoomButton(){
    if(!isGpsActive()) return;
    const rail = document.querySelector(".rightRail");
    if(!rail) return;
    let btn = document.getElementById("gdGpsSnapZoomBtn");
    if(!btn){
      btn = document.createElement("button");
      btn.id = "gdGpsSnapZoomBtn";
      btn.className = "railBtn gdGpsSnapZoomBtn";
      btn.type = "button";
      btn.innerHTML = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="21" cy="21" r="11" fill="none" stroke-width="4"/><path d="M30 30l9 9" fill="none" stroke-width="4" stroke-linecap="round"/><path d="M21 15v12M15 21h12" fill="none" stroke-width="3.5" stroke-linecap="round"/></svg>';
      rail.appendChild(btn);
    }
    if(!btn.__gdSnapZoomBound){
      btn.__gdSnapZoomBound = true;
      btn.addEventListener("click", function(event){
        event.preventDefault();
        event.stopPropagation();
        handleMappedZoomButton();
        safe(function(){ if(typeof haptic === "function") haptic(8); });
      }, true);
    }
    updateZoomButtonLabel();
  }

  function installMapZoomSnap(){
    if(typeof map === "undefined" || !map || map.__gdMappedSnapZoomInstalled) return;
    map.__gdMappedSnapZoomInstalled = true;
    map.on("zoomstart", function(){
      if(!mappedPromptActive() || framingCamera) return;
      beforeZoom = safe(function(){ return map.getZoom(); }, beforeZoom);
    });
    map.on("zoomend", function(){
      if(!mappedPromptActive() || framingCamera) return;
      const after = safe(function(){ return map.getZoom(); }, beforeZoom);
      const delta = Number(after) - Number(beforeZoom);
      if(Math.abs(delta) < .16) return;
      prelockPresetIndex = Math.max(0, Math.min(PRELOCK_PRESETS.length - 1, prelockPresetIndex + (delta > 0 ? 1 : -1)));
      framePrelockPreset(prelockPresetIndex, { animate:true });
    });
    map.on("dragstart", function(){
      if(mappedPromptActive() || document.body.classList.contains("gdGreenArrivalMode")){
        safe(function(){ map.dragging.disable(); });
      }
    });
  }

  function bindShotEndLongPress(){
    const btn = document.getElementById("gdV62LogShotBtn");
    if(!btn || btn.__gdGreenFocusLongPressBound) return;
    btn.__gdGreenFocusLongPressBound = true;
    const cancel = function(){
      clearTimeout(shotEndPressTimer);
      shotEndPressTimer = null;
    };
    btn.addEventListener("pointerdown", function(event){
      if(!isGpsActive()) return;
      btn.__gdGreenFocusLongPressed = false;
      clearTimeout(shotEndPressTimer);
      shotEndPressTimer = setTimeout(function(){
        btn.__gdGreenFocusLongPressed = true;
        safe(function(){ if(typeof haptic === "function") haptic(30); });
        activateGreenFocus("shot-end-long-press");
      }, 680);
    }, true);
    ["pointerup","pointercancel","pointerleave","lostpointercapture"].forEach(function(type){
      btn.addEventListener(type, cancel, true);
    });
    btn.addEventListener("click", function(event){
      if(btn.__gdGreenFocusLongPressed){
        event.preventDefault();
        event.stopPropagation();
        if(event.stopImmediatePropagation) event.stopImmediatePropagation();
        btn.__gdGreenFocusLongPressed = false;
        return false;
      }
      return undefined;
    }, true);
  }

  const oldQueuePreLock = window.gdQueueMappedPreLockHoleFrame;
  if(typeof oldQueuePreLock === "function"){
    window.gdQueueMappedPreLockHoleFrame = function(){
      const result = oldQueuePreLock.apply(this, arguments);
      prelockPresetIndex = Math.max(1, prelockPresetIndex);
      setTimeout(function(){ framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true }); }, 40);
      setTimeout(function(){ framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true }); }, 220);
      return result;
    };
  }

  const oldReturnPreLock = window.gdReturnToPreLockPrompt;
  if(typeof oldReturnPreLock === "function"){
    window.gdReturnToPreLockPrompt = function(){
      const result = oldReturnPreLock.apply(this, arguments);
      setTimeout(function(){ framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true }); }, 80);
      return result;
    };
  }

  function tick(){
    ensureZoomButton();
    installMapZoomSnap();
    syncMappedGestures();
    const greenFocusActive = document.body.classList.contains("gdGreenArrivalMode");
    if(greenFocusActive && !greenFocusWasActive) {
      frameGreenFocus({ animate:false, immediate:true });
    }
    if(greenFocusActive) removeGreenFocusChrome();
    greenFocusWasActive = greenFocusActive;
    const active = mappedPromptActive();
    if(active && !promptWasActive){
      prelockPresetIndex = 1;
      framePrelockPreset(prelockPresetIndex, { animate:false, immediate:true });
    }
    promptWasActive = active;
  }

  setInterval(tick, 650);
  document.addEventListener("DOMContentLoaded", function(){ setTimeout(tick, 120); });
  document.addEventListener("click", function(){ setTimeout(tick, 80); }, true);
})();

/* ==== section: gd-gps-state-stabilizer-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  if(window.__gdGpsStateStabilizerV1) return;
  window.__gdGpsStateStabilizerV1 = true;

  var lastForcedShotKey = "";
  var shotEndPressTimer = null;
  var shotEndLongPressed = false;
  var greenBallDrag = null;
  var greenFocusOutcomePoint = null;
  var greenFocusOutcomeAccuracy = null;
  var greenFocusSource = "";
	  var greenFocusEnteredAt = 0;
	  var greenFocusHadShotToLog = false;
	  var freshHolePreparingUntil = 0;
	  var lastObservedHole = null;
	  var normalHoleCleanupTimer = null;
	  var preLockFocusToken = 0;

	  function safe(fn, fallback){
	    try { return fn(); } catch (_) { return fallback; }
	  }

	  function byId(id){
	    return document.getElementById(id);
	  }

	  function stop(event){
	    if(!event) return;
	    if(event.preventDefault) event.preventDefault();
	    if(event.stopPropagation) event.stopPropagation();
	    if(event.stopImmediatePropagation) event.stopImmediatePropagation();
	  }

	  function point(value){
	    if(!value) return null;
	    var ll = safe(function(){ return typeof value.getLatLng === "function" ? value.getLatLng() : value; }, value);
	    var lat = Number(ll && ll.lat);
	    var lng = Number(ll && ll.lng);
	    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat:lat, lng:lng } : null;
	  }

	  function writeCapturedResume(reason){
	    safe(function(){
	      if(typeof window.gdSaveResumeRound === "function") window.gdSaveResumeRound(reason || "captured-owner");
	    });
	  }

	  function gpsActive(){
	    return !!(document.body && (
      document.body.classList.contains("gdGpsActive") ||
      document.body.classList.contains("gps-active") ||
      document.body.classList.contains("shell-gps")
    ));
  }

  function mappedAssist(){
    return safe(function(){ return typeof gdMappedCourseAssistActive === "function" && gdMappedCourseAssistActive(); }, false);
  }

  function currentHoleNumber(){
    return safe(function(){ return Number(currentPlayingHole || selectedHole || gdMappedStartHoleNumber && gdMappedStartHoleNumber()) || 1; }, 1);
  }

  function holeCountSafe(){
    return safe(function(){
      return Array.isArray(scorecard && scorecard.holes) && scorecard.holes.length ? scorecard.holes.length : 18;
    }, 18) || 18;
  }

  function nextHoleNumber(fromHole){
    var count = holeCountSafe();
    var current = Math.max(1, Math.min(count, Number(fromHole || currentHoleNumber()) || 1));
    return Math.min(count, current + 1);
  }

  function greenFocusRadiusM(){
    return 46;
  }

	  function recentGpsPoint(){
	    return safe(function(){
	      var last = window.gdGpsState && window.gdGpsState.lastFix;
	      if(!last || !Number.isFinite(Number(last.lat)) || !Number.isFinite(Number(last.lng))) return null;
	      return {
	        ll:L.latLng(Number(last.lat), Number(last.lng)),
	        accuracy:Number.isFinite(Number(last.accuracy)) ? Number(last.accuracy) : null
	      };
	    }, null);
	  }

	  function hasFreshRealGps(maxAgeMs){
	    return safe(function(){
	      var last = window.gdGpsState && window.gdGpsState.lastFix;
	      var at = Number(window.gdGpsState && window.gdGpsState.lastFixAt);
	      if(!last || !Number.isFinite(Number(last.lat)) || !Number.isFinite(Number(last.lng))) return false;
	      if(last.simulated === true || String(last.source || "").indexOf("click") >= 0 || String(last.source || "").indexOf("tap-where-standing") >= 0) return false;
	      return Number.isFinite(at) && Date.now() - at < (Number(maxAgeMs) || 90000);
	    }, false);
	  }
	  window.gdHasFreshLiveGpsFeed = hasFreshRealGps;

  function rememberGreenFocusLocation(point, accuracy, source){
    if(!point || !Number.isFinite(Number(point.lat)) || !Number.isFinite(Number(point.lng))) return false;
    window.gdGpsState = window.gdGpsState || {};
    window.gdGpsState.permissionKnown = true;
    window.gdGpsState.permissionGranted = true;
    window.gdGpsState.lastError = null;
    window.gdGpsState.lastFix = {
	      lat:Number(point.lat),
	      lng:Number(point.lng),
	      accuracy:Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
	      source:source || "green-focus",
	      simulated:/click|tap-where-standing/i.test(String(source || ""))
	    };
    window.gdGpsState.lastFixAt = Date.now();
    safe(function(){ gpsOk = true; });
    return true;
  }

  function mappedGreenPoint(){
    return safe(function(){
      var payload = typeof gdActiveMappedHolePlayData === "function" ? gdActiveMappedHolePlayData() : null;
      var data = payload && payload.data;
      if(!data) return null;
      var green = data.green || {};
      var candidates = [green.position, green.center, green.centre, green.pin];
      for(var i = 0; i < candidates.length; i++){
        var p = typeof gdMappedPointToLatLng === "function" ? gdMappedPointToLatLng(candidates[i]) : null;
        if(p) return p;
      }
      var route = typeof gdMappedRouteLatLngs === "function" ? gdMappedRouteLatLngs(data) : [];
      return Array.isArray(route) && route.length ? route[route.length - 1] : null;
    }, null);
  }

  function greenFocusGreen(){
    return safe(function(){ return greenCentre || pin || mappedGreenPoint() || target || null; }, null);
  }

	  function isNearGreenPoint(point){
	    var green = greenFocusGreen();
	    if(!point || !green || !map || !map.distance) return false;
	    return safe(function(){ return map.distance(point, green) <= greenFocusRadiusM(); }, false);
	  }

	  function greenFocusBounds(green, point){
    if(!green || typeof L === "undefined") return null;
    var points = [];
    points.push(green);
    if(point) points.push(point);
    safe(function(){
      var shape = typeof gdMappedGreenShapeLatLngs === "function" ? gdMappedGreenShapeLatLngs((gdActiveMappedHolePlayData() || {}).data) : [];
      if(Array.isArray(shape)) shape.forEach(function(p){ if(p) points.push(p); });
    });
    if(points.length < 2){
      for(var i = 0; i < 10; i++){
        var a = (Math.PI * 2 * i) / 10;
        points.push(project(green, a, 28));
      }
    }
    if(point && map && map.distance && map.distance(point, green) > 24){
      var brg = bearing(green, point);
      points.push(project(point, brg, 12));
      points.push(project(point, brg + Math.PI, 12));
    }
    return safe(function(){ return L.latLngBounds(points.filter(Boolean)); }, null);
  }

  function frameGreenFocusSurface(point){
    var green = greenFocusGreen();
    if(!green) return false;
    var bounds = greenFocusBounds(green, point || greenFocusOutcomePoint || green);
    var framed = false;
    safe(function(){
      if(bounds && typeof window.gdFitCapturedHoleFrameToBoxV19 === "function"){
        framed = !!window.gdFitCapturedHoleFrameToBoxV19(bounds, "zoom", .016, {
          objectName:"greenFocus",
          reason:"green-focus",
          fitRatio:.62,
          maxScale:4.8
        });
      }
    });
    if(!framed){
      safe(function(){
        if(bounds && map && map.fitBounds){
          map.fitBounds(bounds, {
            paddingTopLeft:[34, 78],
            paddingBottomRight:[34, 186],
            animate:true,
            duration:.28,
            maxZoom:20
          });
          framed = true;
        }
      });
    }
    safe(function(){ document.body.classList.add("gd-green-zoom-active"); });
    return framed;
  }

	  function setGreenFocusBallPoint(point, accuracy, source){
	    if(!point) return false;
	    greenFocusOutcomePoint = L.latLng(Number(point.lat), Number(point.lng));
		    greenFocusOutcomeAccuracy = Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
		    greenFocusSource = source || greenFocusSource || "manual";
		    window.__gdGreenFocusSettingBallUntil = Date.now() + 900;
	    safe(function(){
	      if(document.body&&document.body.dataset){
	        document.body.dataset.gdGreenFocusBallLat=String(Number(point.lat));
	        document.body.dataset.gdGreenFocusBallLng=String(Number(point.lng));
	        document.body.dataset.gdGreenFocusBallSource=source||greenFocusSource||"manual";
	      }
	    });
	    positionGreenFocusBall();
	    return true;
	  }

	  function enterGreenFocus(opts){
	    opts = opts || {};
	    if(!gpsActive() || (document.body.classList.contains("gdMappedStartPromptActive") && !opts.allowPrompt)) return false;
	    var green = greenFocusGreen();
	    if(!green) return false;
	    var gps = recentGpsPoint();
	    var point = opts.point || (gps && gps.ll) || safe(function(){ return start; }, null) || green;
	    var accuracy = opts.point ? opts.accuracy : (gps && gps.accuracy);
	    if(opts.requireNear !== false && !isNearGreenPoint(point)) return false;
	    if(opts.point) rememberGreenFocusLocation(point, accuracy, opts.source === "click" ? "click-where-standing" : (opts.source || "green-focus"));
	    greenFocusHadShotToLog = opts.hasShotToLog === true || (opts.hasShotToLog !== false && hasShotToLog());
    greenFocusEnteredAt = Date.now();
    document.body.classList.add("gdGreenArrivalMode", "gd-green-zoom-active");
    document.body.classList.remove("gdMappedStartPromptActive", "gdManualStartPlacementActive", "gdToolRailOpen", "gdLockStateFrameActive", "gd-frame-hard-locked", "gdHeadToTeeFrameActive", "gdBubbleLongPressZoomActive");
    window.__gdManualStandingPlacementActiveUntil = 0;
    resetPendingManualFlow();
	    safe(function(){ greenCentre = green; });
	    safe(function(){ if(typeof hideHint === "function") hideHint(); });
	    safe(function(){ if(typeof setBubbleOnlyLock === "function") setBubbleOnlyLock(false); });
	    safe(function(){ document.getElementById("shotTile")?.classList.remove("visible"); });
	    setGreenFocusBallPoint(point, accuracy, opts.source || (opts.point ? "click" : "gps"));
    frameGreenFocusSurface(greenFocusOutcomePoint);
    syncGreenFocusCleanVisuals();
    setStateSafe("On green · adjust ball then Shot End");
    toastSafe("Green focus");
    return true;
  }

  window.gdEnterGreenFocusMode = enterGreenFocus;
	  window.gdTryEnterGreenFocusFromPoint = function(point, source, opts){
	    opts = opts || {};
	    if(!point) return false;
	    var green=safe(function(){return greenFocusGreen()},null);
	    var distance=safe(function(){return point&&green&&map&&map.distance?map.distance(point,green):null},null);
	    var result = !!enterGreenFocus({
	      source:source || "click-where-standing",
		      point:point,
		      accuracy:opts.accuracy == null ? null : opts.accuracy,
		      requireNear:opts.requireNear !== false,
		      allowPrompt:!!opts.allowPrompt,
		      hasShotToLog:opts.hasShotToLog === true
		    });
	    window.__gdLastGreenFocusAttempt={
	      source:source||"click-where-standing",
	      point:point?{lat:Number(point.lat),lng:Number(point.lng)}:null,
	      green:green?{lat:Number(green.lat),lng:Number(green.lng)}:null,
	      distanceM:Number.isFinite(Number(distance))?Number(distance):null,
	      radiusM:greenFocusRadiusM(),
	      allowPrompt:!!opts.allowPrompt,
	      result:result,
	      prompt:!!document.body.classList.contains("gdMappedStartPromptActive"),
	      manual:!!document.body.classList.contains("gdManualStartPlacementActive"),
	      gps:gpsActive()
	    };
	    return result;
		  };

  function maybeEnterGreenFocusFromGps(){
    if(!gpsActive() || document.body.classList.contains("gdGreenArrivalMode")) return false;
    if(document.body.classList.contains("gdMappedStartPromptActive")) return false;
    var gps = recentGpsPoint();
    if(!gps || !isNearGreenPoint(gps.ll)) return false;
    return enterGreenFocus({ source:"gps", point:gps.ll, accuracy:gps.accuracy, hasShotToLog:hasShotToLog() });
  }

  function installGreenFocusClick(){
    var mapEl = safe(function(){ return map && map.getContainer ? map.getContainer() : document.getElementById("map"); }, null);
    if(!mapEl || document.__gdGreenFocusClickInstalled) return;
    document.__gdGreenFocusClickInstalled = true;
    safe(function(){ document.body.dataset.gdGreenFocusInstaller = "installed"; });
	    document.addEventListener("click", function(event){
	      safe(function(){ document.body.dataset.gdGreenFocusClick = "seen"; });
	      if(!gpsActive() || document.body.classList.contains("gdGreenArrivalMode")){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-state"; }); return; }
	      if(document.body.classList.contains("gdMappedStartPromptActive")){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-prompt"; }); return; }
	      if(typeof window.gdMapClickConsumed === "function" && window.gdMapClickConsumed()){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-consumed"; }); return; }
	      if(typeof window.gdLocationEventIsPlayOverlay === "function" && window.gdLocationEventIsPlayOverlay(event)){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-overlay-helper"; }); return; }
	      if(safe(function(){ return !!targetDragging || document.body.classList.contains("gdCapturedBubbleDragging"); }, false)){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-bubble-drag"; }); return; }
	      var blocked = event.target && event.target.closest && event.target.closest("button,a,input,select,textarea,.rightRail,#gdV62UndoDock,#shotTile,#hint,.panel,.modulePanel,#gdCapturedBubbleDragHit,.gdBubbleDragHit,.gdBubbleDragHitIcon,.targetDot,.startDot,.gdCapturedShotBubble,.gdCapturedShotCore,.gdCapturedShotSvg,.gdCapturedAimLine,.gdHoleImageOverlay,.gdAimRecognitionFleck,.gdMiddleGuideLabel,.remainingGreenLabel,.leaflet-marker-icon,.leaflet-interactive");
	      if(blocked){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-control"; }); return; }
      var frameEl = document.getElementById("gdHoleImageCameraLayer");
      var inMapSurface = safe(function(){
        if(mapEl.contains(event.target)) return true;
        if(frameEl && frameEl.contains(event.target)) return true;
        var rect = mapEl.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      }, false);
      if(!inMapSurface){ safe(function(){ document.body.dataset.gdGreenFocusClick = "blocked-surface"; }); return; }
      var ll = greenFocusLatLngFromClientEvent(event);
      safe(function(){
        var green = greenFocusGreen();
        var distance = ll && green && map && map.distance ? map.distance(ll, green) : null;
        document.body.dataset.gdGreenFocusClick = "surface:" + (Number.isFinite(Number(distance)) ? Math.round(distance) : "no-dist");
      });
      if(!ll || !isNearGreenPoint(ll)) return;
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation) event.stopImmediatePropagation();
      enterGreenFocus({ source:"click", point:ll, accuracy:null, hasShotToLog:hasShotToLog() });
      safe(function(){ document.body.dataset.gdGreenFocusClick = "entered"; });
    }, true);
  }

  function prepareFreshHoleScreen(reason){
    freshHolePreparingUntil = Date.now() + 1200;
    document.body.classList.remove("gdGreenArrivalMode", "gd-green-zoom-active", "gdLockStateFrameActive", "gd-frame-hard-locked");
    resetPendingManualFlow();
    greenBallDrag = null;
    removeGreenFocusBall();
    safe(function(){ if(typeof gdClearShotForNextStart === "function") gdClearShotForNextStart(null); });
    safe(function(){ if(typeof clearWandScaleLock === "function") clearWandScaleLock(reason || "fresh-hole"); });
    safe(function(){ if(map && map.dragging && !document.body.classList.contains("gdMappedStartPromptActive")) map.dragging.enable(); });
    safe(function(){
      var tile = document.getElementById("shotTile");
      if(tile) tile.classList.remove("visible");
    });
    setTimeout(function(){
      safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
      safe(function(){ if(typeof window.gdSyncPlayFlowRail === "function") window.gdSyncPlayFlowRail(); });
    }, 60);
    return false;
  }

  function clearNormalHoleChangeShotState(reason){
    freshHolePreparingUntil = Date.now() + 900;
    document.body.classList.remove("gdGreenArrivalMode", "gdMappedStartPromptActive", "gd-green-zoom-active", "gdLockStateFrameActive", "gd-frame-hard-locked");
    resetPendingManualFlow();
    greenBallDrag = null;
    removeGreenFocusBall();
    safe(function(){ if(typeof clearShot === "function") clearShot(); });
    safe(function(){ if(typeof gdResetShotDistanceDisplay === "function") gdResetShotDistanceDisplay(); });
    safe(function(){
      [startMarker,targetMarker,greenMarker,pinMarker,pinDirectionLine,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(removeLayer);
      startMarker=targetMarker=greenMarker=pinMarker=pinDirectionLine=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
    });
    safe(function(){ start=target=greenCentre=pin=null; });
    safe(function(){ currentShotLogged=false; gdCurrentPlannedShotId=null; targetWasMoved=false; gdWindLandingTarget=null; });
    safe(function(){ lockedFrame=false; });
    safe(function(){
      var tile = document.getElementById("shotTile");
      if(tile) tile.classList.remove("visible");
    });
    safe(function(){
      var appEl = document.getElementById("app");
      if(appEl){
        appEl.classList.remove("framed");
        appEl.classList.remove("gdPreLockFrame");
      }
    });
    setStateSafe("Hole " + currentHoleNumber());
    safe(function(){ if(typeof hideHint === "function") hideHint(); });
    setTimeout(function(){
      safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
      safe(function(){ if(typeof window.gdSyncPlayFlowRail === "function") window.gdSyncPlayFlowRail(); });
    }, 80);
    return false;
  }

  function scheduleNormalHoleChangeCleanup(reason){
    if(reason === "shot-end-green-focus") return;
    freshHolePreparingUntil = Date.now() + 1300;
    safe(function(){
      var tile = document.getElementById("shotTile");
      if(tile) tile.classList.remove("visible");
    });
    clearTimeout(normalHoleCleanupTimer);
    normalHoleCleanupTimer = setTimeout(function(){
      clearNormalHoleChangeShotState(reason || "normal-hole-change");
    }, 260);
  }

	  function showMappedPreLockPrompt(){
	    if(hasFreshRealGps()){
	      safe(function(){ document.body.classList.remove("gdMappedStartPromptActive"); });
	      safe(function(){ document.getElementById("app") && document.getElementById("app").classList.remove("gdPreLockFrame"); });
	      safe(function(){ if(typeof hideHint === "function") hideHint(); });
	      setStateSafe("GPS fixed · press Lock");
	      return;
	    }
	    safe(function(){
	      var hint = document.getElementById("hint");
      if(!hint) return;
      if(typeof gdRenderMappedStartHint === "function") gdRenderMappedStartHint(hint);
      else{
        hint.classList.add("gdMappedStartPill");
        hint.innerHTML = '<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
      }
      hint.classList.add("visible");
    });
    safe(function(){ document.body.classList.add("gdMappedCourseMode", "gdMappedStartPromptActive"); });
    safe(function(){ if(typeof window.gdSuppressShotForMappedStartPrompt === "function") window.gdSuppressShotForMappedStartPrompt(); });
    safe(function(){
      var appEl = document.getElementById("app");
      if(appEl){
        appEl.classList.remove("framed");
        appEl.classList.add("gdPreLockFrame");
      }
    });
    setStateSafe("Mapped: set position");
  }

  function frameMappedPreLockOnly(){
    var framed = false;
    safe(function(){ if(typeof gdRenderMappedPreLockHoleFrame === "function") framed = !!gdRenderMappedPreLockHoleFrame() || framed; });
    safe(function(){ if(typeof window.gdFrameMappedPreLockPreset === "function") framed = !!window.gdFrameMappedPreLockPreset(1, { animate:false, immediate:true }) || framed; });
    return framed;
  }

	  window.gdFocusMappedPreLockHole = function(h, opts){
	    opts = opts || {};
	    var next = Math.max(1, Math.min(holeCountSafe(), Math.round(Number(h) || currentHoleNumber() || 1)));
	    var token = ++preLockFocusToken;
	    window.__gdPreLockFocusToken = token;
	    safe(function(){document.body.dataset.gdPreLockFocusToken=String(token);document.body.dataset.gdPreLockFocusTarget=String(next)});
	    freshHolePreparingUntil = Date.now() + 1500;
	    lastObservedHole = next;
	    clearTimeout(normalHoleCleanupTimer);
	    safe(function(){ selectedHole = next; currentPlayingHole = next; });
	    safe(function(){ sessionStorage.setItem("gd_active_playing_hole", String(next)); sessionStorage.setItem("gd_mapper_active_hole", String(next)); });
	    safe(function(){ window.gdMapperActiveHole = next; });
	    safe(function(){ if(typeof setHole === "function") setHole(opts.par != null ? { hole:next, par:opts.par } : { hole:next }); });
	    if(!opts.surfaceAlreadyClear){
	      safe(function(){ if(typeof window.gdClearHoleImageRuntime === "function") window.gdClearHoleImageRuntime(opts.source || "mapped-prelock-hole"); });
	      clearNormalHoleChangeShotState(opts.source || "mapped-prelock-hole");
	    }
	    if(!mappedAssist()){
	      setStateSafe("Hole " + next);
	      return false;
	    }
	    showMappedPreLockPrompt();
	    [0,90,260,620].forEach(function(delay){
	      setTimeout(function(){
	        if(window.__gdPreLockFocusToken !== token) return;
	        if(Number(window.__gdHoleFrameSwitchToken || 0) && Number(opts.switchToken || 0) && Number(window.__gdHoleFrameSwitchToken) !== Number(opts.switchToken)) return;
	        if(currentHoleNumber() !== next) return;
	        showMappedPreLockPrompt();
	        frameMappedPreLockOnly();
      }, delay);
    });
    safe(function(){ if(typeof window.gdSyncPlayFlowRail === "function") window.gdSyncPlayFlowRail(); });
    safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
    return false;
  };

  window.gdBeginNormalHoleNavigation = function(h, reason){
    if(reason === "shot-end-green-focus") return false;
    var next = Number(h);
    if(Number.isFinite(next) && next > 0) lastObservedHole = Math.round(next);
    freshHolePreparingUntil = Date.now() + 1500;
    document.body.classList.remove("gdGreenArrivalMode", "gdMappedSnapCameraActive", "gd-green-zoom-active");
    resetPendingManualFlow();
    greenBallDrag = null;
    removeGreenFocusBall();
    safe(function(){
      var tile = document.getElementById("shotTile");
      if(tile) tile.classList.remove("visible");
    });
    safe(function(){ if(typeof clearShot === "function") clearShot(); });
    safe(function(){ if(typeof gdResetShotDistanceDisplay === "function") gdResetShotDistanceDisplay(); });
    clearTimeout(normalHoleCleanupTimer);
    normalHoleCleanupTimer = setTimeout(function(){
      clearNormalHoleChangeShotState(reason || "normal-hole-navigation");
    }, 360);
    return false;
  };

  function detectNormalHoleChange(){
    if(!gpsActive()) return;
    var hole = currentHoleNumber();
    if(!Number.isFinite(Number(hole))) return;
    if(lastObservedHole === null){
      lastObservedHole = hole;
      return;
    }
    if(hole === lastObservedHole) return;
    lastObservedHole = hole;
    scheduleNormalHoleChangeCleanup("normal-hole-change");
  }

  function hasUsableMappedStartPrompt(){
    return safe(function(){
      if(!document.body.classList.contains("gdMappedStartPromptActive")) return false;
      var hint = document.getElementById("hint");
      if(!hint || !hint.classList.contains("visible")) return false;
      if(hint.querySelector("[data-gd-mapped-start-action]")) return true;
      return /Tap where you are standing/i.test(hint.textContent || "");
    }, false);
  }

  function isGreenFocusShotSaved(logged){
    if(!logged||typeof logged!=="object") return false;
    if(logged.excluded||logged.excludedReason||logged.outcome?.excluded||logged.outcome?.excludedReason)return false;
    return true;
  }
  function finishGreenFocusShotEnd(logged){
    var current=currentHoleNumber();
    var next=nextHoleNumber(current);
    var saved=isGreenFocusShotSaved(logged);
    freshHolePreparingUntil = Date.now() + 1600;
    document.body.classList.remove("gdGreenArrivalMode", "gd-green-zoom-active", "gdLockStateFrameActive", "gd-frame-hard-locked");
    resetPendingManualFlow();
    greenBallDrag = null;
    greenFocusOutcomePoint = null;
    greenFocusOutcomeAccuracy = null;
    greenFocusSource = "";
    greenFocusHadShotToLog = false;
    removeGreenFocusBall();
    safe(function(){ lockedFrame = false; });
    safe(function(){
      var appEl = document.getElementById("app");
      if(appEl){
        appEl.classList.remove("framed");
        appEl.classList.add("gdPreLockFrame");
      }
    });
    if(typeof window.gdPlayNextHole === "function"){
      safe(function(){ window.gdPlayNextHole(); });
    }else{
      setTimeout(function(){
        var advanced = false;
        safe(function(){
          if(typeof window.gdPlayHoleFromScorecard === "function"){
            window.gdPlayHoleFromScorecard(next, { source:"shot-end-green-focus" });
            advanced = true;
          }
        });
        setTimeout(function(){
          if(typeof window.gdFocusMappedPreLockHole === "function") window.gdFocusMappedPreLockHole(next, { source:"shot-end-green-focus" });
          else prepareFreshHoleScreen("shot-end-green-focus");
        }, advanced ? 150 : 40);
      }, 60);
    }
    setTimeout(function(){
      document.body.classList.remove("gdGreenArrivalMode", "gd-green-zoom-active", "gdLockStateFrameActive", "gd-frame-hard-locked");
      safe(function(){ lockedFrame = false; });
      if(!hasUsableMappedStartPrompt()){
        clearNormalHoleChangeShotState("shot-end-green-focus-fallback");
        showMappedPreLockPrompt();
        frameMappedPreLockOnly();
      }
      document.body.classList.remove("gdLockStateFrameActive", "gd-frame-hard-locked");
    }, 720);
    setTimeout(function(){
      if(document.body.classList.contains("gdGreenArrivalMode")) return;
      document.body.classList.remove("gdLockStateFrameActive", "gd-frame-hard-locked");
      safe(function(){ lockedFrame = false; });
      if(!hasUsableMappedStartPrompt()){
        showMappedPreLockPrompt();
        frameMappedPreLockOnly();
      }
    }, 1450);
    toastSafe((saved ? "Shot saved" : "No shot saved") + " · H" + next + " ready");
    try{gdSyncNewShotButtonState();}catch(e){}
    return false;
  }

  window.gdPrepareGpsFreshHoleScreen = prepareFreshHoleScreen;

  function hasShotToLog(){
    return !!safe(function(){
      return (typeof gdPendingCourseShot === "function" && gdPendingCourseShot()) || target || gdCurrentPlannedShotId;
    }, false);
  }

  function hapticSafe(ms){
    safe(function(){ if(typeof haptic === "function") haptic(ms || 12); });
  }

  function toastSafe(text){
    safe(function(){ if(typeof toast === "function") toast(text); });
  }

  function setStateSafe(text){
    safe(function(){ if(typeof setState === "function") setState(text); });
  }

  function resetPendingManualFlow(){
    window.gdPendingManualShotVerification = false;
    window.gdPendingManualShotVerificationReason = "";
    var hint = document.getElementById("hint");
    if(hint && /Tap where the shot finished/i.test(hint.textContent || "")){
      hint.classList.remove("visible");
      hint.textContent = "";
    }
  }

  function logPointOnly(ll, reason, accuracy){
    if(!ll) return null;
    resetPendingManualFlow();
    safe(function(){
      if(target && (!currentShotLogged || !gdCurrentPlannedShotId) && typeof gdCaptureCurrentPlannedShot === "function"){
        gdCaptureCurrentPlannedShot(reason || "shot-end");
      }
    });
    var logged = safe(function(){
      return typeof gdLogBallPositionForTracking === "function"
        ? gdLogBallPositionForTracking(ll, reason || "shot_end_gps", accuracy)
        : null;
    }, null);
    safe(function(){ if(typeof gdRefreshCourseDataSurfaces === "function") gdRefreshCourseDataSurfaces(); });
    return logged;
  }

	  function quickShotEnd(reason){
	    if(!gpsActive()) return false;
	    resetPendingManualFlow();
	    var greenFocusActive = document.body.classList.contains("gdGreenArrivalMode");
	    hapticSafe(reason === "phone_shake" ? 28 : 12);
	    if(greenFocusActive){
	      var outcome = greenFocusOutcomePoint || safe(function(){ return start; }, null);
	      if(!outcome){
	        toastSafe("Place ball first");
	        return false;
	      }
	      var loggedGreen = greenFocusHadShotToLog ? logPointOnly(outcome, reason || "shot_end_green_focus", greenFocusOutcomeAccuracy) : null;
	      return finishGreenFocusShotEnd(loggedGreen);
	    }
    var fix = safe(function(){
      var last = window.gdGpsState && window.gdGpsState.lastFix;
      if(!last || !Number.isFinite(Number(last.lat)) || !Number.isFinite(Number(last.lng))) return null;
      return L.latLng(Number(last.lat), Number(last.lng));
    }, null);
    if(fix){
      if(isNearGreenPoint(fix)){
        enterGreenFocus({ source:reason || "shot_end_button", point:fix, accuracy:safe(function(){ return window.gdGpsState.lastFix.accuracy; }, null), hasShotToLog:hasShotToLog() });
        if(document.body.classList.contains("gdGreenArrivalMode")) return false;
      }
      if(!hasShotToLog()){
        toastSafe("Lock in a shot first");
        return false;
      }
      var logged = logPointOnly(fix, reason || "shot_end_gps", safe(function(){ return window.gdGpsState.lastFix.accuracy; }, null));
      if(greenFocusActive) return finishGreenFocusShotEnd(logged);
      toastSafe("Logged");
      return false;
    }
    if(!hasShotToLog()){
      toastSafe("Lock in a shot first");
      return false;
    }
    if(!navigator.geolocation){
      toastSafe("GPS not ready");
      return false;
    }
    navigator.geolocation.getCurrentPosition(function(pos){
      var here = L.latLng(pos.coords.latitude, pos.coords.longitude);
      if(!greenFocusActive && isNearGreenPoint(here)){
        enterGreenFocus({ source:reason || "shot_end_button", point:here, accuracy:pos.coords.accuracy, hasShotToLog:hasShotToLog() });
        if(document.body.classList.contains("gdGreenArrivalMode")) return;
      }
      var logged = logPointOnly(here, reason || "shot_end_gps", pos.coords.accuracy);
      hapticSafe(16);
      if(greenFocusActive){
        finishGreenFocusShotEnd(logged);
        return;
      }
      toastSafe("Logged");
      safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
    }, function(){
      toastSafe("GPS not ready");
    }, { enableHighAccuracy:true, maximumAge:3000, timeout:7000 });
    return false;
  }

  window.gdGpsNewShot = quickShotEnd;
  window.gdGpsLogShot = quickShotEnd;

  function enterManualShotEnd(){
    resetPendingManualFlow();
    hapticSafe(30);
    enterGreenFocus({ source:"shot-end-long-press", requireNear:false });
    syncGreenFocusCleanVisuals();
    ensureGreenFocusBall();
    return false;
  }

  window.gdEnterShotEndManualPlacement = enterManualShotEnd;

  function removeLayer(layer){
    safe(function(){ if(layer && map && map.removeLayer) map.removeLayer(layer); });
  }

  function resetBubbleToHome(){
    return safe(function(){
      if(!start || !greenCentre) return false;
      var home = typeof gdTargetForGreenCentre === "function" ? gdTargetForGreenCentre(greenCentre) : greenCentre;
      if(!home) return false;
      target = home;
      targetWasMoved = false;
      gdWindLandingTarget = null;
      if(targetMarker) targetMarker.setLatLng((typeof gdShotDisplayTarget === "function" && gdShotDisplayTarget()) || target);
      if(typeof renderShot === "function") renderShot();
      if(typeof updatePinLine === "function") updatePinLine();
      return true;
    }, false);
  }

  function clearTemporaryExtras(){
    var changed = false;
    if(document.body.classList.contains("gdGreenArrivalMode")){
      document.body.classList.remove("gdGreenArrivalMode", "gd-green-zoom-active");
      greenFocusOutcomePoint = null;
      greenFocusOutcomeAccuracy = null;
      greenFocusSource = "";
      greenFocusHadShotToLog = false;
      changed = true;
    }
    if(window.gdPendingManualShotVerification){
      resetPendingManualFlow();
      changed = true;
    }
    changed = safe(function(){
      if(typeof placingPin !== "undefined" && placingPin){
        if(typeof cancelPinPlacement === "function") cancelPinPlacement("Reset");
        else placingPin = false;
        return true;
      }
      return false;
    }, false) || changed;
    changed = safe(function(){
      if(typeof targetWasMoved !== "undefined" && targetWasMoved){
        return resetBubbleToHome();
      }
      return false;
    }, false) || changed;
    changed = safe(function(){
      var hadWind = !!(typeof gdHasWindVector === "function" && gdHasWindVector());
      if(hadWind || gdWindLandingTarget){
        gdWindLandingTarget = null;
        if(typeof gdClearWindVisuals === "function") gdClearWindVisuals();
        if(typeof renderShot === "function") renderShot();
        return true;
      }
      return false;
    }, false) || changed;
    changed = safe(function(){
      if(typeof clearReplaceGreenMode === "function") clearReplaceGreenMode();
      document.body.classList.remove("gd-replacing-green-centre");
      if(typeof window.gdClearWandLive === "function") window.gdClearWandLive();
      return false;
    }, false) || changed;
    removeGreenFocusBall();
    return changed;
  }

  function resetAction(){
    if(!gpsActive()) return false;
    hapticSafe(12);
    if(clearTemporaryExtras()){
      toastSafe("Reset");
      safe(function(){ if(start && target && typeof renderShot === "function") renderShot(); });
      return false;
    }
    if(typeof window.gdReturnToPreLockPrompt === "function") return window.gdReturnToPreLockPrompt("reset");
    safe(function(){ if(typeof unlockFrameForReset === "function") unlockFrameForReset(); });
    setStateSafe(mappedAssist() ? "Pre-lock" : "GPS ready");
    return false;
  }

	  window.gdGpsResetAction = resetAction;

	  function removeShotTargetArtifacts(){
	    safe(function(){ if(typeof window.gdClearCapturedHoleFrameShotOverlay === "function") window.gdClearCapturedHoleFrameShotOverlay(); });
	    safe(function(){ if(typeof clearShot === "function") clearShot(); });
	    safe(function(){
	      [targetMarker,greenMarker,pinMarker,pinDirectionLine,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(removeLayer);
	      targetMarker=greenMarker=pinMarker=pinDirectionLine=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
	    });
	    safe(function(){ target=greenCentre=pin=null; });
	    safe(function(){ greenPolygon=null; gdWindLandingTarget=null; targetWasMoved=false; currentShotLogged=false; gdCurrentPlannedShotId=null; targetDragging=false; });
	    safe(function(){ document.getElementById("shotTile") && document.getElementById("shotTile").classList.remove("visible"); });
	  }

	  function unlockedLiveState(label){
	    safe(function(){ lockedFrame = false; });
	    safe(function(){ if(typeof setBubbleOnlyLock === "function") setBubbleOnlyLock(false); });
	    safe(function(){ document.body.classList.remove("gdLockStateFrameActive", "gd-frame-hard-locked", "gdMappedStartPromptActive", "gdHeadToTeeFrameActive"); });
	    safe(function(){ if(typeof window.gdSyncGpsPlayCameraTilt === "function") window.gdSyncGpsPlayCameraTilt("unlock-start"); });
	    safe(function(){ document.getElementById("app") && document.getElementById("app").classList.remove("framed", "gdPreLockFrame"); });
	    safe(function(){ if(typeof hideHint === "function") hideHint(); });
	    safe(function(){ mode = mappedAssist() ? "ready" : "green"; });
	    setStateSafe(label || (mappedAssist() ? "GPS fixed · press Lock" : "GPS ready"));
	  }

	  function unlockAction(){
	    if(!gpsActive()) return false;
	    resetPendingManualFlow();
	    if(hasFreshRealGps()){
	      removeShotTargetArtifacts();
	      unlockedLiveState("GPS fixed · press Lock");
	      toastSafe("Unlocked");
	      safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
	      return false;
	    }
	    if(mappedAssist() && typeof window.gdFocusMappedPreLockHole === "function") return window.gdFocusMappedPreLockHole(currentHoleNumber(), { source:"unlock" });
	    if(typeof window.gdReturnToPreLockPrompt === "function") return window.gdReturnToPreLockPrompt("unlock");
	    safe(function(){ if(typeof unlockFrameForReset === "function") unlockFrameForReset(); });
	    setStateSafe("Pre-lock");
	    return false;
	  }

	  window.newShotUnlock = unlockAction;
	  window.softUnlockFrame = unlockAction;

	  function pointFromRecentGpsOrStart(){
	    var gps = recentGpsPoint();
	    return (gps && gps.ll) || safe(function(){ return start || null; }, null);
	  }
	  function optimisticLockPoint(){
	    var gps = hasFreshRealGps(120000) ? recentGpsPoint() : null;
	    if(gps && gps.ll) return gps;
	    var s = safe(function(){ return start || null; }, null);
	    return s ? { ll:s, accuracy:null, source:"existing-start" } : null;
	  }
	  function refreshGpsAfterOptimisticLock(reason){
	    if(!navigator.geolocation) return false;
	    navigator.geolocation.getCurrentPosition(function(pos){
	      safe(function(){ if(typeof window.gdGpsRememberFix === "function") window.gdGpsRememberFix(pos, reason || "lock-button-background"); });
	    }, function(){}, { enableHighAccuracy:true, maximumAge:3000, timeout:3500 });
	    return true;
	  }

	  function lockShotFromPoint(point, reason, accuracy){
	    if(!gpsActive()) return false;
	    if(!point) point = pointFromRecentGpsOrStart();
	    if(!point){
	      toastSafe("GPS not ready");
	      return false;
	    }
	    resetPendingManualFlow();
	    if(typeof window.gdTryEnterGreenFocusFromPoint === "function"){
	      var focused = safe(function(){ return window.gdTryEnterGreenFocusFromPoint(point, reason || "lock-button", { accuracy:accuracy }); }, false);
	      if(focused) return false;
	    }
	    safe(function(){ if(typeof setStart === "function") setStart(point, false); else start = point; });
	    if(!safe(function(){ return !!target; }, false) && mappedAssist()){
	      safe(function(){
	        if(typeof window.gdLockMappedGreenFromStart === "function") window.gdLockMappedGreenFromStart(point, reason || "lock-button", { hole:currentHoleNumber() });
	      });
	    }
	    if(!safe(function(){ return !!(start && target); }, false)){
	      setStateSafe(mappedAssist() ? "Hole data not ready" : "Set green");
	      toastSafe(mappedAssist() ? "Hole data not ready" : "Set green first");
	      return false;
	    }
	    safe(function(){ mode = "aim"; });
	    safe(function(){ lockedFrame = true; });
	    safe(function(){ if(typeof setBubbleOnlyLock === "function") setBubbleOnlyLock(true); });
	    safe(function(){ document.body.classList.remove("gdMappedStartPromptActive", "gdManualStartPlacementActive"); });
	    safe(function(){ document.body.classList.add("gdLockStateFrameActive"); });
	    safe(function(){ if(typeof window.gdSyncGpsPlayCameraTilt === "function") window.gdSyncGpsPlayCameraTilt(reason || "lock-start"); });
	    safe(function(){ document.getElementById("app") && document.getElementById("app").classList.add("framed"); });
	    safe(function(){ document.getElementById("shotTile") && document.getElementById("shotTile").classList.add("visible"); });
	    safe(function(){ if(typeof hideHint === "function") hideHint(); });
	    safe(function(){ if(typeof renderShot === "function") renderShot(); });
	    safe(function(){ if(typeof updatePinLine === "function") updatePinLine(); });
	    var fitted = safe(function(){
	      return typeof window.gdFitLockStateFrameV19 === "function" && window.gdFitLockStateFrameV19({ force:true, objectName:"explicitLockButton", reason:reason || "lock-button" });
	    }, false);
	    if(!fitted) safe(function(){ if(typeof lockFrame === "function") lockFrame(true); });
	    ensureCapturedShotOverlay(reason || "lock-button");
	    setStateSafe("Hole " + currentHoleNumber());
	    toastSafe("Locked");
	    safe(function(){ if(typeof window.gdSyncNewShotButtonState === "function") window.gdSyncNewShotButtonState(); });
	    return false;
	  }

	  function requestFreshLocationThenLock(){
	    hapticSafe(12);
	    var immediate = optimisticLockPoint();
	    if(immediate && immediate.ll){
	      safe(function(){ document.body.dataset.gdGpsLockStartMode = immediate.source || "optimistic"; });
	      var result = lockShotFromPoint(immediate.ll, immediate.source === "existing-start" ? "lock-button-start" : "lock-button-optimistic", immediate.accuracy);
	      refreshGpsAfterOptimisticLock("lock-button-background");
	      return result;
	    }
	    if(!navigator.geolocation) return lockShotFromPoint(pointFromRecentGpsOrStart(), "lock-button");
	    setStateSafe("Checking GPS");
	    navigator.geolocation.getCurrentPosition(function(pos){
	      var here = L.latLng(pos.coords.latitude, pos.coords.longitude);
	      safe(function(){ if(typeof window.gdGpsRememberFix === "function") window.gdGpsRememberFix(pos, "lock-button"); });
	      lockShotFromPoint(here, "lock-button-gps", pos.coords.accuracy);
	    }, function(){
	      lockShotFromPoint(pointFromRecentGpsOrStart(), "lock-button-fallback");
	    }, { enableHighAccuracy:true, maximumAge:0, timeout:6500 });
	    return false;
	  }

  function shotEndIconMarkup(){
    return '<svg class="gdLogShotIcon gdShotEndIcon" viewBox="0 0 100 100" aria-hidden="true">' +
      '<path class="gdShakeEcho faint" d="M25 25c-5 1-8 4-8 9l9 41c1 5 4 8 9 8h3"/>' +
      '<path class="gdShakeEcho" d="M32 24c-5 1-8 4-8 9l5 42c1 5 4 8 9 8h4"/>' +
      '<path class="gdShakeEcho" d="M68 24c5 1 8 4 8 9l-5 42c-1 5-4 8-9 8h-4"/>' +
      '<path class="gdShakeEcho faint" d="M75 25c5 1 8 4 8 9l-9 41c-1 5-4 8-9 8h-3"/>' +
      '<rect class="gdPhoneFace" x="36" y="22" width="28" height="58" rx="7"/>' +
      '<rect class="gdPhoneIsland" x="46" y="27.2" width="8" height="2.8" rx="1.4"/>' +
      '<circle class="gdCameraLens" cx="52.6" cy="28.6" r=".65"/>' +
      '<rect class="gdSideButton" x="33.9" y="34.5" width="2.1" height="5.8" rx="1"/>' +
      '<rect class="gdSideButton" x="33.9" y="42.6" width="2.1" height="5.4" rx="1"/>' +
      '<rect class="gdSideButton" x="64" y="35.5" width="2.1" height="7.5" rx="1"/>' +
      '<path class="gdTopArrow" d="M35 16c9-7 21-7 30 0"/>' +
      '<path class="gdTopArrowHead" d="M35.8 11.6 29.8 17l7.6 2.4Z"/>' +
      '<path class="gdTopArrowHead" d="M64.2 11.6 70.2 17l-7.6 2.4Z"/>' +
      '</svg>';
  }

  function ensureResetButton(){
    if(!gpsActive()) return;
    var dock = document.getElementById("gdV62UndoDock");
    if(!dock) return;
    var btn = document.getElementById("gdGpsClearBtn");
    if(!btn){
      btn = document.createElement("button");
      btn.id = "gdGpsClearBtn";
      btn.type = "button";
      dock.prepend(btn);
    }
    btn.textContent = "Reset";
    btn.setAttribute("aria-label", "Reset temporary shot tools");
    btn.title = "Reset temporary shot tools";
    if(!btn.__gdResetCaptureBound){
      btn.__gdResetCaptureBound = true;
      btn.addEventListener("click", function(event){
        event.preventDefault();
        event.stopPropagation();
        if(event.stopImmediatePropagation) event.stopImmediatePropagation();
        return resetAction();
      }, true);
    }
  }

	  function bindUnlockButton(){
	    var btn = document.getElementById("gdV62NewShotBtn");
	    if(!btn) return;
	    var locked = safe(function(){ return !!(start && target && lockedFrame); }, false);
	    btn.textContent = locked ? "Unlock" : "Lock";
	    btn.dataset.gdShotFrameAction = locked ? "unlock" : "lock";
	    btn.classList.toggle("gdLockReady", !locked);
	    btn.classList.toggle("gdUnlockReady", locked);
	    btn.title = locked ? "Return to unlocked GPS view" : "Lock in from current location";
	    btn.setAttribute("aria-label", btn.title);
	    function handleLockToggleClick(event){
	      event.preventDefault();
	      event.stopPropagation();
	      if(event.stopImmediatePropagation) event.stopImmediatePropagation();
	      if(safe(function(){ return !!(start && target && lockedFrame); }, false)) return unlockAction();
	      return requestFreshLocationThenLock();
	    }
	    btn.onclick = handleLockToggleClick;
	    if(!btn.__gdUnlockCaptureBoundV30){
	      btn.__gdUnlockCaptureBoundV30 = true;
	      btn.addEventListener("click", handleLockToggleClick, true);
	    }
	  }

  function bindShotEndButton(){
    var btn = document.getElementById("gdV62LogShotBtn");
    if(!btn) return;
    btn.classList.remove("disabled");
    btn.setAttribute("aria-disabled", "false");
    btn.innerHTML = shotEndIconMarkup() + '<span class="gdLogShotText gdShotEndText">Shot End</span>';
    btn.title = hasShotToLog() ? "Tap to log GPS. Long press to place manually." : "Lock in a shot first";
    btn.setAttribute("aria-label", btn.title);
    if(btn.__gdShotEndCaptureBound) return;
    btn.__gdShotEndCaptureBound = true;
    btn.addEventListener("pointerdown", function(event){
      if(!gpsActive()) return;
      shotEndLongPressed = false;
      clearTimeout(shotEndPressTimer);
      shotEndPressTimer = setTimeout(function(){
        shotEndLongPressed = true;
        enterManualShotEnd();
      }, 650);
    }, true);
    ["pointerup","pointercancel","pointerleave","lostpointercapture"].forEach(function(type){
      btn.addEventListener(type, function(){
        clearTimeout(shotEndPressTimer);
        shotEndPressTimer = null;
      }, true);
    });
    btn.addEventListener("click", function(event){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation) event.stopImmediatePropagation();
      if(shotEndLongPressed){
        shotEndLongPressed = false;
        return false;
      }
      return quickShotEnd("shot_end_button");
    }, true);
  }

  function getMapOrigin(){
    var el = safe(function(){ return map && map.getContainer ? map.getContainer() : document.getElementById("map"); }, null);
    if(!el) return null;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle ? getComputedStyle(el) : null;
    var w = el.offsetWidth || rect.width || 1;
    var h = el.offsetHeight || rect.height || 1;
    var parts = String(style && style.transformOrigin || "50% 50%").split(/\s+/);
    function parse(raw, size){
      raw = String(raw || "").trim();
      if(raw.endsWith("%")) return (parseFloat(raw) || 0) / 100 * size;
      var n = parseFloat(raw);
      return Number.isFinite(n) ? n : size / 2;
    }
    var origin = L.point(parse(parts[0], w), parse(parts[1], h));
    var originScreen = L.point(rect.left + (origin.x / Math.max(w, 1)) * rect.width, rect.top + (origin.y / Math.max(h, 1)) * rect.height);
    return { el:el, rect:rect, origin:origin, originScreen:originScreen, width:w, height:h };
  }

  function containerToClient(point){
    var o = getMapOrigin();
    if(!o || !point) return null;
    var angle = ((safe(function(){ return Number(currentMapRotation); }, 0) || 0) * Math.PI) / 180;
    var cos = Math.cos(angle);
    var sin = Math.sin(angle);
    var dx = point.x - o.origin.x;
    var dy = point.y - o.origin.y;
    return L.point(o.originScreen.x + dx * cos - dy * sin, o.originScreen.y + dx * sin + dy * cos);
  }

	  function capturedFrameManifest(){
	    return safe(function(){
	      var manifest=window.gdHoleImageCaptureManifest || window.__gdLastHoleImageCaptureManifest || window.__gdV19CapturedHoleFrameManifest || null;
	      if(manifest&&typeof window.gdCapturedSurfaceManifestMatchesActive==="function"&&!window.gdCapturedSurfaceManifestMatchesActive(manifest))return null;
	      return manifest;
	    }, null);
	  }

  function capturedFrameMatrix(){
    var group = document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles");
    if(!group || typeof DOMMatrix === "undefined") return null;
    return safe(function(){
      var transform = getComputedStyle(group).transform || "none";
      return transform && transform !== "none" ? new DOMMatrix(transform) : new DOMMatrix();
    }, null);
  }

  function capturedLatLngToClient(ll){
    if(!ll || !map || !document.body.classList.contains("gdCapturedHoleFrameCameraOn")) return null;
    var manifest = capturedFrameManifest();
    var matrix = capturedFrameMatrix();
    if(!manifest || !manifest.originPx || !Number.isFinite(Number(manifest.captureZoom)) || !matrix || typeof DOMPoint === "undefined") return null;
    return safe(function(){
      var q = map.project(ll, Number(manifest.captureZoom));
      var p = new DOMPoint(q.x - Number(manifest.originPx.x || 0), q.y - Number(manifest.originPx.y || 0)).matrixTransform(matrix);
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? L.point(p.x, p.y) : null;
    }, null);
  }

  function capturedClientToLatLng(clientX, clientY){
    if(!map || !document.body.classList.contains("gdCapturedHoleFrameCameraOn")) return null;
    var manifest = capturedFrameManifest();
    var matrix = capturedFrameMatrix();
    if(!manifest || !manifest.originPx || !Number.isFinite(Number(manifest.captureZoom)) || !matrix || typeof DOMPoint === "undefined") return null;
    return safe(function(){
      var p = new DOMPoint(Number(clientX), Number(clientY)).matrixTransform(matrix.inverse());
      return map.unproject(L.point(p.x + Number(manifest.originPx.x || 0), p.y + Number(manifest.originPx.y || 0)), Number(manifest.captureZoom));
    }, null);
  }
  window.gdCapturedClientToLatLng = function(clientX, clientY){
    return capturedClientToLatLng(clientX, clientY);
  };
  window.gdCapturedLatLngToClient = function(ll){
    return capturedLatLngToClient(ll);
  };
  window.gdCapturedSurfaceAccuracyProbe = function(clientX, clientY){
    var captured = capturedClientToLatLng(clientX, clientY);
    var live = safe(function(){
      if(!map || typeof window.gdLiveLatLngFromClient !== "function") return null;
      return window.gdLiveLatLngFromClient(clientX, clientY);
    }, null);
    var delta = safe(function(){
      return captured && live && map && map.distance ? map.distance(captured, live) : null;
    }, null);
    return { captured:point(captured), live:point(live), deltaM:Number.isFinite(Number(delta)) ? Number(delta) : null };
  };

  function capturedLatLngToLocal(point){
    var manifest = capturedFrameManifest();
    if(!point || !map || !manifest || !manifest.originPx || !Number.isFinite(Number(manifest.captureZoom))) return null;
    return safe(function(){
      var ll = L.latLng(Number(point.lat), Number(point.lng));
      var projected = map.project(ll, Number(manifest.captureZoom));
      var x = projected.x - Number(manifest.originPx.x || 0);
      var y = projected.y - Number(manifest.originPx.y || 0);
      return Number.isFinite(x) && Number.isFinite(y) ? L.point(x, y) : null;
    }, null);
  }

  function capturedLocalToLatLng(point){
    var manifest = capturedFrameManifest();
    if(!point || !map || !manifest || !manifest.originPx || !Number.isFinite(Number(manifest.captureZoom))) return null;
    return safe(function(){
      return map.unproject(L.point(Number(point.x) + Number(manifest.originPx.x || 0), Number(point.y) + Number(manifest.originPx.y || 0)), Number(manifest.captureZoom));
    }, null);
  }

  function capturedClientToLocal(clientX, clientY){
    var matrix = capturedFrameMatrix();
    if(!matrix || typeof DOMPoint === "undefined") return null;
    return safe(function(){
      var p = new DOMPoint(Number(clientX), Number(clientY)).matrixTransform(matrix.inverse());
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? L.point(p.x, p.y) : null;
    }, null);
  }

  function capturedFrameScale(){
    var matrix = capturedFrameMatrix();
    if(!matrix) return 1;
    var sx = Math.hypot(Number(matrix.a) || 0, Number(matrix.b) || 0);
    var sy = Math.hypot(Number(matrix.c) || 0, Number(matrix.d) || 0);
    var scale = Math.max(sx || 0, sy || 0);
    return Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  function capturedShotState(){
    return safe(function(){
      var s = start || null;
      var rawTarget = target || null;
      if(!s || !rawTarget || !map || !map.distance) return null;
      var display = (typeof gdShotDisplayTarget === "function" && (gdShotDisplayTarget() || null)) || rawTarget;
      if(!display) return null;
      var distance = map.distance(s, display);
      if(!Number.isFinite(distance) || distance <= 0) return null;
      var raw = typeof getGpsBubblePayload === "function" ? getGpsBubblePayload(distance) : null;
      var center = (typeof gdBubbleRenderCenter === "function" && gdBubbleRenderCenter(raw)) || display || rawTarget;
      if(!center) return null;
      var payload = typeof gdGpsBubbleDisplayPayload === "function" ? gdGpsBubbleDisplayPayload(raw, distance, center) : raw;
      return { start:s, target:rawTarget, display:display, distance:distance, raw:raw || {}, center:center, payload:payload || raw || {} };
    }, null);
  }

  function capturedProjectOffset(origin, bearingRad, forwardM, sideM){
    return safe(function(){
      if(typeof projectOffset === "function") return projectOffset(origin, bearingRad || 0, forwardM || 0, sideM || 0);
      var base = typeof project === "function" ? project(origin, bearingRad || 0, forwardM || 0) : origin;
      var perp = (bearingRad || 0) + Math.PI / 2;
      var earth = 111320;
      return L.latLng(
        Number(base.lat) + (Math.cos(perp) * (sideM || 0)) / earth,
        Number(base.lng) + (Math.sin(perp) * (sideM || 0)) / (earth * Math.cos(Number(base.lat) * Math.PI / 180))
      );
    }, null);
  }

  function capturedBubbleShape(state){
    if(!state || !state.center) return [];
    var shape = safe(function(){
      return typeof buildBubbleShape === "function" ? buildBubbleShape(state.center, state.payload, 1) : null;
    }, null);
    if(Array.isArray(shape) && shape.length >= 3) return shape.filter(Boolean);
    var radius = Math.max(6, Number(state.payload && state.payload.radius) || 24);
    var ring = [];
    for(var i = 0; i < 56; i++){
      var a = (Math.PI * 2 * i) / 56;
      var p = capturedProjectOffset(state.center, 0, Math.cos(a) * radius, Math.sin(a) * radius);
      if(p) ring.push(p);
    }
    return ring;
  }

  function capturedBearingRad(a, b){
    return safe(function(){
      if(typeof bearingRad === "function") return bearingRad(a, b);
      if(typeof bearing === "function") return bearing(a, b);
      var lat1 = Number(a.lat) * Math.PI / 180;
      var lat2 = Number(b.lat) * Math.PI / 180;
      var dLon = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
      var y = Math.sin(dLon) * Math.cos(lat2);
      var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      return Math.atan2(y, x);
    }, null);
  }

  function capturedAimEnd(state){
    if(!state) return null;
    var end = safe(function(){
      return typeof gdAimLineEndPoint === "function" ? gdAimLineEndPoint(state.distance, state.payload) : null;
    }, null);
    if(end) return end;
    var bearingValue = capturedBearingRad(state.start, state.display || state.center);
    if(Number.isFinite(Number(bearingValue)) && typeof project === "function"){
      return safe(function(){ return project(state.display || state.center, Number(bearingValue), Math.max(180, state.distance * 1.18)); }, state.display || state.center);
    }
    return state.display || state.center;
  }

  function ensureCapturedOwnerDragHit(){
    var hit = byId("gdCapturedBubbleDragHit");
    if(!hit){
      hit = document.createElement("div");
      hit.id = "gdCapturedBubbleDragHit";
      hit.setAttribute("aria-hidden", "true");
      document.body.appendChild(hit);
    }
    if(hit.__gdCapturedDragInstalled || hit.__gdSpringCapturedDragInstalled) return hit;
    hit.__gdSpringCapturedDragInstalled = true;
    hit.addEventListener("pointerdown", function(event){
      if(event.button != null && event.button !== 0) return;
      if(!document.body.classList.contains("gdCapturedHoleFrameCameraOn") || document.body.classList.contains("gdMappedStartPromptActive")) return;
      var state = capturedShotState();
      if(!state || !state.center) return;
      var centerLocal = capturedLatLngToLocal(state.center);
      var downLocal = capturedClientToLocal(event.clientX, event.clientY);
      if(!centerLocal || !downLocal) return;
      stop(event);
      safe(function(){ if(typeof window.gdConsumeNextMapClick === "function") window.gdConsumeNextMapClick("spring-bubble-pointerdown", 1400); });
      var drag = {
        id:event.pointerId,
        offset:L.point(downLocal.x - centerLocal.x, downLocal.y - centerLocal.y),
        raf:null,
        pending:null
      };
      safe(function(){ if(map && map.dragging) map.dragging.disable(); });
      safe(function(){ targetDragging = true; });
      document.body.classList.add("gdCapturedBubbleDragging");
      hit.style.cursor = "grabbing";
      safe(function(){ hit.setPointerCapture(event.pointerId); });
      function apply(local, final){
        if(!local) return;
        var ll = capturedLocalToLatLng(L.point(local.x - drag.offset.x, local.y - drag.offset.y));
        if(!ll) return;
        drag.pending = ll;
        if(drag.raf && !final) return;
        if(drag.raf && final){ cancelAnimationFrame(drag.raf); drag.raf = null; }
        var run = function(){
          drag.raf = null;
          var next = drag.pending;
          if(!next) return;
          safe(function(){ if(typeof gdSetTargetFromDisplayedLanding === "function") gdSetTargetFromDisplayedLanding(next); else target = next; });
          safe(function(){ targetWasMoved = true; });
          safe(function(){ if(typeof gdMarkCurrentPlanDirty === "function") gdMarkCurrentPlanDirty(); });
          safe(function(){
            var shown = (typeof gdShotDisplayTarget === "function" && (gdShotDisplayTarget() || null)) || target || next;
            if(targetMarker && targetMarker.setLatLng) targetMarker.setLatLng(shown);
          });
          safe(function(){ if(typeof renderShot === "function") renderShot(); });
          safe(function(){ if(typeof updatePinLine === "function") updatePinLine(); });
          paintCapturedShotOverlayOwner("captured-owner-drag");
        };
        if(final) run();
        else drag.raf = requestAnimationFrame(run);
      }
      function move(moveEvent){
        if(moveEvent.pointerId !== drag.id) return;
        stop(moveEvent);
        apply(capturedClientToLocal(moveEvent.clientX, moveEvent.clientY), false);
      }
      function end(endEvent){
        if(endEvent.pointerId !== drag.id) return;
        stop(endEvent);
        safe(function(){ if(typeof window.gdConsumeNextMapClick === "function") window.gdConsumeNextMapClick("spring-bubble-pointerup", 1400); });
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        document.removeEventListener("pointercancel", end);
        apply(capturedClientToLocal(endEvent.clientX, endEvent.clientY), true);
        document.body.classList.remove("gdCapturedBubbleDragging", "gdBubbleLongPressZoomActive", "gd-green-zoom-active");
        safe(function(){ targetDragging = false; });
        safe(function(){ if(typeof setBubbleOnlyLock === "function") setBubbleOnlyLock(true); });
        safe(function(){ if(map && map.dragging && !document.body.classList.contains("gdGreenArrivalMode")) map.dragging.enable(); });
        safe(function(){ hit.releasePointerCapture(endEvent.pointerId); });
        hit.style.cursor = "grab";
        writeCapturedResume("captured-owner-drag");
      }
      document.addEventListener("pointermove", move, { passive:false });
      document.addEventListener("pointerup", end, { passive:false });
      document.addEventListener("pointercancel", end, { passive:false });
    }, { passive:false });
    return hit;
  }

  function positionCapturedOwnerDragHit(centerLocal, localPts, scale){
    var hit = ensureCapturedOwnerDragHit();
    var screen = capturedLatLngToClient(capturedLocalToLatLng(centerLocal));
    if(!hit || !screen || document.body.classList.contains("gdMappedStartPromptActive")){
      if(hit) hit.style.display = "none";
      return false;
    }
    var xs = localPts.map(function(p){ return p.x; });
    var ys = localPts.map(function(p){ return p.y; });
    var localW = xs.length ? Math.max.apply(null, xs) - Math.min.apply(null, xs) : 70;
    var localH = ys.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 70;
    var size = Math.max(54, Math.min(260, Math.max(localW, localH) * Math.max(.05, Number(scale) || 1) + 28));
    hit.style.display = "block";
    hit.style.width = size.toFixed(1) + "px";
    hit.style.height = size.toFixed(1) + "px";
    hit.style.left = (screen.x - size / 2).toFixed(1) + "px";
    hit.style.top = (screen.y - size / 2).toFixed(1) + "px";
    return true;
  }

	  function paintCapturedShotOverlayOwner(reason){
	    if(!document.body || !document.body.classList.contains("gdCapturedHoleFrameCameraOn")) return false;
	    if(document.body.classList.contains("gdMappedStartPromptActive") || document.body.classList.contains("gdGreenArrivalMode")) return false;
	    var layer = byId("gdHoleImageCameraLayer");
	    var group = layer && layer.querySelector(".gdHoleImageTiles");
	    if(!layer || !group) return false;
	    var overlay = group.querySelector(".gdHoleImageOverlay");
	    if(!overlay){
	      overlay = document.createElement("div");
	      overlay.className = "gdHoleImageOverlay";
	      group.appendChild(overlay);
	    }
	    if(!safe(function(){ return !!lockedFrame; }, false)){
	      overlay.innerHTML = "";
	      var hit = byId("gdCapturedBubbleDragHit");
	      if(hit) hit.style.display = "none";
	      return false;
	    }
	    var manifest = capturedFrameManifest();
    var state = capturedShotState();
    if(!manifest || !state){
      overlay.innerHTML = "";
      return false;
    }
    var centerLocal = capturedLatLngToLocal(state.center);
    var shape = capturedBubbleShape(state);
    var localPts = shape.map(capturedLatLngToLocal).filter(Boolean);
    if(!centerLocal || localPts.length < 3){
      overlay.innerHTML = "";
      return false;
    }
    var width = Math.max(1, Number(manifest.imageWidth) || group.offsetWidth || 1);
    var height = Math.max(1, Number(manifest.imageHeight) || group.offsetHeight || 1);
    var scale = capturedFrameScale();
    var stroke = Math.max(.6, Math.min(24, 2.8 / Math.max(.05, scale)));
    var core = Math.max(2.2, Math.min(34, 5.2 / Math.max(.05, scale)));
    var path = "M " + localPts.map(function(p){ return p.x.toFixed(1) + " " + p.y.toFixed(1); }).join(" L ") + " Z";
    var startLocal = capturedLatLngToLocal(state.start);
    var endLocal = capturedLatLngToLocal(capturedAimEnd(state));
    var dashA = Math.max(2, 8 / Math.max(.05, scale));
    var dashB = Math.max(2, 10 / Math.max(.05, scale));
    var aim = startLocal && endLocal
      ? '<line class="gdCapturedAimLine" x1="' + startLocal.x.toFixed(1) + '" y1="' + startLocal.y.toFixed(1) + '" x2="' + endLocal.x.toFixed(1) + '" y2="' + endLocal.y.toFixed(1) + '" stroke-width="' + Math.max(.8, Math.min(28, 3.25 / Math.max(.05, scale))).toFixed(2) + '" stroke-dasharray="' + dashA.toFixed(1) + ' ' + dashB.toFixed(1) + '"/>'
      : "";
    overlay.innerHTML = '<svg class="gdCapturedShotSvg" data-owner="gps-play-runtime" data-reason="' + String(reason || "owner").replace(/"/g, "") + '" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + aim + '<path class="gdCapturedShotBubble" d="' + path + '" stroke-width="' + stroke.toFixed(2) + '"/><circle class="gdCapturedShotCore" cx="' + centerLocal.x.toFixed(1) + '" cy="' + centerLocal.y.toFixed(1) + '" r="' + core.toFixed(2) + '" stroke-width="' + Math.max(.45, stroke * .62).toFixed(2) + '"/></svg>';
    positionCapturedOwnerDragHit(centerLocal, localPts, scale);
	    window.__gdCapturedOwnerLastPaint = { reason:reason || "owner", at:Date.now(), distance:state.distance, center:point(state.center), source:"gps-play-runtime" };
	    return true;
	  }
	  window.gdPaintCapturedShotOverlayOwner = paintCapturedShotOverlayOwner;

  function liveLatLngFromClientEvent(event){
    return safe(function(){
      if(typeof window.gdLiveLatLngFromClient === "function") return window.gdLiveLatLngFromClient(event.clientX, event.clientY);
      var rect = map.getContainer().getBoundingClientRect();
      return map.containerPointToLatLng(L.point(event.clientX - rect.left, event.clientY - rect.top));
    }, null);
  }

	  function greenFocusLatLngFromClientEvent(event){
	    var captured = typeof window.gdCapturedLatLngFromClientStrict === "function"
	      ? window.gdCapturedLatLngFromClientStrict(event.clientX, event.clientY, "green-focus-event")
	      : capturedClientToLatLng(event.clientX, event.clientY);
	    if(document.body.classList.contains("gdCapturedHoleFrameCameraOn")) return captured;
	    if(captured && isNearGreenPoint(captured)) return captured;
	    var live = liveLatLngFromClientEvent(event);
	    if(live && isNearGreenPoint(live)) return live;
	    return captured || live;
	  }

  function springGreenFocusGreen(){
    return safe(function(){
      if(typeof greenCentre !== "undefined" && greenCentre) return greenCentre;
      if(typeof pin !== "undefined" && pin) return pin;
      var payload = typeof gdActiveMappedHolePlayData === "function" ? gdActiveMappedHolePlayData() : null;
      var data = payload && payload.data;
      var green = data && data.green ? data.green : {};
      var candidates = [green.position, green.center, green.centre, green.pin];
      for(var i = 0; i < candidates.length; i++){
        var ll = typeof gdMappedPointToLatLng === "function" ? gdMappedPointToLatLng(candidates[i]) : null;
        if(ll) return ll;
      }
      var route = data && Array.isArray(data.route) ? data.route : [];
      if(route.length && typeof gdMappedPointToLatLng === "function") return gdMappedPointToLatLng(route[route.length - 1]);
      return typeof target !== "undefined" ? target : null;
    }, null);
  }

  function greenFocusScreenGreenForEvent(event){
    try{
      var green = springGreenFocusGreen();
      if(!event || !green || !map){
        safe(function(){ document.body.dataset.gdGreenFocusScreenDistance = "missing:" + (!event?"event":!green?"green":"map"); });
        return null;
      }
      var screen = typeof window.gdCapturedLatLngToClient === "function" ? window.gdCapturedLatLngToClient(green) : null;
      if(!screen){
        var projected = map.latLngToContainerPoint(green);
        var rect = map.getContainer().getBoundingClientRect();
        screen = { x:rect.left + projected.x, y:rect.top + projected.y };
      }
      if(!screen) return null;
      var distance = Math.hypot(Number(event.clientX) - Number(screen.x), Number(event.clientY) - Number(screen.y));
      var radius = Math.max(56, Math.min(112, (window.innerWidth || 360) * .26));
      document.body.dataset.gdGreenFocusScreenDistance = Math.round(distance) + "/" + Math.round(radius);
      return distance <= radius ? green : null;
    }catch(error){
      safe(function(){ document.body.dataset.gdGreenFocusScreenError = String(error && error.message || error); });
      return null;
    }
  }

  function positionGreenFocusBall(){
    var ball = document.getElementById("gdGreenFocusScreenBall");
    if(!ball || !document.body.classList.contains("gdGreenArrivalMode")) return;
    var ll = greenFocusOutcomePoint || safe(function(){ return start; }, null);
    if(!ll || !map) return;
    var p = safe(function(){ return map.latLngToContainerPoint(ll); }, null);
    var screen = capturedLatLngToClient(ll) || containerToClient(p);
    if(!screen) return;
    ball.style.left = screen.x + "px";
    ball.style.top = screen.y + "px";
    safe(function(){
      if(startMarker && startMarker.getElement) startMarker.getElement().style.opacity = "0";
    });
  }

  function removeGreenFocusBall(){
    var ball = document.getElementById("gdGreenFocusScreenBall");
    if(ball) ball.remove();
    safe(function(){
      if(startMarker && startMarker.getElement) startMarker.getElement().style.opacity = "";
      if(startMarker && startMarker.dragging && startMarker.dragging.enabled()) startMarker.dragging.disable();
      if(startMarker && startMarker.setIcon && typeof startIcon !== "undefined") startMarker.setIcon(startIcon);
    });
  }

  function ensureGreenFocusBall(){
    if(!gpsActive() || !document.body.classList.contains("gdGreenArrivalMode")){
      removeGreenFocusBall();
      return;
    }
    var ball = document.getElementById("gdGreenFocusScreenBall");
    if(!ball){
      ball = document.createElement("div");
      ball.id = "gdGreenFocusScreenBall";
      ball.className = "gdGreenFocusScreenBall";
      ball.setAttribute("role", "button");
      ball.setAttribute("aria-label", "Adjust ball position");
      document.body.appendChild(ball);
      ball.addEventListener("pointerdown", function(event){
        if(!document.body.classList.contains("gdGreenArrivalMode")) return;
        event.preventDefault();
        event.stopPropagation();
        if(event.stopImmediatePropagation) event.stopImmediatePropagation();
        greenBallDrag = {
          id:event.pointerId,
          x:event.clientX,
          y:event.clientY,
          left:parseFloat(ball.style.left) || event.clientX,
          top:parseFloat(ball.style.top) || event.clientY
        };
        ball.classList.add("dragging");
        safe(function(){ ball.setPointerCapture(event.pointerId); });
        safe(function(){ if(map && map.dragging) map.dragging.disable(); });
      }, true);
      ball.addEventListener("pointermove", function(event){
        if(!greenBallDrag || greenBallDrag.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        var left = greenBallDrag.left + (event.clientX - greenBallDrag.x);
        var top = greenBallDrag.top + (event.clientY - greenBallDrag.y);
        ball.style.left = left + "px";
        ball.style.top = top + "px";
      }, true);
      function finish(event){
        if(!greenBallDrag || greenBallDrag.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        var left = parseFloat(ball.style.left) || event.clientX;
        var top = parseFloat(ball.style.top) || event.clientY;
        greenBallDrag = null;
        ball.classList.remove("dragging");
	        var ll = capturedClientToLatLng(left, top);
	        if(!ll&&!document.body.classList.contains("gdCapturedHoleFrameCameraOn"))ll = safe(function(){
	          if(typeof gdLatLngFromClientEvent === "function") return gdLatLngFromClientEvent({ clientX:left, clientY:top });
	          var rect = map.getContainer().getBoundingClientRect();
	          return map.containerPointToLatLng(L.point(left - rect.left, top - rect.top));
	        }, null);
        if(ll){
          resetPendingManualFlow();
          setGreenFocusBallPoint(ll, null, "drag");
          hapticSafe(10);
        }
        safe(function(){ if(map && map.dragging && document.body.classList.contains("gdGreenArrivalMode")) map.dragging.disable(); });
        positionGreenFocusBall();
      }
      ball.addEventListener("pointerup", finish, true);
      ball.addEventListener("pointercancel", finish, true);
    }
    positionGreenFocusBall();
  }

  function syncGreenFocusCleanVisuals(){
    if(!document.body.classList.contains("gdGreenArrivalMode")){
      removeGreenFocusBall();
      return;
    }
    resetPendingManualFlow();
    safe(function(){ if(typeof gdClearAimLine === "function") gdClearAimLine(); });
    safe(function(){ if(typeof window.gdClearCapturedHoleFrameShotOverlay === "function") window.gdClearCapturedHoleFrameShotOverlay(); });
    safe(function(){
      [pinLine,pinLabel,remainingGreenLine,remainingGreenLabel,middleGuideLine,middleGuideLabel,bubbleOuter,bubbleMain,bubbleCore,bubbleMiss,bubbleShadow,bubbleShade,bubbleCarryLine].forEach(removeLayer);
      pinLine=pinLabel=remainingGreenLine=remainingGreenLabel=middleGuideLine=middleGuideLabel=bubbleOuter=bubbleMain=bubbleCore=bubbleMiss=bubbleShadow=bubbleShade=bubbleCarryLine=null;
    });
    safe(function(){
      if(bubbleTexture && bubbleTexture.length) bubbleTexture.forEach(removeLayer);
      bubbleTexture = [];
    });
    safe(function(){ if(typeof gdClearGpsFocusModeLayer === "function") gdClearGpsFocusModeLayer(); });
    safe(function(){ if(typeof gdClearWindVisuals === "function") gdClearWindVisuals(); });
    safe(function(){ if(typeof gdClearMappedLayupReference === "function") gdClearMappedLayupReference(); });
    safe(function(){
      if(!pin && pinMarker){
        removeLayer(pinMarker);
        pinMarker = null;
      }
    });
    safe(function(){ if(map && map.dragging) map.dragging.disable(); });
    ensureGreenFocusBall();
  }

  window.gdSyncGreenFocusCleanVisuals = syncGreenFocusCleanVisuals;

	  function ensureCapturedShotOverlay(reason){
	    if(!gpsActive() || document.body.classList.contains("gdGreenArrivalMode") || document.body.classList.contains("gdMappedStartPromptActive")) return false;
	    if(!document.body.classList.contains("gdCapturedHoleFrameCameraOn")) return false;
	    var ready = safe(function(){ return !!(start && target && lockedFrame); }, false);
	    if(!ready) return false;
    var overlay = document.querySelector("#gdHoleImageCameraLayer .gdHoleImageOverlay");
    var hasBubble = !!(overlay && overlay.querySelector(".gdCapturedShotBubble"));
    var hasAim = !!(overlay && overlay.querySelector(".gdCapturedAimLine"));
    if(hasBubble && hasAim) return true;
    var painted = safe(function(){
      return typeof window.gdPaintCapturedShotOverlayOwner === "function" && window.gdPaintCapturedShotOverlayOwner(reason || "overlay-watchdog");
    }, false);
    if(!painted){
      painted = safe(function(){
        return typeof window.gdForceCapturedOverlayFromCurrentShot === "function" && window.gdForceCapturedOverlayFromCurrentShot(reason || "overlay-watchdog");
      }, false);
    }
    return !!painted;
  }

  function forceNormalShotViewAfterStart(){
    if(!gpsActive() || document.body.classList.contains("gdGreenArrivalMode")) return;
    if(Date.now() < freshHolePreparingUntil) return;
	    var ready = safe(function(){ return !!(start && target); }, false);
	    if(!ready) return;
	    if(!safe(function(){ return !!lockedFrame; }, false)) return;
	    var promptActive = document.body.classList.contains("gdMappedStartPromptActive");
    var key = safe(function(){ return [start.lat, start.lng, target.lat, target.lng, mode, promptActive].join("|"); }, "");
    if(!promptActive && mode === "aim") return;
    if(lastForcedShotKey === key) return;
    lastForcedShotKey = key;
    resetPendingManualFlow();
    document.body.classList.remove("gdMappedStartPromptActive");
    safe(function(){ document.getElementById("app") && document.getElementById("app").classList.remove("gdPreLockFrame"); });
    safe(function(){ mode = "aim"; });
    safe(function(){ document.getElementById("shotTile") && document.getElementById("shotTile").classList.add("visible"); });
	    safe(function(){ if(typeof hideHint === "function") hideHint(); });
	    safe(function(){ if(typeof renderShot === "function") renderShot(); });
	    ensureCapturedShotOverlay("force-normal-shot-view");
    setStateSafe("Hole " + currentHoleNumber());
  }

  var previousFrameShotView = safe(function(){ return frameShotView; }, null);
  if(typeof previousFrameShotView === "function"){
    frameShotView = function(){
      try{
        if(!start || !target || !map) return previousFrameShotView.apply(this, arguments);
        var displayTarget = (typeof gdFrameDisplayTarget === "function" && gdFrameDisplayTarget()) || target;
        var frameTarget = (typeof gdFrameNorthTarget === "function" && gdFrameNorthTarget()) || displayTarget;
        if(!displayTarget || !frameTarget) return previousFrameShotView.apply(this, arguments);
        var axis = (typeof gdShotUpAxis === "function" && gdShotUpAxis()) || null;
        var shotBrg = axis && Number.isFinite(axis.bearingRad) ? axis.bearingRad : bearing(start, frameTarget);
        var shotM = Math.max(1, map.distance(start, displayTarget));
        var back = project(start, shotBrg + Math.PI, Math.max(8, Math.min(20, shotM * .055)));
        var beyond = project(frameTarget, shotBrg, Math.max(14, Math.min(46, shotM * .11)));
        var mid = project(start, shotBrg, shotM * .54);
        var lateral = Math.max(28, Math.min(68, shotM * .18));
        var points = [back, beyond, start, displayTarget, frameTarget, projectOffset(mid, shotBrg, 0, -lateral), projectOffset(mid, shotBrg, 0, lateral)];
        if(greenCentre) points.push(greenCentre);
        if(pin) points.push(pin);
        map.fitBounds(L.latLngBounds(points.filter(Boolean)), {
          paddingTopLeft:[34, 92],
          paddingBottomRight:[34, 78],
          animate:false,
          duration:0,
          maxZoom:20
        });
        return true;
      }catch(_e){
        return previousFrameShotView.apply(this, arguments);
      }
    };
    window.frameShotView = frameShotView;
  }

  var previousSync = window.gdSyncNewShotButtonState;
  window.gdSyncNewShotButtonState = function(){
    safe(function(){ if(typeof previousSync === "function") previousSync.apply(this, arguments); });
    ensureResetButton();
    bindUnlockButton();
    bindShotEndButton();
    resetPendingManualFlow();
  };

  function tick(){
    if(!gpsActive()) return;
    installGreenFocusClick();
    maybeEnterGreenFocusFromGps();
    ensureResetButton();
    bindUnlockButton();
    bindShotEndButton();
    detectNormalHoleChange();
    forceNormalShotViewAfterStart();
    ensureCapturedShotOverlay("tick");
    syncGreenFocusCleanVisuals();
  }

  setInterval(tick, 350);
  document.addEventListener("DOMContentLoaded", function(){ setTimeout(tick, 120); });
  document.addEventListener("click", function(){ setTimeout(tick, 40); }, true);
  window.addEventListener("resize", function(){ setTimeout(positionGreenFocusBall, 80); }, true);
})();

/* ==== section: gd-gps-play-runtime-owner-v1.js ==== */
/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsPlayRuntimeOwnerV1)return;
  window.__gdGpsPlayRuntimeOwnerV1=true;
  window.__gdGpsSpringCleanOwnerV1="renamed-to-gdGpsPlayRuntimeOwnerV1";
  window.gdGpsPlayRuntimeOwner={id:"gdGpsPlayRuntimeOwnerV1",owns:["gps-location-lifecycle","gps-runtime-cleanup","manual-start-runtime","resume-round-runtime","tool-rail-runtime","captured-shot-overlay-runtime"],shellNavigationOwner:"gdCanonicalRouteAuditV1",cameraOwner:"v19-captured-surface"};
  var RESUME_KEY="gd_gps_resume_round_v1";
  var LEGACY_RESUME_KEY="gd_gps_auto_session_v1";
  var RESUME_TTL_MS=3*60*60*1000;
  var manualStartArmedAt=0;
  var manualStartLockToken=0;
	  var lastTabToggleAt=0;
	  var toolRailOpenToken=0;
	  var lastHomeNavAt=0;
	  var lastBackNavAt=0;
	  var capturedGreenZoomActive=false;
	  var gpsSurfaceRestoreBusy=false;
  var gpsFirstPaintGateToken=0;
  var GPS_ROUND_START_PERMISSION_KEY="gps_round_start";
  var oldEnter=window.enterGpsModule;
	  var oldHome=window.gdCanonicalShellHome||window.showShellHome;
	  var oldBack=window.gdCanonicalShellBack||window.shellBack;
	  var oldPickerHome=window.gdCoursePickerHome;
	  var oldOpenCourse=window.gdOpenCoursePickerCourse;
  var oldSimpleGreenZoom=window.gdToggleSimpleGreenZoom;
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function byId(id){return document.getElementById(id)}
  function latLngFromPosition(pos){
    if(!pos)return null;
    if(pos.coords)return L.latLng(pos.coords.latitude,pos.coords.longitude);
    if(Number.isFinite(Number(pos.lat))&&Number.isFinite(Number(pos.lng)))return L.latLng(Number(pos.lat),Number(pos.lng));
    return null;
  }
  function setGpsSafe(ok,label){
    safe(function(){if(typeof setGps==="function")setGps(ok,label)});
    safe(function(){if(typeof setGpsLabel==="function")setGpsLabel(ok,label)});
  }
  function setStateSafe(label){
    safe(function(){if(typeof setState==="function")setState(label)});
    safe(function(){if(typeof setStateLabel==="function")setStateLabel(label)});
  }
  function showGpsHintSafe(label){
    safe(function(){if(typeof showHint==="function")showHint(label)});
    safe(function(){if(typeof hint==="function")hint(label)});
  }
  function hideGpsHintSafe(){
    safe(function(){if(typeof hideHint==="function")hideHint()});
    safe(function(){if(typeof hideHintSafe==="function")hideHintSafe()});
  }
  function gpsErrorLabel(err){
    var code=err&&err.code;
    if(code===1)return {gps:"GPS denied",state:"GPS permission needed",toast:"Location permission needed",hint:null};
    if(code===3)return {gps:"GPS weak",state:"GPS is searching",toast:"GPS timeout · try again outside",hint:"GPS is searching. Try again near the tee."};
    return {gps:"GPS weak",state:"GPS is searching",toast:"GPS is searching",hint:"GPS is searching. Try again near the tee."};
  }
  function pulseStartDot(){var el=document.querySelector(".startDot");if(el){el.classList.remove("pulse");void el.offsetWidth;el.classList.add("pulse")}}
  function rememberLiveGpsOnly(here,accuracy,source){
    window.__gdGpsLocateQuarantineV1=true;
    if(!here||!Number.isFinite(Number(here.lat))||!Number.isFinite(Number(here.lng)))return false;
    var point={lat:Number(here.lat),lng:Number(here.lng)};
    var accuracyValue=Number.isFinite(Number(accuracy))?Number(accuracy):null;
    window.gdGpsState=window.gdGpsState||{};
    window.gdGpsState.permissionKnown=true;
    window.gdGpsState.permissionGranted=true;
    window.gdGpsState.lastError=null;
    window.gdGpsState.lastFix={lat:point.lat,lng:point.lng,accuracy:accuracyValue,source:source||"gps-live",simulated:false};
    window.gdGpsState.lastFixAt=Date.now();
    window.__gdLastLiveGpsPoint={lat:point.lat,lng:point.lng,accuracy:accuracyValue,source:source||"gps-live",at:Date.now()};
    safe(function(){
      if(document.body&&document.body.dataset){
        document.body.dataset.gdLiveGpsLat=String(point.lat);
        document.body.dataset.gdLiveGpsLng=String(point.lng);
        document.body.dataset.gdLiveGpsSource=source||"gps-live";
        document.body.dataset.gdLiveGpsAt=String(Date.now());
      }
    });
    safe(function(){
      if(typeof L!=="undefined"&&typeof map!=="undefined"&&map){
        var ll=L.latLng(point.lat,point.lng);
        if(!window.__gdLiveGpsMarker){
          window.__gdLiveGpsMarker=L.circleMarker(ll,{radius:6,color:"#1fd36d",weight:2,opacity:.95,fillColor:"#1fd36d",fillOpacity:.32,interactive:false}).addTo(map);
        }else if(window.__gdLiveGpsMarker.setLatLng){
          window.__gdLiveGpsMarker.setLatLng(ll);
        }
      }
    });
    safe(function(){gpsOk=true});
    setGpsSafe(true,source==="gps-refresh"?"GPS refreshed":"GPS live");
    return true;
  }
  function rememberGpsPosition(pos,source){
    var ll=latLngFromPosition(pos);
    if(!ll)return null;
    rememberLiveGpsOnly(ll,pos&&pos.coords?pos.coords.accuracy:null,source||"gps");
    return ll;
  }
  function updateGpsInsideLockedFrameOwner(here,label){
    if(!here)return false;
    var currentStart=safe(function(){return typeof start!=="undefined"?start:null},null);
    if(!currentStart)return false;
    rememberLiveGpsOnly(here,null,label||"GPS live");
    var moved=safe(function(){return map.distance(currentStart,here)},0);
    var max=safe(function(){return Number(lockedGpsUpdateMaxM)||0},0);
    if(max&&moved>max){
      setGpsSafe(true,"GPS moved");
      safe(function(){if(typeof toast==="function")toast("GPS moved outside locked frame · reset for new shot")});
      return false;
    }
    setGpsSafe(true,label||"GPS live");
    pulseStartDot();
    return true;
  }
  function startLocationWatch(){
    if(safe(function(){return !!gpsWatch},false)||!navigator.geolocation)return null;
    var watch=navigator.geolocation.watchPosition(function(pos){
      var here=rememberGpsPosition(pos,"gps-watch");
      if(!here)return;
      var hasStart=safe(function(){return !!start},false);
      if(!hasStart)return;
      if(safe(function(){return !!lockedFrame},false)){
        updateGpsInsideLockedFrameOwner(here,"GPS live");
      }
    },function(err){
      window.gdGpsState=window.gdGpsState||{};
      window.gdGpsState.lastError=err||null;
      setGpsSafe(false,"GPS weak");
    },{enableHighAccuracy:true,maximumAge:3000,timeout:10000});
    safe(function(){gpsWatch=watch});
    return watch;
  }
  function stopLocationWatch(reason){
    var watch=safe(function(){return gpsWatch},null);
    if(watch&&navigator.geolocation){
      safe(function(){navigator.geolocation.clearWatch(watch)});
    }
    safe(function(){gpsWatch=null});
    window.gdGpsState=window.gdGpsState||{};
    window.gdGpsState.watchStoppedAt=Date.now();
    window.gdGpsState.watchStopReason=reason||"gps-location-lifecycle";
    return true;
  }
  function requestGpsFix(opts){
    opts=opts||{};
    if(window.__gdGpsLocationRequestActive)return false;
    if(!navigator.geolocation){
      setGpsSafe(false,"GPS unavailable");
      safe(function(){if(typeof toast==="function")toast("GPS unavailable")});
      return false;
    }
    window.__gdGpsLocationRequestActive=true;
    setGpsSafe(true,"GPS...");
    navigator.geolocation.getCurrentPosition(function(pos){
      window.__gdGpsLocationRequestActive=false;
      var here=rememberGpsPosition(pos,opts.source||"gps-refresh");
      if(!here)return;
      if(safe(function(){return !!lockedFrame},false)){
        updateGpsInsideLockedFrameOwner(here,opts.label||"GPS live");
        setStateSafe("Live locked");
      }else{
        setStateSafe(opts.state||"GPS live");
      }
      hideGpsHintSafe();
      startLocationWatch();
      if(opts.toast!==false)safe(function(){if(typeof toast==="function")toast(opts.toastLabel||"GPS refreshed")});
      safe(function(){if(typeof gdV62Refresh==="function")gdV62Refresh()});
    },function(err){
      window.__gdGpsLocationRequestActive=false;
      window.gdGpsState=window.gdGpsState||{};
      window.gdGpsState.permissionKnown=true;
      window.gdGpsState.permissionGranted=!(err&&err.code===1);
      window.gdGpsState.lastError=err||null;
      var labels=gpsErrorLabel(err);
      setGpsSafe(false,labels.gps);
      setStateSafe(labels.state);
      if(labels.hint)showGpsHintSafe(labels.hint);
      else hideGpsHintSafe();
      safe(function(){if(typeof toast==="function")toast(err&&err.message?err.message:labels.toast)});
      safe(function(){if(typeof gdV62Refresh==="function")gdV62Refresh()});
    },{enableHighAccuracy:true,maximumAge:opts.maximumAge==null?0:opts.maximumAge,timeout:opts.timeout||15000});
    return true;
  }
  function initGpsLocation(){
    if(!navigator.geolocation){
      safe(function(){gpsOk=false});
      setGpsSafe(false,"Manual");
      showGpsHintSafe(safe(function(){return gdMappedStartHint()},"Tap twice: ball then green"));
      return false;
    }
    return requestGpsFix({source:"gps-init",toast:false,state:"GPS live",maximumAge:3000,timeout:8000});
  }
  function refreshGpsLocation(){return requestGpsFix({source:"gps-refresh",toast:true,toastLabel:"GPS refreshed",state:"GPS live",maximumAge:0,timeout:8000})}
  function centerOnPlayerOwner(){
    if(safe(function(){return !!lockedFrame},false)){
      safe(function(){if(typeof toast==="function")toast("Frame locked · GPS dot still live")});
      pulseStartDot();
      return false;
    }
    safe(function(){if(typeof clearMapRotation==="function")clearMapRotation()});
    var currentStart=safe(function(){return typeof start!=="undefined"?start:null},null);
    if(!currentStart)return refreshGpsLocation();
    safe(function(){map.panTo(currentStart,{animate:true,duration:.35})});
    pulseStartDot();
    return true;
  }
  window.GDGpsLocationLifecycle={
    id:"gdGpsPlayRuntimeOwnerV1",
    init:initGpsLocation,
    refresh:refreshGpsLocation,
    locate:function(){return requestGpsFix({source:"gps-locate",toast:true,toastLabel:"GPS located",state:"GPS live",maximumAge:0,timeout:15000})},
    startWatch:startLocationWatch,
    stopWatch:stopLocationWatch,
    rememberFix:rememberGpsPosition,
    rememberLive:rememberLiveGpsOnly,
    updateLocked:updateGpsInsideLockedFrameOwner,
    centerOnPlayer:centerOnPlayerOwner
  };
  window.initGPS=initGpsLocation;
  window.refreshGPS=refreshGpsLocation;
  window.gdGpsLocateNow=window.GDGpsLocationLifecycle.locate;
  window.gdGpsRememberFix=rememberGpsPosition;
  window.gdGpsApplyFix=function(point,opts){opts=opts||{};return rememberLiveGpsOnly(latLngFromPosition(point),opts.accuracy,opts.source||"gps-live")};
  window.gdRememberLiveGpsOnly=rememberLiveGpsOnly;
  window.updateGpsInsideLockedFrame=updateGpsInsideLockedFrameOwner;
  window.startWatch=startLocationWatch;
  window.stopGpsWatch=stopLocationWatch;
  window.centerOnPlayer=centerOnPlayerOwner;
  function liftShellTop(){
    var top=byId("shellTop");
    if(!top||!document.body)return false;
    if(top.parentElement!==document.body)document.body.appendChild(top);
    top.dataset.gdShellLayer="body";
    return true;
  }
  function stop(event){if(!event)return;if(event.preventDefault)event.preventDefault();if(event.stopPropagation)event.stopPropagation();if(event.stopImmediatePropagation)event.stopImmediatePropagation()}
  function visible(el){if(!el||el.hidden||(el.classList&&el.classList.contains("hidden")))return false;var cs=getComputedStyle(el);var r=el.getBoundingClientRect();return cs.display!=="none"&&cs.visibility!=="hidden"&&r.width>0&&r.height>0}
  function canonicalShellNavActive(){return typeof window.gdCanonicalShellHome==="function"&&typeof window.gdCanonicalShellBack==="function"}
	  function pickerOpen(){return visible(byId("courseScreen"))}
	  function homeOpen(){return document.body.classList.contains("shell-home")&&visible(byId("shellHome"))}
	  function moduleOpen(){return document.body.classList.contains("shell-module")}
	  function gpsOpen(){return !!document.body&&(document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active"))&&!homeOpen()&&!moduleOpen()}
	  function gdGpsExplicitMapMode(reason){
	    return safe(function(){
	      var tool=String(document.body.dataset&&document.body.dataset.gdToolScreen||"");
	      var why=String(reason||"");
	      return tool==="mapping"||
	        document.body.classList.contains("gdFullMappingMode")||
	        document.body.classList.contains("gdExplicitRemapMode")||
	        document.body.classList.contains("gdMappingRepairActive")||
	        document.body.classList.contains("gdGpsInteractiveGreenFallbackActive")||
	        !!window.gdFullMappingMode||
	        !!window.__gdMapperObjectCaptureActive||
	        /(^|[-_ ])(mapping|remap|mapper-tool|manual-map|capture|green-fallback|interactive-green|select-green)([-_ ]|$)/i.test(why);
	    },false);
	  }
	  function gpsIdentity(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"")}
	  function activeCourseIdentity(){
	    return safe(function(){
	      var c=course();
	      return gpsIdentity(c&&(c.courseId||c.id||c.name||c.courseName)||document.body.dataset.gdActiveCourseName||"");
	    },"");
	  }
	  function manifestKey(manifest){
	    return String(manifest&&(manifest.key||manifest.storageKey||manifest.scanId||manifest.activeScanId)||"");
	  }
	  function gdGpsLiveMapExplicitlyAllowed(reason){
	    return pickerOpen()||document.body.classList.contains("gdCoursePickerOpen")||gdGpsExplicitMapMode(reason);
	  }
	  function gdGpsPresentationReady(){
	    return safe(function(){
	      if(!document.body)return false;
	      if(document.body.classList.contains("gdGpsHoleTransitioning"))return false;
	      if(document.body.classList.contains("gdHoleFrameLoading"))return false;
	      var last=window.__gdV19LastCapturedFit;
	      var captured=document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&document.body.classList.contains("gdHoleImageCameraOn");
	      var layer=byId("gdHoleImageCameraLayer");
	      var tiles=layer&&layer.querySelector(".gdHoleImageTiles .gdHoleImageTile");
	      var fitted=!!(last&&Number(last.at)>0&&Number(last.tiles)>0);
	      var active=currentHole();
	      var lastHole=Number(last&&last.hole);
	      var layerHole=Number(layer&&layer.dataset&&layer.dataset.gdCapturedSurfaceHole);
	      if(Number.isFinite(lastHole)&&Math.round(lastHole)!==Math.round(active))return false;
	      if(Number.isFinite(layerHole)&&Math.round(layerHole)!==Math.round(active))return false;
	      var manifest=safe(function(){return typeof window.gdLoadHoleImageCaptureManifest==="function"?window.gdLoadHoleImageCaptureManifest():window.gdHoleImageCaptureManifest||window.__gdV19CapturedHoleFrameManifest||null;},null);
	      if(!manifest||typeof window.gdCapturedSurfaceManifestMatchesActive==="function"&&!window.gdCapturedSurfaceManifestMatchesActive(manifest))return false;
	      var stamp=window.__gdGpsCapturedPresentationStamp||{};
	      var stampHole=Number(stamp.hole);
	      if(!Number.isFinite(stampHole)||Math.round(stampHole)!==Math.round(active))return false;
	      var activeCourse=activeCourseIdentity();
	      var stampCourse=gpsIdentity(stamp.course||stamp.manifestCourse||"");
	      var lastCourse=gpsIdentity(last&&last.course||"");
	      var layerCourse=gpsIdentity(layer&&layer.dataset&&layer.dataset.gdCapturedSurfaceCourse||"");
	      var manifestCourse=gpsIdentity(manifest.courseKey||manifest.courseName||"");
	      if(activeCourse&&stampCourse&&stampCourse!==activeCourse)return false;
	      if(activeCourse&&lastCourse&&lastCourse!==activeCourse)return false;
	      if(activeCourse&&layerCourse&&layerCourse!==activeCourse)return false;
	      if(activeCourse&&manifestCourse&&manifestCourse!==activeCourse)return false;
	      var key=manifestKey(manifest);
	      var layerKey=String(layer&&layer.dataset&&layer.dataset.gdCapturedSurfaceManifestKey||"");
	      if(key&&stamp.manifestKey&&String(stamp.manifestKey)!==key)return false;
	      if(key&&layerKey&&layerKey!==key)return false;
	      var transitionAt=Number(document.body.dataset&&document.body.dataset.gdGpsHoleTransitionAt||0);
	      if(Number.isFinite(transitionAt)&&transitionAt>0&&Number(stamp.fitAt||0)<transitionAt)return false;
	      return !!(captured&&layer&&tiles&&fitted&&Number(stamp.tiles)>0&&!document.body.classList.contains("gdFrameCameraWaiting"));
	    },false);
	  }
	  function gdGpsPlayMayExposeLiveMap(reason){
	    return safe(function(){
	      if(!gpsOpen())return true;
	      return gdGpsLiveMapExplicitlyAllowed(reason);
	    },false);
	  }
	  function gdApplyGpsMapVisibilityOwner(reason){
	    return safe(function(){
	      if(!document.body)return true;
	      var explicit=gdGpsLiveMapExplicitlyAllowed(reason);
	      var ready=gdGpsPresentationReady();
	      document.body.classList.toggle("gdGpsExplicitMapMode",!!explicit);
	      document.body.classList.toggle("gdGpsPresentationReady",!!ready);
	      document.body.classList.toggle("gdGpsLiveMapAllowed",!!(gpsOpen()&&explicit));
	      if(!gpsOpen()||pickerOpen()||homeOpen()||moduleOpen()){
	        document.body.classList.toggle("gdGpsLiveMapAllowed",!!(gpsOpen()&&pickerOpen()));
	        document.body.classList.remove("gdGpsLiveMapSuppressed");
	        document.body.dataset.gdGpsMapVisibilityOwner=String(reason||"not-gps");
	        document.body.dataset.gdGpsMapVisibilityState=pickerOpen()?"picker-live-map":"not-gps";
	        return true;
	      }
	      var mayExpose=gdGpsPlayMayExposeLiveMap(reason);
	      var shouldSuppress=!mayExpose;
	      document.body.classList.toggle("gdGpsLiveMapSuppressed",!!shouldSuppress);
	      document.body.dataset.gdGpsMapVisibilityOwner=String(reason||"gps-visibility");
	      document.body.dataset.gdGpsMapVisibilityState=mayExpose?"explicit-live-map":ready?"captured-presentation":document.body.classList.contains("gdCapturedFrameUnavailable")?"unavailable":"live-map-hidden";
	      return mayExpose;
	    },true);
	  }
	  window.gdGpsPresentationReady=gdGpsPresentationReady;
	  window.gdGpsPlayMayExposeLiveMap=gdGpsPlayMayExposeLiveMap;
	  window.gdGpsLiveMapExplicitlyAllowed=gdGpsLiveMapExplicitlyAllowed;
	  window.gdApplyGpsMapVisibilityOwner=gdApplyGpsMapVisibilityOwner;
	  function gpsFrameReady(){
	    return safe(function(){
	      return gdGpsExplicitMapMode("frame-ready")||
	        document.body.classList.contains("gdCapturedFrameUnavailable")||
	        gdGpsPresentationReady();
	    },false);
	  }
	  function releaseGpsFirstPaintGate(reason){
	    safe(function(){
	      if(gpsOpen()&&!pickerOpen()&&!homeOpen()&&!moduleOpen()&&!gpsFrameReady()&&!/leave|permission|not-gps/i.test(String(reason||""))){
	        document.body.classList.add("gdGpsFramePreparing");
	        gdApplyGpsMapVisibilityOwner((reason||"release")+"-blocked");
	        return;
	      }
	      gdApplyGpsMapVisibilityOwner((reason||"release")+"-pre");
	      document.body.classList.remove("gdGpsFramePreparing");
	      document.body.dataset.gdGpsFirstPaintGateReleased=String(reason||"ready");
	      gdApplyGpsMapVisibilityOwner(reason||"release");
	    });
	  }
	  function syncGpsFirstPaintGate(reason){
	    if(!document.body)return true;
	    if(!gpsOpen()||pickerOpen()||homeOpen()||moduleOpen()){releaseGpsFirstPaintGate(reason||"not-gps");return true;}
	    if(gpsFrameReady()){releaseGpsFirstPaintGate(reason||"frame-ready");return true;}
	    document.body.classList.add("gdGpsFramePreparing");
	    document.body.dataset.gdGpsFirstPaintGateReason=String(reason||"waiting-frame");
	    gdApplyGpsMapVisibilityOwner(reason||"waiting-frame");
	    return false;
	  }
	  function startGpsFirstPaintGate(reason){
	    if(!document.body)return;
	    var token=++gpsFirstPaintGateToken;
	    document.body.classList.add("gdGpsFramePreparing");
	    document.body.dataset.gdGpsFirstPaintGateReason=String(reason||"enter-gps");
	    gdApplyGpsMapVisibilityOwner(reason||"enter-gps");
	    [0,80,180,360,720,1200,2000,3200].forEach(function(delay){
      setTimeout(function(){
        if(token!==gpsFirstPaintGateToken)return;
        syncGpsFirstPaintGate((reason||"enter-gps")+"-"+delay);
      },delay);
    });
  }
  function setRouteLabel(label){var el=byId("shellRouteLabel");if(el)el.textContent=label||""}
	  function cleanRouteClasses(route){
	    if(!document.body)return;
	    document.body.classList.remove("shell-home","shell-gps","shell-module","gdGpsActive","gps-active","gps-open","manual-gps-active","gdCoursePickerOpen","gdCoursePinPromptActive","gdToolRailOpen");
	    if(route!=="gps")releaseGpsFirstPaintGate(route||"leave-gps");
	    if(route==="home")document.body.classList.add("shell-home");
	    if(route==="gps")document.body.classList.add("shell-gps","gdGpsActive","gps-active");
	    if(route==="module")document.body.classList.add("shell-module");
	    if(document.body.dataset){
	      document.body.dataset.clarityRoute=route==="module"?"module":route==="gps"?"gps":"home";
	      if(route==="home")document.body.dataset.gdToolScreen="home";
	      else if(route==="module")document.body.dataset.gdToolScreen="module";
	      else if(document.body.dataset.gdToolScreen==="home"||document.body.dataset.gdToolScreen==="module"||document.body.dataset.gdToolScreen==="picker")document.body.dataset.gdToolScreen="unmapped";
	      if(route!=="gps"){
	        ["gdCourseNeedsPin","gdCourseNeedsPinCourse","gdCoursePinDecision","gdCourseDatabaseMapAvailable","gdCourseDatabaseMapSource","gdCourseAutoMapStatus","gdCourseAutoMappedHoles","gdCourseAutoMapSaved","gdCourseScannerSeed"].forEach(function(key){delete document.body.dataset[key]});
	        safe(function(){window.__gdCoursePickerPinPromptActive=false;window.__gdPendingCoursePinPayload=null;});
	      }
	    }
	  }
  function clearCaptured(reason){
    safe(function(){
      document.body.classList.remove("gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn");
      window.__gdSpringCleanLastCapturedClear={reason:reason||"surface",at:Date.now()};
    });
  }
  function activeFrameSurface(){
    return safe(function(){
      return document.body.classList.contains("gdMappedStartPromptActive")||
        document.body.classList.contains("gd-frame-hard-locked")||
        document.body.classList.contains("gdGreenArrivalMode")||
        document.body.classList.contains("gd-green-zoom-active");
    },false);
  }
  function guardSurface(){
    if(!document.body)return;
    liftShellTop();
    if(homeOpen())clearCaptured("home");
    else if(pickerOpen())clearCaptured("course-picker");
    else if(moduleOpen()&&!activeFrameSurface())clearCaptured("module");
    document.body.classList.toggle("gdCoursePickerOpen",pickerOpen());
    syncGpsFirstPaintGate("guard-surface");
  }
  function point(value){
    if(!value)return null;
    var ll=safe(function(){return typeof value.getLatLng==="function"?value.getLatLng():value},value);
    var lat=Number(ll&&ll.lat),lng=Number(ll&&ll.lng);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat:lat,lng:lng}:null;
  }
  function latLng(value){
    var p=point(value);
    if(!p)return null;
    return safe(function(){return L.latLng(p.lat,p.lng)},p);
  }
  function course(){
    var c=safe(function(){return currentCourse},null)||safe(function(){return window.currentCourse},null)||safe(function(){return window.gdActiveCourse},null);
    if(!c||typeof c!=="object")return null;
    var name=String(c.name||c.courseName||"").trim();
    var out={name:name,courseName:name,courseId:String(c.courseId||c.id||c.canonicalKey||name||"").trim(),id:String(c.id||c.courseId||c.canonicalKey||name||"").trim()};
    if(Number.isFinite(Number(c.lat)))out.lat=Number(c.lat);
    if(Number.isFinite(Number(c.lng)))out.lng=Number(c.lng);
    return out.name||out.courseId?out:null;
  }
  function courseLabel(c){
    return String((c&&(c.name||c.courseName))||safe(function(){return window.gdActiveCourseDisplayName},"")||safe(function(){return byId("courseLine").textContent},"")||safe(function(){return sessionStorage.getItem("gd_assumed_course_name")},"")||"").trim();
  }
  function currentHole(){
    var values=[safe(function(){return currentPlayingHole},0),safe(function(){return selectedHole},0),safe(function(){return window.gdMapperActiveHole},0),safe(function(){return sessionStorage.getItem("gd_active_playing_hole")},0),safe(function(){return sessionStorage.getItem("gd_mapper_active_hole")},0)];
    for(var i=0;i<values.length;i++){var n=Number(values[i]);if(Number.isFinite(n)&&n>0)return Math.round(n)}
    return 1;
  }
  function shouldBypassGpsRoundStartPermission(options){
    options=options||{};
    return !!(options.fromResume || options.fromBack || options.preserve || options.preserveState);
  }
  function normalizeResume(raw,source){
    if(!raw||typeof raw!=="object")return null;
    var updated=Number(raw.updatedAt||0);
    if(!Number.isFinite(updated)||updated<=0)return null;
    if(Date.now()-updated>RESUME_TTL_MS){
      safe(function(){localStorage.removeItem(source==="legacy"?LEGACY_RESUME_KEY:RESUME_KEY)});
      return null;
    }
    var c=raw.course&&typeof raw.course==="object"?raw.course:null;
    var rawLabel=String(raw.courseLabel||raw.courseName||raw.course||(c&&(c.name||c.courseName))||"").trim();
    var startPoint=point(raw.start);
    var targetPoint=point(raw.target);
    var greenPoint=point(raw.green||raw.greenCentre);
    var pinPoint=point(raw.pin);
    if(!c&&!startPoint&&!targetPoint&&!greenPoint&&!raw.activated)return null;
    return {updatedAt:updated,expiresAt:updated+RESUME_TTL_MS,source:source,course:c,courseLabel:rawLabel||"GPS round",hole:Number(raw.hole)||1,mode:String(raw.mode||""),locked:!!raw.locked,activated:!!raw.activated,start:startPoint,target:targetPoint,green:greenPoint,pin:pinPoint,hasShot:!!(raw.hasShot||raw.start||raw.target||raw.green||raw.greenCentre)};
  }
  function readResume(){
    return normalizeResume(safe(function(){return JSON.parse(localStorage.getItem(RESUME_KEY)||"null")},null),"primary");
  }
  function resumeActivated(){return safe(function(){return sessionStorage.getItem("gd_resume_round_activated")==="1"},false)}
  function setResumeActivated(on){safe(function(){if(on)sessionStorage.setItem("gd_resume_round_activated","1");else sessionStorage.removeItem("gd_resume_round_activated")})}
  function writeResume(reason){
    if(Date.now()-Number(window.__gdResumeRoundClearedAt||0)<800)return null;
    if(!gpsOpen()&&!pickerOpen())return null;
    var c=course(),label=courseLabel(c);
    var live=safe(function(){return typeof window.gdGpsLiveResumeSnapshot==="function"?window.gdGpsLiveResumeSnapshot(reason||"resume-write"):null},null)||{};
    var startPoint=point(live.start)||point(safe(function(){return start},null));
    var targetPoint=point(live.target)||point(safe(function(){return target},null));
    var greenPoint=point(live.green)||point(safe(function(){return greenCentre},null));
    var pinPoint=point(live.pin)||point(safe(function(){return pin},null));
    var hasCoords=!!(startPoint||targetPoint||greenPoint);
    if(pickerOpen()&&!hasCoords)return null;
    if(!hasCoords&&!resumeActivated()&&!c)return null;
    if(!label&&!c&&!hasCoords)return null;
    var payload={version:4,reason:reason||"auto",route:"gps",updatedAt:Date.now(),expiresAt:Date.now()+RESUME_TTL_MS,course:c,courseLabel:label||"GPS round",hole:currentHole(),mode:String(live.mode||safe(function(){return mode},"")||""),locked:!!(live.locked||safe(function(){return lockedFrame},false)),activated:resumeActivated()||hasCoords||!!c,start:startPoint,target:targetPoint,green:greenPoint,pin:pinPoint,undoDepth:Number(safe(function(){return Array.isArray(undoStack)?undoStack.length:0},0))||0};
    payload.hasShot=!!(live.hasShot||(payload.start&&payload.target)||payload.green);
    safe(function(){localStorage.setItem(RESUME_KEY,JSON.stringify(payload))});
    return payload;
  }
  function clearResume(){
    safe(function(){localStorage.removeItem(RESUME_KEY)});
    safe(function(){localStorage.removeItem(LEGACY_RESUME_KEY)});
    setResumeActivated(false);
    window.__gdResumeRoundClearedAt=Date.now();
  }
  function resumeAge(saved){var m=Math.max(1,Math.round((Date.now()-Number(saved.updatedAt||0))/60000));return m<60?m+" min ago":Math.max(1,Math.round(m/60))+" hr ago"}
  function resumeDetail(saved){return (saved.courseLabel||"GPS round")+" · H"+(Number(saved.hole)||1)+" · "+resumeAge(saved)}
  function ensureResumePanel(){
    var screen=byId("courseScreen");
    if(!screen)return null;
    var panel=byId("gdCourseResumeRound");
    if(!panel){
      panel=document.createElement("div");
      panel.id="gdCourseResumeRound";
      panel.innerHTML='<button class="gdCourseResumePrimary" type="button"><strong>Resume Round</strong><span></span></button><button class="gdCourseResumeNew" type="button">End Round</button>';
      var header=screen.querySelector(".courseHeader");
      if(header&&header.parentNode)header.parentNode.insertBefore(panel,header.nextSibling);
      else screen.insertBefore(panel,screen.firstChild);
    }
    var saved=readResume();
    panel.hidden=!saved;
    panel.classList.toggle("visible",!!saved);
    var detailEl=panel.querySelector(".gdCourseResumePrimary span");
    if(detailEl)detailEl.textContent=saved?resumeDetail(saved):"";
    var resume=panel.querySelector(".gdCourseResumePrimary");
    if(resume&&!resume.__gdSpringResumeBound){resume.__gdSpringResumeBound=true;resume.addEventListener("click",resumeRound,true)}
    var end=panel.querySelector(".gdCourseResumeNew");
    if(end){end.textContent="End Round";if(!end.__gdSpringEndBound){end.__gdSpringEndBound=true;end.addEventListener("click",endRound,true)}}
    return panel;
  }
  function showPicker(reason){
	    writeResume(reason||"show-picker");
	    safe(function(){document.querySelectorAll(".panel.open,.modulePanel.open").forEach(function(el){el.classList.remove("open")})});
    cleanRouteClasses("gps");
    safe(function(){
      document.body.classList.remove("gdMappedStartPromptActive","gdManualStartPlacementActive","gdHeadToTeeFrameActive","gdLockStateFrameActive","gd-frame-hard-locked","gdGreenArrivalMode","gd-green-zoom-active","gdBubbleLongPressZoomActive","gdCapturedBubbleDragging","gdToolRailOpen","gdCourseOpening","gdCoursePinPromptActive");
      ["gdCourseNeedsPin","gdCourseNeedsPinCourse","gdCoursePinDecision","gdCourseDatabaseMapAvailable","gdCourseDatabaseMapSource","gdCourseAutoMapStatus","gdCourseAutoMappedHoles","gdCourseAutoMapSaved","gdCourseScannerSeed"].forEach(function(key){delete document.body.dataset[key]});
      window.__gdCoursePickerPinPromptActive=false;
      if(typeof window.gdClearCapturedHoleFrameShotOverlay==="function")window.gdClearCapturedHoleFrameShotOverlay();
    });
    clearCaptured("course-picker");
    safe(function(){var homeEl=byId("shellHome");if(homeEl)homeEl.classList.add("hidden")});
	    safe(function(){var s=byId("courseScreen");if(s){s.classList.remove("hidden");s.style.display="flex";s.style.pointerEvents="auto";s.style.visibility="";s.style.opacity=""}});
	    safe(function(){document.body.dataset.clarityRoute="gps";document.body.dataset.gdToolScreen="picker"});
	    setRouteLabel("GPS");
    safe(function(){if(typeof gdRefreshAssumedCourseFromLocation==="function")gdRefreshAssumedCourseFromLocation()});
	    ensureResumePanel();
	    setTimeout(ensureResumePanel,160);
	    safe(function(){if(typeof window.gdCoursePickerCenterMapOnGps==="function")window.gdCoursePickerCenterMapOnGps()});
	    safe(function(){if(typeof window.gdCoursePickerRequestGps==="function")window.gdCoursePickerRequestGps()});
		    guardSurface();
		    return false;
		  }
	  function scheduleBackPrelockPickerRestore(reason){
	    window.__gdBackPrelockPickerUntil=Date.now()+2400;
	    [60,180,420,900,1500,2200].forEach(function(delay){
	      setTimeout(function(){
	        if(Date.now()>Number(window.__gdBackPrelockPickerUntil||0))return;
	        if(pickerOpen())return;
	        showPicker((reason||"back-prelock")+"-restore");
	      },delay);
	    });
	  }
  function repaintResumeShot(reason){
    safe(function(){
      if(start && target && !document.body.classList.contains("gdMappedStartPromptActive") && !document.body.classList.contains("gdGreenArrivalMode")){
        var tile = byId("shotTile");
        if(tile) tile.classList.add("visible");
      }
    });
    safe(function(){if(typeof renderShot==="function")renderShot()});
    safe(function(){if(typeof updatePinLine==="function")updatePinLine()});
    safe(function(){if(typeof window.gdRepaintCapturedHoleFrameShotOverlay==="function")window.gdRepaintCapturedHoleFrameShotOverlay(reason||"resume-round")});
    safe(function(){if(typeof window.gdForceCapturedOverlayFromCurrentShot==="function")window.gdForceCapturedOverlayFromCurrentShot(reason||"resume-round")});
	    safe(function(){if(typeof window.gdPaintCapturedShotOverlayOwner==="function")window.gdPaintCapturedShotOverlayOwner(reason||"resume-round")});
  }
  function lockedGpsResumeToRestore(reason){
    if(gpsSurfaceRestoreBusy||!gpsOpen()||pickerOpen()||homeOpen()||moduleOpen())return null;
    var saved=readResume();
    if(!saved||!saved.hasShot||!(saved.start&&saved.target))return null;
    var locked=document.body.classList.contains("gdLockStateFrameActive")||
      document.body.classList.contains("gd-frame-hard-locked")||
      !!saved.locked;
	    if(!locked)return null;
	    var captured=byId("gdHoleImageCameraLayer");
	    var needsCaptured=!document.body.classList.contains("gdCapturedHoleFrameCameraOn")||!visible(captured);
	    return needsCaptured?saved:null;
	  }
  function restoreGpsSurfaceFromResume(reason){
    var saved=lockedGpsResumeToRestore(reason);
    if(!saved)return false;
    gpsSurfaceRestoreBusy=true;
    safe(function(){
      document.body.classList.remove("shell-home","shell-module","gdCoursePickerOpen","gdToolRailEmpty");
      document.body.classList.add("shell-gps","gdGpsActive","gps-active","gdMappedCourseMode","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn");
      if(saved.locked)document.body.classList.add("gdLockStateFrameActive","gd-frame-hard-locked");
      if(document.body.dataset&&(document.body.dataset.gdToolScreen==="home"||document.body.dataset.gdToolScreen==="module"||document.body.dataset.gdToolScreen==="picker"))document.body.dataset.gdToolScreen="mapped";
    });
    restoreResume(saved);
    repaintResumeShot(reason||"gps-surface-restore");
    safe(function(){
      if(saved.locked&&typeof window.gdFitLockStateFrameV19==="function")window.gdFitLockStateFrameV19({force:true,objectName:"moduleReturnLockFrame",reason:reason||"gps-surface-restore"});
    });
    [140,420,900].forEach(function(delay){
      setTimeout(function(){
        if(!gpsOpen()||pickerOpen()||homeOpen()||moduleOpen())return;
	        safe(function(){document.body.classList.add("gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn")});
	        gdApplyGpsMapVisibilityOwner((reason||"gps-surface-restore")+"-late");
	        repaintResumeShot((reason||"gps-surface-restore")+"-late");
        safe(function(){if(saved.locked&&typeof window.gdFitLockStateFrameV19==="function")window.gdFitLockStateFrameV19({force:true,objectName:"moduleReturnLockFrameLate",reason:reason||"gps-surface-restore-late"})});
        syncToolRail();
      },delay);
    });
    gpsSurfaceRestoreBusy=false;
    syncGpsFirstPaintGate(reason||"gps-surface-restore");
    return true;
  }
  function restoreResume(saved){
    var c=saved.course||course();
    if(c){
      safe(function(){currentCourse=c});
      safe(function(){window.currentCourse=c;window.gdActiveCourse=c;window.gdActiveCourseDisplayName=c.name||c.courseName||""});
      safe(function(){document.body.dataset.gdActiveCourseName=c.name||c.courseName||""});
    }
    var label= saved.courseLabel||courseLabel(c);
    safe(function(){var line=byId("courseLine");if(line&&label&&label!=="GPS round"){line.textContent=label;line.style.display="block"}});
    var h=Math.max(1,Math.round(Number(saved.hole)||1));
    safe(function(){currentPlayingHole=selectedHole=h;window.gdMapperActiveHole=h});
    safe(function(){sessionStorage.setItem("gd_gps_session_activated","1");sessionStorage.setItem("gd_active_playing_hole",String(h));sessionStorage.setItem("gd_mapper_active_hole",String(h))});
    safe(function(){if(typeof setHole==="function")setHole({hole:h})});
	    var restored=false;
	    var s=latLng(saved.start),g=latLng(saved.green),t=latLng(saved.target),p=latLng(saved.pin);
	    var engineRestored=false;
	    if(s&&t){
	      engineRestored=safe(function(){
	        return typeof window.gdGpsRestoreResumeSnapshot==="function"&&window.gdGpsRestoreResumeSnapshot(saved,{objectName:"resumeRoundEngine",reason:"resume-round"});
	      },false);
	      if(engineRestored)restored=true;
	    }
	    if(s){restored=true;safe(function(){if(typeof setStart==="function")setStart(s,false);else start=s})}
	    if(g){restored=true;safe(function(){greenCentre=g})}
	    if(t){restored=true;safe(function(){if(typeof gdSetTargetFromDisplayedLanding==="function")gdSetTargetFromDisplayedLanding(t);else target=t;var shown=(typeof gdShotDisplayTarget==="function"&&(gdShotDisplayTarget()||null))||target||t;if(typeof createTargetMarker==="function")createTargetMarker(shown);else if(targetMarker&&targetMarker.setLatLng)targetMarker.setLatLng(shown)})}
	    if(p){restored=true;safe(function(){pin=p})}
	    var hasShotPoints=!!(s&&t);
	    if(restored&&hasShotPoints){
	      safe(function(){mode=hasShotPoints?"aim":(saved.mode||"aim")});
	      safe(function(){if(saved.locked)lockedFrame=true});
	      safe(function(){if(saved.locked&&document.body)document.body.classList.add("gdLockStateFrameActive","gd-frame-hard-locked")});
	      safe(function(){if(typeof renderShot==="function")renderShot()});
	      safe(function(){if(typeof updatePinLine==="function")updatePinLine()});
	      safe(function(){if(saved.locked&&typeof window.gdFitLockStateFrameV19==="function")window.gdFitLockStateFrameV19({force:true,objectName:"resumeRound",reason:"resume-round"});else if(typeof gdReframeShotAfterUndo==="function")gdReframeShotAfterUndo({refit:false})});
	      repaintResumeShot("resume-round");
	      [90,260,620].forEach(function(delay){
	        setTimeout(function(){
	          if(!gpsOpen()||pickerOpen()||homeOpen())return;
	          if(saved.locked)safe(function(){if(typeof window.gdFitLockStateFrameV19==="function")window.gdFitLockStateFrameV19({force:true,objectName:"resumeRoundRestore",reason:"resume-round-restore"})});
	          repaintResumeShot("resume-round-restore");
	        },delay);
	      });
	    }else{
	      safe(function(){lockedFrame=false;mode="start";target=null;pin=null;gdWindLandingTarget=null});
	      safe(function(){if(typeof clearShot==="function")clearShot()});
	      safe(function(){if(typeof gdResetShotDistanceDisplay==="function")gdResetShotDistanceDisplay()});
	      safe(function(){if(typeof window.gdFocusMappedPreLockHole==="function")window.gdFocusMappedPreLockHole(h,{source:"resume-round",preserveGpsSession:true,reenterGps:false,refreshGps:false})});
	      [80,260,620].forEach(function(delay){
	        setTimeout(function(){
	          if(gpsOpen()&&!pickerOpen()&&!homeOpen()&&!document.body.classList.contains("gdManualStartPlacementActive"))restoreMappedStartPrompt("resume-round-prelock");
	        },delay);
	      });
	    }
    safe(function(){if(typeof gdV62Refresh==="function")gdV62Refresh()});
    safe(function(){if(typeof window.gdHydrateGpsBadge==="function")window.gdHydrateGpsBadge(true)});
  }
  function scheduleResumeRestore(saved,reason){
    if(!saved)return;
    [180,520,980,1650,2600].forEach(function(delay){
      setTimeout(function(){
        if(!gpsOpen()||pickerOpen()||homeOpen())return;
        restoreResume(saved);
        repaintResumeShot((reason||"resume-round")+"-settle");
        writeResume((reason||"resume-round")+"-settle");
        guardSurface();
        syncToolRail();
      },delay);
    });
  }
  function resumeRound(event){
    stop(event);
    var saved=readResume();
    if(!saved){ensureResumePanel();safe(function(){if(typeof toast==="function")toast("No active round to resume")});return false}
    startGpsFirstPaintGate("resume-round");
    safe(function(){if(typeof oldEnter==="function")oldEnter.call(window,{replace:true,preserveState:true,keepGps:true,fromBack:true,fromResume:true})});
    safe(function(){var courseScreenEl=byId("courseScreen");if(courseScreenEl)courseScreenEl.classList.add("hidden")});
    cleanRouteClasses("gps");
    restoreResume(saved);
    scheduleResumeRestore(saved,"resume-round");
    writeResume("resume-round");
    guardSurface();
    queuePostOpeningToolSync("resume-round");
    safe(function(){if(typeof toast==="function")toast("Round resumed")});
    return false;
  }
  function endRound(event){
    stop(event);
    clearResume();
    safe(function(){if(typeof resetPlay==="function")resetPlay(true)});
    safe(function(){if(Array.isArray(undoStack))undoStack=[]});
    safe(function(){currentCourse=null;selectedHole=1;currentPlayingHole=1});
    safe(function(){window.currentCourse=null;window.gdActiveCourse=null;window.gdActiveCourseDisplayName="";window.gdMapperActiveHole=1});
    safe(function(){["gd_gps_session_activated","gd_active_playing_hole","gd_mapper_active_hole","gd_active_course_session_key","gd_assumed_course_name"].forEach(function(key){sessionStorage.removeItem(key)})});
    safe(function(){var line=byId("courseLine");if(line){line.textContent="";line.style.display="none"}if(typeof setHole==="function")setHole(null)});
    safe(function(){document.body.classList.remove("gdMappedCourseMode","gdMappedStartPromptActive","gdCourseOpening","gdGreenArrivalMode","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn")});
    safe(function(){window.__gdCoursePickerFirstHoleOpenToken=null;window.__gdWholeCourseAutoMapOnLoadToken=null});
    safe(function(){if(typeof gdRefreshAssumedCourseFromLocation==="function")gdRefreshAssumedCourseFromLocation()});
    ensureResumePanel();
    safe(function(){if(typeof toast==="function")toast("Round ended")});
    return false;
  }
	  function resumeUndoAvailable(){
	    if(safe(function(){return Array.isArray(undoStack)&&undoStack.length>0},false))return true;
	    return !!safe(function(){return placingPin},false);
	  }
  function home(event){
    if(event)stop(event);
    if(gpsOpen())writeResume("home");
    cleanGpsTransient("home");
    var result=typeof oldHome==="function"?oldHome.apply(this,arguments):false;
    queueHomeCleanup("home");
    return result;
  }
  function back(event){
    if(event)stop(event);
    safe(function(){window.__gdSpringBackHandledUntil=Date.now()+800});
    if(gpsOpen()&&!pickerOpen()){
	      if(document.body&&document.body.classList.contains("gdManualStartPlacementActive")){
	        cancelManualStart("back-cancel-manual-start");
	        writeResume("back-cancel-manual-start");
	        return false;
	      }
	      if(document.body&&document.body.classList.contains("gdMappedStartPromptActive")){
	        scheduleBackPrelockPickerRestore("back-prelock-to-course-picker");
	        writeResume("back-prelock-to-course-picker");
	        return showPicker("back-prelock-to-course-picker");
	      }
	      if(safe(function(){return !!window.gdPendingManualShotVerification},false)){
	        safe(function(){window.gdPendingManualShotVerification=false;if(typeof gdSyncNewShotButtonState==="function")gdSyncNewShotButtonState();if(typeof toast==="function")toast("Result logging cancelled")});
        writeResume("back-cancel-verification");
        return false;
      }
      if(resumeUndoAvailable()&&typeof undoLast==="function"){
        safe(function(){undoLast()});
        writeResume("back-undo");
        return false;
      }
      return showPicker("back-to-course-picker");
    }
    if(moduleOpen()&&window.__gdBackTarget==="gps"){
      window.__gdBackTarget="";
      if(typeof oldEnter==="function")return oldEnter.call(window,{replace:true,preserveState:true,fromBack:true,keepGps:true});
      cleanRouteClasses("gps");
      return false;
    }
    return typeof oldBack==="function"?oldBack.apply(this,arguments):home(event);
  }
  function pickerHome(event){
    stop(event);
    safe(function(){if(typeof window.gdHideCoursePinScreen==="function")window.gdHideCoursePinScreen()});
    writeResume("course-picker-home");
    return typeof oldPickerHome==="function"?oldPickerHome.call(this,event):home(event);
  }
  function pickerBack(event){
    stop(event);
    if(window.__gdCoursePickerPinPromptActive&&typeof window.gdCancelCoursePin==="function")return window.gdCancelCoursePin(event);
    if(window.__gdCoursePickerReturnTarget==="home"){
      window.__gdCoursePickerReturnTarget="";
      window.gdCourseChangeMode="";
      return home(event);
    }
    if(window.gdCourseChangeMode==="assumed-label"||window.gdCourseChangeMode==="change-course"){
      window.gdCourseChangeMode="";
      safe(function(){var courseScreenEl=byId("courseScreen");if(courseScreenEl)courseScreenEl.classList.add("hidden")});
      if(typeof oldEnter==="function")return oldEnter.call(window,{preserveState:true,fromBack:true,keepGps:true});
      return false;
    }
    return home(event);
  }
  function enter(opts){
    var options=opts||{};
    startGpsFirstPaintGate("enter-gps");
    if(shouldBypassGpsRoundStartPermission(options)){
      var resumeResult=typeof oldEnter==="function"?oldEnter.apply(this,arguments):false;
      setTimeout(function(){if(pickerOpen())ensureResumePanel();else if(!options.fromResume)writeResume("enter-gps");guardSurface();syncToolRail()},140);
      setTimeout(function(){if(pickerOpen())ensureResumePanel();guardSurface();syncToolRail()},520);
      return resumeResult;
    }
    var permissionCheck = window.ClarityPermissions && typeof window.ClarityPermissions.canUse==="function"
      ? window.ClarityPermissions.canUse(GPS_ROUND_START_PERMISSION_KEY, { route: "gps_round_start", resourceId: "gps-entry" })
      : Promise.resolve({ ok: false, allowed: false, permissionKey: GPS_ROUND_START_PERMISSION_KEY, reasons: ["PERMISSIONS_HELPER_MISSING"], entitlement: null, raw: null, error: "ClarityPermissions unavailable" });
    permissionCheck.then(function(check){
      if(check&&check.allowed){
        if(typeof oldEnter==="function")oldEnter.call(window,options);
      }else{
        releaseGpsFirstPaintGate("permission-denied");
        safe(function(){if(typeof toast==="function")toast("Start gate: active paid access is required for GPS rounds")});
      }
      setTimeout(function(){if(pickerOpen())ensureResumePanel();else if(!(options.fromResume))writeResume("enter-gps");guardSurface();syncToolRail()},140);
      setTimeout(function(){if(pickerOpen())ensureResumePanel();guardSurface();syncToolRail()},520);
    }).catch(function(){
      releaseGpsFirstPaintGate("permission-error");
      safe(function(){if(typeof toast==="function")toast("Start gate check failed. Try again.")});
      return false;
    });
    return false;
  }
  function openCourseWrapper(){
    var result=typeof oldOpenCourse==="function"?oldOpenCourse.apply(this,arguments):false;
    if(window.__gdCoursePickerPinPromptActive||document.body&&document.body.dataset&&document.body.dataset.gdCourseNeedsPin==="choose-course-pin")return result;
    setResumeActivated(true);
    setTimeout(function(){writeResume("course-open")},900);
    queuePostOpeningToolSync("course-open");
    return result;
  }
	  function manualStartVisual(on){
	    if(!document.body)return;
	    document.body.classList.toggle("gdManualStartPlacementActive",!!on);
    if(on){
      cleanRouteClasses("gps");
      document.body.classList.add("gdMappedStartPromptActive");
      document.body.classList.remove("gdToolRailOpen","gdGreenArrivalMode","gd-green-zoom-active","gdLockStateFrameActive","gd-frame-hard-locked");
      safe(function(){var hit=byId("gdCapturedBubbleDragHit");if(hit)hit.style.display="none"});
	      safe(function(){var appEl=byId("app");if(appEl){appEl.classList.remove("framed");appEl.classList.add("gdPreLockFrame")}});
	      var hint=byId("hint");
	      if(hint){hint.classList.remove("gdMappedStartPill");hint.classList.add("visible");hint.textContent="Tap where you are standing"}
	    }else{
	      document.body.classList.remove("gdManualStartPlacementActive");
	    }
	  }
	  function clearStandingPointRuntime(reason,opts){
	    opts=opts||{};
	    manualStartArmedAt=0;
	    manualStartLockToken+=1;
	    safe(function(){
	      window.__gdManualStartLockToken=manualStartLockToken;
	      window.__gdManualStandingPlacementActiveUntil=0;
	      window.__gdManualStartHadShotToLog=false;
	      window.__gdGreenFocusSettingBallUntil=0;
	      delete window.__gdLastStandingPoint;
	    });
	    safe(function(){if(typeof window.gdClearLocationSetLock==="function")window.gdClearLocationSetLock(reason||"clear-standing-point")});
	    manualStartVisual(false);
	    safe(function(){
	      if(!document.body)return;
	      document.body.classList.remove("gdManualStartPlacementActive");
	      if(!opts.preserveMappedPrompt)document.body.classList.remove("gdMappedStartPromptActive");
	      if(opts.clearLockState)document.body.classList.remove("gdHeadToTeeFrameActive","gdLockStateFrameActive","gd-frame-hard-locked","gdGreenArrivalMode","gd-green-zoom-active","gdBubbleLongPressZoomActive","gdCapturedBubbleDragging");
	    });
	    safe(function(){
	      if(!document.body||!document.body.dataset)return;
	      [
	        "gdStandingPointLat","gdStandingPointLng","gdStandingPointSource","gdStandingPointAt","gdStandingPointComplete",
	        "gdGreenFocusManualDistance","gdGreenFocusBallLat","gdGreenFocusBallLng","gdGreenFocusBallSource","gdGreenFocusDecision",
	        "gdGreenGate","gdGreenFocusClick","gdGreenFocusScreenDistance","gdGreenFocusScreenError","gdManualSurfaceEnd",
	        "gdLocationSetLockedReason","gdLocationSetLockedAt","gdLocationClickConsumed","gdLocationClickConsumedAt"
	      ].forEach(function(key){delete document.body.dataset[key]});
	      document.body.dataset.gdStandingPointClearReason=String(reason||"clear-standing-point");
	      document.body.dataset.gdStandingPointClearAt=String(Date.now());
	    });
	    safe(function(){var ball=byId("gdGreenFocusScreenBall");if(ball)ball.remove()});
	    safe(function(){if(typeof window.gdClearCapturedHoleFrameShotOverlay==="function")window.gdClearCapturedHoleFrameShotOverlay()});
	    safe(function(){var hint=byId("hint");if(hint&&!opts.preserveHint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent=""}});
	    return true;
	  }
	  window.gdClearManualStartRuntime=clearStandingPointRuntime;
  function restoreMappedStartPrompt(reason){
    if(!document.body)return;
    if(homeOpen()||document.body.classList.contains("shell-home"))return;
    document.body.classList.add("gdMappedStartPromptActive");
    safe(function(){if(typeof setState==="function")setState("Mapped: set position")});
    var hint=byId("hint");
    if(hint){
      hint.classList.add("visible","gdMappedStartPill");
      if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(hint);
      else hint.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
    }
    safe(function(){if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame({source:reason||"restore-mapped-start-prompt"})});
    syncGpsFirstPaintGate(reason||"restore-mapped-start-prompt");
  }
  function cancelManualStart(reason){
    clearStandingPointRuntime(reason||"cancel-manual-start",{preserveMappedPrompt:true,preserveHint:true});
    restoreMappedStartPrompt(reason||"cancel-manual-start");
    [120,360].forEach(function(delay){
      setTimeout(function(){
        if(gpsOpen()&&!homeOpen()&&!pickerOpen()&&!document.body.classList.contains("gdManualStartPlacementActive"))restoreMappedStartPrompt(reason||"cancel-manual-start-late");
      },delay);
    });
    setToolOpen(false);
    syncToolRail();
    return false;
  }
  function cleanGpsTransient(reason){
    if(!document.body)return;
    clearStandingPointRuntime(reason||"leave-gps",{clearLockState:true});
    document.body.classList.remove("gdManualStartPlacementActive","gdMappedStartPromptActive","gdMappedCourseMode","gdMappedSnapCameraActive","gdCourseOpening","gdToolRailOpen","gdGreenArrivalMode","gd-green-zoom-active","gdBubbleLongPressZoomActive","gdLockStateFrameActive","gdHeadToTeeFrameActive","gd-frame-hard-locked","gdCapturedBubbleDragging");
    releaseGpsFirstPaintGate(reason||"leave-gps");
    clearCaptured(reason||"leave-gps");
    safe(function(){if(typeof window.gdClearCapturedHoleFrameShotOverlay==="function")window.gdClearCapturedHoleFrameShotOverlay()});
    safe(function(){var appEl=byId("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame")});
    safe(function(){var hit=byId("gdCapturedBubbleDragHit");if(hit)hit.style.display=""});
    safe(function(){var hint=byId("hint");if(hint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent=""}});
    setToolOpen(false);
  }
		  function armManualStart(){
		    if(!gpsOpen()&&!document.body.classList.contains("shell-gps"))return false;
		    manualStartArmedAt=Date.now();
		    manualStartLockToken+=1;
		    window.__gdManualStartLockToken=manualStartLockToken;
		    window.__gdManualStandingPlacementActiveUntil=Date.now()+9000;
	    safe(function(){targetDragging=false});
	    safe(function(){if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(false)});
	    safe(function(){lockedFrame=false});
	    safe(function(){mode="start"});
	    var hadActiveShot=safe(function(){return !!(target||gdCurrentPlannedShotId||(typeof gdPendingCourseShot==="function"&&gdPendingCourseShot()))},false);
	    var greenFocusHint=safe(function(){return typeof greenFocusGreen==="function"?greenFocusGreen():null},null);
	    window.__gdManualStartHadShotToLog=hadActiveShot;
	    safe(function(){if(typeof window.gdClearCapturedHoleFrameShotOverlay==="function")window.gdClearCapturedHoleFrameShotOverlay()});
	    if(!hadActiveShot)safe(function(){
	      if(typeof gdClearTargetArtifactsForFreshStart==="function")gdClearTargetArtifactsForFreshStart();
	      if(greenFocusHint)greenCentre=greenFocusHint;
	    });
    safe(function(){if(typeof setState==="function")setState("Mapped: set position")});
    manualStartVisual(true);
    safe(function(){if(typeof window.gdArmLocationSet==="function")window.gdArmLocationSet("set-start-point");});
    safe(function(){if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame({source:"manual-start-arm"})});
    safe(function(){if(typeof toast==="function")toast("Tap where you are standing")});
    syncToolRail();
    return true;
  }
	  function pointFromEvent(event){
	    return safe(function(){
	      if(document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&typeof window.gdCapturedClientToLatLng==="function"){
	        var captured=typeof window.gdCapturedLatLngFromClientStrict==="function"?window.gdCapturedLatLngFromClientStrict(event.clientX,event.clientY,"standing-tap"):window.gdCapturedClientToLatLng(event.clientX,event.clientY);
	        if(captured){
	          window.__gdLastManualStartSurfaceProbe=typeof window.gdCapturedSurfaceAccuracyProbe==="function"?window.gdCapturedSurfaceAccuracyProbe(event.clientX,event.clientY):{captured:point(captured),live:null,deltaM:null};
	          return captured;
	        }
	        safe(function(){document.body.dataset.gdStandingPointComplete="blocked-captured-point"});
	        return null;
	      }
	      var live=typeof window.gdLiveLatLngFromClient==="function"?window.gdLiveLatLngFromClient(event.clientX,event.clientY):null;
	      if(live)return live;
	      if(typeof gdLatLngFromClientEvent==="function")return gdLatLngFromClientEvent(event);
      var el=map&&map.getContainer?map.getContainer():byId("map");
      var rect=el.getBoundingClientRect();
      return map.containerPointToLatLng(L.point(event.clientX-rect.left,event.clientY-rect.top));
    },null);
  }
  function springManualGreenPoint(){
    return safe(function(){
      if(typeof greenCentre!=="undefined"&&greenCentre)return greenCentre;
      if(typeof pin!=="undefined"&&pin)return pin;
      var payload=typeof gdActiveMappedHolePlayData==="function"?gdActiveMappedHolePlayData():null;
      var data=payload&&payload.data;
      var green=data&&data.green?data.green:{};
      var candidates=[green.position,green.center,green.centre,green.pin];
      for(var i=0;i<candidates.length;i++){
        var ll=typeof gdMappedPointToLatLng==="function"?gdMappedPointToLatLng(candidates[i]):null;
        if(ll)return ll;
      }
      var route=data&&Array.isArray(data.route)?data.route:[];
      if(route.length&&typeof gdMappedPointToLatLng==="function")return gdMappedPointToLatLng(route[route.length-1]);
      return typeof target!=="undefined"?target:null;
    },null);
  }
	  function springManualGreenScreenForEvent(event){
	    try{
	      var green=springManualGreenPoint();
      if(!event||!green||!map){
        safe(function(){document.body.dataset.gdGreenFocusScreenDistance="missing:"+(!event?"event":!green?"green":"map")});
        return null;
      }
      var screen=typeof window.gdCapturedLatLngToClient==="function"?window.gdCapturedLatLngToClient(green):null;
      if(!screen){
        var projected=map.latLngToContainerPoint(green);
        var rect=map.getContainer().getBoundingClientRect();
        screen={x:rect.left+projected.x,y:rect.top+projected.y};
      }
      var distance=Math.hypot(Number(event.clientX)-Number(screen.x),Number(event.clientY)-Number(screen.y));
      var radius=Math.max(56,Math.min(112,(window.innerWidth||360)*.26));
      document.body.dataset.gdGreenFocusScreenDistance=Math.round(distance)+"/"+Math.round(radius);
      return distance<=radius?green:null;
    }catch(error){
      safe(function(){document.body.dataset.gdGreenFocusScreenError=String(error&&error.message||error)});
	      return null;
	    }
	  }
	  function rememberStandingPointAsGps(point, source){
	    if(!point||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lng)))return false;
	    safe(function(){
	      window.gdGpsState=window.gdGpsState||{};
	      window.gdGpsState.permissionKnown=true;
	      window.gdGpsState.permissionGranted=true;
	      window.gdGpsState.lastError=null;
	      window.gdGpsState.lastFix={
	        lat:Number(point.lat),
	        lng:Number(point.lng),
	        accuracy:null,
	        source:source||"tap-where-standing",
	        simulated:true
	      };
	      window.gdGpsState.lastFixAt=Date.now();
	      window.__gdLastStandingPoint={lat:Number(point.lat),lng:Number(point.lng),source:source||"tap-where-standing",at:Date.now()};
	      if(document.body&&document.body.dataset){
	        document.body.dataset.gdStandingPointLat=String(Number(point.lat));
	        document.body.dataset.gdStandingPointLng=String(Number(point.lng));
	        document.body.dataset.gdStandingPointSource=source||"tap-where-standing";
	        document.body.dataset.gdStandingPointAt=String(Date.now());
	      }
	    });
	    safe(function(){gpsOk=true});
	    return true;
	  }
	  function lockAfterManualStart(){
	    var lockHole=currentHole();
	    var lockToken=++manualStartLockToken;
	    window.__gdManualStartLockToken=lockToken;
	    manualStartVisual(false);
	    window.__gdManualStandingPlacementActiveUntil=Date.now()+900;
	    setTimeout(function(){
      if(lockToken!==manualStartLockToken||Number(window.__gdManualStartLockToken)!==lockToken)return;
      if(currentHole()!==lockHole)return;
      if(window.__gdHoleFrameSwitching||document.body.classList.contains("gdGpsHoleTransitioning"))return;
      if(!safe(function(){return !!(start&&target)},false))return;
      safe(function(){mode="aim"});
      safe(function(){if(typeof hideHint==="function")hideHint()});
      var fitted=safe(function(){return typeof window.gdFitLockStateFrameV19==="function"&&window.gdFitLockStateFrameV19({force:true,objectName:"manualStartLockProcedure",reason:"manual-start-lock"})},false);
      if(!fitted)safe(function(){if(typeof lockFrame==="function")lockFrame(true)});
	      safe(function(){if(typeof setBubbleOnlyLock==="function")setBubbleOnlyLock(true)});
	      safe(function(){var tile=byId("shotTile");if(tile)tile.classList.add("visible")});
	      safe(function(){if(typeof renderShot==="function")renderShot()});
	      safe(function(){if(typeof updatePinLine==="function")updatePinLine()});
		      safe(function(){if(typeof window.gdPaintCapturedShotOverlayOwner==="function")window.gdPaintCapturedShotOverlayOwner("manual-start-lock")});
	      safe(function(){var hint=byId("hint");if(hint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent=""}});
	      writeResume("manual-start-lock");
		    },120);
		  }
	  function manualStartPresentationSurfaceEvent(event){
	    return safe(function(){
	      if(!event||!Number.isFinite(Number(event.clientX))||!Number.isFinite(Number(event.clientY)))return false;
	      var target=event.target;
	      var mapEl=map&&map.getContainer?map.getContainer():byId("map");
	      var frameEl=byId("gdHoleImageCameraLayer");
	      var appEl=byId("app");
	      if(target&&target.closest&&target.closest("button,a,input,select,textarea,.leaflet-control,.rightRail,.shellBar,.dock,#gdV62UndoDock,#gdV62ModeSwitch,#shotTile,#gdV62GpsBadge,#hint,#toast,#gdWandPanel,#gdMapperToolFlyout,#gdMapperToolsDrawer,#gdMapperHoleStrip,.panel,.modulePanel,#courseScreen:not(.hidden)"))return false;
	      if(target&&((mapEl&&mapEl.contains(target))||(frameEl&&frameEl.contains(target))))return true;
	      var rectSource=mapEl||frameEl||appEl;
	      if(!rectSource)return false;
	      var rect=rectSource.getBoundingClientRect();
	      if(!rect||rect.width<=0||rect.height<=0)return false;
	      return Number(event.clientX)>=rect.left&&Number(event.clientX)<=rect.right&&Number(event.clientY)>=rect.top&&Number(event.clientY)<=rect.bottom&&(!target||(appEl&&appEl.contains(target))||target===document.body||target===document.documentElement);
	    },false);
	  }
	  function completeStandingPointPlacement(event){
		    if(!document.body||!document.body.classList.contains("gdManualStartPlacementActive")){
	      var standingAt=Number(document.body&&document.body.dataset&&document.body.dataset.gdStandingPointAt||0);
	      if(standingAt&&Date.now()-standingAt<1600)return false;
	      if(standingAt)safe(function(){document.body.dataset.gdStandingPointComplete="blocked-state"});
	      return false;
	    }
	    if(typeof window.gdMapClickConsumed==="function"&&window.gdMapClickConsumed()){
	      safe(function(){document.body.dataset.gdStandingPointComplete="blocked-consumed"});
	      return false;
	    }
	    if(typeof window.gdMaySetLocationFromMapEvent==="function"&&!window.gdMaySetLocationFromMapEvent(event,{source:"manual-start-pointerup"})){
	      safe(function(){document.body.dataset.gdStandingPointComplete="blocked-location-guard"});
	      return false;
		    }
		    safe(function(){document.body.dataset.gdStandingPointComplete="seen:"+(event&&event.type||"event")});
	    if(!manualStartPresentationSurfaceEvent(event)){safe(function(){document.body.dataset.gdStandingPointComplete="blocked-surface"});return false;}
	    var blocked=event.target.closest&&event.target.closest("button,a,input,select,textarea,.rightRail,#gdV62UndoDock,#shotTile,#hint,.panel,.modulePanel,#courseScreen:not(.hidden)");
    if(blocked){safe(function(){document.body.dataset.gdStandingPointComplete="blocked-control"});return false;}
		    var ll=pointFromEvent(event);
			    if(!ll){safe(function(){document.body.dataset.gdStandingPointComplete="blocked-point"});return false;}
				    stop(event);
				    rememberStandingPointAsGps(ll,"tap-where-standing");
				    safe(function(){if(typeof gdSuppressMapPlacementClick==="function")gdSuppressMapPlacementClick(700)});
				    safe(function(){document.body.dataset.gdStandingPointComplete="placing"});
				    window.__gdManualStandingPlacementActiveUntil=Date.now()+2200;
				    var manualGreen=springManualGreenPoint();
				    var manualGreenDistance=safe(function(){return ll&&manualGreen&&map&&map.distance?map.distance(ll,manualGreen):null},null);
				    var manualGreenRadius=safe(function(){return typeof gdGreenFocusRadiusM==="function"?gdGreenFocusRadiusM():46},46);
				    safe(function(){document.body.dataset.gdGreenFocusManualDistance=Number.isFinite(Number(manualGreenDistance))?String(Math.round(Number(manualGreenDistance))):""});
		    safe(function(){lockedFrame=false;mode="start";gdMapPlacementSuppressClickUntil=0});
		    var placed=safe(function(){
	      if(typeof gdCompleteStandingStartPlacement==="function")return gdCompleteStandingStartPlacement(ll,{source:"tap-where-standing",lockSource:"manual-start",hasShotToLog:window.__gdManualStartHadShotToLog===true,event:event});
	      return typeof gdCompleteTwoTapPlacement==="function"&&gdCompleteTwoTapPlacement(ll);
	    },false);
	    if(placed&&document.body&&!document.body.classList.contains("gdGreenArrivalMode"))lockAfterManualStart();
	    if(placed){
	      manualStartArmedAt=0;
	      safe(function(){if(typeof window.gdDisarmLocationSet==="function")window.gdDisarmLocationSet("manual-start-complete");});
	      window.__gdManualStartHadShotToLog=false;
	      window.__gdManualStandingPlacementActiveUntil=0;
	    }
	    return placed;
	  }
  function startButton(event){return event.target&&event.target.closest&&event.target.closest("[data-gd-mapped-start-action='manual']")}
  function currentToolScreen(){return document.body&&document.body.dataset?document.body.dataset.gdToolScreen||"":""}
  function hiddenToolScreen(){var screen=currentToolScreen();return screen==="home"||screen==="module"||screen==="mapping"||document.body.classList.contains("gdCourseOpening")||pickerOpen()||homeOpen()||moduleOpen()}
  function ensureToolTab(){
    var tab=byId("gdToolRailTab");
    if(tab){tab.onclick=function(event){stop(event);return false};return tab;}
    tab=document.createElement("button");
    tab.id="gdToolRailTab";
    tab.type="button";
    tab.title="Tools";
    tab.setAttribute("aria-label","Tools");
    tab.setAttribute("aria-expanded","false");
    tab.innerHTML='<svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><path d="M31 9a8.8 8.8 0 0 0 9 11L22 38a5 5 0 0 1-7-7l18-18a8.8 8.8 0 0 0-2-4Z" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 13l8 8" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/></svg>';
    tab.addEventListener("pointerdown",toggleToolTab,true);
    tab.addEventListener("click",function(event){stop(event)},true);
    tab.addEventListener("keydown",function(event){var key=event.key||event.code;if(key!=="Enter"&&key!==" "&&key!=="Spacebar")return;toggleToolTab(event)},true);
    tab.onclick=function(event){stop(event);return false};
    document.body.appendChild(tab);
    return tab;
  }
	  function setToolOpen(open){
	    if(!document.body)return;
	    document.body.classList.toggle("gdToolRailOpen",!!open);
	    var tab=byId("gdToolRailTab");
	    if(tab)tab.setAttribute("aria-expanded",open?"true":"false");
	  }
	  function clearGreenZoomChrome(){
	    if(!document.body)return;
	    document.body.classList.remove("gd-green-zoom-active","gdBubbleLongPressZoomActive");
	    var btn=byId("gdGreenZoomBtn");
	    if(btn)btn.classList.remove("softActive");
	  }
	  function toggleCapturedGreenZoom(event){
	    if(event)stop(event);
	    var btn=byId("gdGreenZoomBtn");
	    capturedGreenZoomActive=false;
	    clearGreenZoomChrome();
	    safe(function(){
	      if(typeof lockFrameTightness!=="undefined"){
	        lockFrameTightness=lockFrameTightness===0.48?0.62:0.48;
	        var toggle=document.getElementById("frameTightToggle");
	        var sub=document.getElementById("frameTightSub");
	        if(toggle)toggle.textContent=lockFrameTightness===0.48?"Very tight":"Tight";
	        if(sub)sub.textContent=lockFrameTightness===0.48?"Maximum shot focus":"Tight shot focus";
	        if(typeof lockFrame==="function"&&start&&target&&lockedFrame)lockFrame(false);
	        if(typeof applyShotUpAfterPlacement==="function")applyShotUpAfterPlacement();
	      }else if(typeof cycleFrameTightness==="function")cycleFrameTightness();
	    });
	    safe(function(){
	      if(typeof window.gdFitLockStateFrameV19==="function")window.gdFitLockStateFrameV19({force:true,objectName:"frameTightnessButton",reason:"frame-tightness-button"});
	      else if(typeof lockFrame==="function"&&lockedFrame)lockFrame(true);
	    });
	    safe(function(){if(typeof renderShot==="function")renderShot();});
	    var label=safe(function(){return document.getElementById("frameTightToggle")?.textContent||"Frame tightness";},"Frame tightness");
	    if(btn){
	      btn.title=label;
	      btn.setAttribute("aria-label",label);
	    }
	    safe(function(){if(typeof toast==="function")toast(label);});
	    return false;
	  }
	  function bindGreenZoomButton(){
	    var btn=byId("gdGreenZoomBtn");
	    if(!btn)return;
	    btn.onclick=toggleCapturedGreenZoom;
	    if(!btn.__gdCapturedZoomOwnerBound){
	      btn.__gdCapturedZoomOwnerBound=true;
	      btn.addEventListener("click",toggleCapturedGreenZoom,true);
	    }
	  }
	  function queuePostOpeningToolSync(reason){
	    safe(function(){window.__gdToolRailOpeningSyncReason=reason||"opening"});
	    [260,700,1300,2300,3600,5200,7600,10500].forEach(function(delay){
	      setTimeout(function(){syncToolRail()},delay);
	    });
	  }
  function playTileOpen(event){
    stop(event);
    window.__gdCoursePickerReturnTarget="home";
    window.gdCourseChangeMode="";
    return showPicker("home-play-tile");
  }
  function bindHomePlayTile(){
    safe(function(){
      document.querySelectorAll("button.gdPlayTile,.gdPlayTile").forEach(function(tile){
        if(tile.__gdSpringPlayTileBound)return;
        tile.__gdSpringPlayTileBound=true;
        tile.addEventListener("click",playTileOpen,true);
      });
    });
  }
  function forceHomeShell(){
    cleanRouteClasses("home");
    safe(function(){var h=byId("shellHome");if(h){h.classList.remove("hidden");h.style.display="";h.style.visibility="";h.style.opacity=""}});
    safe(function(){var s=byId("courseScreen");if(s){s.classList.add("hidden");s.style.display="none";s.style.visibility="hidden";s.style.opacity="0"}});
  }
  function queueHomeCleanup(reason){
    [40,120,300,700,1300,2200].forEach(function(delay){
      setTimeout(function(){
        if(!document.body||!document.body.classList.contains("shell-home"))return;
        cleanGpsTransient((reason||"home")+"-late");
        forceHomeShell();
        guardSurface();
        syncToolRail();
      },delay);
    });
  }
  function homeGuardTick(){
    if(!document.body||!document.body.classList.contains("shell-home"))return;
    liftShellTop();
    var hint=byId("hint");
    var dirty=document.body.classList.contains("gdMappedStartPromptActive")||
      document.body.classList.contains("gdCapturedHoleFrameCameraOn")||
      document.body.classList.contains("gdHoleImageCameraOn")||
      document.body.classList.contains("gdMappedCourseMode")||
      document.body.classList.contains("gdCourseOpening")||
      !!(hint&&String(hint.textContent||"").trim());
    expose();
    bindHomePlayTile();
    if(!dirty)return;
    cleanGpsTransient("home-guard");
    forceHomeShell();
    bindHomePlayTile();
  }
  function toggleToolTab(event){
    stop(event);
    if(Date.now()-lastTabToggleAt<220)return false;
    lastTabToggleAt=Date.now();
    var open=!document.body.classList.contains("gdToolRailOpen");
    var token=++toolRailOpenToken;
    safe(function(){var rail=byId("gdAppRightRail")||document.querySelector(".rightRail");if(!rail&&typeof window.gdEnsureAppRightRail==="function")rail=window.gdEnsureAppRightRail();if(rail)syncAllowedButtons(rail)});
    setToolOpen(open);
    if(open)[120,360,680,1000].forEach(function(delay){setTimeout(function(){if(token===toolRailOpenToken&&document.body.classList.contains("gdToolRailOpen")&&gpsOpen()&&!hiddenToolScreen()&&!pickerOpen())setToolOpen(true)},delay)});
    else setTimeout(syncToolRail,80);
    return false;
  }
  function roleAllowsTool(id){
    var role=safe(function(){return typeof gdGetAccountPermission==="function"?gdGetAccountPermission():""},"")||
      safe(function(){return document.body&&document.body.dataset&&(document.body.dataset.gdPermission||document.body.dataset.clarityAccountRole||document.body.dataset.accountRole)},"")||
      safe(function(){return window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"&&(window.GolfDaddyAccounts.current()||{}).role},"")||
      safe(function(){return typeof activePlayerProfile==="function"&&(activePlayerProfile()||{}).permission},"")||
      "player";
    role=String(role||"player");
    if(id==="gdMapperToolsBtn")return role==="admin"||role==="coach";
    return true;
  }
  function semanticButtonAllowed(el){
    if(!el||el.id==="gdToolRailTab")return false;
    if(el.disabled||el.getAttribute("aria-disabled")==="true")return false;
    var id=el.id||"";
    if(!roleAllowsTool(id))return false;
    var screen=currentToolScreen();
    if(id==="gdGpsSnapZoomBtn"||id==="gdGreenZoomBtn"||id==="gdGpsSettingsRailBtn")return gpsOpen();
    if(id==="gdV62ModeSwitch")return false;
    var mapped={flagTool:1,windToolBtn:1,gpsRailBtn:1,gdGreenZoomBtn:1,gdGpsSettingsRailBtn:1,scorecardRailBtn:1,bagRailBtn:1};
    var unmapped={flagTool:1,greenToolBtn:1,windToolBtn:1,gpsRailBtn:1,gdMapperToolsBtn:1,gdGreenZoomBtn:1,gdGpsSettingsRailBtn:1,scorecardRailBtn:1,bagRailBtn:1};
    if(screen==="mapped")return !!mapped[id];
    if(screen==="unmapped"||!screen)return !!unmapped[id];
    return false;
  }
  function syncAllowedButtons(rail){
    var buttons=rail?Array.prototype.slice.call(rail.querySelectorAll(".railBtn,#gdV62ModeSwitch")):[];
    var hasTools=false;
    buttons.forEach(function(button){
      var allowed=semanticButtonAllowed(button);
      if(allowed)hasTools=true;
      button.dataset.gdToolTabAllowed=allowed?"1":"0";
    });
    return hasTools;
  }
  function syncToolRail(){
    if(!document.body)return;
    liftShellTop();
    guardSurface();
    restoreGpsSurfaceFromResume("tool-sync");
	    var rail=byId("gdAppRightRail")||document.querySelector(".rightRail");
	    if(!rail&&typeof window.gdEnsureAppRightRail==="function")rail=window.gdEnsureAppRightRail();
		    var tab=ensureToolTab();
	    bindGreenZoomButton();
	    if(rail&&rail.parentElement!==document.body)document.body.appendChild(rail);
    var active=gpsOpen()&&!hiddenToolScreen()&&!pickerOpen()&&!!rail;
    var hasTools=active&&rail?syncAllowedButtons(rail):false;
    document.body.classList.toggle("gdToolRailEmpty",!hasTools);
    if(!active||!hasTools)setToolOpen(false);
    if(tab)tab.hidden=!active||!hasTools;
	    if(gpsOpen()&&document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&typeof window.gdPaintCapturedShotOverlayOwner==="function")window.gdPaintCapturedShotOverlayOwner("tool-sync");
  }
	  function expose(){
	    window.gdReadResumeRound=readResume;
	    window.gdSaveResumeRound=writeResume;
	    window.gdClearResumeRound=clearResume;
		    if(typeof window.gdPaintCapturedShotOverlayOwner!=="function")window.gdPaintCapturedShotOverlayOwner=function(){return false};
	    window.gdEnsureResumeRoundPicker=ensureResumePanel;
	    window.gdResumeRoundFromPicker=resumeRound;
	    window.gdEndRoundFromPicker=endRound;
	    window.gdStartNewRoundFromPicker=endRound;
	    window.gdSpringHomePlayTileOpen=playTileOpen;
	    window.gdGpsBackToCoursePicker=function(reason){return showPicker(reason||"gps-back-to-course-picker")};
	    window.gdGpsPlayRuntimeHome=home;
	    window.gdGpsPlayRuntimeBack=back;
	    window.gdArmManualStartCapturedSurface=armManualStart;
	    if(!canonicalShellNavActive()){
	      window.gdShellBackClick=function(event){return back(event)};
	      window.gdShellBackPointer=function(event){
	        if(document.body&&document.body.classList.contains("gdMappedStartPromptActive")&&!document.body.classList.contains("gdManualStartPlacementActive")){scheduleBackPrelockPickerRestore("shell-back-pointer-prelock");return back(event);}
	        return true;
	      };
	      window.gdCanonicalShellHome=home;
      window.showShellHome=home;
	      window.gdCanonicalShellBack=back;
	      window.shellBack=back;
	    }
	    window.enterGpsModule=enter;
	    window.gdToggleSimpleGreenZoom=toggleCapturedGreenZoom;
	    window.gdCoursePickerHome=pickerHome;
    window.gdCoursePickerBack=pickerBack;
    if(typeof oldOpenCourse==="function")window.gdOpenCoursePickerCourse=openCourseWrapper;
	    safe(function(){if(!canonicalShellNavActive()){showShellHome=home;shellBack=back;}enterGpsModule=enter;gdToggleSimpleGreenZoom=toggleCapturedGreenZoom;gdCoursePickerHome=pickerHome;gdCoursePickerBack=pickerBack;if(typeof oldOpenCourse==="function")gdOpenCoursePickerCourse=openCourseWrapper});
	  }
	  function wire(){
	    liftShellTop();
	    expose();
	    var homeBtn=byId("shellHomeBtn");
	    if(!canonicalShellNavActive()&&homeBtn&&!homeBtn.__gdSpringHomeBound){homeBtn.__gdSpringHomeBound=true;homeBtn.addEventListener("click",home,true)}
	    var backBtn=byId("shellBackBtn");
	    if(!canonicalShellNavActive()&&backBtn&&!backBtn.__gdSpringBackBound){backBtn.__gdSpringBackBound=true;backBtn.addEventListener("click",back,true)}
    ensureResumePanel();
	    bindHomePlayTile();
	    bindGreenZoomButton();
	    syncToolRail();
	    guardSurface();
	  }
	  function earlyShellBack(event){
	    if(canonicalShellNavActive())return;
	    if(!event.target||!event.target.closest||!event.target.closest("#shellBackBtn"))return;
	    if(Date.now()<Number(window.__gdSpringBackHandledUntil||0)){stop(event);return false}
	    lastBackNavAt=Date.now();
	    back(event);
	    return false;
	  }
	  document.addEventListener("mousedown",earlyShellBack,true);
	  document.addEventListener("touchstart",earlyShellBack,true);
	  document.addEventListener("pointerdown",function(event){
	    if(!canonicalShellNavActive()&&event.target&&event.target.closest&&event.target.closest("#shellHomeBtn")){lastHomeNavAt=Date.now();home(event);return false}
	    if(!canonicalShellNavActive()&&event.target&&event.target.closest&&event.target.closest("#shellBackBtn")){lastBackNavAt=Date.now();back(event);return false}
    if(!startButton(event))return;
    stop(event);
    armManualStart();
  },true);
	  function manualPlacementSurfaceEnd(event){
	    safe(function(){document.body.dataset.gdManualSurfaceEnd="seen:"+(event&&event.type||"event")});
	    if(!document.body||!document.body.classList.contains("gdManualStartPlacementActive")){safe(function(){document.body.dataset.gdManualSurfaceEnd="blocked-state"});return;}
	    if(startButton(event)){safe(function(){document.body.dataset.gdManualSurfaceEnd="blocked-start-button"});return;}
	    if(typeof window.gdMapClickConsumed==="function"&&window.gdMapClickConsumed()){safe(function(){document.body.dataset.gdManualSurfaceEnd="blocked-consumed"});return;}
	    if(typeof window.gdMaySetLocationFromMapEvent==="function"&&!window.gdMaySetLocationFromMapEvent(event,{source:"manual-start-window-pointerup"})){safe(function(){document.body.dataset.gdManualSurfaceEnd="blocked-location-guard"});return;}
	    completeStandingPointPlacement(event);
	  }
	  window.addEventListener("pointerup",manualPlacementSurfaceEnd,true);
	  document.addEventListener("click",function(event){
	    if(!canonicalShellNavActive()&&event.target&&event.target.closest&&event.target.closest("#shellHomeBtn")){if(Date.now()-lastHomeNavAt<650){stop(event);return false}lastHomeNavAt=Date.now();home(event);return false}
	    if(!canonicalShellNavActive()&&event.target&&event.target.closest&&event.target.closest("#shellBackBtn")){if(Date.now()-lastBackNavAt<650){stop(event);return false}lastBackNavAt=Date.now();back(event);return false}
	    if(event.target&&event.target.closest&&event.target.closest(".gdPlayTile")){return playTileOpen(event)}
	    if(startButton(event)){stop(event);if(Date.now()-manualStartArmedAt>700)armManualStart();return false}
	    if(event.target&&event.target.closest&&event.target.closest(".rightRail"))return;
    if(event.target&&event.target.closest&&event.target.closest("#gdToolRailTab"))return;
    if(document.body&&document.body.classList.contains("gdToolRailOpen"))setToolOpen(false);
    setTimeout(function(){if(pickerOpen())ensureResumePanel();else if(gpsOpen())writeResume("click");syncToolRail();guardSurface()},80);
  },true);
  window.addEventListener("beforeunload",function(){writeResume("beforeunload")});
  window.addEventListener("popstate",function(){setTimeout(function(){guardSurface();syncToolRail()},40)},true);
  ["resize","orientationchange"].forEach(function(name){window.addEventListener(name,function(){setTimeout(syncToolRail,80)},true)});
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire);
  else wire();
  [120,500,1500,3000].forEach(function(delay){setTimeout(wire,delay)});
  setInterval(homeGuardTick,260);
})();

/* ==== section: gd-gps-play-camera-tilt-v1.js ==== */
/* GPS Play camera tilt: automatic flat whole-hole view, then delayed lock-state tilt. */
(function(){
  if(window.__gdGpsPlayCameraTiltV1)return;
  window.__gdGpsPlayCameraTiltV1=true;

  var AUTO_LOCK_TILT_DEG=32;
  var LOCK_TILT_DELAY_MS=0;
  var FLAT_TILT_DEG=0;
  var STORAGE_KEY="gd_gps_play_camera_tilt_deg_v1";
  var currentDeg=null;
  var syncRaf=0;
  var lockTiltTimer=0;
  var observer=null;

  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function gpsActive(){
    return !!(document.body&&(
      document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active")||
      document.body.dataset.clarityRoute==="gps"
    ));
  }
  function pickerOpen(){
    var screen=safe(function(){return document.getElementById("courseScreen");},null);
    return !!(document.body&&(
      document.body.classList.contains("shell-home")||
      document.body.classList.contains("gdCoursePickerOpen")||
      document.body.classList.contains("gdCourseOpening")||
      (screen&&!screen.classList.contains("hidden"))
    ));
  }
  function capturedSurfaceReady(){
    return !!(document.body&&
      document.body.classList.contains("gdCapturedHoleFrameCameraOn")&&
      document.querySelector("#gdHoleImageCameraLayer .gdHoleImageTiles"));
  }
  function lockedViewReady(){
    if(!gpsActive()||pickerOpen()||!capturedSurfaceReady())return false;
    if(document.body.classList.contains("gdMappedStartPromptActive"))return false;
    if(document.body.classList.contains("gdManualStartPlacementActive"))return false;
    if(document.body.classList.contains("gdGreenArrivalMode"))return false;
    if(document.body.classList.contains("gdLockStateFrameActive"))return true;
    if(document.body.classList.contains("gd-frame-hard-locked"))return true;
    return safe(function(){return !!(lockedFrame&&start&&target);},false);
  }
  function scaleFor(deg){
    deg=Number(deg)||0;
    return (1+Math.max(0,deg)/150).toFixed(3);
  }
  function removeTiltControls(){
    ["gdGpsPlayCameraTiltBtn","gdGpsCameraTiltRow"].forEach(function(id){
      var el=document.getElementById(id);
      if(el&&el.parentNode)el.parentNode.removeChild(el);
    });
  }
  function syncControls(){
    removeTiltControls();
  }
  function clearLockTiltTimer(){
    if(lockTiltTimer){clearTimeout(lockTiltTimer);lockTiltTimer=0;}
  }
  function applyTilt(deg,reason){
    deg=Number(deg)||0;
    deg=deg>0?AUTO_LOCK_TILT_DEG:FLAT_TILT_DEG;
    currentDeg=deg;
    if(document.documentElement){
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-deg",String(deg)+"deg");
      document.documentElement.style.setProperty("--gd-gps-play-camera-tilt-scale",scaleFor(deg));
    }
    if(document.body){
      document.body.classList.add("gdGpsPlayCameraTiltAutoReady");
      document.body.classList.toggle("gdGpsPlayCameraTiltOn",deg>0);
      document.body.classList.toggle("gdGpsPlayCameraTiltFlat",deg<=0);
      document.body.dataset.gdGpsPlayCameraTiltDeg=String(deg);
      document.body.dataset.gdGpsPlayCameraTiltReason=String(reason||"auto");
    }
    syncControls(deg);
    return deg;
  }
  function syncAutoTilt(reason){
    var shouldTilt=lockedViewReady();
    if(!shouldTilt){
      clearLockTiltTimer();
      if(currentDeg!==FLAT_TILT_DEG)applyTilt(FLAT_TILT_DEG,reason||"unlock-flat");
      else {
        if(document.body){
          document.body.classList.add("gdGpsPlayCameraTiltAutoReady","gdGpsPlayCameraTiltFlat");
          document.body.classList.remove("gdGpsPlayCameraTiltOn");
          document.body.dataset.gdGpsPlayCameraTiltDeg=String(FLAT_TILT_DEG);
        }
        syncControls();
      }
      return FLAT_TILT_DEG;
    }
    if(currentDeg===AUTO_LOCK_TILT_DEG)return currentDeg;
    if(lockTiltTimer)return currentDeg==null?FLAT_TILT_DEG:currentDeg;
    if(LOCK_TILT_DELAY_MS<=0){
      clearLockTiltTimer();
      return applyTilt(AUTO_LOCK_TILT_DEG,reason||"lock-same-time");
    }
    lockTiltTimer=setTimeout(function(){
      lockTiltTimer=0;
      if(lockedViewReady())applyTilt(AUTO_LOCK_TILT_DEG,"lock-settled");
      else applyTilt(FLAT_TILT_DEG,"lock-cancelled");
    },LOCK_TILT_DELAY_MS);
    if(currentDeg!==FLAT_TILT_DEG)applyTilt(FLAT_TILT_DEG,reason||"lock-prep-flat");
    syncControls();
    return FLAT_TILT_DEG;
  }
  function scheduleSync(reason){
    if(syncRaf)return;
    syncRaf=requestAnimationFrame(function(){
      syncRaf=0;
      syncAutoTilt(reason||"scheduled");
    });
  }
  function handleControl(event){
    if(event){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    }
    scheduleSync("control-sync");
    return false;
  }
  function ensureObserver(){
    if(observer||!document.body||typeof MutationObserver!=="function")return;
    observer=new MutationObserver(function(){scheduleSync("body-state");});
    observer.observe(document.body,{attributes:true,attributeFilter:["class","data-clarity-route"]});
  }
  function init(){
    safe(function(){localStorage.removeItem(STORAGE_KEY);});
    removeTiltControls();
    ensureObserver();
    applyTilt(FLAT_TILT_DEG,"init-flat");
    scheduleSync("init");
  }

  window.gdCycleGpsPlayCameraTilt=handleControl;
  window.gdSyncGpsPlayCameraTilt=function(reason){return syncAutoTilt(reason||"manual-sync");};
  window.gdSetGpsPlayCameraTilt=function(deg){clearLockTiltTimer();return applyTilt(Number(deg)>0?AUTO_LOCK_TILT_DEG:FLAT_TILT_DEG,"manual-set");};
  window.gdGetGpsPlayCameraTilt=function(){return currentDeg==null?FLAT_TILT_DEG:currentDeg;};
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
  [160,420,900,1600,2600].forEach(function(delay){setTimeout(function(){removeTiltControls();ensureObserver();scheduleSync("settle-"+delay);},delay);});
  ["click","pointerup","transitionend"].forEach(function(type){window.addEventListener(type,function(){scheduleSync(type);},true);});
})();
