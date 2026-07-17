/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy patch: location permission/fix state is based on last successful GPS fix --- */
(function(){
  const CACHE_MAX_MS = 90000;
  const REQUEST_TIMEOUT_MS = 18000;

  window.gdGpsState = window.gdGpsState || {
    permissionKnown:false,
    permissionGranted:false,
    lastFix:null,
    lastFixAt:0,
    lastError:null,
    activeRequest:false
  };

  function now(){ return Date.now(); }
  function safeToast(msg){ try{ if(typeof toast==='function') toast(msg); }catch(e){} }
  function setGpsLabelSafe(ok,label){
    try{ if(typeof setGps==='function') setGps(ok,label); }catch(e){}
    try{ if(typeof setGpsLabel==='function') setGpsLabel(ok,label); }catch(e){}
  }
  function setStateSafe(label){
    try{ if(typeof setState==='function') setState(label); }catch(e){}
    try{ if(typeof setStateLabel==='function') setStateLabel(label); }catch(e){}
  }
  function hintSafe(msg){ try{ if(typeof hint==='function') hint(msg); else if(typeof showHint==='function') showHint(msg); }catch(e){} }
  function hideHintSafe2(){ try{ if(typeof hideHintSafe==='function') hideHintSafe(); else if(typeof hideHint==='function') hideHint(); }catch(e){} }
  function isLocked(){ try{return !!lockedFrame}catch(e){return false} }
  function curStart(){ try{return typeof start!=='undefined'&&start?start:null}catch(e){return null} }
  function curTarget(){ try{return typeof target!=='undefined'&&target?target:null}catch(e){return null} }
  function asLatLng(posOrFix){
    if(!posOrFix) return null;
    if(posOrFix.lat!=null && posOrFix.lng!=null) return L.latLng(posOrFix.lat,posOrFix.lng);
    if(posOrFix.coords) return L.latLng(posOrFix.coords.latitude,posOrFix.coords.longitude);
    return null;
  }
  function rememberFix(pos, source){
    const ll = asLatLng(pos);
    if(!ll) return null;
    window.gdGpsState.permissionKnown = true;
    window.gdGpsState.permissionGranted = true;
    window.gdGpsState.lastError = null;
    window.gdGpsState.lastFix = {
      lat: ll.lat,
      lng: ll.lng,
      accuracy: pos && pos.coords ? pos.coords.accuracy : undefined,
      source: source || 'gps'
    };
    window.gdGpsState.lastFixAt = now();
    try{ gpsOk = true; }catch(e){}
    return ll;
  }
  function cacheFresh(){
    return !!(window.gdGpsState.lastFix && (now()-window.gdGpsState.lastFixAt) < CACHE_MAX_MS);
  }
	  function jumpCameraTo(ll){
	    return false;
	  }
	  function applyFix(ll, opts){
	    opts = opts || {};
	    if(!ll) return false;
	    setGpsLabelSafe(true, opts.label || 'GPS');
	    try{ gpsOk=true; }catch(e){}
	    try{ if(typeof window.gdRememberLiveGpsOnly==='function')window.gdRememberLiveGpsOnly(ll,opts.accuracy,opts.cache?'gps-cache':'gps-live'); }catch(e){}

	    if(isLocked()){
	      try{ if(typeof updateGpsInsideLockedFrame==='function' && curStart()) updateGpsInsideLockedFrame(ll, opts.label || 'GPS live'); }catch(e){}
	      setStateSafe('Live locked');
	      hideHintSafe2();
	      if(opts.toast) safeToast('GPS refreshed');
	      return true;
	    }

	    setStateSafe(opts.cache ? 'GPS cached' : 'GPS live');
	    hideHintSafe2();
	    if(opts.toast) safeToast(opts.cache ? 'GPS refreshed from recent fix' : 'GPS located');
	    return true;
	  }

  // Intercept every successful geolocation result, including old app code, so the whole app agrees permission is working.
  try{
    if(navigator.geolocation && !navigator.geolocation.__gdFixCachePatched){
      const geo = navigator.geolocation;
      const rawGet = geo.getCurrentPosition.bind(geo);
      const rawWatch = geo.watchPosition.bind(geo);
      geo.getCurrentPosition = function(success, error, options){
        return rawGet(function(pos){ rememberFix(pos,'getCurrentPosition'); if(typeof success==='function') success(pos); }, function(err){ window.gdGpsState.lastError = err || null; if(typeof error==='function') error(err); }, options);
      };
      geo.watchPosition = function(success, error, options){
        return rawWatch(function(pos){ rememberFix(pos,'watchPosition'); if(typeof success==='function') success(pos); }, function(err){ window.gdGpsState.lastError = err || null; if(typeof error==='function') error(err); }, options);
      };
      geo.__gdFixCachePatched = true;
    }
  }catch(e){}

  function requestGpsRobust(opts){
    opts = opts || {};
    if(!navigator.geolocation){ setGpsLabelSafe(false,'GPS unavailable'); safeToast('GPS unavailable'); return; }

    // If the dot has already moved, permission is effectively working. Use that immediately while asking for a fresher fix.
    if(cacheFresh() && opts.allowCacheFirst !== false){
      applyFix(asLatLng(window.gdGpsState.lastFix), Object.assign({}, opts, {cache:true, toast:opts.toast}));
    }

    if(window.gdGpsState.activeRequest) return;
    window.gdGpsState.activeRequest = true;
    setGpsLabelSafe(true,'GPS…');

    navigator.geolocation.getCurrentPosition(function(pos){
      window.gdGpsState.activeRequest = false;
      const ll = rememberFix(pos,'gpsButton');
      applyFix(ll, Object.assign({}, opts, {cache:false}));
      try{ if(typeof startWatch==='function') startWatch(); }catch(e){}
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    }, function(err){
      window.gdGpsState.activeRequest = false;
      window.gdGpsState.lastError = err || null;
      // Do not call this denied if a successful fix exists. This handles timeout/slow GPS after permission was granted.
      if(cacheFresh()){
        setGpsLabelSafe(true,'GPS cached');
        applyFix(asLatLng(window.gdGpsState.lastFix), Object.assign({}, opts, {cache:true, toast:true}));
        try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
        return;
      }
      const code = err && err.code;
      const msg = code === 1 ? 'GPS permission needed' : (code === 3 ? 'GPS timeout · try again outside' : 'GPS weak');
      setGpsLabelSafe(false, code === 1 ? 'GPS denied' : 'GPS weak');
      setStateSafe(msg);
      if(code === 1) hideHintSafe2();
      else hintSafe('GPS is searching. Try again near the tee.');
      safeToast(err && err.message ? err.message : msg);
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    }, {enableHighAccuracy:true, maximumAge:15000, timeout:REQUEST_TIMEOUT_MS});
  }

  window.gdGpsRememberFix = rememberFix;
  window.gdGpsApplyFix = applyFix;
  window.gdGpsLocateNow = function(){ requestGpsRobust({jump:true, toast:true, label:'GPS locate'}); };
  window.refreshGPS = function(){ requestGpsRobust({jump:true, toast:true, label:'GPS refreshed'}); };

  function patchButton(){
    const btn = document.getElementById('gpsRailBtn');
    if(btn && !btn.__gdRobustGpsClick){
      btn.__gdRobustGpsClick = true;
      btn.onclick = function(ev){ ev.preventDefault(); ev.stopPropagation(); window.gdGpsLocateNow(); };
    }
  }
  patchButton();
  document.addEventListener('DOMContentLoaded',()=>setTimeout(patchButton,80));
  setTimeout(patchButton,300);
  setTimeout(patchButton,1000);
})();
