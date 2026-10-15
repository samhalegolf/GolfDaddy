(function(){
  "use strict";
  if(window.GDShell&&window.GDShell.__owner==="GDShell")return;

  /* Values are GDI18n keys ("shell.*"); anything else (brand, admin) is shown as-is. */
  var ROUTE_LABELS={
    home:"shell.home",
    "course-picker":"GPS",
    "module:profile":"shell.profile",
    "module:bag":"shell.bag",
    "module:settings":"shell.settings",
    "module:playerSettings":"shell.settings",
    "module:admin":"Admin",
    "module:dataHub":"shell.data",
    "module:shotData":"shell.shotData",
    "module:courseData":"shell.courseData",
    "module:practiceData":"shell.practiceData",
    auth:"shell.profile"
  };
  /* Callers (gd-route-audit.js) still pass English labels in opts.label. */
  var LABEL_KEYS={
    "Home":"shell.home",
    "Profile":"shell.profile",
    "Bag":"shell.bag",
    "Settings":"shell.settings",
    "Data":"shell.data",
    "Shot Data":"shell.shotData",
    "Course Data":"shell.courseData",
    "Practice Data":"shell.practiceData"
  };
  var MODULE_IDS={
    profile:"profilePanel",
    profilePanel:"profilePanel",
    gdProfileV67:"gdProfileV67",
    bag:"bagPanel",
    bagPanel:"bagPanel",
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
    source:"init",
    enteredAt:new Date().toISOString(),
    history:["home"],
    initialized:false
  };

  function safe(fn,fallback){try{return fn()}catch(e){return fallback}}
  function byId(id){return document.getElementById(id)}
  function clone(){return Object.assign({},state,{history:state.history.slice()})}
  function routeLabel(route,module,label){
    if(label)return LABEL_KEYS[label]||label;
    if(route==="module")return ROUTE_LABELS["module:"+module]||String(module||"Module").replace(/Panel$/,"").replace(/([A-Z])/g," $1").trim();
    return ROUTE_LABELS[route]||"shell.home";
  }
  function isLabelKey(label){return /^shell\.[A-Za-z]+$/.test(String(label||""));}
  function labelText(label){return isLabelKey(label)?window.GDI18n.t(label):label;}
  function showLabel(el,label){
    if(!el)return;
    if(isLabelKey(label))window.GDI18n.set(el,label);
    else window.GDI18n.plain(el,label);
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
    var module=state.route==="module";
    document.body.classList.toggle("shell-home",home);
    document.body.classList.toggle("shell-gps",picker);
    document.body.classList.toggle("shell-module",module);
    document.body.classList.toggle("gdGpsActive",picker);
    document.body.classList.toggle("gps-active",picker);
    document.body.classList.toggle("gdCoursePickerOpen",picker);
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
      document.body.dataset.clarityRouteLabel=labelText(label);
      document.body.dataset.gdToolScreen=route==="home"?"home":route==="course-picker"?"picker":route==="module"?"module":"unmapped";
    }
    showLabel(byId("shellRouteLabel"),label);
    var back=byId("shellBackBtn");
    if(back)back.style.visibility=route==="home"?"hidden":"visible";
    setDock(opts.dock||DOCK_NAMES[state.module]||(route==="course-picker"?"gps":""));
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
    state.source=opts.source||route;
    state.enteredAt=new Date().toISOString();
    applyRouteDom(opts);
    return false;
  }
  function showHome(opts){
    opts=opts||{};
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
    if(opts.to==="previous"&&state.previousRoute&&state.previousRoute!=="course-picker")return back(opts);
    return showHome(Object.assign({source:"course-picker-close"},opts));
  }
  /* GPS Play is its own page (app/); the course picker is the way in, and the
     only place in this shell that Play, the Play dock button, or "back to play"
     can land. */
  function enterGps(opts){
    opts=opts||{};
    var pickerOpts={source:opts.source||"gps",returnTarget:opts.returnTarget||"home",replace:!!opts.replace};
    if(window.GDCoursePicker&&typeof window.GDCoursePicker.open==="function")return window.GDCoursePicker.open(pickerOpts);
    return openCoursePicker(pickerOpts);
  }
  function normalModuleName(name){
    var key=String(name||"").trim();
    if(key==="developerPanel"||key==="developer")return "admin";
    if(key==="dataHubPanel")return "dataHub";
    if(key==="statsPanel")return "courseData";
    if(key==="practiceDataPanel")return "practiceData";
    if(key==="bagPanel")return "bag";
    if(key==="profilePanel"||key==="gdProfileV67")return "profile";
    return key||"module";
  }
  function openModule(name,opts){
    opts=opts||{};
    var module=normalModuleName(opts.module||name);
    var moduleId=opts.moduleId||MODULE_IDS[name]||MODULE_IDS[module]||String(name||"");
    var wasGps=state.route==="course-picker";
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
      return enterGps({replace:true,source:"module-back"});
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
    state.source=opts.source||"auth";
    state.enteredAt=new Date().toISOString();
    showElement(byId("shellHome"),false);
    showElement(byId("courseScreen"),false);
    showChrome(false);
    applyBodyClasses();
    document.body.classList.add("gdAuthLocked","gdProfileOpen");
    var profile=byId("gdProfileV67");
    if(profile)profile.classList.remove("hidden");
    showLabel(byId("shellRouteLabel"),routeLabel("auth"));
    return false;
  }
  function back(opts){
    opts=opts||{};
    if(state.route==="module")return closeModule(opts);
    if(state.route==="course-picker")return closeCoursePicker({to:"origin",source:"course-picker-back"});
    return false;
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
    openModule:openModule,
    closeModule:closeModule,
    showAuth:showAuth,
    back:back,
    home:home,
    getState:clone,
    destroy:destroy
  };
  window.GDShell=api;

  window.showShellHome=function(){return api.showHome({source:"legacy-showShellHome"});};
  window.gdCanonicalShellHome=function(){return api.home.apply(api,arguments);};
  window.gdCanonicalShellBack=function(){return api.back({source:"legacy-canonical-back"});};
  window.gdShellBackClick=function(event){event?.preventDefault?.();event?.stopPropagation?.();event?.stopImmediatePropagation?.();return api.back({event:event,source:"shell-back-click"});};
  window.shellBack=function(event){return api.back({event:event,source:"legacy-shellBack"});};
  window.enterGpsModule=function(opts){return api.enterGps(opts||{});};
  window.openShellModule=function(id,opts){return api.openModule(id,opts||{});};
  window.showModePicker=function(){return api.showHome({source:"legacy-showModePicker"});};
  window.showModeDashboard=function(){return api.showHome({source:"legacy-showModeDashboard"});};

  safe(function(){showShellHome=window.showShellHome;gdCanonicalShellHome=window.gdCanonicalShellHome;gdCanonicalShellBack=window.gdCanonicalShellBack;gdShellBackClick=window.gdShellBackClick;shellBack=window.shellBack;enterGpsModule=window.enterGpsModule;openShellModule=window.openShellModule;showModePicker=window.showModePicker;showModeDashboard=window.showModeDashboard;});

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
  else init();
})();
