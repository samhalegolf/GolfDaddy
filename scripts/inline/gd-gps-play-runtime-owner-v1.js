/* Extracted verbatim from an inline <script> block in index.html (split-03). */
(function(){
  "use strict";
  if(window.__gdGpsPlayRuntimeOwnerV1)return;
  window.__gdGpsPlayRuntimeOwnerV1=true;
  window.__gdGpsSpringCleanOwnerV1="renamed-to-gdGpsPlayRuntimeOwnerV1";
  window.gdGpsPlayRuntimeOwner={id:"gdGpsPlayRuntimeOwnerV1",owns:["gps-runtime-cleanup","manual-start-runtime","resume-round-runtime","tool-rail-runtime","captured-shot-overlay-runtime"],shellNavigationOwner:"gdCanonicalRouteAuditV1",cameraOwner:"v19-captured-surface"};
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
	    document.body.classList.remove("shell-home","shell-gps","shell-module","gdGpsActive","gps-active","gps-open","manual-gps-active","gdCoursePickerOpen","gdToolRailOpen");
	    if(route!=="gps")releaseGpsFirstPaintGate(route||"leave-gps");
	    if(route==="home")document.body.classList.add("shell-home");
	    if(route==="gps")document.body.classList.add("shell-gps","gdGpsActive","gps-active");
	    if(route==="module")document.body.classList.add("shell-module");
	    if(document.body.dataset){
	      document.body.dataset.clarityRoute=route==="module"?"module":route==="gps"?"gps":"home";
	      if(route==="home")document.body.dataset.gdToolScreen="home";
	      else if(route==="module")document.body.dataset.gdToolScreen="module";
	      else if(document.body.dataset.gdToolScreen==="home"||document.body.dataset.gdToolScreen==="module"||document.body.dataset.gdToolScreen==="picker")document.body.dataset.gdToolScreen="unmapped";
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
      document.body.classList.remove("gdMappedStartPromptActive","gdManualStartPlacementActive","gdHeadToTeeFrameActive","gdLockStateFrameActive","gd-frame-hard-locked","gdGreenArrivalMode","gd-green-zoom-active","gdBubbleLongPressZoomActive","gdCapturedBubbleDragging");
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
  function pickerHome(event){stop(event);writeResume("course-picker-home");return typeof oldPickerHome==="function"?oldPickerHome.call(this,event):home(event)}
  function pickerBack(event){
    stop(event);
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
    setResumeActivated(true);
    var result=typeof oldOpenCourse==="function"?oldOpenCourse.apply(this,arguments):false;
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
    safe(function(){var rail=byId("gdAppRightRail")||document.querySelector(".rightRail");if(rail)syncAllowedButtons(rail)});
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
    if(id==="gdArcadeRailBtn")return document.body.classList.contains("gdArcadeEntryAllowed")&&document.body.classList.contains("gdArcadeEntryAvailable");
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
