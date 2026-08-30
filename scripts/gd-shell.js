(function(){
  "use strict";
  if(window.GDShell&&window.GDShell.__owner==="GDShell")return;

  var ROUTE_LABELS={
    home:"Home",
    "course-picker":"GPS",
    gps:"GPS",
    "module:profile":"Profile",
    "module:bag":"Bag",
    "module:settings":"Settings",
    "module:playerSettings":"Settings",
    "module:admin":"Admin",
    "module:dataHub":"Data",
    "module:shotData":"Shot Data",
    "module:courseData":"Course Data",
    "module:practiceData":"Practice Data",
    auth:"Profile"
  };
  var MODULE_IDS={
    profile:"profilePanel",
    profilePanel:"profilePanel",
    gdProfileV67:"gdProfileV67",
    bag:"bagPanel",
    bagPanel:"bagPanel",
    settings:"settingsPanel",
    settingsPanel:"settingsPanel",
    playerSettings:"playerSettingsPanel",
    playerSettingsPanel:"playerSettingsPanel",
    admin:"developerPanel",
    developer:"developerPanel",
    developerPanel:"developerPanel",
    dataHub:"dataHubPanel",
    shotData:"dataHubPanel",
    courseData:"dataHubPanel",
    practiceData:"dataHubPanel",
    statsPanel:"dataHubPanel",
    practiceDataPanel:"dataHubPanel"
  };
  var DOCK_NAMES={gps:"gps",bag:"bag",admin:"admin",dataHub:"bubble",shotData:"bubble",courseData:"bubble",practiceData:"bubble"};
  var state={
    route:"home",
    layer:"home",
    module:null,
    previousRoute:null,
    coursePickerOpen:false,
    gpsActive:false,
    source:"init",
    enteredAt:new Date().toISOString(),
    history:["home"],
    initialized:false
  };

  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function byId(id){return document.getElementById(id)}
  function clone(){return Object.assign({},state,{history:state.history.slice()})}
  function routeLabel(route,module,label){
    if(label)return label;
    if(route==="module")return ROUTE_LABELS["module:"+module]||String(module||"Module").replace(/Panel$/,"").replace(/([A-Z])/g," $1").trim();
    return ROUTE_LABELS[route]||"Home";
  }
  function remember(route,replace){
    state.previousRoute=replace?state.previousRoute:state.route;
    if(replace)state.history=state.history.length?state.history.slice(0,-1).concat(route):[route];
    else if(state.history[state.history.length-1]!==route)state.history=state.history.concat(route).slice(-24);
  }
  function closePanels(exceptId){
    document.querySelectorAll(".modulePanel.open,.panel.open").forEach(function(panel){
      if(panel.id!==exceptId)panel.classList.remove("open");
    });
  }
  function showElement(el,on,display){
    if(!el)return;
    el.classList.toggle("hidden",!on);
    if(on){
      el.removeAttribute("hidden");
      el.style.display=display||"";
      el.style.visibility="";
      el.style.opacity="";
      el.style.pointerEvents="";
    }else{
      el.style.display="";
      el.style.visibility="";
      el.style.opacity="";
      el.style.pointerEvents="";
    }
  }
  function showChrome(on){
    ["shellTop","shellDock"].forEach(function(id){
      var el=byId(id);
      if(!el)return;
      if(on){
        el.classList.remove("gdGpsModuleDock","gdHiddenGpsDock");
        ["display","visibility","pointerEvents","opacity"].forEach(function(prop){el.style[prop]="";});
      }
      el.classList.toggle("visible",!!on);
    });
  }
  function setDock(name){
    ["Gps","Bubble","Bag","Admin"].forEach(function(key){
      var el=byId("dock"+key);
      if(el)el.classList.toggle("active",key.toLowerCase()===(name||""));
    });
  }
  function clearPickerDatasets(){
    if(!document.body||!document.body.dataset)return;
    [
      "gdCourseNeedsPin",
      "gdCourseNeedsPinCourse",
      "gdCoursePinDecision",
      "gdCourseDatabaseMapAvailable",
      "gdCourseDatabaseMapSource",
      "gdCourseAutoMapStatus",
      "gdCourseAutoMappedHoles",
      "gdCourseAutoMapSaved",
      "gdCourseScannerSeed"
    ].forEach(function(key){delete document.body.dataset[key];});
    safe(function(){window.__gdCoursePickerPinPromptActive=false;});
    safe(function(){window.__gdPendingCoursePinPayload=null;});
  }
  function applyBodyClasses(){
    if(!document.body)return;
    var home=state.route==="home";
    var picker=state.route==="course-picker";
    var gps=state.route==="gps";
    var module=state.route==="module";
    document.body.classList.toggle("shell-home",home);
    document.body.classList.toggle("shell-gps",gps||picker);
    document.body.classList.toggle("shell-module",module);
    document.body.classList.toggle("gdGpsActive",gps||picker);
    document.body.classList.toggle("gps-active",gps||picker);
    document.body.classList.toggle("gdCoursePickerOpen",picker);
    if(!(gps||picker))document.body.classList.remove("gps-open","manual-gps-active");
    if(!picker)document.body.classList.remove("gdCoursePinPromptActive","gdCourseOpening");
  }
  function applyRouteDom(opts){
    opts=opts||{};
    var route=state.route;
    var moduleId=state.moduleId||null;
    var label=routeLabel(route,state.module,opts.label);
    var home=byId("shellHome");
    var course=byId("courseScreen");
    var profile=byId("gdProfileV67");
    closePanels(moduleId);
    if(route!=="module"||moduleId!=="gdProfileV67")safe(function(){profile&&profile.classList.add("hidden");document.body.classList.remove("gdProfileOpen");});
    showElement(home,route==="home");
    showElement(course,route==="course-picker","flex");
    if(route!=="course-picker")safe(function(){byId("gdCoursePinScreen")?.classList.add("hidden");});
    if(route==="module"&&moduleId){
      if(moduleId==="gdProfileV67"){
        var profileEl=byId("gdProfileV67");
        if(profileEl)profileEl.classList.remove("hidden");
        document.body.classList.add("gdProfileOpen");
      }else{
        var panel=byId(moduleId);
        if(panel)panel.classList.add("open");
      }
    }
    showChrome(route!=="home"&&route!=="auth");
    applyBodyClasses();
    if(document.body&&document.body.dataset){
      document.body.dataset.clarityRoute=route==="course-picker"?"course-picker":route==="module"?(state.module||"module"):route;
      document.body.dataset.clarityRouteLabel=label;
      document.body.dataset.gdToolScreen=route==="home"?"home":route==="course-picker"?"picker":route==="module"?"module":"unmapped";
    }
    var labelEl=byId("shellRouteLabel");
    if(labelEl)labelEl.textContent=label;
    var back=byId("shellBackBtn");
    if(back)back.style.visibility=route==="home"?"hidden":"visible";
    var settings=byId("shellSettingsBtn");
    if(settings)settings.style.visibility=(route==="gps"||route==="course-picker")?"visible":"hidden";
    setDock(opts.dock||DOCK_NAMES[state.module]||(route==="gps"||route==="course-picker"?"gps":""));
    safe(function(){window.ClarityRouter?.remember?.(route==="module"?(state.module||"module"):route,!!opts.replace);});
    safe(function(){window.dispatchEvent(new CustomEvent("gd:shell-route-changed",{detail:clone()}));});
  }
  function transition(route,opts){
    opts=opts||{};
    remember(route,!!opts.replace);
    state.route=route;
    state.layer=route==="course-picker"?"gps":route;
    state.module=opts.module||null;
    state.moduleId=opts.moduleId||null;
    state.coursePickerOpen=route==="course-picker";
    state.gpsActive=route==="gps";
    state.source=opts.source||route;
    state.enteredAt=new Date().toISOString();
    applyRouteDom(opts);
    return false;
  }
  function showHome(opts){
    opts=opts||{};
    var leavingGps=state.route==="gps"||!!(document.body&&document.body.classList.contains("shell-gps")&&!document.body.classList.contains("gdCoursePickerOpen"));
    if(leavingGps&&window.GDGpsPlayRuntime&&typeof window.GDGpsPlayRuntime.leave==="function")safe(function(){window.GDGpsPlayRuntime.leave({reason:opts.source||"shell-home"});});
    else if(leavingGps)safe(function(){window.gdGpsPlayRuntimeLeave?.({reason:opts.source||"shell-home"});});
    safe(function(){window.GolfDaddyAccounts?.returnToOwnProfile?.({silent:true});});
    safe(function(){window.ClaritySession?.sync?.("home");});
    clearPickerDatasets();
    safe(function(){var hint=byId("hint");if(hint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent="";}});
    safe(function(){var appEl=byId("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame");});
    window.__gdBackTarget="";
    return transition("home",Object.assign({replace:true,source:"home"},opts));
  }
  function openCoursePicker(opts){
    opts=opts||{};
    window.__gdCoursePickerReturnTarget=opts.returnTarget||state.previousRoute||"home";
    clearPickerDatasets();
    safe(function(){if(typeof gdClearMappedStartPromptChrome==="function")gdClearMappedStartPromptChrome();});
    return transition("course-picker",Object.assign({source:"course-picker",dock:"gps"},opts));
  }
  function closeCoursePicker(opts){
    opts=opts||{};
    clearPickerDatasets();
    if(opts.to==="origin"){
      var target=window.__gdCoursePickerReturnTarget||"home";
      if(target==="practice")return openModule("practiceData",{module:"practiceData",moduleId:"practiceDataPanel",source:"course-picker-back"});
      if(target==="coach-player")return openModule("profile",{module:"profile",source:"course-picker-back"});
    }
    if(opts.to==="gps")return enterGps(Object.assign({replace:true,fromCoursePicker:true},opts));
    if(opts.to==="previous"&&state.previousRoute&&state.previousRoute!=="course-picker")return back(opts);
    return showHome(Object.assign({source:"course-picker-close"},opts));
  }
  function enterGps(opts){
    opts=opts||{};
    clearPickerDatasets();
    transition("gps",Object.assign({source:"gps",dock:"gps"},opts));
    safe(function(){window.gdApplyGpsMapVisibilityOwner?.("shell-enter-gps");});
    safe(function(){if(typeof map!=="undefined"&&map&&map.invalidateSize)setTimeout(function(){map.invalidateSize();},80);});
    safe(function(){window.gdHydrateGpsBadge?.(true);});
    // This is the shell's OWN enter-GPS path (window.enterGpsModule gets
    // overwritten to delegate here, so gd-app-core.js's enterGpsModule body
    // never actually runs for a normal GPS entry) - the "playing as" badge
    // sync has to live here too, or it silently never fires.
    safe(function(){window.gdSyncGpsPlayerBadge?.();});
    return false;
  }
  function leaveGps(opts){
    opts=opts||{};
    if(window.GDGpsPlayRuntime&&typeof window.GDGpsPlayRuntime.leave==="function")safe(function(){window.GDGpsPlayRuntime.leave({reason:opts.source||"shell-leave-gps"});});
    else safe(function(){window.gdGpsPlayRuntimeLeave?.({reason:opts.source||"shell-leave-gps"});});
    return opts.to==="home"?showHome(opts):false;
  }
  function normalModuleName(name){
    var key=String(name||"").trim();
    if(key==="developerPanel"||key==="developer")return "admin";
    if(key==="dataHubPanel")return "dataHub";
    if(key==="statsPanel")return "courseData";
    if(key==="practiceDataPanel")return "practiceData";
    if(key==="settingsPanel")return "settings";
    if(key==="bagPanel")return "bag";
    if(key==="profilePanel"||key==="gdProfileV67")return "profile";
    return key||"module";
  }
  function openModule(name,opts){
    opts=opts||{};
    var module=normalModuleName(opts.module||name);
    var moduleId=opts.moduleId||MODULE_IDS[name]||MODULE_IDS[module]||String(name||"");
    var wasGps=state.route==="gps"||state.route==="course-picker"||document.body?.classList.contains("shell-gps");
    var wasHome=state.route==="home"||document.body?.classList.contains("shell-home");
    if(opts.fromGps)window.__gdBackTarget="gps";
    else if(opts.fromHome)window.__gdBackTarget="home";
    else if(opts.fromProfile)window.__gdBackTarget="profile";
    else if(!window.__gdBackTarget)window.__gdBackTarget=wasGps&&!wasHome?"gps":"home";
    return transition("module",Object.assign({source:"module",module:module,moduleId:moduleId,dock:DOCK_NAMES[module]},opts));
  }
  function closeModule(opts){
    opts=opts||{};
    closePanels();
    safe(function(){byId("gdProfileV67")?.classList.add("hidden");document.body.classList.remove("gdProfileOpen");});
    if(opts.to==="gps"||window.__gdBackTarget==="gps"){
      window.__gdBackTarget="";
      return enterGps({replace:true,preserveState:true,fromBack:true});
    }
    window.__gdBackTarget="";
    return showHome({source:"module-close"});
  }
  function showAuth(opts){
    opts=opts||{};
    closePanels();
    state.route="auth";
    state.layer="auth";
    state.module="profile";
    state.moduleId="gdProfileV67";
    state.coursePickerOpen=false;
    state.gpsActive=false;
    state.source=opts.source||"auth";
    state.enteredAt=new Date().toISOString();
    showElement(byId("shellHome"),false);
    showElement(byId("courseScreen"),false);
    showChrome(false);
    applyBodyClasses();
    document.body.classList.add("gdAuthLocked","gdProfileOpen");
    var profile=byId("gdProfileV67");
    if(profile)profile.classList.remove("hidden");
    var label=byId("shellRouteLabel");
    if(label)label.textContent=routeLabel("auth");
    return false;
  }
  function back(opts){
    opts=opts||{};
    if(state.route==="module")return closeModule(opts);
    if(state.route==="course-picker")return closeCoursePicker({to:"origin",source:"course-picker-back"});
    if(state.route==="gps"){
      safe(function(){window.GDGpsPlayRuntime?.back?.({source:"shell-back"});});
      if(window.GDGpsPlayRuntime&&typeof window.GDGpsPlayRuntime.back==="function")return false;
      return openCoursePicker({source:"gps-back",returnTarget:"gps"});
    }
    return false;
  }
  function backPointer(event){
    if(document.body&&document.body.classList.contains("gdMappedStartPromptActive")&&!document.body.classList.contains("gdManualStartPlacementActive")){
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      return back({source:"mapped-start-pointer"});
    }
    return true;
  }
  function home(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    return showHome({source:"home-command"});
  }
  function init(){
    if(state.initialized)return false;
    state.initialized=true;
    applyRouteDom({replace:true});
    /* A GPS exit reloads the root shell. Restore only a validated semantic
       surface, never a stale browser-history GPS route. */
    setTimeout(function(){safe(function(){window.GDPlayContext?.restore?.();});},0);
    var homeBtn=byId("shellHomeBtn");
    if(homeBtn&&!homeBtn.__gdShellOwnerBound){
      homeBtn.__gdShellOwnerBound=true;
      homeBtn.onclick=home;
    }
    var backBtn=byId("shellBackBtn");
    if(backBtn&&!backBtn.__gdShellOwnerBound){
      backBtn.__gdShellOwnerBound=true;
      backBtn.onclick=function(event){event?.preventDefault?.();return back({event:event,source:"back-button"});};
      backBtn.onpointerdown=backPointer;
    }
    var profileBtn=byId("shellProfileReturnBtn");
    if(profileBtn&&!profileBtn.__gdShellOwnerBound){
      profileBtn.__gdShellOwnerBound=true;
      profileBtn.onclick=function(event){
        event?.preventDefault?.();
        event?.stopPropagation?.();
        return typeof window.gdReturnToProfileWorkspace==="function"?window.gdReturnToProfileWorkspace():false;
      };
    }
    var settingsBtn=byId("shellSettingsBtn");
    if(settingsBtn&&!settingsBtn.__gdShellOwnerBound){
      settingsBtn.__gdShellOwnerBound=true;
      settingsBtn.onclick=function(event){
        event?.preventDefault?.();
        event?.stopPropagation?.();
        if(typeof window.openSettings==="function")return window.openSettings({fromGps:true});
        return openModule("settings",{source:"shell-settings",fromGps:true});
      };
    }
    return false;
  }
  function destroy(){state.initialized=false;return false;}

  var api={
    __owner:"GDShell",
    init:init,
    showHome:showHome,
    openCoursePicker:openCoursePicker,
    closeCoursePicker:closeCoursePicker,
    enterGps:enterGps,
    leaveGps:leaveGps,
    openModule:openModule,
    closeModule:closeModule,
    showAuth:showAuth,
    back:back,
    backPointer:backPointer,
    home:home,
    getState:clone,
    destroy:destroy
  };
  window.GDShell=api;

  window.showShellHome=function(){return api.showHome({source:"legacy-showShellHome"});};
  window.gdCanonicalShellHome=function(){return api.home.apply(api,arguments);};
  window.gdCanonicalShellBack=function(){return api.back({source:"legacy-canonical-back"});};
  window.gdShellBackClick=function(event){event?.preventDefault?.();event?.stopPropagation?.();event?.stopImmediatePropagation?.();return api.back({event:event,source:"shell-back-click"});};
  window.gdShellBackPointer=function(event){return api.backPointer(event);};
  window.shellBack=function(event){return api.back({event:event,source:"legacy-shellBack"});};
  window.enterGpsModule=function(opts){return api.enterGps(opts||{});};
  window.openShellModule=function(id,opts){return api.openModule(id,opts||{});};
  window.showModePicker=function(){return api.showHome({source:"legacy-showModePicker"});};
  window.showModeDashboard=function(){return api.showHome({source:"legacy-showModeDashboard"});};

  safe(function(){showShellHome=window.showShellHome;gdCanonicalShellHome=window.gdCanonicalShellHome;gdCanonicalShellBack=window.gdCanonicalShellBack;gdShellBackClick=window.gdShellBackClick;gdShellBackPointer=window.gdShellBackPointer;shellBack=window.shellBack;enterGpsModule=window.enterGpsModule;openShellModule=window.openShellModule;showModePicker=window.showModePicker;showModeDashboard=window.showModeDashboard;});

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
