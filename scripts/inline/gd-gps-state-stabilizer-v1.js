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
