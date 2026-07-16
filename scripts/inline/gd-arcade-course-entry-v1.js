/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  var ON_COURSE_RADIUS_M=900;
  var ARCADE_OWNER_EMAILS={"samhalegolf@gmail.com":true};
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function byId(id){return document.getElementById(id)}
  function slug(value){return String(value||"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||""}
  function currentAccountEmail(){
    return String(safe(function(){
      var account=window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"?window.GolfDaddyAccounts.current():null;
      if(account&&account.email)return account.email;
      var session=window.ClaritySession&&typeof window.ClaritySession.get==="function"?window.ClaritySession.get():null;
      return session&&session.accountEmail||"";
    },"")).trim().toLowerCase();
  }
  function arcadeAllowed(){
    return !!ARCADE_OWNER_EMAILS[currentAccountEmail()];
  }
  window.gdArcadeModeAllowed=arcadeAllowed;
  function gpsActive(){
    return document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active");
  }
  function coursePickerOpen(){
    var screen=byId("courseScreen");
    if(!screen||screen.classList.contains("hidden"))return false;
    var cs=safe(function(){return getComputedStyle(screen)},null);
    return !cs||cs.display!=="none"&&cs.visibility!=="hidden";
  }
  function activeCourse(){
    return safe(function(){
      var stored=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");
      if(typeof window.gdActiveCourseForMode==="function"){
        var modeCourse=window.gdActiveCourseForMode();
        if(modeCourse&&(modeCourse.name||modeCourse.courseName||modeCourse.courseId||modeCourse.id)){
          var modeName=slug(modeCourse.name||modeCourse.courseName||modeCourse.courseId||modeCourse.id);
          var storedName=slug(stored?.name||stored?.courseName||stored?.courseId||stored?.id);
          return stored&&modeName&&storedName&&modeName===storedName?Object.assign({},stored,modeCourse):modeCourse;
        }
      }
      if(stored&&(stored.name||stored.courseName||stored.courseId||stored.id))return stored;
      if(window.gdActiveCourse&&(window.gdActiveCourse.name||window.gdActiveCourse.courseName))return window.gdActiveCourse;
      if(window.currentCourse&&(window.currentCourse.name||window.currentCourse.courseName))return window.currentCourse;
      var label=String(byId("courseLine")?.textContent||"").trim();
      if(label)return {name:label,courseName:label};
      return null;
    },null);
  }
  function courseName(course){return String(course?.name||course?.courseName||"").trim()}
  function realCourse(course){
    var name=courseName(course);
    if(!name||/^manual gps$/i.test(name)||/^assumed/i.test(name))return false;
    return !!slug(course?.courseId||course?.id||name);
  }
  function activeHole(){
    return safe(function(){
      var h=Number(window.currentPlayingHole||window.selectedHole||sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole")||1);
      return Number.isFinite(h)&&h>0?Math.round(h):1;
    },1);
  }
  function mappedForArcade(course,hole){
    if(document.body.dataset.gdToolScreen!=="mapped")return false;
    if(typeof window.gdCourseHasMappedGreenFairway==="function"){
      return !!safe(function(){return window.gdCourseHasMappedGreenFairway(course,hole)},false);
    }
    return document.body.classList.contains("gdMappedCourseMode");
  }
  function pointFromCourse(course){
    var lat=Number(course?.lat??course?.courseLat??course?.finderLat??course?.courseFinderLat??course?.latitude);
    var lng=Number(course?.lng??course?.courseLng??course?.finderLng??course?.courseFinderLng??course?.longitude);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat:lat,lng:lng}:null;
  }
  function currentStartPoint(){
    return safe(function(){
      if(typeof start!=="undefined"&&start&&Number.isFinite(Number(start.lat))&&Number.isFinite(Number(start.lng)))return {lat:Number(start.lat),lng:Number(start.lng)};
      return null;
    },null);
  }
  function distanceM(a,b){
    if(!a||!b)return Infinity;
    return safe(function(){
      if(typeof map!=="undefined"&&map&&typeof map.distance==="function")return map.distance(a,b);
      var toRad=function(n){return Number(n)*Math.PI/180};
      var R=6371000,dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng);
      var s=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;
      return 2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
    },Infinity);
  }
  function liveModeOnCourse(course){
    var mode=safe(function(){return typeof gdGpsPlayMode==="function"?gdGpsPlayMode():localStorage.getItem("gdGpsPlayMode")},"twoTap");
    if(mode!=="live")return false;
    var here=currentStartPoint();
    var coursePoint=pointFromCourse(course);
    return !!(here&&coursePoint&&distanceM(here,coursePoint)<=ON_COURSE_RADIUS_M);
  }
  function entryContext(){
    var course=activeCourse();
    var hole=activeHole();
    return {
      available:shouldShow(),
      course:course,
      courseName:courseName(course),
      courseId:course?.courseId||course?.id||slug(courseName(course)),
      hole:hole,
      source:"course-view-arcade-entry"
    };
  }
  function shouldShow(){
    if(!arcadeAllowed())return false;
    if(!gpsActive()||coursePickerOpen())return false;
    if(document.body.dataset.gdToolScreen!=="mapped")return false;
    if(window.gdFullMappingMode||document.body.classList.contains("gdFullMappingMode"))return false;
    if(safe(function(){return typeof gdTournamentModeEnabled==="function"&&gdTournamentModeEnabled()},false))return false;
    var course=activeCourse();
    if(!realCourse(course))return false;
    if(!mappedForArcade(course,activeHole()))return false;
    return !liveModeOnCourse(course);
  }
  function sync(){
    var btn=byId("gdArcadeRailBtn");
    var allowed=arcadeAllowed();
    var active=arcadeActive();
    if(!allowed&&active&&typeof window.gdExitArcadeMode==="function")window.gdExitArcadeMode(false);
    var show=allowed&&(active||shouldShow());
    document.body.classList.toggle("gdArcadeEntryAllowed",allowed);
    document.body.classList.toggle("gdArcadeEntryAvailable",show);
    document.body.dataset.gdArcadeEntry=show?"available":"";
    if(btn){
      btn.setAttribute("aria-hidden",show?"false":"true");
      btn.setAttribute("aria-disabled",show?"false":"true");
      btn.title=active?"Exit Arcade Mode":(show?"Arcade Mode":"Arcade Mode needs a mapped course view");
    }
    return show;
  }
  function arcadeActive(){
    if(document.body.classList.contains("gdArcadeMode"))return true;
    return !!safe(function(){
      return typeof window.gdArcadeModeState==="function"&&window.gdArcadeModeState().active;
    },false);
  }
  function open(event){
    if(event){
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
    }
    if(!arcadeAllowed()){
      safe(function(){if(typeof toast==="function")toast("Arcade Mode is private")});
      return false;
    }
    if(arcadeActive()){
      if(typeof window.gdExitArcadeMode==="function")return window.gdExitArcadeMode();
      document.body.classList.remove("gdArcadeMode","gdArcadeRouteLocked","gdArcadePlaying","gdArcadeDragging");
      delete document.body.dataset.gdArcadeMode;
      sync();
      return false;
    }
    sync();
    var ctx=entryContext();
    if(!ctx.available){
      safe(function(){if(typeof toast==="function")toast("Arcade appears on mapped course views away from the course")});
      return false;
    }
    if(typeof window.gdLaunchArcadeMode==="function")return window.gdLaunchArcadeMode(ctx);
    document.dispatchEvent(new CustomEvent("clarity-arcade-entry",{detail:ctx}));
    safe(function(){if(typeof toast==="function")toast("Arcade entry ready")});
    return false;
  }
  window.gdArcadeEntryContext=entryContext;
  window.gdSyncArcadeEntry=sync;
  window.gdOpenArcadeEntry=open;
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",function(){setTimeout(sync,80)});
  else sync();
  document.addEventListener("click",function(){setTimeout(sync,80)},true);
  setTimeout(sync,220);
  setTimeout(sync,900);
  setInterval(sync,900);
})();
