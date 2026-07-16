/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  var KEY="gd_tournament_mode_v1";
  var PREV_MODES_KEY="gd_tournament_prev_course_modes_v1";
  var COURSE_MODE_PREFIX="gd_mapped_play_mode_course_v1:";
  var LEGACY_MODE_KEY="gd_mapped_play_mode_v1";
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function slug(value){return String(value||"manual-gps").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"manual-gps"}
  function enabled(){return safe(function(){return localStorage.getItem(KEY)==="on"},false)}
	  function activeCourse(){
	    return safe(function(){
	      if(typeof window.gdActiveCourseForMode==="function")return window.gdActiveCourseForMode();
	      var stored=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");
	      if(stored&&(stored.courseId||stored.id||stored.name||stored.courseName))return stored;
      if(window.gdActiveCourse)return window.gdActiveCourse;
      if(typeof currentCourse!=="undefined"&&currentCourse)return currentCourse;
      if(window.currentCourse)return window.currentCourse;
      return null;
    },null);
	  }
	  function courseModeKeys(){
	    var keys=[LEGACY_MODE_KEY,COURSE_MODE_PREFIX+"windross-farm",COURSE_MODE_PREFIX+"windross-farm-golf-course"];
	    var course=activeCourse();
	    if(course){
	      var canonical=safe(function(){
	        return typeof window.gdCourseModeIdentity==="function"?window.gdCourseModeIdentity(course):"";
	      },"");
	      [canonical,course.courseId,course.id,course.name,course.courseName].forEach(function(value){
	        if(value)keys.push(COURSE_MODE_PREFIX+slug(value));
	      });
	    }
	    return Array.from(new Set(keys.filter(Boolean)));
	  }
  function readPrevModes(){return safe(function(){return JSON.parse(localStorage.getItem(PREV_MODES_KEY)||"{}")||{}},{})}
  function forceCourseMappingOff(){
    var previous=readPrevModes();
    courseModeKeys().forEach(function(key){
      if(!(key in previous))previous[key]=localStorage.getItem(key);
      localStorage.setItem(key,"unmapped");
    });
    localStorage.setItem(PREV_MODES_KEY,JSON.stringify(previous));
  }
  function restoreCourseMapping(){
    var previous=readPrevModes();
    Object.keys(previous).forEach(function(key){
      if(previous[key]===null||previous[key]===undefined)localStorage.removeItem(key);
      else localStorage.setItem(key,previous[key]);
    });
    localStorage.removeItem(PREV_MODES_KEY);
  }
  function disableIllegalState(){
    safe(function(){
      if(typeof greenCentre!=="undefined"&&greenCentre)target=greenCentre;
      else if(typeof gdWindLandingTarget!=="undefined"&&gdWindLandingTarget)target=gdWindLandingTarget;
    });
    safe(function(){gdWindActive=false});
    safe(function(){gdWindOriginAngle=null});
    safe(function(){gdWindLandingTarget=null});
    safe(function(){if(typeof gdClearWindVisuals==="function")gdClearWindVisuals()});
    safe(function(){document.getElementById("gdWindPicker")?.classList.add("hidden")});
    safe(function(){document.getElementById("gdWandPanel")?.classList.add("hidden")});
    safe(function(){greenActive=false});
    safe(function(){if(typeof clearWandHandles==="function")clearWandHandles()});
    safe(function(){if(typeof window.gdClearWandLive==="function")window.gdClearWandLive()});
    safe(function(){if(typeof gdSyncWindButton==="function")gdSyncWindButton()});
  }
  function syncUi(){
    var on=enabled();
    document.body.classList.toggle("gdTournamentMode",on);
    var btn=document.getElementById("gdTournamentModeToggle");
    var sub=document.getElementById("gdTournamentModeSub");
    if(btn){
      btn.textContent=on?"On":"Off";
      btn.classList.toggle("active",on);
      btn.setAttribute("aria-pressed",on?"true":"false");
      btn.title=on?"Tournament mode on: distance only":"Tournament mode off";
    }
    if(sub)sub.textContent=on?"Distance only - no wind, slope, club pick, bubble or advice":"Distance only - no advice";
    var mapped=document.getElementById("gdMappedPlayModeToggle");
    if(mapped){
      mapped.disabled=on;
      mapped.title=on?"Course mapping is off in tournament mode":mapped.title||"Course mapping";
    }
  }
  function setMode(on,opts){
    opts=opts||{};
    localStorage.setItem(KEY,on?"on":"off");
    if(on){
      disableIllegalState();
      forceCourseMappingOff();
      safe(function(){if(typeof gdDiscardCurrentPlannedShot==="function")gdDiscardCurrentPlannedShot()});
    }else{
      restoreCourseMapping();
    }
	    syncUi();
	    safe(function(){if(typeof window.gdSyncToolScreen==="function")window.gdSyncToolScreen()});
	    safe(function(){if(typeof renderShot==="function")renderShot()});
    safe(function(){if(typeof window.gdSyncPlayFlowRail==="function")window.gdSyncPlayFlowRail()});
    if(!opts.silent)safe(function(){if(typeof toast==="function")toast(on?"Tournament mode: distance only":"Tournament mode off")});
    return on;
  }
  function toggle(){return setMode(!enabled())}
  function edgeText(){
    var metrics=safe(function(){return typeof gdGreenEdgeDistanceMetrics==="function"?gdGreenEdgeDistanceMetrics(greenPolygon):null},null);
    if(!metrics)return "";
    return "Front "+metrics.front.value+metrics.front.unit+"  Back "+metrics.back.value+metrics.back.unit;
  }
  function pinText(){
    if(!start||!pin||!map)return "";
    var p=fmt(map.distance(start,pin));
    return "Pin "+p.value+p.unit;
  }
  function clearSlope(tileMain){
    if(!tileMain)return;
    tileMain.querySelectorAll(".gdSlopeAdjustedLine").forEach(function(el){el.remove()});
    tileMain.classList.remove("hasSlope","slopeUnder","slopeOver","slopeLevel");
  }
  function renderTournamentShot(){
    disableIllegalState();
    safe(function(){if(typeof clearShot==="function")clearShot()});
    if(!start)return;
    var centre=greenCentre||target;
    if(!centre)return;
    var tile=document.getElementById("shotTile");
    if(tile)tile.classList.add("visible");
    var label=tile?tile.querySelector(".tileLabel"):null;
    var club=tile?tile.querySelector(".tileClub"):null;
    var tileMain=tile?tile.querySelector(".tileMain"):null;
    var dist=document.getElementById("tileDist");
    var sub=document.getElementById("tileSub");
    var meta=document.getElementById("tileMeta");
    var pinDiff=document.getElementById("pinDiff");
    var centreDistance=fmt(map.distance(start,centre));
    if(tile)tile.classList.remove("noBag");
    if(label)label.textContent="";
    if(club)club.textContent="GPS";
    if(dist)dist.innerHTML=centreDistance.value+"<span>"+centreDistance.unit+"</span>";
    clearSlope(tileMain);
    if(sub)sub.textContent=edgeText()||"Centre raw distance";
    if(meta)meta.textContent=pinText()||"Distance only - no wind, slope or club advice";
    if(pinDiff){
      var text=pinText();
      pinDiff.style.display=text?"block":"none";
      pinDiff.textContent=text;
    }
    safe(function(){if(targetMarker&&centre)targetMarker.setLatLng(centre)});
    safe(function(){if(typeof setState==="function")setState("Tournament - distance only")});
  }
  function blockIllegalClick(event){
    if(!enabled())return;
    var hit=event.target&&event.target.closest&&event.target.closest("#windToolBtn,#greenToolBtn,#gdMapperToolsBtn,#bagRailBtn,#gdMappedPlayModeToggle");
    if(!hit)return;
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    safe(function(){if(typeof toast==="function")toast("Tournament mode: distance only")});
    syncUi();
    return false;
  }
  var oldOpenSettings=window.openSettings;
  if(typeof oldOpenSettings==="function"&&!oldOpenSettings.__gdTournamentWrapped){
    var wrappedOpenSettings=function(){
      var result=oldOpenSettings.apply(this,arguments);
      setTimeout(syncUi,0);
      return result;
    };
    wrappedOpenSettings.__gdTournamentWrapped=true;
    window.openSettings=wrappedOpenSettings;
    safe(function(){openSettings=wrappedOpenSettings});
  }
  ["openStats","gdOpenDataHub","openCourseData"].forEach(function(name){
    var old=window[name];
    if(typeof old!=="function"||old.__gdTournamentWrapped)return;
    var wrapped=function(){
      if(enabled()){
        safe(function(){if(typeof toast==="function")toast("Tournament mode: shot data is off")});
        return false;
      }
      return old.apply(this,arguments);
    };
    wrapped.__gdTournamentWrapped=true;
    window[name]=wrapped;
    safe(function(){if(name==="openStats")openStats=wrapped});
  });
	  window.gdTournamentModeEnabled=enabled;
	  window.gdSetTournamentMode=setMode;
	  window.gdToggleTournamentMode=toggle;
	  window.gdRenderTournamentShot=renderTournamentShot;
	  function installCourseDataFilterTab(){
	    var filters=document.querySelector("#statsPanel .gdStatsFilters");
	    if(!filters||filters.closest(".gdStatsFilterDetails"))return;
	    var details=document.createElement("details");
	    details.className="gdStatsFilterDetails";
	    var summary=document.createElement("summary");
	    summary.textContent="Filters";
	    filters.parentNode.insertBefore(details,filters);
	    details.append(summary,filters);
	  }
	  window.gdInstallCourseDataFilterTab=installCourseDataFilterTab;
	  document.addEventListener("click",blockIllegalClick,true);
	  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){installCourseDataFilterTab();syncUi();if(enabled())setMode(true,{silent:true})});
	  else{installCourseDataFilterTab();syncUi();if(enabled())setMode(true,{silent:true})}
	  setTimeout(syncUi,400);
	  setTimeout(installCourseDataFilterTab,500);
	  setTimeout(function(){if(enabled())setMode(true,{silent:true})},1400);
})();
 
