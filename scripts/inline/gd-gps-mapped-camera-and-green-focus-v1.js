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
