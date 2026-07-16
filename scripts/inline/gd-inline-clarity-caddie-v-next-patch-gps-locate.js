/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddie vNext patch: GPS locate button recenters when unlocked, stays live-only when locked --- */
(function(){
  function safeToast(msg){ try{ if(typeof toast==='function') toast(msg); }catch(e){} }
  function setGpsLabelSafe(ok,label){ try{ if(typeof setGps==='function') setGps(ok,label); }catch(e){}; try{ if(typeof setGpsLabel==='function') setGpsLabel(ok,label); }catch(e){} }
  function setStateSafe(label){ try{ if(typeof setState==='function') setState(label); }catch(e){}; try{ if(typeof setStateLabel==='function') setStateLabel(label); }catch(e){} }
  function hideHint(){ try{ if(typeof hideHintSafe==='function') hideHintSafe(); else if(typeof hideHint==='function') hideHint(); }catch(e){} }
  function showHintSafe(msg){ try{ if(typeof hint==='function') hint(msg); else if(typeof showHint==='function') showHint(msg); }catch(e){} }
  function curStart(){ try{return typeof start!=='undefined'&&start?start:null}catch(e){return null} }
  function curTarget(){ try{return typeof target!=='undefined'&&target?target:null}catch(e){return null} }
  function isLocked(){ try{return !!lockedFrame}catch(e){return false} }
  function currentZoom(){ try{return (map&&map.getZoom)?map.getZoom():18}catch(e){return 18} }
	  function jumpCameraTo(here){
	    return false;
	  }
	  function applyLiveGpsPosition(here, opts){
	    opts=opts||{};
	    setGpsLabelSafe(true,'GPS');
	    try{ gpsOk=true; }catch(e){}
	    try{ if(typeof window.gdRememberLiveGpsOnly==='function')window.gdRememberLiveGpsOnly(here,opts.accuracy,opts.source||'gps-live'); }catch(e){}

	    if(isLocked()){
	      try{ if(typeof updateGpsInsideLockedFrame==='function'&&curStart()) updateGpsInsideLockedFrame(here, opts.label||'GPS live'); }catch(e){}
	      setStateSafe('Live locked');
	      hideHint();
	      if(opts.toast) safeToast('GPS refreshed');
	      return;
	    }

	    setStateSafe('GPS live');
	    hideHint();
	    if(opts.toast) safeToast('GPS located');
	  }
  function requestLiveGps(opts){
    opts=opts||{};
    if(!navigator.geolocation){ setGpsLabelSafe(false,'GPS unavailable'); safeToast('GPS unavailable'); return; }
    setGpsLabelSafe(true,'GPS…');
    navigator.geolocation.getCurrentPosition(pos=>{
      const here=L.latLng(pos.coords.latitude,pos.coords.longitude);
      applyLiveGpsPosition(here, opts);
      try{ if(typeof startWatch==='function') startWatch(); }catch(e){}
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    },err=>{
      const denied=err&&err.code===1;
      setGpsLabelSafe(false,denied?'GPS denied':'GPS weak');
      setStateSafe(denied?'GPS permission needed':'GPS is searching');
      if(denied)hideHint();
      else showHintSafe('GPS is searching. Try again near the tee.');
      safeToast(err&&err.message?err.message:(denied?'Location permission needed':'GPS is searching'));
      try{ if(typeof gdV62Refresh==='function') gdV62Refresh(); }catch(e){}
    },{enableHighAccuracy:true,maximumAge:0,timeout:15000});
  }

  window.refreshGPS=function(){ requestLiveGps({jump:true,toast:true,label:'GPS refreshed'}); };
  window.gdGpsLocateNow=function(){ requestLiveGps({jump:true,toast:true,label:'GPS locate'}); };

  const oldEnterLive=window.setGpsPlayMode;
  if(typeof oldEnterLive==='function'&&!oldEnterLive.__gdLocateJumpWrapped){
    const wrapped=function(next){
      if(next==='live') { requestLiveGps({jump:true,toast:false,label:'GPS live'}); return; }
      return oldEnterLive.apply(this,arguments);
    };
    wrapped.__gdLocateJumpWrapped=true;
    window.setGpsPlayMode=wrapped;
  }

  const oldInit=window.initGPS;
  if(typeof oldInit==='function'&&!oldInit.__gdLocateJumpWrapped){
    const wrapped=function(){
      const res=oldInit.apply(this,arguments);
      try{
        const saved=localStorage.getItem('gd_gps_play_mode');
        if(saved==='live'&&!isLocked()) setTimeout(()=>requestLiveGps({jump:true,toast:false,label:'GPS live'}),250);
      }catch(e){}
      return res;
    };
    wrapped.__gdLocateJumpWrapped=true;
    window.initGPS=wrapped;
  }
})();
