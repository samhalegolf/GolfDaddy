/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  var MODE_KEY="gd_mapped_play_mode_v1";
  var COURSE_MODE_PREFIX="gd_mapped_play_mode_course_v1:";
  var flagDown=null;
  var lastFlagOpenAt=0;
  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function slug(value){
    return String(value||"manual-gps").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"manual-gps";
  }
  function activeCourse(){
    return safe(function(){
      var visible=String(document.getElementById("courseLine")?.textContent||"").trim();
      if(visible&&visible!=="Manual GPS"&&!/^assumed/i.test(visible))return {name:visible,source:"visible-course-label"};
      var bodyName=String(document.body.dataset.gdActiveCourseName||"").trim();
      if(bodyName&&bodyName!=="Manual GPS"&&!/^assumed/i.test(bodyName))return {name:bodyName,source:"body-course-label"};
      var stored=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");
      if(stored&&(stored.name||stored.courseName))return stored;
      if(window.gdActiveCourse&&(window.gdActiveCourse.name||window.gdActiveCourse.courseName))return window.gdActiveCourse;
      if(window.currentCourse&&(window.currentCourse.name||window.currentCourse.courseName))return window.currentCourse;
      return {name:"Manual GPS"};
    },{name:"Manual GPS"});
  }
  function courseIdentity(course){
    course=course||activeCourse();
    return slug(course.courseId||course.id||course.name||course.courseName||"manual-gps");
  }
  function defaultMappedMode(course){
    course=course||activeCourse();
    var name=String(course.name||course.courseName||"");
    if(/^manual gps$/i.test(name))return "unmapped";
    return safe(function(){return window.gdCourseHasMappedGreenFairway&&window.gdCourseHasMappedGreenFairway(course)} ,false)?"mapped":"unmapped";
  }
  function setCourseMode(mode){
    var next=mode==="mapped"?"mapped":"unmapped";
    safe(function(){localStorage.setItem(COURSE_MODE_PREFIX+courseIdentity(activeCourse()),next)});
    syncToolScreen();
    updateCourseMappingSetting();
    safe(function(){if(typeof toast==="function")toast(next==="mapped"?"Mapped course assist on":"Plain two-tap mode")});
    return next;
  }
  function mappedMode(){
    return safe(function(){
      var course=activeCourse();
      var value=localStorage.getItem(COURSE_MODE_PREFIX+courseIdentity(course));
      if(value==="mapped")return true;
      if(value==="unmapped")return false;
      return defaultMappedMode(course)==="mapped";
    },false);
  }
  function canShowCourseMappingSetting(){
    var role=safe(function(){return typeof gdGetAccountPermission==="function"?gdGetAccountPermission():""},"")||
      safe(function(){return document.body&&document.body.dataset&&(document.body.dataset.gdPermission||document.body.dataset.clarityAccountRole||document.body.dataset.accountRole)},"")||
      safe(function(){return window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"&&(window.GolfDaddyAccounts.current()||{}).role},"")||
      "player";
    role=String(role||"player").toLowerCase();
    return role==="admin"||role==="coach";
  }
  function updateCourseMappingSetting(){
    var course=activeCourse();
    var mapped=mappedMode();
    var row=document.getElementById("gdMappedPlayModeRow");
    var canShow=canShowCourseMappingSetting();
    if(row)row.hidden=!canShow;
    if(!canShow)return;
    var btn=document.getElementById("gdMappedPlayModeToggle");
    var sub=document.getElementById("gdMappedPlayModeSub");
    if(btn){
      btn.textContent=mapped?"Mapped":"Unmapped";
      btn.classList.toggle("active",mapped);
      btn.setAttribute("aria-label",mapped?"Mapped course mode":"Unmapped course mode");
      btn.title=mapped?"Mapped course mode":"Unmapped course mode";
      if(!btn.__gdFinalCourseModeBound){
        btn.__gdFinalCourseModeBound=true;
        btn.addEventListener("click",function(event){
          event.preventDefault();
          event.stopPropagation();
          setCourseMode(mappedMode()?"unmapped":"mapped");
        },true);
      }
    }
    if(sub){
      var name=String(course.name||course.courseName||"Manual GPS");
      sub.textContent=mapped?"Use saved mapping for "+name:"Plain two-tap for "+name;
    }
  }
  function gpsActive(){
    return document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active");
  }
	  function mappingActive(){
	    return !!window.gdFullMappingMode||document.body.classList.contains("gdFullMappingMode");
	  }
	  function toolScreen(){
	    if(!gpsActive())return document.body.classList.contains("shell-module")?"module":"home";
	    if(mappingActive())return "mapping";
	    return mappedMode()?"mapped":"unmapped";
	  }
  function resetLegacyFlagState(flag){
    safe(function(){placingPin=false});
    safe(function(){draggingFlag=false});
    safe(function(){flagPointerStart=null});
    safe(function(){document.getElementById("ghost").style.display="none"});
    safe(function(){flag.classList.remove("softActive","grabbing")});
    safe(function(){document.getElementById("gdPinToolFlyout")?.classList.add("hidden")});
  }
  function closeMappedWand(screen){
    if(screen!=="mapped")return;
    safe(function(){greenActive=false});
    safe(function(){document.getElementById("gdWandPanel")?.classList.add("hidden")});
    safe(function(){if(typeof clearWandHandles==="function")clearWandHandles()});
    safe(function(){if(typeof window.gdClearWandLive==="function")window.gdClearWandLive()});
  }
  function syncToolScreen(){
    var screen=toolScreen();
    var pickerOpen=safe(function(){
      var courseScreen=document.getElementById("courseScreen");
      if(!courseScreen||courseScreen.classList.contains("hidden"))return false;
      var cs=getComputedStyle(courseScreen);
      return cs.display!=="none"&&cs.visibility!=="hidden";
    },false);
    if(pickerOpen)screen="picker";
    document.body.dataset.gdToolScreen=screen;
    document.body.dataset.gdToolCourse=courseIdentity(activeCourse());
    document.body.classList.toggle("gdMappedCourseMode",screen==="mapped");
    updateCourseMappingSetting();
    closeMappedWand(screen);
    var flag=document.getElementById("flagTool");
    if(flag){
      flag.onclick=openFlagPlacement;
      flag.setAttribute("aria-label","Pin-Lock");
      flag.title="Pin-Lock";
    }
    var pinTool=document.getElementById("gdPinToolFlyout");
    if(pinTool)pinTool.classList.add("hidden");
    return screen;
  }
  function blockFlagEvent(event){
    var flag=event.target&&event.target.closest&&event.target.closest("#flagTool");
    if(!flag)return null;
    event.preventDefault();
    event.stopPropagation();
    if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    return flag;
  }
  function openFlagPlacement(event){
    var flag=event&&event.target&&event.target.closest?event.target.closest("#flagTool"):document.getElementById("flagTool");
    if(event){
      event.preventDefault();
      event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
    }
    syncToolScreen();
    resetLegacyFlagState(flag||document.getElementById("flagTool"));
    if(Date.now()-lastFlagOpenAt<180)return false;
    lastFlagOpenAt=Date.now();
    if(typeof gdHasPlacedPin==="function"&&gdHasPlacedPin()){
      gdClearPinAndOpenPinLock("Pin cleared");
      return false;
    }
    if(typeof window.gdOpenPinLockSheet==="function")window.gdOpenPinLockSheet();
    else if(typeof window.gdTogglePinToolFlyout==="function")window.gdTogglePinToolFlyout(event||null);
    return false;
  }
  document.addEventListener("pointerdown",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    syncToolScreen();
    resetLegacyFlagState(flag);
    flagDown={x:event.clientX||0,y:event.clientY||0,time:Date.now()};
  },true);
  document.addEventListener("pointermove",function(event){
    if(!flagDown)return;
    var flag=event.target&&event.target.closest&&event.target.closest("#flagTool");
    if(!flag)return;
    blockFlagEvent(event);
    resetLegacyFlagState(flag);
  },true);
  document.addEventListener("pointerup",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    var start=flagDown;
    flagDown=null;
    resetLegacyFlagState(flag);
    var moved=start?Math.hypot((event.clientX||0)-start.x,(event.clientY||0)-start.y):0;
    if(moved<=12)openFlagPlacement(event);
  },true);
  document.addEventListener("pointercancel",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    flagDown=null;
    resetLegacyFlagState(flag);
  },true);
  document.addEventListener("click",function(event){
    var flag=blockFlagEvent(event);
    if(!flag)return;
    openFlagPlacement(event);
  },true);
	  window.gdOpenFlagPlacement=openFlagPlacement;
	  window.startPinPlacement=openFlagPlacement;
	  window.gdActiveCourseForMode=activeCourse;
	  window.gdCourseModeIdentity=courseIdentity;
	  window.gdSetCourseMappedMode=setCourseMode;
	  window.gdMappedMode=mappedMode;
	  window.gdSyncToolScreen=syncToolScreen;
	  safe(function(){startPinPlacement=openFlagPlacement});
  syncToolScreen();
  setTimeout(syncToolScreen,80);
  setTimeout(syncToolScreen,350);
  setTimeout(syncToolScreen,1200);
  setInterval(syncToolScreen,700);
})();
