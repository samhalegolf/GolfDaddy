/* GolfDaddy canonical route audit / shell navigation owner. Extracted
   verbatim (split-02) from the inline <script id=gdCanonicalRouteAuditV1>
   block at index.html:38574. Self-contained IIFE. */
(function(){
  "use strict";
  const routeAuditGuard="data-gd-canonical-route-audit-v1";
  if(document.documentElement.hasAttribute(routeAuditGuard))return;
  document.documentElement.setAttribute(routeAuditGuard,"1");
  const oldEnterGps=window.enterGpsModule;
  const oldOpenShellModule=window.openShellModule;
  const oldOpenProfilePanel=window.openProfilePanel;
  function safe(fn,fallback){try{return fn();}catch(e){console.warn("[GolfDaddy] route audit",e);return fallback;}}
  function byId(id){return document.getElementById(id);}
  function closeLegacyPanels(){document.querySelectorAll(".panel.open").forEach(panel=>panel.classList.remove("open"));}
  function closeModules(){document.querySelectorAll(".modulePanel.open").forEach(panel=>panel.classList.remove("open"));}
  function hideOverlays(){
    [
      "gdCourseLibraryOverlay","gdCourseConfirmOverlay","gdMapperToolsDrawer","gdMapperToolFlyout",
      "gdMapperHoleStrip","gdPinLockOverlay","gdPinToolFlyout","gdPinChoiceSheet","gdAssumedCourseBadge"
	    ].forEach(id=>byId(id)?.classList.add("hidden"));
	    document.body.classList.remove("gdFullMappingMode");
	    try{window.gdFullMappingMode=false;sessionStorage.removeItem("gd_full_mapping_mode");}catch(e){}
	    try{if(typeof window.gdClearMapperGuideUi==="function")window.gdClearMapperGuideUi();}catch(e){}
	    byId("gdProfileV67")?.classList.add("hidden");
  }
		  function showCoursePicker(){
		    if(window.GDCoursePicker&&typeof window.GDCoursePicker.open==="function"){
		      return window.GDCoursePicker.open({source:"route-audit",returnTarget:"gps"});
		    }
		    if(window.GDShell&&typeof window.GDShell.openCoursePicker==="function"){
		      return window.GDShell.openCoursePicker({source:"route-audit-fallback",returnTarget:"gps"});
		    }
		    const screen=byId("courseScreen");
		    if(!screen)return;
    clearCoursePickerDatabaseState();
    document.body.classList.remove("gdMappedCourseMode","gdMappedStartPromptActive","gdToolRailOpen","gdCourseOpening","gdCoursePinPromptActive");
    safe(()=>{window.__gdCoursePickerPinPromptActive=false;});
    screen.classList.remove("hidden");
    screen.style.display="flex";
    screen.style.pointerEvents="auto";
    screen.style.visibility="";
    screen.style.opacity="";
    try{if(typeof gdRefreshAssumedCourseFromLocation==="function")gdRefreshAssumedCourseFromLocation();}catch(e){}
  }
		  function hideCoursePicker(){
		    if(window.GDShell&&typeof window.GDShell.closeCoursePicker==="function")return window.GDShell.closeCoursePicker({reason:"route-audit-hide-course-picker",to:"gps"});
		    const screen=byId("courseScreen");
	    if(screen)screen.classList.add("hidden");
	    clearCoursePickerOwnerState();
	  }
	  function hasActiveCourse(){
	    try{if(typeof currentCourse!=="undefined"&&currentCourse&&currentCourse.name)return true;}catch(e){}
	    try{const raw=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");if(raw&&raw.name&&typeof gdHasRestorableCourseSession==="function"&&gdHasRestorableCourseSession(raw))return true;}catch(e){}
	    return false;
	  }
	  function activeCourseForGpsStable(){
	    try{if(typeof currentCourse!=="undefined"&&currentCourse&&currentCourse.name)return currentCourse;}catch(e){}
	    try{const raw=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");if(raw&&raw.name&&typeof gdHasRestorableCourseSession==="function"&&gdHasRestorableCourseSession(raw))return raw;}catch(e){}
	    return null;
	  }
	  function recommendedCourseForGpsStable(){
	    const root=byId("gdCourseAssumedOption");
	    const el=root?.querySelector?.(".courseAssumedBlock[data-gd-course-name]")||root;
	    if(!el)return null;
	    const name=String(el.dataset.gdCourseName||root?.dataset?.gdCourseName||"").trim();
	    if(!name||/^manual gps$/i.test(name))return null;
	    const payload=el.__gdCoursePayload||root?.__gdCoursePayload||{
	      name,
	      courseName:name,
	      courseId:el.dataset.gdCourseId||root?.dataset?.gdCourseId||name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""),
	      lat:Number(el.dataset.gdCourseLat||root?.dataset?.gdCourseLat),
	      lng:Number(el.dataset.gdCourseLng||root?.dataset?.gdCourseLng)
	    };
	    return typeof gdNormalizeCoursePickerPayload==="function"?gdNormalizeCoursePickerPayload(payload):payload;
	  }
	  function visibleCourseForGpsStable(){
	    const name=String(byId("courseLine")?.textContent||"").trim();
	    if(!name||/^manual gps$/i.test(name))return null;
	    return {name,courseName:name,courseId:name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")};
	  }
	  function gpsStableCourseIsManual(course){
	    return typeof gdCoursePayloadIsManual==="function"
	      ?gdCoursePayloadIsManual(course)
	      :/^manual gps$/i.test(String(course?.name||course?.courseName||""));
	  }
	  function forceStableMappedHoleOne(course,reason){
	    const payload=course||activeCourseForGpsStable()||visibleCourseForGpsStable();
	    if(!payload||gpsStableCourseIsManual(payload))return false;
	    if(safe(()=>typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset(),false))return false;
	    safe(()=>{selectedHole=1;currentPlayingHole=1;});
	    safe(()=>{sessionStorage.setItem("gd_active_playing_hole","1");sessionStorage.setItem("gd_mapper_active_hole","1");});
	    safe(()=>{window.gdMapperActiveHole=1;});
	    safe(()=>{document.body.classList.add("gdMappedCourseMode");document.body.classList.remove("manual-gps-active");});
	    safe(()=>{if(typeof setHole==="function")setHole({hole:1});});
	    safe(()=>{mode="start";});
	    safe(()=>{if(typeof setState==="function")setState("Mapped: set position");});
	    safe(()=>{
	      const h=byId("hint");
	      if(!h)return;
	      h.classList.add("gdMappedStartPill","visible");
	      if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(h);
	      else h.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
	      if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame();
	    });
	    safe(()=>{window.gdStableMappedHoleOneLast={reason:reason||"gps-stable",course:payload,at:Date.now()};});
	    return true;
	  }
	  function scheduleStableMappedHoleOne(course,reason){
	    const payload=course||activeCourseForGpsStable()||visibleCourseForGpsStable();
	    if(!payload||gpsStableCourseIsManual(payload))return false;
	    if(safe(()=>typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset(),false))return false;
	    safe(()=>{window.gdStableMappedHoleOneLast={reason:reason||"gps-stable",course:payload,at:Date.now(),scheduledOnly:true};});
	    [0,420,950,1800].forEach(delay=>setTimeout(()=>safe(()=>{
	      if(typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset())return;
	      hideCoursePicker();
	      if(typeof window.gdScheduleCoursePickerFirstHoleOpen==="function")window.gdScheduleCoursePickerFirstHoleOpen(payload);
	      else if(typeof window.gdOpenCourseToFirstHole==="function")window.gdOpenCourseToFirstHole(payload);
	    }),delay));
	    return true;
	  }
	  function clearBody(){
	    [
	      "gdStatsOpen","gdProfileOpen","gdBubbleStudioOpen","gdGpsActive","gps-active","gps-open",
	      "manual-gps-active","shell-home","shell-gps","shell-module","gdShotDataOpen","gdMappedCourseMode","gdMappedStartPromptActive",
	      "gdManualStartPlacementActive","gdToolRailOpen","gdCoursePickerOpen","gdCoursePinPromptActive","gdCourseOpening","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn",
	      "gdAuthLocked","gdPasswordResetRoute","gdGreenArrivalMode","gdMappedSnapCameraActive","gdPreLockBlackoutFrame",
	      "gdFullMappingMode","gdFullMappingUiActive"
	    ].forEach(cls=>document.body.classList.remove(cls));
	  }
	  function clearGpsSurfaceLocks(){
	    document.body.classList.remove(
	      "gd-frame-hard-locked",
	      "gd-replacing-green-centre",
	      "gdMappedCourseMode",
	      "gdManualStartPlacementActive",
	      "gdToolRailOpen",
	      "gdCapturedHoleFrameCameraOn",
	      "gdHoleImageCameraOn"
	    );
	    document.documentElement.classList.remove("gdGpsViewportLocked");
	  }
	  function clearRouteBootLocks(){
	    document.documentElement.classList.remove("gdAuthRouteBoot","gdResetRouteBoot","gdGpsViewportLocked");
	    document.body.classList.remove("gdAuthLocked","gdPasswordResetRoute","gdProfileOpen");
	  }
	  function restoreHomeSurface(){
	    clearCoursePickerOwnerState();
	    const home=byId("shellHome");
	    if(home){
	      home.classList.remove("hidden");
	      home.removeAttribute("hidden");
	      ["display","visibility","pointerEvents","opacity"].forEach(prop=>home.style[prop]="");
	    }
	    const screen=byId("courseScreen");
	    if(screen){
	      screen.classList.add("hidden");
	      ["display","visibility","pointerEvents","opacity","transform"].forEach(prop=>screen.style[prop]="");
	    }
	    document.querySelectorAll(".modulePanel.open,.panel.open").forEach(panel=>panel.classList.remove("open"));
	    byId("gdProfileV67")?.classList.add("hidden");
	    document.body.dataset.gdToolScreen="home";
	  }
  function showShellChrome(on){
    ["shellTop","shellDock"].forEach(id=>{
      const el=byId(id);
      if(!el)return;
      if(on){
        el.classList.remove("gdGpsModuleDock","gdHiddenGpsDock");
        ["display","visibility","pointerEvents","opacity"].forEach(prop=>el.style[prop]="");
      }
      el.classList.toggle("visible",!!on);
    });
  }
	  function setRouteLabel(label){
	    if(document.body&&document.body.dataset)document.body.dataset.clarityRouteLabel=label||"Home";
	    setProfileReturnButton();
	  }
  function setDock(name){
    ["Gps","Bubble","Bag","Admin"].forEach(key=>{
      byId("dock"+key)?.classList.toggle("active",key.toLowerCase()===name);
    });
  }
  function setProfileReturnButton(){
    const btn=byId("shellProfileReturnBtn");
    if(!btn)return;
    const active=window.__gdBackTarget==="profile"&&!!window.__gdProfileReturnProfileId;
    btn.classList.toggle("visible",active);
    btn.setAttribute("aria-label",active?`Return to ${window.__gdProfileReturnName||"selected profile"}`:"Return to selected profile");
    btn.title=active?`Back to ${window.__gdProfileReturnName||"profile"}`:"Profile";
  }
  function clearProfileReturn(){
    window.__gdProfileReturnProfileId="";
    window.__gdProfileReturnName="";
    setProfileReturnButton();
  }
  function clearCoursePickerDatabaseState(){
    const data=document.body&&document.body.dataset;
    if(!data)return;
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
    ].forEach(key=>delete data[key]);
  }
  function clearCoursePickerOwnerState(){
    clearCoursePickerDatabaseState();
    document.body.classList.remove("gdCoursePinPromptActive","gdCourseOpening","gdToolRailOpen");
    safe(()=>{window.__gdCoursePickerPinPromptActive=false;});
    safe(()=>{window.__gdPendingCoursePinPayload=null;});
    safe(()=>{window.__gdCoursePickerDbCheckToken="";});
    byId("gdCoursePinScreen")?.classList.add("hidden");
  }
  const GD_BROWSER_ROUTE_STATE_KEY="gdShellRouteV1";
  let gdBrowserRouteRestoring=false;
  let gdBrowserRouteInstalled=false;
  function gdBrowserAdminAllowed(){
    const session=safe(()=>window.ClaritySession?.get?.(),null);
    const role=String(session?.accountRole||"");
    return role==="admin"||role==="coach";
  }
  function gdBrowserRouteState(route){
    return {
      [GD_BROWSER_ROUTE_STATE_KEY]:true,
      route:String(route||"home"),
      backTarget:String(window.__gdBackTarget||""),
      profileReturnProfileId:String(window.__gdProfileReturnProfileId||""),
      profileReturnName:String(window.__gdProfileReturnName||"")
    };
  }
  function gdRememberBrowserRoute(route,replace){
    if(gdBrowserRouteRestoring||!window.history||typeof history.pushState!=="function")return;
    const next=gdBrowserRouteState(route);
    const current=history.state&&typeof history.state==="object"?history.state:{};
    const currentRoute=current[GD_BROWSER_ROUTE_STATE_KEY]?String(current.route||""):"";
    if(
      current[GD_BROWSER_ROUTE_STATE_KEY]&&
      currentRoute===next.route&&
      String(current.backTarget||"")===next.backTarget&&
      String(current.profileReturnProfileId||"")===next.profileReturnProfileId
    )return;
    const leavingHome=currentRoute==="home"&&next.route!=="home"&&next.route!=="auth";
    const method=replace&&!leavingHome?"replaceState":"pushState";
    const url=location.pathname+(location.search||"")+(location.hash||"");
    safe(()=>history[method](Object.assign({},current,next),document.title,url));
  }
  function gdRestoreBrowserBackTarget(state){
    window.__gdBackTarget=String(state?.backTarget||"");
    window.__gdProfileReturnProfileId=String(state?.profileReturnProfileId||"");
    window.__gdProfileReturnName=String(state?.profileReturnName||"");
    setProfileReturnButton();
  }
  function gdShowBrowserAuthGate(){
    gdBrowserRouteRestoring=true;
    try{
      clearProfileReturn();
      window.__gdBackTarget="";
      closeLegacyPanels();
      closeModules();
      hideOverlays();
      clearBody();
      clearGpsSurfaceLocks();
      byId("shellHome")?.classList.add("hidden");
      byId("courseScreen")?.classList.add("hidden");
      showShellChrome(false);
      setDock("");
      setRouteLabel("Profile");
      document.body.classList.add("gdAuthLocked","gdProfileOpen");
      const profile=byId("gdProfileV67");
      if(window.gdOpenProfileV67&&(!profile||profile.classList.contains("hidden")||!/Sign in|Create account|Set password/i.test(profile.textContent||""))){
        safe(()=>window.gdOpenProfileV67({authGate:true}));
      }
      byId("gdProfileV67")?.classList.remove("hidden");
    }finally{
      setTimeout(()=>{gdBrowserRouteRestoring=false;},0);
    }
    return false;
  }
  function gdRestoreBrowserRoute(state){
    const route=String(state?.route||"home");
    /* Only an explicitly recorded auth route reopens the auth screen. This used
       to also fire whenever no account existed, which meant a signed-out player
       pressing Back anywhere in the app was thrown into sign-in - see
       scripts/inline/gd-auth-gate-v1.js for why that is gone. */
    if(route==="auth")return gdShowBrowserAuthGate();
    gdBrowserRouteRestoring=true;
    try{
      gdRestoreBrowserBackTarget(state);
      const target=String(window.__gdBackTarget||"");
      if(route==="home")return forceHomeFallback();
      if(route==="gps")return openGpsStable({replace:true,preserveState:true,fromBack:true});
      if(route==="profile"||route==="profilePanel")return openProfileStable({replace:true,fromGps:target==="gps",fromHome:target!=="gps"});
      if(route==="bag"||route==="bagPanel")return openBagStable({replace:true,fromGps:target==="gps",fromHome:target!=="gps"});
      if(route==="settings"||route==="settingsPanel"||route==="playerSettings"||route==="playerSettingsPanel")return openSettingsStable({replace:true,fromGps:target==="gps",fromHome:target!=="gps"});
      if(route==="dataHubPanel"||route==="shotData")return openDataHub({replace:true});
      if(route==="courseData"||route==="statsPanel")return openCourseData({replace:true});
      if(route==="practiceData"||route==="practiceDataPanel")return openPracticeData({replace:true});
      if(route==="admin"||route==="developer"||route==="developerPanel"){
        if(!gdBrowserAdminAllowed())return forceHomeFallback();
        return openDeveloper({replace:true,fromGps:target==="gps",fromHome:target!=="gps"});
      }
      return forceHomeFallback();
    }finally{
      setTimeout(()=>{gdBrowserRouteRestoring=false;},0);
    }
  }
  function gdBrowserRouteIsHomeVisible(){
    const shell=byId("shellHome");
    const shellVisible=!!shell&&!shell.classList.contains("hidden");
    return document.body.classList.contains("shell-home")||shellVisible;
  }
  function gdKeepHomeOnBrowserBack(){
    safe(()=>clearProfileReturn());
    window.__gdBackTarget="";
    safe(()=>window.GDShell?.showHome?.({source:"browser-back-home",replace:true}));
    safe(()=>restoreHomeSurface());
    safe(()=>showShellChrome(false));
    safe(()=>setDock(""));
    safe(()=>setRouteLabel("Home"));
    if(window.history&&typeof history.replaceState==="function"){
      const current=history.state&&typeof history.state==="object"?history.state:{};
      const homeState=Object.assign({},current,gdBrowserRouteState("home"));
      const url=location.pathname+(location.search||"")+(location.hash||"");
      safe(()=>history.replaceState(homeState,document.title,url));
    }
    return false;
  }
  function gdInstallBrowserRouteBridge(){
    if(gdBrowserRouteInstalled||!window.history||typeof history.replaceState!=="function")return;
    gdBrowserRouteInstalled=true;
    gdRememberBrowserRoute(window.lastShellModule||"home",true);
    window.addEventListener("popstate",event=>{
      const state=event.state&&event.state[GD_BROWSER_ROUTE_STATE_KEY]?event.state:{[GD_BROWSER_ROUTE_STATE_KEY]:true,route:"home"};
      const route=String(state.route||"home");
      if(gdBrowserRouteIsHomeVisible()&&route!=="home"&&route!=="auth"){
        gdKeepHomeOnBrowserBack();
        return;
      }
      gdRestoreBrowserRoute(state);
    });
  }
  function rememberProfileReturn(opts){
    if(!(opts&&opts.fromProfile))return;
    const p=safe(()=>window.GolfDaddyProfiles?.active?.(),null);
    if(!p||!p.id)return;
    window.__gdBackTarget="profile";
    window.__gdProfileReturnProfileId=p.id;
    window.__gdProfileReturnName=p.name||"Profile";
    setProfileReturnButton();
  }
  function returnToProfileWorkspace(){
    const profileId=window.__gdProfileReturnProfileId;
    if(!profileId)return forceHomeFallback();
    safe(()=>window.ClarityRouter?.navigate?.("profile",{replace:true,source:"profile-return",params:{profileId}}));
    closeLegacyPanels();
    closeModules();
    hideOverlays();
    clearBody();
    clearGpsSurfaceLocks();
    byId("shellHome")?.classList.add("hidden");
    safe(()=>window.GDShell?.openModule?.("profile",{source:"profile-return",moduleId:"gdProfileV67",replace:true}));
    safe(()=>window.GolfDaddyAccounts?.viewProfile?.(profileId));
    safe(()=>window.gdOpenProfileV67?.());
    window.__gdBackTarget="profile";
    setDock("");
    setRouteLabel("Profile");
    remember("profilePanel",true);
    setProfileReturnButton();
    return false;
  }
  window.gdReturnToProfileWorkspace=returnToProfileWorkspace;
  function remember(route,replace){
    safe(()=>window.ClarityRouter?.remember?.(route,replace));
    window.shellRouteStack=Array.isArray(window.shellRouteStack)?window.shellRouteStack:["home"];
    if(replace)window.shellRouteStack=[route];
    else if(window.shellRouteStack[window.shellRouteStack.length-1]!==route)window.shellRouteStack.push(route);
    window.lastShellModule=route;
    safe(()=>{
      if(typeof shellRouteStack!=="undefined"){
        if(replace)shellRouteStack=[route];
        else if(shellRouteStack[shellRouteStack.length-1]!==route)shellRouteStack.push(route);
      }
      if(typeof lastShellModule!=="undefined")lastShellModule=route;
    });
    gdRememberBrowserRoute(route,!!replace);
  }
	  function cleanForModule(){
	    closeLegacyPanels();
	    closeModules();
	    hideOverlays();
	    clearBody();
	    clearGpsSurfaceLocks();
		    byId("shellHome")?.classList.add("hidden");
		    safe(()=>window.GDShell?.openModule?.("module",{source:"route-audit-clean-for-module",replace:true}));
	    setTimeout(()=>safe(()=>document.body.classList.remove("gps-open","manual-gps-active")),0);
	    setTimeout(()=>safe(()=>document.body.classList.remove("gps-open","manual-gps-active")),80);
  }
  function cleanForHome(){
	    safe(()=>window.GolfDaddyAccounts?.returnToOwnProfile?.({silent:true}));
	    safe(()=>window.ClaritySession?.sync?.("home"));
	    safe(()=>window.ClarityRouter?.navigate?.("home",{replace:true,source:"home"}));
	    clearRouteBootLocks();
	    clearProfileReturn();
	    window.__gdBackTarget="";
	    closeLegacyPanels();
	    closeModules();
	    hideOverlays();
	    clearBody();
	    clearGpsSurfaceLocks();
	    clearRouteBootLocks();
	    safe(()=>{const h=byId("hint");if(h){h.classList.remove("visible","gdMappedStartPill");h.textContent="";}});
	    safe(()=>{const appEl=byId("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame");});
		    safe(()=>window.GDShell?.showHome?.({source:"route-audit-clean-home",replace:true}));
    restoreHomeSurface();
    showShellChrome(false);
    setDock("");
    setRouteLabel("Home");
    remember("home",true);
		    setTimeout(()=>safe(()=>{clearRouteBootLocks();restoreHomeSurface();window.GDShell?.showHome?.({source:"route-audit-clean-home-late",replace:true});}),80);
  }
	  function openModulePanel(id,label,dock,opts){
		    safe(()=>window.ClarityRouter?.navigate?.(id,{replace:!!(opts&&opts.replace),source:"module-panel",label}));
		    safe(()=>window.GDShell?.openModule?.(id,{source:"route-audit-module-panel",label,dock,replace:!!(opts&&opts.replace)}));
		    const panel=byId(id);
	    if(panel)panel.classList.add("open");
	    else{
	      console.warn("[GolfDaddy] missing module panel",id);
	      return forceHomeFallback();
	    }
	    setDock(dock||"");
	    setRouteLabel(label);
	    document.body.classList.toggle("gdShotDataOpen",!!panel?.classList.contains("gdShotDataPanel"));
	    remember(id,!!(opts&&opts.replace));
	    return false;
	  }
		  function openLegacyPanel(id,label,dock,opts){
		    safe(()=>window.ClarityRouter?.navigate?.(id,{replace:!!(opts&&opts.replace),source:"legacy-panel",label}));
		    safe(()=>window.GDShell?.openModule?.(id,{source:"route-audit-legacy-panel",label,dock,replace:!!(opts&&opts.replace)}));
		    const panel=byId(id);
	    if(panel)panel.classList.add("open");
	    else{
	      console.warn("[GolfDaddy] missing panel",id);
	      return forceHomeFallback();
	    }
	    setDock(dock||"");
	    setRouteLabel(label);
	    remember(label==="Shot Data"?"courseData":id.replace("Panel",""),!!(opts&&opts.replace));
	    return false;
	  }
  function gdPracticeDisplayStore(){
    const api=window.GolfDaddyLaunchMonitorData;
    const store=safe(()=>api?.getDisplayStore?.(),null);
    return Array.isArray(store?.captures)&&store.captures.length?store:null;
  }
  let gdPracticeDisplayHydrationPending=false;
  function gdPracticeHydrateDisplayAnalysis(){
    if(gdPracticeDisplayHydrationPending||typeof gdEnsureLaunchMonitorApi!=="function")return;
    gdPracticeDisplayHydrationPending=true;
    safe(()=>gdEnsureLaunchMonitorApi().then(()=>{
      gdPracticeDisplayHydrationPending=false;
      if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
      if(document.getElementById("practiceDataPanel")?.classList.contains("open"))renderPracticeData(true);
    }).catch(()=>{
      gdPracticeDisplayHydrationPending=false;
    }),null);
  }
  function gdPracticeDisplayAnalysis(opts={}){
    const api=window.GolfDaddyLaunchMonitorData;
    if(typeof api?.analyzeDisplay!=="function"){
      if(!opts.quiet)gdPracticeHydrateDisplayAnalysis();
      return null;
    }
    const analysis=safe(()=>api.analyzeDisplay(),null);
    // Manual Practice is an INPUT ROUTE, not a second analysis: its evidence is
    // already in the library the line above analysed. The only thing left for it
    // to say here is the coach's trusted override, which restates the anchor
    // without re-clustering anything.
    if(!analysis)return analysis;
    return safe(()=>window.GolfDaddyManualPracticeData?.applyTrustedOverride?.(analysis)||analysis,analysis);
  }
  function gdPracticeAnalysisHasRealData(analysis){
    if(Array.isArray(analysis?.acceptedShots)&&analysis.acceptedShots.length)return true;
    if(Array.isArray(analysis?.rejectedShots)&&analysis.rejectedShots.length)return true;
    const totals=analysis?.totals||{};
    if(Number(totals.rawShots)>0||Number(totals.accepted)>0)return true;
    return gdPracticeDisplayShotCount()>0;
  }
  function gdPracticeProjectionReadyAnalysis(analysis=null){
    const next=analysis||gdPracticeDisplayAnalysis();
    if(!next)gdPracticeHydrateDisplayAnalysis();
    return gdPracticeAnalysisHasRealData(next)?next:null;
  }
  function gdPracticePlotAllRowsForTest(){
    return gdPracticePlotMode()==="all";
  }
  // HARD INTAKE GATE: the intake gates decide graph membership. Rejected
  // shots never plot. The mode is pinned to "auto" so no stale localStorage
  // flag can silently reintroduce rejected rows.
  function gdPracticePlotMode(){
    return "auto";
  }
  function gdPracticeSetPlotMode(mode){
    const next=String(mode||"all")==="auto"?"auto":"all";
    try{localStorage.setItem("gd_practice_plot_filter_mode",next);}catch(e){}
    renderPracticeData(true);
    if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    return false;
  }
  function gdTogglePracticePlotAll(force){
    const next=typeof force==="boolean"?force:!gdPracticePlotAllRowsForTest();
    return gdPracticeSetPlotMode(next?"all":"auto");
  }
  function gdPracticePlotExcludedShotMap(){
    try{
      const parsed=JSON.parse(localStorage.getItem("gd_practice_plot_excluded_shots_v1")||"{}");
      return parsed&&typeof parsed==="object"?parsed:{};
    }catch(e){return {};}
  }
  function gdPracticeSavePlotExcludedShotMap(map){
    try{localStorage.setItem("gd_practice_plot_excluded_shots_v1",JSON.stringify(map||{}));}catch(e){}
  }
  function gdPracticeShotDeselectedFromPlot(shot){
    const id=String(shot?.shotId||shot||"").trim();
    if(!id)return false;
    return gdPracticePlotExcludedShotMap()[id]===true;
  }
  function gdPracticeSetSelectedPlotExcluded(exclude=true){
    const ids=Object.keys(gdPracticeEvidenceSelectedShots||{}).filter(Boolean);
    if(!ids.length){
      gdLmToast("Select practice shots first");
      return false;
    }
    const map=gdPracticePlotExcludedShotMap();
    ids.forEach(id=>{
      if(exclude)map[id]=true;
      else delete map[id];
    });
    gdPracticeSavePlotExcludedShotMap(map);
    renderPracticeData(true);
    if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    gdLmToast(exclude?`Deselected ${ids.length} shot${ids.length===1?"":"s"} from plot`:`Restored ${ids.length} shot${ids.length===1?"":"s"} to plot`);
    return false;
  }
  function gdPracticePlotModeControls(){
    if(!gdPracticeAdminIsOpen())return "";
    // Plot mode is hard-gated: intake gates decide graph membership.
    return `<div class="gdPracticePlotMode"><span>Intake gate active — rejected shots never plot.</span></div>`;
  }
  function gdPracticeShotActualDistance(shot){
    const carry=Number(shot?.carryM);
    if(Number.isFinite(carry))return carry;
    const expected=Number(shot?.expectedM);
    const depth=Number(shot?.depthM);
    if(Number.isFinite(expected)&&Number.isFinite(depth))return expected+depth;
    return Number.isFinite(expected)?expected:NaN;
  }
  function gdPracticeChartDataRows(shots){
    return (Array.isArray(shots)?shots:[]).map((shot,index)=>{
      const actual=gdPracticeShotActualDistance(shot);
      const lateral=gdShotChartLateralInfo(shot,actual);
      return {club:shot?.club||"Unknown",actualDistanceM:actual,lateralM:lateral.value,hasLateral:lateral.hasLateral,shot,index};
    }).filter(row=>Number.isFinite(row.actualDistanceM)&&row.actualDistanceM>0);
  }
  const GD_PRACTICE_PROJECTION_SELECTED_CLUB_KEY="gd_practice_projection_selected_club_v1";
  const GD_PRACTICE_BAG_DRAFT_KEY="gd_practice_projection_bag_draft_v1";
	  const GD_PRACTICE_BAG_SCALE_ALL_KEY="gd_practice_projection_bag_scale_all_v1";
	  const GD_PRACTICE_IMPORT_OPEN_KEY="gd_practice_import_open_v1";
	  let gdPracticeBagWidgetExpanded=false;
	  let gdPracticeBagWidgetConfirm=false;
	  let gdPracticeProjectorOpen=false;
	  let gdPracticeProjectionUserTouched=false;
	  let gdPracticeImportOpen=false;
	  let gdPracticeEmailLaneOpen=false;
	  let gdPracticePlotOpen=false;
	  let gdCoachSetBubbleOpen=false;
  let gdPracticeBubbleAdoptionMotion=null;
  let gdPracticeBagSuggestionOpen=false;
  let gdPracticeBagAdaptOpen=false;
  let gdPracticeBagAdaptUndoStack=[];
  const GD_PRACTICE_BAG_SUGGESTION_SEEN_KEY="gd_practice_bag_suggestion_seen_v1";
  try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
  function gdPracticeNormaliseBagRow(row,source="practice-bag"){
    const club=String(row?.club||row?.name||"").trim();
    const carry=Number(row?.actualDistanceM??row?.baseCarry??row?.carry??row?.distance??row?.meters);
    if(!club||!Number.isFinite(carry)||carry<=0)return null;
    return {club,actualDistanceM:Math.max(1,Math.round(carry)),lateralM:0,projectionSource:source};
  }
  function gdPracticeNormaliseBagRows(rows,source="practice-bag"){
    return (Array.isArray(rows)?rows:[]).map(row=>gdPracticeNormaliseBagRow(row,row?.projectionSource||source)).filter(Boolean);
  }
	  function gdPracticeSavedBagRows(){
	    const saved=safe(()=>typeof gdBagSourceRows==="function"?gdBagSourceRows():ensureProfile()?.bag,[])||[];
	    const savedRows=gdPracticeNormaliseBagRows(saved,"player-bag");
	    if(savedRows.length)return savedRows;
	    return [];
	  }
  function gdPracticeLoadBagDraftRows(){
    try{
      const parsed=JSON.parse(localStorage.getItem(GD_PRACTICE_BAG_DRAFT_KEY)||"[]");
      return gdPracticeNormaliseBagRows(parsed,"practice-draft-bag");
    }catch(e){return [];}
  }
  function gdPracticeBagDraftRows(){
    const draft=gdPracticeLoadBagDraftRows();
    return draft.length?draft:gdPracticeSavedBagRows();
  }
  function gdPracticeSaveBagDraftRows(rows){
    const normalised=gdPracticeNormaliseBagRows(rows,"practice-draft-bag");
    try{
      localStorage.setItem(GD_PRACTICE_BAG_DRAFT_KEY,JSON.stringify(normalised.map(row=>({club:row.club,baseCarry:Math.round(Number(row.actualDistanceM)||0)}))));
    }catch(e){}
    return normalised;
  }
  function gdPracticeProjectionBagRows(dataRows){
    const draft=gdPracticeLoadBagDraftRows();
    if(draft.length)return draft.map(row=>Object.assign({projectionSource:"practice-draft-bag"},row));
    return gdShotBubbleOverlayProjectionBagRows(dataRows);
  }
  function gdPracticeBagRowsByClub(rows){
    const map={};
    gdPracticeNormaliseBagRows(rows).forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key)map[key]=row;
    });
    return map;
  }
  function gdPracticeBagDiffRows(rows=gdPracticeBagDraftRows()){
    const saved=gdPracticeBagRowsByClub(gdPracticeSavedBagRows());
    const draft=gdPracticeBagRowsByClub(rows);
    const keys=[...new Set(Object.keys(saved).concat(Object.keys(draft)))];
    return keys.map(key=>{
      const before=saved[key];
      const after=draft[key];
      const club=after?.club||before?.club||key;
      const beforeCarry=before?Math.round(Number(before.actualDistanceM)||0):null;
      const afterCarry=after?Math.round(Number(after.actualDistanceM)||0):null;
      if(beforeCarry===afterCarry)return null;
      const type=before&&!after?"Removed":(!before&&after?"Added":"Changed");
      const delta=(afterCarry||0)-(beforeCarry||0);
      return {club,type,before:beforeCarry,after:afterCarry,delta};
    }).filter(Boolean);
  }
  function gdPracticeDistanceLearningSummary(analysis){
    const ready=gdPracticeProjectionReadyAnalysis(analysis);
    const shots=Array.isArray(ready?.acceptedShots)?ready.acceptedShots:[];
    const groups=new Map();
    shots.forEach(shot=>{
      const club=String(shot?.club||"").trim();
      const carry=Number(shot?.carryM);
      const actual=Number.isFinite(carry)?carry:gdPracticeShotActualDistance(shot);
      if(!club||!Number.isFinite(actual)||actual<=0)return;
      const key=gdShotBubbleOverlayClubKey(club);
      if(!groups.has(key))groups.set(key,{club,values:[]});
      groups.get(key).values.push(actual);
    });
    const currentRows=gdPracticeBagDraftRows();
    const currentByClub=gdPracticeBagRowsByClub(currentRows);
    const nextByClub=Object.assign({},currentByClub);
    const learnings=[];
    groups.forEach(group=>{
      if(group.values.length<3)return;
      const learned=Math.round(gdShotBubbleMedian(group.values));
      if(!Number.isFinite(learned)||learned<=0)return;
      const key=gdShotBubbleOverlayClubKey(group.club);
      const current=nextByClub[key]||gdPracticeNormaliseBagRow({club:group.club,baseCarry:gdShotBubbleSafe(()=>gdDefaultCarryForClub(group.club),learned)},"practice-distance-default");
      const before=Math.round(Number(current?.actualDistanceM)||0);
      const delta=learned-before;
      if(!before||Math.abs(delta)<1)return;
      nextByClub[key]=Object.assign({},current,{club:current.club||group.club,actualDistanceM:learned,projectionSource:"practice-distance-learning"});
      learnings.push({club:current.club||group.club,before,after:learned,delta,count:group.values.length});
    });
    const rows=Object.values(nextByClub).filter(Boolean).sort((a,b)=>Number(b.actualDistanceM||0)-Number(a.actualDistanceM||0));
    const diffs=gdPracticeBagDiffRows(rows);
    const primary=learnings.slice().sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))[0]||null;
    return {rows,diffs,learnings,primary};
  }
  function gdPracticeBagSyncSettings(){
    const cfg=safe(()=>window.GolfDaddyLaunchMonitorData?.settings?.(),null)||safe(()=>dev("launchMonitorCluster"),null)||{};
    const num=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
    return {
      enabled:num(cfg.bagSyncEnabled,1)!==0,
      minDeltaM:Math.max(.1,num(cfg.bagSyncMinDeltaM,.5)),
      minRatio:Math.min(1,Math.max(.2,num(cfg.bagSyncMinRatio,.55))),
      maxRatio:Math.max(1,num(cfg.bagSyncMaxRatio,1.7))
    };
  }
  function gdPracticeRescaleBubbleSourceToCarry(bubble,newCarry){
    if(!bubble||typeof bubble!=="object")return null;
    const sync=gdPracticeBagSyncSettings();
    if(!sync.enabled)return null;
    const next=Number(newCarry);
    const old=Number(bubble.baseDistanceM||bubble.baseCarry||bubble.expectedDistanceM);
    if(!Number.isFinite(next)||next<=0||!Number.isFinite(old)||old<=0)return null;
    if(Math.abs(next-old)<sync.minDeltaM)return null;
    const ratio=Math.min(sync.maxRatio,Math.max(sync.minRatio,next/old));
    const scaled=Object.assign({},bubble);
    ["bubbleWidthM","clusterWidthM","visualWidthM","widthM","bubbleDepthM","clusterDepthM","visualDepthM","depthM","lateralRadiusM","depthRadiusM","radiusM"].forEach(key=>{
      const value=Number(scaled[key]);
      if(Number.isFinite(value)&&value>0)scaled[key]=value*ratio;
    });
    ["expectedDistanceM","meanExpectedM"].forEach(key=>{
      if(Number.isFinite(Number(scaled[key])))scaled[key]=next;
    });
    scaled.baseCarry=next;
    scaled.baseDistanceM=next;
    if(Number.isFinite(Number(scaled.centerDistanceM)))scaled.centerDistanceM=next+(Number(bubble.centerDistanceM)-old)*ratio;
    const offset=Number(scaled.offsetDeg??scaled.faceAlignmentOffsetDeg??scaled.faceOffsetDeg);
    if(Number.isFinite(offset)){
      const aim=Math.tan(offset*Math.PI/180)*next;
      if(scaled.aimOffsetM!==undefined)scaled.aimOffsetM=aim;
      if(scaled.centerLateralM!==undefined)scaled.centerLateralM=aim;
    }
    scaled.distanceSyncedAt=new Date().toISOString();
    return scaled;
  }
  function gdPracticeSyncBubbleSourcesToBag(opts={}){
    const p=safe(()=>ensureProfile(),null);
    if(!p)return false;
    const bagByClub=gdPracticeBagRowsByClub(gdPracticeSavedBagRows());
    const carryFor=club=>{
      const row=bagByClub[gdShotBubbleOverlayClubKey(club)];
      const carry=Number(row?.actualDistanceM);
      return Number.isFinite(carry)&&carry>0?carry:NaN;
    };
    let changed=false;
    const syncBubble=bubble=>{
      const scaled=gdPracticeRescaleBubbleSourceToCarry(bubble,carryFor(bubble?.club));
      if(scaled)changed=true;
      return scaled||bubble;
    };
    if(p.previewBubbleSet)p.previewBubbleSet=syncBubble(p.previewBubbleSet);
    if(p.bubbleProfiles&&typeof p.bubbleProfiles==="object"){
      Object.keys(p.bubbleProfiles).forEach(key=>{p.bubbleProfiles[key]=syncBubble(p.bubbleProfiles[key]);});
    }
    if(p.practiceBubblePendingSource?.bubble){
      const syncedPending=syncBubble(p.practiceBubblePendingSource.bubble);
      if(syncedPending!==p.practiceBubblePendingSource.bubble)p.practiceBubblePendingSource=Object.assign({},p.practiceBubblePendingSource,{bubble:syncedPending});
    }
    if(!changed)return false;
    p.updatedAt=new Date().toISOString();
    savePlayerProfiles();
    syncCoreProfileFromActive();
    if(!opts.skipRender){
      safe(()=>typeof gdRenderBubbleOffsetHub==="function"&&gdRenderBubbleOffsetHub());
      safe(()=>{
        if(document.getElementById("practiceDataPanel")?.classList.contains("open")&&typeof renderPracticeData==="function")renderPracticeData(true);
      });
      safe(()=>{
        if(document.getElementById("dataHubPanel")?.classList.contains("open")&&typeof renderCompareData==="function")renderCompareData();
      });
    }
    return true;
  }
  window.gdPracticeSyncBubbleSourcesToBag=gdPracticeSyncBubbleSourcesToBag;
  function gdPracticeApplyDistanceLearning(analysis,opts={}){
    const summary=gdPracticeDistanceLearningSummary(analysis);
    if(!summary.diffs.length){
      gdPracticeBagWidgetExpanded=false;
      gdPracticeBagWidgetConfirm=false;
      return {changed:false,summary};
    }
    if(opts.commit){
      const bagRows=summary.rows.map(row=>{
        const carry=Math.max(1,Math.round(Number(row.actualDistanceM)||0));
        const total=gdShotBubbleSafe(()=>typeof gdBagTotalForCarry==="function"?gdBagTotalForCarry(row.club,carry):carry,carry);
        return {club:row.club,baseCarry:carry,totalM:Math.max(carry,Math.round(Number(total)||carry))};
      });
      if(typeof gdBagPersistRows==="function")gdBagPersistRows(bagRows,{silent:true,render:false});
      else safe(()=>{
        const profile=ensureProfile();
        profile.bag=bagRows;
        savePlayerProfiles();
        syncCoreProfileFromActive();
      });
      try{localStorage.removeItem(GD_PRACTICE_BAG_DRAFT_KEY);}catch(e){}
      gdPracticeSyncBubbleSourcesToBag({skipRender:true});
      gdPracticeBagWidgetExpanded=false;
      gdPracticeBagWidgetConfirm=false;
      safe(()=>typeof renderBagPanel==="function"&&renderBagPanel());
      safe(()=>typeof renderProfilePanel==="function"&&renderProfilePanel());
      return {changed:true,committed:true,summary};
    }
    gdPracticeSaveBagDraftRows(summary.rows);
    gdPracticeBagWidgetExpanded=true;
    gdPracticeBagWidgetConfirm=false;
    gdPracticeProjectorOpen=true;
    return {changed:true,committed:false,summary};
  }
  function gdPracticeBagDraftDirty(){
    return gdPracticeLoadBagDraftRows().length>0&&gdPracticeBagDiffRows().length>0;
  }
  function gdPracticeProjectionStoredClub(){
    try{return String(localStorage.getItem(GD_PRACTICE_PROJECTION_SELECTED_CLUB_KEY)||"").trim();}
    catch(e){return "";}
  }
  function gdPracticeBagScaleAllEnabled(){
    try{return localStorage.getItem(GD_PRACTICE_BAG_SCALE_ALL_KEY)==="off"?false:true;}
    catch(e){return true;}
  }
  function gdPracticeRefreshProjectionSurfaces(){
    renderPracticeData(true);
    if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    return false;
  }
  function gdPracticeToggleBagWidget(){
    gdPracticeProjectorOpen=true;
    gdPracticeBagWidgetExpanded=!gdPracticeBagWidgetExpanded;
    gdPracticeBagWidgetConfirm=false;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeToggleBagScaleAll(){
    try{localStorage.setItem(GD_PRACTICE_BAG_SCALE_ALL_KEY,gdPracticeBagScaleAllEnabled()?"off":"on");}catch(e){}
    gdPracticeBagWidgetConfirm=false;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticePreviewBagDraft(club,mode){
    const nextMode=String(mode||gdPracticeProjectionMode())==="all"?"all":"selected";
    const selected=String(club||"").trim();
    try{
      if(selected)localStorage.setItem(GD_PRACTICE_PROJECTION_SELECTED_CLUB_KEY,selected);
      localStorage.setItem("gd_practice_projection_mode_v1",nextMode);
    }catch(e){}
    const analysis=gdPracticeProjectionReadyAnalysis();
    window.__gdPracticeProjectionModePending=nextMode;
    try{gdPracticeSetProjectionOverlay(true,analysis);}
    finally{delete window.__gdPracticeProjectionModePending;}
    if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    return false;
  }
  function gdPracticeSetProjectionSelectedClub(club){
    return gdPracticePreviewBagDraft(club,"selected");
  }
  function gdPracticeSetBagCarry(club,rawValue){
    const key=gdShotBubbleOverlayClubKey(club);
    const nextCarry=Math.round(Number(rawValue));
    if(!key||!Number.isFinite(nextCarry)||nextCarry<=0){
      gdLmToast("Enter a carry distance");
      return gdPracticeRefreshProjectionSurfaces();
    }
    const rows=gdPracticeBagDraftRows();
    const target=rows.find(row=>gdShotBubbleOverlayClubKey(row.club)===key);
    if(!target)return false;
    const oldCarry=Number(target.actualDistanceM);
    const scaleAll=gdPracticeBagScaleAllEnabled()&&Number.isFinite(oldCarry)&&oldCarry>0;
    const ratio=scaleAll?nextCarry/oldCarry:1;
    const updated=rows.map(row=>{
      const rowKey=gdShotBubbleOverlayClubKey(row.club);
      const carry=scaleAll?Math.max(1,Math.round((Number(row.actualDistanceM)||0)*ratio)):(rowKey===key?nextCarry:row.actualDistanceM);
      return Object.assign({},row,{actualDistanceM:carry,projectionSource:"practice-draft-bag"});
    });
    gdPracticeSaveBagDraftRows(updated);
    gdPracticeBagWidgetConfirm=false;
    return gdPracticePreviewBagDraft(target.club,scaleAll?"all":"selected");
  }
  function gdPracticeResetBagDraft(){
    try{localStorage.removeItem(GD_PRACTICE_BAG_DRAFT_KEY);}catch(e){}
    gdPracticeBagWidgetConfirm=false;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeCommitBagDraft(){
    const draft=gdPracticeLoadBagDraftRows();
    const diffs=gdPracticeBagDiffRows(draft);
    if(!draft.length||!diffs.length){
      gdLmToast("No bag changes");
      return false;
    }
    if(!gdPracticeBagWidgetConfirm){
      gdPracticeBagWidgetConfirm=true;
      return gdPracticeRefreshProjectionSurfaces();
    }
    const bagRows=draft.map(row=>{
      const carry=Math.max(1,Math.round(Number(row.actualDistanceM)||0));
      const total=gdShotBubbleSafe(()=>typeof gdBagTotalForCarry==="function"?gdBagTotalForCarry(row.club,carry):carry,carry);
      return {club:row.club,baseCarry:carry,totalM:Math.max(carry,Math.round(Number(total)||carry))};
    });
    if(typeof gdBagPersistRows==="function")gdBagPersistRows(bagRows,{silent:true,render:false});
    else safe(()=>{
      const profile=ensureProfile();
      profile.bag=bagRows;
      if(typeof savePlayerProfiles==="function")savePlayerProfiles();
      if(typeof syncCoreProfileFromActive==="function")syncCoreProfileFromActive();
    });
    try{localStorage.removeItem(GD_PRACTICE_BAG_DRAFT_KEY);}catch(e){}
    gdPracticeBagWidgetConfirm=false;
    safe(()=>typeof renderBagPanel==="function"&&renderBagPanel());
    safe(()=>typeof renderProfilePanel==="function"&&renderProfilePanel());
    safe(()=>typeof renderShot==="function"&&renderShot());
    gdLmToast("Bag saved");
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeBagDiffHTML(diffs){
    if(!diffs.length)return `<div class="gdPracticeBagEmpty">No changes</div>`;
    return `<div class="gdPracticeBagDiffList">${diffs.map(diff=>{
      const before=diff.before==null?"--":`${diff.before}m`;
      const after=diff.after==null?"--":`${diff.after}m`;
      const delta=diff.delta>0?`+${diff.delta}m`:`${diff.delta}m`;
      return `<div class="gdPracticeBagDiff"><span>${gdEscapeHTML(diff.type)}</span><strong>${gdEscapeHTML(diff.club)}</strong><small>${before} -> ${after} - ${delta}</small></div>`;
    }).join("")}</div>`;
  }
  function gdPracticeBagWidgetHTML(analysis,ctx){
    if(!gdPracticeBagWidgetExpanded)return "";
    const rows=gdPracticeBagDraftRows();
    const dirty=gdPracticeBagDraftDirty();
    const diffs=gdPracticeBagDiffRows(rows);
    const confirm=gdPracticeBagWidgetConfirm&&dirty;
    const scaleAll=gdPracticeBagScaleAllEnabled();
    const selectedKey=gdShotBubbleOverlayClubKey(gdPracticeProjectionStoredClub()||gdPracticeProjectionSelectedClubNames(analysis,ctx?.dataRows||[])[0]||"");
    const body=confirm?gdPracticeBagDiffHTML(diffs):`<div class="gdPracticeBagRows">${rows.map(row=>{
      const club=String(row.club||"");
      const key=gdShotBubbleOverlayClubKey(club);
      const active=key&&key===selectedKey;
      return `<div class="gdPracticeBagRow ${active?"active":""}"><button type="button" aria-pressed="${active?"true":"false"}" data-gd-practice-bag-club="${gdEscapeHTML(club)}">${gdEscapeHTML(club)}</button><input type="number" inputmode="numeric" min="1" step="1" value="${Math.round(Number(row.actualDistanceM)||0)}" aria-label="${gdEscapeHTML(club)} carry" data-gd-practice-bag-carry="${gdEscapeHTML(club)}"><span>m</span></div>`;
    }).join("")}</div>`;
    const meta=dirty?`${diffs.length} unsaved`:`${rows.length} clubs`;
    return `<div class="gdPracticeBagWidget ${dirty?"dirty":""} ${confirm?"confirm":""}"><div class="gdPracticeBagWidgetHead"><div class="gdPracticeBagWidgetTitle"><strong>Bag widget</strong><span>${gdEscapeHTML(meta)}</span></div><button type="button" class="gdPracticeBagScaleButton ${scaleAll?"active":""}" aria-pressed="${scaleAll?"true":"false"}" data-gd-practice-bag-action="scale">Scale all</button></div>${body}<div class="gdPracticeBagWidgetActions">${confirm?`<button type="button" data-gd-practice-bag-action="back">Back</button><button type="button" class="active" data-gd-practice-bag-action="save">Confirm save</button>`:`<button type="button" ${dirty?"":"disabled"} data-gd-practice-bag-action="reset">Reset</button><button type="button" class="${dirty?"active":""}" ${dirty?"":"disabled"} data-gd-practice-bag-action="save">Review save</button>`}</div></div>`;
  }
  function gdPracticeProjectionContext(analysis){
    const readyAnalysis=gdPracticeProjectionReadyAnalysis(analysis);
    const hasRealPracticeData=!!readyAnalysis;
    const shots=gdPracticePlotShots(readyAnalysis||{});
    const dataRows=gdPracticeChartDataRows(shots);
    const offset=gdPracticeBubbleOffsetDeg(readyAnalysis);
    const overlayRows=hasRealPracticeData&&gdPracticeHasBubbleOffset(offset)?gdPracticeProjectionRows(dataRows,readyAnalysis):[];
    const hubRows=hasRealPracticeData?gdPracticeOffsetHubRows(dataRows,readyAnalysis):[];
    return {
      shots,
      dataRows,
      offset,
      overlayRows,
      hubRows,
      hasRealPracticeData,
      canProject:hasRealPracticeData&&gdPracticeHasBubbleOffset(offset)&&overlayRows.length>0,
      visible:gdShotBubbleOverlayEnabled("practice")
    };
  }
  function gdPracticeProjectionStatusText(analysis,ctx){
    const context=ctx||gdPracticeProjectionContext(analysis);
    if(!context.hasRealPracticeData)return "Waiting for practice shots.";
    if(!context.canProject)return "Clarity Pattern Finder needs more shots.";
    const mode=gdPracticeProjectionMode();
    const selected=gdPracticeProjectionSelectedClubNames(analysis,context.dataRows);
    const target=mode==="all"?`${context.overlayRows.length} clubs`:(selected.length?selected.join(", "):"selected clubs");
    return `${context.visible?"Showing":"Available"}: ${target}`;
  }
  function gdPracticeProjectionMode(){
    try{
      if(window.__gdPracticeProjectionModePending==="all"||window.__gdPracticeProjectionModePending==="selected")return window.__gdPracticeProjectionModePending;
      const stored=localStorage.getItem("gd_practice_projection_mode_v1")==="all"?"all":"selected";
      return stored==="all"&&gdShotBubbleOverlayEnabled("practice")?"all":"selected";
    }
    catch(e){return "selected";}
  }
	  function gdPracticeSetProjectionOverlay(enabled,analysis,opts={}){
	    if(!opts.auto)gdPracticeProjectionUserTouched=true;
	    if(!enabled&&gdPracticeProjectionMode()==="all"){
	      try{localStorage.setItem("gd_practice_projection_mode_v1","selected");}catch(e){}
	    }
    const readyAnalysis=gdPracticeProjectionReadyAnalysis(analysis);
    const ctx=gdPracticeProjectionContext(readyAnalysis);
    const next=!!enabled&&ctx.canProject;
    gdShotBubbleOverlayState.practice=next;
    window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
    document.documentElement.dataset.gdOverlayPractice=next?"on":"off";
    if(enabled&&!ctx.canProject)gdShotBubbleSafe(()=>typeof gdLmToast==="function"&&gdLmToast("Practice Bubble needed before projection"));
    gdPracticeRefreshProjectionSurfaces();
	    setTimeout(()=>gdSyncShotBubbleOverlayControls("practice"),0);
	    return false;
	  }
	  function gdPracticeMaybeAutoShowProjection(analysis){
	    if(gdPracticeProjectionUserTouched)return false;
	    const ctx=gdPracticeProjectionContext(analysis);
	    if(!ctx.canProject||ctx.visible)return false;
	    gdShotBubbleOverlayState.practice=true;
	    window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
	    document.documentElement.dataset.gdOverlayPractice="on";
	    setTimeout(()=>gdSyncShotBubbleOverlayControls("practice"),0);
	    return true;
	  }
  function gdPracticeToggleProjectionOverlay(){
    return gdPracticeSetProjectionOverlay(!gdShotBubbleOverlayEnabled("practice"));
  }
  function gdPracticeSetProjectionMode(mode){
    const next=String(mode||"all")==="selected"?"selected":"all";
    const current=gdPracticeProjectionMode();
    const wasVisible=gdShotBubbleOverlayEnabled("practice");
    gdPracticeProjectorOpen=false;
    if(next===current&&wasVisible){
      gdPracticeSetProjectionOverlay(false,gdPracticeProjectionReadyAnalysis());
      if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
      return false;
    }
    try{localStorage.setItem("gd_practice_projection_mode_v1",next);}catch(e){}
    const analysis=gdPracticeProjectionReadyAnalysis();
    window.__gdPracticeProjectionModePending=next;
    let ctx;
    try{ctx=gdPracticeProjectionContext(analysis);}
    finally{delete window.__gdPracticeProjectionModePending;}
    if(ctx.canProject)gdPracticeSetProjectionOverlay(true,analysis);
    else gdPracticeSetProjectionOverlay(false,analysis);
    if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    return false;
  }
  function gdPracticeToggleProjector(force){
    gdPracticeProjectorOpen=typeof force==="boolean"?force:!gdPracticeProjectorOpen;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeProjectorSummary(analysis,ctx){
    return ctx?.hasRealPracticeData&&ctx?.canProject?"Bubble ready":"Bubble not ready";
  }
  function gdRenderPracticeImportPanel(){
    const panel=document.getElementById("gdPracticeImportPanel");
    if(!panel)return;
    if(typeof gdPracticeAdminIsOpen==="function"&&!gdPracticeAdminIsOpen()){
      const drawer=document.getElementById("gdNativePracticeImportDrawer");
      if(drawer)drawer.open=false;
    }
    panel.classList.toggle("open",!!gdPracticeImportOpen);
    panel.classList.toggle("email-open",!!gdPracticeEmailLaneOpen);
    panel.classList.toggle("plot-open",!!gdPracticePlotOpen);
    panel.classList.toggle("coachSet-open",!!gdCoachSetBubbleOpen);
    const button=panel.querySelector(".gdPracticeImportToggle");
    if(button)button.setAttribute("aria-expanded",gdPracticeImportOpen?"true":"false");
    const coachSetVisible=gdCoachSetIsCoachViewingPlayer();
    const coachSetBtn=panel.querySelector(".gdCoachSetIconButton");
    if(coachSetBtn)coachSetBtn.hidden=!coachSetVisible;
    if(!coachSetVisible&&gdCoachSetBubbleOpen){gdCoachSetBubbleOpen=false;panel.classList.remove("coachSet-open");}
    const coachSetPanel=document.getElementById("gdCoachSetBubblePanel");
    if(coachSetPanel)coachSetPanel.hidden=!gdCoachSetBubbleOpen;
    if(gdCoachSetBubbleOpen)gdRenderCoachSetBubblePanel();
    gdRenderPracticeEmailLane();
  }
  function gdPracticeQuietPostImportSurface(){
    gdPracticeImportOpen=false;
    gdPracticeEmailLaneOpen=false;
    try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
    try{gdSetShotDataLibraryOpen("practice",true);}catch(e){}
    try{
      if(typeof gdPracticeImportSelectMode!=="undefined")gdPracticeImportSelectMode=false;
      if(typeof gdPracticeImportSelected!=="undefined")Object.keys(gdPracticeImportSelected).forEach(id=>delete gdPracticeImportSelected[id]);
    }catch(e){}
    const practicePanel=byId("practiceDataPanel");
    practicePanel?.classList.remove("gdPracticeAdminExpanded");
    try{gdPracticeQuietScanSurface({clearStatus:true});}catch(e){}
    const feedback=byId("gdNativePracticeFeedback");
    if(feedback)feedback.innerHTML="";
    gdRenderPracticeImportPanel();
    gdRenderPracticeAdminChrome();
  }
  let gdPracticeEmailLaneState={address:"",playerKey:"",status:"Address generated locally",configured:false,batches:[],loading:false,error:""};
  function gdPracticeEmailSlug(value,fallback="player"){
    const raw=String(value||fallback||"player").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
    return raw||fallback||"player";
  }
  function gdPracticeEmailIdentity(){
    const profile=safe(()=>typeof ensureProfile==="function"?ensureProfile():null,null)||{};
    const session=safe(()=>window.ClaritySession&&typeof window.ClaritySession.get==="function"?window.ClaritySession.get():null,null)||{};
    return {
      profileId:profile.id||session.profileId||"",
      accountId:session.accountId||"",
      email:profile.email||session.email||"",
      name:profile.name||session.accountName||"player",
      // The key the server files this player's mail under. Sent with sender
      // approval so the server scopes the change to the same player the lane is
      // showing, not to whatever it would derive on its own.
      playerKey:gdPracticeEmailLaneState?.playerKey||""
    };
  }
  /* There is no local guess any more. The address is ALLOCATED and stored by the
     server - name-based, with a number only when a name is already taken - so
     nothing here can work it out. Printing a derived practice+<id> address as a
     stand-in would show the player an address that does not receive mail, which
     is worse than saying we could not fetch it. */
  const GD_PRACTICE_EMAIL_UNKNOWN="Not issued yet - refresh to fetch it";
  function gdPracticeEmailAddressLocal(){
    return GD_PRACTICE_EMAIL_UNKNOWN;
  }
  function gdPracticeEmailAddressIsKnown(value){
    return !!String(value||"").includes("@");
  }
  function gdPracticeEmailQuery(identity){
    const id=identity||gdPracticeEmailIdentity();
    const params=new URLSearchParams();
    if(id.profileId)params.set("profileId",id.profileId);
    if(id.accountId)params.set("accountId",id.accountId);
    if(id.email)params.set("email",id.email);
    if(id.name)params.set("name",id.name);
    params.set("includeRecent","1");
    return params;
  }
  function gdPracticeEmailMetricValue(metrics,key){
    return metrics&&Object.prototype.hasOwnProperty.call(metrics,key)?metrics[key]:null;
  }
  function gdPracticeEmailShotToNative(row,batch){
    const metrics=row?.metrics_json||{};
    const errors=Array.isArray(row?.errors_json)?row.errors_json:[];
    const warnings=Array.isArray(row?.warnings_json)?row.warnings_json:[];
    return {
      shotId:row?.shot_id||`practice-email-shot-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      sessionId:row?.session_id||batch?.session_id||"",
      playerId:row?.player_id||batch?.player_id||batch?.player_key||"",
      playerName:row?.player_name||batch?.player_name||"Player",
      accountId:row?.account_id||batch?.account_id||"",
      club:row?.club||"",
      shotNumber:Number.isFinite(Number(row?.shot_number))?Number(row.shot_number):null,
      ballSpeed:gdPracticeEmailMetricValue(metrics,"ballSpeed"),
      clubSpeed:gdPracticeEmailMetricValue(metrics,"clubSpeed"),
      launchAngle:gdPracticeEmailMetricValue(metrics,"launchAngle"),
      spin:gdPracticeEmailMetricValue(metrics,"spin"),
      carryDistance:gdPracticeEmailMetricValue(metrics,"carryDistance"),
      totalDistance:gdPracticeEmailMetricValue(metrics,"totalDistance"),
      offlineDistance:gdPracticeEmailMetricValue(metrics,"offlineDistance"),
      side:gdPracticeEmailMetricValue(metrics,"side")||"",
      faceAngle:gdPracticeEmailMetricValue(metrics,"faceAngle"),
      pathAngle:gdPracticeEmailMetricValue(metrics,"pathAngle"),
      faceToPath:gdPracticeEmailMetricValue(metrics,"faceToPath"),
      startDirection:gdPracticeEmailMetricValue(metrics,"startDirection"),
      curve:gdPracticeEmailMetricValue(metrics,"curve"),
      targetLine:gdPracticeEmailMetricValue(metrics,"targetLine")||"",
      sideSpin:gdPracticeEmailMetricValue(metrics,"sideSpin"),
      totalSpin:gdPracticeEmailMetricValue(metrics,"totalSpin"),
      backspin:gdPracticeEmailMetricValue(metrics,"backspin"),
      spinAxis:gdPracticeEmailMetricValue(metrics,"spinAxis"),
      rawSource:row?.raw_source_json||null,
      derivedMetrics:metrics?.derivedMetrics||null,
      sourceType:row?.source_type||batch?.source_type||"email_csv",
      importBatchId:row?.import_batch_id||batch?.import_batch_id||"",
      status:errors.length?"native_invalid":"native_valid",
      schemaVersion:Number(row?.schema_version)||1,
      createdAt:row?.created_at||batch?.created_at||new Date().toISOString(),
      updatedAt:row?.updated_at||batch?.updated_at||new Date().toISOString(),
      errors,
      warnings,
      unknownFields:row?.unknown_fields_json||{}
    };
  }
  function gdPracticeEmailBatchLabel(batch){
    const source=batch?.source_name||batch?.source_type||"Practice email";
    const valid=Number(batch?.valid_count)||0;
    const invalid=Number(batch?.invalid_count)||0;
    return `${source} · ${valid} valid${invalid?` · ${invalid} flags`:""}`;
  }
  function gdPracticeEmailBatchesHTML(){
    const state=gdPracticeEmailLaneState||{};
    if(state.loading)return `<div class="gdPracticeEmailRecent"><span>Checking receiver...</span></div>`;
    if(state.error)return `<div class="gdPracticeEmailRecent warn"><span>${gdEscapeHTML(state.error)}</span></div>`;
    const batches=Array.isArray(state.batches)?state.batches:[];
    if(!batches.length)return "";
    return `<div class="gdPracticeEmailRecent">${batches.slice(0,5).map(batch=>{
      const id=batch.import_batch_id||"";
      // The import came in either way. When it came from a sender the player has
      // not approved it is marked, with an approve button beside it, so the
      // choice is theirs: say yes to that sender once, or delete the import.
      const unapproved=batch.metadata?.senderVerified===false;
      const senderEmail=String(batch.metadata?.from||"").trim();
      const flag=unapproved
        ? `<button type="button" class="gdPracticeEmailFlag" onclick="return gdPracticeApproveEmailSender(${gdEscapeHTML(JSON.stringify(senderEmail))},${gdEscapeHTML(JSON.stringify(batch.intake_id||""))})" title="${gdEscapeHTML(senderEmail||"Unknown sender")} is not on your approved list">Approve ${gdEscapeHTML(senderEmail||"sender")}</button>`
        : "";
      if(batch.source_type==="email_photo"){
        const photoCount=Array.isArray(batch.photos)?batch.photos.length:0;
        const label=`${batch.source_name||"Practice email photo"} · ${photoCount} photo${photoCount===1?"":"s"}`;
        return `<div class="gdPracticeEmailRow${unapproved?" unapproved":""}"><button type="button" onclick="return gdPracticeLoadEmailPhotoBatch(${gdEscapeHTML(JSON.stringify(id))})"><span>${unapproved?"⚑ ":""}${gdEscapeHTML(label)}</span><b>Scan</b></button>${flag}</div>`;
      }
      const label=gdPracticeEmailBatchLabel(batch);
      /* No button. A CSV from an approved sender is already in the library by
         the time this renders, so the row reports what happened rather than
         offering an action that has nothing left to do. */
      const state=unapproved
        ? "waiting for you to approve the sender"
        : (gdPracticeEmailBatchInLibrary(id)
          ? `${Number(batch.valid_count)||0} shot${Number(batch.valid_count)===1?"":"s"} imported`
          : (Number(batch.valid_count) ? "could not be imported" : "no readable rows"));
      return `<div class="gdPracticeEmailRow${unapproved?" unapproved":""}"><div class="gdPracticeEmailRowMain"><span>${unapproved?"⚑ ":""}${gdEscapeHTML(label)}</span><b>${gdEscapeHTML(state)}</b></div>${flag}</div>`;
    }).join("")}</div>`;
  }
  function gdRenderPracticeEmailLane(){
    const root=document.getElementById("gdPracticeEmailBox");
    if(!root)return;
    if(!gdPracticeEmailLaneOpen){
      root.hidden=true;
      root.classList.remove("active");
      root.innerHTML="";
      return;
    }
    root.hidden=false;
    root.classList.add("active");
    const identity=gdPracticeEmailIdentity();
    const address=gdPracticeEmailLaneState.address||gdPracticeEmailAddressLocal(identity);
    const status=gdPracticeEmailLaneState.status||"Address generated locally";
    root.innerHTML=`<div class="gdPracticeEmailHead"><div><strong>Email receiver</strong><span>${gdEscapeHTML(status)}</span></div><div class="gdPracticeEmailActions"><button type="button" onclick="return gdPracticeRefreshEmailLane()">Refresh</button><button type="button" onclick="return gdPracticeCopyEmailAddress()">Copy</button></div></div><div class="gdPracticeEmailAddress">${gdEscapeHTML(address)}</div>${gdPracticeEmailBatchesHTML()}`;
  }
  async function gdPracticeApproveEmailSender(sender,intakeId){
    const auth=window.ClaritySupabaseAuth;
    const token=await safe(()=>typeof auth?.freshAccessToken==="function"?auth.freshAccessToken():"",null)||"";
    if(!token){
      gdLmToast("Sign in to approve a sender");
      return false;
    }
    const identity=gdPracticeEmailIdentity();
    try{
      const response=await fetch("/api/practice-email-intake",{
        method:"POST",
        headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},
        body:JSON.stringify({action:"approve_sender",sender,intakeId,playerKey:identity.playerKey,profileId:identity.profileId,accountId:identity.accountId})
      });
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body?.approved)throw new Error(body?.error||`HTTP ${response.status}`);
      gdLmToast(`${sender} approved - their imports will stop being flagged`);
      return gdPracticeRefreshEmailLane();
    }catch(e){
      gdLmToast(e&&e.message?`Could not approve sender: ${e.message}`:"Could not approve sender");
      return false;
    }
  }
  function gdPracticeCopyEmailAddress(){
    const address=gdPracticeEmailLaneState.address||"";
    if(!gdPracticeEmailAddressIsKnown(address)){
      gdLmToast("No address to copy yet - refresh the receiver");
      return false;
    }
    safe(()=>navigator?.clipboard?.writeText?.(address),null);
    gdLmToast("Practice email address copied");
    return false;
  }
  async function gdPracticeRefreshEmailLane(){
    const identity=gdPracticeEmailIdentity();
    gdPracticeEmailLaneState=Object.assign({},gdPracticeEmailLaneState,{address:gdPracticeEmailLaneState.address||gdPracticeEmailAddressLocal(identity),loading:true,error:"",status:"Checking receiver..."});
    gdRenderPracticeEmailLane();
    try{
      const response=await fetch(`/api/practice-email-intake?${gdPracticeEmailQuery(identity).toString()}`,{cache:"no-store"});
      const body=await response.json().catch(()=>null);
      if(!response.ok||!body)throw new Error(body?.error||`HTTP ${response.status}`);
      gdPracticeEmailLaneState={
        address:body.address||gdPracticeEmailAddressLocal(identity),
        playerKey:body.playerKey||gdPracticeEmailSlug(identity.profileId||identity.accountId||identity.email||identity.name,"player"),
        status:body.configured?"Player-specific practice intake address":"Receiver address ready - storage not configured",
        configured:!!body.configured,
        batches:body.recent?.batches||[],
        loading:false,
        error:""
      };
    }catch(e){
      gdPracticeEmailLaneState=Object.assign({},gdPracticeEmailLaneState,{
        address:gdPracticeEmailLaneState.address||gdPracticeEmailAddressLocal(),
        status:"Could not reach the receiver",
        loading:false,
        error:e&&e.message?`Receiver check failed: ${e.message}`:"Receiver check failed"
      });
    }
    /* Import before the render, so the lane paints its final state once rather
       than showing every batch as pending and then correcting itself. */
    safe(()=>gdPracticeAutoImportEmailBatches(),null);
    gdRenderPracticeEmailLane();
    return false;
  }
  /* An emailed batch, in the shape the library bridge already understands.
     Pure - it decides nothing about whether the batch should be imported. */
  function gdPracticeEmailBatchToPreview(batch){
    const rows=(Array.isArray(batch?.shots)?batch.shots:[]).map(row=>gdPracticeEmailShotToNative(row,batch));
    if(!rows.length)return null;
    const valid=rows.filter(row=>!row.errors?.length).length;
    return {
      preview:{
        batch:{
          importBatchId:batch.import_batch_id,
          sessionId:batch.session_id,
          sourceType:batch.source_type||"email_csv",
          sourceName:batch.source_name||"Practice email",
          // Provenance the server already established when it parsed the
          // attachment. Without it an emailed yard file reaches the library as if
          // it were metres, while the same file uploaded from the phone converts.
          provider:batch.provider||"",
          unitSystem:batch.unit_system||null,
          unitHints:batch.metadata?.unitHints||{},
          sessionDate:batch.session_date||null,
          rowCount:rows.length,
          validCount:valid,
          invalidCount:rows.length-valid,
          createdAt:batch.created_at||new Date().toISOString(),
          updatedAt:batch.updated_at||new Date().toISOString()
        },
        session:{
          sessionId:batch.session_id,
          importBatchId:batch.import_batch_id,
          playerId:batch.player_id||batch.player_key||"",
          playerName:batch.player_name||"Player",
          accountId:batch.account_id||"",
          sourceType:batch.source_type||"email_csv",
          sourceName:batch.source_name||"Practice email",
          shotCount:rows.length,
          createdAt:batch.created_at||new Date().toISOString(),
          updatedAt:batch.updated_at||new Date().toISOString()
        },
        rows
      },
      valid,
      invalid:rows.length-valid
    };
  }
  /* Has this batch already been through the library? Deleted records count as
     yes: the id stays on the soft-deleted rows, so a batch the player threw
     away does not come back on the next refresh. */
  function gdPracticeEmailBatchInLibrary(importBatchId){
    const id=String(importBatchId||"").trim();
    if(!id)return false;
    const lm=window.GolfDaddyLaunchMonitorData;
    const store=safe(()=>typeof lm?.getScopedStore==="function"?lm.getScopedStore():lm?.getStore?.(),null)||{};
    return ["sessions","captures","shots"].some(key=>
      (Array.isArray(store[key])?store[key]:[]).some(record=>String(record?.importBatchId||record?.importId||"").trim()===id));
  }
  /* Mail from a sender the player approved goes straight in. An unapproved
     sender still lands and is still shown, flagged, with an Approve button -
     approving it refreshes the lane, which brings it back through here. */
  function gdPracticeEmailBatchAutoImportable(batch){
    if(!batch||batch.source_type==="email_photo")return false;
    if(String(batch.status||"")!=="staged")return false;
    if(batch.metadata?.senderVerified===false)return false;
    if(!Number(batch.valid_count))return false;
    return !gdPracticeEmailBatchInLibrary(batch.import_batch_id);
  }
  function gdPracticeAutoImportEmailBatches(){
    const batches=Array.isArray(gdPracticeEmailLaneState?.batches)?gdPracticeEmailLaneState.batches:[];
    let importedBatches=0,importedShots=0;
    // Oldest first, so a session imported today does not sort above one from
    // last week purely because of the order the lane happened to return them.
    batches.slice().reverse().forEach(batch=>{
      if(!gdPracticeEmailBatchAutoImportable(batch))return;
      const built=gdPracticeEmailBatchToPreview(batch);
      if(!built||!built.valid)return;
      try{
        const bridged=gdBridgeNativePracticeToLaunchMonitor(built.preview);
        const saved=Array.isArray(bridged?.shots)?bridged.shots.length:0;
        if(!saved)return;
        importedBatches+=1;
        importedShots+=saved;
      }catch(e){
        gdNativePracticeFeedbackPatch({
          status:"failed",
          lastAction:"Email auto-import failed",
          errors:[e&&e.message?e.message:"Could not import an emailed batch"],
          nextStep:"Refresh the email receiver to try again."
        });
      }
    });
    if(importedBatches){
      gdLmToast(`Imported ${importedShots} shot${importedShots===1?"":"s"} from ${importedBatches} email${importedBatches===1?"":"s"}`);
      try{gdRenderShotDataPanel?.();}catch(e){}
      try{gdRenderPracticeDataVisual?.();}catch(e){}
    }
    return {batches:importedBatches,shots:importedShots};
  }
  async function gdPracticeLoadEmailPhotoBatch(importBatchId){
    const batches=Array.isArray(gdPracticeEmailLaneState?.batches)?gdPracticeEmailLaneState.batches:[];
    const batch=batches.find(item=>String(item?.import_batch_id||"")===String(importBatchId||""));
    const photo=batch&&Array.isArray(batch.photos)?batch.photos[0]:null;
    if(!batch||!photo||!photo.url){
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Email photo missing",errors:["Staged email photo was not found or the link expired"],nextStep:"Refresh the email receiver and try again."});
      gdLmToast("Email photo not available - refresh and try again");
      return false;
    }
    gdPracticeFeedback("Loading photo from email...");
    try{
      const response=await fetch(photo.url,{cache:"no-store"});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const blob=await response.blob();
      const file=new File([blob],photo.filename||"practice-email-photo.jpg",{type:photo.contentType||blob.type||"image/jpeg"});
      gdPracticeEmailLaneOpen=false;
      gdRenderPracticeEmailLane();
      await gdHandleLaunchMonitorPhoto(file);
    }catch(e){
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Email photo load failed",errors:[e&&e.message?e.message:"Could not load photo"],nextStep:"Refresh the email receiver and try again."});
      gdPracticeFeedback(`Could not load the emailed photo: ${e&&e.message?e.message:e}`,"error");
    }
    return false;
  }
  function gdPracticeEmailImportPending(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    gdPracticeImportOpen=false;
    gdPracticeEmailLaneOpen=true;
    try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
    gdRenderPracticeImportPanel();
    gdNativePracticeFeedbackPatch({
      status:"waiting",
      lastAction:"Email import selected",
      warnings:[],
      errors:[],
      nextStep:"Copy the receiver address or load a staged email batch into native review."
    });
    gdPracticeRefreshEmailLane();
    gdLmToast("Practice email receiver ready");
    return false;
  }
  function gdTogglePracticePlot(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    gdPracticePlotOpen=!gdPracticePlotOpen;
    gdPracticeImportOpen=false;
    gdPracticeEmailLaneOpen=false;
    gdCoachSetBubbleOpen=false;
    try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
    gdRenderPracticeImportPanel();
    return false;
  }
  function gdCoachSetIsCoachViewingPlayer(){
    return safe(()=>{
      const account=window.GolfDaddyAccounts?.current?.();
      if(!account)return false;
      const role=String(account.role||"player").toLowerCase();
      if(role!=="coach"&&role!=="admin")return false;
      const viewingId=window.GD_ACCOUNT_STATE?.viewingProfileId;
      return !!(viewingId&&viewingId!==account.profileId);
    },false);
  }
  function gdToggleCoachSetBubble(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    if(!gdCoachSetIsCoachViewingPlayer()){
      // This gate is re-checked here, not just at render time when the
      // button was made visible - if the two disagree (viewingProfileId
      // reset back to the coach's own profile in between), the button used
      // to sit there looking clickable and do nothing. Surface that instead
      // of failing silently.
      gdLmToast("Coach Set needs you to be viewing a player, not your own profile");
      return false;
    }
    try{
      gdCoachSetBubbleOpen=!gdCoachSetBubbleOpen;
      gdPracticeImportOpen=false;
      gdPracticeEmailLaneOpen=false;
      gdPracticePlotOpen=false;
      try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
      if(gdCoachSetBubbleOpen){
        gdCoachSetLiveOffsetDeg=0;
        gdCoachSetLiveDistanceM=null;
        gdCoachSetPreviewOn=false;
        gdCoachSetDragState=null;
        const select=document.getElementById("gdCoachSetClub");
        if(select)delete select.dataset.gdPopulated;
        const previewBtn=document.getElementById("gdCoachSetPreviewBtn");
        if(previewBtn)previewBtn.classList.remove("active");
        safe(()=>{
          const {p}=gdBubbleDataContext();
          gdCoachSetDiscardStalePending(p);
          gdCoachSetRevertLiveBag(p);
        });
      }
      gdRenderPracticeImportPanel();
      if(gdCoachSetBubbleOpen)gdRenderCoachSetBubblePanel();
    }catch(e){
      console.error("[GolfDaddy] Coach Set failed to open",e);
      gdLmToast("Coach Set could not open - see console");
    }
    return false;
  }
  const GD_COACH_SET_REFERENCE_CLUBS=["PW","7i","4i","Driver"];
  const GD_COACH_SET_DEFAULT_CLUB="7i";
  const GD_COACH_SET_NO_BAG_DEFAULT_M=120;
  // Reasonable amateur-to-strong-player carry windows per club - dragging the
  // live bubble can't leave this band, however far the pointer travels, so a
  // slip of the thumb can't park a 7i at driver distance. 7i is pinned to the
  // range this was specified against (80-170m around the 120m no-bag start);
  // the rest step down/up from it in the same proportion.
  const GD_COACH_SET_CLUB_RANGE_M={
    Driver:{min:150,max:280},
    "3W":{min:140,max:250},
    "4H":{min:130,max:230},
    "4i":{min:120,max:210},
    "5i":{min:110,max:195},
    "6i":{min:100,max:185},
    "7i":{min:80,max:170},
    "8i":{min:75,max:160},
    "9i":{min:65,max:145},
    PW:{min:55,max:130},
    GW:{min:45,max:115},
    SW:{min:35,max:100},
    LW:{min:25,max:85}
  };
  function gdCoachSetClubDistanceRange(club){
    const storageClub=gdMyBubbleStorageClub(club);
    const range=GD_COACH_SET_CLUB_RANGE_M[storageClub];
    if(range)return range;
    const typical=Math.round(safe(()=>gdDefaultCarryForClub(storageClub),155)||155);
    return{min:Math.round(typical*.6),max:Math.round(typical*1.35)};
  }
  function gdCoachSetClampDistanceForClub(distanceM,club){
    const range=gdCoachSetClubDistanceRange(club);
    return gdShotBubbleOverlayClamp(distanceM,range.min,range.max);
  }
  // A dragged-but-never-adopted bubble left in p.practiceBubblePendingSource
  // would otherwise leak into whatever the real Practice tab does with that
  // field next. Only ever clears OUR OWN staged entry (distanceMode
  // "coach-set") - a genuine in-progress Practice Bubble adoption is left
  // alone.
  function gdCoachSetDiscardStalePending(p){
    if(p?.practiceBubblePendingSource?.distanceMode==="coach-set"){
      delete p.practiceBubblePendingSource;
      delete p.practiceBubblePendingAt;
      savePlayerProfiles();
    }
  }
  // Every club's offset from 7i, read off the same "typical carry" table the
  // bag's own Quick Set generator (gdGenerateQuickBag) is built from - that
  // generator is hardcoded to anchor on a 7i distance, so this is how any
  // OTHER dragged club's distance gets converted back into an equivalent 7i
  // anchor before the rest of the bag is regenerated from it.
  function gdCoachSetClubOffsetFromSeven(club){
    const storageClub=gdMyBubbleStorageClub(club);
    const table=typeof GD_DEFAULT_CLUB_CARRY_M==="object"?GD_DEFAULT_CLUB_CARRY_M:{};
    const base=Number(table[storageClub]);
    const seven=Number(table["7i"])||155;
    return Number.isFinite(base)?base-seven:0;
  }
  // Dragging live-mutates the WHOLE p.bag (in memory, not persisted) - not
  // just the dragged club's row - so every other live-preview surface, this
  // chart's other reference bubbles included, tracks the drag the same way
  // moving the 7-iron in the real bag generator bumps every other club. The
  // pre-drag bag is snapshotted once per editing session so an abandoned
  // drag (club switched, panel closed) can be reverted without touching
  // Adopt's actual persisted write.
  let gdCoachSetBagSnapshot=null;
  function gdCoachSetSnapshotWholeBag(p){
    if(gdCoachSetBagSnapshot)return;
    gdCoachSetBagSnapshot={rows:(Array.isArray(p?.bag)?p.bag:[]).map(r=>Object.assign({},r))};
  }
  function gdCoachSetLiveMutateBag(p,storageClub,distanceM){
    if(!p)return;
    gdCoachSetSnapshotWholeBag(p);
    if(!Array.isArray(p.bag))p.bag=[];
    const sevenAnchor=distanceM-gdCoachSetClubOffsetFromSeven(storageClub);
    const table=typeof GD_DEFAULT_CLUB_CARRY_M==="object"?GD_DEFAULT_CLUB_CARRY_M:{};
    Object.keys(table).forEach(club=>{
      const rounded=Math.max(20,Math.round(sevenAnchor+gdCoachSetClubOffsetFromSeven(club)));
      const idx=p.bag.findIndex(r=>gdMyBubbleStorageClub(r?.club||r?.name||"")===club);
      const row={club,baseCarry:rounded,totalM:safe(()=>gdBagTotalForCarry(club,rounded),rounded)};
      if(idx>=0)p.bag[idx]=Object.assign({},p.bag[idx],row);
      else p.bag.push(row);
    });
  }
  function gdCoachSetRevertLiveBag(p){
    if(!gdCoachSetBagSnapshot)return;
    const{rows}=gdCoachSetBagSnapshot;
    gdCoachSetBagSnapshot=null;
    if(p)p.bag=rows;
  }
  let gdCoachSetPreviewOn=false;
  let gdCoachSetLiveOffsetDeg=0;
  let gdCoachSetLiveDistanceM=null;
  let gdCoachSetDragState=null;
  function gdCoachSetClubList(p){
    const bagClubs=(Array.isArray(p?.bag)?p.bag:[]).map(row=>String(row?.club||row?.name||"").trim()).filter(Boolean);
    const defaults=Object.keys(typeof GD_DEFAULT_CLUB_CARRY_M==="object"?GD_DEFAULT_CLUB_CARRY_M:{});
    const seen=new Set();
    return [...bagClubs,...defaults].filter(club=>{
      const key=club.toLowerCase();
      if(seen.has(key))return false;
      seen.add(key);
      return true;
    });
  }
  // Reference/ghost bubbles (the Preview clubs) are just a visual guide, so
  // an auto-seeded stock bag is a perfectly fine estimate for where to draw
  // them - real bag entry wins if present, otherwise the stock bag, otherwise
  // the club's standard carry.
  function gdCoachSetDistanceForClub(p,club){
    const hasBag=Array.isArray(p?.bag)&&p.bag.length>0;
    if(hasBag){
      const bagRow=p.bag.find(row=>String(row?.club||row?.name||"").trim().toLowerCase()===String(club||"").trim().toLowerCase());
      const bagCarry=Number(bagRow?.baseCarry??bagRow?.carry??bagRow?.totalM);
      if(Number.isFinite(bagCarry)&&bagCarry>0)return Math.round(bagCarry);
    }
    return Math.round(safe(()=>gdDefaultCarryForClub(club),155)||155);
  }
  // The LIVE/draggable bubble is different: a fresh player has no REAL bag
  // yet (completeProfileForHome auto-seeds a stock one the moment any code
  // touches the profile, flagged bagSeededDefault=true), so there is nothing
  // real to anchor the drag to - 120m is just a neutral place to start
  // dragging FROM, not a claim about the player. Once the coach has actually
  // set a club through here (or the bag was genuinely edited elsewhere),
  // that real distance is the honest starting point.
  function gdCoachSetLiveDefaultDistance(p,club){
    const hasRealBag=Array.isArray(p?.bag)&&p.bag.length>0&&!p.bagSeededDefault;
    const distance=hasRealBag?gdCoachSetDistanceForClub(p,club):GD_COACH_SET_NO_BAG_DEFAULT_M;
    return gdCoachSetClampDistanceForClub(distance,club);
  }
  function gdCoachSetResolvedTemplateClub(){
    const select=document.getElementById("gdCoachSetClub");
    return String(select?.value||GD_COACH_SET_DEFAULT_CLUB).trim()||GD_COACH_SET_DEFAULT_CLUB;
  }
  function gdCoachSetBuildBubble(p,club,baseCarry,offsetDeg){
    const storageClub=gdMyBubbleStorageClub(club);
    return calculateCleanBubbleProfile({
      club:storageClub,
      baseCarry,
      handedness:p?.handedness||"right",
      skillLevel:p?.skillLevel||p?.consistency||"mid",
      faceOffsetDeg:offsetDeg
    });
  }
  // Chart is plotted in real units on both axes (lateral metres for aim,
  // distance metres for carry) rather than raw degrees - that is what lets
  // reference bubbles from different clubs sit on one shared, honest chart.
  // The chart's vertical axis IS the club's gate: bottom of the plot is the
  // club's minimum reasonable carry, top is its maximum - not an auto-fit
  // range - so the whole drag surface reads as "this is the realistic window
  // for this club" rather than a wider chart with an invisible clamp inside
  // it. A reference bubble from Preview that falls outside this club's own
  // window (e.g. Driver's real distance while editing 7i) simply draws above
  // or below the visible plot and is clipped by the chart's overflow:hidden.
  function gdCoachSetChartLayout(range,opts={}){
    const W=480,H=opts.tall?600:320,padX=58,padTop=26,padBottom=40;
    const plotLeft=padX,plotRight=W-padX,plotTop=padTop,plotBottom=H-padBottom;
    const minD=Number(range?.min);
    const maxD=Number(range?.max);
    const lateralRangeM=24;
    const xScale=(plotRight-plotLeft)/(lateralRangeM*2);
    const yScale=(plotBottom-plotTop)/(maxD-minD);
    const cx=(plotLeft+plotRight)/2;
    return{
      W,H,plotLeft,plotRight,plotTop,plotBottom,minD,maxD,xScale,yScale,cx,
      mapX:lateralM=>cx+lateralM*xScale,
      mapY:distanceM=>plotBottom-(distanceM-minD)*yScale,
      invX:px=>(px-cx)/xScale,
      invY:py=>minD+(plotBottom-py)/yScale
    };
  }
  // The union of the Preview clubs' own gated ranges, padded well past the
  // widest bubble any of them can draw at that range's edge - the bubble
  // ELLIPSE, not just its centre point, has to fit inside the plot with room
  // to spare, or the widest club (Driver) clips against the top/bottom.
  function gdCoachSetPreviewRange(){
    let min=Infinity,max=-Infinity,maxHalfDepth=0;
    GD_COACH_SET_REFERENCE_CLUBS.forEach(club=>{
      const r=gdCoachSetClubDistanceRange(club);
      min=Math.min(min,r.min);
      max=Math.max(max,r.max);
      const storageClub=gdMyBubbleStorageClub(club);
      [r.min,r.max].forEach(distance=>{
        const depth=Number(safe(()=>calculateCleanBubbleProfile({club:storageClub,baseCarry:distance,handedness:"right",skillLevel:"mid",faceOffsetDeg:0}).clusterDepthM,20))||20;
        maxHalfDepth=Math.max(maxHalfDepth,depth/2);
      });
    });
    const margin=maxHalfDepth+30;
    return{min:Math.max(10,min-margin),max:max+margin};
  }
  function gdCoachSetNiceGridStep(span){
    const steps=[10,20,25,50,100];
    for(const step of steps){if(span/step<=8)return step;}
    return 100;
  }
  function gdCoachSetGridMarkup(layout){
    const step=gdCoachSetNiceGridStep(layout.maxD-layout.minD);
    const start=Math.ceil(layout.minD/step)*step;
    const parts=[];
    for(let d=start;d<=layout.maxD;d+=step){
      const y=layout.mapY(d);
      parts.push(`<line class="gdCoachSetGridLine" x1="${layout.plotLeft}" y1="${y.toFixed(1)}" x2="${layout.plotRight}" y2="${y.toFixed(1)}"/>`);
      parts.push(`<text class="gdCoachSetGridLabel" x="${(layout.plotLeft-8).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end">${d}m</text>`);
    }
    return parts.join("");
  }
  function gdCoachSetBubbleEllipseAttrs(bubble,layout){
    const lateralM=Number(bubble?.aimOffsetM)||0;
    const cx=layout.mapX(lateralM);
    const cy=layout.mapY(Number(bubble?.baseCarry)||layout.minD);
    // Position uses the two axes' own (deliberately different) scales - the
    // lateral axis is a tight fixed range, the distance axis spans a club's
    // whole gate. But the ELLIPSE ITSELF has to be drawn at one consistent
    // metres-to-pixels scale on both dimensions, or a real widthM:depthM
    // ratio comes out visibly stretched sideways (xScale is a few times
    // larger than yScale here). Use whichever axis scale is smaller so the
    // shape stays true without overflowing either axis.
    const sizeScale=Math.min(layout.xScale,layout.yScale);
    // The app's own "My Bubble" chart (gdPracticeNormalisedPlotLayout etc)
    // also plots on a vertical target line - distance away from the player
    // running up the screen, lateral spread running side to side - same as
    // this chart. Its bubble still renders WIDE, because depth is the
    // horizontal radius there and width is the vertical one, not the literal
    // clusterWidthM->horizontal reading this had. Matching that convention
    // is what "orientation 90 off" was describing.
    const rx=Math.max(4,(Number(bubble?.clusterDepthM)||14)/2*sizeScale);
    const ry=Math.max(4,(Number(bubble?.clusterWidthM)||10)/2*sizeScale);
    // clusterTiltDeg is computed for the app's own bubble frame. Swapping
    // which physical measurement is the horizontal vs vertical radius is a
    // second axis transpose stacked on top of the lateral/distance one this
    // chart already made for positioning - two transposes cancel out, so the
    // tilt angle is used as-is here (unnegated).
    const tilt=Number(bubble?.clusterTiltDeg)||0;
    return{cx,cy,rx,ry,tilt};
  }
  function gdCoachSetRenderReadout(offsetDeg,distanceM){
    const el=document.getElementById("gdCoachSetReadout");
    if(!el)return;
    el.textContent=`${gdOffsetLabel(offsetDeg)} · ${Math.round(distanceM)}m`;
  }
  function gdCoachSetRenderChart(){
    const host=document.getElementById("gdCoachSetChart");
    if(!host)return;
    const {p}=gdBubbleDataContext();
    const templateClub=gdCoachSetResolvedTemplateClub();
    const liveDistance=Number.isFinite(gdCoachSetLiveDistanceM)?gdCoachSetLiveDistanceM:gdCoachSetLiveDefaultDistance(p,templateClub);
    const liveOffset=Number.isFinite(gdCoachSetLiveOffsetDeg)?gdCoachSetLiveOffsetDeg:0;
    const liveBuilt=gdCoachSetBuildBubble(p,templateClub,liveDistance,liveOffset);
    // Every reference bubble is rebuilt fresh through the same engine as the
    // live one, never read off a frozen bubbleProfiles snapshot - distance
    // always comes from the CURRENT bag (or the in-progress drag, for
    // whichever club that is), so a bag edit or an active drag is reflected
    // immediately instead of only after Adopt writes it back. Nothing here
    // is persisted; it is exactly the "preview, not locked in" read Adopt
    // Bubble later makes real.
    const templateStorageClub=gdMyBubbleStorageClub(templateClub);
    // Aim direction cascades across every club the same way distance does -
    // a player who pushes their 7i right is pushing everything right, it's
    // a swing tendency, not a per-club fact. This matches how the rest of
    // the app already treats it: p.faceOffsetDeg/centralFaceOffsetDeg are
    // profile-level (not per-club) fields, and gdBubbleCentralOffset() reads
    // them as the general default for any club with no bubble of its own.
    const referenceBubbles=gdCoachSetPreviewOn?GD_COACH_SET_REFERENCE_CLUBS.map(club=>{
      const storageClub=gdMyBubbleStorageClub(club);
      const isLiveClub=storageClub===templateStorageClub;
      const distance=isLiveClub?liveDistance:gdCoachSetDistanceForClub(p,club);
      const bubble=gdCoachSetBuildBubble(p,club,distance,liveOffset);
      return{club,storageClub,bubble};
    }):[];
    const layout=gdCoachSetPreviewOn
      ?gdCoachSetChartLayout(gdCoachSetPreviewRange(),{tall:true})
      :gdCoachSetChartLayout(gdCoachSetClubDistanceRange(templateClub));
    const gridMarkup=gdCoachSetPreviewOn?gdCoachSetGridMarkup(layout):"";
    const refMarkup=referenceBubbles.map(r=>{
      const a=gdCoachSetBubbleEllipseAttrs(r.bubble,layout);
      return `<g class="gdCoachSetRefBubble" data-club="${gdEscapeHTML(r.storageClub)}"><ellipse cx="${a.cx.toFixed(1)}" cy="${a.cy.toFixed(1)}" rx="${a.rx.toFixed(1)}" ry="${a.ry.toFixed(1)}" transform="rotate(${a.tilt.toFixed(1)} ${a.cx.toFixed(1)} ${a.cy.toFixed(1)})"/><text class="gdCoachSetRefLabel" x="${a.cx.toFixed(1)}" y="${(a.cy-a.ry-6).toFixed(1)}" text-anchor="middle">${gdEscapeHTML(r.club)}</text></g>`;
    }).join("");
    const liveAttrs=gdCoachSetBubbleEllipseAttrs(liveBuilt,layout);
    const liveMarkup=`<g class="gdCoachSetLiveBubble" data-gd-coach-set-live="1"><ellipse cx="${liveAttrs.cx.toFixed(1)}" cy="${liveAttrs.cy.toFixed(1)}" rx="${liveAttrs.rx.toFixed(1)}" ry="${liveAttrs.ry.toFixed(1)}" transform="rotate(${liveAttrs.tilt.toFixed(1)} ${liveAttrs.cx.toFixed(1)} ${liveAttrs.cy.toFixed(1)})"/><circle class="gdCoachSetLiveHandleHit" cx="${liveAttrs.cx.toFixed(1)}" cy="${liveAttrs.cy.toFixed(1)}" r="26"/><circle class="gdCoachSetLiveHandleDot" cx="${liveAttrs.cx.toFixed(1)}" cy="${liveAttrs.cy.toFixed(1)}" r="5"/></g>`;
    const zeroX=layout.mapX(0);
    const targetLine=`<line class="gdCoachSetTargetLine" x1="${zeroX.toFixed(1)}" y1="${layout.plotTop}" x2="${zeroX.toFixed(1)}" y2="${layout.plotBottom}"/>`;
    host.innerHTML=`<svg viewBox="0 0 ${layout.W} ${layout.H}" data-gd-coach-set-chart="1" touch-action="none">${gridMarkup}${targetLine}${refMarkup}${liveMarkup}</svg>`;
    const wrap=host.closest(".gdCoachSetChartWrap");
    if(wrap)wrap.classList.toggle("large",!!gdCoachSetPreviewOn);
    gdCoachSetWireChartDrag();
    gdCoachSetRenderReadout(liveOffset,liveDistance);
  }
  function gdCoachSetUpdateLiveBubbleDom(layout,liveBuilt,offsetDeg,distanceM,storageClub){
    const svg=document.querySelector('svg[data-gd-coach-set-chart="1"]');
    if(!svg)return;
    const a=gdCoachSetBubbleEllipseAttrs(liveBuilt,layout);
    const g=svg.querySelector('[data-gd-coach-set-live="1"]');
    if(!g)return;
    const ellipse=g.querySelector("ellipse");
    const hit=g.querySelector(".gdCoachSetLiveHandleHit");
    const dot=g.querySelector(".gdCoachSetLiveHandleDot");
    if(ellipse){
      ellipse.setAttribute("cx",a.cx.toFixed(1));
      ellipse.setAttribute("cy",a.cy.toFixed(1));
      ellipse.setAttribute("rx",a.rx.toFixed(1));
      ellipse.setAttribute("ry",a.ry.toFixed(1));
      ellipse.setAttribute("transform",`rotate(${a.tilt.toFixed(1)} ${a.cx.toFixed(1)} ${a.cy.toFixed(1)})`);
    }
    if(hit){hit.setAttribute("cx",a.cx.toFixed(1));hit.setAttribute("cy",a.cy.toFixed(1));}
    if(dot){dot.setAttribute("cx",a.cx.toFixed(1));dot.setAttribute("cy",a.cy.toFixed(1));}
    // If the club being dragged is also one of the Preview ghost bubbles,
    // that ghost is now stale (it's showing where the club WAS) - drag it
    // along with the live bubble so Preview reads as live, not frozen.
    if(storageClub){
      const ref=svg.querySelector(`.gdCoachSetRefBubble[data-club="${CSS.escape(storageClub)}"]`);
      if(ref){
        const refEllipse=ref.querySelector("ellipse");
        const refLabel=ref.querySelector(".gdCoachSetRefLabel");
        if(refEllipse){
          refEllipse.setAttribute("cx",a.cx.toFixed(1));
          refEllipse.setAttribute("cy",a.cy.toFixed(1));
          refEllipse.setAttribute("rx",a.rx.toFixed(1));
          refEllipse.setAttribute("ry",a.ry.toFixed(1));
          refEllipse.setAttribute("transform",`rotate(${a.tilt.toFixed(1)} ${a.cx.toFixed(1)} ${a.cy.toFixed(1)})`);
        }
        if(refLabel){
          refLabel.setAttribute("x",a.cx.toFixed(1));
          refLabel.setAttribute("y",(a.cy-a.ry-6).toFixed(1));
        }
      }
    }
    gdCoachSetRenderReadout(offsetDeg,distanceM);
  }
  function gdCoachSetWireChartDrag(){
    const svg=document.querySelector('svg[data-gd-coach-set-chart="1"]');
    if(!svg)return;
    const hit=svg.querySelector(".gdCoachSetLiveHandleHit");
    if(!hit)return;
    hit.onpointerdown=function(event){
      event.preventDefault();
      const templateClub=gdCoachSetResolvedTemplateClub();
      // Must match whatever layout gdCoachSetRenderChart() actually drew
      // (the wide Preview range, or the tight per-club one) so pointer
      // position tracks the rendered bubble - the drag is still clamped to
      // the club's own reasonable range regardless of which layout is shown.
      const layout=gdCoachSetPreviewOn
        ?gdCoachSetChartLayout(gdCoachSetPreviewRange(),{tall:true})
        :gdCoachSetChartLayout(gdCoachSetClubDistanceRange(templateClub));
      gdCoachSetDragState={pointerId:event.pointerId,layout,templateClub};
      try{svg.setPointerCapture(event.pointerId);}catch(e){}
      svg.classList.add("dragging");
    };
    svg.onpointermove=function(event){
      const drag=gdCoachSetDragState;
      if(!drag||drag.pointerId!==event.pointerId)return;
      const rect=svg.getBoundingClientRect();
      if(!rect.width||!rect.height)return;
      const vb=drag.layout;
      const px=((event.clientX-rect.left)/rect.width)*vb.W;
      const py=((event.clientY-rect.top)/rect.height)*vb.H;
      const lateralM=gdShotBubbleOverlayClamp(vb.invX(px),-40,40);
      // Gated per club - however far the pointer travels, the drag can't
      // park a club at an unrealistic distance for it (e.g. a 7i at driver
      // range).
      const distanceM=gdCoachSetClampDistanceForClub(vb.invY(py),drag.templateClub);
      const offsetDeg=gdRound(Math.atan2(lateralM,Math.max(distanceM,1))*180/Math.PI,2);
      gdCoachSetLiveOffsetDeg=offsetDeg;
      gdCoachSetLiveDistanceM=Math.round(distanceM*10)/10;
      const {p}=gdBubbleDataContext();
      const storageClub=gdMyBubbleStorageClub(drag.templateClub);
      const liveBuilt=gdCoachSetBuildBubble(p,drag.templateClub,gdCoachSetLiveDistanceM,offsetDeg);
      gdCoachSetUpdateLiveBubbleDom(vb,liveBuilt,offsetDeg,gdCoachSetLiveDistanceM,storageClub);
      // Live-wire the bag too, so the GPS Ready My Bubble hub (and anything
      // else reading the bag right now) previews the drag, not just this
      // chart - still just an in-memory mutation, not a persisted save.
      gdCoachSetLiveMutateBag(p,storageClub,gdCoachSetLiveDistanceM);
      safe(()=>gdRenderBubbleOffsetHub());
    };
    const finish=function(event){
      const drag=gdCoachSetDragState;
      if(!drag||drag.pointerId!==event.pointerId)return;
      svg.classList.remove("dragging");
      try{svg.releasePointerCapture(event.pointerId);}catch(e){}
      gdCoachSetDragState=null;
      gdCoachSetStagePendingBubble();
    };
    svg.onpointerup=finish;
    svg.onpointercancel=finish;
  }
  // Letting go of the bubble only STAGES it - into the exact same
  // p.practiceBubblePendingSource field the real Practice Bubble adopt flow
  // (gdPracticeAdoptBubbleAsPlayingBubble) writes, so the drag result reads
  // to the rest of the app as if it were an adopted Practice Bubble. Nothing
  // is written to previewBubbleSet/bubbleProfiles/the bag until the coach
  // presses Adopt Bubble, which reuses that same save wiring.
  function gdCoachSetStagePendingBubble(){
    if(!gdCoachSetIsCoachViewingPlayer())return;
    const {p}=gdBubbleDataContext();
    if(!p)return;
    const club=gdCoachSetResolvedTemplateClub();
    const storageClub=gdMyBubbleStorageClub(club);
    const distance=Number.isFinite(gdCoachSetLiveDistanceM)?gdCoachSetLiveDistanceM:gdCoachSetLiveDefaultDistance(p,club);
    const offset=Number.isFinite(gdCoachSetLiveOffsetDeg)?gdCoachSetLiveOffsetDeg:0;
    const built=gdCoachSetBuildBubble(p,club,distance,offset);
    const bubble=Object.assign({},built,{
      club:storageClub,
      displayClub:club,
      baseCarry:distance,
      baseDistanceM:distance,
      faceOffsetDeg:offset,
      faceAlignmentOffsetDeg:offset,
      offsetDeg:offset,
      handedness:p.handedness||"right",
      shapeSource:"coach-set"
    });
    // distanceMode deliberately isn't "committed"/"review" - those two values
    // are gdBubbleOffsetSave()'s hook into gdPracticeApplyDistanceLearning,
    // which rescales the WHOLE bag from real practice-shot analysis. That has
    // nothing to do with a distance the coach just dragged to, so this tag
    // skips that branch entirely; gdCoachSetAdoptBubble() writes the bag row
    // itself, via the same gdBagPersistRows() every other bag edit goes
    // through.
    p.practiceBubblePendingSource={
      active:true,
      offsetDeg:Number(offset.toFixed(2)),
      status:"coach-set",
      club,
      shots:0,
      fingerprint:"coach-set-"+Date.now().toString(36),
      distanceMode:"coach-set",
      practiceDistanceM:null,
      importBatchIds:[],
      bubble
    };
    p.practiceBubblePendingAt=new Date().toISOString();
    p.updatedAt=new Date().toISOString();
    savePlayerProfiles();
    syncCoreProfileFromActive();
    const adoptBtn=document.getElementById("gdCoachSetAdoptBtn");
    if(adoptBtn)adoptBtn.disabled=false;
    const status=document.getElementById("gdCoachSetAdoptStatus");
    if(status)status.textContent=`Ready to adopt: ${club} ${Math.round(distance)}m, ${gdOffsetLabel(offset)}`;
    // Every pointermove already patches the live bubble (and its own ghost)
    // directly for smooth dragging, but the OTHER Preview ghosts only get
    // rebuilt on a full render - cheap enough to just do once here, the
    // moment the bubble is actually placed, instead of waiting for the coach
    // to notice and toggle Preview off/on to force it.
    gdCoachSetRenderChart();
  }
  function gdCoachSetAdoptBubble(){
    if(!gdCoachSetIsCoachViewingPlayer())return false;
    const {p}=gdBubbleDataContext();
    const pending=p?.practiceBubblePendingSource;
    if(!pending||!pending.active||pending.distanceMode!=="coach-set"){
      gdLmToast("Drag the bubble into place first");
      return false;
    }
    const club=pending.club||gdCoachSetResolvedTemplateClub();
    const storageClub=gdMyBubbleStorageClub(club);
    const distance=Number(pending.bubble?.baseDistanceM||pending.bubble?.baseCarry)||gdCoachSetLiveDefaultDistance(p,club);
    const offset=Number(pending.offsetDeg)||0;
    // Same "Save" wiring the Practice tab's Save button calls - it reads this
    // exact pending source, writes previewBubbleSet/bubbleProfiles, and clears
    // the staging fields.
    gdPracticeSaveBubbleFromAction();
    const roundedDistance=Math.round(distance);
    // p.bag was already rescaled whole, live, during the drag - this call is
    // just the final, idempotent pass in case Adopt fires without a prior
    // move (e.g. re-adopting an already-staged value).
    gdCoachSetLiveMutateBag(p,storageClub,distance);
    const wholeBag=Array.isArray(p.bag)?p.bag.slice():[];
    // The bag's own canonical write path - same function every other bag
    // edit in the app goes through, which is what actually "kicks in" here.
    if(typeof gdBagPersistRows==="function")gdBagPersistRows(wholeBag,{silent:true,render:false});
    else safe(()=>{
      const fresh=ensureProfile();
      fresh.bag=wholeBag;
      fresh.bagSlotsTouched=true;
      fresh.bagSeededDefault=false;
      savePlayerProfiles();
      syncCoreProfileFromActive();
    });
    // The bag is now genuinely persisted at these values - the pre-drag
    // snapshot no longer applies, or a later discard would wrongly revert a
    // real, adopted save.
    gdCoachSetBagSnapshot=null;
    const adoptBtn=document.getElementById("gdCoachSetAdoptBtn");
    if(adoptBtn)adoptBtn.disabled=true;
    const status=document.getElementById("gdCoachSetAdoptStatus");
    if(status)status.textContent="Drag the bubble, then adopt.";
    gdLmToast(`${club} adopted for ${p.name||"player"}: ${roundedDistance}m, ${gdOffsetLabel(offset)}`);
    gdCoachSetRenderChart();
    return false;
  }
  function gdCoachSetOpenBag(){
    if(typeof openBag==="function")openBag({fromProfile:true});
    return false;
  }
  function gdCoachSetTogglePreview(){
    gdCoachSetPreviewOn=!gdCoachSetPreviewOn;
    const btn=document.getElementById("gdCoachSetPreviewBtn");
    if(btn)btn.classList.toggle("active",gdCoachSetPreviewOn);
    gdCoachSetRenderChart();
    return false;
  }
  function gdRenderCoachSetBubblePanel(){
    const panel=document.getElementById("gdCoachSetBubblePanel");
    if(!panel)return;
    const {p}=gdBubbleDataContext();
    const select=document.getElementById("gdCoachSetClub");
    if(select&&!select.dataset.gdPopulated){
      const clubs=gdCoachSetClubList(p);
      select.innerHTML=clubs.map(club=>`<option value="${gdEscapeHTML(club)}">${gdEscapeHTML(club)}</option>`).join("");
      select.value=GD_COACH_SET_DEFAULT_CLUB;
      if(!select.value&&select.options.length)select.value=select.options[0].value;
      select.dataset.gdPopulated="1";
    }
    const who=document.getElementById("gdCoachSetBubbleWho");
    if(who)who.textContent=p?.name?`Set ${p.name}'s bubble directly - skips photo, email and plotting.`:"Set this player's bubble directly.";
    const pendingIsOurs=p?.practiceBubblePendingSource?.active&&p.practiceBubblePendingSource.distanceMode==="coach-set";
    const adoptBtn=document.getElementById("gdCoachSetAdoptBtn");
    if(adoptBtn)adoptBtn.disabled=!pendingIsOurs;
    const status=document.getElementById("gdCoachSetAdoptStatus");
    if(status)status.textContent=pendingIsOurs
      ?`Ready to adopt: ${p.practiceBubblePendingSource.club} ${Math.round(Number(p.practiceBubblePendingSource.bubble?.baseDistanceM)||0)}m, ${gdOffsetLabel(Number(p.practiceBubblePendingSource.offsetDeg)||0)}`
      :"Drag the bubble, then adopt.";
    if(gdCoachSetLiveDistanceM==null){
      const club=gdCoachSetResolvedTemplateClub();
      const storageClub=gdMyBubbleStorageClub(club);
      const existing=p?.bubbleProfiles?.[storageClub];
      if(existing&&Number.isFinite(Number(existing.faceOffsetDeg))&&Number.isFinite(Number(existing.baseCarry))){
        gdCoachSetLiveOffsetDeg=Number(existing.faceOffsetDeg);
        gdCoachSetLiveDistanceM=gdCoachSetClampDistanceForClub(Number(existing.baseCarry),club);
      }else{
        gdCoachSetLiveOffsetDeg=0;
        gdCoachSetLiveDistanceM=gdCoachSetLiveDefaultDistance(p,club);
      }
    }
    gdCoachSetRenderChart();
  }
  function gdCoachSetClubChanged(){
    const {p}=gdBubbleDataContext();
    gdCoachSetDiscardStalePending(p);
    gdCoachSetRevertLiveBag(p);
    safe(()=>gdRenderBubbleOffsetHub());
    const adoptBtn=document.getElementById("gdCoachSetAdoptBtn");
    if(adoptBtn)adoptBtn.disabled=true;
    const status=document.getElementById("gdCoachSetAdoptStatus");
    if(status)status.textContent="Drag the bubble, then adopt.";
    const club=gdCoachSetResolvedTemplateClub();
    const storageClub=gdMyBubbleStorageClub(club);
    const existing=p?.bubbleProfiles?.[storageClub];
    if(existing&&Number.isFinite(Number(existing.faceOffsetDeg))&&Number.isFinite(Number(existing.baseCarry))){
      gdCoachSetLiveOffsetDeg=Number(existing.faceOffsetDeg);
      gdCoachSetLiveDistanceM=gdCoachSetClampDistanceForClub(Number(existing.baseCarry),club);
    }else{
      gdCoachSetLiveOffsetDeg=0;
      gdCoachSetLiveDistanceM=gdCoachSetLiveDefaultDistance(p,club);
    }
    gdCoachSetRenderChart();
    return false;
  }
  let gdPracticePhotoDebugRun=null;
  function gdPracticeDebugNow(){return new Date().toISOString();}
  function gdPracticeDebugMs(start,finish){
    const a=Date.parse(start||""),b=Date.parse(finish||"");
    return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,b-a):null;
  }
  function gdPracticeDebugError(error){
    if(!error)return null;
    return {message:String(error.message||error||"Unknown error"),name:String(error.name||"Error"),stack:error.stack?String(error.stack):""};
  }
  function gdPracticePhotoDebugCanView(){
    let permission="";
    try{permission=typeof gdGetAccountPermission==="function"?gdGetAccountPermission():String(document.body?.dataset?.gdPermission||"");}catch(e){permission="";}
    return String(permission||"").toLowerCase()==="admin";
  }
  function gdPracticeDebugButtonSnapshot(){
    return ["gdPracticeScanPhotoBtn","gdPracticeDefaultScanBtn","gdPracticeContinueScanBtn","gdNativePracticeSaveBtn"].map(id=>{
      const el=document.getElementById(id);
      if(!el)return null;
      return {
        id,
        disabled:!!el.disabled,
        hidden:!!el.hidden||el.offsetParent===null,
        ariaDisabled:String(el.getAttribute("aria-disabled")||""),
        text:String(el.textContent||"").replace(/\s+/g," ").trim().slice(0,80),
        classes:String(el.className||"")
      };
    }).filter(Boolean);
  }
  function gdPracticeDebugButtonsAreLocked(){
    return !!document.body?.classList?.contains("gdPracticePhotoProcessing");
  }
  function gdPracticeReleaseProcessingControls(reason){
    const wasProcessing=!!gdPracticePhotoProcessing;
    if(wasProcessing)gdSetPracticePhotoProcessing(false);
    else if(gdPracticePhotoDebugRun)gdPracticeDebugRecordButtonState(false,reason||"processing-release");
    return wasProcessing;
  }
  function gdPracticeDebugRecordButtonState(locked,reason){
    if(!gdPracticePhotoDebugRun)return;
    const buttons=gdPracticeDebugButtonSnapshot();
    gdPracticeDebugCheckpoint("save_ui_state_changed","success",{
      outputSummary:`Photo processing controls ${locked?"locked":"released"}`,
      counts:{buttons:buttons.length,disabled:buttons.filter(button=>button.disabled).length},
      raw:{locked:!!locked,reason:String(reason||""),buttons}
    });
    gdPracticeDebugCheckpoint(locked?"save_button_locked":"save_button_released","success",{
      outputSummary:locked?"Processing controls locked while save/import runs":"Processing controls released after save/import run",
      counts:{buttons:buttons.length,disabled:buttons.filter(button=>button.disabled).length}
    });
  }
  function gdPracticeDebugCheckpointLabel(id){
    return ({
      photo_selected:"Photo selected / loaded",
      native_csv_received:"Native CSV received",
      image_metadata:"Image metadata read",
      image_preprocess:"Image preprocessing",
      crop_cleanup:"Crop / orientation / cleanup",
      value_corridor_mapping:"1 · Column splitter",
      header_strip_scan:"2 · Header allocation",
      club_id:"2.5 · Club ID (offcut)",
      extraction_started:"3 · Extraction",
      extraction_completed:"3 · Extraction",
      deep_scan:"3.5 · Deep scan (direction markers)",
      ocr_generated_template:"OCR grid generated",
      header_cutout_allocation:"Header / cutout allocation",
      raw_values_detected:"Raw text / raw values detected",
      table_detected:"Table / CSV-like data detected",
      field_mapping:"Field mapping attempted",
      rows_parsed:"Rows parsed",
      rows_accepted:"Rows accepted",
      rows_rejected:"Rows rejected",
      gate_handoff:"Practice Data Gate input built",
      practice_store_handoff:"Practice store handoff",
      practice_render_refresh:"Practice Data render refresh",
      save_started:"Save started",
      save_completed:"Saved to library",
      save_failed:"Save failed",
      save_button_locked:"Save/process button locked",
      save_button_released:"Save/process button released",
      save_ui_state_changed:"Save/process UI state",
      qa_fixture_cleanup_started:"QA fixture cleanup started",
      qa_fixture_cleanup_completed:"QA fixture cleanup completed",
      qa_fixture_cleanup_failed:"QA fixture cleanup failed"
    })[id]||String(id||"Checkpoint");
  }
  function gdPracticeDebugStartRun(source={}){
    const at=gdPracticeDebugNow();
    gdPracticePhotoDebugRun={
      id:`practice-photo-debug-${Date.now().toString(36)}`,
      startedAt:at,
      finishedAt:null,
      status:"processing",
      failedCheckpointId:"",
      latestFailedCheckpointId:"",
      lastSuccessfulCheckpointId:"",
      checkpoints:[],
      summary:{sourceName:String(source.sourceName||source.fileName||gdPracticePhotoName||"Practice photo processing"),dataSaved:false,errorMessage:"",totalProcessingMs:null},
      raw:{source}
    };
    window.__gdPracticePhotoDebugRun=gdPracticePhotoDebugRun;
    gdPracticeRecordLiveDebugEvent("run",`Debug run started: ${gdPracticePhotoDebugRun.summary.sourceName}`,{state:"processing",checkpoint:"debug_start"});
    return gdPracticePhotoDebugRun;
  }
  function gdPracticeDebugEnsureRun(source){
    if(!gdPracticePhotoDebugRun)gdPracticeDebugStartRun(source||{sourceName:"Practice photo processing"});
    return gdPracticePhotoDebugRun;
  }
  function gdPracticeDebugCheckpoint(id,status,details={}){
    const run=gdPracticeDebugEnsureRun();
    const at=gdPracticeDebugNow();
    let checkpoint=run.checkpoints.find(item=>item.id===id);
    if(!checkpoint){
      checkpoint={id,label:gdPracticeDebugCheckpointLabel(id),status:"pending",startedAt:null,finishedAt:null,durationMs:null,inputSummary:"",outputSummary:"",warnings:[],error:null,technicalDetails:null,counts:null,tableScanOutcome:null};
      run.checkpoints.push(checkpoint);
    }
    if(status==="running"&&!checkpoint.startedAt)checkpoint.startedAt=at;
    if(status!=="running"){
      if(!checkpoint.startedAt)checkpoint.startedAt=at;
      checkpoint.finishedAt=at;
      checkpoint.durationMs=gdPracticeDebugMs(checkpoint.startedAt,checkpoint.finishedAt);
    }
    checkpoint.status=status||checkpoint.status||"success";
    if(details.inputSummary!==undefined)checkpoint.inputSummary=String(details.inputSummary||"");
    if(details.outputSummary!==undefined)checkpoint.outputSummary=String(details.outputSummary||"");
    if(Array.isArray(details.warnings))checkpoint.warnings=details.warnings.slice();
    if(details.error)checkpoint.error=gdPracticeDebugError(details.error);
    if(details.technicalDetails!==undefined)checkpoint.technicalDetails=details.technicalDetails;
    if(details.counts&&typeof details.counts==="object")checkpoint.counts=Object.assign({},details.counts);
    const snapshot=gdPracticeDebugSnapshotForCheckpoint(id,details);
    if(snapshot)checkpoint.snapshot=snapshot;
    if(details.tableScanOutcome!==undefined||details.scanOutcome!==undefined){
      checkpoint.tableScanOutcome=details.tableScanOutcome||details.scanOutcome||null;
    }else if(!checkpoint.tableScanOutcome&&/ocr_generated_template|header_cutout_allocation|table_detected|raw_values_detected|extraction_started|extraction_completed|rows_parsed|rows_accepted|rows_rejected/i.test(id)){
      try{
        if(typeof gdPracticeTableScanOutcomeForDebug==="function")checkpoint.tableScanOutcome=gdPracticeTableScanOutcomeForDebug(window.__gdPracticeColumnScan||null);
      }catch(e){}
    }
    if(details.raw!==undefined){
      run.raw=run.raw||{};
      run.raw[id]=details.raw;
    }
    if(status==="success"||status==="warning")run.lastSuccessfulCheckpointId=id;
    if(status==="failed"){
      run.status="failed";
      if(!run.failedCheckpointId)run.failedCheckpointId=id;
      run.latestFailedCheckpointId=id;
      if(!run.summary.errorMessage)run.summary.errorMessage=checkpoint.error?.message||checkpoint.outputSummary||"Photo processing failed";
    }
    window.__gdPracticePhotoDebugRun=run;
    gdPracticeRecordLiveDebugEvent("checkpoint",`${checkpoint.label}: ${checkpoint.status}`,{state:checkpoint.status,checkpoint:id});
    return checkpoint;
  }
  function gdPracticeDebugFinish(status,summary={}){
    const run=gdPracticeDebugEnsureRun();
    const priorError=run.summary?.errorMessage||"";
    run.status=status||run.status||"success";
    if(typeof gdPracticeReleaseProcessingControls==="function")gdPracticeReleaseProcessingControls("debug-finish");
    run.finishedAt=gdPracticeDebugNow();
    run.summary=Object.assign({},run.summary||{},summary||{});
    if(run.status==="failed"&&priorError)run.summary.errorMessage=priorError;
    run.summary.totalProcessingMs=gdPracticeDebugMs(run.startedAt,run.finishedAt);
    run.summary.buttonLockedAtFinish=gdPracticeDebugButtonsAreLocked();
    if(run.status==="success"){
      run.failedCheckpointId="";
      run.latestFailedCheckpointId="";
      run.summary.errorMessage="";
    }
    window.__gdPracticePhotoDebugRun=run;
    gdPracticeRecordLiveDebugEvent("run",`Debug run finished: ${run.status}`,{state:run.status,checkpoint:"debug_finish"});
    return run;
  }
  function gdPracticeDebugFailed(id,error,details={}){
    gdPracticeDebugCheckpoint(id||"extraction_started","failed",Object.assign({},details,{error,outputSummary:details.outputSummary||String(error?.message||error||"Processing failed")}));
    const rootMessage=gdPracticePhotoDebugRun?.summary?.errorMessage||String(error?.message||error||"Processing failed");
    return gdPracticeDebugFinish("failed",{dataSaved:false,errorMessage:rootMessage});
  }
  function gdPracticeDebugLabelForRunCheckpoint(run,id){
    const checkpoint=(run?.checkpoints||[]).find(item=>item.id===id);
    return checkpoint?.label||"";
  }
  function gdPracticeDebugMetric(label,value){
    return `<div class="gdPracticePhotoDebugMetric"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value==null||value===""?"-":String(value))}</strong></div>`;
  }
  function gdPracticeDebugFormatMs(ms){
    const n=Number(ms);
    if(!Number.isFinite(n))return "-";
    return n<1000?`${Math.round(n)} ms`:`${(n/1000).toFixed(1)} s`;
  }
  function gdPracticeDebugDetailRow(label,value){
    if(value==null||value===""||(Array.isArray(value)&&!value.length))return "";
    const text=Array.isArray(value)?value.join(", "):String(value);
    return `<div><b>${gdEscapeHTML(label)}:</b> ${gdEscapeHTML(text)}</div>`;
  }
  function gdPracticeDebugCanvasSnapshot(source,label="Stage image"){
    if(!source)return null;
    if(typeof source==="string")return {label,width:0,height:0,url:source};
    const width=Number(source.width||source.videoWidth||source.naturalWidth)||0;
    const height=Number(source.height||source.videoHeight||source.naturalHeight)||0;
    if(width<2||height<2)return null;
    try{
      const canvas=document.createElement("canvas");
      const scale=Math.min(1,760/width);
      canvas.width=Math.max(1,Math.round(width*scale));
      canvas.height=Math.max(1,Math.round(height*scale));
      const ctx=canvas.getContext("2d");
      ctx.drawImage(source,0,0,canvas.width,canvas.height);
      return {label,width,height,url:canvas.toDataURL("image/jpeg",.78)};
    }catch(e){
      return null;
    }
  }
  function gdPracticeDebugSnapshotFromDetails(details){
    const snap=details?.snapshot;
    if(!snap)return null;
    if(typeof snap==="string")return gdPracticeDebugCanvasSnapshot(snap,"Provided snapshot");
    return gdPracticeDebugCanvasSnapshot(snap.canvas||snap.image||snap.source||snap.url,snap.label||"Provided snapshot");
  }
  function gdPracticeDebugSnapshotForCheckpoint(id,details={}){
    const direct=gdPracticeDebugSnapshotFromDetails(details);
    if(direct)return direct;
    const checkpoint=typeof gdPracticeClusterCheckpoint!=="undefined"?(gdPracticeClusterCheckpoint||window.__gdPracticeClusterCheckpoint):window.__gdPracticeClusterCheckpoint;
    const columnScan=window.__gdPracticeColumnScan||null;
    const outcomes=window.__gdPracticeTemplateOutcomes||{};
    const visibleDebugCanvas=document.getElementById("gdPracticeScanDebugCanvas");
    const candidates=[];
    const add=(source,label)=>{if(source)candidates.push({source,label});};
    if(/photo_selected|image_metadata/i.test(id)){
      add(typeof gdPracticePhotoBitmap!=="undefined"?gdPracticePhotoBitmap:null,"Selected photo");
    }
    if(/image_preprocess|crop_cleanup/i.test(id)){
      add(typeof gdPracticeNormalizedCanvas!=="undefined"?gdPracticeNormalizedCanvas:null,"Normalised photo");
      add(checkpoint?.source,"Prepared source");
      add(checkpoint?.cluster?.displayCutoutCanvas||checkpoint?.scanImage,"Detected value-grid crop");
    }
    if(/ocr_generated_template|header_cutout_allocation|table_detected|raw_values_detected|extraction_started|extraction_completed|rows_parsed|rows_accepted|rows_rejected/i.test(id)){
      add(columnScan?.sourceCanvas||columnScan?.preparedCanvas||columnScan?.directColumnSource,"Flat scan image");
      add(outcomes.ocr?.image||outcomes.flat?.image,"Template output image");
      add(checkpoint?.scanImage||checkpoint?.directColumnSource||checkpoint?.cluster?.displayCutoutCanvas,"Value-grid scan image");
    }
    add(visibleDebugCanvas&&visibleDebugCanvas.width>2&&visibleDebugCanvas.height>2?visibleDebugCanvas:null,"Visible debug canvas");
    for(const item of candidates){
      const snapshot=gdPracticeDebugCanvasSnapshot(item.source,item.label);
      if(snapshot)return snapshot;
    }
    return null;
  }
  function gdPracticeDebugSnapshotHtml(snapshot,failed){
    if(!snapshot?.url)return "";
    return `<details class="gdPracticePhotoDebugSection" ${failed?"open":""}>
      <summary><strong>Stage Snapshot</strong><span>${gdEscapeHTML(snapshot.label||"image")}</span></summary>
      <div class="gdPracticePhotoDebugBody gdPracticeStageSnapshot">
        <img src="${gdEscapeHTML(snapshot.url)}" alt="${gdEscapeHTML(snapshot.label||"Stage snapshot")}">
        <small>${gdEscapeHTML(snapshot.width&&snapshot.height?`${snapshot.width} x ${snapshot.height}`:"snapshot")}</small>
      </div>
    </details>`;
  }
  function gdPracticeDebugCheckpointHtml(checkpoint,run){
    const failed=run?.failedCheckpointId===checkpoint.id||checkpoint.status==="failed";
    const counts=checkpoint.counts?Object.entries(checkpoint.counts).map(([key,value])=>`${key}: ${value}`).join(", "):"";
    const technical=checkpoint.technicalDetails||checkpoint.error?.stack||"";
    const tableOutcome=checkpoint.tableScanOutcome||checkpoint.scanOutcome||null;
    return `<details class="gdPracticePhotoDebugSection ${failed?"failed":""}" ${failed?"open":""}>
      <summary><strong>${gdEscapeHTML(checkpoint.label)}</strong><span class="${gdEscapeHTML(checkpoint.status||"pending")}">${gdEscapeHTML(checkpoint.status||"pending")}</span></summary>
      <div class="gdPracticePhotoDebugBody">
        ${gdPracticeDebugDetailRow("Timestamp",checkpoint.startedAt||checkpoint.finishedAt)}
        ${gdPracticeDebugDetailRow("Duration",gdPracticeDebugFormatMs(checkpoint.durationMs))}
        ${gdPracticeDebugDetailRow("Input",checkpoint.inputSummary)}
        ${gdPracticeDebugDetailRow("Output",checkpoint.outputSummary)}
        ${gdPracticeDebugDetailRow("Counts",counts)}
        ${gdPracticeDebugDetailRow("Warnings",checkpoint.warnings)}
        ${gdPracticeDebugDetailRow("Error",checkpoint.error?.message)}
          ${gdPracticeDebugSnapshotHtml(checkpoint.snapshot,failed)}
        ${gdPracticeTableScanOutcomeHtml(tableOutcome)}
        ${technical?`<details><summary>Technical details</summary><pre>${gdEscapeHTML(typeof technical==="string"?technical:JSON.stringify(technical,null,2))}</pre></details>`:""}
      </div>
    </details>`;
  }
  function gdPracticeDebugRejectedRows(run){
    const rows=(run?.raw?.rejectedRows||[]).slice(0,80);
    if(!rows.length)return "";
    const body=rows.map(row=>`<div><b>${gdEscapeHTML(row.index??row.rowNumber??"-")}</b> ${gdEscapeHTML(row.reason||"rejected")} ${row.rawValue!==undefined?`- raw ${gdEscapeHTML(row.rawValue)}`:""} ${row.mappedValue!==undefined?`- mapped ${gdEscapeHTML(row.mappedValue)}`:""}</div>`).join("");
    return `<details class="gdPracticePhotoDebugSection"><summary><strong>Rejected Rows / Rejected Items</strong><span>${rows.length}</span></summary><div class="gdPracticePhotoDebugBody">${body}</div></details>`;
  }
  function gdCopyPracticePhotoDebugJson(){
    const text=JSON.stringify(gdPracticePhotoDebugRun||{},null,2);
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(()=>gdLmToast("Debug JSON copied")).catch(()=>gdLmToast("Copy failed"));
    return false;
  }
  function gdTogglePracticeImport(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    gdPracticeImportOpen=!gdPracticeImportOpen;
    gdPracticeEmailLaneOpen=false;
    try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
    if(gdPracticeImportOpen){
      gdMigrateLegacyNativePracticeStore();
      gdNativePracticeFeedbackPatch({
        status:"waiting",
        lastAction:"Import opened",
        savedCount:gdPracticeLibraryShotCount(),
        warnings:[],
        errors:[],
        nextStep:"Upload a text file, paste CSV, or take/upload a photo."
      });
    }else{
      gdNativePracticeFeedbackPatch({
        lastAction:"Import closed",
        nextStep:"Open Import to upload a file, paste CSV, or select a photo."
      });
    }
    gdRenderPracticeImportPanel();
    return false;
  }
  let gdNativePracticeImportPreview=null;
  let gdNativePracticeFeedbackState={
    status:"waiting",
    lastAction:"Import opened",
    parsedCount:0,
    validCount:0,
    invalidCount:0,
    savedCount:0,
    warnings:[],
    errors:[],
    nextStep:"Upload a text file, paste CSV, or take/upload a photo.",
    photoAction:false,
    updatedAt:""
  };
  function gdNativePracticeApi(){
    return window.GDPracticeDataImport||window.GolfDaddyNativePracticeData||null;
  }
  function gdNativePracticeSample(){
    return "club,carry,total,offline,face,path,start\n7 Iron,142,151,-6,1.2,3.1,0.8\n7 Iron,146,154,-3,0.9,2.7,0.5\n7 Iron,139,148,-9,1.8,3.5,1.1\n7 Iron,144,152,-4,1.1,2.9,0.6";
  }
  function gdOpenNativePracticeDrawer(){
    gdPracticeImportOpen=true;
    try{localStorage.removeItem(GD_PRACTICE_IMPORT_OPEN_KEY);}catch(e){}
    const drawer=byId("gdNativePracticeImportDrawer");
    if(drawer)drawer.open=true;
    gdRenderPracticeImportPanel();
    return false;
  }
  function gdNativePracticeMetricHTML(label,value){
    return `<div class="gdNativePracticeMetric"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value)}</strong></div>`;
  }
  function gdNativePracticeStatusLabel(status){
    return ({
      waiting:"Waiting for practice data",
      file_selected:"File selected",
      photo_selected:"Photo selected",
      parsing:"Parsing import...",
      parsed:"Rows parsed",
      ready_to_save:"Rows parsed - review before saving native data",
      saved:"Native practice rows saved",
      failed:"Import needs attention"
    })[status]||String(status||"Waiting");
  }
  function gdNativePracticeFeedbackPatch(patch={}){
    const nextPatch=Object.assign({},patch);
    if(Object.prototype.hasOwnProperty.call(nextPatch,"status")&&nextPatch.status!=="photo_selected"&&!Object.prototype.hasOwnProperty.call(nextPatch,"photoAction")){
      nextPatch.photoAction=false;
    }
    gdNativePracticeFeedbackState=Object.assign({},gdNativePracticeFeedbackState,nextPatch,{updatedAt:new Date().toISOString()});
    gdRenderNativePracticeFeedback();
    return gdNativePracticeFeedbackState;
  }
  function gdNativePracticeFeedbackMessages(values){
    const list=(Array.isArray(values)?values:[values]).filter(Boolean).map(value=>String(value));
    return list.length?Array.from(new Set(list)):["none"];
  }
  function gdNativePracticeFeedbackItem(label,value){
    return `<div class="gdNativePracticeFeedbackItem"><span>${gdEscapeHTML(label)}</span><strong>${gdEscapeHTML(value==null||value===""?"-":String(value))}</strong></div>`;
  }
  function gdRenderNativePracticeFeedback(){
    const root=byId("gdNativePracticeFeedback");
    if(!root)return;
    if(!gdPracticeImportOpen||!gdPracticeAdminIsOpenSafe()){
      root.innerHTML="";
      return;
    }
    const state=gdNativePracticeFeedbackState||{};
    const status=state.status||"waiting";
    const updated=state.updatedAt?new Date(state.updatedAt):null;
    const updatedText=updated&&!Number.isNaN(updated.getTime())?updated.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"-";
    const warnings=gdNativePracticeFeedbackMessages(state.warnings);
    const errors=gdNativePracticeFeedbackMessages(state.errors);
    root.innerHTML=`<div class="gdNativePracticeFeedback">
      <div class="gdNativePracticeFeedbackHead"><div><strong>Import Status</strong><span>${gdEscapeHTML(gdNativePracticeStatusLabel(status))}</span></div><div class="gdNativePracticeStatusPill ${gdEscapeHTML(status)}">${gdEscapeHTML(status.replace(/_/g," "))}</div></div>
      <div class="gdNativePracticeFeedbackGrid">
        ${gdNativePracticeFeedbackItem("Status",gdNativePracticeStatusLabel(status))}
        ${gdNativePracticeFeedbackItem("Last action",state.lastAction||"Import opened")}
        ${gdNativePracticeFeedbackItem("Parsed rows",Number(state.parsedCount)||0)}
        ${gdNativePracticeFeedbackItem("Valid rows",Number(state.validCount)||0)}
        ${gdNativePracticeFeedbackItem("Invalid rows",Number(state.invalidCount)||0)}
        ${gdNativePracticeFeedbackItem("Saved native rows",Number(state.savedCount)||0)}
        ${gdNativePracticeFeedbackItem("Updated",updatedText)}
        ${gdNativePracticeFeedbackItem("Storage",state.storageKey||"gd_launch_monitor_data_v1")}
      </div>
      <div class="gdNativePracticeFeedbackLists">
        <div class="warn"><b>Warnings:</b> ${gdEscapeHTML(warnings.join("; "))}</div>
        <div class="error"><b>Errors:</b> ${gdEscapeHTML(errors.join("; "))}</div>
        <div><b>Next step:</b> ${gdEscapeHTML(state.nextStep||"Upload a text file, paste CSV, or take/upload a photo.")}</div>
        ${state.photoAction?`<div class="gdNativePracticeFeedbackAction"><button type="button" onclick="return gdAdjustPracticeGeneratedBox()">Adjust generated box</button></div>`:""}
        <div><b>Accepted fields:</b> club, carry, total, offline, face, path, face-to-path, start direction, launch, spin, ball speed, club speed.</div>
        ${state.savedBatchId?`<div><b>Saved batch:</b> ${gdEscapeHTML(state.savedBatchId)} · <b>Session:</b> ${gdEscapeHTML(state.savedSessionId||"-")}</div>`:""}
      </div>
    </div>`;
  }
  function gdNativePracticeRowIssues(row){
    return []
      .concat(Array.isArray(row?.errors)?row.errors:[])
      .concat(Array.isArray(row?.warnings)?row.warnings:[])
      .concat(Object.keys(row?.unknownFields||{}).length?["unknown_fields"]:[]);
  }
  /* Library shots in the shape the review table reads. The table speaks
     Clarity-native (carryDistance, offlineDistance, ...) because that is what a
     parsed row looks like; a stored shot keeps the same numbers under the
     library's own names, so this is a rename, not a second conversion. */
  function gdPracticeLibraryRowsForReview(){
    const lm=window.GolfDaddyLaunchMonitorData;
    const store=safe(()=>typeof lm?.getScopedStore==="function"?lm.getScopedStore():lm?.getStore?.(),null)||{};
    return (Array.isArray(store.shots)?store.shots:[])
      .filter(shot=>String(shot?.status||"active").toLowerCase()!=="deleted")
      .slice()
      .reverse()
      .map((shot,index)=>({
        shotNumber:index+1,
        club:shot.club||shot.originClubLabel||"",
        carryDistance:shot.carryM,
        totalDistance:shot.totalM,
        offlineDistance:shot.lateralM,
        faceAngle:shot.delivery?.faceAngleDeg??null,
        pathAngle:shot.delivery?.clubPathDeg??null,
        // Left blank on purpose: the library keeps a single delivery signal
        // (face-to-path, or face minus path), not a start direction. Showing
        // that number under a "Start" heading would be a different measurement
        // wearing the wrong label.
        startDirection:null,
        status:"saved",
        errors:[],
        warnings:[]
      }));
  }
  function gdNativePracticeRowsTable(rows,opts={}){
    if(!rows||!rows.length)return `<div class="gdNativePracticeEmpty">${gdEscapeHTML(opts.empty||"No native practice rows yet.")}</div>`;
    const limited=rows.slice(0,Number(opts.limit)||24);
    const body=limited.map(row=>{
      const invalid=Array.isArray(row.errors)&&row.errors.length;
      const offline=Number.isFinite(Number(row.offlineDistance))?`${Number(row.offlineDistance).toFixed(1)}m`:"-";
      const carry=Number.isFinite(Number(row.carryDistance))?`${Number(row.carryDistance).toFixed(0)}m`:"-";
      const total=Number.isFinite(Number(row.totalDistance))?`${Number(row.totalDistance).toFixed(0)}m`:"-";
      const issueText=gdNativePracticeRowIssues(row).join(", ");
      const status=invalid?row.errors.join(", "):(issueText||row.status||"native_valid");
      const unknown=Object.keys(row.unknownFields||{}).join(", ");
      return `<tr class="${invalid?"invalid":""}"><td>${gdEscapeHTML(row.shotNumber||"-")}</td><td>${gdEscapeHTML(row.club||"-")}</td><td>${gdEscapeHTML(carry)}</td><td>${gdEscapeHTML(total)}</td><td>${gdEscapeHTML(offline)}</td><td>${gdEscapeHTML(row.faceAngle??"-")}</td><td>${gdEscapeHTML(row.pathAngle??"-")}</td><td>${gdEscapeHTML(row.startDirection??"-")}</td><td>${gdEscapeHTML(status)}${unknown?` · unknown: ${gdEscapeHTML(unknown)}`:""}</td></tr>`;
    }).join("");
    return `<div class="gdNativePracticeTableWrap"><table class="gdNativePracticeTable"><thead><tr><th>#</th><th>Club</th><th>Carry</th><th>Total</th><th>Offline</th><th>Face</th><th>Path</th><th>Start</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  function gdRenderNativePracticeImportLane(){
    const text=byId("gdNativePracticeImportText");
    const summary=byId("gdNativePracticeSummary");
    const preview=byId("gdNativePracticePreview");
    const saved=byId("gdNativePracticeSaved");
    const saveBtn=byId("gdNativePracticeSaveBtn");
    if(!summary||!preview||!saved)return;
    gdMigrateLegacyNativePracticeStore();
    const savedCount=gdPracticeLibraryShotCount();
    const rows=gdNativePracticeImportPreview?.rows||[];
    const valid=rows.filter(row=>!row.errors?.length).length;
    const invalid=rows.filter(row=>row.errors?.length).length;
    gdNativePracticeFeedbackState.savedCount=savedCount;
    gdNativePracticeFeedbackState.storageKey=window.GolfDaddyLaunchMonitorData?.storageKey||"gd_launch_monitor_data_v1";
    gdRenderNativePracticeFeedback();
    summary.innerHTML=[
      gdNativePracticeMetricHTML("Parsed",rows.length||0),
      gdNativePracticeMetricHTML("Valid",valid),
      gdNativePracticeMetricHTML("Saved shots",savedCount)
    ].join("");
    preview.innerHTML=rows.length?`<div class="gdNativePracticeHead"><div><strong>Review parsed rows</strong><span>${valid} valid · ${invalid} invalid · save writes only valid rows.</span></div></div>${gdNativePracticeRowsTable(rows,{empty:"No parsed rows."})}`:`<div class="gdNativePracticeEmpty">Paste CSV/text and parse to review native rows.</div>`;
    saved.innerHTML=`<div class="gdNativePracticeHead"><div><strong>Saved shots</strong><span>${savedCount} shot${savedCount===1?"":"s"} in the Clarity Shot Library.</span></div></div>${gdNativePracticeRowsTable(gdPracticeLibraryRowsForReview(),{empty:"No saved practice shots yet.",limit:12})}`;
    if(saveBtn){
      const wasDisabled=!!saveBtn.disabled;
      saveBtn.disabled=!valid;
      if(gdPracticePhotoDebugRun&&wasDisabled!==saveBtn.disabled){
        gdPracticeDebugCheckpoint("save_ui_state_changed","success",{
          outputSummary:`Native save button ${saveBtn.disabled?"disabled":"enabled"}`,
          counts:{valid,rejected:invalid,disabled:saveBtn.disabled?1:0},
          raw:{reason:"native-import-render",buttons:gdPracticeDebugButtonSnapshot()}
        });
      }
    }
  }
  function gdNativePracticePasteChanged(){
    const text=byId("gdNativePracticeImportText")?.value||"";
    gdNativePracticeFeedbackPatch({
      status:text.trim()?"file_selected":"waiting",
      lastAction:text.trim()?"Pasted text edited":"Paste cleared",
      parsedCount:0,
      validCount:0,
      invalidCount:0,
      warnings:text.trim()?[]:["none"],
      errors:[],
      nextStep:text.trim()?"Press Parse pasted text to review native rows.":"Paste CSV/text, upload a file, or select a photo."
    });
    return false;
  }
  function gdNativePracticeTextFilePickerClicked(){
    gdOpenNativePracticeDrawer();
    gdNativePracticeFeedbackPatch({
      status:"file_selected",
      lastAction:"Upload text file clicked",
      warnings:[],
      errors:[],
      nextStep:"Choose a CSV/text file. It will be copied into the paste lane and parsed for review."
    });
    return true;
  }
  function gdClearNativePracticePaste(){
    const text=byId("gdNativePracticeImportText");
    if(text)text.value="";
    gdNativePracticeImportPreview=null;
    gdNativePracticeFeedbackPatch({
      status:"waiting",
      lastAction:"Paste cleared",
      parsedCount:0,
      validCount:0,
      invalidCount:0,
      warnings:[],
      errors:[],
      nextStep:"Paste CSV/text, upload a text file, or select a photo."
    });
    gdRenderNativePracticeImportLane();
    return false;
  }
  function gdParseNativePracticeImport(){
    const api=gdNativePracticeApi();
    const text=byId("gdNativePracticeImportText")?.value||"";
    const existingJob=gdPracticeHydrateImportJob();
    if(!existingJob||["completed","canceled"].includes(String(existingJob.status||"")))gdPracticeStartImportJob("practice-native","Native Practice Data paste",{status:"parsing",checkpointText:"Parsing native practice rows",stageIndex:1,progress:34,source:"native-paste"});
    else if(String(existingJob.status)==="failed"){
      gdPracticeImportCanStart("Native Practice Data paste");
      return false;
    }
    gdNativePracticeFeedbackPatch({
      status:"parsing",
      lastAction:"Parse started",
      warnings:[],
      errors:[],
      nextStep:"Parsing import..."
    });
    gdPracticeDebugStartRun({sourceName:"Native Practice Data paste",sourceType:"csv",rawLength:text.length});
    gdPracticeDebugCheckpoint("native_csv_received","success",{outputSummary:"Paste input loaded",counts:{characters:text.length}});
    if(!api||typeof api.parsePracticeImportText!=="function"||typeof api.createPracticeImportBatch!=="function"){
      gdPracticeFailImportJob(new Error("Native Practice Data module is not ready"),"Native Practice Data module is not ready. Refresh the app and try again.");
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Parse failed",errors:["Native Practice Data module is not ready"],nextStep:"Refresh the app and try again."});
      gdPracticeDebugFailed("field_mapping",new Error("Native Practice Data module is not ready"),{outputSummary:"Parser API unavailable"});
      gdLmToast("Native Practice Data module is not ready");
      return false;
    }
    try{
      if(!text.trim())throw new Error("No rows detected");
      gdPracticeDebugCheckpoint("table_detected","running",{inputSummary:"CSV/text paste"});
      const parsed=api.parsePracticeImportText(text,{sourceType:"csv",sourceName:"Practice Data paste"});
      if(!parsed.rows?.length)throw new Error("No rows detected");
      gdPracticeDebugCheckpoint("table_detected",parsed.rows?.length?"success":"warning",{
        outputSummary:parsed.hasHeader?"Header row detected":"Headers inferred",
        warnings:parsed.warnings||[],
        counts:{rowsDetected:parsed.rows?.length||0,headers:(parsed.headers||[]).length},
        raw:{headers:parsed.headers,warnings:parsed.warnings}
      });
      gdPracticeDebugCheckpoint("field_mapping","success",{outputSummary:"Native field aliases applied",counts:{headers:(parsed.headers||[]).length}});
      // Forward the provenance the parse established - unit system, session
      // date, provider - so the batch records what the numbers actually mean
      // rather than being staged as bare figures.
      const batch=api.createPracticeImportBatch(parsed.rows,{sourceType:parsed.sourceType||"csv",sourceName:"Practice Data paste",rawText:text,unitSystem:parsed.unitSystem,unitSource:parsed.unitSource,sessionDate:parsed.sessionDate,sessionDateSource:parsed.sessionDateSource,provider:parsed.provider});
      // Per-field units (a yard column in a metric file, a mph speed) only exist
      // on the parse. Keep them on the batch so the library bridge can convert
      // each column from what it actually said.
      if(batch.batch)batch.batch.unitHints=parsed.unitHints||{};
      const valid=batch.rows.filter(row=>!row.errors?.length);
      const invalid=batch.rows.filter(row=>row.errors?.length);
      gdPracticeDebugCheckpoint("rows_parsed","success",{outputSummary:`${batch.rows.length} rows normalized`,counts:{rowsParsed:batch.rows.length}});
      gdPracticeDebugCheckpoint("rows_accepted",valid.length?"success":"failed",{outputSummary:`${valid.length} rows valid`,counts:{accepted:valid.length}});
      gdPracticeDebugCheckpoint("rows_rejected",invalid.length?"warning":"success",{outputSummary:`${invalid.length} rows rejected`,counts:{rejected:invalid.length},warnings:invalid.flatMap(row=>row.errors||[])});
      gdPracticePhotoDebugRun.raw.rejectedRows=invalid.map((row,index)=>({index:row.shotNumber||index+1,reason:(row.errors||[]).join(", "),rawValue:row.rawSource?.line||JSON.stringify(row.rawSource?.cells||{}),mappedValue:row.club||""}));
      gdPracticeDebugCheckpoint("practice_store_handoff","success",{outputSummary:"Preview is ready for Practice Data save path",counts:{valid:valid.length,rejected:invalid.length}});
      gdPracticeDebugFinish(valid.length?"success":"failed",{dataSaved:false,errorMessage:valid.length?"":"No valid native practice rows"});
      if(valid.length){
        gdPracticeUpdateImportJob({
          status:"validating",
          checkpointText:"Review native rows before saving",
          accepted:valid.length,
          rejected:invalid.length,
          rawRows:batch.rows.length,
          nativeRows:valid.length,
          importBatchId:batch.batch?.importBatchId||"",
          sessionId:batch.session?.sessionId||"",
          importDate:batch.batch?.createdAt||batch.session?.createdAt||gdPracticeNowISO(),
          stageIndex:1,
          progress:68
        });
        gdSetPracticePhotoProcessing(false,{skipJob:true});
      }else{
        gdPracticeFailImportJob(new Error("No valid native practice rows"),"No valid native practice rows. Fix missing required fields or paste a cleaner CSV.");
        gdSetPracticePhotoProcessing(false,{skipJob:true});
      }
      gdNativePracticeImportPreview=batch;
      gdNativePracticeFeedbackPatch({
        status:valid.length?"ready_to_save":"failed",
        lastAction:`Parsed ${batch.rows.length} row${batch.rows.length===1?"":"s"}`,
        parsedCount:batch.rows.length,
        validCount:valid.length,
        invalidCount:invalid.length,
        warnings:gdNativePracticeFeedbackMessages([...(parsed.warnings||[]),...batch.rows.flatMap(row=>row.warnings||[])]).filter(item=>item!=="none"),
        errors:invalid.length?Array.from(new Set(invalid.flatMap(row=>row.errors||["Missing required fields"]))):valid.length?[]:["0 valid rows"],
        nextStep:valid.length?"Review the preview table, then save valid rows to native practice data.":"Fix missing required fields or paste a cleaner CSV."
      });
      gdRenderNativePracticeImportLane();
      gdLmToast(`Parsed ${batch.rows.length} native row${batch.rows.length===1?"":"s"}`);
    }catch(e){
      console.warn("[GolfDaddy] native practice parse failed",e);
      gdPracticeFailImportJob(e,e&&e.message?e.message:"Native Practice Data parse failed");
      gdNativePracticeImportPreview=null;
      gdNativePracticeFeedbackPatch({
        status:"failed",
        lastAction:"Parse failed",
        parsedCount:0,
        validCount:0,
        invalidCount:0,
        warnings:[],
        errors:[e&&e.message?e.message:"No rows detected"],
        nextStep:"Use headers like club, carry, total, offline, face, path, start."
      });
      gdRenderNativePracticeImportLane();
      gdPracticeDebugFailed("field_mapping",e,{inputSummary:"Native paste parse",technicalDetails:e&&e.stack});
      gdLmToast("Native Practice Data parse failed");
    }
    return false;
  }
  // Bridges saved native practice rows into the launch-monitor store.
  //
  // Why this exists: the graph, the cluster analysis and the Practice Bubble all
  // read the Clarity Shot Library, so this is how a parsed import becomes
  // something the player can actually see.
  //
  // The mapping itself lives in scripts/gd-practice-library-adapter.js, which is
  // the one place Clarity-native rows become library metrics. This used to be a
  // hand-rolled copy of that mapping, and it had drifted: it omitted
  // expectedDistanceM (so every pasted or emailed shot had a depth of zero and
  // plotted in a vertical line), sent "startDirection" where the library's key
  // is launchDirection, dropped side spin and backspin, and passed yards through
  // as if they were metres.
  //
  // This is now the whole save: the Clarity Shot Library is the only store.
  function gdBridgeNativePracticeToLaunchMonitor(preview){
    const lm=window.GolfDaddyLaunchMonitorData;
    const adapter=window.GDPracticeLibraryAdapter;
    if(!lm||typeof lm.importCapture!=="function"||!adapter||!preview)return null;
    const importBatchId=String(preview.batch?.importBatchId||"").trim();
    const sessionId=String(preview.session?.sessionId||"").trim();
    const stored=(preview.rows||[]).filter(row=>!row.errors?.length);
    if(!stored.length)return null;
    const sourceType=String(preview.batch?.sourceType||"").toLowerCase();
    // The batch carries what the source declared about itself, so an emailed
    // yard file is converted here the same way an uploaded one is.
    const payload=adapter.nativeRowsToLibraryPayload(stored,{
      label:preview.batch?.sourceName||"Practice import",
      inputType:sourceType.includes("email")?"email-csv":"native-csv",
      provider:preview.batch?.provider||"",
      unitSystem:preview.batch?.unitSystem||null,
      unitHints:preview.batch?.unitHints||{},
      sessionDate:preview.batch?.sessionDate||null
    });
    if(!payload.clubGroups.length)return null;
    return lm.importCapture(Object.assign(payload,{importBatchId,sessionId}));
  }
  function gdPracticeLibraryShotCount(){
    const lm=window.GolfDaddyLaunchMonitorData;
    const store=safe(()=>typeof lm?.getScopedStore==="function"?lm.getScopedStore():lm?.getStore?.(),null)||{};
    return (Array.isArray(store.shots)?store.shots:[]).filter(shot=>String(shot?.status||"active").toLowerCase()!=="deleted").length;
  }
  /* One-time move of anything left in the retired native store.
     gd_native_practice_shot_data_v1 held a second copy of every imported shot.
     Imports saved before the library bridge existed live ONLY there, so they
     are carried across before the key is dropped - a player who imported last
     month should not lose those shots because the storage changed. Rows whose
     batch is already in the library are skipped rather than duplicated.
     Once the key is gone this is a no-op, and it can be deleted in a later
     release. */
  let gdLegacyNativeStoreChecked=false;
  function gdMigrateLegacyNativePracticeStore(){
    if(gdLegacyNativeStoreChecked)return null;
    gdLegacyNativeStoreChecked=true;
    const KEY="gd_native_practice_shot_data_v1";
    const lm=window.GolfDaddyLaunchMonitorData;
    const adapter=window.GDPracticeLibraryAdapter;
    if(!lm||typeof lm.importCapture!=="function"||!adapter)return null;
    const legacy=safe(()=>{
      const raw=localStorage.getItem(KEY);
      return raw?JSON.parse(raw):null;
    },null);
    if(!legacy)return null;
    const shots=(Array.isArray(legacy.shots)?legacy.shots:[]).filter(row=>row&&String(row.recordStatus||"active").toLowerCase()!=="deleted");
    const known=new Set();
    safe(()=>{
      const store=lm.getStore?.()||{};
      (Array.isArray(store.sessions)?store.sessions:[]).forEach(session=>{
        const id=String(session?.importBatchId||session?.importId||"").trim();
        if(id)known.add(id);
      });
    },null);
    const byBatch={};
    shots.forEach(row=>{
      const id=String(row.importBatchId||row.importId||"").trim();
      if(!id||known.has(id))return;
      (byBatch[id]=byBatch[id]||[]).push(row);
    });
    let moved=0;
    Object.keys(byBatch).forEach(importBatchId=>{
      const rows=byBatch[importBatchId];
      const batch=(Array.isArray(legacy.importBatches)?legacy.importBatches:[])
        .find(item=>String(item?.importBatchId||item?.importId||"")===importBatchId)||{};
      const payload=adapter.nativeRowsToLibraryPayload(rows,{
        label:batch.sourceName||"Imported practice data",
        inputType:String(batch.sourceType||"").toLowerCase().includes("email")?"email-csv":"native-csv",
        provider:batch.provider||"",
        unitSystem:batch.unitSystem||null,
        unitHints:batch.unitHints||{},
        sessionDate:batch.sessionDate||null
      });
      if(!payload.clubGroups.length)return;
      safe(()=>{
        lm.importCapture(Object.assign(payload,{importBatchId,sessionId:rows[0]?.sessionId||importBatchId}));
        moved+=payload.clubGroups.length;
      },null);
    });
    safe(()=>localStorage.removeItem(KEY),null);
    if(moved)gdLmToast(`Moved ${moved} earlier practice shot${moved===1?"":"s"} into the Clarity Shot Library`);
    return {moved};
  }
  function gdSaveNativePracticeImport(){
    gdMigrateLegacyNativePracticeStore();
    const api=gdNativePracticeApi();
    if(!api||!window.GolfDaddyLaunchMonitorData||typeof window.GolfDaddyLaunchMonitorData.importCapture!=="function"){
      gdPracticeFailImportJob(new Error("Clarity Shot Library is not ready"),"Clarity Shot Library is not ready. Refresh the app and try again.");
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Save failed",errors:["Clarity Shot Library is not ready"],nextStep:"Refresh the app and try again."});
      gdPracticeDebugFailed("save_failed",new Error("Clarity Shot Library is not ready"),{outputSummary:"Save API unavailable"});
      gdLmToast("Clarity Shot Library is not ready");
      return false;
    }
    if(!gdNativePracticeImportPreview||!gdNativePracticeImportPreview.rows?.length){
      gdPracticeFailImportJob(new Error("Parse rows before saving"),"Parse rows before saving.");
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Save blocked",errors:["Parse rows before saving"],nextStep:"Paste or upload data, then parse it before saving."});
      gdPracticeDebugFailed("save_failed",new Error("Parse rows before saving"),{outputSummary:"No preview rows"});
      gdLmToast("Parse rows before saving");
      return false;
    }
    const saveBtn=byId("gdNativePracticeSaveBtn");
    try{
      gdPracticeDebugEnsureRun({sourceName:"Native Practice Data save"});
      const validRows=(gdNativePracticeImportPreview.rows||[]).filter(row=>!row.errors?.length);
      const invalidRows=(gdNativePracticeImportPreview.rows||[]).filter(row=>row.errors?.length);
      if(!gdPracticeHydrateImportJob()||["completed","canceled"].includes(String(gdPracticeHydrateImportJob()?.status||"")))gdPracticeStartImportJob("practice-native","Native Practice Data save",{status:"saving",checkpointText:"Saving native rows",stageIndex:2,progress:82,source:"native-save"});
      gdPracticeUpdateImportJob({
        status:"saving",
        checkpointText:"Saving valid native rows",
        accepted:validRows.length,
        rejected:invalidRows.length,
        rawRows:gdNativePracticeImportPreview.rows.length,
        nativeRows:validRows.length,
        importBatchId:gdNativePracticeImportPreview.batch?.importBatchId||"",
        sessionId:gdNativePracticeImportPreview.session?.sessionId||"",
        importDate:gdNativePracticeImportPreview.batch?.createdAt||gdNativePracticeImportPreview.session?.createdAt||gdPracticeNowISO(),
        stageIndex:2,
        progress:84
      });
      gdNativePracticeFeedbackPatch({status:"parsing",lastAction:"Saving rows",warnings:[],errors:[],nextStep:"Saving valid rows to the Clarity Shot Library..."});
      if(saveBtn)saveBtn.disabled=true;
      gdPracticeDebugRecordButtonState(true,"native-save-start");
      gdPracticeDebugCheckpoint("save_started","running",{inputSummary:`${gdNativePracticeImportPreview.rows.length} preview rows`});
      gdPracticeAssertImportNotCanceled();
      const gate=typeof api.buildPracticeGateInput==="function"
        ?api.buildPracticeGateInput(validRows,{sessionId:gdNativePracticeImportPreview.session?.sessionId||"",importBatchId:gdNativePracticeImportPreview.batch?.importBatchId||""})
        :null;
      if(gate){
        gdPracticeDebugCheckpoint("gate_handoff","success",{outputSummary:`Gate-ready accepted ${gate.counts?.gateReady||0}`,counts:gate.counts||{},raw:gate});
      }
      // The save IS the handoff: one store, so a row that reaches the library
      // has been saved and a row that does not has not.
      const bridged=gdBridgeNativePracticeToLaunchMonitor(gdNativePracticeImportPreview);
      const savedCount=Array.isArray(bridged?.shots)?bridged.shots.length:0;
      if(!savedCount)throw new Error("Nothing reached the Clarity Shot Library");
      gdPracticeCompleteImportJob(null,null,{
        nativeRows:savedCount,
        validCount:validRows.length,
        invalidCount:invalidRows.length,
        rawRows:gdNativePracticeImportPreview.rows.length,
        importBatchId:gdNativePracticeImportPreview.batch?.importBatchId||"",
        sessionId:gdNativePracticeImportPreview.session?.sessionId||"",
        importDate:gdNativePracticeImportPreview.batch?.createdAt||gdNativePracticeImportPreview.session?.createdAt||gdPracticeNowISO()
      });
      gdPracticeDebugCheckpoint("save_completed","success",{outputSummary:`Saved ${savedCount} row${savedCount===1?"":"s"} to the Clarity Shot Library`,counts:{saved:savedCount,rejected:invalidRows.length}});
      gdPracticeDebugFinish("success",{dataSaved:savedCount>0,errorMessage:""});
      gdNativePracticeFeedbackPatch({
        status:"saved",
        lastAction:`Saved ${savedCount} row${savedCount===1?"":"s"}`,
        savedCount:gdPracticeLibraryShotCount(),
        savedBatchId:gdNativePracticeImportPreview.batch?.importBatchId||"",
        savedSessionId:gdNativePracticeImportPreview.session?.sessionId||"",
        storageKey:window.GolfDaddyLaunchMonitorData?.storageKey||"gd_launch_monitor_data_v1",
        warnings:invalidRows.length?[`${invalidRows.length} invalid row${invalidRows.length===1?"":"s"} not saved`]:[],
        errors:[],
        nextStep:"Saved rows are in practice data and visible to the graph. No Practice Bubble was generated - use Generate Bubble when ready."
      });
      gdNativePracticeImportPreview=null;
      gdRenderNativePracticeImportLane();
      safe(()=>renderPracticeData(true));
      gdLmToast(`Saved ${Number(result?.savedCount)||0} native practice row${Number(result?.savedCount)===1?"":"s"}`);
    }catch(e){
      console.warn("[GolfDaddy] native practice save failed",e);
      gdPracticeFailImportJob(e,e&&e.message?e.message:"Native Practice Data save failed");
      gdNativePracticeFeedbackPatch({status:"failed",lastAction:"Save failed",errors:[e&&e.message?e.message:"Save failed"],nextStep:"Review valid rows and try saving again."});
      gdPracticeDebugFailed("save_failed",e,{inputSummary:"Native practice save",technicalDetails:e&&e.stack});
      gdLmToast("Native Practice Data save failed");
    }finally{
      gdRenderNativePracticeImportLane();
      gdSetPracticePhotoProcessing(false,{skipJob:true});
      gdPracticeReleaseProcessingControls("native-save-finally");
    }
    return false;
  }
  // Commits the staged (adopted) bubble into My Bubble. This is the point of no
  // return in the flow - after it, Undo is gone and the only way back is adopting
  // something else - so it refuses politely rather than silently doing nothing
  // when there is nothing staged.
  function gdPracticeSaveBubbleFromAction(){
    if(window.ClarityPayments?.requireAccess&&!window.ClarityPayments.requireAccess("save your own bubble"))return false;
    const p=safe(()=>ensureProfile(),null);
    const pending=p?.practiceBubblePendingSource;
    if(!pending||!pending.active||!Number.isFinite(Number(pending.offsetDeg))){
      gdLmToast("Adopt a bubble before saving");
      return false;
    }
    gdBubbleOffsetSave();
    return false;
  }
  function gdPracticeGenerateBubble(){
    const analysis=gdPracticeProjectionReadyAnalysis();
    const ctx=gdPracticeProjectionContext(analysis);
    if(!ctx.canProject){
      gdLmToast(ctx.hasRealPracticeData?"Cluster finder needs more shots":"Add practice shot data first");
      return false;
    }
    const source=gdPracticeBubbleSource(analysis);
    try{
      if(source?.club)localStorage.setItem(GD_PRACTICE_PROJECTION_SELECTED_CLUB_KEY,source.club);
      localStorage.setItem("gd_practice_projection_mode_v1","selected");
    }catch(e){}
    gdPracticeProjectorOpen=false;
    return gdPracticeSetProjectionOverlay(true,analysis);
  }
  function gdPracticeToggleBagSuggestions(force){
    const next=typeof force==="boolean"?force:!gdPracticeBagSuggestionOpen;
    if(next)gdPracticeMarkBagSuggestionSeen();
    gdPracticeBagSuggestionOpen=next;
    if(!gdPracticeBagSuggestionOpen)gdPracticeBagAdaptOpen=false;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeAdoptBubbleFromAction(){
    if(window.ClarityPayments?.requireAccess&&!window.ClarityPayments.requireAccess("adopt a bubble from your own data"))return false;
    const analysis=gdPracticeProjectionReadyAnalysis();
    const ctx=gdPracticeProjectionContext(analysis);
    if(!ctx.canProject){
      gdLmToast("Practice Bubble not ready");
      return false;
    }
    // No ctx.visible check: that required the overlay to be switched on, which was
    // the old Generate button's job. With Generate gone this guard refused every
    // adopt while the dock button sat enabled - a dead end with a misleading toast.
    if(gdPracticeCurrentBubbleWasAdopted(safe(()=>ensureProfile(),null),analysis)){
      gdLmToast("Practice Bubble already adopted");
      return false;
    }
    gdPracticeBagAdaptOpen=false;
    // ADOPT TAKES DIRECTION ONLY. Distance is a separate, explicit decision, so the
    // bag opens straight afterwards with the suggestions to review rather than the
    // player having to know to go looking for them.
    const hasDistanceSuggestions=safe(()=>gdPracticePrefillRows(analysis).length>0,false);
    gdPracticeBagSuggestionOpen=!!hasDistanceSuggestions;
    gdPracticeAdoptBubbleAsPlayingBubble();
    gdLmToast(hasDistanceSuggestions
      ?"Direction adopted - review distance suggestions"
      :"Direction adopted");
    safe(()=>gdPracticeRefreshProjectionSurfaces());
    return false;
  }
  // Undo the staging step from gdPracticeAdoptBubbleAsPlayingBubble - clears
  // the pending preview (offset+shape only ever gets this far unless the
  // separate Distance Suggestion flow also ran) without touching a bubble
  // that has already been fully saved via gdBubbleOffsetSave.
  function gdPracticeUnadoptBubbleFromAction(){
    const p=safe(()=>ensureProfile(),null);
    if(!p||!gdPracticePendingBubbleIsActive(p)){
      gdLmToast("Nothing pending to undo");
      return false;
    }
    const pendingMode=String(p.practiceBubblePendingSource?.distanceMode||"");
    delete p.practiceBubblePendingSource;
    delete p.practiceBubblePendingAt;
    if(pendingMode!=="manual-preview"){
      try{localStorage.removeItem(GD_PRACTICE_BAG_DRAFT_KEY);}catch(e){}
    }
    p.updatedAt=new Date().toISOString();
    savePlayerProfiles();
    syncCoreProfileFromActive();
    gdPracticeBubbleAdoptionMotion=null;
    gdShotBubbleSafe(()=>typeof gdRenderBubbleOffsetHub==="function"&&gdRenderBubbleOffsetHub());
    renderPracticeData(true);
    gdShotBubbleSafe(()=>typeof renderDataHubStatus==="function"&&renderDataHubStatus());
    gdShotBubbleSafe(()=>typeof renderCompareData==="function"&&renderCompareData());
    gdLmToast("Bubble un-adopted");
    return false;
  }
  function gdPracticeProjectorSummary(analysis,ctx){
    return ctx?.hasRealPracticeData&&ctx?.canProject?"Bubble ready":"Bubble not ready";
  }
  function gdPracticeRawSavedBagRows(){
    const p=safe(()=>typeof gdShotActiveProfile==="function"?gdShotActiveProfile():ensureProfile(),null)||safe(()=>ensureProfile(),null)||{};
    return (Array.isArray(p.bag)?p.bag:[]).map(row=>gdNormaliseBagRow(row)).filter(Boolean);
  }
  function gdPracticeHasUserBag(){
    const p=safe(()=>typeof gdShotActiveProfile==="function"?gdShotActiveProfile():ensureProfile(),null)||safe(()=>ensureProfile(),null)||{};
    const rows=gdPracticeRawSavedBagRows();
    if(!rows.length)return false;
    if(p.bagSeededDefault&&!p.bagSlotsTouched)return false;
    return true;
  }
  // Measured carry for ANY club -> the 7 iron carry that implies.
  //
  // This is the inverse of gdGenerateQuickBag, so it has to walk the SAME ladder
  // gdGenerateQuickBag walks. It used to read GD_DEFAULT_CLUB_CARRY_M instead, and
  // the two ladders do not agree: relative to the 7 iron the table has Driver +75
  // and 4H +25, the generator has +90 and +35. Only PW matched. So a driver-only
  // import measured at 245m implied a 170m 7 iron, and the bag generated from that
  // handed the driver back 260m - the app silently telling the player they hit it
  // 15m further than they just did. 9i was +3m out, SW +1m, and so on.
  //
  // Deriving the offset from the generator makes the round trip exact by
  // construction and leaves ONE ladder in play. GD_DEFAULT_CLUB_CARRY_M stays the
  // fallback for clubs the generator does not emit (4i, oddities, custom names).
  const GD_PRACTICE_SEVEN_REF_CARRY=155;
  let gdPracticeQuickBagOffsetCache=null;
  function gdPracticeQuickBagOffsets(){
    if(gdPracticeQuickBagOffsetCache)return gdPracticeQuickBagOffsetCache;
    const rows=gdShotBubbleSafe(()=>typeof gdGenerateQuickBag==="function"?gdGenerateQuickBag(GD_PRACTICE_SEVEN_REF_CARRY):[],[])||[];
    const map={};
    rows.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row?.club);
      const carry=Number(row?.baseCarry);
      if(key&&Number.isFinite(carry))map[key]=carry-GD_PRACTICE_SEVEN_REF_CARRY;
    });
    if(Object.keys(map).length)gdPracticeQuickBagOffsetCache=map;
    return map;
  }
  function gdPracticeClubDefaultSevenCarry(club,carry){
    const c=String(club||"").trim();
    const n=Number(carry);
    if(!c||!Number.isFinite(n)||n<=0)return NaN;
    const offsets=gdPracticeQuickBagOffsets();
    const key=gdShotBubbleOverlayClubKey(c);
    if(key&&Number.isFinite(offsets[key]))return n-offsets[key];
    const defaultClub=gdShotBubbleSafe(()=>typeof gdDefaultCarryForClub==="function"?gdDefaultCarryForClub(c):NaN,NaN);
    const defaultSeven=Number(typeof GD_DEFAULT_BAG_7I_CARRY!=="undefined"?GD_DEFAULT_BAG_7I_CARRY:155)||155;
    if(!Number.isFinite(defaultClub)||defaultClub<=0)return NaN;
    return n-(defaultClub-defaultSeven);
  }
  function gdPracticeTrueDistanceEvidenceRows(analysis){
    const accepted=Array.isArray(analysis?.acceptedShots)?analysis.acceptedShots:[];
    const fallback=accepted.length?[]:gdPracticeEvidenceRows(analysis).filter(row=>!row.excluded&&!row.plotDeselected);
    const source=accepted.length?accepted:fallback;
    const groups={};
    source.forEach(shot=>{
      const club=String(shot?.club||"Unknown").trim()||"Unknown";
      const key=gdShotBubbleOverlayClubKey(club);
      const carry=accepted.length?gdPracticeShotActualDistance(shot):Number(shot?.actualDistanceM);
      if(!key||!Number.isFinite(carry)||carry<20||carry>330)return;
      groups[key]=groups[key]||{club,values:[],shots:[]};
      groups[key].values.push(Number(carry));
      groups[key].shots.push(shot);
    });
    return Object.values(groups).map(group=>{
      const values=group.values.slice().sort((a,b)=>a-b);
      const carry=gdShotBubbleMedian(values);
      const deviations=values.map(value=>Math.abs(value-carry));
      return{
        club:group.club,
        clubKey:gdShotBubbleOverlayClubKey(group.club),
        trueDistanceM:Math.round(carry),
        count:values.length,
        spreadM:Math.round(gdShotBubbleMedian(deviations)||0),
        impliedSevenCarryM:Math.round(gdPracticeClubDefaultSevenCarry(group.club,carry)||0)
      };
    }).filter(row=>row.count>=2&&Number.isFinite(Number(row.trueDistanceM))).sort((a,b)=>(b.count-a.count)||a.club.localeCompare(b.club,undefined,{numeric:true}));
  }
  function gdPracticeEstimatedSevenCarryFromEvidence(evidenceRows){
    const direct=(evidenceRows||[]).find(row=>gdShotBubbleOverlayClubKey(row.club)==="7i");
    if(direct&&Number.isFinite(Number(direct.trueDistanceM)))return Math.round(Number(direct.trueDistanceM));
    const implied=[];
    (evidenceRows||[]).forEach(row=>{
      const n=Number(row.impliedSevenCarryM);
      const count=Math.max(1,Math.min(5,Number(row.count)||1));
      if(Number.isFinite(n)&&n>=80&&n<=210){
        for(let i=0;i<count;i++)implied.push(n);
      }
    });
    const value=gdShotBubbleMedian(implied);
    return Number.isFinite(value)&&value>0?Math.round(value):NaN;
  }
  const GD_PRACTICE_DISTANCE_LINK_CLUB_KEY="gd_practice_distance_link_club_v1";
  function gdPracticeStoredDistanceLinkClub(){
    try{return String(localStorage.getItem(GD_PRACTICE_DISTANCE_LINK_CLUB_KEY)||"").trim();}
    catch(e){return"";}
  }
  function gdPracticeBestDistanceLink(analysis,evidenceRows=null){
    const evidence=Array.isArray(evidenceRows)?evidenceRows:gdPracticeTrueDistanceEvidenceRows(analysis);
    if(!evidence.length)return null;
    const storedKey=gdShotBubbleOverlayClubKey(gdPracticeStoredDistanceLinkClub());
    if(storedKey){
      const stored=evidence.find(row=>gdShotBubbleOverlayClubKey(row.club)===storedKey);
      if(stored)return stored;
    }
    const source=gdPracticeBubbleSource(analysis);
    const anchorKey=gdShotBubbleOverlayClubKey(source?.club||analysis?.methods?.resultScaledCluster?.anchorClub);
    if(anchorKey){
      const anchor=evidence.find(row=>gdShotBubbleOverlayClubKey(row.club)===anchorKey);
      if(anchor)return anchor;
    }
    return evidence.slice().sort((a,b)=>(b.count-a.count)||(a.spreadM-b.spreadM)||a.club.localeCompare(b.club,undefined,{numeric:true}))[0]||null;
  }
  function gdPracticeSetDistanceLinkClub(club){
    const value=String(club||"").trim();
    try{
      if(value)localStorage.setItem(GD_PRACTICE_DISTANCE_LINK_CLUB_KEY,value);
      else localStorage.removeItem(GD_PRACTICE_DISTANCE_LINK_CLUB_KEY);
    }catch(e){}
    gdPracticeBagSuggestionOpen=true;
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeEstimatedBagRowsFromEvidence(analysis){
    const evidence=gdPracticeTrueDistanceEvidenceRows(analysis);
    const link=gdPracticeBestDistanceLink(analysis,evidence);
    const seven=link?Number(link.impliedSevenCarryM):gdPracticeEstimatedSevenCarryFromEvidence(evidence);
    if(!Number.isFinite(seven)||seven<=0)return{rows:[],evidence,sevenCarryM:null};
    const base=gdShotBubbleSafe(()=>typeof gdGenerateQuickBag==="function"?gdGenerateQuickBag(seven):[],[])||[];
    const rows=gdBagSortRows(base.map(row=>{
      const carry=Math.max(1,Math.round(Number(row.baseCarry)||0));
      return Object.assign({},row,{baseCarry:carry,totalM:gdBagTotalForCarry(row.club,carry)});
    }));
    return{rows,evidence,sevenCarryM:Math.round(seven),link};
  }
  function gdPracticeSuggestedCarryRows(analysis){
    const estimate=gdPracticeEstimatedBagRowsFromEvidence(analysis);
    const estimatedRows=estimate.rows||[];
    if(!estimatedRows.length)return[];
    const saved=gdPracticeHasUserBag()?gdPracticeRawSavedBagRows():[];
    const savedByKey={};
    saved.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key)savedByKey[key]=row;
    });
    const directEvidenceByKey={};
    (estimate.evidence||[]).forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key)directEvidenceByKey[key]=row;
    });
    return estimatedRows.map(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      const current=savedByKey[key];
      const suggested=Math.round(Number(row.baseCarry)||0);
      const currentCarry=current?Math.round(Number(current.baseCarry)||0):null;
      const diff=currentCarry==null?null:suggested-currentCarry;
      const evidence=directEvidenceByKey[key]||null;
      const linkKey=gdShotBubbleOverlayClubKey(estimate.link?.club);
      const shouldShow=!saved.length||currentCarry==null||Math.abs(diff)>=6||Math.abs(diff)/Math.max(1,currentCarry)>=.045||evidence;
      if(!shouldShow)return null;
      return{
        club:row.club,
        currentCarry,
        suggestedCarry:suggested,
        middleCarry:currentCarry==null?suggested:Math.round((currentCarry+suggested)/2),
        diff,
        evidenceCount:Number(evidence?.count||row.practiceEvidenceCount||0),
        evidenceCarry:evidence?Number(evidence.trueDistanceM):null,
        linkClub:estimate.link?.club||"",
        linkDistanceM:Number(estimate.link?.trueDistanceM)||null,
        isLink:!!(linkKey&&key===linkKey),
        estimated:!evidence
      };
    }).filter(Boolean);
  }
  function gdPracticeSuggestionRowsForApply(mode){
    const estimate=gdPracticeEstimatedBagRowsFromEvidence(gdPracticeProjectionReadyAnalysis());
    const estimated=estimate.rows||[];
    const saved=gdPracticeRawSavedBagRows();
    const savedByKey={};
    saved.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key)savedByKey[key]=row;
    });
    if(mode==="middle"&&saved.length){
      return gdBagSortRows(estimated.map(row=>{
        const key=gdShotBubbleOverlayClubKey(row.club);
        const current=savedByKey[key];
        const suggested=Math.round(Number(row.baseCarry)||0);
        const carry=current?Math.round((Math.round(Number(current.baseCarry)||suggested)+suggested)/2):suggested;
        return{club:row.club,baseCarry:carry,totalM:gdBagTotalForCarry(row.club,carry)};
      }));
    }
    return estimated.map(row=>({club:row.club,baseCarry:Math.round(Number(row.baseCarry)||0),totalM:gdBagTotalForCarry(row.club,Math.round(Number(row.baseCarry)||0))}));
  }
  function gdPracticePrefillRows(analysis){
    const estimate=gdPracticeEstimatedBagRowsFromEvidence(analysis);
    const rows=estimate.rows||[];
    const saved=gdPracticeHasUserBag()?gdPracticeRawSavedBagRows():[];
    const savedByKey={};
    saved.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key)savedByKey[key]=row;
    });
    return rows.map(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      const current=savedByKey[key]||null;
      const suggested=Math.round(Number(row.baseCarry)||0);
      const currentCarry=current?Math.round(Number(current.baseCarry)||0):null;
      return{
        club:row.club,
        currentCarry,
        suggestedCarry:suggested,
        diff:currentCarry==null?null:suggested-currentCarry,
        link:!!(key&&key===gdShotBubbleOverlayClubKey(estimate.link?.club))
      };
    });
  }
  function gdPracticeBagSuggestionSignature(estimate,prefillRows,hasBag){
    const link=estimate?.link||{};
    const linkPart=`${link.club||""}:${Math.round(Number(link.trueDistanceM)||0)}`;
    const rowPart=(Array.isArray(prefillRows)?prefillRows:[]).map(row=>`${row.club}:${row.currentCarry??""}:${row.suggestedCarry}`).join("|");
    return `${hasBag?"bag":"no-bag"}::${linkPart}::${rowPart}`;
  }
  function gdPracticeCurrentBagSuggestionSignature(){
    const analysis=gdPracticeProjectionReadyAnalysis();
    const estimate=gdPracticeEstimatedBagRowsFromEvidence(analysis);
    const prefillRows=gdPracticePrefillRows(analysis);
    if(!prefillRows.length)return"";
    return gdPracticeBagSuggestionSignature(estimate,prefillRows,gdPracticeHasUserBag());
  }
  function gdPracticeBagSuggestionSeen(signature){
    const value=String(signature||"");
    if(!value)return true;
    try{return localStorage.getItem(GD_PRACTICE_BAG_SUGGESTION_SEEN_KEY)===value;}
    catch(e){return false;}
  }
  function gdPracticeMarkBagSuggestionSeen(signature=gdPracticeCurrentBagSuggestionSignature()){
    const value=String(signature||"");
    if(!value)return false;
    try{localStorage.setItem(GD_PRACTICE_BAG_SUGGESTION_SEEN_KEY,value);}catch(e){}
    return true;
  }
  function gdPracticeToggleBagAdapt(force){
    gdPracticeBagSuggestionOpen=true;
    gdPracticeBagAdaptOpen=typeof force==="boolean"?force:!gdPracticeBagAdaptOpen;
    gdPracticeBagAdaptUndoStack=[];
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeBagAdaptRemember(input){
    if(!input)return false;
    if(!Object.prototype.hasOwnProperty.call(input.dataset,"lastValue"))input.dataset.lastValue=String(input.value||"");
    return false;
  }
  function gdPracticeBagAdaptChanged(input){
    if(!input)return false;
    const club=String(input.dataset.gdPracticeAdaptClub||"").trim();
    const previous=Object.prototype.hasOwnProperty.call(input.dataset,"lastValue")?String(input.dataset.lastValue||""):"";
    const next=String(input.value||"");
    if(club&&previous!==next){
      gdPracticeBagAdaptUndoStack.push({club,value:previous});
      if(gdPracticeBagAdaptUndoStack.length>60)gdPracticeBagAdaptUndoStack.shift();
      input.dataset.lastValue=next;
    }
    return false;
  }
  function gdPracticeUndoBagAdapt(){
    const step=gdPracticeBagAdaptUndoStack.pop();
    if(!step){
      gdLmToast("Nothing to undo");
      return false;
    }
    const input=[...document.querySelectorAll("[data-gd-practice-adapt-club]")].find(item=>String(item.dataset.gdPracticeAdaptClub||"")===step.club);
    if(!input){
      gdLmToast("Field no longer visible");
      return false;
    }
    input.value=step.value;
    input.dataset.lastValue=String(step.value||"");
    input.focus();
    try{input.select?.();}catch(e){}
    return false;
  }
  function gdPracticeAdaptedBagRowsFromDOM(){
    const rows=[];
    document.querySelectorAll("[data-gd-practice-adapt-club]").forEach(input=>{
      const club=String(input.dataset.gdPracticeAdaptClub||"").trim();
      const carry=Math.round(Number(input.value)||0);
      if(!club||carry<=0)return;
      rows.push({club,baseCarry:carry,totalM:gdBagTotalForCarry(club,carry)});
    });
    return gdBagSortRows(rows);
  }
  function gdPracticeApplyBagSuggestions(mode){
    const action=String(mode||"suggested");
    /* "keep" changes nothing, so it never has to ask - refusing to leave a bag
       alone would be an odd thing to charge for. */
    if(action!=="keep"&&window.ClarityPayments?.requireAccess
       &&!window.ClarityPayments.requireAccess("apply practice distances to your bag"))return false;
    if(action==="keep"){
      gdPracticeBagSuggestionOpen=false;
      gdPracticeBagAdaptOpen=false;
      gdPracticeBagAdaptUndoStack=[];
      gdLmToast("Bag left unchanged");
      return gdPracticeRefreshProjectionSurfaces();
    }
    const rows=action==="adapted"?gdPracticeAdaptedBagRowsFromDOM():gdPracticeSuggestionRowsForApply(action);
    if(!rows.length){
      gdLmToast("No distance suggestion ready");
      return false;
    }
    if(typeof gdBagPersistRows==="function")gdBagPersistRows(rows,{silent:true,render:false});
    else safe(()=>{
      const p=ensureProfile();
      p.bag=rows;
      p.bagSlotsTouched=true;
      p.bagSeededDefault=false;
      savePlayerProfiles();
      syncCoreProfileFromActive();
    });
    gdPracticeSyncBubbleSourcesToBag({skipRender:true});
    gdPracticeBagSuggestionOpen=false;
    gdPracticeBagAdaptOpen=false;
    gdPracticeBagAdaptUndoStack=[];
    safe(()=>typeof renderBagPanel==="function"&&renderBagPanel());
    safe(()=>typeof renderProfilePanel==="function"&&renderProfilePanel());
    safe(()=>typeof renderShot==="function"&&renderShot());
    gdLmToast(action==="adapted"?"Adapted bag saved":"Bag distances adopted");
    return gdPracticeRefreshProjectionSurfaces();
  }
  // Auto-bag from the shots themselves.
  //
  // With no real bag this chart has no legitimate anchor: everything is plotted as a
  // percentage of the anchor, and a seeded ghost bag is not allowed to stand in for
  // one (Bubble Bible s4, trap 3 - anchoring to stand-in numbers is the same sin as
  // drawing a stand-in bubble). The practice import IS a real measurement, so it can
  // supply the bag instead of the player being asked for one before they can see
  // anything.
  //
  // No new estimator: this is the same chain the distance-suggestion panel already
  // runs - per-club medians -> implied 7 iron -> gdGenerateQuickBag - just applied
  // without waiting for a click. gdBagPersistRows clears bagSeededDefault and sets
  // bagSlotsTouched, so the result reads as a real bag from here on and the anchor
  // has something fixed to sit on.
  let gdPracticeAutoBagInFlight=false;
  function gdPracticeAutoBagFromData(analysis){
    // gdBagPersistRows re-enters through gdPracticeSyncBubbleSourcesToBag; without
    // this the first render would recurse.
    if(gdPracticeAutoBagInFlight)return false;
    if(safe(()=>gdPracticeHasUserBag(),false))return false;
    const estimate=safe(()=>gdPracticeEstimatedBagRowsFromEvidence(analysis),null);
    const rows=estimate?.rows||[];
    if(!rows.length)return false;
    gdPracticeAutoBagInFlight=true;
    try{
      const persist=gdBagSortRows(rows.map(row=>{
        const carry=Math.max(1,Math.round(Number(row.baseCarry)||0));
        return{club:row.club,baseCarry:carry,totalM:gdBagTotalForCarry(row.club,carry)};
      }));
      if(typeof gdBagPersistRows==="function")gdBagPersistRows(persist,{silent:true,render:false});
      else safe(()=>{
        const p=ensureProfile();
        p.bag=persist;
        p.bagSlotsTouched=true;
        p.bagSeededDefault=false;
        savePlayerProfiles();
        syncCoreProfileFromActive();
      });
      // Provenance, so the panel can say where these numbers came from and a later
      // real bag edit can be told apart from this.
      safe(()=>{
        const p=ensureProfile();
        p.bagSource="practice-data";
        p.bagSourceSevenCarryM=Number(estimate?.sevenCarryM)||null;
        p.bagSourceLinkClub=String(estimate?.link?.club||"")||null;
        savePlayerProfiles();
        syncCoreProfileFromActive();
      });
      gdPracticeSyncBubbleSourcesToBag({skipRender:true});
      gdLmToast("Set generated from data");
    }finally{
      gdPracticeAutoBagInFlight=false;
    }
    return true;
  }
  function gdPracticeBagGeneratedFromData(){
    const p=safe(()=>ensureProfile(),null)||{};
    return p.bagSource==="practice-data";
  }
  function gdPracticeBagSuggestionHTML(analysis){
    const hasBag=gdPracticeHasUserBag();
    const estimate=gdPracticeEstimatedBagRowsFromEvidence(analysis);
    const prefillRows=gdPracticePrefillRows(analysis);
    if(!prefillRows.length)return"";
    const rows=gdPracticeSuggestedCarryRows(analysis);
    const link=estimate.link||null;
    const evidence=estimate.evidence||[];
    const linkChoices=evidence.length>1?`<div class="gdPracticeDistanceLinkChoices">${evidence.map(row=>`<button type="button" class="${gdShotBubbleOverlayClubKey(row.club)===gdShotBubbleOverlayClubKey(link?.club)?"active":""}" onclick="return gdPracticeSetDistanceLinkClub(${gdPracticeJsArg(row.club)})">${gdEscapeHTML(row.club)} / ${Math.round(Number(row.trueDistanceM)||0)}m</button>`).join("")}</div>`:"";
    const previewRows=prefillRows.slice(0,12);
	    const signature=gdPracticeBagSuggestionSignature(estimate,prefillRows,hasBag);
	    const notify=!gdPracticeBagSuggestionSeen(signature);
	    if(!gdPracticeBagSuggestionOpen){
	      return `<button type="button" class="gdPracticeBagSuggestionIcon ${notify?"unseen":""} ${hasBag?"hasBag":"noBag"}" aria-label="Open bag distance suggestions" onclick="return gdPracticeToggleBagSuggestions(true)"><span class="gdPracticeBagSuggestionIconFrame"><img src="assets/home/bag.png?v=ae58e8eb" alt=""></span></button>`;
	    }
    const body=previewRows.map(row=>{
      const currentValue=row.currentCarry==null?"":String(Math.round(Number(row.currentCarry)||0));
      const current=gdPracticeBagAdaptOpen
        ? `<input type="number" min="1" step="1" value="${gdEscapeHTML(currentValue)}" placeholder="m" data-gd-practice-adapt-club="${gdEscapeHTML(row.club)}" aria-label="${gdEscapeHTML(row.club)} current bag distance" onfocus="gdPracticeBagAdaptRemember(this)" oninput="gdPracticeBagAdaptChanged(this)">`
        : `<span class="gdPracticeCurrentCell ${row.currentCarry==null?"empty":"readonly"}">${gdEscapeHTML(row.currentCarry==null?"Empty":`${row.currentCarry}m`)}</span>`;
      const suggestion=`<span class="gdPracticeSuggestedSide">${Math.round(Number(row.suggestedCarry)||0)}m</span>`;
      const delta=Number.isFinite(Number(row.diff))?(row.diff>0?`+${row.diff}m`:`${row.diff}m`):"new";
      return `<div class="gdPracticeBagSuggestionRow ${row.link?"link":""} ${gdPracticeBagAdaptOpen?"editable":"locked"}"><strong>${gdEscapeHTML(row.club)}</strong>${current}${suggestion}<b>${gdEscapeHTML(delta)}</b></div>`;
    }).join("");
    const actions=gdPracticeBagAdaptOpen
      ? `<button type="button" onclick="return gdPracticeApplyBagSuggestions('adapted')">Save adapted</button><button type="button" onclick="return gdPracticeUndoBagAdapt()">Undo</button><button type="button" onclick="return gdPracticeToggleBagAdapt(false)">Back</button>`
      : (hasBag
        ? `<button type="button" onclick="return gdPracticeApplyBagSuggestions('suggested')">Adopt</button><button type="button" onclick="return gdPracticeToggleBagAdapt(true)">Adapt</button><button type="button" onclick="return gdPracticeApplyBagSuggestions('keep')">Not now</button>`
        : `<button type="button" onclick="return gdPracticeApplyBagSuggestions('suggested')">Adopt</button><button type="button" onclick="return gdPracticeApplyBagSuggestions('keep')">Not now</button>`);
	    const linkCopy=link?`<div class="gdPracticeDistanceLink"><span>Distance link</span><strong>${gdEscapeHTML(link.club)} / ${Math.round(Number(link.trueDistanceM)||0)}m</strong></div>`:"";
	    const generatedCopy=gdPracticeBagGeneratedFromData()?`<div class="gdPracticeBagGeneratedNote">Set generated from data</div>`:"";
	    return `<div class="gdPracticeBagSuggestionPanel ${hasBag?"hasBag":"noBag"} ${gdPracticeBagAdaptOpen?"adapt":""}"><div class="gdPracticeBagSuggestionHead"><div class="gdPracticeBagSuggestionTitle"><img src="assets/home/bag.png?v=ae58e8eb" alt=""><span>Bag</span></div><button type="button" aria-label="Close" onclick="return gdPracticeToggleBagSuggestions(false)">×</button></div>${generatedCopy}${linkCopy}${linkChoices}<div class="gdPracticeBagSuggestionGrid"><span>Club</span><span>${gdPracticeBagAdaptOpen?"Edit current":hasBag?"Current":"Bag"}</span><span>Suggested</span><span>Diff</span>${body}</div><div class="gdPracticeBagSuggestionActions">${actions}</div></div>`;
	  }
	  function gdPracticeBagSuggestionNoticeHTML(analysis){
	    if(gdPracticeBagSuggestionOpen)return"";
	    const hasBag=gdPracticeHasUserBag();
	    const estimate=gdPracticeEstimatedBagRowsFromEvidence(analysis);
	    const prefillRows=gdPracticePrefillRows(analysis);
	    if(!prefillRows.length)return"";
	    const signature=gdPracticeBagSuggestionSignature(estimate,prefillRows,hasBag);
	    if(gdPracticeBagSuggestionSeen(signature))return"";
	    return `<div class="gdPracticeBagSuggestionNoticeRow"><button type="button" class="gdPracticeBagSuggestionNotice ${hasBag?"hasBag":"noBag"}" onclick="return gdPracticeToggleBagSuggestions(true)">Distance Suggestion Available</button></div>`;
	  }

  function gdPracticeProjectionControlsHTML(analysis){
    const ctx=gdPracticeProjectionContext(analysis);
    const p=safe(()=>ensureProfile(),null);
    // "Adopted" must mean THIS bubble, not "a bubble was adopted once".
    // gdPracticePlayingBubbleIsAdopted only checks that a source is active and its
    // offset matches the profile - it knows nothing about the live analysis, so
    // once anything had been saved the dock locked to Adopted/Saved forever, even
    // after new shots produced a completely different practice bubble. The
    // fingerprint-aware check is the one that answers the real question.
    const adopted=gdPracticeCurrentBubbleWasAdopted(p,analysis);
    // A bubble is saved, but it is NOT the one on screen - so adopting is available
    // again and will replace it.
    const hasStaleSaved=!adopted&&gdPracticePlayingBubbleIsAdopted(p);
    const pending=p?.practiceBubblePendingSource||null;
    // A pending stage counts toward the button's toggle state only while it
    // still matches the CURRENTLY live practice bubble - if the underlying
    // shots/analysis moved on since staging, treat it as stale rather than
    // showing "Unadopt" for a bubble that's no longer what's on screen.
    const pendingActive=!!(pending&&pending.active&&pending.fingerprint===gdPracticeBubbleFingerprint(analysis));
    const generated=ctx.canProject&&ctx.visible;
    // ADOPT -> SAVE is the flow. Adopt stages a pending bubble (undoable), Save
    // commits it to My Bubble (not undoable). The old "Generate Bubble" button is
    // gone: its only job was switching the overlay on, and adopting never needed
    // the overlay to be visible - so adopt now depends on canProject alone,
    // otherwise removing Generate would have left it permanently disabled.
    const savedLocked=adopted&&!pendingActive;
    const saveDisabled=pendingActive?"":"disabled";
    const saveLabel=savedLocked?"Saved":"Save Bubble";
    const adoptDisabled=pendingActive?"":(ctx.canProject&&!adopted?"":"disabled");
	    const tone=generated?"generated":ctx.canProject?"ready":"waiting";
	    const adoptLabel=pendingActive?"Undo":adopted?"Adopted":"Adopt";
	    const adoptAction=pendingActive?"gdPracticeUnadoptBubbleFromAction()":"gdPracticeAdoptBubbleFromAction()";
	    // The state line is the "locked in" feedback: it has to be unambiguous that
	    // Undo has stopped being an option once Save has been pressed.
	    const adoptStatus=pendingActive
	      ?`<div class="gdPracticeAdoptStatus pending"><strong>Direction adopted, not saved</strong><span>Review the distance suggestions in the bag, then Save to lock it in — or Undo to drop it.</span></div>`
	      :savedLocked
	        ?`<div class="gdPracticeAdoptStatus saved"><strong>Saved to My Bubble</strong><span>Locked in — Undo is no longer available. Adopt a new bubble to replace it.</span></div>`
	        :hasStaleSaved
	          ?`<div class="gdPracticeAdoptStatus fresh"><strong>New practice bubble</strong><span>This is not the bubble you saved. Adopting replaces it.</span></div>`
	          :"";
	    const bagSuggestion=gdPracticeBagSuggestionHTML(analysis);
	    const bagNotice=gdPracticeBagSuggestionNoticeHTML(analysis);
	    return `<div class="gdPracticeActionDock ${tone} ${bagSuggestion?"hasBagSuggestion":""} ${gdPracticeBagSuggestionOpen?"bagOpen":""}"><div class="gdPracticePrimaryActions"><button type="button" class="gdPracticeBubbleAction save ${pendingActive?"ready":""} ${savedLocked?"locked":""}" ${saveDisabled} onclick="return gdPracticeSaveBubbleFromAction()">${gdEscapeHTML(saveLabel)}</button><button type="button" class="gdPracticeBubbleAction adopt ${adopted?"adopted":""} ${pendingActive?"pending":""}" aria-pressed="${adopted||pendingActive?"true":"false"}" ${adoptDisabled} onclick="return ${adoptAction}">${gdEscapeHTML(adoptLabel)}</button></div>${adoptStatus}${bagSuggestion?`<div class="gdPracticeBagSuggestionSlot">${bagSuggestion}</div>`:""}</div>${gdPracticeSandboxControlsHTML("compact")}${bagNotice}`;
	  }
	  function gdRenderPracticeProjectionControls(analysis){
	    const root=byId("gdPracticeProjectionControls");
	    if(!root)return;
	    const ctx=gdPracticeProjectionContext(analysis);
    if(!ctx.canProject&&gdShotBubbleOverlayEnabled("practice")){
      gdShotBubbleOverlayState.practice=false;
      window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
      document.documentElement.dataset.gdOverlayPractice="off";
      ctx.visible=false;
      setTimeout(()=>gdSyncShotBubbleOverlayControls("practice"),0);
    }
	    root.classList.toggle("waiting",!ctx.canProject);
	    root.innerHTML=gdPracticeProjectionControlsHTML(analysis);
	  }
	  function gdPracticePlayingBubbleActionLabel(){
	    const p=safe(()=>ensureProfile(),null)||{};
	    if(gdPracticePlayingBubbleIsAdopted(p))return "Restore My Bubble";
	    return "Play With Practice Bubble";
	  }
	  function gdPracticePlayingBubbleIsAdopted(profile){
	    const p=profile||safe(()=>ensureProfile(),null)||{};
	    const source=p.practiceBubbleSource||{};
	    const current=Number(p.faceOffsetDeg??p.centralFaceOffsetDeg);
	    const adopted=Number(source.offsetDeg);
	    return !!source.active&&Number.isFinite(current)&&Number.isFinite(adopted)&&Math.abs(current-adopted)<.02;
	  }
  let gdMyBubbleLanePreviewSource=null;
  function gdMyBubbleLanePreviewPendingSource(){
    const preview=gdMyBubbleLanePreviewSource;
    const offset=Number(preview?.offsetDeg);
    return preview&&preview.active&&Number.isFinite(offset)?preview:null;
  }
  function gdSetMyBubbleLanePreviewPendingSource(source){
    if(!source||!source.active||!Number.isFinite(Number(source.offsetDeg))){
      gdMyBubbleLanePreviewSource=null;
      return null;
    }
    gdMyBubbleLanePreviewSource=Object.assign({},source,{temporary:true,previewOnly:true});
    return gdMyBubbleLanePreviewSource;
  }
  function gdClearMyBubbleLanePreviewPendingSource(){
    gdMyBubbleLanePreviewSource=null;
  }
  function gdPracticePendingBubbleSource(profile,opts={}){
    return opts.ignoreLanePreview
      ? ((profile||safe(()=>ensureProfile(),null)||{}).practiceBubblePendingSource||{})
      : (gdMyBubbleLanePreviewPendingSource()||(profile||safe(()=>ensureProfile(),null)||{}).practiceBubblePendingSource||{});
  }
	  function gdPracticePendingBubbleIsActive(profile){
	    const pending=gdPracticePendingBubbleSource(profile);
	    return !!pending.active&&Number.isFinite(Number(pending.offsetDeg));
	  }
	  function gdPracticeAutoFlowHTML(analysis){
	    return "";
	  }
	  function gdRenderPracticeAutoFlow(analysis){
	    const root=byId("gdPracticeDataResult");
	    if(!root)return;
	    const html=gdPracticeAutoFlowHTML(analysis);
	    root.hidden=!html;
	    root.innerHTML=html;
	  }
		  function gdPracticeAdoptBubbleAsPlayingBubble(mode="direction"){
		    const p=ensureProfile();
		    const analysis=gdPracticeProjectionReadyAnalysis();
		    const adoptDistance=String(mode||"direction")==="distance-direction";
		    const source=gdPracticeBubbleSource(analysis);
		    const method=gdPracticeBubbleMethod(analysis);
		    const offset=Number(source?.offsetDeg??method?.anchorDeg);
		    if(!Number.isFinite(offset)){
		      gdLmToast("Practice Bubble not ready");
		      return false;
		    }
	    const previousOffset=gdPracticeMyBubbleOffsetDeg(p);
	    const adoptedClub=source?.club||method?.anchorClub||gdCompareClub||"7i";
	    const adoptedKey=gdShotBubbleOverlayClubKey(adoptedClub)||"7i";
	    const distanceSummary=gdPracticeDistanceLearningSummary(analysis);
	    const beforeRowsByClub=gdPracticeBagRowsByClub(gdPracticeBagDraftRows());
	    const learnedRowsByClub=gdPracticeBagRowsByClub(distanceSummary.rows||[]);
	    const beforeDistance=Number(beforeRowsByClub[adoptedKey]?.actualDistanceM)||gdShotBubbleSafe(()=>gdDefaultCarryForClub(adoptedClub),155)||155;
	    const sourceDistance=Number(source?.baseDistanceM||source?.expectedDistanceM||source?.meanExpectedM);
	    const learnedDistance=Number(learnedRowsByClub[adoptedKey]?.actualDistanceM)||sourceDistance||beforeDistance;
	    const motionToDistance=adoptDistance?learnedDistance:beforeDistance;
	    const stagedSource={
	      active:true,
	      offsetDeg:Number(offset.toFixed(2)),
	      status:method?.status||"",
		      club:adoptedClub,
		      shots:Number(source?.shots||method?.countedShots||0),
		      fingerprint:gdPracticeBubbleFingerprint(analysis),
		      distanceMode:adoptDistance?"committed":"review",
		      practiceDistanceM:Number.isFinite(learnedDistance)&&learnedDistance>0?Math.round(learnedDistance*10)/10:null,
		      importBatchIds:Array.isArray(source?.importBatchIds)?source.importBatchIds.slice():[]
		    };
		    const adoptedBase=motionToDistance;
	    const adoptedRadius=Number(source?.lateralRadiusDeg);
	    const adoptedWidth=Number(source?.bubbleWidthM)||Number(source?.clusterWidthM)||(Number.isFinite(adoptedRadius)&&adoptedRadius>0?Math.tan(adoptedRadius*Math.PI/180)*Math.max(1,adoptedBase)*2:null);
	    const adoptedDepth=Number(source?.bubbleDepthM)||Number(source?.clusterDepthM)||Math.max(14,adoptedBase*.18);
	    const adoptedBubble=Object.assign({},source,{
	      club:adoptedClub,
	      baseCarry:adoptedBase,
	      baseDistanceM:adoptedBase,
	      faceOffsetDeg:offset,
	      faceAlignmentOffsetDeg:offset,
	      offsetDeg:offset,
	      bubbleWidthM:Number.isFinite(adoptedWidth)&&adoptedWidth>0?adoptedWidth:Math.max(10,adoptedBase*.14),
	      clusterWidthM:Number.isFinite(adoptedWidth)&&adoptedWidth>0?adoptedWidth:Math.max(10,adoptedBase*.14),
	      bubbleDepthM:adoptedDepth,
	      clusterDepthM:adoptedDepth,
	      handedness:p.handedness||"right",
	      practiceDistanceM:Number.isFinite(learnedDistance)&&learnedDistance>0?Math.round(learnedDistance*10)/10:null,
	      shapeSource:"practice-adopted"
	    });
	    p.practiceBubblePendingSource=Object.assign({},stagedSource,{bubble:adoptedBubble});
	    p.practiceBubblePendingAt=new Date().toISOString();
	    p.updatedAt=new Date().toISOString();
	    const distanceResult=adoptDistance?{changed:(distanceSummary.diffs||[]).length>0,committed:false,summary:distanceSummary}:gdPracticeApplyDistanceLearning(analysis,{commit:false});
	    savePlayerProfiles();
	    syncCoreProfileFromActive();
	    document.querySelectorAll(".gdBubbleFaceOffsetInput").forEach(input=>{input.dataset.editing="0";input.readOnly=true;input.value=gdMyBubbleDisplayLabel(gdMyBubbleState(p,analysis));});
	    gdPracticeBubbleAdoptionMotion={
	      at:Date.now(),
	      fromOffset:Number.isFinite(Number(previousOffset))?Number(previousOffset):0,
	      toOffset:offset,
	      fromDistance:beforeDistance,
	      toDistance:motionToDistance,
	      practiceDistance:learnedDistance,
	      fingerprint:gdPracticeBubbleFingerprint(analysis)
	    };
	    gdShotBubbleOverlayState.practice=false;
	    window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
	    document.documentElement.dataset.gdOverlayPractice="off";
	    gdRenderBubbleOffsetHub();
	    renderPracticeData(true);
	    renderDataHubStatus();
	    if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
	    renderCompareData();
	    setTimeout(()=>{
	      if(gdPracticeBubbleAdoptionMotion&&gdPracticeBubbleAdoptionMotion.fingerprint===gdPracticeBubbleFingerprint(gdPracticeProjectionReadyAnalysis())){
	        gdPracticeBubbleAdoptionMotion=null;
	        renderPracticeData(true);
	      }
	    },1500);
	    const distanceLabel=distanceResult.changed
	      ? adoptDistance?"Distance + direction ready to save":"Direction ready to save; distance sent to bag review"
	      : "Direction ready to save";
	    gdLmToast(distanceLabel);
	    return false;
	  }
	  function gdRenderComparePracticeProjector(ctx){
    const root=byId("gdComparePracticeProjector");
    if(!root)return false;
    // The Generate / Adopt Bubble + bag controls now live on the Practice
    // tab card while Comparison is expanded (see gdRenderDataHubCards).
    // Nothing is duplicated inside the comparison expansion any more.
    root.hidden=true;
    root.classList.remove("waiting");
    root.innerHTML="";
    return false;
  }
  function gdPracticeBubbleMethod(analysis){
    const method=analysis?.methods?.resultScaledCluster||null;
    const n=Number(method?.anchorDeg);
    if(method&&method.showToUser&&Number.isFinite(n))return method;
    const rec=analysis?.recommendation||null;
    const recOffset=Number(rec?.offsetDeg);
    const evidence=Array.isArray(rec?.evidence)?rec.evidence:[];
    if(rec?.showToUser&&evidence.includes("result_scaled_cluster")&&Number.isFinite(recOffset)){
      return Object.assign({},method||{},{
        method:"result_scaled_cluster",
        status:rec.status||method?.status||"result_only",
        anchorDeg:recOffset,
        anchorClub:method?.anchorClub||"",
        verificationClubs:Array.isArray(method?.verificationClubs)?method.verificationClubs:[],
        clubClusters:Array.isArray(method?.clubClusters)?method.clubClusters:[],
        showToUser:true
      });
    }
    return null;
  }
  function gdPracticeBubbleOffsetDeg(analysis){
    const method=gdPracticeBubbleMethod(analysis);
    const n=Number(method?.anchorDeg);
    return Number.isFinite(n)?n:null;
  }
  function gdPracticeHasBubbleOffset(value){
    return typeof value==="number"&&Number.isFinite(value);
  }
  function gdPracticeBubbleSourceLooksReal(source){
    if(!source||typeof source!=="object")return false;
    if(/placeholder|default|stand.?in|fallback/i.test(String(source.shapeSource||source.source||source.projectionSource||"")))return false;
    const carry=Number(source.baseDistanceM??source.expectedDistanceM??source.meanExpectedM??source.baseCarry??source.carry??source.actualDistanceM);
    const width=Number(source.bubbleWidthM??source.clusterWidthM??source.visualWidthM??source.lateralRadiusM);
    const depth=Number(source.bubbleDepthM??source.clusterDepthM??source.visualDepthM??source.depthRadiusM);
    const radius=Number(source.lateralRadiusDeg);
    return Number.isFinite(carry)&&carry>0&&(
      Number.isFinite(width)&&width>0||
      Number.isFinite(depth)&&depth>0||
      Number.isFinite(radius)&&radius>0
    );
  }
  function gdMyBubbleGpsSourceLooksRenderable(source){
    if(!source||typeof source!=="object")return false;
    const shapeSource=String(source.shapeSource||source.source||source.projectionSource||"");
    if(/placeholder|default|stand.?in|fallback|ghost|manual-profile/i.test(shapeSource))return false;
    const carry=Number(source.baseDistanceM??source.expectedDistanceM??source.meanExpectedM??source.baseCarry??source.carry??source.actualDistanceM);
    const depth=Number(source.bubbleDepthM??source.clusterDepthM??source.visualDepthM??source.depthM);
    const width=Number(source.bubbleWidthM??source.clusterWidthM??source.visualWidthM??source.widthM);
    const radius=Number(source.lateralRadiusDeg);
    return Number.isFinite(carry)&&carry>0&&
      Number.isFinite(depth)&&depth>0&&
      ((Number.isFinite(width)&&width>0)||(Number.isFinite(radius)&&radius>0));
  }
  function gdMyBubbleStrictGpsSource(source,opts={}){
    if(!gdMyBubbleGpsSourceLooksRenderable(source))return null;
    const offset=Number.isFinite(Number(opts.offsetDeg))?Number(opts.offsetDeg):Number(source.offsetDeg??source.faceOffsetDeg??source.faceAlignmentOffsetDeg);
    const baseDistance=Number(source.baseDistanceM??source.expectedDistanceM??source.meanExpectedM??source.baseCarry??source.carry??source.actualDistanceM);
    const depth=Number(source.bubbleDepthM??source.clusterDepthM??source.visualDepthM??source.depthM);
    const width=Number(source.bubbleWidthM??source.clusterWidthM??source.visualWidthM??source.widthM);
    const radius=Number(source.lateralRadiusDeg);
    if(!Number.isFinite(offset)||!Number.isFinite(baseDistance)||baseDistance<=0||!Number.isFinite(depth)||depth<=0)return null;
    if(!Number.isFinite(width)&&!Number.isFinite(radius))return null;
    const club=gdCompareClubKey(source.club||opts.club)||gdCompareClubKey(opts.club)||"7i";
    const next=Object.assign({},source,{
      club,
      offsetDeg:offset,
      faceOffsetDeg:offset,
      faceAlignmentOffsetDeg:offset,
      baseCarry:baseDistance,
      baseDistanceM:baseDistance,
      expectedDistanceM:baseDistance,
      meanExpectedM:baseDistance,
      bubbleDepthM:depth,
      clusterDepthM:depth,
      handedness:source.handedness||opts.handedness||"right"
    });
    if(Number.isFinite(width)&&width>0){
      next.bubbleWidthM=width;
      next.clusterWidthM=width;
    }else if(Number.isFinite(radius)&&radius>0){
      next.lateralRadiusDeg=radius;
      const computedWidth=Math.tan(radius*Math.PI/180)*baseDistance*2;
      if(Number.isFinite(computedWidth)&&computedWidth>0){
        next.bubbleWidthM=computedWidth;
        next.clusterWidthM=computedWidth;
      }
    }
    return next;
  }
  function gdGpsReadyMyBubbleSource(source,opts={}){
    const strict=gdMyBubbleStrictGpsSource(source,opts);
    if(!strict)return null;
    const offset=Number(strict.offsetDeg??strict.faceOffsetDeg??strict.faceAlignmentOffsetDeg);
    const baseDistance=Number(strict.baseDistanceM??strict.expectedDistanceM??strict.meanExpectedM??strict.baseCarry);
    if(!Number.isFinite(offset)||!Number.isFinite(baseDistance)||baseDistance<=0)return null;
    const club=gdCompareClubKey(strict.club||opts.club)||"7i";
    return Object.assign({},strict,{
      club,
      offsetDeg:offset,
      faceOffsetDeg:offset,
      faceAlignmentOffsetDeg:offset,
      baseCarry:baseDistance,
      baseDistanceM:baseDistance,
      expectedDistanceM:baseDistance,
      meanExpectedM:baseDistance,
      gpsReady:true
    });
  }
  function gdMyBubblePresentationMetrics(source,opts={}){
    const strict=gdGpsReadyMyBubbleSource(source,opts);
    if(!strict)return null;
    const club=gdCompareClubKey(opts.club||strict.club)||"7i";
    const offset=Number.isFinite(Number(opts.offsetDeg))?Number(opts.offsetDeg):Number(strict.offsetDeg);
    const sourceDistance=Number(strict.baseDistanceM||strict.expectedDistanceM||strict.meanExpectedM||strict.baseCarry);
    const distance=Number.isFinite(Number(opts.distanceM))?Number(opts.distanceM):sourceDistance;
    if(!Number.isFinite(distance)||distance<=0||!Number.isFinite(sourceDistance)||sourceDistance<=0)return null;
    const scale=distance/sourceDistance;
    const sourceWidth=gdMyBubbleScaledSourceMetric(strict,["bubbleWidthM","clusterWidthM","visualWidthM","widthM"],scale);
    const sourceDepth=gdMyBubbleScaledSourceMetric(strict,["bubbleDepthM","clusterDepthM","visualDepthM","depthM"],scale);
    const generated=gdShotBubbleSafe(()=>gdGeneratedShotBubbleForClub(club,distance,offset),null)||{};
    const generatedWidth=Number(generated.widthM||generated.bubbleWidthM||generated.clusterWidthM)||Math.max(10,distance*.14);
    const generatedDepth=Number(generated.depthM||generated.bubbleDepthM||generated.clusterDepthM)||Math.max(14,distance*.18);
    const width=Math.max(Number.isFinite(sourceWidth)&&sourceWidth>0?sourceWidth:0,generatedWidth);
    const depth=Math.max(Number.isFinite(sourceDepth)&&sourceDepth>0?sourceDepth:0,generatedDepth);
    if(!Number.isFinite(width)||width<=0||!Number.isFinite(depth)||depth<=0)return null;
    const presentation=gdBubblePresentationForRender(Object.assign({},strict,{
      club,
      distanceM:distance,
      offsetDeg:offset,
      handedness:strict.handedness||opts.handedness||"right",
      bubbleWidthM:width,
      clusterWidthM:width,
      bubbleDepthM:depth,
      clusterDepthM:depth
    }),{normalizeAxes:true});
    return {
      source:strict,
      club,
      offsetDeg:offset,
      distanceM:distance,
      sourceDistanceM:sourceDistance,
      scale,
      widthM:presentation.widthM,
      depthM:presentation.depthM,
      lateralRadiusM:presentation.lateralRadiusM,
      depthRadiusM:presentation.depthRadiusM,
      radiusM:presentation.radiusM,
      tiltDeg:presentation.tiltDeg,
      skewDeg:presentation.skewDeg,
      handedness:presentation.handedness
    };
  }
  function gdPracticeBubbleFingerprint(analysis){
    const ready=gdPracticeProjectionReadyAnalysis(analysis);
    if(!ready)return "";
    const method=gdPracticeBubbleMethod(ready);
    const offset=gdPracticeBubbleOffsetDeg(ready);
    const accepted=Array.isArray(ready.acceptedShots)?ready.acceptedShots:[];
    const totals=ready.totals||{};
    const timestamps=accepted.map(shot=>Date.parse(shot?.timestamp||shot?.startedAt||shot?.createdAt||"")).filter(Number.isFinite).sort((a,b)=>b-a);
    const clubs=[...new Set(accepted.map(shot=>String(shot?.club||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).join(",");
    return [
      Number.isFinite(offset)?Number(offset).toFixed(2):"",
      String(method?.anchorClub||""),
      Number(method?.countedShots||method?.shots||0)||0,
      Number(totals.rawShots||totals.acceptedShots||accepted.length||0)||0,
      timestamps[0]||0,
      clubs
    ].join("|");
  }
  function gdPracticeCurrentBubbleWasAdopted(profile,analysis){
    const p=profile||safe(()=>ensureProfile(),null)||{};
    const source=p.practiceBubbleSource||{};
    if(!gdPracticePlayingBubbleIsAdopted(p))return false;
    const currentFingerprint=gdPracticeBubbleFingerprint(analysis);
    if(source.fingerprint&&currentFingerprint)return source.fingerprint===currentFingerprint;
    const currentOffset=gdPracticeBubbleOffsetDeg(gdPracticeProjectionReadyAnalysis(analysis));
    const adoptedOffset=Number(source.offsetDeg);
    return Number.isFinite(currentOffset)&&Number.isFinite(adoptedOffset)&&Math.abs(currentOffset-adoptedOffset)<.02;
  }
  function gdPracticeMyBubbleState(profile,analysis){
    const p=profile||safe(()=>ensureProfile(),null)||{};
    const pendingSource=gdPracticePendingBubbleSource(p);
    const pendingOffset=Number(pendingSource.offsetDeg);
    if(pendingSource.active&&Number.isFinite(pendingOffset)){
      return{offset:pendingOffset,kind:"pending",label:"Save My Bubble",graphLabel:"MY"};
    }
    const adoptedSource=p.practiceBubbleSource||{};
    const adoptedOffset=Number(adoptedSource.offsetDeg);
    const currentAdopted=gdPracticeCurrentBubbleWasAdopted(p,analysis);
    if(adoptedSource.active&&Number.isFinite(adoptedOffset)){
      return{offset:adoptedOffset,kind:currentAdopted?"adopted-current":"saved",label:currentAdopted?"My Bubble active":"My Bubble saved",graphLabel:"MY"};
    }
    const defaultState={offset:0,kind:"default",label:"Default My Bubble",graphLabel:"DEFAULT"};
    if(!p||p.placeholderProfile)return defaultState;
    const sources=[];
    if(p.previewBubbleSet)sources.push(p.previewBubbleSet);
    if(p.bubbleProfiles&&typeof p.bubbleProfiles==="object"){
      try{Object.values(p.bubbleProfiles).forEach(source=>sources.push(source));}catch(e){}
    }
    if(!sources.some(gdPracticeBubbleSourceLooksReal))return defaultState;
    const offset=Number(p.faceOffsetDeg??p.centralFaceOffsetDeg??p.previewBubbleSet?.faceOffsetDeg??p.previewBubbleSet?.faceAlignmentOffsetDeg??p.previewBubbleSet?.offsetDeg);
    return Number.isFinite(offset)?{offset,kind:"saved",label:"My Bubble saved",graphLabel:"MY"}:defaultState;
  }
  function gdPracticeMyBubbleOffsetDeg(profile){
    const state=gdPracticeMyBubbleState(profile,gdPracticeProjectionReadyAnalysis());
    const offset=Number(state?.offset);
    return Number.isFinite(offset)?offset:0;
  }
  function gdMyBubbleState(profile,analysis){
    const p=profile||safe(()=>ensureProfile(),null)||{};
    const state=gdPracticeMyBubbleState(p,analysis||gdPracticeProjectionReadyAnalysis());
    if(state&&Number.isFinite(Number(state.offset)))return state;
    const offset=gdProfileCentralOffset(p,0);
    return{offset:Number.isFinite(Number(offset))?Number(offset):0,kind:"default",label:"Default My Bubble",graphLabel:"DEFAULT"};
  }
  function gdMyBubbleDisplayLabel(state,editing=false){
    if(editing)return"Manual centre";
    const kind=String(state?.kind||"");
    if(kind==="default")return"Default";
    if(kind==="pending")return"Save My Bubble";
    if(kind==="adopted-current")return"My Bubble active";
    if(kind==="saved")return"My Bubble saved";
    return state?.label||"My Bubble";
  }
  function gdPracticeProjectionSelectedClubNames(analysis,dataRows){
    const names=new Set();
    const selectedIds=safe(()=>Object.keys(gdPracticeEvidenceSelectedShots||{}).filter(Boolean),[])||[];
    if(selectedIds.length&&typeof gdPracticeEvidenceRows==="function"){
      const rows=safe(()=>gdPracticeEvidenceRows(analysis),[])||[];
      rows.forEach(row=>{if(selectedIds.includes(row.shotId)&&row.club)names.add(String(row.club));});
    }
    const stored=gdPracticeProjectionStoredClub();
    if(!names.size&&stored)names.add(stored);
    const active=safe(()=>String(gdPracticeEvidenceActiveClub||""),"");
    if(!names.size&&active)names.add(active);
    const method=gdPracticeBubbleMethod(analysis);
    if(!names.size&&method?.anchorClub)names.add(String(method.anchorClub));
    (dataRows||[]).forEach(row=>{if(!names.size&&row?.club)names.add(String(row.club));});
    return [...names].filter(Boolean);
  }
  function gdPracticeProjectionRows(dataRows,analysis){
    const mode=gdPracticeProjectionMode();
    const offset=gdPracticeBubbleOffsetDeg(analysis);
    if(!gdPracticeHasBubbleOffset(offset))return [];
    const bagRows=gdPracticeProjectionBagRows(dataRows);
    const fallbackRows=gdShotBubbleOverlayReferenceRows(dataRows);
    if(mode==="all")return (bagRows.length?bagRows:fallbackRows).filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
    const selected=gdPracticeProjectionSelectedClubNames(analysis,dataRows).map(gdShotBubbleOverlayClubKey).filter(Boolean);
    if(!selected.length)return fallbackRows;
    const byClub={};
    bagRows.concat(fallbackRows).forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key&&!byClub[key])byClub[key]=row;
    });
    const selectedRows=selected.map(key=>byClub[key]).filter(row=>row&&Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
    return selectedRows.length?selectedRows:fallbackRows.filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
  }
  function gdPracticeOffsetHubRows(dataRows,analysis){
    const mode=gdPracticeProjectionMode();
    if(mode==="all")return gdPracticeProjectionBagRows(dataRows).filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
    const selected=gdPracticeProjectionSelectedClubNames(analysis,dataRows).map(gdShotBubbleOverlayClubKey).filter(Boolean);
    const sourceRows=gdPracticeProjectionBagRows(dataRows).concat(gdShotBubbleOverlayReferenceRows(dataRows));
    if(!selected.length)return gdShotBubbleOverlayReferenceRows(dataRows);
    const byClub={};
    sourceRows.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key&&!byClub[key])byClub[key]=row;
    });
    const selectedRows=selected.map(key=>byClub[key]).filter(row=>row&&Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
    return selectedRows.length?selectedRows:gdShotBubbleOverlayReferenceRows(dataRows);
  }
  function gdPracticeMyBubbleHubRows(dataRows,analysis){
    const p=safe(()=>ensureProfile(),null)||{};
    const state=gdPracticeMyBubbleState(p,analysis);
    const offset=Number(state?.offset);
    if(!Number.isFinite(offset))return [];
    const selectedNames=gdPracticeProjectionSelectedClubNames(analysis,dataRows);
    const selectedKeys=selectedNames.map(gdShotBubbleOverlayClubKey).filter(Boolean);
    const savedRows=gdPracticeSavedBagRows().filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
    const dataByClub={};
    (dataRows||[]).forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key&&!dataByClub[key])dataByClub[key]=row;
    });
    const sourceForClub=club=>{
      const ctx={p};
      return gdMyBubbleHubSource(ctx,club,offset)
        || gdMyBubbleHubSource(ctx,gdCompareClubKey(p?.previewBubbleSet?.club),offset);
    };
    const applyBubbleSource=(row,source)=>{
      const strict=gdGpsReadyMyBubbleSource(source,{offsetDeg:offset,club:row?.club,handedness:p?.handedness});
      if(!row||!strict)return null;
      const distance=Number(row.actualDistanceM);
      const sourceDistance=Number(strict.baseDistanceM||strict.expectedDistanceM||strict.meanExpectedM||strict.baseCarry);
      if(!Number.isFinite(distance)||distance<=0||!Number.isFinite(sourceDistance)||sourceDistance<=0)return null;
      const presentation=gdMyBubblePresentationMetrics(strict,{distanceM:distance,offsetDeg:offset,club:row?.club,handedness:p?.handedness});
      if(!presentation)return null;
      // SIZE COMES FROM THE SAVED BUBBLE, not from the presentation pass.
      // gdMyBubblePresentationMetrics already normalises and scales the shape, and
      // the graph renderer normalises again on the way in - so taking its output
      // here sized Practice's My Bubble ~8% larger than the identical bubble on
      // Course and Comparison. Only the visual attributes (tilt/skew/handedness)
      // are taken from it; the dimensions stay the player's own, scaled to this
      // row's distance. No fallback: no real shape means no row.
      const carryScale=distance/sourceDistance;
      const savedWidthM=Number(strict.bubbleWidthM??strict.clusterWidthM)*carryScale;
      const savedDepthM=Number(strict.bubbleDepthM??strict.clusterDepthM)*carryScale;
      if(!Number.isFinite(savedWidthM)||savedWidthM<=0||!Number.isFinite(savedDepthM)||savedDepthM<=0)return null;
      const next=Object.assign({},row,{
        baseDistanceM:distance,
        expectedDistanceM:distance,
        meanExpectedM:distance,
        bubbleWidthM:savedWidthM,
        clusterWidthM:savedWidthM,
        lateralRadiusM:savedWidthM/2,
        bubbleDepthM:savedDepthM,
        clusterDepthM:savedDepthM,
        depthRadiusM:savedDepthM/2,
        radiusM:Math.max(savedWidthM,savedDepthM)/2,
        offsetDeg:offset,
        faceOffsetDeg:offset,
        faceAlignmentOffsetDeg:offset,
        handedness:presentation.handedness,
        tiltDeg:presentation.tiltDeg,
        skewDeg:presentation.skewDeg,
        shapeSource:strict.shapeSource||"my-bubble-graph-projection"
      });
      return next;
    };
    const defaultRowForClub=(club,key)=>{
      const label=club||dataByClub[key]?.club||key||"7i";
      const source=sourceForClub(label);
      const sourceCarry=Number(source?.baseDistanceM||source?.expectedDistanceM||source?.meanExpectedM||source?.baseCarry);
      const carry=Number.isFinite(sourceCarry)&&sourceCarry>0?sourceCarry:gdShotBubbleSafe(()=>typeof gdDefaultCarryForClub==="function"?gdDefaultCarryForClub(label):NaN,NaN);
      const fallback=Number(dataByClub[key]?.actualDistanceM);
      const actual=Number.isFinite(Number(carry))&&Number(carry)>0?Number(carry):(Number.isFinite(fallback)&&fallback>0?fallback:155);
      return applyBubbleSource({club:label,actualDistanceM:actual,lateralM:0,projectionSource:"my-bubble-current-distance"},source);
    };
    if(gdPracticeProjectionMode()==="all"){
      if(savedRows.length)return savedRows.map(row=>applyBubbleSource(Object.assign({projectionSource:"my-bubble-saved-bag"},row),sourceForClub(row.club))).filter(Boolean);
      const keys=Object.keys(dataByClub);
      return (keys.length?keys.map(key=>defaultRowForClub(dataByClub[key]?.club,key)):[defaultRowForClub(gdCompareClubKey(p?.previewBubbleSet?.club)||"7i","7i")]).filter(Boolean);
    }
    const byClub={};
    savedRows.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(key&&!byClub[key])byClub[key]=applyBubbleSource(Object.assign({projectionSource:"my-bubble-saved-bag"},row),sourceForClub(row.club));
    });
    const keys=selectedKeys.length?selectedKeys:Object.keys(dataByClub).slice(0,1);
    const rows=keys.map((key,index)=>byClub[key]||defaultRowForClub(selectedNames[index]||dataByClub[key]?.club,key));
    return rows.filter(row=>row&&Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
  }
	  function gdPracticePlotShots(analysis){
	    // Hard intake gate: only shots that pass the intake gates
	    // (analysis.acceptedShots) ever reach the graph.
	    const accepted=Array.isArray(analysis?.acceptedShots)?analysis.acceptedShots:[];
	    const deselected=gdPracticePlotExcludedShotMap();
	    return accepted.filter(shot=>!deselected[shot?.shotId]);
	  }
	  function gdPracticeNormalisedBaselineForShot(shot,actualDistance){
	    const expected=Number(shot?.expectedM??shot?.expectedDistanceM);
	    if(Number.isFinite(expected)&&expected>0)return expected;
	    const clubDefault=Number(gdDefaultCarryForClub(shot?.club||""));
	    if(Number.isFinite(clubDefault)&&clubDefault>0)return clubDefault;
	    return Number.isFinite(actualDistance)&&actualDistance>0?actualDistance:NaN;
	  }
	  function gdPracticeNormalisedAngleForShot(shot,baselineDistance){
	    const direct=Number(shot?.normalizedDeg??shot?.normalisedDeg??shot?.plot?.normalizedDeg??shot?.plot?.normalisedDeg);
	    if(Number.isFinite(direct))return direct;
	    const metric=typeof gdPracticeShotMetricValue==="function"?gdPracticeShotMetricValue(shot,["sideAngle","offlineAngle","resultAngle"]):NaN;
	    if(Number.isFinite(metric))return metric;
	    const lateral=gdShotChartLateralInfo(shot,baselineDistance);
	    if(lateral.hasLateral!==false&&Number.isFinite(Number(lateral.value))&&Number.isFinite(baselineDistance)&&baselineDistance>0){
	      return Math.atan2(Number(lateral.value),baselineDistance)*180/Math.PI;
	    }
	    return NaN;
	  }
	  function gdPracticeNormalisedPlotRows(shots){
	    return (Array.isArray(shots)?shots:[]).map((shot,index)=>{
	      const actual=gdPracticeShotActualDistance(shot);
	      const expected=gdPracticeNormalisedBaselineForShot(shot,actual);
	      if(!Number.isFinite(expected)||expected<=0)return null;
	      const rawDepth=Number(shot?.depthM??shot?.normalisedDepthM??shot?.normalizedDepthM);
	      const depth=Number.isFinite(rawDepth)?rawDepth:(Number.isFinite(actual)?actual-expected:0);
	      const angle=gdPracticeNormalisedAngleForShot(shot,expected);
	      return {
	        club:shot?.club||"Unknown",
	        actualDistanceM:Number.isFinite(actual)?actual:null,
	        expectedDistanceM:expected,
	        normalisedDepthM:depth,
	        normalizedDeg:Number.isFinite(angle)?angle:0,
	        hasLateral:Number.isFinite(angle),
	        shot,
	        index
	      };
	    }).filter(row=>row&&Number.isFinite(row.normalisedDepthM)&&Number.isFinite(row.normalizedDeg));
	  }
  // Shared relative-% chart rows: every shot/bubble is positioned against the SAME
  // anchor (My Bubble's own current distance, tied to the bag) rather than each
  // shot's own per-club expected baseline. This is what lets a Practice Bubble
  // legitimately sit off-centre from My Bubble when the two distances differ -
  // that gap is real (it's what the Distance Suggestion feature is meant to close)
  // and must not be normalised away per-club.
  // PER-CLUB OUTCOME NORMALISATION. Every shot is plotted against ITS OWN club's
  // baseline, so a wedge and a driver both centre on zero and a mixed bag reads
  // correctly. The axis means "how far off your own number for THAT club" - the
  // same thing everywhere, which is exactly why the reading holds with more than
  // one club on screen.
  //
  // A single shared anchor was tried instead and cannot work with a mixed bag: a
  // 105m wedge against a 142m anchor plots at -26%, off the bottom of the window,
  // purely because it is a wedge - nothing to do with how it was struck.
  //
  // baselineFor(club) supplies the club's own number: the saved bag carry when the
  // player has a real bag, otherwise the median of that club's own shots. Never a
  // stand-in - a club with no baseline is not plotted.
  function gdBubbleRelativeShotRows(shots,baselineFor){
    const resolve=typeof baselineFor==="function"
      ?baselineFor
      :()=>Number(baselineFor);
    return (Array.isArray(shots)?shots:[]).map((shot,index)=>{
      const actual=gdPracticeShotActualDistance(shot);
      const baseline=Number(resolve(shot?.club,shot));
      if(!Number.isFinite(actual)||actual<=0||!Number.isFinite(baseline)||baseline<=0)return null;
      const angle=gdPracticeNormalisedAngleForShot(shot,baseline);
      return {
        club:shot?.club||"Unknown",
        actualDistanceM:actual,
        expectedDistanceM:baseline,
        normalisedDepthM:(actual-baseline)/baseline*100,
        normalizedDeg:Number.isFinite(angle)?angle:0,
        hasLateral:Number.isFinite(angle),
        shot,
        index
      };
    }).filter(row=>row&&Number.isFinite(row.normalisedDepthM)&&Number.isFinite(row.normalizedDeg));
  }
	  // Fixed axes. Course / Comparison / Practice all share this domain, so an
	  // identical bubble renders at an identical shape on every screen. Do NOT
	  // fit the axes to the plotted rows - that is what made the same bubble look
	  // stretched on Comparison (bubbles only) vs Practice (bubbles + scatter).
	  // THE VIEW WINDOW. These two numbers ARE the zoom: they say how much of the
	  // world the box shows, and nothing else may change them. Shared by Course,
	  // Practice and Comparison so the zoom is identical on all three - a bubble
	  // that looks a given size on one screen looks that size on every screen.
	  // Shots outside the window clip at the edge on purpose; the view never
	  // stretches to swallow an outlier.
	  const GD_NORMALISED_DEPTH_MAX=25;  // +/- % of anchor carry
	  const GD_NORMALISED_ANGLE_MAX=8;   // +/- aim angle, degrees
	  // DOWN-THE-LINE IS THE ONLY ORIENTATION. The shot origin sits at the bottom
	  // centre and the ball travels UP the page, so aim maps to the X axis (right
	  // miss = right) and distance maps to the Y axis (long = up). This is built
	  // natively rather than by rotating a landscape drawing - the old
	  // originBottomTransform approach pushed long shots clean off the top of the
	  // box, because rotating a 420x142 plot needs a 142-wide, 420-tall one.
	  //
	  // The plot fills the chart: everything outside it is the title block and an
	  // 8px margin for the rounded surround.
	  const GD_NORMALISED_CHART={width:480,height:460,left:34,right:446,top:92,bottom:436};
	  function gdPracticeNormalisedPlotLayout(opts={}){
	    const chartWidth=Number(opts.width)||GD_NORMALISED_CHART.width;
	    const chartHeight=Number(opts.height)||GD_NORMALISED_CHART.height;
	    const plotLeft=Number(opts.plotLeft)||GD_NORMALISED_CHART.left;
	    const plotRight=Number(opts.plotRight)||GD_NORMALISED_CHART.right;
	    const plotTop=Number(opts.plotTop)||GD_NORMALISED_CHART.top;
	    const plotBottom=Number(opts.plotBottom)||GD_NORMALISED_CHART.bottom;
	    const plotMidX=(plotLeft+plotRight)/2;
	    const plotMidY=(plotTop+plotBottom)/2;
	    const depthMax=GD_NORMALISED_DEPTH_MAX;
	    const angleMax=GD_NORMALISED_ANGLE_MAX;
	    return {chartWidth,chartHeight,plotLeft,plotRight,plotTop,plotBottom,plotMidX,plotMidY,depthMax,angleMax,depthRange:depthMax,angleRange:angleMax};
	  }
	  function gdPracticeNormalisedViewBox(plot){
	    return `0 0 ${Number(plot?.chartWidth)||GD_NORMALISED_CHART.width} ${Number(plot?.chartHeight)||GD_NORMALISED_CHART.height}`;
	  }
	  function gdPracticeGraphInternalGeometry(plot){
	    if(!plot)return null;
	    const halfWidth=(plot.plotRight-plot.plotLeft)/2;
	    const halfHeight=(plot.plotBottom-plot.plotTop)/2;
	    // Down the line: the player stands at the bottom centre and hits away from
	    // the viewer, so aim runs across and distance runs up.
	    const originX=Number(plot.plotMidX);
	    const originY=Number(plot.plotBottom);
	    return {
	      originX,
	      originY,
	      // Positive angle is a miss to the RIGHT, and the ball is travelling away
	      // from the viewer, so right of the line is right of the screen.
	      xForAngle(angle){return plot.plotMidX+gdShotChartClamp((Number(angle)||0)/plot.angleRange,-1,1)*halfWidth;},
	      // MINUS: positive depth is LONG, which is further up the page.
	      yForDepth(depth){return plot.plotMidY-gdShotChartClamp((Number(depth)||0)/plot.depthRange,-1,1)*halfHeight;},
	      // A shot with no lateral reading still has a real distance - it sits on
	      // the target line with only a nudge so overlaps stay visible.
	      xForUnknown(jitter=0){return plot.plotMidX+(Number(jitter)||0);}
	    };
	  }
	  function gdPracticeNormalisedPlotPoint(plot,row,index=0){
	    if(!plot||!row)return null;
	    const depth=Number(row.normalisedDepthM);
	    const angle=Number(row.normalizedDeg);
	    if(!Number.isFinite(depth)||!Number.isFinite(angle))return null;
	    const geo=gdPracticeGraphInternalGeometry(plot);
	    if(!geo)return null;
	    const jitter=((Number(index)||0)%5-2)*.85;
	    const x=row.hasLateral===false
	      ?geo.xForUnknown(jitter)
	      :geo.xForAngle(angle)+(Math.abs(angle)<.08?jitter:0);
	    const y=geo.yForDepth(depth);
	    return {x,y,clipped:Math.abs(depth)>plot.depthRange||Math.abs(angle)>plot.angleRange};
	  }
  // The origin-at-bottom toggle, its stored preference and its rotate button are
  // gone: that orientation is now the only one, built into the geometry rather
  // than applied as a transform. None of it had any call site anyway.
	  function gdPracticeNormalisedBackdropSvg(plot,title,opts={}){
	    const width=Number(plot.chartWidth)||480;
	    const height=Number(plot.chartHeight)||260;
	    const titleText=String(title||"").trim();
	    const hideText=opts.hideText===true;
	    const subtitleY=titleText?48:30;
	    const grid=[
	      {x:plot.plotLeft+(plot.plotRight-plot.plotLeft)*.25},
	      {x:plot.plotLeft+(plot.plotRight-plot.plotLeft)*.75},
	      {y:plot.plotTop+(plot.plotBottom-plot.plotTop)*.25},
	      {y:plot.plotTop+(plot.plotBottom-plot.plotTop)*.75}
	    ].map(item=>Number.isFinite(item.x)
	      ?`<line x1="${item.x.toFixed(1)}" y1="${plot.plotTop}" x2="${item.x.toFixed(1)}" y2="${plot.plotBottom}" stroke="rgba(255,255,255,.055)" stroke-width="1"/>`
	      :`<line x1="${plot.plotLeft}" y1="${item.y.toFixed(1)}" x2="${plot.plotRight}" y2="${item.y.toFixed(1)}" stroke="rgba(255,255,255,.055)" stroke-width="1"/>`
	    ).join("");
	    return `<rect width="${width}" height="${height}" fill="rgba(0,0,0,.08)"/>
	      ${titleText&&!hideText?`<text x="24" y="30" fill="rgba(255,255,255,.82)" font-size="14" font-weight="950">${gdStatsSvgText(titleText)}</text>`:""}
	      ${hideText?"":`<text x="24" y="${subtitleY}" fill="rgba(255,255,255,.46)" font-size="9" font-weight="850">${gdStatsSvgText(opts.subtitle||"Depth against expected carry · lateral angle")}</text>`}
	      <rect x="${(plot.plotLeft-8).toFixed(1)}" y="${(plot.plotTop-8).toFixed(1)}" width="${(plot.plotRight-plot.plotLeft+16).toFixed(1)}" height="${(plot.plotBottom-plot.plotTop+16).toFixed(1)}" rx="8" fill="rgba(255,255,255,.012)" stroke="rgba(255,255,255,.045)" stroke-width="1"/>
	      ${grid}
	      <line x1="${plot.plotLeft}" y1="${plot.plotMidY.toFixed(1)}" x2="${plot.plotRight}" y2="${plot.plotMidY.toFixed(1)}" stroke="rgba(255,255,255,.18)" stroke-width="1" stroke-dasharray="4 8" stroke-linecap="round"/>
	      <line x1="${plot.plotMidX.toFixed(1)}" y1="${plot.plotTop}" x2="${plot.plotMidX.toFixed(1)}" y2="${plot.plotBottom}" stroke="rgba(248,250,247,.42)" stroke-width="1.55" stroke-dasharray="7 8" stroke-linecap="round"/>
	      <path d="M ${plot.plotMidX.toFixed(1)} ${(plot.plotBottom-7).toFixed(1)} V ${(plot.plotBottom-48).toFixed(1)}" stroke="rgba(248,250,247,.76)" stroke-width="1.8" stroke-linecap="round"/>
	      <circle cx="${plot.plotMidX.toFixed(1)}" cy="${plot.plotBottom}" r="6.4" fill="#f8faf7" stroke="rgba(0,0,0,.62)" stroke-width="1.45"/>
	      <circle cx="${plot.plotMidX.toFixed(1)}" cy="${plot.plotBottom}" r="2.2" fill="#07100d"/>`;
	  }
	  function gdPracticeClubKeyDropdownHTML(clubs){
	    const rows=(Array.isArray(clubs)?clubs:[]).filter(Boolean);
	    if(!rows.length)return "";
	    return `<details class="gdPracticeClubKeyDrop"><summary>Club key</summary><div class="gdPracticeClubKeyList">${rows.map(club=>`<span class="gdPracticeClubKeyItem"><i class="gdPracticeClubKeySwatch" style="background:${gdStatsClubColor(club)}"></i><span>${gdEscapeHTML(club)}</span></span>`).join("")}</div></details>`;
	  }
	  function gdPracticeDisplayShotCount(){
    const store=gdPracticeDisplayStore();
    return Array.isArray(store?.shots)?store.shots.length:0;
  }
  function renderDataHubStatus(){
    gdRenderDataHubCards();
  }
  // THE NORMALISED CLUB. Practice output is expressed in a 7-iron view - the
  // cluster method pools every club into one oval and labels it "Practice oval",
  // which is a DISPLAY LABEL, not a club. Storing that label as the bubbleProfiles
  // key is what orphaned saved bubbles: `gdMyBubbleHubSource` looks up by real
  // club, so Practice, Comparison and the GPS bubble all found nothing, while
  // Course happened to find it only because it looks up with club=null and falls
  // back to the bubble's own label. Keys are clubs; labels are for reading.
  const GD_NORMALISED_VIEW_CLUB="7i";
  function gdIsRealClubKey(club){
    const key=String(gdCompareClubKey(club)||"").trim();
    if(!key)return false;
    if(/^(driver|\d{1,2}\s*(w|h|i)|[pgslaw]w)$/i.test(key.replace(/\s+/g,"")))return true;
    return safe(()=>(typeof gdBagSourceRows==="function"?gdBagSourceRows():[])
      .some(row=>gdCompareClubKey(row?.club||row?.name).toLowerCase()===key.toLowerCase()),false);
  }
  function gdMyBubbleStorageClub(club){
    return gdIsRealClubKey(club)?(gdCompareClubKey(club)||GD_NORMALISED_VIEW_CLUB):GD_NORMALISED_VIEW_CLUB;
  }
  // Re-keys bubbles already saved under a label. Without this the fix would only
  // help bubbles saved from now on, and an existing one would stay orphaned.
  function gdMigrateMyBubbleClubKeys(p){
    if(!p||typeof p!=="object")return p;
    let changed=false;
    if(p.bubbleProfiles&&typeof p.bubbleProfiles==="object"){
      Object.keys(p.bubbleProfiles).forEach(key=>{
        if(gdIsRealClubKey(key))return;
        const bubble=p.bubbleProfiles[key];
        delete p.bubbleProfiles[key];
        if(bubble&&typeof bubble==="object"){
          p.bubbleProfiles[GD_NORMALISED_VIEW_CLUB]=Object.assign({},bubble,{club:GD_NORMALISED_VIEW_CLUB});
        }
        changed=true;
      });
    }
    if(p.previewBubbleSet&&typeof p.previewBubbleSet==="object"&&!gdIsRealClubKey(p.previewBubbleSet.club)){
      p.previewBubbleSet=Object.assign({},p.previewBubbleSet,{club:GD_NORMALISED_VIEW_CLUB});
      changed=true;
    }
    if(changed)safe(()=>savePlayerProfiles());
    return p;
  }
  function gdBubbleDataContext(){
    const p=safe(()=>gdMigrateMyBubbleClubKeys(ensureProfile()),null)||safe(()=>ensureProfile(),null);
    return{p};
  }
  function gdBubbleCentralOffset(p){
    const n=Number(p?.faceOffsetDeg??p?.centralFaceOffsetDeg??p?.previewBubbleSet?.faceOffsetDeg??p?.previewBubbleSet?.faceAlignmentOffsetDeg??1.4);
    return Number.isFinite(n)?n:1.4;
  }
  function gdCourseOffsetSuggestion(p){
    const n=Number(p?.pendingStatsOffsetSuggestion?.faceOffsetDeg??p?.pendingStatsOffsetSuggestion?.faceAlignmentOffsetDeg);
    return Number.isFinite(n)?n:null;
  }
  function gdPracticeOffsetSuggestion(){
    const method=gdPracticeBubbleMethod(gdPracticeProjectionReadyAnalysis());
    const n=Number(method?.anchorDeg);
    return Number.isFinite(n)?n:null;
  }
  function gdOffsetLabel(value){
    const n=Number(value);
    if(!Number.isFinite(n))return "-";
    if(Math.abs(n)<.05)return "0.0°";
    return `${n>0?"R":"L"} ${Math.abs(n).toFixed(1)}°`;
  }
  function gdParseOffsetValue(value,fallback=NaN){
    if(typeof value==="number")return Number.isFinite(value)?value:fallback;
    const raw=String(value??"").trim();
    if(!raw)return fallback;
    const direction=raw.match(/\b([lr])\b/i)?.[1]?.toUpperCase()||"";
    const numberMatch=raw.replace(/,/g,".").match(/[+-]?\d+(?:\.\d+)?/);
    if(!numberMatch)return fallback;
    const magnitude=Number(numberMatch[0]);
    if(!Number.isFinite(magnitude))return fallback;
    if(direction==="L")return -Math.abs(magnitude);
    if(direction==="R")return Math.abs(magnitude);
    return magnitude;
  }
  function gdShotBubbleClamp(value,min,max){
    return Math.max(min,Math.min(max,value));
  }
  const GD_SHOT_BUBBLE_MODEL=Object.freeze({width:480,height:260,startPct:.16,basePct:.68,yPct:.60});
  const GD_SHOT_BUBBLE_HUB_MODEL=Object.freeze({width:720,height:120,startPct:.12,basePct:.68,yPct:.56});
  function gdShotBubbleLandingX(width,base=.68){
    return width*Math.max(.50,Math.min(.82,Number(base)||.68));
  }
  function gdShotBubbleFrame(width,height,opts={}){
    const viewW=Math.max(1,Number(width)||GD_SHOT_BUBBLE_MODEL.width);
    const viewH=Math.max(1,Number(height)||GD_SHOT_BUBBLE_MODEL.height);
    const modelW=Math.max(1,Number(opts.modelWidth)||GD_SHOT_BUBBLE_MODEL.width);
    const modelH=Math.max(1,Number(opts.modelHeight)||GD_SHOT_BUBBLE_MODEL.height);
    const scale=Math.min(viewW/modelW,viewH/modelH);
    const x0=(viewW-(modelW*scale))/2;
    const y0=(viewH-(modelH*scale))/2;
    const rawStartPct=Number.isFinite(Number(opts.startXPct))?Number(opts.startXPct):Number.isFinite(Number(opts.startX))?Number(opts.startX)/viewW:GD_SHOT_BUBBLE_MODEL.startPct;
    const rawBasePct=Number.isFinite(Number(opts.basePct))?Number(opts.basePct):GD_SHOT_BUBBLE_MODEL.basePct;
    const rawYPct=Number.isFinite(Number(opts.yPct))?Number(opts.yPct):Number.isFinite(Number(opts.y))?Number(opts.y)/viewH:GD_SHOT_BUBBLE_MODEL.yPct;
    const startPct=gdShotBubbleClamp(rawStartPct,.06,.42);
    const basePct=gdShotBubbleClamp(rawBasePct,.50,.84);
    const yPct=gdShotBubbleClamp(rawYPct,.24,.84);
    const startXModel=modelW*startPct;
    const zeroXModel=modelW*basePct;
    const yModel=modelH*yPct;
    return{
      viewW,viewH,modelW,modelH,scale,x0,y0,startPct,basePct,yPct,startXModel,zeroXModel,yModel,
      x:x=>x0+(Number(x)||0)*scale,
      y:y=>y0+(Number(y)||0)*scale,
      len:value=>(Number(value)||0)*scale
    };
  }
  function gdShotBubbleModelEndpoint(offset,frame){
    const n=Number(offset);
    const dx=Math.max(1,frame.zeroXModel-frame.startXModel);
    // POSITIVE, not negated - same landscape law as gdShotChartYForLateral
    // (gd-app-core.js). Ball left, target right, so a RIGHT offset (positive n)
    // draws BELOW the line, which is +y in SVG. The negation drew it above.
    // Model +y therefore means RIGHT, which also makes the bubble's physics
    // tilt (positive = far end swings right) come out the correct way round in
    // gdShotBubbleSimulatedModelPath - both were mirrored before.
    const rawDy=Number.isFinite(n)?Math.tan(n*Math.PI/180)*dx:0;
    const minY=frame.modelH*.30;
    const maxY=frame.modelH*.80;
    const y=gdShotBubbleClamp(frame.yModel+rawDy,minY,maxY);
    const dy=y-frame.yModel;
    return{x:frame.zeroXModel,y,angle:Math.atan2(dy,dx)*180/Math.PI,distance:Math.sqrt(dx*dx+dy*dy),dx,dy};
  }
  function gdShotBubbleEndpoint(offset,width,height,startX,zeroX,alignmentY,opts={}){
    const viewW=Math.max(1,Number(width)||GD_SHOT_BUBBLE_MODEL.width);
    const viewH=Math.max(1,Number(height)||GD_SHOT_BUBBLE_MODEL.height);
    const frame=gdShotBubbleFrame(viewW,viewH,Object.assign({},opts,{
      startXPct:Number.isFinite(Number(startX))?Number(startX)/viewW:opts.startXPct,
      basePct:Number.isFinite(Number(zeroX))?Number(zeroX)/viewW:opts.basePct,
      yPct:Number.isFinite(Number(alignmentY))?Number(alignmentY)/viewH:opts.yPct
    }));
    const aim=gdShotBubbleModelEndpoint(offset,frame);
    return{
      x:frame.x(aim.x),
      y:frame.y(aim.y),
      angle:aim.angle,
      distance:frame.len(aim.distance),
      modelX:aim.x,
      modelY:aim.y,
      modelDistance:aim.distance
    };
  }
  function gdShotBubbleMedian(values){
    const clean=(values||[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    if(!clean.length)return 0;
    const mid=Math.floor(clean.length/2);
    return clean.length%2?clean[mid]:(clean[mid-1]+clean[mid])/2;
  }
  function gdShotBubbleSize(width,height,opts={},startX,zeroX){
    const viewW=Math.max(1,Number(width)||GD_SHOT_BUBBLE_MODEL.width);
    const viewH=Math.max(1,Number(height)||GD_SHOT_BUBBLE_MODEL.height);
    const frame=gdShotBubbleFrame(viewW,viewH,Object.assign({},opts,{
      startXPct:Number.isFinite(Number(startX))?Number(startX)/viewW:opts.startXPct,
      basePct:Number.isFinite(Number(zeroX))?Number(zeroX)/viewW:opts.basePct
    }));
    const dx=Math.max(1,frame.zeroXModel-frame.startXModel);
    const defaultRx=Math.max(24,frame.modelW*(Number(opts.rxPct)||.105));
    const defaultRy=Math.max(20,frame.modelH*(Number(opts.ryPct)||.19));
    let rx=defaultRx;
    let ry=defaultRy;
    const baseM=Math.max(1,Number(opts.baseDistanceM||opts.expectedDistanceM||opts.meanExpectedM||155));
    const depthM=Number(opts.bubbleDepthM);
    if(Number.isFinite(depthM)&&depthM>0){
      rx=gdShotBubbleClamp((depthM/2/baseM)*dx*1.35,Math.max(18,frame.modelW*.038),Math.max(defaultRx*1.3,frame.modelW*.16));
    }
    const widthM=Number(opts.bubbleWidthM);
    const lateralRadiusDeg=Number(opts.lateralRadiusDeg);
    if(Number.isFinite(widthM)&&widthM>0){
      ry=gdShotBubbleClamp((widthM/2/baseM)*dx*1.35,Math.max(13,frame.modelH*.05),Math.max(defaultRy*1.22,frame.modelH*.18));
    }else if(Number.isFinite(lateralRadiusDeg)&&lateralRadiusDeg>0){
      ry=gdShotBubbleClamp(Math.tan(lateralRadiusDeg*Math.PI/180)*dx*1.45,Math.max(13,frame.modelH*.05),Math.max(defaultRy*1.22,frame.modelH*.18));
    }
    const depthPct=Number(opts.depthPct);
    if(Number.isFinite(depthPct)&&depthPct>0){
      rx=gdShotBubbleClamp(depthPct*dx*1.35,Math.max(18,frame.modelW*.038),Math.max(defaultRx*1.3,frame.modelW*.16));
    }
    return{rx:Number(frame.len(rx).toFixed(1)),ry:Number(frame.len(ry).toFixed(1)),rxModel:rx,ryModel:ry};
  }
  function gdShotBubbleRenderPayload(opts={}){
    if(opts.payload&&typeof opts.payload==="object")return opts.payload;
    const distance=Number(opts.baseDistanceM||opts.expectedDistanceM||opts.meanExpectedM)||155;
    return gdShotBubbleSafe(()=>typeof gdFallbackGpsBubblePayload==="function"?gdFallbackGpsBubblePayload(distance):null,null)||{};
  }
  function gdShotBubbleSimulatedModelPath(frame,centerXModel,centerYModel,depthRadiusModel,lateralRadiusModel,opts={}){
    const payload=gdShotBubbleRenderPayload(opts);
    const tilt=(Number(opts.tiltDeg)||0)*Math.PI/180;
    const skew=(Number(opts.skewDeg)||0)*Math.PI/180;
    const depth=Math.max(1,Number(depthRadiusModel)||1);
    const lateral=Math.max(1,Number(lateralRadiusModel)||1);
    const points=[];
    const steps=64;
    for(let i=0;i<steps;i++){
      const rel=(Math.PI*2*i)/steps;
      const radiusFactor=typeof bubbleRadiusFactor==="function"?bubbleRadiusFactor(rel,payload):1;
      const localX=Math.cos(rel)*depth*radiusFactor;
      const localY=Math.sin(rel)*lateral*radiusFactor;
      const skewedY=localY+Math.tan(skew)*localX*.42;
      const rotatedX=localX*Math.cos(tilt)-skewedY*Math.sin(tilt);
      const rotatedY=localX*Math.sin(tilt)+skewedY*Math.cos(tilt);
      points.push(`${frame.x(Number(centerXModel)+rotatedX).toFixed(1)} ${frame.y(Number(centerYModel)+rotatedY).toFixed(1)}`);
    }
    return points.length?`M ${points.join(" L ")} Z`:"";
  }
  function gdShotBubblePointFromEvidence(point,width,height,opts={}){
    const frame=gdShotBubbleFrame(width,height,opts);
    const dx=Math.max(1,frame.zeroXModel-frame.startXModel);
    const offset=Number(point?.offsetDeg);
    const aim=gdShotBubbleModelEndpoint(Number.isFinite(offset)?offset:0,frame);
    const depthPct=Number(point?.depthPct);
    const modelX=frame.zeroXModel+gdShotBubbleClamp(Number.isFinite(depthPct)?depthPct*dx*1.15:0,-frame.modelW*.24,frame.modelW*.20);
    const x=frame.x(modelX);
    const y=frame.y(aim.y);
    return Object.assign({},point,{x,y,modelX,modelY:aim.y,inFrame:x>=20&&x<=width-20&&y>=24&&y<=height-24});
  }
  function gdShotBubbleBaseSvg(width,height,opts={}){
    const offset=Number.isFinite(Number(opts.offsetDeg))?Number(opts.offsetDeg):gdBubbleCentralOffset(safe(()=>ensureProfile(),null));
    const frame=gdShotBubbleFrame(width,height,opts);
    const aim=gdShotBubbleModelEndpoint(offset,frame);
	    const baseDistance=Number(opts.baseDistanceM||opts.expectedDistanceM||opts.meanExpectedM||155);
	    const modelBubble=gdShotBubbleSafe(()=>gdGeneratedShotBubbleForClub(opts.club||"7i",baseDistance,offset),null);
	    const drawable=modelBubble?gdShotBubbleNormaliseDrawable(modelBubble,Object.assign({},opts,{actualDistanceM:baseDistance,club:opts.club||"7i"}),offset):null;
	    const startX=frame.x(frame.startXModel);
	    const zeroX=frame.x(frame.zeroXModel);
	    const y=frame.y(frame.yModel);
	    const bubbleX=frame.x(aim.x);
	    const bubbleY=frame.y(aim.y);
	    const zeroLineStart=frame.x(frame.modelW*.04);
	    const zeroLineEnd=frame.x(frame.modelW*.96);
	    const bubbleSize=gdShotBubbleSize(width,height,opts);
	    const bubblePath=gdShotBubbleSimulatedModelPath(frame,aim.x,aim.y,bubbleSize.rxModel,bubbleSize.ryModel,Object.assign({},opts,{tiltDeg:drawable?gdShotBubbleDisplayTiltDeg(drawable):aim.angle}));
    const opacity=Number.isFinite(Number(opts.opacity))?Number(opts.opacity):.34;
    const targetSize=Math.max(6,Math.min(13,frame.len(frame.modelW*.028)));
    const ballRadius=Math.max(4.8,frame.len(frame.modelW*.017));
    const offsetWidth=Math.max(1.6,frame.len(frame.modelW*.006));
    const bubbleStroke=Math.max(1.35,frame.len(frame.modelW*.0048));
    return `<g class="gdShotBubbleBase" opacity="${opacity}">
      <defs>
        <radialGradient id="gdShotBubbleBallGrad" cx="35%" cy="28%" r="70%">
          <stop offset="0" stop-color="#fff"/>
          <stop offset=".58" stop-color="#dfe5e2"/>
          <stop offset="1" stop-color="#8b9691"/>
        </radialGradient>
	      </defs>
	      <g class="gdShotBubbleZeroLayer">
	        <line x1="${zeroLineStart}" y1="${y}" x2="${zeroLineEnd}" y2="${y}" stroke="rgba(255,255,255,.58)" stroke-width="1.35" stroke-dasharray="4 7" stroke-linecap="round"/>
	      </g>
      <g class="gdShotBubbleOffsetLayer">
        <line x1="${startX}" y1="${y}" x2="${bubbleX}" y2="${bubbleY}" stroke="rgba(255,159,47,.64)" stroke-width="${offsetWidth}" stroke-linecap="round"/>
        <path d="${bubblePath}" fill="rgba(239,68,68,.13)" stroke="rgba(255,159,47,.82)" stroke-width="${bubbleStroke}" stroke-linejoin="round"/>
      </g>
      <g class="gdShotBubbleZeroMarkers">
        <line x1="${zeroX-targetSize}" y1="${y}" x2="${zeroX+targetSize}" y2="${y}" stroke="rgba(255,255,255,.72)" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="${zeroX}" y1="${y-targetSize}" x2="${zeroX}" y2="${y+targetSize}" stroke="rgba(255,255,255,.72)" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="${startX}" cy="${y}" r="${ballRadius}" fill="url(#gdShotBubbleBallGrad)" opacity=".94"/>
      </g>
    </g>`;
  }
  function gdShotBubbleAimSvg(width,height,opts={}){
    const offset=Number(opts.offsetDeg);
    if(!Number.isFinite(offset))return "";
    const frame=gdShotBubbleFrame(width,height,opts);
    const aim=gdShotBubbleModelEndpoint(offset,frame);
    const baseDistance=Number(opts.baseDistanceM||opts.expectedDistanceM||opts.meanExpectedM||155);
    const modelBubble=gdShotBubbleSafe(()=>gdGeneratedShotBubbleForClub(opts.club||"7i",baseDistance,offset),null);
    const drawable=modelBubble?gdShotBubbleNormaliseDrawable(modelBubble,Object.assign({},opts,{actualDistanceM:baseDistance,club:opts.club||"7i"}),offset):null;
    const startX=frame.x(frame.startXModel);
    const y=frame.y(frame.yModel);
    const bubbleX=frame.x(aim.x);
    const bubbleY=frame.y(aim.y);
    const bubbleSize=gdShotBubbleSize(width,height,opts);
    const renderTilt=Number.isFinite(Number(opts.tiltDeg))?Number(opts.tiltDeg):(drawable?gdShotBubbleDisplayTiltDeg(drawable):aim.angle);
    const bubblePath=gdShotBubbleSimulatedModelPath(frame,aim.x,aim.y,bubbleSize.rxModel,bubbleSize.ryModel,Object.assign({},opts,{tiltDeg:renderTilt}));
    const stroke=opts.stroke||"#ff9f2f";
    const fill=opts.fill||"rgba(239,68,68,.10)";
    const opacity=Number.isFinite(Number(opts.opacity))?Number(opts.opacity):.56;
    const className=opts.className||"gdShotBubbleGeneratedLayer";
    const lineWidth=Math.max(1.35,frame.len(frame.modelW*.0048));
    const bubbleStroke=Math.max(1.2,frame.len(frame.modelW*.004));
    const lineEndY=opts.lineMode==="straight"?y:bubbleY;
    const lineMarkup=opts.showAimLine===false?"":`<line x1="${startX}" y1="${y}" x2="${bubbleX}" y2="${lineEndY}" stroke="${stroke}" stroke-width="${lineWidth}" stroke-linecap="round"/>`;
    return `<g class="${className}" opacity="${opacity}">
      ${lineMarkup}
      <path d="${bubblePath}" fill="${fill}" stroke="${stroke}" stroke-width="${bubbleStroke}" stroke-linejoin="round"/>
    </g>`;
  }
	  function gdMyBubbleLaneMaxDistance(){
	    return 250;
	  }
	  function gdMyBubbleLaneMinDistance(club="7i",source={}){
	    const sourceCarry=Number(source?.baseDistanceM||source?.expectedDistanceM||source?.meanExpectedM||source?.baseCarry);
	    const fallbackCarry=gdShotBubbleSafe(()=>gdDefaultCarryForClub(club),155)||155;
	    const carry=Number.isFinite(sourceCarry)&&sourceCarry>=40?sourceCarry:fallbackCarry;
	    return gdShotBubbleOverlayClamp(Math.round(carry*.45),40,95);
	  }
	  function gdMyBubbleClampLaneDistance(distance,club="7i",source={}){
	    const max=gdMyBubbleLaneMaxDistance();
	    const min=gdMyBubbleLaneMinDistance(club,source);
	    return gdShotBubbleOverlayClamp(Number(distance),min,max);
	  }
	  function gdMyBubbleScaledSourceMetric(source,keys,scale=1){
	    const list=Array.isArray(keys)?keys:[keys];
	    for(const key of list){
	      const value=Number(source?.[key]);
	      if(Number.isFinite(value)&&value>0)return value*Math.max(.1,Number(scale)||1);
	    }
	    return NaN;
	  }
	  function gdShotBubblePlayingLaneSvg(offset,sizeOpts={}){
	    const width=480;
	    const height=132;
	    const source=gdGpsReadyMyBubbleSource(sizeOpts,{offsetDeg:offset,club:sizeOpts?.club});
	    if(!source)return "";
	    const club=source.club||"7i";
	    const laneM=gdMyBubbleLaneMaxDistance();
	    const requestedOffset=Number(offset);
	    const liveOffset=Number.isFinite(requestedOffset)?requestedOffset:Number(source.offsetDeg);
	    if(!Number.isFinite(liveOffset))return "";
	    const sourceDistance=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM||source.baseCarry);
	    if(!Number.isFinite(sourceDistance)||sourceDistance<=0)return "";
	    const baseDistance=gdMyBubbleClampLaneDistance(sourceDistance,club,source);
	    const presentation=gdMyBubblePresentationMetrics(source,{distanceM:baseDistance,offsetDeg:liveOffset,club});
	    if(!presentation)return "";
	    const plotLeft=30;
	    const plotRight=452;
	    const plotTop=16;
	    const plotBottom=116;
	    const plotMidY=(plotTop+plotBottom)/2;
	    const targetX=plotLeft+(baseDistance/laneM)*(plotRight-plotLeft);
	    const assetWidth=Number.isFinite(presentation.widthM)&&presentation.widthM>0?presentation.widthM:NaN;
	    const assetDepth=Number.isFinite(presentation.depthM)&&presentation.depthM>0?presentation.depthM:NaN;
	    if(!Number.isFinite(assetDepth)||(!Number.isFinite(assetWidth)&&!Number.isFinite(Number(source.lateralRadiusDeg))))return "";
	    const sourceTilt=Number(presentation.tiltDeg);
	    const sourceSkew=Number(presentation.skewDeg);
	    const idSuffix=`${String(club).replace(/[^a-z0-9]+/gi,"").slice(0,10)||"club"}${Math.round(baseDistance)}${Math.round((liveOffset+90)*100)}`;
	    const assetOpts=Object.assign({},source,{
	      club,
	      actualDistanceM:baseDistance,
	      baseDistanceM:baseDistance,
	      baseCarry:baseDistance,
	      expectedDistanceM:baseDistance,
	      meanExpectedM:baseDistance,
	      offsetDeg:liveOffset,
	      faceOffsetDeg:liveOffset,
	      faceAlignmentOffsetDeg:liveOffset,
	      bubbleWidthM:Number.isFinite(assetWidth)&&assetWidth>0?assetWidth:undefined,
	      clusterWidthM:Number.isFinite(assetWidth)&&assetWidth>0?assetWidth:undefined,
	      bubbleDepthM:Number.isFinite(assetDepth)&&assetDepth>0?assetDepth:undefined,
	      clusterDepthM:Number.isFinite(assetDepth)&&assetDepth>0?assetDepth:undefined,
	      tiltDeg:Number.isFinite(sourceTilt)?sourceTilt:undefined,
	      skewDeg:Number.isFinite(sourceSkew)?sourceSkew:source.skewDeg,
	      handedness:presentation.handedness,
	      startXPct:plotLeft/width,
	      basePct:targetX/width,
	      yPct:plotMidY/height,
	      modelWidth:width,
	      modelHeight:height,
	      lineMode:"straight",
	      stroke:"rgba(215,176,107,.62)",
	      fill:`url(#gdMyBubbleLaneFill${idSuffix})`,
	      opacity:.96,
	      className:"gdMyBubbleGpsAssetLayer"
	    });
	    const frame=gdShotBubbleFrame(width,height,assetOpts);
	    const aim=gdShotBubbleModelEndpoint(liveOffset,frame);
	    const originX=frame.x(frame.startXModel);
	    const originY=frame.y(frame.yModel);
	    const bubbleX=frame.x(aim.x);
	    const bubbleY=frame.y(aim.y);
	    const gpsBubbleMarkup=gdShotBubbleAimSvg(width,height,assetOpts);
	    return `<svg class="gdMyBubbleLaneSvg" data-gd-my-bubble-lane="1" data-viewbox-width="${width}" data-lane-m="${laneM}" data-plot-left="${plotLeft}" data-plot-right="${plotRight}" data-base-distance-m="${baseDistance.toFixed(1)}" data-offset-deg="${liveOffset.toFixed(2)}" data-tilt-deg="${Number.isFinite(sourceTilt)?sourceTilt.toFixed(2):""}" data-shape-source="${gdStatsSvgText(source.shapeSource||"gps-bubble")}" data-bubble-width-m="${Number.isFinite(assetWidth)?assetWidth.toFixed(1):""}" data-bubble-depth-m="${Number.isFinite(assetDepth)?assetDepth.toFixed(1):""}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
	      <defs>
	        <radialGradient id="gdMyBubbleLaneBall${idSuffix}" cx="35%" cy="28%" r="70%">
	          <stop offset="0" stop-color="#fff"/>
	          <stop offset=".58" stop-color="#e6ebe8"/>
	          <stop offset="1" stop-color="#87928e"/>
	        </radialGradient>
	        <radialGradient id="gdMyBubbleLaneFill${idSuffix}" cx="42%" cy="32%" r="78%">
	          <stop offset="0" stop-color="#fff1be" stop-opacity=".30"/>
	          <stop offset=".56" stop-color="#d7b06b" stop-opacity=".18"/>
	          <stop offset="1" stop-color="#62d2ff" stop-opacity=".10"/>
	        </radialGradient>
	      </defs>
	      <rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="rgba(3,12,11,.34)"/>
	      <line x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${plotBottom}" stroke="rgba(238,245,242,.10)" stroke-width="1"/>
	      <line x1="${plotRight}" y1="${plotTop}" x2="${plotRight}" y2="${plotBottom}" stroke="rgba(238,245,242,.10)" stroke-width="1"/>
	      <line x1="${originX.toFixed(1)}" y1="${originY.toFixed(1)}" x2="${plotRight}" y2="${originY.toFixed(1)}" stroke="rgba(238,245,242,.30)" stroke-width="1.2" stroke-dasharray="7 7" stroke-linecap="round"/>
	      ${gpsBubbleMarkup}
	      <g class="gdMyBubbleLandingHandle" data-gd-lane-drag-handle="1" data-distance-m="${baseDistance.toFixed(1)}" pointer-events="all">
	        <circle cx="${bubbleX.toFixed(1)}" cy="${bubbleY.toFixed(1)}" r="22" fill="transparent" class="gdMyBubbleLandingHit"/>
	        <circle cx="${bubbleX.toFixed(1)}" cy="${bubbleY.toFixed(1)}" r="3.5" fill="rgba(255,235,170,.86)" stroke="rgba(8,12,8,.55)" stroke-width="1"/>
	      </g>
	      <circle cx="${originX.toFixed(1)}" cy="${originY.toFixed(1)}" r="6.6" fill="url(#gdMyBubbleLaneBall${idSuffix})" opacity=".96"/>
	      <circle cx="${originX.toFixed(1)}" cy="${originY.toFixed(1)}" r="2.2" fill="rgba(255,255,255,.92)"/>
	    </svg>`;
	  }
	  function gdShotBubbleHubSvg(offset,sizeOpts={}){
	    const source=sizeOpts||{};
	    if(source.previewKind==="playing")return gdShotBubblePlayingLaneSvg(offset,source);
	    const isMyBubbleSource=!!source.gpsReady||/my-bubble/i.test(String(source.shapeSource||source.projectionSource||""));
	    if(isMyBubbleSource)return "";
	    const width=360;
	    const height=72;
	    const club=source.club||"7i";
	    const sourceDistance=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM||source.baseCarry);
	    const baseDistance=Number.isFinite(sourceDistance)&&sourceDistance>0?sourceDistance:gdShotBubbleSafe(()=>gdDefaultCarryForClub(club),155);
	    const generated=gdShotBubbleSafe(()=>gdGeneratedShotBubbleForClub(club,baseDistance,offset),null)||{};
	    const previewScale=2.05;
	    const presentation=gdBubblePresentationForRender(Object.assign({},generated,source,{
	      club,
	      distanceM:baseDistance,
	      baseDistanceM:baseDistance,
	      offsetDeg:Number.isFinite(Number(offset))?Number(offset):gdBubbleOffsetForSource(source),
	      handedness:source.handedness||generated.handedness||gdShotBubbleSafe(()=>ensureProfile()?.handedness,"right")||"right"
	    }),{normalizeAxes:true,scale:previewScale});
	    const centerLateral=gdShotBubbleGpsLateralForOffset(offset,baseDistance);
	    const bubble=Object.assign({},generated,{
	      club,
	      baseDistanceM:baseDistance,
	      centerDistanceM:baseDistance,
	      centerLateralM:centerLateral,
	      widthM:presentation.widthM,
	      depthM:presentation.depthM,
	      lateralRadiusM:presentation.lateralRadiusM,
	      depthRadiusM:presentation.depthRadiusM,
	      radiusM:presentation.radiusM,
	      tiltDeg:presentation.tiltDeg,
	      skewDeg:presentation.skewDeg,
	      handedness:presentation.handedness,
	      offsetDeg:Number(offset)||0
	    });
	    const realDepthRadius=Math.max(1,Number(bubble.depthRadiusM||bubble.depthM/2)||1);
	    const realWidthRadius=Math.max(1,Number(bubble.lateralRadiusM||bubble.widthM/2)||1);
	    const realCenterDistance=Number(bubble.centerDistanceM||bubble.baseDistanceM)||baseDistance;
	    const realCenterLateral=Number(bubble.centerLateralM)||centerLateral||0;
	    const worldMinDistance=0;
	    const neededHalfHeight=Math.max(12,Math.abs(realCenterLateral)+realWidthRadius+4);
	    const baseDistanceRange=Math.max(150,realCenterDistance+realDepthRadius+16);
	    const worldDistanceRange=Math.max(baseDistanceRange,neededHalfHeight*2*(width/height));
	    const worldMaxDistance=worldMinDistance+worldDistanceRange;
	    const worldHalfHeight=worldDistanceRange*(height/width)/2;
	    const plot={
	      plotLeft:20,
	      plotRight:350,
	      plotTop:3,
	      plotBottom:69,
	      plotMidY:36,
	      minDistance:worldMinDistance,
	      maxDistance:worldMaxDistance,
	      lateralMax:worldHalfHeight
	    };
	    plot.distanceRange=plot.maxDistance-plot.minDistance;
	    const xForDistance=distance=>plot.plotLeft+((distance-plot.minDistance)/plot.distanceRange)*(plot.plotRight-plot.plotLeft);
	    const yForLateral=lateral=>gdShotChartYForLateral(plot,lateral);
	    const path=gdShotBubbleOverlayBubblePath(bubble,plot,xForDistance,yForLateral);
	    const originX=xForDistance(0);
	    const originY=plot.plotMidY;
	    const lineEnd=xForDistance(Math.min(worldMaxDistance,realCenterDistance+realDepthRadius));
	    return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
	      <defs>
	        <radialGradient id="gdShotBubbleHubBallGrad" cx="35%" cy="28%" r="70%">
	          <stop offset="0" stop-color="#fff"/>
	          <stop offset=".58" stop-color="#e6ebe8"/>
	          <stop offset="1" stop-color="#87928e"/>
	        </radialGradient>
	        <radialGradient id="gdShotBubbleHubFillGrad" cx="42%" cy="32%" r="78%">
	          <stop offset="0" stop-color="#ffffff" stop-opacity=".34"/>
	          <stop offset=".58" stop-color="#f4f8f3" stop-opacity=".26"/>
	          <stop offset="1" stop-color="#dfe9e3" stop-opacity=".20"/>
	        </radialGradient>
	      </defs>
	      <line x1="${originX.toFixed(1)}" y1="${originY.toFixed(1)}" x2="${lineEnd.toFixed(1)}" y2="${originY.toFixed(1)}" stroke="rgba(255,255,255,.55)" stroke-width="1.25" stroke-dasharray="4 7" stroke-linecap="round"/>
	      ${path?`<path class="gdShotBubbleHubBubble" d="${path}" fill="url(#gdShotBubbleHubFillGrad)" stroke="none"/>`:""}
	      <circle cx="${originX.toFixed(1)}" cy="${originY.toFixed(1)}" r="6.6" fill="url(#gdShotBubbleHubBallGrad)" opacity=".96"/>
	      <circle cx="${originX.toFixed(1)}" cy="${originY.toFixed(1)}" r="2.2" fill="rgba(255,255,255,.92)"/>
	    </svg>`;
	  }
	  function gdComparisonContext(){
	    const p=safe(()=>ensureProfile(),null);
	    const current=gdCompareProfileBubbleOffset(p);
	    const courseAnalysis=safe(()=>gdCurrentStatsAnalysis?.(),null);
	    const courseRecords=courseAnalysis?gdStatsFilteredRecords(courseAnalysis):[];
	    const courseFiltered=courseAnalysis?gdStatsAnalysisForRecords(courseRecords,courseAnalysis.settings):null;
	    const practiceAnalysis=gdPracticeProjectionReadyAnalysis();
	    const courseBubble=gdCourseBubbleSource(courseAnalysis,courseFiltered,courseRecords,p);
	    const practiceBubble=gdPracticeBubbleSource(practiceAnalysis);
	    const course=Number.isFinite(Number(courseBubble?.offsetDeg))?Number(courseBubble.offsetDeg):null;
	    const practice=Number.isFinite(Number(practiceBubble?.offsetDeg))?Number(practiceBubble.offsetDeg):null;
	    const practiceTotals=practiceAnalysis?.totals||{};
	    return{p,current,course,practice,courseBubble,practiceBubble,courseAnalysis,courseFiltered,courseRecords,practiceAnalysis,practiceShots:Number(practiceTotals.rawShots||0)};
	  }
	  function gdCompareProfileBubbleOffset(p){
	    const state=gdMyBubbleState(p,gdPracticeProjectionReadyAnalysis());
	    const offset=Number(state?.offset);
	    return Number.isFinite(offset)?offset:0;
	  }
		  function gdPracticeBubbleSource(analysis){
		    const method=gdPracticeBubbleMethod(analysis);
		    const offsetDeg=Number(method?.anchorDeg);
		    if(!method||!Number.isFinite(offsetDeg))return null;
		    // anchorClub can be a DISPLAY LABEL. The oval method pools every club into
		    // one shape and calls it "Practice oval", which matches no club cluster and
		    // no shot's club - so filtering by it selected NOTHING, and the measured
		    // distance fell all the way through to the literal 155. That phantom 155m
		    // was what sat above the real shots on the chart and got saved into My
		    // Bubble. Only scope to a club when the anchor really is one; otherwise the
		    // oval is formed from every accepted shot, so measure it from all of them.
		    const anchorClub=method.anchorClub;
		    const clubScoped=gdIsRealClubKey(anchorClub);
		    const anchor=clubScoped?((method.clubClusters||[]).find(cluster=>cluster.club===anchorClub)||null):null;
		    const accepted=Array.isArray(analysis?.acceptedShots)?analysis.acceptedShots:[];
		    const shots=clubScoped?accepted.filter(shot=>shot.club===anchorClub):accepted;
		    const importBatchIds=[...new Set(shots.map(shot=>shot.importBatchId||shot.importId||"").filter(Boolean))];
		    // Real measured distance first (same helper the rest of Practice uses),
		    // target/expected carry only as a last-resort fallback - this bubble is
		    // meant to represent what these shots actually did, not what the club
		    // is nominally supposed to carry.
		    const measured=gdShotBubbleMedian(shots.map(shot=>gdPracticeShotActualDistance(shot)));
		    const expected=Number.isFinite(measured)&&measured>0?measured:(Number(anchor?.meanExpectedM)||155);
    const radiusDeg=Number(anchor?.radiusDeg||anchor?.stdDeg);
    const depthSpread=gdShotBubbleMedian(shots.map(shot=>Math.abs(Number(shot.depthM)||0)))*2;
    return{
      offsetDeg,
      lateralRadiusDeg:Number.isFinite(radiusDeg)?Math.max(radiusDeg,.25):.45,
      bubbleDepthM:depthSpread||expected*.10,
		      baseDistanceM:expected,
		      // A real club for anything that keys or sizes off this; the label is kept
		      // separately for display. Cross-club ovals normalise to the 7-iron view.
		      club:clubScoped?anchorClub:GD_NORMALISED_VIEW_CLUB,
		      displayClub:anchorClub||"",
		      measuredDistance:Number.isFinite(measured)&&measured>0,
		      shots:Number(anchor?.countedShots||anchor?.shots||shots.length||0),
		      importBatchIds
		    };
		  }
	  // Every course record measures its shot from the CENTRE OF THE BUBBLE that was
	  // on screen at the time (gd-shot-outcomes.js computeShotOutcome), so
	  // resultBubble.normalizedDeg is a DEVIATION from the playing bubble - NOT an aim
	  // from the target line. Plotting it raw on a target-line chart (Comparison) puts
	  // the Course Bubble near straight-ahead instead of beside My Bubble. It must be
	  // re-anchored: drawn offset = My Bubble's own aim + the measured deviation.
	  // deviationDeg is kept raw because that is the number worth showing ("0.3L").
	  function gdCourseBubbleSource(courseAnalysis,filteredAnalysis,records,p){
    const aim=Number(gdBubbleCentralOffset(p));
    const anchorDeg=Number.isFinite(aim)?aim:0;
    const fits=(filteredAnalysis?.bubbleFit||courseAnalysis?.bubbleFit||[]).slice().sort((a,b)=>(b.shots||0)-(a.shots||0));
    const fit=fits[0]||null;
    if(fit&&Number.isFinite(Number(fit.resultBubble?.normalizedDeg))){
      const fitRows=fit.club?(records||[]).filter(record=>record.club===fit.club):records||[];
      const baseDistance=gdShotBubbleMedian(fitRows.map(record=>Number(record.expectedDistanceM)||Number(record.actualDistanceM)))||155;
      const deviationDeg=Number(fit.resultBubble.normalizedDeg);
      return{
        offsetDeg:anchorDeg+deviationDeg,
        deviationDeg:deviationDeg,
        anchorOffsetDeg:anchorDeg,
        bubbleWidthM:Number(fit.resultBubble.widthM),
        bubbleDepthM:Number(fit.resultBubble.depthM),
        baseDistanceM:baseDistance,
        club:fit.club||"",
        shots:Number(fit.shots||fitRows.length||0)
      };
    }
    const cross=filteredAnalysis?.clusterHunter?.crossClub||courseAnalysis?.clusterHunter?.crossClub||null;
    if(cross&&Number.isFinite(Number(cross.meanDeg))){
      const deviationDeg=Number(cross.meanDeg);
      return{offsetDeg:anchorDeg+deviationDeg,deviationDeg:deviationDeg,anchorOffsetDeg:anchorDeg,lateralRadiusDeg:Number(cross.stdDeg)||.45,bubbleDepthM:16,baseDistanceM:155,club:(cross.clubs||[]).join(", "),shots:Number(cross.shots||0)};
    }
		    return null;
		  }
	  function gdShotBubbleSizeSource(source,offsetDeg){
	    const baseDistance=Number(source?.baseDistanceM||source?.expectedDistanceM||source?.meanExpectedM);
	    const out={
	      club:source?.club||"",
	      offsetDeg:Number.isFinite(Number(offsetDeg))?Number(offsetDeg):Number(source?.offsetDeg),
	      baseDistanceM:Number.isFinite(baseDistance)&&baseDistance>0?baseDistance:155
	    };
	    const depth=Number(source?.bubbleDepthM);
	    if(Number.isFinite(depth)&&depth>0)out.bubbleDepthM=depth;
	    const widthM=Number(source?.bubbleWidthM);
	    if(Number.isFinite(widthM)&&widthM>0)out.bubbleWidthM=widthM;
	    const radius=Number(source?.lateralRadiusDeg);
	    if(!Number.isFinite(out.bubbleWidthM)&&Number.isFinite(radius)&&radius>0)out.lateralRadiusDeg=radius;
	    return out;
	  }
	  function gdOffsetHubBubbleSource(ctx){
	    const current=Number(ctx?.current);
	    const sources=[ctx?.courseBubble,ctx?.practiceBubble].filter(source=>source&&Number.isFinite(Number(source.offsetDeg)));
	    if(!sources.length){
	      return{offsetDeg:0,bubbleDepthM:18,lateralRadiusDeg:.45,baseDistanceM:155};
	    }
	    const bases=sources.map(source=>Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM)).filter(value=>Number.isFinite(value)&&value>0);
	    const baseDistance=gdShotBubbleMedian(bases)||155;
	    const depths=sources.map(source=>Number(source.bubbleDepthM)).filter(value=>Number.isFinite(value)&&value>0);
	    const widths=sources.map(source=>{
	      const widthM=Number(source.bubbleWidthM);
	      if(Number.isFinite(widthM)&&widthM>0)return widthM;
	      const radius=Number(source.lateralRadiusDeg);
	      const base=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM)||baseDistance;
	      return Number.isFinite(radius)&&radius>0?Math.tan(radius*Math.PI/180)*Math.max(1,base)*2:null;
	    }).filter(value=>Number.isFinite(value)&&value>0);
	    return{
	      offsetDeg:Number.isFinite(current)?current:0,
	      bubbleDepthM:gdShotBubbleMedian(depths)||18,
	      bubbleWidthM:gdShotBubbleMedian(widths)||null,
	      lateralRadiusDeg:widths.length?null:.45,
	      baseDistanceM:baseDistance
	    };
	  }
  function gdCourseDataComparison(){
    return window.GolfDaddyCourseDataComparison||window.GolfDaddy?.modules?.courseDataComparison||null;
  }
  function gdCourseTransferScore(){
    return window.GolfDaddyCourseTransferScore||window.GolfDaddy?.modules?.courseTransferScore||null;
  }
  function gdCourseImplementationInsight(){
    return window.GolfDaddyCourseImplementationInsight||window.GolfDaddy?.modules?.courseImplementationInsight||null;
  }
  function gdCompareCoursePoints(ctx){
    const records=(ctx.courseRecords||[]).slice(0,70);
    if(!records.length)return [];
    const comparison=gdCourseDataComparison();
    const actualDistanceForRecord=record=>{
      const actual=Number(record.actualDistanceM);
      if(Number.isFinite(actual))return actual;
      const expected=Number(record.expectedDistanceM);
      const depth=Number(record.depthM);
      if(Number.isFinite(expected)&&Number.isFinite(depth))return expected+depth;
      return Number.isFinite(expected)?expected:NaN;
    };
    return records.map((record,index)=>{
      /* The Course Bubble / Comparison Layer decides whether this shot compares
         against My Bubble on its raw or its wind/slope-normalised position. It
         only substitutes when the Conditions Engine applied normalisation, so a
         record with no analysis falls through to exactly the previous maths. */
      const values=comparison?comparison.comparisonValues(record):null;
      const actual=values&&Number.isFinite(Number(values.actualDistanceM))
        ?Number(values.actualDistanceM)
        :actualDistanceForRecord(record);
      const lateral=values&&values.normalisationApplied&&Number.isFinite(Number(values.lateralM))
        ?{value:Number(values.lateralM),hasLateral:true}
        :gdShotChartLateralInfo(record,actual);
      return {
        index,
        source:"course",
        club:record.club||"Unknown",
        actualDistanceM:actual,
        lateralM:lateral.value,
        hasLateral:lateral.hasLateral,
        counted:record.counted!==false,
        excluded:record.counted===false,
        normalisationApplied:!!(values&&values.normalisationApplied),
        normalisationType:values?values.normalisationType:null,
        rawActualDistanceM:values?values.rawActualDistanceM:actualDistanceForRecord(record),
        rawLateralM:values?values.rawLateralM:null
      };
    }).filter(point=>Number.isFinite(Number(point.actualDistanceM))&&Number(point.actualDistanceM)>0);
  }
  function gdComparePracticePoints(ctx){
    const shots=gdPracticePlotShots(ctx.practiceAnalysis).slice(0,120);
    if(!shots.length)return [];
    const actualPracticeDistance=shot=>{
      const carry=Number(shot?.carryM);
      if(Number.isFinite(carry))return carry;
      const expected=Number(shot?.expectedM);
      const depth=Number(shot?.depthM);
      if(Number.isFinite(expected)&&Number.isFinite(depth))return expected+depth;
      return Number.isFinite(expected)?expected:NaN;
    };
    const all=shots.map((shot,index)=>{
      const actual=actualPracticeDistance(shot);
      const lateral=gdShotChartLateralInfo(shot,actual);
      return{
        index,
        shotId:shot.shotId||"",
        source:"practice",
        club:shot.club||"Unknown",
        actualDistanceM:actual,
        lateralM:lateral.value,
        hasLateral:lateral.hasLateral,
        counted:true,
        excluded:!gdPracticePlotAllRowsForTest()&&!!shot.rejected,
        rejectReason:shot.rejectReason||""
      };
    }).filter(point=>Number.isFinite(Number(point.actualDistanceM))&&Number(point.actualDistanceM)>0);
    const rows=all.filter(point=>!point.excluded&&point.hasLateral!==false&&Number.isFinite(Number(point.actualDistanceM))&&Number.isFinite(Number(point.lateralM)));
    if(rows.length<5)return all.map(point=>Object.assign({},point,{counted:false}));
    const rowsByClub=new Map();
    rows.forEach(point=>{
      const club=String(point.club||"Unknown");
      if(!rowsByClub.has(club))rowsByClub.set(club,[]);
      rowsByClub.get(club).push(point);
    });
    const counted=new Set();
    rowsByClub.forEach(clubRows=>{
      if(clubRows.length<5)return;
      const need=Math.max(5,Math.ceil(clubRows.length*.28));
      let best=null;
      clubRows.forEach(anchor=>{
        const ranked=clubRows.map(point=>{
          const dx=(Number(point.actualDistanceM)-Number(anchor.actualDistanceM))*1.4;
          const dy=(Number(point.lateralM)-Number(anchor.lateralM))*8;
          return{point,dist:dx*dx+dy*dy};
        }).sort((a,b)=>a.dist-b.dist).slice(0,need);
        const radius=Math.sqrt(Math.max(...ranked.map(item=>item.dist)));
        if(!best||radius<best.radius)best={ranked,radius};
      });
      (best?.ranked||[]).forEach(item=>counted.add(item.point.index));
    });
    return all.map(point=>Object.assign({},point,{counted:counted.has(point.index)}));
  }
		  let gdCompareClub="";
		  function gdCompareClubLabel(club=gdCompareClub){
		    const value=String(club||"").trim();
		    return value.toLowerCase()==="7i"?"7iron":value;
		  }
		  function gdCompareClubKey(club){
		    const value=String(club||"").trim();
		    return /^7\s*(i|iron)$/i.test(value)?"7i":value;
		  }
		  function gdCompareAvailableClubs(ctx){
		    const clubs=[];
		    const add=club=>{
		      const value=gdCompareClubKey(club);
		      if(value&&!clubs.some(item=>item.toLowerCase()===value.toLowerCase()))clubs.push(value);
		    };
		    const p=ctx?.p||safe(()=>ensureProfile(),null);
		    if(p?.bubbleProfiles&&typeof p.bubbleProfiles==="object")Object.keys(p.bubbleProfiles).forEach(add);
		    add(p?.previewBubbleSet?.club);
		    add(p?.baseCalibration?.club);
		    (Array.isArray(p?.bag)?p.bag:[]).forEach(row=>add(row?.club||row?.name));
		    add(ctx?.courseBubble?.club);
		    add(ctx?.practiceBubble?.club);
		    if(!clubs.length){
		      const defaults=gdShotBubbleSafe(()=>typeof gdDefaultBagRows==="function"?gdDefaultBagRows():[],[])||[];
		      defaults.forEach(row=>add(row?.club||row?.name));
		    }
		    if(!clubs.length)["Driver","3w","5w","4i","5i","6i","7i","8i","9i","PW","GW","SW"].forEach(add);
		    return clubs;
		  }
		  function gdCompareNormaliseClub(club,ctx){
		    const options=gdCompareAvailableClubs(ctx);
		    if(!options.length)return "";
		    const value=gdCompareClubKey(club);
		    const match=options.find(item=>item.toLowerCase()===String(value).toLowerCase());
		    if(match)return match;
		    return options.find(item=>item.toLowerCase()==="7i")||options[0];
		  }
		  function gdCompareSetClub(value){
		    gdCompareClub=gdCompareNormaliseClub(value,gdComparisonContext());
		    try{localStorage.setItem("gd_compare_bubble_club_v1",gdCompareClub)}catch(e){}
		    gdPaintCompareVisual();
		    return false;
		  }
		  function gdCompareLoadClub(ctx){
		    const options=gdCompareAvailableClubs(ctx);
		    if(!options.length){
		      gdCompareClub="";
		      return "";
		    }
		    let stored="";
		    try{stored=localStorage.getItem("gd_compare_bubble_club_v1")||""}catch(e){}
		    gdCompareClub=gdCompareNormaliseClub(gdCompareClub||stored||"7i",ctx);
		    return gdCompareClub;
		  }
		  function gdCompareClubOptions(selected,ctx){
		    return gdCompareAvailableClubs(ctx)
		      .map(club=>`<option value="${gdStatsSvgText(club)}"${club===selected?" selected":""}>${gdStatsSvgText(gdCompareClubLabel(club))}</option>`)
		      .join("");
		  }
		  function gdCompareManualProfileBubbleSource(p,club,offset){
		    if(!p||!Number.isFinite(Number(offset)))return null;
		    const bagRows=Array.isArray(p.bag)?p.bag:[];
		    const selected=gdCompareClubKey(club)||gdCompareClubKey(p?.baseCalibration?.club)||gdCompareClubKey(p?.previewBubbleSet?.club)||"7i";
		    const row=bagRows.find(item=>gdCompareClubKey(item?.club||item?.name).toLowerCase()===selected.toLowerCase())
		      ||bagRows.find(item=>gdCompareClubKey(item?.club||item?.name).toLowerCase()==="7i")
		      ||bagRows[0]
		      ||null;
		    const sourceClub=gdCompareClubKey(row?.club||row?.name)||selected;
		    const carry=Number(row?.baseCarry??row?.carry??row?.carryM??row?.distance??row?.meters??p?.baseCalibration?.baseCarry);
		    const baseCarry=Number.isFinite(carry)&&carry>0?carry:gdShotBubbleSafe(()=>gdDefaultCarryForClub(sourceClub),155);
		    const totalM=Number(row?.totalM??row?.total??row?.rolloutM);
		    const input=Object.assign({},p.baseCalibration||{},{
		      club:sourceClub,
		      baseCarry,
		      totalM:Number.isFinite(totalM)&&totalM>=baseCarry?totalM:gdShotBubbleSafe(()=>gdBagTotalForCarry(sourceClub,baseCarry),baseCarry),
		      handedness:p.handedness||"right",
		      skillLevel:p.skillLevel||p.consistency,
		      faceOffsetDeg:Number(offset),
		      faceAlignmentOffsetDeg:Number(offset),
		      shapeSource:"manual-profile"
		    });
		    try{
		      const profile=typeof calculateBubbleProfile==="function"?calculateBubbleProfile(input):null;
		      if(profile)return Object.assign({},profile,{shapeSource:"manual-profile"});
		    }catch(e){}
		    return{
		      club:sourceClub,
		      baseCarry,
		      baseDistanceM:baseCarry,
		      faceOffsetDeg:Number(offset),
		      faceAlignmentOffsetDeg:Number(offset),
		      bubbleWidthM:Math.max(10,baseCarry*.14),
		      bubbleDepthM:Math.max(14,baseCarry*.19),
		      clusterWidthM:Math.max(10,baseCarry*.14),
		      clusterDepthM:Math.max(14,baseCarry*.19),
		      handedness:p.handedness||"right",
		      shapeSource:"manual-profile"
		    };
		  }
		  function gdCompareProfileBubbleSource(ctx,club){
		    const p=ctx?.p;
		    if(!p||(!p.practiceBubbleSource?.active&&p.placeholderProfile)||!Number.isFinite(Number(ctx?.current)))return null;
		    const selected=gdCompareClubKey(club);
		    // Pending (staged via Adopt Bubble, shape computed from real shots) takes
		    // priority - same ordering Practice's own hub source uses - since it
		    // represents what My Bubble is about to become, not a fallback.
		    const pending=gdShotBubbleSafe(()=>typeof gdPracticePendingBubbleSource==="function"?gdPracticePendingBubbleSource(p):null,null);
		    const pendingSource=pending&&pending.active&&pending.bubble&&Number.isFinite(Number(pending.offsetDeg))?pending.bubble:null;
		    const exact=selected&&p.bubbleProfiles&&typeof p.bubbleProfiles==="object"?p.bubbleProfiles[selected]:null;
		    const preview=p.previewBubbleSet&&(!selected||gdCompareClubKey(p.previewBubbleSet.club)===selected)?p.previewBubbleSet:null;
		    // No generic/model fallback here on purpose: My Bubble on Comparison
		    // must be real - pending, a fully saved bubble, or nothing at all -
		    // never a silently-generated textbook shape standing in for real data.
		    const source=pendingSource||exact||preview||null;
		    if(!source)return null;
		    const baseDistance=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM||source.baseCarry);
		    const depth=Number(source.bubbleDepthM||source.clusterDepthM||source.visualDepthM);
		    const width=Number(source.bubbleWidthM||source.clusterWidthM||source.visualWidthM);
		    if(!Number.isFinite(baseDistance)||baseDistance<=0||!Number.isFinite(depth)||depth<=0||!Number.isFinite(width)||width<=0)return null;
		    return Object.assign({},source,{offsetDeg:Number(ctx.current),baseDistanceM:baseDistance,bubbleDepthM:depth,bubbleWidthM:width,club:source.club||selected});
		  }
		  function gdCompareBubbleSize(source,club){
		    if(!source)return null;
		    const carry=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM);
		    if(!Number.isFinite(carry)||carry<=0)return null;
	    return gdShotBubbleSizeSource(source,source?.offsetDeg);
	  }
	  function gdCompareDisplayCarryForClub(club,fallback=155){
	    const key=gdCompareClubKey(club)||"7i";
	    const p=safe(()=>ensureProfile(),null);
	    const row=(Array.isArray(p?.bag)?p.bag:[]).find(item=>gdCompareClubKey(item?.club||item?.name).toLowerCase()===key.toLowerCase());
	    const carry=Number(row?.baseCarry??row?.carry??row?.carryM??row?.distance??row?.meters);
	    if(Number.isFinite(carry)&&carry>0)return carry;
	    return gdShotBubbleSafe(()=>gdDefaultCarryForClub(key),fallback)||fallback;
	  }
	  function gdCompareDisplayBubbleSize(size,kind,displayClub){
	    if(!size)return null;
	    const sourceCarry=Number(size.baseDistanceM);
	    if(!Number.isFinite(sourceCarry)||sourceCarry<=0)return size;
	    const sourceClub=gdCompareClubKey(size.club)||gdCompareClubKey(displayClub)||"7i";
	    const targetClub=gdCompareClubKey(displayClub)||"7i";
	    const targetCarry=gdCompareDisplayCarryForClub(targetClub,sourceCarry);
	    const sourceDefaults=gdShotBubbleSafe(()=>gdGetClubPatternDefaults(sourceClub),null)||{};
	    const targetDefaults=gdShotBubbleSafe(()=>gdGetClubPatternDefaults(targetClub),null)||sourceDefaults||{};
	    const sourceStandardWidth=Math.max(10,sourceCarry*(Number(sourceDefaults.width)||.148));
	    const sourceStandardDepth=Math.max(13,sourceCarry*(Number(sourceDefaults.depth)||.195));
	    const targetStandardWidth=Math.max(10,targetCarry*(Number(targetDefaults.width)||.148));
	    const targetStandardDepth=Math.max(13,targetCarry*(Number(targetDefaults.depth)||.195));
	    const width=Number(size.bubbleWidthM);
	    const depth=Number(size.bubbleDepthM);
	    const radius=Number(size.lateralRadiusDeg);
	    const widthFromRadius=Number.isFinite(radius)&&radius>0?Math.tan(radius*Math.PI/180)*sourceCarry*2:NaN;
	    const rawWidth=Number.isFinite(width)&&width>0?width:(Number.isFinite(widthFromRadius)?widthFromRadius:sourceStandardWidth);
	    const rawDepth=Number.isFinite(depth)&&depth>0?depth:sourceStandardDepth;
	    const rawArea=Math.max(1,rawWidth*rawDepth);
	    const standardArea=Math.max(1,sourceStandardWidth*sourceStandardDepth);
	    const relationScale=kind==="playing"
	      ? 1
	      : gdShotBubbleOverlayClamp(Math.sqrt(rawArea/standardArea),.76,1.34);
	    const next=Object.assign({},size);
	    next.club=targetClub;
	    next.baseDistanceM=targetCarry;
	    next.bubbleWidthM=targetStandardWidth*relationScale;
	    next.bubbleDepthM=targetStandardDepth*relationScale;
	    delete next.lateralRadiusDeg;
	    return next;
	  }
	  function gdCompareBubbleParts(item,anchorDistanceM){
	    const rawOffset=Number(item.offset);
	    if(!Number.isFinite(rawOffset))return [];
	    const size=gdCompareBubbleSize(item.source);
	    const carry=Number(size?.baseDistanceM||item.source?.baseDistanceM||item.source?.expectedDistanceM||item.source?.meanExpectedM);
	    const depth=Number(size?.bubbleDepthM);
	    const widthM=Number(size?.bubbleWidthM);
	    const radiusDeg=Number(size?.lateralRadiusDeg);
	    const itemClub=gdCompareClubKey(size?.club||item.source?.club||"7i")||"7i";
	    const anchor=Number(anchorDistanceM);
	    const hasShape=Number.isFinite(anchor)&&anchor>0&&Number.isFinite(carry)&&carry>0&&Number.isFinite(depth)&&depth>0&&(Number.isFinite(widthM)&&widthM>0||Number.isFinite(radiusDeg)&&radiusDeg>0);
	    if(!hasShape)return [];
	    const referenceRows=[{
	      club:itemClub,
	      actualDistanceM:carry,
	      bubbleDepthM:depth,
	      bubbleWidthM:Number.isFinite(widthM)&&widthM>0?widthM:null,
	      lateralRadiusDeg:Number.isFinite(radiusDeg)&&radiusDeg>0?radiusDeg:null,
	      handedness:item.source?.handedness
	    }];
	    return gdBubbleRelativeParts(referenceRows,rawOffset,anchor);
	  }
	  function gdCompareBubbleLayerSvg(item,parts,plot){
	    const className=item.kind==="playing"?"gdComparePlayingBubble":"gdCompareEvidenceBubble";
	    const muted=parts.length?1:.34;
	    const layer=parts.length?gdPracticeNormalisedBubbleLayerMarkup(parts,plot,{
	      offsetDeg:Number(item.offset)||0,
	      groupClass:`gdShotBubbleOverlayLayer gdCompareBubbleLayer gdCompareBubbleLayer-${item.kind}`,
	      source:item.kind==="playing"?"my-bubble":item.kind,
	      colour:item.stroke,
	      fillOpacity:item.fillOpacity||".12",
	      strokeOpacity:item.strokeOpacity||".82",
	      strokeWidth:item.kind==="playing"?"1.7":"1.55",
	      labelText:item.label
	    }):"";
	    return `<g class="${className}" opacity="${muted}">
	      ${layer}
	    </g>`;
	  }
	  function gdCompareSvg(ctx){
	    const plotBox=gdPracticeNormalisedPlotLayout();
	    const width=plotBox.chartWidth,height=plotBox.chartHeight;
	    const club=gdCompareLoadClub(ctx);
	    const currentSource=gdCompareProfileBubbleSource(ctx,club);
	    const courseSource=ctx.courseBubble||null;
	    const practiceSource=ctx.practiceBubble||null;
	    const items=[
	      {kind:"playing",label:"My Bubble",offset:Number(ctx.current),source:currentSource,stroke:"#f4f8f3",fillOpacity:".10",strokeOpacity:".78"},
	      {kind:"course",label:"Course Bubble",offset:Number(ctx.course),source:courseSource,stroke:"#37f28d",fillOpacity:".13",strokeOpacity:".84"},
	      {kind:"practice",label:"Practice Bubble",offset:Number(ctx.practice),source:practiceSource,stroke:"#62d2ff",fillOpacity:".13",strokeOpacity:".84"}
	    ];
	    // Anchor for the relative-% depth axis. Prefer My Bubble's own distance,
	    // tied to the bag - never a generic/display club.
	    //
	    // But do NOT require it. Comparison shows whatever the home screens are
	    // already showing, so it must not be gated on adoption: with a Practice and
	    // a Course bubble but no My Bubble yet, both still belong here. This used to
	    // read the anchor from My Bubble alone, so a missing My Bubble left the
	    // anchor null and gdCompareBubbleParts dropped EVERY bubble - the screen sat
	    // empty waiting for an adoption that has nothing to do with it.
	    const anchorFor=source=>{
	      if(!source)return null;
	      const size=gdCompareBubbleSize(source);
	      const distance=Number(size?.baseDistanceM||source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM);
	      return Number.isFinite(distance)&&distance>0?distance:null;
	    };
	    const anchorSource=[currentSource,practiceSource,courseSource].find(source=>anchorFor(source))||null;
	    const anchorDistanceM=anchorFor(anchorSource);
	    const anchorLabel=!anchorSource?""
	      :anchorSource===currentSource?"My Bubble"
	      :anchorSource===practiceSource?"Practice Bubble":"Course Bubble";
	    const bubblePartsByItem=items.map(item=>gdCompareBubbleParts(item,anchorDistanceM));
	    const allParts=bubblePartsByItem.flat();
	    // Same plot box as Practice's chart (gd-route-audit.js practiceSvg) so
	    // identical bubble data renders at an identical shape on both screens.
	    const plot=plotBox;
	    const bubbleSvg=items.map((item,i)=>gdCompareBubbleLayerSvg(item,bubblePartsByItem[i],plot)).join("");
	    // Same buffer band as Course, around the same My Bubble. This is where the
	    // Course and Practice bubbles get read against the allowance, so it has to
	    // be here too. Drawn under the bubbles so they stay legible on top.
	    const bufferPct=gdCourseBubbleBufferPct();
	    const playingPart=(bubblePartsByItem[0]||[])[0];
	    const bufferSvg=gdGraphBufferBandMarkup(playingPart,gdGraphBufferPart(playingPart,1+bufferPct/100),plot);
	    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="My Bubble, Course and Practice bubble comparison">
	      ${gdPracticeNormalisedBackdropSvg(plot,gdShotDataGraphTitle("Comparison"),{subtitle:`Distance vs ${anchorLabel||"My Bubble"} (%) \u00b7 aim angle (\u00b0)${playingPart?` \u00b7 band = My Bubble +${Math.round(bufferPct)}%`:""}`})}
	      ${bufferSvg}
	      ${bubbleSvg}
	    </svg>`;
	  }
  let gdCompareExpandedSource="practice";
  let gdDataHubCompareOpen=false;
  // === Data Hub accordion ===
  // The hub owns three sections: course / compare / practice. Course and
  // Practice are the original module panels physically embedded as section
  // bodies (all their ids, classes and render functions keep working).
  let gdDataHubActiveSection=null;
  const GD_HUB_SECTIONS={
    course:{host:"gdHubCourseHost",panel:"statsPanel",btn:"gdCourseDataOpenBtn"},
    compare:{host:"gdHubCompareExpansion",panel:"",btn:"gdCompareDataOpenBtn"},
    practice:{host:"gdHubPracticeHost",panel:"practiceDataPanel",btn:"gdPracticeDataOpenBtn"}
  };
  function gdInitDataHubAccordion(){
    const courseHost=byId("gdHubCourseHost");
    const practiceHost=byId("gdHubPracticeHost");
    const stats=byId("statsPanel");
    const practice=byId("practiceDataPanel");
    if(courseHost&&stats&&stats.parentElement!==courseHost){stats.classList.add("gdHubEmbedded");courseHost.appendChild(stats);}
    if(practiceHost&&practice&&practice.parentElement!==practiceHost){practice.classList.add("gdHubEmbedded");practiceHost.appendChild(practice);}
  }
  function gdHubSetSection(section,opts={}){
    gdInitDataHubAccordion();
    const requested=GD_HUB_SECTIONS[section]?section:null;
    const next=(gdDataHubActiveSection===requested&&!opts.force)?null:requested;
    gdDataHubActiveSection=next;
    gdDataHubCompareOpen=next==="compare";
    Object.keys(GD_HUB_SECTIONS).forEach(key=>{
      const def=GD_HUB_SECTIONS[key];
      const host=byId(def.host);
      const active=key===next;
      host?.toggleAttribute("hidden",!active);
      host?.classList.toggle("gdHubSectionOpen",active);
      if(def.panel)byId(def.panel)?.classList.toggle("open",active);
    });
    gdRenderDataHubCards();
    if(next==="course"){
      document.body.classList.add("gdShotDataOpen");
      safe(()=>typeof renderStats==="function"&&renderStats());
      safe(()=>typeof gdRenderCourseDataSurfaceFallback==="function"&&gdRenderCourseDataSurfaceFallback());
    }else if(next==="practice"){
      safe(()=>gdPracticeSyncBubbleSourcesToBag({skipRender:true}));
      safe(()=>typeof renderPracticeData==="function"&&renderPracticeData());
    }else if(next==="compare"){
      gdSyncDataHubCompare();
      safe(()=>typeof renderCompareData==="function"&&renderCompareData());
    }
    if(next!=="compare")gdRenderComparePracticeProjector(null);
    return false;
  }
  const gdDataHubCardCopy={
    course:`<div class="ico">⛳</div><div><strong>Course Data</strong><span>GPS and scorecard shot data filed under a course label. This is the on-course truth layer.</span></div>`,
    practice:`<div class="ico">◉</div><div><strong>Practice Data</strong><span>Launch monitor captures and Clarity Pattern Finder evidence. Kept separate from course rounds.</span></div>`,
    compare:`<div class="ico">↔</div><div><strong>Comparison</strong><span>View Course and Practice recommendation values together. Jump back to each source to change the evidence.</span></div>`
  };
  function gdCompareSetSource(source){
    gdCompareExpandedSource=source==="course"?"course":"practice";
    if(gdDataHubActiveSection!=="compare")return gdHubSetSection("compare",{force:true});
    gdDataHubCompareOpen=true;
    gdSyncDataHubCompare();
    renderCompareData();
    return false;
  }
  function gdRenderDataHubCards(){
    const panel=byId("dataHubPanel");
    const active=gdDataHubActiveSection;
    const expanded=!!active&&!!panel?.classList.contains("open");
    const compareExpanded=expanded&&active==="compare";
    panel?.classList.toggle("gdHubSectionExpanded",expanded);
    panel?.classList.toggle("gdCompareExpanded",compareExpanded);
    panel?.classList.toggle("gdCompareSourceCourse",compareExpanded&&gdCompareExpandedSource==="course");
    panel?.classList.toggle("gdCompareSourcePractice",compareExpanded&&gdCompareExpandedSource!=="course");
    Object.keys(GD_HUB_SECTIONS).forEach(key=>{
      const btn=byId(GD_HUB_SECTIONS[key].btn);
      if(!btn)return;
      btn.classList.toggle("active",expanded&&key===active);
      btn.classList.remove("widget","title");
      btn.setAttribute("aria-expanded",expanded&&key===active?"true":"false");
      btn.innerHTML=gdDataHubCardCopy[key];
      // While Comparison is expanded the Practice tab carries the compact
      // Generate / Adopt Bubble + bag controls (same maths and handlers as
      // the practice screen) instead of duplicating them inside the
      // comparison expansion.
      const practiceTabDock=key==="practice"&&compareExpanded;
      btn.classList.toggle("hasPracticeTabDock",practiceTabDock);
      if(practiceTabDock){
        const analysis=safe(()=>gdComparisonContext().practiceAnalysis,null)||safe(()=>typeof gdPracticeDisplayAnalysis==="function"?gdPracticeDisplayAnalysis():null,null);
        btn.insertAdjacentHTML("beforeend",`<div class="gdPracticeTabCompactDock" data-gd-card-control onpointerdown="event.stopPropagation()" onclick="event.stopPropagation()">${gdPracticeProjectionControlsHTML(analysis)}</div>`);
      }
    });
    document.querySelectorAll("#dataHubPanel .gdHubSection").forEach(section=>{
      section.classList.toggle("gdHubActive",expanded&&section.dataset.hubSection===active);
    });
    const sourceSwitch=byId("gdCompareSourceSwitch");
    sourceSwitch?.querySelectorAll("button").forEach(btn=>{
      btn.classList.toggle("active",btn.dataset.src===gdCompareExpandedSource);
    });
  }
  function gdSyncDataHubCompare(){
    const expanded=!!gdDataHubCompareOpen&&!!byId("dataHubPanel")?.classList.contains("open");
    byId("gdHubCompareExpansion")?.toggleAttribute("hidden",!expanded);
    gdRenderDataHubCards();
    if(expanded){
      const ctx=gdComparisonContext();
      gdPaintCompareVisual();
      gdRenderComparePracticeProjector(ctx);
    }else{
      gdRenderComparePracticeProjector(null);
    }
  }
  function gdCloseDataHubCompare(){
    if(gdDataHubActiveSection==="compare")gdHubSetSection(null);
    gdDataHubCompareOpen=false;
    gdSyncDataHubCompare();
    renderDataHubStatus();
    return false;
  }
  function gdDataHubCourseAction(){
    return gdHubSetSection("course");
  }
  function gdDataHubPracticeAction(){
    return gdHubSetSection("practice");
  }
  function gdCompareSourceTab(source,title,control,active=false){
    const openButton=`<button class="gdCompareSourceOpen" data-gd-card-control type="button" onclick="return gdOpenCompareSourcePage('${source}',event)">Open</button>`;
    if(active||control)return `<div class="gdCompareSourceShell active${control?"":" simple"}"><div class="gdCompareSourceTitle active"><strong>${gdStatsSvgText(title)}</strong>${openButton}</div>${control?`<div class="gdCompareSourceControl">${control}</div>`:""}</div>`;
    return `<div class="gdCompareSourceShell"><div class="gdCompareSourceTitle"><strong>${gdStatsSvgText(title)}</strong>${openButton}</div></div>`;
  }
  function gdOpenCompareSourcePage(source,event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    return gdHubSetSection(source==="course"?"course":"practice",{force:true});
  }
  function gdCompareCourseCompact(){
    const ctx=gdComparisonContext();
    const rows=Array.isArray(ctx.courseRecords)?ctx.courseRecords:[];
    const counted=rows.filter(row=>row&&row.counted!==false).length;
    const bubble=gdCourseBubbleValueLabel(ctx.courseAnalysis,ctx.courseFiltered,rows);
    const body=`<div class="gdCompareLibraryStats"><span>${counted}/${rows.length} counted</span><span>${gdStatsConsistencyPct}% cluster setting</span></div><div class="gdCompareCourseSummary" data-gd-card-control onpointerdown="event.stopPropagation()" onclick="event.stopPropagation()">
      <div class="gdCompareCourseConsistency" data-gd-card-control>
        <div><span>Consistency</span><strong class="gdCompareCompactValue">${gdStatsConsistencyPct}%</strong></div>
        <input data-gd-card-control type="range" min="51" max="80" step="1" value="${gdStatsConsistencyPct}" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation()" oninput="gdCompareSetConsistency(this.value,this)" onchange="gdCompareSetConsistency(this.value,this)">
      </div>
    </div>`;
    return gdShotDataLibraryShellHTML({kind:"course",title:"Course Library",bubbleLabel:"Course Bubble",bubbleValue:bubble,count:rows.length,bodyHTML:body,compact:true,stopPropagation:true,dropdown:true,open:gdShotDataLibraryIsOpen("course")});
  }
  function gdComparePracticeAdminIsOpen(){
    return !!byId("dataHubPanel")?.classList.contains("gdComparePracticeAdminExpanded");
  }
  function gdCompareTogglePracticeAdmin(force){
    const panel=byId("dataHubPanel");
    const open=typeof force==="boolean"?force:!gdComparePracticeAdminIsOpen();
    panel?.classList.toggle("gdComparePracticeAdminExpanded",open);
    gdRenderDataHubCards();
    return false;
  }
  function gdComparePracticeCompact(){
    const canEdit=gdPracticeToleranceCanEdit();
    const pct=gdPracticeToleranceMasterPct();
    const adminOpen=gdComparePracticeAdminIsOpen();
    const ctx=gdComparisonContext();
    const count=Number(ctx.practiceShots)||gdComparePracticePoints(ctx).length||0;
    const bubble=gdPracticeBubbleValueLabel(ctx.practiceAnalysis);
    const adminButton=canEdit?`<button type="button" class="gdComparePracticeAdminBtn ${adminOpen?"active":""}" data-gd-card-control onclick="return gdCompareTogglePracticeAdmin()">Admin</button>`:"";
    const adminControls=adminOpen?`<div class="gdComparePracticeControls" data-gd-card-control onpointerdown="event.stopPropagation()" onclick="event.stopPropagation()">
      <div class="gdComparePracticeMaster">
        <div class="gdComparePracticeHead"><span>Tolerance</span><strong class="gdCompareCompactValue">${pct}%</strong></div>
        <input data-gd-card-control type="range" min="0" max="100" step="1" value="${pct}" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation()" oninput="gdComparePreviewPracticeToleranceMaster(this)" onchange="gdCompareSetPracticeToleranceMaster(this.value,this)" ${canEdit?"":"disabled"}>
      </div>
    </div>`:"";
    const body=`<div class="gdCompareLibraryStats"><span>${count} stored shot${count===1?"":"s"}</span>${adminButton}</div>${adminControls}`;
    return gdShotDataLibraryShellHTML({kind:"practice",title:"Clarity Shot Library",bubbleLabel:"Practice Bubble",bubbleValue:bubble,count,bodyHTML:body,compact:true,stopPropagation:true,dropdown:true,open:gdShotDataLibraryIsOpen("practice")});
  }
  function gdCompareSliderValueEl(input){
    return input?.parentElement?.querySelector(".gdCompareCompactValue")||null;
  }
  function gdRefreshPracticeComparisonVisuals(){
    gdPaintCompareVisual();
    renderPracticeData(true);
  }
	  function gdCompareFallbackSvg(error){
	    const width=480,height=260;
	    const plot=gdShotChartLayout([],[],{plotLeft:30,plotRight:450,plotTop:82,plotBottom:224});
	    const note=error?`<text x="240" y="142" text-anchor="middle" fill="rgba(255,255,255,.52)" font-size="10" font-weight="850">Comparison data will appear here.</text>`:"";
	    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Course and Practice comparison visual">
	      ${gdShotChartBackdropSvg(plot,gdShotDataGraphTitle("Comparison"))}
	      ${note}
	    </svg>`;
	  }
	  function gdCompareMyBubbleRows(ctx){
	    const coursePoints=gdCompareCoursePoints(ctx||{});
	    const practicePoints=gdComparePracticePoints(ctx||{});
	    const activePoints=coursePoints.concat(practicePoints).filter(point=>point&&point.counted!==false&&!point.excluded);
	    return gdShotBubbleOverlayReferenceRows(activePoints).filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0);
	  }
	  function gdSyncCompareOverlayControl(ctx){
	    const control=document.querySelector('[data-gd-overlay-control="compare"]');
	    if(!control)return;
	    const rows=gdCompareMyBubbleRows(ctx||gdComparisonContext());
	    const hasRows=rows.length>0;
	    control.hidden=!hasRows;
	    control.classList.toggle("disabled",!hasRows);
	    control.setAttribute("aria-disabled",hasRows?"false":"true");
	    if(!hasRows&&gdShotBubbleOverlayEnabled("compare")){
	      gdShotBubbleOverlayState.compare=false;
	      window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
	      document.documentElement.dataset.gdOverlayCompare="off";
	    }
	    gdSyncShotBubbleOverlayControls("compare");
	  }
	  function gdPaintCompareVisual(){
	    const visual=byId("gdHubCompareDataVisual");
	    if(!visual)return false;
	    try{
	      const ctx=gdComparisonContext();
	      visual.innerHTML=gdCompareSvg(ctx);
	      gdSyncCompareOverlayControl(ctx);
	      delete visual.dataset.gdCompareError;
	    }catch(e){
	      console.warn("[GolfDaddy] compare visual render skipped",e);
	      visual.dataset.gdCompareError=String(e&&e.message?e.message:e);
	      visual.innerHTML=gdCompareFallbackSvg(e);
	      gdSyncCompareOverlayControl({});
	    }
	    return true;
	  }
  function gdComparePreviewPracticeToleranceMaster(input){
    const pct=Math.max(0,Math.min(100,Math.round(Number(input.value)||0)));
    const el=gdCompareSliderValueEl(input);
    if(el)el.textContent=`${pct}%`;
    gdApplyPracticeToleranceMaster(pct,{preserveCompareTab:true});
  }
  function gdComparePreviewPracticeToleranceField(path,input){
    if(!gdPracticeToleranceCanEdit())return;
    const f=DEV_FIELDS[path]||{};
    let n=Number(input.value);
    if(!Number.isFinite(n))n=Number(devDefault(path));
    n=Math.max(Number(f.min),Math.min(Number(f.max),n));
    gdPracticeWriteTolerance(path,n);
    const el=gdCompareSliderValueEl(input);
    if(el)el.textContent=gdPracticeToleranceDisplay(path,n);
    gdRefreshPracticeComparisonVisuals();
  }
  function gdPracticeToleranceMasterPct(){
    const fromSettings=gdPracticeToleranceMasterPctFromSettings();
    if(Number.isFinite(fromSettings))return fromSettings;
    const stored=safe(()=>Number(localStorage.getItem("gd_practice_tolerance_master_pct")),NaN);
    return Number.isFinite(stored)?Math.max(0,Math.min(100,Math.round(stored))):50;
  }
  function gdToleranceRoundToStep(value,step,min=0){
    const s=Number(step)||1;
    const base=Number(min)||0;
    return base+Math.round((value-base)/s)*s;
  }
  const gdPracticeHighIsStrictToleranceFields=new Set([
    "launchMonitorCluster.resultConsistencyPct",
    "launchMonitorCluster.minClusterShots",
    "launchMonitorCluster.minVerificationClubs",
    "launchMonitorCluster.smashMin"
  ]);
  function gdPracticeToleranceMasterValue(path,pct){
    const f=DEV_FIELDS[path]||{};
    const def=Number(devDefault(path));
    const min=Number(f.min);
    const max=Number(f.max);
    if(!Number.isFinite(def)||!Number.isFinite(min)||!Number.isFinite(max))return def;
    const highIsStrict=gdPracticeHighIsStrictToleranceFields.has(path);
    const strict=highIsStrict?max:min;
    const loose=highIsStrict?min:max;
    const t=Math.max(0,Math.min(100,Number(pct)||0));
    if(t===0)return Math.max(min,Math.min(max,strict));
    if(t===50)return Math.max(min,Math.min(max,def));
    if(t===100)return Math.max(min,Math.min(max,loose));
    const raw=t<50?strict+(def-strict)*(t/50):def+(loose-def)*((t-50)/50);
    return Math.max(min,Math.min(max,gdToleranceRoundToStep(raw,f.step,min)));
  }
  function gdPracticeToleranceMasterPctFromSettings(){
    if(typeof dev!=="function"||typeof devDefault!=="function")return NaN;
    let bestPct=NaN;
    let bestScore=Infinity;
    for(let pct=0;pct<=100;pct++){
      let score=0;
      gdPracticeMasterToleranceFields.forEach(path=>{
        const f=DEV_FIELDS[path]||{};
        const current=Number(dev(path));
        const target=Number(gdPracticeToleranceMasterValue(path,pct));
        const range=Math.max(.0001,Math.abs(Number(f.max)-Number(f.min)));
        if(Number.isFinite(current)&&Number.isFinite(target))score+=Math.pow((current-target)/range,2);
      });
      if(score<bestScore){bestScore=score;bestPct=pct;}
    }
    return bestPct;
  }
  function gdCompareSetPracticeToleranceMaster(value,input){
    const pct=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
    const el=gdCompareSliderValueEl(input);
    if(el)el.textContent=`${pct}%`;
    gdApplyPracticeToleranceMaster(pct,{preserveCompareTab:true});
    if(document.getElementById("developerPanel")?.classList.contains("open"))renderDevPanel();
  }
  function gdCompareSetPracticeToleranceField(path,value){
    if(!gdPracticeToleranceCanEdit())return;
    const f=DEV_FIELDS[path]||{};
    let n=Number(value);
    if(!Number.isFinite(n))n=Number(devDefault(path));
    n=Math.max(Number(f.min),Math.min(Number(f.max),n));
    gdPracticeWriteTolerance(path,n);
    renderPracticeData(true);
    renderCompareData();
  }
  function gdCompareCourseControl(key,value){
    gdStatsView[key]=value;
    renderCompareData();
  }
  function gdCompareSetConsistency(value,input){
    gdStatsConsistencyPct=Math.max(51,Math.min(80,Math.round(Number(value)||68)));
    try{localStorage.setItem("gd_stats_consistency_pct",String(gdStatsConsistencyPct))}catch(e){}
    const el=gdCompareSliderValueEl(input);
    if(el)el.textContent=`${gdStatsConsistencyPct}%`;
    gdPaintCompareVisual();
  }
  function renderCompareData(){
    const ctx=gdComparisonContext();
    gdPaintCompareVisual();
    gdRenderComparePracticeProjector(ctx);
    gdRenderDataHubCards();
  }
  function gdInstallOffsetHubTabs(){
    document.querySelectorAll("details.gdOffsetHubDetails[data-gd-offset-hub]:not([data-gd-offset-tab-ready])").forEach(details=>{
      details.dataset.gdOffsetTabReady="1";
      details.addEventListener("toggle",()=>{if(details.open)gdRenderBubbleOffsetHub(true);});
    });
    document.querySelectorAll(".gdShotDataHubCard[data-gd-offset-hub]:not(.gdOffsetHubDetails)").forEach(card=>{
      if(card.dataset.gdOffsetTabReady==="1")return;
      const head=card.querySelector(".gdBubbleGenHead");
      const title=head?.querySelector("div");
      const actions=head?.querySelector(".gdBubbleOffsetActions");
      const grid=card.querySelector(".gdBubbleGenGrid");
      if(!head||!title||!grid)return;
      const tab=document.createElement("button");
      tab.type="button";
      tab.className="gdBubbleGenHead gdOffsetHubSummary gdOffsetHubButton";
      tab.setAttribute("aria-expanded","false");
      tab.innerHTML=title.outerHTML;
      const body=document.createElement("div");
      body.className="gdOffsetHubBody";
      body.hidden=true;
      if(actions)body.appendChild(actions);
      body.appendChild(grid);
      head.remove();
      card.classList.add("gdOffsetHubDetails");
      card.dataset.gdOffsetTabReady="1";
      card.prepend(tab);
      card.appendChild(body);
      tab.addEventListener("click",()=>{
        const open=body.hidden;
        body.hidden=!open;
        card.classList.toggle("open",open);
        tab.setAttribute("aria-expanded",open?"true":"false");
        if(open)gdRenderBubbleOffsetHub(true);
      });
    });
  }
  function gdMyBubbleHubSource(ctx,club,offset,opts={}){
    const p=ctx?.p||safe(()=>ensureProfile(),null)||{};
    const pending=gdPracticePendingBubbleSource(p,opts);
    if(pending.active&&pending.bubble&&Number.isFinite(Number(pending.offsetDeg))){
      const pendingSource=gdGpsReadyMyBubbleSource(pending.bubble,{offsetDeg:Number(pending.offsetDeg),club:pending.club,handedness:p?.handedness});
      return pendingSource?Object.assign({},pendingSource,{shapeSource:pendingSource.shapeSource||"practice-pending-save"}):null;
    }
    // ONLY AN ACTIVE SOURCE COUNTS. A saved SHAPE left on the profile is not a My
    // Bubble on its own. Nothing in the app ever deletes `previewBubbleSet` or
    // `bubbleProfiles`, so an old shape outlives everything - unadopting drops the
    // pending stage, clearing practice data drops the source, and the shape stays.
    // Reading the shape alone rendered a My Bubble on Course while the UI (which
    // reads `practiceBubbleSource`/`faceOffsetDeg`) correctly reported none set.
    // Same question, two answers. The source is the answer.
    if(!p?.practiceBubbleSource||p.practiceBubbleSource.active!==true)return null;
    const selected=gdCompareClubKey(club)||gdCompareClubKey(p?.previewBubbleSet?.club)||"7i";
    const currentOffset=Number.isFinite(Number(offset))?Number(offset):0;
    const exactKey=selected&&p?.bubbleProfiles&&typeof p.bubbleProfiles==="object"
      ? Object.keys(p.bubbleProfiles).find(key=>gdCompareClubKey(key).toLowerCase()===String(selected).toLowerCase())
      : "";
    const exact=exactKey?p.bubbleProfiles[exactKey]:null;
    const preview=p?.previewBubbleSet&&(!selected||gdCompareClubKey(p.previewBubbleSet.club)===selected)?p.previewBubbleSet:null;
    const profileSource=exact||preview;
    if(profileSource&&typeof profileSource==="object"){
      const strict=gdGpsReadyMyBubbleSource(profileSource,{offsetDeg:currentOffset,club:selected,handedness:p?.handedness});
      return strict?Object.assign({},strict,{shapeSource:strict.shapeSource||"my-bubble-current"}):null;
    }
    // No generic/model fallback here on purpose: My Bubble must be either a
    // real saved bubble or nothing at all, never a silently-generated
    // textbook shape standing in for real data or an explicit setting.
    return null;
  }
  function gdRenderBubbleOffsetHub(manual=false){
    gdInstallOffsetHubTabs();
    const {p}=gdBubbleDataContext();
    const faces=[...document.querySelectorAll(".gdBubbleFaceOffsetInput")];
    const sources=[...document.querySelectorAll(".gdBubbleOffsetSource")];
    const editing=faces.some(face=>face.dataset.editing==="1");
    const state=gdMyBubbleState(p,gdPracticeProjectionReadyAnalysis());
    const stateLabel=gdMyBubbleDisplayLabel(state,editing);
    const stateKind=String(state?.kind||"default");
    document.querySelectorAll("[data-gd-offset-hub]").forEach(hub=>{
      hub.dataset.gdBubbleKind=stateKind;
      hub.classList.toggle("gdMyBubbleActive",stateKind==="adopted-current"||stateKind==="pending");
      const buttons=[...hub.querySelectorAll(".gdBubbleOffsetActions button")];
      if(buttons[0])buttons[0].textContent=stateKind==="pending"?"Undo":"Edit";
      if(buttons[1]){
        buttons[1].textContent=stateKind==="pending"?"Save":"Apply";
        buttons[1].classList.toggle("gdBubbleSaveReady",stateKind==="pending");
      }
    });
    faces.forEach(face=>{
      face.readOnly=!editing;
      if(!manual&&!editing)face.value=stateLabel;
    });
	    const focusedFace=document.activeElement?.classList?.contains("gdBubbleFaceOffsetInput")?document.activeElement:null;
	    const visibleFace=document.querySelector(".modulePanel.open .gdBubbleFaceOffsetInput")||document.querySelector("#statsPanel.open .gdBubbleFaceOffsetInput");
	    const internalOffset=Number(state?.offset);
	    const liveOffset=gdParseOffsetValue(focusedFace?.value??visibleFace?.value??faces.find(face=>face.dataset.editing==="1")?.value??faces[0]?.value,Number.isFinite(internalOffset)?internalOffset:gdBubbleCentralOffset(p));
	    const ctx=gdComparisonContext();
	    const club=safe(()=>gdCompareLoadClub(ctx),gdCompareClub)||"7i";
	    const hubPreviewOffset=editing&&Number.isFinite(liveOffset)?liveOffset:(Number.isFinite(internalOffset)?internalOffset:0);
	    const hubBubbleSource=gdMyBubbleHubSource(ctx,club,hubPreviewOffset);
	    const hubBubble=hubBubbleSource?Object.assign({},hubBubbleSource,{previewKind:"playing"}):null;
	    const hubPreviewHTML=hubBubble?gdShotBubbleHubSvg(Number.isFinite(hubPreviewOffset)?hubPreviewOffset:Number(hubBubble.offsetDeg)||0,hubBubble):"";
	    document.querySelectorAll(".gdShotBubbleHubPreview").forEach(preview=>{
	      preview.innerHTML=hubPreviewHTML;
	    });
    sources.forEach(source=>{
	      source.classList.add("gdMyBubbleLaneSource");
	      if(!source.querySelector(".gdShotBubbleHubPreview")){
		        source.innerHTML=`<div class="gdShotBubbleHubPreview">${hubPreviewHTML}</div>`;
      }
      source.dataset.gdBubbleState=stateLabel;
      source.dataset.gdBubbleKind=stateKind;
      source.setAttribute("aria-label",stateLabel);
    });
    if(manual){
      if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
      if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    }
  }
  let gdMyBubbleLaneDrag=null;
  function gdMyBubbleLaneDistanceFromEvent(svg,event){
    if(!svg||!event)return null;
    const rect=svg.getBoundingClientRect();
    if(!rect||!rect.width)return null;
    const viewWidth=Number(svg.dataset.viewboxWidth||svg.dataset.viewBoxWidth)||480;
    const plotLeft=Number(svg.dataset.plotLeft)||30;
    const plotRight=Number(svg.dataset.plotRight)||452;
    const laneM=Number(svg.dataset.laneM)||250;
    const x=((Number(event.clientX)-rect.left)/Math.max(1,rect.width))*viewWidth;
    const pct=gdShotBubbleOverlayClamp((x-plotLeft)/Math.max(1,plotRight-plotLeft),0,1);
    return Math.round(pct*laneM*10)/10;
  }
  function gdMyBubbleStageLaneDistance(distance,opts={}){
    const requestedDistance=Number(distance);
    if(!Number.isFinite(requestedDistance)||requestedDistance<=0)return false;
    const p=ensureProfile();
    const analysis=gdPracticeProjectionReadyAnalysis();
    const state=gdMyBubbleState(p,analysis);
    const offset=Number(state?.offset);
    if(!Number.isFinite(offset)){
      gdLmToast("My Bubble not ready");
      return false;
    }
	    const ctx=gdComparisonContext();
	    const club=safe(()=>gdCompareLoadClub(ctx),gdCompareClub)||p?.previewBubbleSet?.club||"7i";
	    const baseSource=gdMyBubbleHubSource(ctx,club,offset,{ignoreLanePreview:true});
	    if(!baseSource){
	      gdLmToast("GPS Bubble needed");
	      return false;
	    }
	    const sourceClub=gdCompareClubKey(baseSource.club||club)||"7i";
	    const nextDistance=gdMyBubbleClampLaneDistance(requestedDistance,sourceClub,baseSource);
	    const sourceDistance=Number(baseSource.baseDistanceM||baseSource.expectedDistanceM||baseSource.meanExpectedM||baseSource.baseCarry);
	    if(!Number.isFinite(sourceDistance)||sourceDistance<=0){
	      gdLmToast("GPS Bubble needed");
	      return false;
	    }
	    const presentation=gdMyBubblePresentationMetrics(baseSource,{distanceM:nextDistance,offsetDeg:offset,club:sourceClub,handedness:p.handedness||baseSource.handedness});
	    const width=Number(presentation?.widthM);
	    const depth=Number(presentation?.depthM);
	    if(!Number.isFinite(depth)||depth<=0||!Number.isFinite(width)||width<=0){
	      gdLmToast("GPS Bubble needed");
	      return false;
	    }
	    const baseTilt=Number(presentation.tiltDeg);
	    const baseSkew=Number(presentation.skewDeg);
	    const pendingBubble=Object.assign({},baseSource,{
	      club:sourceClub,
	      baseCarry:nextDistance,
	      baseDistanceM:nextDistance,
	      expectedDistanceM:nextDistance,
      meanExpectedM:nextDistance,
      centerDistanceM:nextDistance,
      centerLateralM:gdShotBubbleGpsLateralForOffset(offset,nextDistance),
      faceOffsetDeg:offset,
      faceAlignmentOffsetDeg:offset,
      offsetDeg:offset,
      bubbleWidthM:width,
      clusterWidthM:width,
      bubbleDepthM:depth,
      clusterDepthM:depth,
      lateralRadiusM:width/2,
	      depthRadiusM:depth/2,
	      radiusM:presentation.radiusM,
	      tiltDeg:Number.isFinite(baseTilt)?baseTilt:presentation.tiltDeg,
	      skewDeg:Number.isFinite(baseSkew)?baseSkew:presentation.skewDeg,
	      visual:Object.assign({},baseSource.visual||{},{
	        visualWidthM:width,
	        visualDepthM:depth,
	        visualTiltDeg:Number.isFinite(baseTilt)?baseTilt:presentation.tiltDeg,
	        visualSkewDeg:Number.isFinite(baseSkew)?baseSkew:presentation.skewDeg
	      }),
	      handedness:presentation.handedness,
	      shapeSource:"my-bubble-distance-preview"
    });
    const current=gdPracticePendingBubbleSource(p,{ignoreLanePreview:true});
    gdSetMyBubbleLanePreviewPendingSource({
      active:true,
      offsetDeg:Number(offset.toFixed(2)),
      status:"distance_preview",
      club:sourceClub,
      shots:Number(current.shots||0),
      fingerprint:current.fingerprint||"my-bubble-distance-preview",
      distanceMode:"manual-preview",
      bubble:pendingBubble
    });
    if(opts.render==="preview"){
      gdRenderBubbleOffsetHub();
      return true;
    }
    if(opts.render!==false){
      gdRenderBubbleOffsetHub();
      renderPracticeData(true);
      renderDataHubStatus();
      if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
      renderCompareData();
    }
    return true;
  }
  function gdWireMyBubbleLaneDrag(){
    if(window.__gdMyBubbleLaneDragBound)return;
    window.__gdMyBubbleLaneDragBound=true;
    document.addEventListener("pointerdown",event=>{
      const svg=event.target?.closest?.("svg[data-gd-my-bubble-lane='1']");
      if(!svg)return;
      const handle=event.target?.closest?.("[data-gd-lane-drag-handle='1']");
      if(!handle)return;
      if(event.button&&event.button!==0)return;
      const distance=gdMyBubbleLaneDistanceFromEvent(svg,event);
      if(!Number.isFinite(Number(distance)))return;
      event.preventDefault();
      event.stopPropagation();
      gdMyBubbleLaneDrag={pointerId:event.pointerId,svg,lastDistance:distance,startX:event.clientX,startY:event.clientY,active:false};
      svg.classList.add("dragging");
      try{svg.setPointerCapture(event.pointerId)}catch(e){}
    },true);
    document.addEventListener("pointermove",event=>{
      const drag=gdMyBubbleLaneDrag;
      if(!drag||drag.pointerId!==event.pointerId)return;
      const svg=drag.svg?.isConnected?drag.svg:document.querySelector("svg[data-gd-my-bubble-lane='1']");
      const distance=gdMyBubbleLaneDistanceFromEvent(svg,event);
      if(!Number.isFinite(Number(distance)))return;
      event.preventDefault();
      event.stopPropagation();
      if(!drag.active){
        const moved=Math.abs(Number(event.clientX)-Number(drag.startX));
        if(moved<5)return;
        drag.active=true;
      }
      if(Math.abs(Number(distance)-Number(drag.lastDistance))<.5)return;
      drag.lastDistance=distance;
      gdMyBubbleStageLaneDistance(distance,{persist:false,render:"preview"});
    },true);
    const finish=event=>{
      const drag=gdMyBubbleLaneDrag;
      if(!drag||drag.pointerId!==event.pointerId)return;
      const svg=drag.svg?.isConnected?drag.svg:document.querySelector("svg[data-gd-my-bubble-lane='1']");
      const distance=gdMyBubbleLaneDistanceFromEvent(svg,event);
      event.preventDefault();
      event.stopPropagation();
      if(svg)svg.classList.remove("dragging");
      gdMyBubbleLaneDrag=null;
      if(drag.active&&Number.isFinite(Number(distance))&&gdMyBubbleStageLaneDistance(distance,{persist:true})){
        gdLmToast("My Bubble distance ready to save");
      }
    };
    document.addEventListener("pointerup",finish,true);
    document.addEventListener("pointercancel",finish,true);
  }
  function gdActiveOffsetInput(){
    return document.querySelector(".modulePanel.open .gdBubbleFaceOffsetInput")||document.querySelector("#statsPanel.open .gdBubbleFaceOffsetInput")||document.querySelector(".gdBubbleFaceOffsetInput");
  }
  function gdBubbleOffsetEdit(){
    const face=gdActiveOffsetInput();
    if(!face)return;
    const {p}=gdBubbleDataContext();
    if(gdMyBubbleLanePreviewPendingSource()){
      gdClearMyBubbleLanePreviewPendingSource();
      gdRenderBubbleOffsetHub();
      renderPracticeData(true);
      renderDataHubStatus();
      renderCompareData();
      gdLmToast("Preview cleared");
      return;
    }
    if(gdPracticePendingBubbleIsActive(p)){
      const pendingMode=String(p.practiceBubblePendingSource?.distanceMode||"");
      delete p.practiceBubblePendingSource;
      delete p.practiceBubblePendingAt;
      if(pendingMode!=="manual-preview"){
        try{localStorage.removeItem(GD_PRACTICE_BAG_DRAFT_KEY);}catch(e){}
      }
      p.updatedAt=new Date().toISOString();
      savePlayerProfiles();
      syncCoreProfileFromActive();
      gdPracticeBubbleAdoptionMotion=null;
      gdRenderBubbleOffsetHub();
      renderPracticeData(true);
      renderDataHubStatus();
      renderCompareData();
      gdLmToast("Pending My Bubble cleared");
      return;
    }
    const offset=gdParseOffsetValue(face.value,gdBubbleCentralOffset(gdBubbleDataContext().p));
    document.querySelectorAll(".gdBubbleFaceOffsetInput").forEach(input=>{input.dataset.editing="1";input.readOnly=false;input.value=gdMyBubbleDisplayLabel(gdMyBubbleState(gdBubbleDataContext().p),true);});
    gdRenderBubbleOffsetHub(true);
    face.focus();
    face.select?.();
  }
  // The only way to remove a My Bubble. Before this there was none: nothing in the
  // app deleted previewBubbleSet or bubbleProfiles, so a saved bubble could only
  // ever be replaced by another save, never cleared. Wipes the source, the pending
  // stage and the saved shapes together, so the state cannot split again.
  function gdClearMyBubble(){
    const {p}=gdBubbleDataContext();
    if(!p)return false;
    const hasAnything=!!(p.practiceBubbleSource||p.practiceBubblePendingSource||p.previewBubbleSet||(p.bubbleProfiles&&Object.keys(p.bubbleProfiles).length));
    if(!hasAnything){
      gdLmToast("No My Bubble to clear");
      return false;
    }
    return gdConfirmAction({
      title:"Clear My Bubble?",
      message:"Removes the saved bubble, its shape and any pending adoption. Your practice and course data are untouched.",
      confirmLabel:"Clear"
    },()=>{
      delete p.practiceBubbleSource;
      delete p.practiceBubblePendingSource;
      delete p.practiceBubblePendingAt;
      delete p.practiceBubblePreviousState;
      delete p.practiceBubbleAdoptedAt;
      delete p.previewBubbleSet;
      delete p.bubbleProfiles;
      p.faceOffsetDeg=0;
      p.centralFaceOffsetDeg=0;
      p.updatedAt=new Date().toISOString();
      safe(()=>gdClearMyBubbleLanePreviewPendingSource());
      savePlayerProfiles();
      syncCoreProfileFromActive();
      gdRenderBubbleOffsetHub();
      renderPracticeData(true);
      renderDataHubStatus();
      if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
      renderCompareData();
      safe(()=>typeof renderShot==="function"&&renderShot());
      gdLmToast("My Bubble cleared");
    });
  }
  function gdBubbleOffsetSave(){
    if(window.ClarityPayments?.requireAccess&&!window.ClarityPayments.requireAccess("set your own bubble centre"))return false;
    const {p}=gdBubbleDataContext();
    const previewPending=gdMyBubbleLanePreviewPendingSource();
    const pending=previewPending||p.practiceBubblePendingSource||{};
    if(pending.active&&Number.isFinite(Number(pending.offsetDeg))){
      const offset=Number(pending.offsetDeg);
      const analysis=gdPracticeProjectionReadyAnalysis();
      const pendingBubble=pending.bubble&&typeof pending.bubble==="object"?pending.bubble:{};
      const club=pending.club||pendingBubble.club||gdCompareClub||"7i";
      const rawBaseDistance=Number(pendingBubble.baseDistanceM||pendingBubble.baseCarry||pendingBubble.expectedDistanceM)||gdShotBubbleSafe(()=>gdDefaultCarryForClub(club),155)||155;
      const baseDistance=pending.distanceMode==="manual-preview"?gdMyBubbleClampLaneDistance(rawBaseDistance,club,pendingBubble):rawBaseDistance;
      // Store under the normalised club, never the practice label. `club` above can
      // be "Practice oval" - a display label - and using it as the key orphaned the
      // bubble from every lookup that asks by real club.
      const storageClub=gdMyBubbleStorageClub(club);
      const bubble=Object.assign({},pendingBubble,{
        club:storageClub,
        displayClub:club,
        baseCarry:baseDistance,
        baseDistanceM:baseDistance,
        faceOffsetDeg:offset,
        faceAlignmentOffsetDeg:offset,
        offsetDeg:offset,
        handedness:p.handedness||pendingBubble.handedness||"right",
        shapeSource:pendingBubble.shapeSource||"practice-adopted"
      });
      if(pending.distanceMode==="committed")gdPracticeApplyDistanceLearning(analysis,{commit:true});
      else if(pending.distanceMode==="review")gdPracticeApplyDistanceLearning(analysis,{commit:false});
      p.faceOffsetDeg=offset;
      p.centralFaceOffsetDeg=offset;
      p.placeholderProfile=false;
      p.previewBubbleSet=bubble;
      p.bubbleProfiles=Object.assign({},p.bubbleProfiles||{});
      p.bubbleProfiles[storageClub]=bubble;
      p.practiceBubbleSource={
        active:true,
        offsetDeg:Number(offset.toFixed(2)),
        status:pending.status||"",
        club,
        shots:Number(pending.shots||0),
        fingerprint:pending.fingerprint||gdPracticeBubbleFingerprint(analysis),
        distanceMode:pending.distanceMode||"review",
        practiceDistanceM:Number(pending.practiceDistanceM)||null
      };
      p.practiceBubbleAdoptedAt=new Date().toISOString();
      delete p.practiceBubblePendingSource;
      delete p.practiceBubblePendingAt;
      delete p.practiceBubblePreviousState;
      gdClearMyBubbleLanePreviewPendingSource();
      p.updatedAt=new Date().toISOString();
      savePlayerProfiles();
      syncCoreProfileFromActive();
      document.querySelectorAll(".gdBubbleFaceOffsetInput").forEach(input=>{input.dataset.editing="0";input.readOnly=true;input.value=gdMyBubbleDisplayLabel(gdMyBubbleState(p,analysis));});
      gdRenderBubbleOffsetHub();
      renderPracticeData(true);
      renderDataHubStatus();
      if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
      renderCompareData();
      safe(()=>typeof renderShot==="function"&&renderShot());
      gdLmToast("My Bubble saved");
      return;
    }
    const face=gdActiveOffsetInput();
    const offset=gdParseOffsetValue(face?.value,gdBubbleCentralOffset(p));
    if(!Number.isFinite(offset)){toast("Enter a face offset");return}
    p.faceOffsetDeg=offset;
    p.centralFaceOffsetDeg=offset;
    const applyOffset=source=>source&&typeof source==="object"
      ? Object.assign({},source,{faceOffsetDeg:offset,faceAlignmentOffsetDeg:offset,offsetDeg:offset})
      : source;
    if(p.previewBubbleSet)p.previewBubbleSet=applyOffset(p.previewBubbleSet);
    if(p.bubbleProfiles&&typeof p.bubbleProfiles==="object"){
      Object.keys(p.bubbleProfiles).forEach(key=>{
        p.bubbleProfiles[key]=applyOffset(p.bubbleProfiles[key]);
      });
    }
    if(!p.previewBubbleSet&&(!p.bubbleProfiles||!Object.keys(p.bubbleProfiles).length)){
      const selected=gdCompareClub||p.baseCalibration?.club||(Array.isArray(p.bag)&&p.bag.find(row=>gdCompareClubKey(row?.club||row?.name).toLowerCase()==="7i")?.club)||"7i";
      const source=gdCompareManualProfileBubbleSource(p,selected,offset);
      if(source){
        p.previewBubbleSet=source;
        p.bubbleProfiles=Object.assign({},p.bubbleProfiles||{});
        p.bubbleProfiles[gdCompareClubKey(source.club||selected)||"7i"]=source;
      }
    }
    p.updatedAt=new Date().toISOString();
    savePlayerProfiles();
    syncCoreProfileFromActive();
    document.querySelectorAll(".gdBubbleFaceOffsetInput").forEach(input=>{input.dataset.editing="0";input.readOnly=true;input.value=gdMyBubbleDisplayLabel(gdMyBubbleState(p));});
    gdRenderBubbleOffsetHub();
    if(document.getElementById("statsPanel")?.classList.contains("open"))renderStats();
    renderCompareData();
    renderDataHubStatus();
    toast("Offset saved");
  }
  function gdCourseDataAdminCanManage(){
    return safe(()=>typeof gdCourseDataCanManage==="function"&&gdCourseDataCanManage(),false);
  }
  function gdCourseDataAdminFallbackHTML(){
    const badge=gdCourseDataAdminCanManage()?"Admin editable":"Locked by permission";
    if(!gdCourseDataAdminCanManage())return `<div class="gdShotAdminHead"><div><strong>Course Data admin</strong><span>Coach/admin only.</span></div><div class="gdShotAdminBadge">${badge}</div></div>`;
    // The sandbox generator has to be here too: an empty store is exactly when
    // you need to feed the plumbing something.
    return `<div class="gdShotAdminHead"><div><strong>Course Data admin</strong><span>Permission-gated management lives here, away from the normal shot view.</span></div><div class="gdShotAdminBadge">${badge}</div></div>${gdRenderCourseDataUploadHTML()}${gdRenderCourseDataTuningHTML()}${gdRenderSandboxGeneratorHTML()}<div class="gdShotAdminList"><div class="gdShotAdminEmpty">No paired course shots to manage yet.</div></div>`;
  }
  const gdCourseDataTuningFields=[
    "statsCluster.consistencyMinPct",
    "statsCluster.consistencyMaxPct",
    "statsCluster.consistencyDefaultPct",
    "statsCluster.distanceWindowPct",
    "statsCluster.distanceWindowMinM",
    "statsCluster.distanceWindowMaxM",
    "statsCluster.viableDegreeAbs",
    "statsCluster.alignmentDegreeAbs",
    "statsCluster.minClusterShots",
    "statsCluster.minSuggestionClubs",
    "statsCluster.maxClusterStdDeg",
    "statsCluster.maxClusterRangeDeg"
  ];
  const gdAutoNextShotTuningFields=[
    "autoNextShot.enabled",
    "autoNextShot.movementM",
    "autoNextShot.accuracyMaxM",
    "autoNextShot.cooldownS",
    "autoNextShot.requireLiveGps"
  ];
  function gdDataTuningDisplay(path,value){
    const f=DEV_FIELDS[path]||{};
    const n=Number(value);
    if(!Number.isFinite(n))return "-";
    if(path==="autoNextShot.enabled"||path==="autoNextShot.requireLiveGps"||path==="liveWind.enabled")return n?"On":"Off";
    if(path.endsWith("Pct")){
      const pct=Math.abs(n)<=1?Math.round(n*100):Math.round(n);
      return `${pct}%`;
    }
    return `${formatDev(n)}${f.unit||""}`;
  }
  function gdCourseDataTuningLabel(path,fallback){
    const labels={
      "statsCluster.consistencyMinPct":"Fit min",
      "statsCluster.consistencyMaxPct":"Fit max",
      "statsCluster.consistencyDefaultPct":"Fit default",
      "statsCluster.distanceWindowPct":"Distance %",
      "statsCluster.distanceWindowMinM":"Window min",
      "statsCluster.distanceWindowMaxM":"Window max",
      "statsCluster.viableDegreeAbs":"Viable deg",
      "statsCluster.alignmentDegreeAbs":"Align deg",
      "statsCluster.minClusterShots":"Min shots",
      "statsCluster.minSuggestionClubs":"Min clubs",
      "statsCluster.maxClusterStdDeg":"Spread",
      "statsCluster.maxClusterRangeDeg":"Range",
      "autoNextShot.enabled":"Auto next shot",
      "autoNextShot.movementM":"Movement",
      "autoNextShot.accuracyMaxM":"GPS accuracy",
      "autoNextShot.cooldownS":"Cooldown",
      "autoNextShot.requireLiveGps":"Live GPS only"
    };
    return labels[path]||fallback||path;
  }
  function gdWriteDataTuning(path,value,opts={}){
    const parts=path.split(".");
    let target=devSettings;
    for(let i=0;i<parts.length-1;i++)target=target[parts[i]];
    target[parts.at(-1)]=value;
    gdPersistAdminTuning();
    if(path.startsWith("statsCluster.")){
      gdStatsConsistencyPct=gdStatsClampConsistency(gdStatsConsistencyPct);
      try{localStorage.setItem("gd_stats_consistency_pct",String(gdStatsConsistencyPct))}catch(e){}
      renderStats();
      if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    }
    if(path.startsWith("launchMonitorCluster.")){
      renderPracticeData(true);
      if(document.getElementById("dataHubPanel")?.classList.contains("open"))renderCompareData();
    }
    if(!opts.skipShotRender&&typeof renderShot==="function")renderShot();
  }
  // Course data gates mirror the practice admin layout: sectioned sliders
  // (same CSS classes as the practice tolerance panel) instead of one flat
  // "Cluster settings" grid.
  const gdCourseToleranceSections=[
    {label:"Course Bubble",meta:"Single cluster",fields:[
      "statsCluster.minClusterShots",
      "statsCluster.maxClusterStdDeg",
      "statsCluster.maxClusterRangeDeg",
      "statsCluster.viableDegreeAbs",
      "statsCluster.alignmentDegreeAbs",
      "statsCluster.minSuggestionClubs"
    ]},
    {label:"Consistency",meta:"Fit slider",fields:[
      "statsCluster.consistencyMinPct",
      "statsCluster.consistencyMaxPct",
      "statsCluster.consistencyDefaultPct"
    ]},
    {label:"Intake gates",meta:"Before cluster",fields:[
      "statsCluster.distanceWindowPct",
      "statsCluster.distanceWindowMinM",
      "statsCluster.distanceWindowMaxM"
    ]},
    /* Analysis-only. These never touch the in-round wind aim tool; they set how
       the Conditions Engine splits wind between distance and direction when
       deciding whether wind explains a shot. Editing them mints a new tolerance
       profile version so earlier analyses stay explainable. */
    {label:"Wind normalisation",meta:"Conditions Engine",fields:[
      "conditionsEngine.headwindFactor",
      "conditionsEngine.tailwindFactor",
      "conditionsEngine.crosswindFactor",
      "conditionsEngine.crosswindGateDeg"
    ]}
  ];
  const gdCourseToleranceCompactLabels={
    "statsCluster.minClusterShots":"Min shots",
    "statsCluster.maxClusterStdDeg":"Spread",
    "statsCluster.maxClusterRangeDeg":"Range",
    "statsCluster.viableDegreeAbs":"Viable deg",
    "statsCluster.alignmentDegreeAbs":"Align deg",
    "statsCluster.minSuggestionClubs":"Suggest clubs",
    "statsCluster.consistencyMinPct":"Slider min",
    "statsCluster.consistencyMaxPct":"Slider max",
    "statsCluster.consistencyDefaultPct":"Default fit",
    "conditionsEngine.headwindFactor":"Headwind",
    "conditionsEngine.tailwindFactor":"Tailwind",
    "conditionsEngine.crosswindFactor":"Crosswind",
    "conditionsEngine.crosswindGateDeg":"Cross gate",
    "statsCluster.distanceWindowPct":"Miss vs bag %",
    "statsCluster.distanceWindowMinM":"Miss floor",
    "statsCluster.distanceWindowMaxM":"Miss cap"
  };
  const gdCourseToleranceCompactHelp={
    "statsCluster.minClusterShots":"Fewest counted course shots before a cluster can speak.",
    "statsCluster.maxClusterStdDeg":"Maximum standard deviation allowed in the course cluster.",
    "statsCluster.maxClusterRangeDeg":"Maximum left/right angle range allowed in the course cluster.",
    "statsCluster.viableDegreeAbs":"Offset limit for a cluster to become a Course Bubble candidate.",
    "statsCluster.alignmentDegreeAbs":"Beyond this, a strong cluster is flagged as an alignment signal.",
    "statsCluster.minSuggestionClubs":"Clubs needed before profile suggestions are made.",
    "statsCluster.consistencyMinPct":"Lowest selectable containment setting.",
    "statsCluster.consistencyMaxPct":"Highest selectable containment setting.",
    "statsCluster.consistencyDefaultPct":"Default containment for Shot Data fit checks.",
    "statsCluster.distanceWindowPct":"Max distance miss as a % of the club's bag number. Not absolute distance - deviation from the expected carry.",
    "statsCluster.distanceWindowMinM":"Smallest allowed miss-vs-bag window (protects short clubs).",
    "statsCluster.distanceWindowMaxM":"Largest allowed miss-vs-bag window (caps the % for long clubs)."
  };
  function gdRenderCourseDataTuningHTML(){
    const canEdit=gdCourseDataAdminCanManage();
    const rowHTML=path=>{
      const f=DEV_FIELDS[path]||{};
      const value=Number(dev(path));
      const id=`gdCourseTol_${path.replace(/[^a-z0-9]/gi,"_")}`;
      const label=gdCourseToleranceCompactLabels[path]||f.label||path;
      const help=gdCourseToleranceCompactHelp[path]||f.help||"";
      return `<div class="gdPracticeTolerance" title="${gdEscapeHTML(help)}"><label for="${id}"><span>${gdEscapeHTML(label)}</span>${help?`<small>${gdEscapeHTML(help)}</small>`:""}</label><input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${Number.isFinite(value)?value:devDefault(path)}" data-course-tuning-path="${path}" ${canEdit?"":"disabled"}><output>${gdDataTuningDisplay(path,value)}</output></div>`;
    };
    return `<div class="gdPracticeTolerancePanel gdCourseTolerancePanel ${canEdit?"":"locked"}">`+
      `<div class="gdPracticeToleranceHead"><div><strong>Course Bubble controls</strong></div><div class="gdPracticeToleranceBadge">${canEdit?"Admin":"Locked"}</div></div>`+
      `<div class="gdPracticeToleranceSections">${gdCourseToleranceSections.map(section=>`<section class="gdPracticeToleranceSection"><div class="gdPracticeToleranceSectionHead"><strong>${gdEscapeHTML(section.label)}</strong><span>${gdEscapeHTML(section.meta||"")}</span></div><div class="gdPracticeToleranceGrid">${section.fields.map(rowHTML).join("")}</div></section>`).join("")}</div></div>`;
  }
  function gdRenderCourseDataUploadHTML(){
    const canEdit=gdCourseDataAdminCanManage();
    return `<div class="gdDataImportPanel ${gdCourseImportOpen?"open":""} ${canEdit?"":"locked"}"><button type="button" class="gdDataImportToggle" aria-expanded="${gdCourseImportOpen?"true":"false"}" onclick="return gdToggleCourseImport(event)"><span>Import</span><i aria-hidden="true">▾</i></button><div class="gdDataImportBody"><div><strong>Raw course data</strong><span>Upload testing shots or native ShotEvents JSON.</span></div><button type="button" ${canEdit?"":"disabled"} onclick="return gdPickRawCourseDataFile()">Upload</button><button type="button" ${canEdit?"":"disabled"} onclick="gdClearCourseShotData();return false">Clear</button></div></div>`;
  }
  function gdBindCourseDataTuningControls(root){
    root?.querySelectorAll("[data-course-tuning-path]").forEach(input=>{
      input.oninput=()=>{
        const path=input.dataset.courseTuningPath;
        const f=DEV_FIELDS[path]||{};
        let value=Number(input.value);
        if(!Number.isFinite(value))value=Number(devDefault(path));
        value=Math.max(Number(f.min),Math.min(Number(f.max),value));
        gdWriteDataTuning(path,value,{skipShotRender:true});
        const out=input.parentElement?.querySelector("output");
        if(out)out.textContent=gdDataTuningDisplay(path,value);
      };
      input.onchange=()=>{if(document.getElementById("developerPanel")?.classList.contains("open"))renderDevPanel();};
    });
  }
  // ---------------------------------------------------------------------------
  // SANDBOX DATA GENERATOR
  // Feeds the shot-data plumbing with made-up batches so the pipes can be tested
  // without going and hitting balls. Both generators fill an EDITABLE textarea
  // first - randomise, tweak by hand, then submit - so a specific case can be
  // reproduced exactly rather than only sampled randomly.
  //
  // Neither generator bypasses the real intake:
  //   Course   -> plannedShots + outcomes written to the shot-event store, the
  //               same shapes gd-shot-outcomes.js produces from real GPS.
  //   Practice -> native CSV pushed through gdParseNativePracticeImport(), the
  //               exact path a real launch-monitor paste takes.
  //
  // NOTE: by choice there is no sandbox flag - injected shots are written into
  // the live store and are indistinguishable from real ones. "Clear" in the
  // Import panel above is the only way back.
  // ---------------------------------------------------------------------------
  const GD_SANDBOX_FIELDS={
    course:[
      {id:"gdSandboxCourseCount",label:"Shots",value:14,min:1,max:60,step:1},
      {id:"gdSandboxCourseCarry",label:"Carry (m)",value:150,min:30,max:320,step:1},
      {id:"gdSandboxCourseOffsetMin",label:"Aim min (°)",value:-3,min:-20,max:20,step:.1},
      {id:"gdSandboxCourseOffsetMax",label:"Aim max (°)",value:3,min:-20,max:20,step:.1},
      {id:"gdSandboxCourseDepthMin",label:"Depth min (%)",value:-8,min:-40,max:40,step:.5},
      {id:"gdSandboxCourseDepthMax",label:"Depth max (%)",value:8,min:-40,max:40,step:.5}
    ],
    practice:[
      {id:"gdSandboxPracticeCount",label:"Shots",value:14,min:1,max:60,step:1},
      {id:"gdSandboxPracticeCarry",label:"Carry (m)",value:142,min:30,max:320,step:1},
      {id:"gdSandboxPracticeCarrySpread",label:"Carry ± (m)",value:6,min:0,max:40,step:.5},
      {id:"gdSandboxPracticeLateralBias",label:"Lateral bias (°)",value:0,min:-20,max:20,step:.1},
      {id:"gdSandboxPracticeOffline",label:"Offline ± (m)",value:7,min:0,max:60,step:.5}
    ]
  };
  function gdSandboxNumber(id,fallback){
    const value=Number(byId(id)?.value);
    return Number.isFinite(value)?value:fallback;
  }
  function gdSandboxFieldValue(kind,id){
    const field=(GD_SANDBOX_FIELDS[kind]||[]).find(item=>item.id===id);
    return gdSandboxNumber(id,Number(field?.value)||0);
  }
  function gdSandboxBetween(min,max,decimals=1){
    const low=Math.min(min,max),high=Math.max(min,max);
    const value=low+Math.random()*(high-low);
    const factor=Math.pow(10,decimals);
    return Math.round(value*factor)/factor;
  }
  function gdSandboxClub(){
    const raw=String(byId("gdSandboxClub")?.value||"7i").trim();
    return raw||"7i";
  }
  function gdSandboxCount(kind,id){
    return Math.max(1,Math.min(60,Math.round(gdSandboxFieldValue(kind,id))));
  }
  // Course rows are the deviation values this screen actually plots: aim degrees
  // and depth as a percentage of carry, both relative to the bubble that was set.
  function gdSandboxGenerateCourse(){
    const club=gdSandboxClub();
    const carry=gdSandboxFieldValue("course","gdSandboxCourseCarry");
    const lines=[];
    for(let i=0;i<gdSandboxCount("course","gdSandboxCourseCount");i++){
      const offset=gdSandboxBetween(gdSandboxFieldValue("course","gdSandboxCourseOffsetMin"),gdSandboxFieldValue("course","gdSandboxCourseOffsetMax"),2);
      const depth=gdSandboxBetween(gdSandboxFieldValue("course","gdSandboxCourseDepthMin"),gdSandboxFieldValue("course","gdSandboxCourseDepthMax"),1);
      lines.push(`${club},${carry},${offset},${depth}`);
    }
    const box=byId("gdSandboxCourseRows");
    if(box)box.value=`club,carry_m,aim_deg,depth_pct\n${lines.join("\n")}`;
    return false;
  }
  function gdSandboxParseCourseRows(text){
    return String(text||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean).filter(line=>!/^club\s*,/i.test(line)).map(line=>{
      const cells=line.split(",").map(cell=>cell.trim());
      const carry=Number(cells[1]),aim=Number(cells[2]),depth=Number(cells[3]);
      if(!cells[0]||!Number.isFinite(carry)||carry<=0||!Number.isFinite(aim)||!Number.isFinite(depth))return null;
      return {club:cells[0],carryM:carry,aimDeg:aim,depthPct:depth};
    }).filter(Boolean);
  }
  // The bubble each sandbox shot was "played with". Uses the real My Bubble when
  // there is one so fitRatio has something honest to compare against, and a plain
  // stated default otherwise - never a silently invented shape.
  function gdSandboxPlannedBubbleYards(carryM){
    const source=safe(()=>gdMyBubbleHubSource(gdBubbleDataContext(),null,gdStatsCurrentModelOffsetDeg()),null);
    const carry=Number(source?.baseDistanceM);
    const width=Number(source?.bubbleWidthM);
    const depth=Number(source?.bubbleDepthM);
    const usable=Number.isFinite(carry)&&carry>0&&Number.isFinite(width)&&width>0&&Number.isFinite(depth)&&depth>0;
    const scale=usable?carryM/carry:1;
    const widthM=usable?width*scale:carryM*.148;
    const depthM=usable?depth*scale:carryM*.195;
    return {widthYards:widthM*1.0936132983,lengthYards:depthM*1.0936132983,fromMyBubble:usable};
  }
  function gdSandboxInjectCourse(){
    const api=safe(()=>window.GolfDaddyShotEvents||window.GolfDaddy?.modules?.shotEvents,null);
    if(!api||typeof api.replaceScopedStore!=="function"){
      safe(()=>toast("Shot events module is not ready"));
      return false;
    }
    const rows=gdSandboxParseCourseRows(byId("gdSandboxCourseRows")?.value);
    if(!rows.length){
      safe(()=>toast("No usable sandbox rows - expected club,carry_m,aim_deg,depth_pct"));
      return false;
    }
    const store=safe(()=>api.getScopedStore?.()||api.getStore?.(),null)||{ballEvents:[],plannedShots:[],outcomes:[]};
    const plannedShots=Array.isArray(store.plannedShots)?store.plannedShots.slice():[];
    const outcomes=Array.isArray(store.outcomes)?store.outcomes.slice():[];
    const stamp=Date.now();
    const iso=new Date().toISOString();
    const roundId=`round-sandbox-${iso.slice(0,10)}`;
    rows.forEach((row,index)=>{
      const expectedYards=row.carryM*1.0936132983;
      const bubble=gdSandboxPlannedBubbleYards(row.carryM);
      // Same convention as a real outcome: errors measured from the bubble
      // centre, positive lateral = right, positive forward = long.
      const lateralYards=Math.tan(row.aimDeg*Math.PI/180)*expectedYards;
      const depthYards=expectedYards*(row.depthPct/100);
      const shotId=`sandbox-shot-${stamp}-${index}`;
      const outcomeId=`sandbox-outcome-${stamp}-${index}`;
      plannedShots.push({
        shotId,
        roundId,
        holeId:`hole-${(index%18)+1}`,
        originEventId:null,
        origin:{lat:0,lng:0},
        plannedBubble:{centerLat:0,centerLng:0,orientationDeg:0,lengthYards:Number(bubble.lengthYards.toFixed(1)),widthYards:Number(bubble.widthYards.toFixed(1)),shape:"oval"},
        club:row.club,
        expectedDistanceYards:Number(expectedYards.toFixed(1)),
        renderKey:`sandbox:${shotId}`,
        createdAt:iso,
        pairedOutcomeId:outcomeId
      });
      outcomes.push({
        outcomeId,
        shotId,
        resultEventId:null,
        pairedConfidence:1,
        insideBubble:Math.abs(lateralYards)<=bubble.widthYards/2&&Math.abs(depthYards)<=bubble.lengthYards/2,
        relativeResult:"sandbox",
        lateralErrorYards:Number(lateralYards.toFixed(1)),
        distanceErrorYards:Number(depthYards.toFixed(1)),
        gpsAccuracyM:null,
        sourceConfidence:"sandbox",
        computedAt:iso
      });
    });
    api.replaceScopedStore({version:1,ballEvents:Array.isArray(store.ballEvents)?store.ballEvents:[],plannedShots,outcomes});
    safe(()=>gdRefreshCourseDataSurfaces());
    safe(()=>gdRenderCourseDataSurfaceFallback());
    safe(()=>gdRenderCourseDataAdminPanel());
    safe(()=>toast(`${rows.length} sandbox course shots added`));
    return false;
  }
  // Practice rows keep the native paste column order so they stay readable and
  // hand-editable, but the values are METRES - the launch-monitor store's own
  // unit - because these go straight into that store rather than through the
  // yard-based paste parser.
  function gdSandboxGeneratePractice(){
    const club=gdSandboxClub();
    const carry=gdSandboxFieldValue("practice","gdSandboxPracticeCarry");
    const spread=gdSandboxFieldValue("practice","gdSandboxPracticeCarrySpread");
    const offline=gdSandboxFieldValue("practice","gdSandboxPracticeOffline");
    // Bias is entered in degrees because that is what the gate reports back:
    // buildPracticeGateInput() derives normalizedDeg as atan2(offline, carry).
    // Converting per shot (not once off the nominal carry) keeps the group
    // centred on the requested angle even as carry scatters.
    const biasDeg=gdSandboxFieldValue("practice","gdSandboxPracticeLateralBias");
    const lines=["club,carry_m,total_m,offline_m,face,path,start"];
    for(let i=0;i<gdSandboxCount("practice","gdSandboxPracticeCount");i++){
      const carryM=gdSandboxBetween(carry-spread,carry+spread,1);
      const rollM=gdSandboxBetween(3,10,1);
      const biasM=carryM*Math.tan(biasDeg*Math.PI/180);
      lines.push([
        club,
        carryM.toFixed(1),
        (carryM+rollM).toFixed(1),
        gdSandboxBetween(biasM-offline,biasM+offline,1).toFixed(1),
        gdSandboxBetween(-2.5,2.5,1).toFixed(1),
        gdSandboxBetween(-4,4,1).toFixed(1),
        gdSandboxBetween(-2,2,1).toFixed(1)
      ].join(","));
    }
    const box=byId("gdSandboxPracticeRows");
    if(box)box.value=lines.join("\n");
    return false;
  }
  function gdSandboxParsePracticeRows(text){
    return String(text||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean).filter(line=>!/^club\s*,/i.test(line)).map(line=>{
      const cells=line.split(",").map(cell=>cell.trim());
      const carry=Number(cells[1]);
      if(!cells[0]||!Number.isFinite(carry)||carry<=0)return null;
      const num=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};
      return {club:cells[0],carryM:carry,totalM:num(cells[2]),offlineM:num(cells[3]),faceDeg:num(cells[4]),pathDeg:num(cells[5]),startDeg:num(cells[6])};
    }).filter(Boolean);
  }
  // Writes AFTER THE GATE, straight into the launch-monitor store that the
  // practice graph and bubble engine actually read, via the module's own
  // importCapture(). The native CSV paste path is deliberately skipped: it only
  // reaches the native store, and nothing in the app bridges that to the launch
  // monitor - so rows imported that way never appear on the practice screen.
  // inputType "generated-demo" is an existing practice_evidence lane, so these
  // land in the display store like any reviewed capture.
  function gdSandboxSendPractice(){
    const rows=gdSandboxParsePracticeRows(byId("gdSandboxPracticeRows")?.value);
    if(!rows.length){
      safe(()=>toast("No usable practice rows - expected club,carry_m,total_m,offline_m,face,path,start"));
      return false;
    }
    const lm=window.GolfDaddyLaunchMonitorData;
    if(!lm||typeof lm.importCapture!=="function"){
      safe(()=>toast("Launch monitor module is not ready"));
      return false;
    }
    // The point of the sandbox is to push a batch through the REAL intake, so it
    // goes through the same Clarity-native seam every import uses. Doing its own
    // mapping made it a test of a path nothing else takes - and it inherited the
    // same defects: no expectedDistanceM, and a startDirection key the library
    // does not read.
    const adapter=window.GDPracticeLibraryAdapter;
    if(!adapter){
      safe(()=>toast("Practice library adapter is not ready"));
      return false;
    }
    const payload=adapter.nativeRowsToLibraryPayload(rows.map(row=>({
      club:row.club,
      carryDistance:row.carryM,
      totalDistance:row.totalM,
      offlineDistance:row.offlineM,
      faceAngle:row.faceDeg,
      pathAngle:row.pathDeg,
      startDirection:row.startDeg,
      errors:[]
    })),{
      label:"Sandbox batch",
      inputType:"generated-demo",
      rawTextBlocks:["sandbox generated practice batch"]
    });
    const result=lm.importCapture(payload);
    safe(()=>renderPracticeData(true));
    safe(()=>{if(typeof window.gdRenderDataHubStatus==="function")window.gdRenderDataHubStatus();});
    const saved=Array.isArray(result?.shots)?result.shots.length:0;
    safe(()=>toast(`${saved} sandbox practice shot${saved===1?"":"s"} added`));
    return false;
  }
  function gdSandboxFieldHTML(kind,field){
    return `<label>${gdEscapeHTML(field.label)}<input id="${field.id}" type="number" value="${field.value}" min="${field.min}" max="${field.max}" step="${field.step}"></label>`;
  }
  function gdRenderSandboxGeneratorHTML(){
    const courseFields=GD_SANDBOX_FIELDS.course.map(field=>gdSandboxFieldHTML("course",field)).join("");
    const practiceFields=GD_SANDBOX_FIELDS.practice.map(field=>gdSandboxFieldHTML("practice",field)).join("");
    return `<div class="gdSandboxPanel">
      <div class="gdSandboxHead"><div><strong>Sandbox data generator</strong><span>Randomise a batch, edit it by hand, then push it through the real intake. Writes to live data - use Clear above to remove.</span></div></div>
      <label class="gdSandboxClubRow">Club<input id="gdSandboxClub" type="text" value="7i" spellcheck="false"></label>
      <div class="gdSandboxSection">
        <div class="gdSandboxSectionHead"><strong>Course shots</strong><span>Aim ° and depth % relative to the bubble that was set.</span></div>
        <div class="gdSandboxGrid">${courseFields}</div>
        <div class="gdSandboxActions"><button type="button" onclick="return gdSandboxGenerateCourse()">Randomise</button><button type="button" onclick="return gdSandboxInjectCourse()">Add to course data</button></div>
        <textarea id="gdSandboxCourseRows" rows="8" spellcheck="false" placeholder="club,carry_m,aim_deg,depth_pct"></textarea>
      </div>
      <div class="gdSandboxSection">
        <div class="gdSandboxSectionHead"><strong>Practice shots</strong><span>Metres, except lateral bias in degrees - the group centres on that angle, offline ± is the scatter around it. Negative is left. Written after the gate, straight into the launch monitor store the practice graph reads.</span></div>
        <div class="gdSandboxGrid">${practiceFields}</div>
        <div class="gdSandboxActions"><button type="button" onclick="return gdSandboxGeneratePractice()">Randomise</button><button type="button" onclick="return gdSandboxSendPractice()">Add to practice data</button></div>
        <textarea id="gdSandboxPracticeRows" rows="8" spellcheck="false" placeholder="club,carry_m,total_m,offline_m,face,path,start"></textarea>
      </div>
    </div>`;
  }
  function gdRenderCourseDataAdminPanel(){
    const root=byId("gdCourseDataAdminPanel");
    if(!root)return;
    const canManage=gdCourseDataAdminCanManage();
    if(!canManage){
      root.innerHTML=gdCourseDataAdminFallbackHTML();
      return;
    }
    const analysis=safe(()=>typeof gdCurrentStatsAnalysis==="function"?gdCurrentStatsAnalysis():null,null);
    const shotTime=record=>safe(()=>typeof gdStatsShotTime==="function"?gdStatsShotTime(record):Date.parse(record?.at||record?.time||record?.timestamp||0),0)||0;
    const records=(analysis?.records||[]).slice().sort((a,b)=>shotTime(b)-shotTime(a));
    const badge=canManage?"Admin editable":"Locked by permission";
    const rows=records.map(record=>{
      const shotId=String(record.shotId||"");
      const escapedId=gdEscapeHTML(shotId).replace(/'/g,"&#39;");
      const action=canManage&&shotId?`<button type="button" onclick="event.stopPropagation();gdDeleteCourseShot('${escapedId}')">Delete</button>`:`<span class="gdShotAdminBadge">Locked</span>`;
      return `<div class="gdShotAdminRow"><div><strong>${gdEscapeHTML(record.club||"Unknown")} · ${Number(record.actualDistanceM||0).toFixed(0)}m</strong><span>${record.counted?"Counted":"Filtered"} · ${gdOffsetLabel(record.normalizedDeg||0)} · ${gdEscapeHTML(record.holeId||record.roundId||"course shot")}</span></div>${action}</div>`;
    }).join("");
    root.innerHTML=rows?`<div class="gdShotAdminHead"><div><strong>Course Data admin</strong><span>Permission-gated management lives here, away from the normal shot view.</span></div><div class="gdShotAdminBadge">${badge}</div></div>${gdRenderCourseDataUploadHTML()}${gdRenderCourseDataTuningHTML()}${gdRenderSandboxGeneratorHTML()}<div class="gdShotAdminList">${rows}</div>`:gdCourseDataAdminFallbackHTML();
    gdBindCourseDataTuningControls(root);
  }
  function gdSetCourseDataTab(tab, forceOpen){
    if(tab==="admin"&&!gdCourseDataAdminCanManage()){
      try{toast("Course Data admin is coach/admin only");}catch(e){}
      return false;
    }
    const panel=byId("statsPanel");
    const btn=byId("gdCourseAdminExpanderBtn");
    const open=!!panel?.classList.contains("gdCourseAdminTab");
    const admin=typeof forceOpen==="boolean"?forceOpen:(tab==="admin"?!open:false);
    panel?.classList.toggle("gdCourseAdminTab",admin);
    if(btn){
      btn.classList.toggle("active",admin);
      btn.setAttribute("aria-expanded",admin?"true":"false");
      btn.textContent=admin?"Hide admin":"Admin";
    }
    if(admin)gdRenderCourseDataAdminPanel();
    return false;
  }
	  function gdCourseDataSurfaceCounts(){
	    const store=safe(()=>window.GolfDaddyShotEvents?.getScopedStore?.()||window.GolfDaddyShotEvents?.getStore?.(),{})||{};
	    const pct=safe(()=>Number(localStorage.getItem("gd_stats_consistency_pct")||68)||68,68);
	    const analysis=safe(()=>window.GolfDaddyShotClusterAnalysis?.analyzeCurrent?.({consistencyPct:pct}),null)||{};
	    const records=Array.isArray(analysis.records)?analysis.records:[];
    const shown=records;
    const counted=shown.filter(record=>record&&record.counted).length;
    return {
      planned:Array.isArray(store.plannedShots)?store.plannedShots.length:0,
      paired:Array.isArray(store.outcomes)?store.outcomes.length:0,
      rawEvents:Array.isArray(store.ballEvents)?store.ballEvents.length:0,
      records:records.length,
      shown:shown.length,
	      counted:counted
	    };
	  }
  // How much bigger than My Bubble the buffer ring is drawn on Course Data, as a
  // percentage. A chosen allowance for the course window being wider than the
  // practice window - not a measurement, and never a pass/fail threshold. Tunable
  // so the number can be argued about without touching the logic.
  // Course Data draws three distinct things and they must never be mistaken for
  // each other, so they share the Comparison screen's colour language:
  //   My Bubble  = white   (same as Comparison's "playing" bubble)
  //   Course     = green   (same as Comparison's "course" bubble)
  //   Buffer     = amber   (its own colour - it is an allowance, not a bubble)
  const GD_MY_BUBBLE_COLOUR="#f4f8f3";
  const GD_COURSE_BUBBLE_COLOUR="#37f28d";
  const GD_COURSE_BUFFER_COLOUR="#ffb347";
  // Dots say one thing: inside the plan, or outside it. Bright bone inside,
  // grey-green outside, and off-black for a shot the pipeline did not count -
  // present, because it happened, but never mistaken for evidence.
  const GD_COURSE_DOT_INSIDE="#f4f8f3";
  const GD_COURSE_DOT_OUTSIDE="#8b968f";
  const GD_COURSE_DOT_UNCOUNTED="#4a534f";
  const GD_COURSE_BUBBLE_BUFFER_PCT=50;
  function gdCourseBubbleBufferPct(){
    const tuned=safe(()=>typeof dev==="function"?Number(dev("bubbleVisuals.courseBufferPct")):NaN,NaN);
    return Number.isFinite(tuned)&&tuned>=0?tuned:GD_COURSE_BUBBLE_BUFFER_PCT;
  }
  // opts lets the Course Data default screen (gdStatsVisualSummary) reuse this
  // renderer with its own filtered records, colour mode and legend, so both the
  // default screen and this fallback plot on the SAME fixed normalised domain.
  // THE BUBBLE IS DRAWN AT ITS PRESET SIZE, FULL STOP. There used to be a slider
  // sizing it, and it was the screen's most misread control: the score never came
  // off it (the score is the automatically found threshold), so dragging changed
  // the picture and not the number, and the two looked like they disagreed. The
  // bubble is the plan; the dots are what happened; the score says how far apart
  // they are. Nothing on this screen resizes the plan.
  const GD_COURSE_BUBBLE_SCALE=1;
  // THE DATE RANGE. The only control on the screen, and it does exactly one
  // thing: it decides which rows reach the chart. Everything after that - dots,
  // score, chip, rail, the four quadrant percentages, the containment line - is
  // the ordinary analysis of whatever subset came through, so there is no
  // per-range maths anywhere and no way for one reading to be filtered while
  // another is not.
  const GD_COURSE_RANGE_KEY="gd_course_data_range_v1";
  const GD_COURSE_RANGE_DEFAULT="month";
  const GD_COURSE_RANGES=[
    {key:"week",label:"Week",days:7},
    {key:"month",label:"Month",days:30},
    {key:"year",label:"Year",days:365},
    {key:"all",label:"All",days:null}
  ];
  function gdCourseRangeFor(key){
    return GD_COURSE_RANGES.filter(range=>range.key===key)[0]||null;
  }
  function gdCourseRangeKey(){
    const stored=safe(()=>JSON.parse(localStorage.getItem(GD_COURSE_RANGE_KEY)||"null"),null);
    const key=stored&&typeof stored.range==="string"?stored.range:null;
    return gdCourseRangeFor(key)?key:GD_COURSE_RANGE_DEFAULT;
  }
  function gdCourseSetRangeKey(key){
    const valid=gdCourseRangeFor(key)?key:GD_COURSE_RANGE_DEFAULT;
    safe(()=>localStorage.setItem(GD_COURSE_RANGE_KEY,JSON.stringify({range:valid,updatedAt:new Date().toISOString()})));
    return valid;
  }
  // 0 means no limit. A record with no readable capture time is never dropped:
  // the same rule the stats filter uses, because binning undated rows would make
  // the shot list and the graph quietly disagree about how many shots there are.
  function gdCourseRangeCutoff(key){
    const range=gdCourseRangeFor(key);
    if(!range||!range.days)return 0;
    return Date.now()-range.days*24*60*60*1000;
  }
  function gdCourseRecordTime(record){
    return safe(()=>typeof gdStatsShotTime==="function"?gdStatsShotTime(record):Date.parse(record?.timestamp||""),0)||0;
  }
  function gdCourseRecordsInRange(records,key){
    const cutoff=gdCourseRangeCutoff(key);
    if(!cutoff)return records;
    return records.filter(record=>{
      const at=gdCourseRecordTime(record);
      return !at||at>=cutoff;
    });
  }
  function gdCourseRangeRowHTML(){
    const active=gdCourseRangeKey();
    const pills=GD_COURSE_RANGES.map(range=>`<button type="button" class="gdCourseRangePill${range.key===active?" active":""}" aria-pressed="${range.key===active}" onclick="return gdCourseRangeChanged('${range.key}')">${gdEscapeHTML(range.label)}</button>`).join("");
    return `<div class="gdCourseRangeRow">
      <span class="gdCourseRangeIcon" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="rgba(255,255,255,.65)" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 9.5 H20.5"/><path d="M8 2.8 V5.6"/><path d="M16 2.8 V5.6"/></svg></span>
      <div class="gdCourseRangePills" role="group" aria-label="Date range">${pills}</div>
    </div>`;
  }
  // A full re-render, not a live update: the range changes which shots exist, so
  // every figure on the screen has to be recomputed from the new subset. The old
  // slider had a DOM-patching fast path because it changed nothing but the
  // picture; this changes the data, and nothing here may patch a number in place.
  function gdCourseRangeChanged(key){
    gdCourseSetRangeKey(key);
    if(typeof renderStats==="function")safe(()=>renderStats());
    else safe(()=>gdRenderCourseDataSurfaceFallback());
    return false;
  }
  // The insight area. Every sentence comes from the insight module - nothing is
  // phrased here - so the copy-safety rules are enforced in one testable place.
  // What this function owns is presentation only: which band the tone maps to is
  // the module's call, and the stylesheet holds the colour it means.
  function gdCourseInsightHTML(analysis){
    const mod=gdCourseImplementationInsight();
    const built=analysis&&mod?safe(()=>mod.buildCourseInsight(analysis),null):null;
    if(!built)return "";
    const score=built.sections.filter(section=>section.key==="score")[0];
    const explain=built.sections.filter(section=>section.key==="explain")[0];
    if(!score)return "";
    // The rail comes built. Each segment already knows the band it sits in and
    // whether it is lit, so nothing here decides where red becomes amber - the
    // band boundaries live with the score, and this only spends them.
    const rail=(score.rail||[]).map(seg=>
      `<span class="gdCourseRailSeg" data-band="${gdEscapeHTML(seg.band)}" data-seg="${gdEscapeHTML(seg.state)}"></span>`
    ).join("");
    const note=explain&&explain.note?`<p class="gdCourseInsightNote">${gdEscapeHTML(explain.note)}</p>`:"";
    // Collapsed on every load. The open state is deliberately not persisted: the
    // score is the screen, and a tab that remembers itself open turns the
    // explanation into permanent furniture.
    const more=explain?`<details class="gdCourseInsightMore">
        <summary><span class="gdCourseInsightInfo" aria-hidden="true">i</span>${gdEscapeHTML(explain.title)}</summary>
        <div class="gdCourseInsightBody"><p>${gdEscapeHTML(explain.body)}</p>${note}</div>
      </details>`:"";
    return `<div class="gdCourseInsight" data-state="${gdEscapeHTML(built.state)}" data-tone="${gdEscapeHTML(score.tone||"none")}">
      <div class="gdCourseScoreHead">
        <span class="gdCourseScoreLabel">${gdEscapeHTML(score.title)}</span>
        <span class="gdCourseScoreChip">${gdEscapeHTML(score.chip||"")}</span>
      </div>
      <div class="gdCourseScoreValue"><strong>${gdEscapeHTML(score.headline)}</strong><span>/${Number(score.outOf)||10}</span></div>
      <div class="gdCourseRail">
        <div class="gdCourseRailSegs">${rail}</div>
        <div class="gdCourseRailEnds"><span>1</span><span>${Number(score.outOf)||10}</span></div>
      </div>
      ${more}
    </div>`;
  }
  function gdCourseDataSurfaceSvg(counts, analysis, opts={}){
    const suppliedRecords=Array.isArray(opts?.records)?opts.records:(Array.isArray(analysis?.records)?analysis.records:[]);
    // THE RANGE FILTER IS THE FIRST THING THAT HAPPENS. Cutting the rows here,
    // before a single position is computed, is what makes every downstream figure
    // automatically consistent with the pill: the rest of this function has no
    // idea a filter exists.
    const rangeKey=gdCourseRangeKey();
    const records=gdCourseRecordsInRange(suppliedRecords,rangeKey);
    const colourFor=typeof opts?.colourFor==="function"?opts.colourFor:null;
    // COURSE IS THE DEVIATION FRAME. Zero here is THE PLAYING BUBBLE, not the
    // target line. Every record already stores its shot measured from the centre
    // of the bubble that was on screen at the time, in that bubble's own
    // orientation (gd-shot-outcomes.js computeShotOutcome), so the deviations are
    // plotted directly and no per-club anchoring is needed. The old bag-carry /
    // median anchoring was redundant AND mixed frames (it rebuilt position from
    // `expected + a bubble-relative delta`). Because the reference is stored per
    // shot, settings changing between rounds cannot distort this picture.
    const dataRows=records.map((record,index)=>({
      club:record.club||"Unknown",
      counted:record.counted!==false,
      excluded:record.counted===false,
      record,
      index
    }));
    // Per-club reference distance, used ONLY to express stored metres in the
    // chart's units (% of carry for depth, degrees for lateral). This is NOT an
    // anchor: it never moves a shot, it only scales it. Taken from the shots'
    // own expected distances - never the bag.
    const referenceByClub={};
    dataRows.forEach(row=>{
      const key=gdShotBubbleOverlayClubKey(row.club);
      if(!key||Number.isFinite(referenceByClub[key]))return;
      const median=gdShotBubbleMedian(dataRows
        .filter(r=>gdShotBubbleOverlayClubKey(r.club)===key)
        .map(r=>Number(r.record?.expectedDistanceM))
        .filter(value=>Number.isFinite(value)&&value>0));
      if(Number.isFinite(median)&&median>0)referenceByClub[key]=median;
    });
    // EVERY SHOT LANDS ON THIS GRAPH. A club with no usable expected distance of
    // its own falls back to the all-shot median rather than dropping its shots:
    // the deviation is already measured and real, and the reference only ever
    // scales it into the chart's units. Silently binning those shots made the
    // picture and the containment count quietly disagree with the shot list.
    const allExpected=dataRows.map(row=>Number(row.record?.expectedDistanceM)).filter(value=>Number.isFinite(value)&&value>0);
    const fallbackReference=gdShotBubbleMedian(allExpected);
    const referenceFor=club=>{
      const own=Number(referenceByClub[gdShotBubbleOverlayClubKey(club)]);
      if(Number.isFinite(own)&&own>0)return own;
      return Number.isFinite(fallbackReference)&&fallbackReference>0?fallbackReference:NaN;
    };
    const relativeRows=dataRows.map(row=>{
      const reference=referenceFor(row.club);
      const depth=Number(row.record?.depthM);          // forward deviation from bubble centre, m
      const angle=Number(row.record?.normalizedDeg);   // lateral deviation from bubble centre, deg
      if(!Number.isFinite(reference)||reference<=0||!Number.isFinite(depth)||!Number.isFinite(angle))return null;
      return {club:row.club,normalisedDepthM:depth/reference*100,normalizedDeg:angle,hasLateral:true,row,index:row.index};
    }).filter(Boolean);
    // THE BUBBLE IS THE PRESET SHAPE AT ITS PRESET SIZE. Fixed at 1 rather than
    // read from anywhere: nothing on this screen resizes the plan, and the score
    // never came off a size the player chose.
    const courseBubbleScale=GD_COURSE_BUBBLE_SCALE;
    const plot=gdPracticeNormalisedPlotLayout();
    const pointFor=entry=>gdPracticeNormalisedPlotPoint(plot,entry,entry.index);
    // NO CLUSTER FINDING ON THIS SCREEN. There is exactly one piece of logic here:
    // every stored outcome, scaled into the chart's units, plotted against ONE
    // graph bubble sitting at 0.0. Nothing about where the shots went may move or
    // resize that bubble - it is the fixed thing they are being measured against.
    //
    // So the bubble no longer comes from `analysis.bubbleFit` at all. It is the
    // preset shape for the normalised view club (the same 7i view Practice reads
    // in), converted into chart units and scaled by the slider. Because
    // gdDeriveBasePatternSize scales a preset with carry, that shape covers almost
    // the same % depth and the same angular width at any carry - which is exactly
    // what lets one bubble stand for every club on one graph.
    //
    // A directional reading (which way the cluster actually sits) is a COMPARISON
    // screen question and is derived there from the existing cluster analysis. It
    // is deliberately not computed, drawn or published here.
    // THE FRAME DRAWS BEFORE THE DATA DOES. With no shots there is no measured
    // reference, and the whole screen used to collapse to a bare backdrop - no
    // bubble, no quadrant labels, no score card - so a player who had not yet
    // logged a round saw nothing and had no idea what the screen would come to
    // tell them. The player's own view-club carry (their bag value, or the club
    // default) is a fine scale for an empty frame: it moves no shot, because
    // there are none, and the first real shot replaces it with the measured
    // median. It is a drawing scale only and never reaches the score.
    const bubbleReference=(()=>{
      const median=gdShotBubbleMedian(Object.keys(referenceByClub).map(key=>Number(referenceByClub[key])).filter(value=>Number.isFinite(value)&&value>0));
      if(Number.isFinite(median)&&median>0)return median;
      if(Number.isFinite(fallbackReference)&&fallbackReference>0)return fallbackReference;
      const preset=Number(safe(()=>gdCompareDisplayCarryForClub(GD_NORMALISED_VIEW_CLUB),NaN));
      return Number.isFinite(preset)&&preset>0?preset:NaN;
    })();
    const courseGeo=(()=>{
      const geo=gdPracticeGraphInternalGeometry(plot);
      if(!geo||!Number.isFinite(bubbleReference)||bubbleReference<=0)return null;
      const dims=gdGraphBubbleDimensions(GD_NORMALISED_VIEW_CLUB,bubbleReference);
      if(!dims)return null;
      const halfWidth=(plot.plotRight-plot.plotLeft)/2;
      const halfHeight=(plot.plotBottom-plot.plotTop)/2;
      // Radii are built at 100% and then multiplied, NOT built from an already
      // scaled width: the live slider rescales linearly off data-base-rx, and
      // atan2 is not linear, so scaling before the conversion would leave the
      // drawn bubble and the dragged bubble disagreeing at the ends of the range.
      const angleRadiusDeg=Math.max(.4,Math.atan2(dims.widthM/2,bubbleReference)*180/Math.PI);
      const depthRadiusPct=dims.depthM/2/bubbleReference*100;
      const baseRx=Math.max(3,(angleRadiusDeg/Math.max(.5,plot.angleRange))*halfWidth);
      const baseRy=Math.max(3,(depthRadiusPct/Math.max(1,plot.depthRange))*halfHeight);
      return {
        cx:geo.xForAngle(0),
        cy:geo.yForDepth(0),
        baseRx,
        baseRy,
        rx:baseRx*courseBubbleScale,
        ry:baseRy*courseBubbleScale,
        tilt:gdGraphBubbleTiltDeg(GD_NORMALISED_VIEW_CLUB)
      };
    })();
    // A dot always carries ITS OWN CLUB'S colour - that is how the graph says
    // which club hit it, against the club key above. Being inside the bubble is a
    // second, independent signal, so it is carried by weight rather than by hue:
    // outside dots sit back at low opacity, inside dots come forward at full
    // strength with a ring. Tested in the ellipse's ROTATED frame so what lights
    // up is exactly what looks enclosed.
    // The bubble at 100%, which is what the analysis grows from. courseGeo.rx/ry
    // are the same shape already multiplied by the slider.
    const courseEllipse=courseGeo?{cx:courseGeo.cx,cy:courseGeo.cy,rx:courseGeo.baseRx,ry:courseGeo.baseRy,tiltDeg:courseGeo.tilt}:null;
    // ONE inside/outside test for the whole screen. It used to be written out
    // three times - here, in the live drag handler, and again in the score - and
    // three copies of a rotated-ellipse test is three chances for the picture and
    // the number to disagree.
    const insideBubble=point=>{
      const mod=gdCourseTransferScore();
      if(!mod||!courseEllipse||!point)return false;
      return mod.isPointInsideScaledBubble(point,courseEllipse,courseBubbleScale*100);
    };
    // NEWEST WINS when there are more shots than the chart can carry. The old cap
    // sliced from the front, which quietly dropped the most recent rounds - the
    // ones the player is actually asking about - and left the containment count
    // (which walked every row) disagreeing with the picture.
    const GD_COURSE_MAX_DOTS=240;
    const plottedRows=relativeRows.slice(-GD_COURSE_MAX_DOTS);
    // THE ANALYSIS RUNS ON THE DRAWN DOTS, in the drawn frame, against the drawn
    // bubble. No second validity rule is invented here: a shot is eligible if the
    // Course Data pipeline counted it and the chart could place it, which is the
    // same test the picture uses. yAxisDown because screen y grows downwards, so
    // a LONG shot sits above the centre.
    const courseAnalysis=(()=>{
      const mod=gdCourseTransferScore();
      if(!mod||!courseEllipse)return null;
      const points=[];
      plottedRows.forEach(entry=>{
        if(entry.row?.record?.counted===false)return;
        const point=pointFor(entry);
        if(!point)return;
        points.push({x:point.x,y:point.y,club:entry.club,id:entry.row?.record?.shotId||null});
      });
      return safe(()=>mod.analyse(points,courseEllipse,{yAxisDown:true,sliderScalePercent:courseBubbleScale*100}),null);
    })();
    // ONE QUESTION PER DOT, AND IT IS NOT WHICH CLUB. Course Data asks how the
    // whole bag transferred against one plan, so a dot's only job here is inside
    // or outside - which is carried by fill and weight, with no hue left over to
    // mean anything else. The club key went with the colours: a legend for a
    // distinction the screen no longer draws is just clutter to read past.
    //
    // A caller colouring by something else (gd-app-core's time-of-capture mode)
    // still owns both its colours and its key, and that branch is untouched.
    const dotColourFor=entry=>{
      if(!colourFor)return null;
      return safe(()=>colourFor(entry.row?.record,entry.club||"Unknown"),null);
    };
    const shotDots=plottedRows.map(entry=>{
      const point=pointFor(entry);
      if(!point)return "";
      const counted=entry.row.record.counted!==false;
      const custom=dotColourFor(entry);
      if(!counted)return `<circle class="gdCourseShotDot excluded" data-club="${gdStatsSvgText(entry.club||"Unknown")}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="1.8" fill="${GD_COURSE_DOT_UNCOUNTED}" opacity=".3"/>`;
      const inside=insideBubble(point);
      const colour=custom||(inside?GD_COURSE_DOT_INSIDE:GD_COURSE_DOT_OUTSIDE);
      const opacity=custom?(inside?".95":".42"):(inside?".92":".6");
      return `<circle class="gdCourseShotDot${inside?" inside":""}" data-club="${gdStatsSvgText(entry.club||"Unknown")}" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${inside?"2.9":"2.4"}" fill="${colour}" opacity="${opacity}" stroke="${inside?GD_COURSE_BUBBLE_COLOUR:"none"}" stroke-width="${inside?"1":"0"}" stroke-opacity="${inside?".55":"0"}"/>`;
    }).join("");
    // Reads off the analysis rather than recounting, so the headline figure and
    // the score are answers from the same pass over the same dots.
    const containment=courseAnalysis&&courseAnalysis.sampleSize?{
      inside:courseAnalysis.currentSliderCoverage.inside,
      total:courseAnalysis.sampleSize,
      pct:Math.round(courseAnalysis.currentSliderCoverage.insidePercent)
    }:null;
    safe(()=>{
      window.gdCourseBubbleContainment=containment;
      window.gdCourseBubbleAnalysis=courseAnalysis;
    });
    // The Course Data call site has no key of its own any more - its dots are
    // neutral. A caller colouring by something else supplies one with its colours.
    const clubKeySvg=typeof opts?.keySvg==="string"?opts.keySvg:"";
    // THE QUADRANT READ, DRAWN WHERE IT HAPPENED. It used to be a sentence under
    // the graph ("47% of your shots are concentrated short-left"), which made the
    // player translate words back into a corner of a picture they were already
    // looking at. All four corners are stated instead, and the one over the
    // threshold is the only one that gets a colour - so a balanced set says
    // "balanced" by having nothing lit, without a sentence claiming it.
    //
    // Every number and the threshold come off the analysis. Nothing is recomputed
    // here, and the 35 is read from the config so tuning it moves the wash too.
    const quadrantSvg=(()=>{
      // Drawn with or without shots. An empty set gets the four labels and a
      // dash instead of a percentage: the corners are the screen's vocabulary
      // and should be readable before there is anything to read, but "0%" would
      // be a claim about shots that do not exist.
      if(!courseAnalysis||!courseGeo)return "";
      const hasShots=courseAnalysis.sampleSize>0;
      const flagAt=Number(courseAnalysis.config?.quadrantThresholds?.noticeableMinPercent);
      // The quadrants are the plot rect split at the bubble centre, which is where
      // Short/Long and Left/Right are split in the analysis too - the same divide,
      // read off the same geometry, so the wash cannot land on a different corner
      // from the one the percentage belongs to.
      const cx=courseGeo.cx,cy=courseGeo.cy;
      const leftW=cx-plot.plotLeft,rightW=plot.plotRight-cx;
      const topH=cy-plot.plotTop,bottomH=plot.plotBottom-cy;
      const corners=[
        {label:"LONG LEFT",share:courseAnalysis.longLeftShare,x:plot.plotLeft+10,anchor:"start",labelY:plot.plotTop+16,valueY:plot.plotTop+30,rectX:plot.plotLeft,rectY:plot.plotTop,w:leftW,h:topH},
        {label:"LONG RIGHT",share:courseAnalysis.longRightShare,x:plot.plotRight-10,anchor:"end",labelY:plot.plotTop+16,valueY:plot.plotTop+30,rectX:cx,rectY:plot.plotTop,w:rightW,h:topH},
        {label:"SHORT LEFT",share:courseAnalysis.shortLeftShare,x:plot.plotLeft+10,anchor:"start",labelY:plot.plotBottom-26,valueY:plot.plotBottom-12,rectX:plot.plotLeft,rectY:cy,w:leftW,h:bottomH},
        {label:"SHORT RIGHT",share:courseAnalysis.shortRightShare,x:plot.plotRight-10,anchor:"end",labelY:plot.plotBottom-26,valueY:plot.plotBottom-12,rectX:cx,rectY:cy,w:rightW,h:bottomH}
      ];
      return corners.map(corner=>{
        const share=Number(corner.share)||0;
        const flagged=hasShots&&Number.isFinite(flagAt)&&share>=flagAt;
        const labelFill=flagged?GD_COURSE_BUFFER_COLOUR:"rgba(255,255,255,.4)";
        const valueFill=flagged?GD_COURSE_BUFFER_COLOUR:"rgba(255,255,255,.62)";
        // Drawn before the bubble and the dots, so the wash never sits over them.
        const wash=flagged
          ?`<rect x="${corner.rectX.toFixed(1)}" y="${corner.rectY.toFixed(1)}" width="${corner.w.toFixed(1)}" height="${corner.h.toFixed(1)}" fill="${GD_COURSE_BUFFER_COLOUR}" opacity=".07"/>`
          :"";
        const anchor=corner.anchor==="end"?` text-anchor="end"`:"";
        return `${wash}<text x="${corner.x.toFixed(1)}" y="${corner.labelY.toFixed(1)}"${anchor} fill="${labelFill}" font-size="8" font-weight="900" letter-spacing=".08em">${corner.label}</text>`
          +`<text x="${corner.x.toFixed(1)}" y="${corner.valueY.toFixed(1)}"${anchor} fill="${valueFill}" font-size="12" font-weight="950">${hasShots?Math.round(share)+"%":"—"}</text>`;
      }).join("");
    })();
    // ONE BUBBLE, AT 0.0. Emitted directly rather than through the shared layer
    // markup so it can carry its unscaled radii. The empty overlay group stays:
    // gdApplyShotBubbleDomOverlay injects a legacy ABSOLUTE-frame bubble unless it
    // finds one, which would land at the wrong scale on this normalised chart.
    const courseBubbleSvg=courseGeo
      ?`<g class="gdShotBubbleOverlayLayer gdCourseResultLayer" aria-hidden="true"><ellipse class="gdCourseResultBubble" data-base-rx="${courseGeo.baseRx.toFixed(2)}" data-base-ry="${courseGeo.baseRy.toFixed(2)}" data-tilt-deg="${courseGeo.tilt.toFixed(1)}" cx="${courseGeo.cx.toFixed(1)}" cy="${courseGeo.cy.toFixed(1)}" rx="${courseGeo.rx.toFixed(1)}" ry="${courseGeo.ry.toFixed(1)}"${courseGeo.tilt?` transform="rotate(${courseGeo.tilt.toFixed(1)} ${courseGeo.cx.toFixed(1)} ${courseGeo.cy.toFixed(1)})"`:""} fill="${GD_COURSE_BUBBLE_COLOUR}" fill-opacity=".13" stroke="${GD_COURSE_BUBBLE_COLOUR}" stroke-width="1.55" stroke-opacity=".84"/></g>`
      :`<g class="gdShotBubbleOverlayLayer" aria-hidden="true"></g>`;
    // THE GRAPH CARRIES THE PLAYER'S NAME AND NOTHING ELSE. The card header
    // directly above it already says Course Data, and the containment figure now
    // lives in the info tab under the score - stating either one twice was the
    // graph competing with its own header for the top of the screen.
    const playerName=safe(()=>typeof gdShotDataPlayerLabel==="function"?gdShotDataPlayerLabel():"","")||"";
    const svg=`<svg viewBox="${gdPracticeNormalisedViewBox(plot)}" role="img" aria-label="Course Data visual">
      ${gdPracticeNormalisedBackdropSvg(plot,"",{hideText:true})}
      ${playerName?`<text x="24" y="34" fill="rgba(255,255,255,.82)" font-size="14" font-weight="950">${gdStatsSvgText(playerName)}</text>`:""}
      ${clubKeySvg}
      ${quadrantSvg}
      ${courseBubbleSvg}
      ${shotDots}
    </svg>`;
    return `${gdCourseRangeRowHTML()}<div class="gdCourseChartWrap">${svg}</div>${gdCourseInsightHTML(courseAnalysis)}`;
  }
	  function gdCourseDataLandingStatus(counts){
	    if(counts.shown)return `${counts.shown} shown`;
	    if(counts.records)return `${counts.records} paired`;
    if(counts.paired)return `${counts.paired} paired, waiting for usable shots`;
    if(counts.planned)return `${counts.planned} planned`;
    if(counts.rawEvents)return `${counts.rawEvents} ball events`;
    return "No data yet";
  }
  function gdRenderCourseDataSurfaceFallback(){
    const surfaceCounts=gdCourseDataSurfaceCounts();
    const pct=safe(()=>Number(localStorage.getItem("gd_stats_consistency_pct")||68)||68,68);
    const analysis=safe(()=>window.GolfDaddyShotClusterAnalysis?.analyzeCurrent?.({consistencyPct:pct}),null)||{};
    const filteredRecords=analysis&&typeof gdStatsFilteredRecords==="function"?gdStatsFilteredRecords(analysis):[];
    const filteredAnalysis=analysis&&typeof gdStatsAnalysisForRecords==="function"?gdStatsAnalysisForRecords(filteredRecords,analysis.settings)||analysis:analysis;
    const counts=gdCourseDataLandingCounts(analysis,filteredRecords);
    const landing=byId("gdCourseDataLanding");
    if(landing){
      const countedLabel=counts.shown?`${counts.counted}/${counts.shown} counted`:"0 shown";
      const body=`<div class="gdCourseDataLandingHead"><span>Stored shots</span><strong>${gdCourseDataLandingStatus(counts)}</strong></div><div class="gdCourseDataLandingStats"><b>${counts.planned} plans</b><b>${counts.paired} pairs</b><b>${countedLabel}</b></div>${gdCourseLibraryClubTabsHTML(analysis,filteredRecords)}`;
      landing.innerHTML=gdCourseLibraryShellHTML(analysis,filteredAnalysis,filteredRecords,counts,body);
    }
	    const visual=byId("gdStatsVisual");
	    if(visual&&!visual.innerHTML.trim()){
	      visual.innerHTML=gdCourseDataSurfaceSvg(surfaceCounts,analysis);
	    }
	  }
  function openDataHub(opts){
    /* Account-based route: this is the player's own data, one of the few things
       that legitimately needs a sign-in. gd-auth-gate-v1.js owns the decision
       and opens the sign-in screen itself when the answer is no. */
    if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("shotData"))return false;
    rememberProfileReturn(opts);
    openModulePanel("dataHubPanel","Data","",opts);
    gdInitDataHubAccordion();
    gdRenderBubbleOffsetHub();
    renderDataHubStatus();
    gdSyncDataHubCompare();
    gdRenderDataHubCards();
    return false;
  }
	  function openCourseData(opts){
	    if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("courseData"))return false;
	    rememberProfileReturn(opts);
	    openModulePanel("dataHubPanel","Course Data","",opts);
	    gdHubSetSection("course",{force:true});
	    gdSetCourseDataTab(opts&&opts.adminTab?"admin":"data",!!(opts&&opts.adminTab));
	    gdRenderBubbleOffsetHub();
	    setTimeout(gdRenderCourseDataSurfaceFallback,60);
	    remember("courseData",!!(opts&&opts.replace));
	    return false;
	  }
	  // The practice dots plot in a normalised frame (x: depth vs expected carry,
	  // y: lateral angle). Bubbles must live in the SAME frame or they land in a
	  // meaningless spot relative to the dots. These helpers convert bubble
	  // geometry (absolute carry + lateral metres) into that normalised frame.
	  function gdPracticeNormalisedClubBaselines(shots){
	    const byClub={};
	    (Array.isArray(shots)?shots:[]).forEach(shot=>{
	      const key=gdShotBubbleOverlayClubKey(shot?.club);
	      if(!key)return;
	      const actual=gdPracticeShotActualDistance(shot);
	      const expected=gdPracticeNormalisedBaselineForShot(shot,actual);
	      if(!Number.isFinite(expected)||expected<=0)return;
	      (byClub[key]=byClub[key]||[]).push(expected);
	    });
	    const map={};
	    Object.keys(byClub).forEach(key=>{map[key]=gdShotBubbleMedian(byClub[key]);});
	    return map;
	  }
	  // gdPracticeNormalisedBubbleParts is gone: it was an unused graph helper that
	  // still routed through the GPS projector, i.e. a trap waiting to put world
	  // geometry back onto a chart.
  // THE GRAPH BUBBLE AND THE GPS BUBBLE ARE DIFFERENT RENDERINGS OF THE SAME DATA.
  //
  //   GPS bubble   - the real thing projected into the world: rollout-inflated
  //                  depth, physics tilt, visual skew, bag-roof clamping, screen
  //                  caps. Built by gdGeneratedShotBubbleForClub / getGDBForClub.
  //   Graph bubble - the same saved numbers drawn in the charts' own language, so
  //                  My Bubble sits beside the Practice and Course bubbles and is
  //                  directly comparable to them.
  //
  // The charts must therefore NOT go through the GPS projector. They used to:
  // gdShotBubbleOverlayBubbleParts regenerates every bubble from club + carry and
  // never reads the row's own saved dimensions, so a saved 20x26m My Bubble was
  // redrawn at the engine's 22.2x29.25m for a 7i at 150m - and Comparison, which
  // feeds a different club label in, differed again. The same bubble rendered at
  // three sizes across three screens.
  //
  // NO FALLBACK. A row without a real saved shape is not drawn. The charts never
  // call the GPS projector - a bubble on a graph is always the player's own
  // numbers, or nothing at all.
  // Tilt for graph bubbles. Every graph bubble wears the standard shape, so it
  // wears the standard tilt that goes with it - the same club/handedness rule the
  // GPS bubble uses (gdStandardDispersionTiltDeg).
  //
  // Deliberately NOT the projector's tiltDeg, which is physics tilt (the aim
  // offset) PLUS visual tilt. On a chart the aim offset is already expressed as
  // the bubble's position along the angle axis, so folding it into the tilt as
  // well would count the same aim twice.
  // The dev board's bubbleGeometry.tiltScale and tiltMaxDeg apply here too. They
  // used to reach only gdDeriveClusterTilt (the cluster/GPS path), so "Bubble tilt
  // scale" did nothing to the graphs and the class constants (10/12/14) quietly
  // exceeded their own tiltMaxDeg clamp. Now the control governs every bubble:
  // tiltScale 0 means no tilt anywhere.
  function gdGraphBubbleTiltDeg(club,handedness){
    const hand=handedness||safe(()=>ensureProfile()?.handedness,null)||"right";
    const base=Number(safe(()=>typeof gdStandardDispersionTiltDeg==="function"?gdStandardDispersionTiltDeg(club||"7i",hand):0,0));
    if(!Number.isFinite(base))return 0;
    const geo=safe(()=>typeof gdBubbleGeometryTuning==="function"?gdBubbleGeometryTuning():null,null)||{};
    const scale=Number.isFinite(Number(geo.tiltScale))?Number(geo.tiltScale):1;
    const max=Number.isFinite(Number(geo.tiltMaxDeg))?Math.abs(Number(geo.tiltMaxDeg)):Math.abs(base);
    return Math.max(-max,Math.min(max,base*scale));
  }
  // Attaches a measured bubble source's real shape to a row that has none,
  // scaled from the source's own carry to the row's. Used where the projector
  // used to supply the shape. Returns the row untouched if the source has no
  // real dimensions - the row is then dropped rather than drawn from nothing.
  function gdGraphRowWithBubbleShape(row,source){
    if(!row||!source)return row;
    const carry=Number(row.actualDistanceM||row.baseDistanceM);
    const sourceCarry=Number(source.baseDistanceM||source.expectedDistanceM||source.meanExpectedM||source.baseCarry);
    if(!Number.isFinite(carry)||carry<=0||!Number.isFinite(sourceCarry)||sourceCarry<=0)return row;
    const radiusDeg=Number(source.lateralRadiusDeg);
    const width=Number.isFinite(Number(source.bubbleWidthM))&&Number(source.bubbleWidthM)>0
      ?Number(source.bubbleWidthM)
      :(Number.isFinite(radiusDeg)&&radiusDeg>0?Math.tan(radiusDeg*Math.PI/180)*sourceCarry*2:NaN);
    const depth=Number(source.bubbleDepthM);
    if(!Number.isFinite(width)||width<=0||!Number.isFinite(depth)||depth<=0)return row;
    const scale=carry/sourceCarry;
    return Object.assign({},row,{bubbleWidthM:width*scale,bubbleDepthM:depth*scale});
  }
  // SHAPE IS PRESET. A bubble's size is never formed from the data dots - it comes
  // from the club and the carry, exactly as calculateBubbleProfile puts it:
  // "Offset places the shot data. Club/carry sizes it."
  //
  // All the cluster-finding logic exists to decide WHERE the bubble goes (offset +
  // distance), not how big it is. Sizing bubbles from measured spread is what made
  // the same bubble render differently on every screen, and what let a 0.45deg
  // fallback radius masquerade as a measurement.
  function gdGraphBubbleDimensions(club,carry){
    const size=safe(()=>gdDeriveBasePatternSize({club:club||"7i",baseCarry:carry}),null);
    const widthM=Number(size?.clusterWidthM);
    const depthM=Number(size?.clusterDepthM);
    if(!Number.isFinite(widthM)||widthM<=0||!Number.isFinite(depthM)||depthM<=0)return null;
    return {widthM,depthM};
  }
  function gdBubbleRelativeParts(rows,offsetDeg,anchorDistanceM){
    const anchor=Number(anchorDistanceM);
    if(!Number.isFinite(anchor)||anchor<=0)return [];
    // Radii come in as the PRESET size for the club (gdGraphBubbleDimensions), so
    // there is nothing left to normalise - the preset is the standard shape.
    // Placement (carry, angle) is the only part that comes from the data.
    const partFor=(club,carry,angle,lateralRadius,depthRadius,handedness,baseDistanceM)=>{
      const lateral=Math.max(1,lateralRadius);
      const depth=Math.max(1,depthRadius);
      return{
        club:club||"Unknown",
        depthM:(carry-anchor)/anchor*100,
        depthRadiusM:depth/carry*100,
        angleDeg:angle,
        angleRadiusDeg:Math.max(.4,Math.atan2(lateral,Math.max(1,carry))*180/Math.PI),
        tiltDeg:gdGraphBubbleTiltDeg(club,handedness),
        baseDistanceM:Number(baseDistanceM)||carry
      };
    };
    return (rows||[]).map(row=>{
      const carry=Number(row?.actualDistanceM)||Number(row?.baseDistanceM)||Number(row?.expectedDistanceM);
      if(!Number.isFinite(carry)||carry<=0)return null;
      const dims=gdGraphBubbleDimensions(row?.club,carry);
      if(!dims)return null;
      // THE CALLER'S OFFSET WINS. It is the live one for this layer (the practice
      // bubble's own offset, or My Bubble's hub offset). Rows are bag/data rows
      // that can still be carrying a stale offsetDeg from an earlier source -
      // preferring that drew the bubble at the wrong angle, and adopting then
      // staged the real offset, so the bubble visibly jumped on adopt.
      const angle=Number.isFinite(Number(offsetDeg))
        ?Number(offsetDeg)
        :(Number.isFinite(Number(row?.offsetDeg))?Number(row.offsetDeg):0);
      return partFor(row.club,carry,angle,dims.widthM/2,dims.depthM/2,row?.handedness,carry);
    }).filter(Boolean);
  }
	  // A buffered copy of a bubble part: the same centre and tilt, radii scaled.
	  // Scaling the finished part (rather than the source metres) guarantees the
	  // band stays exactly concentric with My Bubble and shares its tilt, which is
	  // what makes a clean ring possible.
	  function gdGraphBufferPart(part,scale){
	    const k=Number(scale);
	    if(!part||!Number.isFinite(k)||k<=1)return null;
	    const angle=Number(part.angleRadiusDeg)||0;
	    return Object.assign({},part,{
	      depthRadiusM:(Number(part.depthRadiusM)||0)*k,
	      angleRadiusDeg:Math.atan(Math.tan(angle*Math.PI/180)*k)*180/Math.PI
	    });
	  }
	  // The buffer BAND: a filled ring between My Bubble's border and the buffer's
	  // border, closed with a solid outer line. Drawn as one even-odd path so the
	  // area between the two really is filled and My Bubble's own interior stays
	  // clear - two stacked translucent ellipses would tint the middle instead.
	  function gdGraphBufferBandMarkup(innerPart,outerPart,plot,opts={}){
	    const geo=gdPracticeGraphInternalGeometry(plot);
	    if(!geo||!innerPart||!outerPart)return "";
	    const halfWidth=(plot.plotRight-plot.plotLeft)/2;
	    const halfHeight=(plot.plotBottom-plot.plotTop)/2;
	    const shape=part=>({
	      cx:geo.xForAngle(part.angleDeg),
	      cy:geo.yForDepth(part.depthM),
	      rx:Math.max(3,((Number(part.angleRadiusDeg)||0)/Math.max(.5,plot.angleRange))*halfWidth),
	      ry:Math.max(3,((Number(part.depthRadiusM)||0)/Math.max(1,plot.depthRange))*halfHeight)
	    });
	    const outer=shape(outerPart);
	    const inner=shape(innerPart);
	    const ring=e=>`M ${(e.cx-e.rx).toFixed(1)} ${e.cy.toFixed(1)} A ${e.rx.toFixed(1)} ${e.ry.toFixed(1)} 0 1 0 ${(e.cx+e.rx).toFixed(1)} ${e.cy.toFixed(1)} A ${e.rx.toFixed(1)} ${e.ry.toFixed(1)} 0 1 0 ${(e.cx-e.rx).toFixed(1)} ${e.cy.toFixed(1)} Z`;
	    const tilt=Number(outerPart.tiltDeg)||0;
	    // POSITIVE, not negated. The GPS bubble rotates its downrange axis toward
	    // +lateral (right) for a right-hander; on this chart long is UP, so the far
	    // end must swing right, which is a CLOCKWISE (positive) SVG rotation. The
	    // old negation was correct only in the original side-on frame where up meant
	    // right - flipping the y sign and then swapping the axes reversed it twice.
	    const transform=tilt?` transform="rotate(${tilt.toFixed(1)} ${outer.cx.toFixed(1)} ${outer.cy.toFixed(1)})"`:"";
	    const colour=opts.colour||GD_COURSE_BUFFER_COLOUR;
	    return `<g class="gdCourseBubbleBufferLayer" aria-hidden="true"${transform}>`
	      +`<path class="gdCourseBubbleBufferBand" d="${ring(outer)} ${ring(inner)}" fill-rule="evenodd" fill="${colour}" fill-opacity="${opts.fillOpacity||".16"}" stroke="none"/>`
	      +`<ellipse class="gdCourseBubbleBufferRing" cx="${outer.cx.toFixed(1)}" cy="${outer.cy.toFixed(1)}" rx="${outer.rx.toFixed(1)}" ry="${outer.ry.toFixed(1)}" fill="none" stroke="${colour}" stroke-width="${opts.strokeWidth||"1.6"}" stroke-opacity="${opts.strokeOpacity||".9"}"/>`
	      +`</g>`;
	  }
	  function gdPracticeNormalisedBubbleLayerMarkup(parts,plot,opts={}){
	    if(!Array.isArray(parts)||!parts.length)return "";
	    const geo=gdPracticeGraphInternalGeometry(plot);
	    if(!geo)return "";
	    const halfWidth=(plot.plotRight-plot.plotLeft)/2;
	    const halfHeight=(plot.plotBottom-plot.plotTop)/2;
	    const typeStyle=gdShotBubbleOverlayTypeStyle(opts.source,"practice");
	    const colour=opts.colour||typeStyle.colour;
	    const fillOpacity=opts.fillOpacity||typeStyle.fillOpacity;
	    const strokeOpacity=opts.strokeOpacity||typeStyle.strokeOpacity;
	    const strokeWidth=opts.strokeWidth||typeStyle.strokeWidth;
	    const offsetDeg=Number(opts.offsetDeg)||0;
	    const groupStyle=opts.groupStyle?` style="${gdStatsSvgText(opts.groupStyle)}"`:"";
	    const groupClass=opts.groupClass||"gdShotBubbleOverlayLayer";
	    return `<g class="${groupClass}" data-offset-deg="${offsetDeg.toFixed(2)}"${groupStyle}>${parts.map(part=>{
	      // Down the line: aim spans the X axis, distance spans the Y axis - so the
	      // horizontal radius comes from the angle and the vertical from the depth.
	      const cx=geo.xForAngle(part.angleDeg);
	      const cy=geo.yForDepth(part.depthM);
	      const rx=Math.max(3,(part.angleRadiusDeg/Math.max(.5,plot.angleRange))*halfWidth);
	      const ry=Math.max(3,(part.depthRadiusM/Math.max(1,plot.depthRange))*halfHeight);
	      const label=(opts.labelText&&opts.label!==false&&parts.length===1)?(()=>{
	        const fontSize=Math.max(5.2,Math.min(7.4,ry*.44));
	        const isMy=String(opts.source||"").toLowerCase()==="my-bubble";
	        const line=(word,dx,dy,fill)=>`<text x="${(cx+dx).toFixed(1)}" y="${(cy+dy).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" fill="${fill}" font-size="${fontSize.toFixed(1)}" font-weight="950">${gdStatsSvgText(word)}</text>`;
	        return `<g class="gdPracticeBubbleEmbossLabel" data-source="practice-bubble-label" pointer-events="none" aria-hidden="true">${line(opts.labelText,-.55,-.55,"rgba(0,0,0,.58)")}${line(opts.labelText,.55,.6,isMy?"rgba(255,236,181,.24)":"rgba(160,255,201,.20)")}${line(opts.labelText,0,0,isMy?"rgba(28,17,2,.86)":"rgba(0,14,8,.84)")}</g>`;
	      })():"";
	      const dashAttr=opts.strokeDasharray?` stroke-dasharray="${gdStatsSvgText(opts.strokeDasharray)}" stroke-linecap="round"`:"";
	      return `<ellipse class="gdOffsetHubBubble${opts.ellipseClass?` ${gdStatsSvgText(opts.ellipseClass)}`:""}" data-club="${gdStatsSvgText(part.club)}" data-source="${gdStatsSvgText(opts.source||"")}" data-offset-deg="${Number(part.angleDeg).toFixed(2)}" data-base-distance-m="${Number(part.baseDistanceM).toFixed(1)}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}"${part.tiltDeg?` transform="rotate(${Number(part.tiltDeg).toFixed(1)} ${cx.toFixed(1)} ${cy.toFixed(1)})"`:""} fill="${colour}" fill-opacity="${fillOpacity}" stroke="${colour}" stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}"${dashAttr}/>${label}`;
	    }).join("")}</g>`;
	  }
	  function practiceSvg(analysis){
	    const shots=gdPracticePlotShots(analysis||{});
		    if(!shots.length){
		      const emptyPlot=gdPracticeNormalisedPlotLayout();
		      return `<svg class="gdPracticeGraphSvg" viewBox="${gdPracticeNormalisedViewBox(emptyPlot)}" role="img" aria-label="Practice Data relative plot"><g class="gdPracticeGraphCanvas">${gdPracticeNormalisedBackdropSvg(emptyPlot,"",{subtitle:"Distance vs My Bubble (%) \u00b7 aim angle (\u00b0)"})}</g></svg>${gdShotBubbleOverlayButton("practice")}`;
	    }
    const plotAll=gdPracticePlotAllRowsForTest();
    const cfg=safe(()=>window.GolfDaddyLaunchMonitorData?.settings?.(),{})||{};
    const hunterPct=Math.max(.18,Math.min(.45,Number(cfg.clusterHunterPct)||.28));
    const hunterRequired=Math.max(Number(cfg.minClusterShots)||5,Math.ceil(shots.length*hunterPct));
    const faceToPathLimit=Math.max(.5,Number(cfg.faceToPathMaxAbsDeg)||6);
    const spinAxisLimit=Math.max(1,Number(cfg.spinAxisMaxAbsDeg)||12);
    const smashMin=Number.isFinite(Number(cfg.smashMin))?Number(cfg.smashMin):1.18;
    const smashMax=Number.isFinite(Number(cfg.smashMax))?Number(cfg.smashMax):1.52;
    const spinTolerance=Math.max(.05,Number(cfg.spinTolerancePct)||.35);
    const launchTolerance=Math.max(1,Number(cfg.launchToleranceDeg)||6);
	    const dynamicLoftTolerance=Math.max(1,Number(cfg.dynamicLoftToleranceDeg)||8);
	    function metricValue(shot,names){
	      const metrics=Array.isArray(shot?.metrics)?shot.metrics:[];
	      const keys=(Array.isArray(names)?names:[names])
	        .flatMap(name=>gdLmMetricNamesForKey(name))
	        .map(name=>String(name||"").trim().toLowerCase().replace(/[^a-z0-9]/g,""));
	      for(const key of keys){
	        const metric=metrics.find(item=>{
	          const candidate=String(item?.candidateMetric||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
	          const raw=String(item?.rawLabel||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
	          return candidate===key||raw===key;
	        });
	        const value=Number(metric?.value);
	        if(Number.isFinite(value))return value;
	      }
	      return null;
	    }
    function clubBaseline(club){
      const key=String(club||"").toLowerCase();
      if(key==="driver"||key==="1w")return{spin:2600,launch:13,dynamicLoft:15};
      if(key==="3w")return{spin:3600,launch:14,dynamicLoft:17};
      const iron=key.match(/^([2-9])i$/);
      if(iron){
        const n=Number(iron[1]);
        return{spin:3000+n*520,launch:9+n*1.3,dynamicLoft:12+n*2.2};
      }
      if(key==="pw")return{spin:9200,launch:29,dynamicLoft:36};
      if(key==="gw")return{spin:9800,launch:31,dynamicLoft:42};
      if(key==="sw")return{spin:10500,launch:33,dynamicLoft:50};
      if(key==="lw")return{spin:11200,launch:35,dynamicLoft:58};
      return null;
    }
    function practiceExclusionReason(shot){
      if(plotAll)return "";
      // Single source of truth: the engine's quality gates (built-ins,
      // custom data gates AND source don't-trust rules) decide what the
      // graph marks as excluded - no duplicated maths here.
      const engineReason=safe(()=>window.GolfDaddyLaunchMonitorData?.practiceQualityExclusionReason?.(shot),null);
      if(typeof engineReason==="string")return engineReason;
      // Fallback (engine not loaded yet): legacy inline checks.
      const faceToPath=Number(shot?.delivery?.faceToPathDeg);
      if(Number.isFinite(faceToPath)&&Math.abs(faceToPath)>faceToPathLimit)return "face_to_path";
	      const spinAxisMetric=metricValue(shot,"spinAxis");
	      const spinAxis=Number.isFinite(spinAxisMetric)?spinAxisMetric:Number(shot?.plot?.spinAxisDeg);
	      if(Number.isFinite(spinAxis)&&Math.abs(spinAxis)>spinAxisLimit)return "spin_axis";
	      const smash=metricValue(shot,"smashFactor");
	      if(Number.isFinite(smash)&&(smash<smashMin||smash>smashMax))return "smash";
	      const base=clubBaseline(shot?.club);
	      const spin=metricValue(shot,"totalSpin");
	      if(base&&Number.isFinite(spin)&&Math.abs(spin-base.spin)>base.spin*spinTolerance)return "spin_amount";
	      const launch=metricValue(shot,"launch");
	      if(base&&Number.isFinite(launch)&&Math.abs(launch-base.launch)>launchTolerance)return "launch_angle";
	      const dynamicLoft=metricValue(shot,"dynamicLoft");
      if(base&&Number.isFinite(dynamicLoft)&&Math.abs(dynamicLoft-base.dynamicLoft)>dynamicLoftTolerance)return "dynamic_loft";
      return "";
    }
    const projectionCtx=gdPracticeProjectionContext(analysis);
    const dataRows=projectionCtx.dataRows;
    const explicitPracticeOffset=Number(analysis?.__practiceBubbleOffsetDeg);
    const practiceBubbleOffset=Number.isFinite(explicitPracticeOffset)?explicitPracticeOffset:projectionCtx.offset;
    const myBubbleState=gdPracticeMyBubbleState(null,analysis);
    const myBubbleOffset=Number(myBubbleState?.offset);
    const currentBubbleAdopted=gdPracticeCurrentBubbleWasAdopted(null,analysis);
    const distanceSummary=gdPracticeDistanceLearningSummary(analysis);
    const adoptionMotion=gdPracticeBubbleAdoptionMotion;
    const adoptionMotionActive=!!(adoptionMotion&&currentBubbleAdopted&&Date.now()-Number(adoptionMotion.at||0)<1400&&adoptionMotion.fingerprint===gdPracticeBubbleFingerprint(analysis));
    const practiceReady=gdPracticeHasBubbleOffset(practiceBubbleOffset)&&projectionCtx.overlayRows.length>0;
    const showPracticeLayer=(practiceReady&&!currentBubbleAdopted)||adoptionMotionActive;
    const learnedByClub=gdPracticeBagRowsByClub(distanceSummary.rows||[]);
    // Projection rows are bag/data rows - they carry a club and a carry but no
    // shape, because the shape used to be generated by the GPS projector. The
    // graphs no longer call the projector, so the row has to bring its own real
    // shape: the MEASURED practice bubble (cluster radius and depth), scaled to
    // that row's carry. Nothing is invented; a row with no measurable practice
    // shape simply is not drawn.
    const practiceShape=safe(()=>gdPracticeBubbleSource(analysis),null);
    // Built whether or not the layer is currently drawn: adoption hides the
    // practice layer, and the anchor below has to keep reading the practice
    // bubble's distance regardless, or the frame would move on adopt again.
    const practiceRows=projectionCtx.overlayRows.map(row=>{
      const learned=learnedByClub[gdShotBubbleOverlayClubKey(row.club)];
      const next=learned?Object.assign({},row,{actualDistanceM:learned.actualDistanceM,projectionSource:"practice-distance-bubble"}):row;
      return gdGraphRowWithBubbleShape(next,practiceShape);
    });
    const overlayRows=showPracticeLayer?practiceRows:[];
    const hubBaseRows=gdPracticeMyBubbleHubRows(dataRows,analysis);
    const hubRows=gdPracticeHasBubbleOffset(myBubbleOffset)?hubBaseRows.filter(row=>Number.isFinite(Number(row.actualDistanceM))&&Number(row.actualDistanceM)>0):[];
    const hubOffset=gdPracticeHasBubbleOffset(myBubbleOffset)?myBubbleOffset:null;
    // ANCHOR = THE PRACTICE BUBBLE'S OWN DISTANCE, always, on this screen.
    //
    // These are practice shots, so the practice bubble is the natural frame. It
    // used to anchor to My Bubble's distance and fall back to practice only when
    // no My Bubble existed - which meant the anchor CHANGED the instant you
    // adopted (measured 142m -> My Bubble's 155m), and since every dot is plotted
    // as a percentage of the anchor, the whole cluster jumped ~57px down on adopt
    // and back on undo. Nothing about the shots had changed; only the denominator.
    //
    // THE ANCHOR IS THE BAG DISTANCE. It is bag-tied on purpose: the bag is the
    // fixed reference everything else is measured against, and it does NOT move
    // when a bubble is adopted, so the frame holds still.
    //
    // The jump was never caused by bag-anchoring - it was caused by the anchor
    // SWITCHING SOURCE. It read the bag via hubRows when a My Bubble existed and
    // fell back to the practice bubble's distance when one did not, so adopting
    // flipped it (142m -> 155m) and every dot moved ~57px. Reading the bag
    // directly, whether or not a bubble has been adopted, removes the switch
    // without giving up the bag reference.
    //
    // Practice measured distance is the fallback ONLY when the player has no bag
    // entry for the club at all - never a preference over the bag.
    // Resolve against whichever candidate actually HAS a bag entry. The practice
    // bubble's `club` can be a display label ("Practice oval"), which keys to
    // "practice oval" and matches no bag row - looking it up first silently missed
    // the bag every time and fell through to the practice distance.
    // ONLY A REAL BAG ANCHORS. gdPracticeSavedBagRows happily returns the seeded
    // ghost bag, and anchoring the whole chart to stand-in numbers would be the
    // same sin as drawing a stand-in bubble. gdPracticeHasUserBag is the app's own
    // test - false when the bag is a seeded default the player has never touched.
    // With no real bag, the practice measurement below takes over.
    const hasRealBag=safe(()=>gdPracticeHasUserBag(),false);
    // SAVED bag, not the draft: adoption writes the learned distance into the bag
    // draft, so anchoring to the draft moved the frame on adopt all over again.
    // The committed bag only changes when the player commits it.
    const anchorBagByClub=hasRealBag?(safe(()=>gdPracticeBagRowsByClub(gdPracticeSavedBagRows()),null)||{}):{};
    // THE FRAME IS A 7 IRON.
    //
    // Two different jobs, and they were tangled together. anchorBagByClub above is
    // the per-club SCALING: clubBaselineFor divides each club's dots by that club's
    // own bag carry, which is what lets a wedge and a driver share one graph. This
    // is the FRAME those scaled dots land in, and the shared graph is a 7 iron by
    // nature - so it has to be ONE fixed club, not whichever club happens to sort
    // first.
    //
    // The old chain took the first of practiceRows[0] / hubRows[0] / practiceShape
    // that had a bag entry. hubRows only exist once a bubble is adopted (s4 trap 1),
    // so adopting could change which club supplied the frame and every dot moved -
    // the same jump this section was written to kill, one layer up. A fixed 7 iron
    // row cannot switch.
    const bagAnchorM=(()=>{
      if(!hasRealBag)return NaN;
      const direct=Number(anchorBagByClub[gdShotBubbleOverlayClubKey("7i")]?.actualDistanceM);
      if(Number.isFinite(direct)&&direct>0)return direct;
      // Bag with no 7 iron in it. Put the bag's own rows on the 7 iron ladder and
      // take the median, so the frame is still one fixed number derived only from
      // the committed bag - still nothing adoption can move.
      const implied=Object.values(anchorBagByClub)
        .map(row=>gdPracticeClubDefaultSevenCarry(row?.club,Number(row?.actualDistanceM)))
        .filter(value=>Number.isFinite(value)&&value>0);
      const median=gdShotBubbleMedian(implied);
      return Number.isFinite(median)&&median>0?median:NaN;
    })();
    // No hubRows step: those only exist once a bubble is adopted, so including
    // them anywhere in this chain reintroduces the switch-on-adopt by definition.
    const anchorDistanceM=(Number.isFinite(bagAnchorM)&&bagAnchorM>0?bagAnchorM:null)
      ||Number(practiceRows[0]?.actualDistanceM)
      ||Number(practiceShape?.baseDistanceM)
      ||null;
    const domainRows=overlayRows
      .concat(hubRows)
      .concat(showPracticeLayer?gdShotBubbleOverlayDistanceExtentRows(overlayRows,practiceBubbleOffset):[])
      .concat(hubRows.length?gdShotBubbleOverlayDistanceExtentRows(hubRows,hubOffset):[]);
    if(adoptionMotionActive){
      [adoptionMotion.fromDistance,adoptionMotion.toDistance,adoptionMotion.practiceDistance].forEach(value=>{
        const distance=Number(value);
        if(Number.isFinite(distance)&&distance>0)domainRows.push({club:"Motion",actualDistanceM:distance,lateralM:0,hasLateral:false,projectionSource:"bubble-motion"});
      });
    }
    const plotLeft=30,plotRight=450,plotTop=82,plotBottom=224;
    const plot=gdShotChartLayout(dataRows,domainRows,{plotLeft,plotRight,plotTop,plotBottom});
    if(showPracticeLayer||hubRows.length){
      const motionLateralMax=adoptionMotionActive?Math.max(
        Math.abs(Math.tan(Number(adoptionMotion.fromOffset||0)*Math.PI/180)*(Number(adoptionMotion.fromDistance)||155)),
        Math.abs(Math.tan(Number(adoptionMotion.toOffset||0)*Math.PI/180)*(Number(adoptionMotion.toDistance)||155)),
        Math.abs(Math.tan(Number(practiceBubbleOffset||0)*Math.PI/180)*(Number(adoptionMotion.practiceDistance)||155))
      ):0;
      gdShotChartEnsureLateralRange(
        plot,
        showPracticeLayer?gdShotBubbleOverlayLateralMax(overlayRows,practiceBubbleOffset):0,
        hubRows.length?gdShotBubbleOverlayLateralMax(hubRows,hubOffset):0,
        motionLateralMax
      );
    }
    const pointModels=dataRows.slice(0,70).map(row=>{
      const point=gdShotChartPoint(plot,row.actualDistanceM,row.lateralM,row.index,row.hasLateral);
      const excludeReason=practiceExclusionReason(row.shot);
      return point?{x:point.x,y:point.y,index:row.index,shot:row.shot,missingLateral:row.hasLateral===false,excludeReason,excluded:!!excludeReason}:null;
    }).filter(Boolean);
    function practiceHunterCluster(points){
      const rows=points.filter(point=>!point.excluded&&!point.missingLateral&&Number.isFinite(point.x)&&Number.isFinite(point.y));
      if(rows.length<hunterRequired)return{status:"collecting",counted:new Set(),radiusPx:null};
      let best=null;
      rows.forEach(anchor=>{
        const ranked=rows.map(point=>{
          const dx=point.x-anchor.x,dy=point.y-anchor.y;
          return{point,dist:dx*dx+dy*dy};
        }).sort((a,b)=>a.dist-b.dist).slice(0,hunterRequired);
        const radius=Math.sqrt(Math.max(...ranked.map(item=>item.dist)));
        const xs=ranked.map(item=>item.point.x),ys=ranked.map(item=>item.point.y);
        const area=(Math.max(...xs)-Math.min(...xs)+1)*(Math.max(...ys)-Math.min(...ys)+1);
        const score=radius*radius+area*.015;
        if(!best||score<best.score)best={ranked,radius,area,score};
      });
      const counted=new Set(best.ranked.map(item=>item.point.index));
      const strong=counted.size>=Math.max(5,Number(cfg.minClusterShots)||5);
      return{status:strong?"cluster_hunted":"forming",counted,radiusPx:best.radius,areaPx:best.area};
    }
    const hunter=practiceHunterCluster(pointModels);
    const storedCountedShotIds=new Set(gdShotBubbleSafe(()=>typeof gdPracticeEvidenceRows==="function"
      ? gdPracticeEvidenceRows(analysis).filter(row=>row.counted&&!row.excluded&&!row.plotDeselected&&row.shotId).map(row=>row.shotId)
      : [],[]));
    const pointStateByIndex=new Map();
    pointModels.forEach(point=>{
      const storedCounted=point.shot?.shotId&&storedCountedShotIds.has(point.shot.shotId);
      const counted=!!storedCounted||(hunter.counted&&hunter.counted.has(point.index));
      const excluded=!plotAll&&(point.excluded||point.shot&&point.shot.rejected);
      const clubColour=gdStatsClubColor(point.shot?.club);
      const colour=excluded?"#8f9a96":clubColour;
      const opacity=counted?".82":excluded?".18":point.missingLateral?".28":".38";
      point.counted=counted;
      point.excluded=excluded;
      pointStateByIndex.set(point.index,{counted,excluded});
      point.svg=gdShotChartDotSvg(point,{fill:colour,opacity,radius:counted?2.6:1.8,missing:point.missingLateral});
    });
    function practiceClusterMarkerSvg(points){
      const clusterPoints=(points||[]).filter(point=>point.counted&&!point.excluded&&!point.missingLateral&&Number.isFinite(point.x)&&Number.isFinite(point.y));
      if(clusterPoints.length<2)return "";
      const xs=clusterPoints.map(point=>point.x);
      const ys=clusterPoints.map(point=>point.y);
      const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
      const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
      const rx=gdShotChartClamp((maxX-minX)/2+9,16,54);
      const ry=gdShotChartClamp((maxY-minY)/2+7,9,32);
      return `<ellipse class="gdPracticeClusterMarker gdShotChartClubOval practice" data-source="cluster-marker" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="rgba(255,210,135,.82)" fill-opacity=".014" stroke="rgba(255,210,135,.82)" stroke-width=".7" stroke-opacity=".46" stroke-dasharray="1 5" stroke-linecap="round" pointer-events="none"/>`;
    }
	    // Each club's own number: the saved bag carry when there is a real bag,
	    // otherwise the median of that club's own shots. Same precedence as the
	    // anchor above, so the dots and the bubbles are measured against the same
	    // reference and "0" means the same thing for both.
	    const clubShotDistances={};
	    shots.forEach(shot=>{
	      const key=gdShotBubbleOverlayClubKey(shot?.club);
	      const actual=gdPracticeShotActualDistance(shot);
	      if(!key||!Number.isFinite(actual)||actual<=0)return;
	      (clubShotDistances[key]=clubShotDistances[key]||[]).push(actual);
	    });
	    const clubBaselineFor=club=>{
	      const key=gdShotBubbleOverlayClubKey(club);
	      const bagCarry=Number(anchorBagByClub[key]?.actualDistanceM);
	      if(Number.isFinite(bagCarry)&&bagCarry>0)return bagCarry;
	      const median=gdShotBubbleMedian(clubShotDistances[key]||[]);
	      return Number.isFinite(median)&&median>0?median:NaN;
	    };
	    const anchorRelativeRows=gdBubbleRelativeShotRows(shots,clubBaselineFor);
	    // ONE BUBBLE PER LAYER. THIS is the heap.
	    //
	    // gdPracticeNormalisedBubbleLayerMarkup does parts.map(part => <ellipse>), and
	    // both layers were handed EVERY bag club's overlay row - so six clubs drew six
	    // stacked ellipses. The count tracked the BAG, not the data, which is why it
	    // never responded to anything about the shots.
	    //
	    // The Practice Bubble is a single proposal and My Bubble is a single saved
	    // bubble (Bubble Bible s2). Neither is a per-club thing, so neither should ever
	    // emit more than one shape.
	    //
	    // One row is enough because shape is a PRESET scaled by carry (s6), not a fit to
	    // the dots: the preset lands within ~0.2% of the same drawn radii across the bag,
	    // which is exactly what lets the Course chart have one bubble stand for every
	    // club at once (s5). Prefer the 7 iron, since the shared graph is a 7 iron frame.
	    const singleBubbleRow=rows=>{
	      if(!Array.isArray(rows)||!rows.length)return [];
	      const seven=rows.find(row=>gdShotBubbleOverlayClubKey(row?.club)==="7i");
	      return [seven||rows[0]];
	    };
	    const myBubbleParts=anchorDistanceM&&hubRows.length&&gdPracticeHasBubbleOffset(hubOffset)?gdBubbleRelativeParts(singleBubbleRow(hubRows),hubOffset,anchorDistanceM):[];
	    const practiceBubbleParts=anchorDistanceM&&showPracticeLayer?gdBubbleRelativeParts(singleBubbleRow(overlayRows),practiceBubbleOffset,anchorDistanceM):[];
	    const normalisedPlot=gdPracticeNormalisedPlotLayout();
	    const clubKeySource=anchorRelativeRows.length?anchorRelativeRows:dataRows;
	    const clubKey=[...new Set(clubKeySource.map(row=>row.club||"Unknown"))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).slice(0,6);
	    const clubKeyDropdown=gdPracticeClubKeyDropdownHTML(clubKey);
	    const pts=anchorRelativeRows.slice(0,70).map(row=>{
	      const point=gdPracticeNormalisedPlotPoint(normalisedPlot,row,row.index);
	      if(!point)return "";
	      const state=pointStateByIndex.get(row.index)||{};
	      const excluded=!!state.excluded||(!plotAll&&(row.shot?.rejected||practiceExclusionReason(row.shot)));
	      const colour=excluded?"#8f9a96":gdStatsClubColor(row.club);
	      const opacity=excluded?".16":row.hasLateral===false?".42":".72";
      return gdShotChartDotSvg(point,{fill:colour,opacity,radius:2.2,shape:"circle",stroke:point.clipped?"rgba(255,255,255,.26)":"",strokeWidth:"1"});
	    }).join("");
	    let myBubbleMotionStyle="";
	    if(adoptionMotionActive&&myBubbleParts.length&&anchorDistanceM&&gdPracticeHasBubbleOffset(adoptionMotion.fromOffset)&&gdPracticeHasBubbleOffset(hubOffset)){
	      const geo=gdPracticeGraphInternalGeometry(normalisedPlot);
	      const anchorPart=myBubbleParts[0];
	      const toDistance=Number(adoptionMotion.toDistance)||Number(anchorPart.baseDistanceM)||anchorDistanceM;
	      const fromDistance=Number(adoptionMotion.fromDistance)||toDistance;
	      const fromDepthPct=(fromDistance-anchorDistanceM)/anchorDistanceM*100;
	      // Aim moves the bubble across, distance moves it up/down.
	      const dx=geo?geo.xForAngle(Number(adoptionMotion.fromOffset)||0)-geo.xForAngle(Number(hubOffset)||0):NaN;
	      const dy=geo?geo.yForDepth(fromDepthPct)-geo.yForDepth(anchorPart.depthM):NaN;
	      if(Number.isFinite(dx)&&Number.isFinite(dy))myBubbleMotionStyle=`--gd-practice-adopt-x:${dx.toFixed(1)}px;--gd-practice-adopt-y:${dy.toFixed(1)}px;`;
	    }
	    const myBubbleKind=String(myBubbleState?.kind||"default");
	    const myBubbleCombined=myBubbleKind==="adopted-current"||adoptionMotionActive;
	    const myBubbleLabel=myBubbleCombined?"My Bubble":String(myBubbleState?.graphLabel||"MY");
	    const myBubbleLayer=myBubbleParts.length?gdPracticeNormalisedBubbleLayerMarkup(myBubbleParts,normalisedPlot,{
	      offsetDeg:hubOffset,
	      groupClass:`gdShotBubbleOverlayLayer gdPracticeMyBubbleLayer gdPracticeMyBubbleLayer-${myBubbleKind} gdShotBubbleOverlayLens ${adoptionMotionActive?"gdPracticeMyBubbleAdopting":""}`,
	      source:"my-bubble",
	      labelText:myBubbleLabel,
	      groupStyle:myBubbleMotionStyle
	    }):"";
	    const practiceBubbleLayer=practiceBubbleParts.length&&(!myBubbleCombined||adoptionMotionActive)?gdPracticeNormalisedBubbleLayerMarkup(practiceBubbleParts,normalisedPlot,{
	      offsetDeg:practiceBubbleOffset,
	      groupClass:`gdShotBubbleOverlayLayer gdPracticeBubbleProjectionLayer gdShotBubbleOverlayLens ${myBubbleCombined?"gdPracticeBubbleProjectionLayer-combined":""} ${adoptionMotionActive?"gdPracticeBubbleAdoptionGhost":""}`,
	      source:"practice-bubble-projection",
	      labelText:"PRACTICE",
	      label:!myBubbleCombined
	    }):"";
		    return `<svg class="gdPracticeGraphSvg" viewBox="${gdPracticeNormalisedViewBox(normalisedPlot)}" role="img" aria-label="Practice Data relative plot" data-practice-offset-deg="${gdPracticeHasBubbleOffset(practiceBubbleOffset)?Number(practiceBubbleOffset).toFixed(2):""}" data-hub-offset-deg="${gdPracticeHasBubbleOffset(hubOffset)?Number(hubOffset).toFixed(2):""}" data-anchor-distance-m="${anchorDistanceM?Number(anchorDistanceM).toFixed(1):""}">
		      <g class="gdPracticeGraphCanvas">
		      ${gdPracticeNormalisedBackdropSvg(normalisedPlot,"",{subtitle:"Distance vs My Bubble (%) \u00b7 aim angle (\u00b0)"})}
      ${pts}
      ${practiceBubbleLayer}
      ${myBubbleLayer}
      </g>
    </svg>${clubKeyDropdown}${gdShotBubbleOverlayButton("practice")}`;
	  }
  const gdPracticeBubbleToleranceFields=[
    "launchMonitorCluster.clusterHunterPct",
    "launchMonitorCluster.resultConsistencyPct",
    "launchMonitorCluster.minClusterShots",
    "launchMonitorCluster.maxClusterStdDeg",
    "launchMonitorCluster.maxClusterRangeDeg",
    "launchMonitorCluster.viableDegreeAbs",
    "launchMonitorCluster.alignmentDegreeAbs"
  ];
  // Cross-club verification is retired as a tunable gate (bag-sync scaling
  // superseded it). This tab now tunes how bubbles rescale to bag numbers.
  const gdPracticeScalingToleranceFields=[
    "launchMonitorCluster.bagSyncEnabled",
    "launchMonitorCluster.bagSyncMinDeltaM",
    "launchMonitorCluster.bagSyncMinRatio",
    "launchMonitorCluster.bagSyncMaxRatio"
  ];
  const gdPracticeIntakeToleranceFields=[
    "launchMonitorCluster.minCarryM",
    "launchMonitorCluster.maxCarryM",
    "launchMonitorCluster.carryWindowPct",
    "launchMonitorCluster.carryWindowMinM",
    "launchMonitorCluster.carryWindowMaxM",
    "launchMonitorCluster.maxAbsOfflineM",
    "launchMonitorCluster.minMetricConfidence"
  ];
  const gdPracticeToleranceSections=[
    {label:"Practice Bubble",meta:"Single cluster",fields:gdPracticeBubbleToleranceFields},
    {label:"Bubble scaling",meta:"Bag-number sync",fields:gdPracticeScalingToleranceFields},
    {label:"Intake gates",meta:"Before cluster",fields:gdPracticeIntakeToleranceFields}
  ];
  const gdPracticeToleranceFields=gdPracticeToleranceSections.flatMap(section=>section.fields);
  const gdPracticeMasterToleranceFields=[
    "launchMonitorCluster.clusterHunterPct",
    "launchMonitorCluster.resultConsistencyPct",
    "launchMonitorCluster.minClusterShots",
    "launchMonitorCluster.maxClusterStdDeg",
    "launchMonitorCluster.maxClusterRangeDeg",
    "launchMonitorCluster.viableDegreeAbs",
    "launchMonitorCluster.alignmentDegreeAbs"
  ];
  function gdPracticeAdminIsOpen(){
    return !!byId("practiceDataPanel")?.classList.contains("gdPracticeAdminExpanded");
  }
  function gdRenderPracticeAdminChrome(){
    const open=gdPracticeAdminIsOpen();
    const btn=byId("gdPracticeAdminTabBtn");
    const master=byId("gdPracticeMasterTolerance");
    const panel=byId("gdPracticeTolerancePanel");
    const recPanel=byId("gdPracticeRecommendationsPanel");
    btn?.classList.toggle("active",open);
    btn?.setAttribute("aria-expanded",open?"true":"false");
    if(master)master.hidden=!open;
    if(panel)panel.hidden=!open;
    if(recPanel)recPanel.hidden=!open;
    gdRenderPracticeExtractionCheckpoint();
    gdRenderPracticeLiveDebugPanel();
    if(typeof window.gdPracticeRefreshDebugTools==="function")window.gdPracticeRefreshDebugTools();
  }
  function gdTogglePracticeAdmin(force){
    const panel=byId("practiceDataPanel");
    const open=typeof force==="boolean"?force:!gdPracticeAdminIsOpen();
    panel?.classList.toggle("gdPracticeAdminExpanded",open);
    gdRenderPracticeAdminChrome();
    if(open)gdRenderPracticeToleranceControls();
    return false;
  }
  function gdSetPracticeDataTab(tab){
    return gdTogglePracticeAdmin(tab==="admin");
  }
  function gdOpenPracticeAdminTab(){
    openPracticeData({adminTab:true});
    return false;
  }
  function gdPracticeToleranceCanEdit(){
    const permission=safe(()=>typeof gdGetAccountPermission==="function"?gdGetAccountPermission():"player","player");
    return permission==="admin"||permission==="coach";
  }
  function gdPracticeToleranceDisplay(path,value){
    const f=DEV_FIELDS[path]||{};
    const n=Number(value);
    const suffix=f.unit||"";
    if(!Number.isFinite(n))return "-";
    if(path.endsWith("Pct")){
      const pct=Math.abs(n)<=1?Math.round(n*100):Math.round(n);
      return `${pct}%`;
    }
    return `${formatDev(n)}${suffix}`;
  }
  function gdPracticeToleranceCompactLabel(path,fallback){
    const labels={
      "launchMonitorCluster.clusterHunterPct":"Bubble sample",
      "launchMonitorCluster.resultConsistencyPct":"Bubble fit",
      "launchMonitorCluster.minCarryM":"Min carry (abs)",
      "launchMonitorCluster.maxCarryM":"Max carry (abs)",
      "launchMonitorCluster.carryWindowPct":"Miss vs bag %",
      "launchMonitorCluster.carryWindowMinM":"Miss floor",
      "launchMonitorCluster.carryWindowMaxM":"Miss cap",
      "launchMonitorCluster.maxAbsOfflineM":"Max offline (abs)",
      "launchMonitorCluster.minMetricConfidence":"Extract conf",
      "launchMonitorCluster.viableDegreeAbs":"Viable deg",
      "launchMonitorCluster.alignmentDegreeAbs":"Align deg",
      "launchMonitorCluster.minClusterShots":"Min shots",
      "launchMonitorCluster.replicationDegreeTolerance":"Verify tol",
      "launchMonitorCluster.minVerificationClubs":"Verify clubs",
      "launchMonitorCluster.distanceScaleWeight":"Anchor weight",
      "launchMonitorCluster.bagSyncEnabled":"Bag sync",
      "launchMonitorCluster.bagSyncMinDeltaM":"Sync delta",
      "launchMonitorCluster.bagSyncMinRatio":"Shrink limit",
      "launchMonitorCluster.bagSyncMaxRatio":"Grow limit",
      "launchMonitorCluster.maxClusterStdDeg":"Spread",
      "launchMonitorCluster.maxClusterRangeDeg":"Range",
      "launchMonitorCluster.deliveryMinShots":"Delivery shots",
      "launchMonitorCluster.deliveryMaxStdDeg":"Delivery spread",
      "launchMonitorCluster.deliveryMaxRangeDeg":"Delivery range",
      "launchMonitorCluster.deliveryResultToleranceDeg":"Delivery/result",
      "launchMonitorCluster.deliveryMinConfidence":"Delivery conf",
      "launchMonitorCluster.faceToPathMaxAbsDeg":"Face/path",
      "launchMonitorCluster.spinAxisMaxAbsDeg":"Spin axis",
      "launchMonitorCluster.simulatorSpinAxisCurveFactor":"Sim curve",
      "launchMonitorCluster.simulatorMinPlotConfidence":"Sim conf",
      "launchMonitorCluster.simulatorReferenceSpinRpm":"Ref spin",
      "launchMonitorCluster.simulatorReferenceBallSpeedMph":"Ref speed",
      "launchMonitorCluster.smashMin":"Smash min",
      "launchMonitorCluster.smashMax":"Smash max",
      "launchMonitorCluster.launchToleranceDeg":"Launch",
      "launchMonitorCluster.dynamicLoftToleranceDeg":"Dyn loft",
      "launchMonitorCluster.spinTolerancePct":"Spin"
    };
    return labels[path]||fallback||path;
  }
  function gdPracticeToleranceCompactHelp(path,fallback){
    const help={
      "launchMonitorCluster.clusterHunterPct":"Share of usable shots used to assert the Practice Bubble centre.",
      "launchMonitorCluster.resultConsistencyPct":"How tightly result angles must group around the bubble centre.",
      "launchMonitorCluster.minClusterShots":"Minimum accepted shots before a Practice Bubble can exist.",
      "launchMonitorCluster.maxClusterStdDeg":"Maximum standard deviation allowed in the single-cluster bubble.",
      "launchMonitorCluster.maxClusterRangeDeg":"Maximum left/right angle range allowed in the single cluster.",
      "launchMonitorCluster.viableDegreeAbs":"Offset limit for a cluster to become a Practice Bubble candidate.",
      "launchMonitorCluster.alignmentDegreeAbs":"Beyond this, a strong bubble is flagged as an alignment signal.",
      "launchMonitorCluster.replicationDegreeTolerance":"How close another club's bubble centre must be to verify this one.",
      "launchMonitorCluster.minVerificationClubs":"Number of matching clubs needed to mark the bubble verified.",
      "launchMonitorCluster.distanceScaleWeight":"Boosts longer-club clusters when choosing the anchor bubble.",
      "launchMonitorCluster.bagSyncEnabled":"1 = bubbles rescale automatically when bag numbers change. 0 = frozen until regenerated.",
      "launchMonitorCluster.bagSyncMinDeltaM":"Smallest bag-number change in metres before a rescale fires.",
      "launchMonitorCluster.bagSyncMinRatio":"Bubbles never shrink below this share of their original size.",
      "launchMonitorCluster.bagSyncMaxRatio":"Bubbles never grow beyond this multiple of their original size.",
      "launchMonitorCluster.minCarryM":"Absolute floor: shots carrying under this many metres never plot.",
      "launchMonitorCluster.maxCarryM":"Absolute ceiling: shots carrying over this many metres never plot.",
      "launchMonitorCluster.carryWindowPct":"Max carry miss as a % of the club's bag number. Not absolute distance - it measures how far the shot flew vs what the bag says it should.",
      "launchMonitorCluster.carryWindowMinM":"Smallest allowed miss-vs-bag window (protects short clubs).",
      "launchMonitorCluster.carryWindowMaxM":"Largest allowed miss-vs-bag window (caps the % for long clubs).",
      "launchMonitorCluster.maxAbsOfflineM":"Shots wider than this many metres from the target line never plot.",
      "launchMonitorCluster.minMetricConfidence":"Minimum extraction confidence for imported metrics."
    };
    return help[path]||fallback||"";
  }
  function gdPracticeVerificationStatusLabel(method){
    const status=String(method?.status||"").replace(/_/g," ");
    if(!method)return "No Practice Bubble";
    if(method.status==="cross_distance_verified")return "Verified";
    if(method.status==="alignment_signal")return "Alignment signal";
    if(method.status==="cluster_candidate"||method.status==="oval_center_candidate")return "Clarity Coach Helper";
    if(method.status==="needs_more_data")return "Collecting";
    return status||"Indicator";
  }
  function gdPracticeBubbleValueLabel(analysis){
    const method=gdPracticeBubbleMethod(analysis);
    const offset=Number(method?.anchorDeg);
    return method&&Number.isFinite(offset)?"Bubble ready":"Bubble not ready";
  }
  function gdPracticeImportJobHTML(){
    const job=gdPracticeHydrateImportJob();
    if(!job||String(job.status)==="canceled")return "";
    const status=String(job.status||"");
    const active=gdPracticeImportIsActive(job);
    const failed=status==="failed";
    const completed=status==="completed";
    if(active||completed)return "";
    const title=gdPracticeImportStatusLabel(status);
    const source=job.sourceLabel||job.source||"Practice import";
    const date=job.importDate?gdPracticeEvidenceDateLabel(job.importDate):"Import date pending";
    const counts=[
      Number(job.accepted)?`${Number(job.accepted)} accepted`:"",
      Number(job.rejected)?`${Number(job.rejected)} rejected`:"",
      Number(job.nativeRows)?`${Number(job.nativeRows)} saved`:""
    ].filter(Boolean).join(" · ");
    const detail=job.userMessage||job.checkpointText||"Import progress is saved.";
    const diagnostic="";
    const actions=failed
      ? `<button type="button" data-gd-practice-import-action="review" onclick="return gdPracticeHandleImportJobAction('review',event)">Resume/review import</button><button type="button" data-gd-practice-import-action="discard" onclick="return gdPracticeHandleImportJobAction('discard',event)">Discard failed import</button>`
      : active
        ? (status==="saving"?`<button type="button" data-gd-practice-import-action="review" onclick="return gdPracticeHandleImportJobAction('review',event)">Review import</button>`:`<button type="button" data-gd-practice-import-action="review" onclick="return gdPracticeHandleImportJobAction('review',event)">Review import</button><button type="button" data-gd-practice-import-action="cancel" onclick="return gdPracticeHandleImportJobAction('cancel',event)">Cancel import</button>`)
        : `<button type="button" data-gd-practice-import-action="clear" onclick="return gdPracticeHandleImportJobAction('clear',event)">Clear import status</button>`;
    return `<div class="gdPracticeImportJob ${active?"active":failed?"failed":"done"}">
      <div class="gdPracticeImportJobMain"><strong>${gdEscapeHTML(title)}</strong><span>${gdEscapeHTML(detail)}</span><small>${gdEscapeHTML(source)} · ${gdEscapeHTML(date)}${counts?` · ${gdEscapeHTML(counts)}`:""}</small></div>
      <div class="gdPracticeImportJobActions">${actions}</div>
      ${diagnostic}
    </div>`;
  }
  if(!window.__gdPracticeImportJobActionBound){
    window.__gdPracticeImportJobActionBound=true;
    document.addEventListener("click",event=>{
      const target=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-import-action]");
      if(!target)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const action=String(target.dataset.gdPracticeImportAction||"");
      return gdPracticeHandleImportJobAction(action,event);
    },true);
  }
  function gdPracticeLibraryShellHTML(analysis,totalRows,bodyHTML){
    const bubble=gdPracticeBubbleValueLabel(analysis);
    const jobHTML=gdPracticeImportJobHTML();
    const processingHTML=gdNativeShotDataProcessingHTML();
    return gdShotDataLibraryShellHTML({
      kind:"practice",
      title:"Clarity Shot Library",
      bubbleLabel:"Practice Bubble",
      bubbleValue:bubble,
      count:Number(totalRows)||0,
      bodyHTML:jobHTML+bodyHTML,
      dropdown:true,
      open:gdShotDataLibraryIsOpen("practice"),
      headerStatusHTML:processingHTML
    });
  }
  function gdPracticeRecommendationsHTML(analysis){
    const method=gdPracticeBubbleMethod(analysis);
    const rec=analysis?.recommendation||{};
    const cfg=analysis?.settings||{};
    const required=Math.max(1,Number(cfg.minVerificationClubs)||Number(dev("launchMonitorCluster.minVerificationClubs"))||1);
    const verified=Array.isArray(method?.verificationClubs)?method.verificationClubs:[];
    const offset=Number(method?.anchorDeg);
    const bubbleLabel=method&&Number.isFinite(offset)?`Ready${method.anchorClub?` · ${method.anchorClub}`:""}`:"No bubble yet";
    const verification=method?`${verified.length}/${required} clubs · ${gdPracticeVerificationStatusLabel(method)}`:"Waiting for a single cluster";
    const recommendation=rec?.status?String(rec.status).replace(/_/g," "):"needs more data";
    const note=method?.status==="cross_distance_verified"
      ?"Practice Bubble is verified against other clubs."
      :"Verification is an indicator for coach review, not a pass/fail gate for showing the Practice Bubble.";
    return `<div class="gdPracticeRecommendationsHead"><div><strong>Clarity Coach Helper</strong><span>${gdEscapeHTML(note)}</span></div><div class="gdPracticeRecommendationsBadge">Coach</div></div><div class="gdPracticeRecommendationRows"><div class="gdPracticeRecommendationRow"><span>Practice Bubble</span><strong>${gdEscapeHTML(bubbleLabel)}</strong></div><div class="gdPracticeRecommendationRow"><span>Cross-club check</span><strong>${gdEscapeHTML(verification)}</strong></div><div class="gdPracticeRecommendationRow"><span>Helper status</span><strong>${gdEscapeHTML(recommendation)}</strong></div></div>`;
  }
  function gdRenderPracticeRecommendations(analysis){
    const root=byId("gdPracticeRecommendationsPanel");
    if(!root)return;
    root.innerHTML=gdPracticeRecommendationsHTML(analysis);
  }
  function gdRenderPracticeMasterTolerance(){
    const root=byId("gdPracticeMasterTolerance");
    if(!root)return;
    const pct=gdPracticeToleranceMasterPct();
    const canEdit=gdPracticeToleranceCanEdit();
    const input=byId("gdPracticeToleranceMaster");
    const label=byId("gdPracticeToleranceMasterLabel");
    if(input){
      input.value=String(pct);
      input.disabled=!canEdit;
    }
    if(label)label.textContent=`${pct}%`;
    root.classList.toggle("locked",!canEdit);
  }
  function gdApplyPracticeToleranceMaster(value,opts){
    if(!gdPracticeToleranceCanEdit())return;
    const pct=Math.max(0,Math.min(100,Math.round(Number(value)||0)));
    try{localStorage.setItem("gd_practice_tolerance_master_pct",String(pct))}catch(e){}
    gdPracticeMasterToleranceFields.forEach(path=>gdPracticeWriteTolerance(path,gdPracticeToleranceMasterValue(path,pct)));
    gdRenderPracticeMasterTolerance();
    if(gdPracticeAdminIsOpen())gdRenderPracticeToleranceControls();
    renderPracticeData(true);
    if(opts&&opts.preserveCompareTab){
      gdPaintCompareVisual();
      return;
    }
    renderCompareData();
  }
  function gdPracticePreviewToleranceMaster(input){
    const pct=Math.max(0,Math.min(100,Math.round(Number(input?.value)||0)));
    const label=byId("gdPracticeToleranceMasterLabel");
    if(label)label.textContent=`${pct}%`;
    gdApplyPracticeToleranceMaster(pct);
    return false;
  }
  function gdPracticeSetToleranceMaster(value){
    gdApplyPracticeToleranceMaster(value);
    if(document.getElementById("developerPanel")?.classList.contains("open"))renderDevPanel();
    return false;
  }
  function gdPracticeWriteTolerance(path,value){
    gdWriteDataTuning(path,value);
  }
  // === Custom club/ball data gates (admin-authored exclusion rules) ===
  const GD_PRACTICE_GATE_METRICS=[["carry","Carry"],["total","Total"],["offline","Offline"],["ballSpeed","Ball Speed"],["clubSpeed","Club Speed"],["smash","Smash Factor"],["totalSpin","Total Spin"],["spinAxis","Spin Axis"],["launchAngle","Launch Angle"],["launchDirection","Launch Direction"],["faceAngle","Face Angle"],["clubPath","Club Path"],["faceToPath","Face to Path"],["attackAngle","Attack Angle"],["dynamicLoft","Dynamic Loft"],["apexHeight","Apex Height"],["descentAngle","Descent Angle"]];
  const GD_PRACTICE_GATE_OPS=[["gt","greater than"],["lt","less than"],["eq","equal to"],["between","between"],["outside","outside"]];
  function gdPracticeCustomGates(){
    try{
      const raw=dev("launchMonitorCluster.customGates");
      const parsed=typeof raw==="string"&&raw.trim()?JSON.parse(raw):(Array.isArray(raw)?raw:[]);
      return Array.isArray(parsed)?parsed:[];
    }catch(e){return [];}
  }
  function gdPracticeSaveCustomGates(rules){
    setDev("launchMonitorCluster.customGates",JSON.stringify(Array.isArray(rules)?rules:[]));
    gdRenderPracticeToleranceControls();
    renderPracticeData(true);
    return false;
  }
  function gdPracticeGateClubOptions(){
    const set=new Set();
    safe(()=>{(typeof gdPracticeSavedBagRows==="function"?gdPracticeSavedBagRows():[]).forEach(row=>{const c=String(row?.club||"").trim();if(c)set.add(c);});});
    safe(()=>{const analysis=gdPracticeDisplayAnalysis({quiet:true});(analysis?.acceptedShots||[]).concat(analysis?.rejectedShots||[]).forEach(shot=>{const c=String(shot?.club||"").trim();if(c)set.add(c);});});
    if(!set.size)["Driver","3w","5i","6i","7i","8i","9i","PW","SW"].forEach(c=>set.add(c));
    return [...set].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  }
  function gdPracticeGateRuleLabel(rule){
    const metricLabel=(GD_PRACTICE_GATE_METRICS.find(m=>m[0]===rule.metric)||[])[1]||rule.metric;
    const unit=rule.unit==="pct"?"% of bag carry":"";
    const opText={gt:">",lt:"<",eq:"=",between:"between",outside:"outside"}[rule.op]||rule.op;
    const val=(rule.op==="between"||rule.op==="outside")?`${rule.value} – ${rule.value2}${unit?` ${unit}`:""}`:`${rule.value}${unit?` ${unit}`:""}`;
    const clubs=Array.isArray(rule.clubs)&&rule.clubs.length?rule.clubs.join(", "):"All clubs";
    return `${clubs} · ${metricLabel} ${rule.abs?"|±| ":""}${opText} ${val}`;
  }
  function gdPracticeGateOpChanged(select){
    const wrap=select?.closest(".gdPracticeGateForm");
    const second=wrap?.querySelector("[data-gd-gate-val2]");
    const needsTwo=select?.value==="between"||select?.value==="outside";
    if(second)second.hidden=!needsTwo;
    return false;
  }
  function gdPracticeAddCustomGate(button){
    const form=button?.closest(".gdPracticeGateForm");
    if(!form)return false;
    const metric=form.querySelector("[data-gd-gate-metric]")?.value||"";
    const op=form.querySelector("[data-gd-gate-op]")?.value||"gt";
    const value=Number(form.querySelector("[data-gd-gate-val1]")?.value);
    const value2=Number(form.querySelector("[data-gd-gate-val2] input")?.value);
    const abs=!!form.querySelector("[data-gd-gate-abs]")?.checked;
    const unit=form.querySelector("[data-gd-gate-unit]")?.value==="pct"?"pct":"raw";
    const clubs=[...form.querySelectorAll("[data-gd-gate-club]:checked")].map(input=>String(input.value||"").trim()).filter(Boolean);
    if(!metric||!Number.isFinite(value)){gdLmToast("Pick a metric and a value first");return false;}
    if((op==="between"||op==="outside")&&!Number.isFinite(value2)){gdLmToast("Between needs two values");return false;}
    const rules=gdPracticeCustomGates();
    rules.push({id:`gate-${Date.now()}-${Math.floor(Math.random()*1e4)}`,metric,op,value,value2:Number.isFinite(value2)?value2:null,abs,unit,clubs,enabled:true});
    return gdPracticeSaveCustomGates(rules);
  }
  function gdPracticeRemoveCustomGate(id){
    return gdPracticeSaveCustomGates(gdPracticeCustomGates().filter(rule=>rule.id!==id));
  }
  function gdPracticeToggleCustomGate(id){
    return gdPracticeSaveCustomGates(gdPracticeCustomGates().map(rule=>rule.id===id?Object.assign({},rule,{enabled:rule.enabled===false}):rule));
  }
  function gdPracticeCustomGatesSectionHTML(canEdit){
    const rules=gdPracticeCustomGates();
    const rows=rules.map(rule=>{
      const on=rule.enabled!==false;
      const controls=canEdit?`<button type="button" class="gdPracticeGateToggle ${on?"on":""}" title="${on?"Disable":"Enable"} this gate" onclick="return gdPracticeToggleCustomGate('${gdEscapeHTML(rule.id)}')">${on?"On":"Off"}</button><button type="button" class="danger gdPracticeDeleteX" title="Delete this gate" onclick="return gdPracticeRemoveCustomGate('${gdEscapeHTML(rule.id)}')">&times;</button>`:"";
      return `<div class="gdPracticeGateRow ${on?"":"off"}"><span>${gdEscapeHTML(gdPracticeGateRuleLabel(rule))}</span><div class="gdPracticeGateRowActions">${controls}</div></div>`;
    }).join("")||`<div class="gdPracticeGateEmpty">No custom gates yet. Shots matching a gate are excluded from cluster consideration (they still plot).</div>`;
    const metricOptions=GD_PRACTICE_GATE_METRICS.map(([key,label])=>`<option value="${key}">${gdEscapeHTML(label)}</option>`).join("");
    const opOptions=GD_PRACTICE_GATE_OPS.map(([key,label])=>`<option value="${key}">${gdEscapeHTML(label)}</option>`).join("");
    const clubChecks=gdPracticeGateClubOptions().map(club=>`<label class="gdPracticeGateClub"><input type="checkbox" data-gd-gate-club value="${gdEscapeHTML(club)}"><span>${gdEscapeHTML(club)}</span></label>`).join("");
    const form=canEdit?`<div class="gdPracticeGateForm">
      <div class="gdPracticeGateFormRow">
        <select data-gd-gate-metric aria-label="Metric">${metricOptions}</select>
        <select data-gd-gate-op aria-label="Condition" onchange="return gdPracticeGateOpChanged(this)">${opOptions}</select>
        <input data-gd-gate-val1 type="number" step="any" inputmode="decimal" placeholder="Value" aria-label="Value">
        <span data-gd-gate-val2 hidden><input type="number" step="any" inputmode="decimal" placeholder="and" aria-label="Second value"></span>
      </div>
      <div class="gdPracticeGateFormRow">
        <select data-gd-gate-unit aria-label="Unit"><option value="raw">Native units</option><option value="pct">% of bag carry</option></select>
        <label class="gdPracticeGateAbs"><input type="checkbox" data-gd-gate-abs><span>± either side</span></label>
        <button type="button" class="primary" onclick="return gdPracticeAddCustomGate(this)">Add gate</button>
      </div>
      <details class="gdPracticeGateClubs"><summary>Apply to clubs (default: all)</summary><div class="gdPracticeGateClubGrid">${clubChecks}</div></details>
    </div>`:"";
    return `<section class="gdPracticeToleranceSection gdPracticeCustomGates"><div class="gdPracticeToleranceSectionHead"><strong>Custom data gates</strong><span>Club &amp; ball data</span></div><div class="gdPracticeGateList">${rows}</div>${form}</section>`;
  }
  // === Launch monitor source trust (don't-trust rules) ===
  const GD_PRACTICE_SOURCE_LABELS={trackman:"Trackman",foresight:"Foresight (GCQuad/GC3)",flightscope:"FlightScope / Mevo",garmin_r10:"Garmin R10",skytrak:"SkyTrak",toptracer:"Toptracer",uneekor:"Uneekor",fullswing:"Full Swing",rapsodo:"Rapsodo MLM",awesome_golf:"Awesome Golf",unknown:"Unknown"};
  function gdPracticeSourceLabel(key){
    return GD_PRACTICE_SOURCE_LABELS[String(key||"").trim().toLowerCase()]||String(key||"Unknown");
  }
  function gdPracticeSourceTrustRules(){
    try{
      const raw=dev("launchMonitorCluster.sourceTrust");
      const parsed=typeof raw==="string"&&raw.trim()?JSON.parse(raw):(Array.isArray(raw)?raw:[]);
      return Array.isArray(parsed)?parsed:[];
    }catch(e){return [];}
  }
  function gdPracticeSaveSourceTrust(rules){
    setDev("launchMonitorCluster.sourceTrust",JSON.stringify(Array.isArray(rules)?rules:[]));
    gdRenderPracticeToleranceControls();
    renderPracticeData(true);
    return false;
  }
  function gdPracticeAddSourceTrust(button){
    const form=button?.closest(".gdPracticeSourceTrustForm");
    if(!form)return false;
    const source=form.querySelector("[data-gd-trust-source]")?.value||"";
    const metric=form.querySelector("[data-gd-trust-metric]")?.value||"all";
    if(!source){gdLmToast("Pick a source first");return false;}
    const rules=gdPracticeSourceTrustRules();
    if(rules.some(rule=>rule.source===source&&String(rule.metric||"all")===metric)){gdLmToast("That rule already exists");return false;}
    rules.push({id:`trust-${Date.now()}-${Math.floor(Math.random()*1e4)}`,source,metric,enabled:true});
    return gdPracticeSaveSourceTrust(rules);
  }
  function gdPracticeRemoveSourceTrust(id){
    return gdPracticeSaveSourceTrust(gdPracticeSourceTrustRules().filter(rule=>rule.id!==id));
  }
  function gdPracticeToggleSourceTrust(id){
    return gdPracticeSaveSourceTrust(gdPracticeSourceTrustRules().map(rule=>rule.id===id?Object.assign({},rule,{enabled:rule.enabled===false}):rule));
  }
  function gdPracticeRescanSources(){
    const changed=safe(()=>window.GolfDaddyLaunchMonitorData?.retagProviders?.(),0)||0;
    gdLmToast(changed?`Re-tagged ${changed} import${changed===1?"":"s"}`:"No source changes found");
    gdRenderPracticeToleranceControls();
    renderPracticeData(true);
    return false;
  }
  function gdPracticeDetectedSources(){
    const set=new Set();
    safe(()=>{const analysis=gdPracticeDisplayAnalysis({quiet:true});(analysis?.acceptedShots||[]).concat(analysis?.rejectedShots||[]).forEach(shot=>{const p=String(shot?.providerGuess||"").trim().toLowerCase();if(p&&p!=="unknown")set.add(p);});});
    return [...set];
  }
  function gdPracticeSourceTrustSectionHTML(canEdit){
    const rules=gdPracticeSourceTrustRules();
    const rows=rules.map(rule=>{
      const on=rule.enabled!==false;
      const metricLabel=rule.metric==="all"?"All exclusion gates":((GD_PRACTICE_GATE_METRICS.find(m=>m[0]===rule.metric)||[])[1]||rule.metric);
      const controls=canEdit?`<button type="button" class="gdPracticeGateToggle ${on?"on":""}" title="${on?"Disable":"Enable"} this rule" onclick="return gdPracticeToggleSourceTrust('${gdEscapeHTML(rule.id)}')">${on?"On":"Off"}</button><button type="button" class="danger gdPracticeDeleteX" title="Delete this rule" onclick="return gdPracticeRemoveSourceTrust('${gdEscapeHTML(rule.id)}')">&times;</button>`:"";
      return `<div class="gdPracticeGateRow ${on?"":"off"}"><span>${gdEscapeHTML(gdPracticeSourceLabel(rule.source))} · don't apply ${gdEscapeHTML(metricLabel)}${rule.preload?" · preset":""}</span><div class="gdPracticeGateRowActions">${controls}</div></div>`;
    }).join("")||`<div class="gdPracticeGateEmpty">No source rules. Add one to stop unreliable launch monitor data triggering exclusions.</div>`;
    const detected=gdPracticeDetectedSources();
    const known=safe(()=>window.GolfDaddyLaunchMonitorData?.providerSignatures?.(),null)||Object.keys(GD_PRACTICE_SOURCE_LABELS).filter(key=>key!=="unknown").map(key=>({key,label:GD_PRACTICE_SOURCE_LABELS[key]}));
    const sourceOptions=known.map(sig=>`<option value="${gdEscapeHTML(sig.key)}">${gdEscapeHTML(sig.label)}${detected.includes(sig.key)?" · in library":""}</option>`).join("");
    const metricOptions=[`<option value="all">All exclusion gates</option>`].concat(GD_PRACTICE_GATE_METRICS.map(([key,label])=>`<option value="${key}">${gdEscapeHTML(label)}</option>`)).join("");
    const form=canEdit?`<div class="gdPracticeGateForm gdPracticeSourceTrustForm">
      <div class="gdPracticeGateFormRow">
        <select data-gd-trust-source aria-label="Launch monitor source">${sourceOptions}</select>
        <select data-gd-trust-metric aria-label="Gate to skip">${metricOptions}</select>
        <button type="button" class="primary" onclick="return gdPracticeAddSourceTrust(this)">Add rule</button>
      </div>
      <div class="gdPracticeGateFormRow">
        <button type="button" onclick="return gdPracticeRescanSources()">Re-scan import sources</button>
      </div>
    </div>`:"";
    return `<section class="gdPracticeToleranceSection gdPracticeSourceTrust"><div class="gdPracticeToleranceSectionHead"><strong>Source trust</strong><span>Don't-trust rules</span></div><div class="gdPracticeGateList">${rows}</div>${form}</section>`;
  }
	  function gdRenderPracticeToleranceControls(){
	    const root=byId("gdPracticeTolerancePanel");
	    if(!root||typeof dev!=="function"||typeof setDev!=="function")return;
    const canEdit=gdPracticeToleranceCanEdit();
    const rowHTML=path=>{
      const f=DEV_FIELDS[path]||{};
      const value=Number(dev(path));
      const id=`gdTol_${path.replace(/[^a-z0-9]/gi,"_")}`;
      const label=gdPracticeToleranceCompactLabel(path,f.label);
      const help=gdPracticeToleranceCompactHelp(path,f.help);
      return `<div class="gdPracticeTolerance" title="${gdEscapeHTML(help)}"><label for="${id}"><span>${gdEscapeHTML(label)}</span>${help?`<small>${gdEscapeHTML(help)}</small>`:""}</label><input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" value="${Number.isFinite(value)?value:devDefault(path)}" data-tolerance-path="${path}" ${canEdit?"":"disabled"}><output>${gdPracticeToleranceDisplay(path,value)}</output></div>`;
    };
    root.classList.toggle("locked",!canEdit);
    root.innerHTML=[
      `<div class="gdPracticeToleranceHead"><div><strong>Practice Bubble controls</strong></div><div class="gdPracticeToleranceBadge">${canEdit?"Admin":"Locked"}</div></div>`,
      `<div class="gdPracticeToleranceSections">${gdPracticeToleranceSections.map(section=>`<section class="gdPracticeToleranceSection"><div class="gdPracticeToleranceSectionHead"><strong>${gdEscapeHTML(section.label)}</strong><span>${gdEscapeHTML(section.meta||"")}</span></div><div class="gdPracticeToleranceGrid">${section.fields.map(rowHTML).join("")}</div></section>`).join("")}${gdPracticeCustomGatesSectionHTML(canEdit)}${gdPracticeSourceTrustSectionHTML(canEdit)}</div>`
    ].join("");
    root.querySelectorAll("[data-tolerance-path]").forEach(input=>{
      input.oninput=()=>{
        const path=input.dataset.tolerancePath;
        const f=DEV_FIELDS[path]||{};
        let value=Number(input.value);
        if(!Number.isFinite(value))value=Number(devDefault(path));
        value=Math.max(Number(f.min),Math.min(Number(f.max),value));
        gdPracticeWriteTolerance(path,value);
        const out=input.parentElement?.querySelector("output");
        if(out)out.textContent=gdPracticeToleranceDisplay(path,value);
        gdRenderPracticeMasterTolerance();
        renderPracticeData(true);
	      };
	      input.onchange=()=>{if(document.getElementById("developerPanel")?.classList.contains("open"))renderDevPanel();};
	    });
	  }
		  const gdPracticeEvidenceOpenClubs={};
		  const gdPracticeEvidenceSelectedShots={};
		  const gdPracticeImportSelected={};
		  let gdPracticeImportSelectMode=false;
		  let gdPracticeEvidenceActiveClub="";
		  let gdPracticeRawDetailKey="";
	  try{gdPracticeEvidenceActiveClub=localStorage.getItem("gd_practice_evidence_active_club")||"";}catch(e){}
	  function gdPracticeJsArg(value){
	    return gdEscapeHTML(JSON.stringify(String(value||"")));
	  }
		  function gdPracticeShotMetricValue(shot,names){
		    const list=(Array.isArray(names)?names:[names])
		      .flatMap(name=>gdLmMetricNamesForKey(name))
		      .map(name=>String(name||"").trim().toLowerCase().replace(/[^a-z0-9]/g,""));
		    const metrics=Array.isArray(shot?.metrics)?shot.metrics:[];
		    for(const key of list){
		      const metric=metrics.find(item=>{
		        const candidate=String(item?.candidateMetric||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
		        const raw=String(item?.rawLabel||"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
		        return candidate===key||raw===key;
		      });
		      const value=Number(metric?.value);
		      if(Number.isFinite(value))return value;
		    }
	    return null;
	  }
		  function gdPracticeEvidenceRows(analysis){
		    const store=gdPracticeDisplayStore()||{};
		    const shots=Array.isArray(store.shots)?store.shots:[];
		    const accepted=Array.isArray(analysis?.acceptedShots)?analysis.acceptedShots:[];
		    const rejected=Array.isArray(analysis?.rejectedShots)?analysis.rejectedShots:[];
		    const acceptedIndexById=new Map(accepted.map((shot,index)=>[shot?.shotId,index]));
		    const rejectedById=new Map(rejected.map(shot=>[shot?.shotId,shot?.rejectReason||"filtered"]));
		    const pointRows=gdComparePracticePoints({practiceAnalysis:analysis});
		    const pointByIndex=new Map(pointRows.map(point=>[point.index,point]));
		    const pointByShotId=new Map(pointRows.map(point=>[point.shotId,point]).filter(item=>item[0]));
		    const seen=new Set();
		    const launchRows=shots.map((shot,index)=>{
		      if(shot?.shotId)seen.add(shot.shotId);
		      const acceptedIndex=acceptedIndexById.has(shot?.shotId)?acceptedIndexById.get(shot.shotId):-1;
		      const point=pointByShotId.get(shot?.shotId)||(acceptedIndex>=0?(pointByIndex.get(acceptedIndex)||{}):{});
		      const rawCarry=Number.isFinite(Number(shot.carryM))?Number(shot.carryM):gdPracticeShotMetricValue(shot,["carryDistance","carry"]);
	      const rawExpected=Number.isFinite(Number(shot.expectedM))?Number(shot.expectedM):rawCarry;
	      const expected=Math.max(1,Number(rawExpected)||Number(rawCarry)||155);
	      const rawLateral=Number.isFinite(Number(shot.lateralM))?Number(shot.lateralM):gdPracticeShotMetricValue(shot,["offline","side","lateral"]);
	      const rawNormalized=Number.isFinite(Number(shot.normalizedDeg))?Number(shot.normalizedDeg):gdPracticeShotMetricValue(shot,["sideAngle","offlineAngle","resultAngle"]);
	      const depth=Number.isFinite(Number(shot.depthM))?Number(shot.depthM):(Number.isFinite(rawCarry)?rawCarry-expected:0);
	      const normalized=Number.isFinite(Number(rawNormalized))?Number(rawNormalized):(Number.isFinite(rawLateral)?Math.atan2(Number(rawLateral),expected)*180/Math.PI:null);
	      const rejectReason=rejectedById.get(shot?.shotId)||shot.rejectReason||"";
	      const plotDeselected=gdPracticeShotDeselectedFromPlot(shot);
	      const excluded=!!rejectReason||point.excluded===true||shot.rejected===true;
	      return{
	        source:"practice",
	        index,
	        shotId:shot.shotId||"",
	        club:shot.club||"Unknown",
	        actualDistanceM:Number.isFinite(rawCarry)?rawCarry:null,
	        expectedDistanceM:expected,
	        lateralM:Number.isFinite(rawLateral)?rawLateral:null,
	        depthM:depth,
	        normalizedDeg:normalized,
	        counted:!excluded&&point.counted===true,
	        excluded,
	        plotDeselected,
		        rejectReason,
		        captureId:shot.captureId||"",
		        sessionId:shot.sessionId||"",
		        importBatchId:shot.importBatchId||shot.importId||shot.captureId||shot.sessionId||"",
		        playerId:shot.playerId||shot.profileId||"",
		        accountId:shot.accountId||"",
		        sourceType:shot.inputType||shot.sourceType||shot.providerGuess||"",
		        providerGuess:shot.providerGuess||"",
		        rawSource:shot.rawSource||shot.rawGroup||null,
		        warnings:Array.isArray(shot.warnings)?shot.warnings:[],
		        errors:Array.isArray(shot.errors)?shot.errors:[],
		        plotSource:shot.plot?.source||"",
		        plotSimulated:shot.plot?.simulated===true,
		        plotComplete:shot.plot?.complete===true,
		        timestamp:shot.timestamp||shot.capturedAt||shot.time||""
		      };
		    });
		    // One store now: there is no "native only" pile left to reconcile.
		    return launchRows;
		  }
	  function gdPracticeEvidencePlotLabel(row){
	    const source=String(row?.plotSource||"").replace(/_/g," ");
	    if(!row?.plotComplete)return "incomplete";
	    if(row?.plotSimulated)return "sim";
	    if(source.includes("direct"))return "direct";
	    return source||"plot";
	  }
	  function gdPracticeEvidenceTime(value){
	    const time=Date.parse(value||"");
	    return Number.isFinite(time)?time:0;
	  }
	  function gdPracticeEvidenceDateLabel(value){
	    const time=gdPracticeEvidenceTime(value);
	    if(!time)return "Undated upload";
	    try{return new Intl.DateTimeFormat(undefined,{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(time));}
	    catch(e){return new Date(time).toLocaleString();}
	  }
	  function gdPracticeEvidenceUploadMap(){
	    const store=gdPracticeDisplayStore()||{};
	    const sessions={};
	    (store.sessions||[]).forEach(session=>{
	      if(session?.sessionId)sessions[session.sessionId]=session;
	    });
	    const uploads={};
	    (store.captures||[]).forEach(capture=>{
	      if(!capture?.captureId)return;
	      const session=sessions[capture.sessionId]||{};
	      const timestamp=capture.timestamp||session.startedAt||session.importedAt||"";
	      uploads[capture.captureId]={
	        id:capture.captureId,
	        sessionId:capture.sessionId||"",
	        label:session.label||"Practice upload",
	        inputType:capture.inputType||"",
	        timestamp,
	        time:gdPracticeEvidenceTime(timestamp),
	        providerGuess:capture.sourceIdentity?.providerGuess||session.sourceIdentity?.providerGuess||""
	      };
	    });
	    return uploads;
	  }
		  function gdPracticeEvidenceUploadForRow(row, uploads){
		    const id=row.captureId||row.sessionId||row.timestamp||"unknown";
		    const upload=uploads[row.captureId]||null;
		    if(upload)return upload;
	    const timestamp=row.timestamp||"";
	    return{
	      id,
	      sessionId:row.sessionId||"",
	      label:row.providerGuess?String(row.providerGuess).replace(/_/g," "):"Practice upload",
	      inputType:"",
	      timestamp,
	      time:gdPracticeEvidenceTime(timestamp),
			      providerGuess:row.providerGuess||""
			    };
			  }
		  function gdPracticeImportMetadataMap(){
		    const store=gdPracticeDisplayStore()||{};
		    const map={};
		    (store.sessions||[]).forEach(session=>{
		      const id=String(session?.importBatchId||session?.importId||session?.sessionId||"").trim();
		      if(!id)return;
		      map[id]=Object.assign({},map[id]||{},{
		        id,
		        sessionId:session.sessionId||"",
		        label:session.label||map[id]?.label||"Practice import",
		        sourceName:session.label||map[id]?.sourceName||"Practice import",
		        sourceType:session.sourceIdentity?.providerGuess||map[id]?.sourceType||"",
		        timestamp:session.importedAt||session.startedAt||map[id]?.timestamp||"",
		        playerId:session.playerId||map[id]?.playerId||"",
		        accountId:session.accountId||map[id]?.accountId||""
		      });
		    });
		    (store.captures||[]).forEach(capture=>{
		      const id=String(capture?.importBatchId||capture?.importId||capture?.captureId||capture?.sessionId||"").trim();
		      if(!id)return;
		      map[id]=Object.assign({},map[id]||{},{
		        id,
		        captureId:capture.captureId||"",
		        sessionId:capture.sessionId||map[id]?.sessionId||"",
		        label:map[id]?.label||capture.sourceIdentity?.providerGuess||"Practice import",
		        sourceName:map[id]?.sourceName||capture.sourceIdentity?.providerGuess||"Practice import",
		        sourceType:capture.inputType||map[id]?.sourceType||"",
		        timestamp:capture.timestamp||map[id]?.timestamp||"",
		        playerId:capture.playerId||map[id]?.playerId||"",
		        accountId:capture.accountId||map[id]?.accountId||""
		      });
		    });
		    return map;
		  }
		  function gdPracticeImportLabel(value){
		    const text=String(value||"").replace(/[_-]+/g," ").trim();
		    return text?text.replace(/\b\w/g,char=>char.toUpperCase()):"Practice import";
		  }
		  function gdPracticeImportDate(value){
		    const label=gdPracticeEvidenceDateLabel(value);
		    return label==="Undated upload"?"Undated import":label;
		  }
		  function gdPracticeClubKey(value){
		    const text=String(value||"").trim()||"Unknown / Unmatched";
		    return text.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"unknown";
		  }
		  function gdPracticeRawDetailId(club,importId){
		    return `${gdPracticeClubKey(club)}::${String(importId||"unknown")}`;
		  }
		  function gdPracticeToggleRawDetail(club,importId){
		    const key=gdPracticeRawDetailId(club,importId);
		    gdPracticeRawDetailKey=gdPracticeRawDetailKey===key?"":key;
		    renderPracticeData(true);
		    return false;
		  }
		  function gdPracticeRowStatus(row){
		    if(Array.isArray(row?.errors)&&row.errors.length)return "flagged";
		    if(row?.plotDeselected)return "plot off";
		    if(row?.excluded)return "rejected";
		    if(row?.counted)return "bubble fit";
		    return "stored";
		  }
		  function gdPracticeBubbleStatusForClub(analysis,club){
		    const key=gdPracticeClubKey(club);
		    const clusters=gdPracticeClusterByClub(analysis);
		    const cluster=Object.keys(clusters||{}).map(name=>({name,cluster:clusters[name]})).find(item=>gdPracticeClubKey(item.name)===key)?.cluster||null;
		    const status=gdPracticeEvidenceStatus(cluster,Number(cluster?.countedShots||cluster?.shots||0),Number(cluster?.totalShots||cluster?.shots||0));
		    if(status&&status!=="empty"&&status!=="collecting")return status;
		    return "";
		  }
		  function gdPracticeRawValue(value,fallback="-"){
		    if(value===null||value===undefined||value==="")return fallback;
		    if(typeof value==="number"&&Number.isFinite(value))return Math.abs(value)>=10?value.toFixed(0):value.toFixed(1);
		    return String(value);
		  }
		  function gdPracticeRawShotTableHTML(rows,meta,club,importId){
		    // A NORMAL shot table: one row per shot, one column per scanned metric.
		    // No shot IDs, no accepted/rejected status, no player/account plumbing —
		    // those live in debug tooling, not the library.
		    const sorted=(Array.isArray(rows)?rows:[]).slice().sort((a,b)=>a.index-b.index);
		    const TEMPLATE=[["ballSpeed","Ball mph"],["launchAngle","Launch"],["sideAngle","Side"],["backspin","Backspin"],["sideSpin","Side Spin"],["descentAngle","Descent"],["offline","Offline"],["peakHeight","Peak"],["carryDistance","Carry"],["totalDistance","Total"]];
		    const DIRECTIONAL=["sideAngle","sideSpin","offline"];
		    const metricOf=(row,key)=>{
		      const list=row&&row.rawSource&&Array.isArray(row.rawSource.metrics)?row.rawSource.metrics:[];
		      const m=list.find(item=>String(item&&item.candidateMetric||"")===key);
		      if(m&&Number.isFinite(Number(m.value)))return Number(m.value);
		      if(key==="carryDistance"&&Number.isFinite(Number(row.actualDistanceM)))return Number(row.actualDistanceM);
		      if(key==="offline"&&Number.isFinite(Number(row.lateralM)))return Number(row.lateralM);
		      return null;
		    };
		    const fmt=(key,v)=>{
		      if(v==null)return "-";
		      if(DIRECTIONAL.includes(key)){
		        const side=v<0?"L ":v>0?"R ":"";
		        return side+(Math.abs(v)>=100?Math.round(Math.abs(v)):Math.abs(v).toFixed(1)).toString();
		      }
		      return Math.abs(v)>=100?String(Math.round(v)):String(Number(v.toFixed(1)));
		    };
		    const cols=TEMPLATE.filter(([key])=>sorted.some(row=>metricOf(row,key)!=null));
		    const gridStyle=`grid-template-columns:26px repeat(${cols.length},minmax(54px,1fr))`;
		    const head=`<div class="gdPracticeRawShotHead" style="${gridStyle}"><span>#</span>${cols.map(([,label])=>`<span>${gdEscapeHTML(label)}</span>`).join("")}</div>`;
		    const tableRows=sorted.map((row,i)=>
		      `<div class="gdPracticeRawShotRow" style="${gridStyle}"><span>${i+1}</span>${cols.map(([key])=>`<span>${gdEscapeHTML(fmt(key,metricOf(row,key)))}</span>`).join("")}</div>`
		    ).join("");
		    return `<div class="gdPracticeRawShotTable">${head}${tableRows}</div>`;
		  }
		  function gdPracticeToggleImportSelectMode(){
		    gdPracticeImportSelectMode=!gdPracticeImportSelectMode;
		    if(!gdPracticeImportSelectMode)Object.keys(gdPracticeImportSelected).forEach(id=>delete gdPracticeImportSelected[id]);
		    renderPracticeData(true);
		    return false;
		  }
		  function gdPracticeToggleImportSelection(input){
		    const id=String(input?.value||"").trim();
		    if(!id)return true;
		    if(input.checked)gdPracticeImportSelected[id]=true;
		    else delete gdPracticeImportSelected[id];
		    renderPracticeData(true);
		    return true;
		  }
		  function gdPracticeSelectedImportIds(){
		    return Object.keys(gdPracticeImportSelected).filter(Boolean);
		  }
		  function gdPracticeCurrentMyBubbleImportWarning(importIds){
		    const ids=new Set((Array.isArray(importIds)?importIds:[importIds]).map(String));
		    const source=safe(()=>ensureProfile()?.practiceBubbleSource,null)||{};
		    const sourceIds=[source.importBatchId,source.importId].concat(Array.isArray(source.importBatchIds)?source.importBatchIds:[]).filter(Boolean).map(String);
		    if(sourceIds.some(id=>ids.has(id)))return " This import was used for the current My Bubble. My Bubble will remain unchanged.";
		    return source?.active&&ids.size?" My Bubble will remain unchanged. Reset My Bubble separately if needed.":"";
		  }
		  // IN-APP CONFIRMATION. window.confirm is silently suppressed in the app's
		  // embedded webview: it returns false INSTANTLY without ever showing a dialog.
		  // Every destructive action gated on it therefore did nothing at all - no
		  // toast, no error, no change - which is exactly what "delete isn't working"
		  // turned out to be. Do not reintroduce window.confirm for these paths.
		  // Promise form, for await-style call sites:
		  //   if(!await gdConfirmDialog({...}))return false;   // drop-in for confirm()
		  // Resolves false if there is no DOM to draw into, so a missing dialog can
		  // never silently approve a destructive action.
		  function gdConfirmDialog(options){
		    const opts=typeof options==="string"?{message:options}:(options||{});
		    return new Promise(resolve=>{
		      if(!document?.body){resolve(false);return;}
		      document.getElementById("gdConfirmOverlay")?.remove();
		      const overlay=document.createElement("div");
		      overlay.id="gdConfirmOverlay";
		      overlay.className="gdConfirmOverlay";
		      overlay.innerHTML=`<div class="gdConfirmSheet" role="alertdialog" aria-modal="true" aria-label="${gdEscapeHTML(opts.title||"Are you sure?")}">
		        <strong>${gdEscapeHTML(opts.title||"Are you sure?")}</strong>
		        <p>${gdEscapeHTML(opts.message||"")}</p>
		        <div class="gdConfirmActions">
		          <button type="button" data-gd-confirm="cancel">${gdEscapeHTML(opts.cancelLabel||"Cancel")}</button>
		          <button type="button" class="danger" data-gd-confirm="ok">${gdEscapeHTML(opts.confirmLabel||"Delete")}</button>
		        </div>
		      </div>`;
		      let settled=false;
		      const finish=value=>{if(settled)return;settled=true;overlay.remove();resolve(value);};
		      overlay.addEventListener("click",event=>{
		        if(event.target===overlay)return finish(false);
		        const action=event.target?.dataset?.gdConfirm;
		        if(action==="cancel")return finish(false);
		        if(action==="ok")return finish(true);
		      });
		      document.body.appendChild(overlay);
		    });
		  }
		  // Callback form, for onclick handlers that must return false synchronously.
		  function gdConfirmAction(options,onConfirm){
		    gdConfirmDialog(options).then(ok=>{
		      if(!ok||typeof onConfirm!=="function")return;
		      try{onConfirm();}catch(e){console.warn("[GolfDaddy] confirm action failed",e);}
		    });
		    return false;
		  }
		  function gdPracticeDeleteImports(importIds){
		    const ids=(Array.isArray(importIds)?importIds:[importIds]).map(id=>String(id||"").trim()).filter(Boolean);
		    if(!ids.length){gdLmToast("No practice imports selected");return false;}
		    const warning=gdPracticeCurrentMyBubbleImportWarning(ids);
		    const count=ids.length;
		    return gdConfirmAction({
		      title:`Delete ${count} practice import${count===1?"":"s"}?`,
		      message:`This hides import metadata, source rows, native shots, debug events and the generated Practice Bubble for the import.${warning}`,
		      confirmLabel:"Delete"
		    },()=>gdPracticeDeleteImportsConfirmed(ids));
		  }
		  function gdPracticeDeleteImportsConfirmed(ids){
		    const launchApi=window.GolfDaddyLaunchMonitorData;
		    // One store, one delete. This used to delete from the native store and the
		    // library and then take the MAX of the two counts, because the same import
		    // was mirrored in both under one importBatchId and adding them reported a
		    // 6-shot delete as 12 rows.
		    let launchRows=0,launchImports=0;
		    safe(()=>{
		      if(launchApi&&typeof launchApi.deleteSelectedPracticeImports==="function"){
		        const result=launchApi.deleteSelectedPracticeImports(ids);
		        launchRows=Number(result?.deletedShots)||0;
		        launchImports=Number(result?.deletedImports)||0;
		      }
		    },null);
		    const deletedRows=launchRows;
		    const deletedImports=launchImports;
		    ids.forEach(id=>delete gdPracticeImportSelected[id]);
		    if(!gdPracticeSelectedImportIds().length)gdPracticeImportSelectMode=false;
		    gdPracticeDebugEnsureRun({sourceName:"Practice import delete",sourceType:"admin"});
		    // Report what ACTUALLY happened. This used to toast
		    // `deletedImports||ids.length`, so a delete that matched no records still
		    // said "Deleted 1 practice import" - which is exactly why a broken delete
		    // looked like a working one.
		    const deletedNothing=!deletedImports&&!deletedRows;
		    gdPracticeDebugCheckpoint("practice_import_deleted",deletedNothing?"warning":"success",{counts:{imports:deletedImports,rows:deletedRows,requested:ids.length},raw:{importIds:ids}});
		    renderPracticeData(true);
		    if(typeof window.gdRenderDataHubStatus==="function")window.gdRenderDataHubStatus();
		    if(deletedNothing)gdLmToast(`Nothing deleted - no stored rows matched ${ids.length===1?"that import":"those imports"}`);
		    else gdLmToast(`Deleted ${deletedImports||1} practice import${(deletedImports||1)===1?"":"s"} (${deletedRows} row${deletedRows===1?"":"s"})`);
		    return false;
		  }
		  function gdPracticeDeleteSelectedImports(){
		    return gdPracticeDeleteImports(gdPracticeSelectedImportIds());
		  }
		  function gdPracticeClearLibraryForPlayer(){
		    const launchApi=window.GolfDaddyLaunchMonitorData;
		    const nativeApi=gdNativePracticeApi&&gdNativePracticeApi();
		    const scope=safe(()=>launchApi?.activePlayerScope?.()||nativeApi?.activePlayerScope?.(),{})||{};
		    const playerId=String(scope.playerId||"").trim();
		    if(!playerId){gdLmToast("Player scope missing");return false;}
		    return gdConfirmAction({
		      title:"Clear the practice library?",
		      message:"Clears all practice imports for this player. Player-scoped only, and My Bubble is left unchanged.",
		      confirmLabel:"Clear"
		    },()=>gdPracticeClearLibraryForPlayerConfirmed(playerId,launchApi,nativeApi));
		  }
		  function gdPracticeClearLibraryForPlayerConfirmed(playerId,launchApi,nativeApi){
		    let deleted=0;
		    safe(()=>{if(launchApi&&typeof launchApi.clearPracticeLibraryForPlayer==="function")deleted+=Number(launchApi.clearPracticeLibraryForPlayer(playerId)?.deletedImports)||0;},null);
		    Object.keys(gdPracticeImportSelected).forEach(id=>delete gdPracticeImportSelected[id]);
		    gdPracticeImportSelectMode=false;
		    gdPracticeDebugEnsureRun({sourceName:"Practice library player clear",sourceType:"admin"});
		    gdPracticeDebugCheckpoint("practice_library_player_clear","success",{counts:{imports:deleted},raw:{playerId}});
		    renderPracticeData(true);
		    if(typeof window.gdRenderDataHubStatus==="function")window.gdRenderDataHubStatus();
			    gdLmToast(`Cleared ${deleted} practice import${deleted===1?"":"s"} for this player`);
			    return false;
			  }
			  function gdPracticeToggleEvidenceClub(button){
		    const section=button?.closest?.(".gdPracticeShotClub,.gdPracticeNativeClub,.gdPracticeEvidenceClub");
	    if(!section)return false;
	    const club=section.dataset.club||"";
	    const open=!section.classList.contains("open");
	    section.classList.toggle("open",open);
	    button.setAttribute("aria-expanded",open?"true":"false");
	    if(club)gdPracticeEvidenceOpenClubs[club]=open;
	    const marker=section.querySelector(".gdPracticeEvidenceChevron");
	    if(marker)marker.textContent=open?"-":"+";
	    return false;
	  }
    if(!window.__gdPracticeNativeClubToggleBound){
      window.__gdPracticeNativeClubToggleBound=true;
    document.addEventListener("click",event=>{
      const scoreButton=event.target&&event.target.closest&&event.target.closest(".scoreBlock .scoreBtn");
      if(scoreButton){
        event.preventDefault();
        event.stopImmediatePropagation();
        const label=String(scoreButton.getAttribute("aria-label")||scoreButton.textContent||"");
        const delta=/decrease|-/i.test(label)?-1:1;
        if(typeof window.adjustScore==="function")return window.adjustScore(delta);
        return false;
      }
      const target=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-club-toggle]");
      if(!target)return;
        event.preventDefault();
        event.stopImmediatePropagation();
        return gdPracticeToggleEvidenceClub(target);
      },true);
    }
    if(!window.__gdPracticeLibraryActionBound){
      window.__gdPracticeLibraryActionBound=true;
      document.addEventListener("click",event=>{
        const rawButton=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-raw-import]");
        if(rawButton){
          event.preventDefault();
          event.stopImmediatePropagation();
          return gdPracticeToggleRawDetail(rawButton.dataset.gdPracticeRawClub||"",rawButton.dataset.gdPracticeRawImport||"");
        }
        const plotButton=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-plot-mode]");
        if(plotButton){
          event.preventDefault();
          event.stopImmediatePropagation();
          return gdPracticeSetPlotMode(plotButton.dataset.gdPracticePlotMode||"all");
        }
      },true);
    }
	  function gdPracticeSetEvidenceClubTab(club){
	    gdPracticeEvidenceActiveClub=String(club||"");
	    try{localStorage.setItem("gd_practice_evidence_active_club",gdPracticeEvidenceActiveClub);}catch(e){}
	    renderPracticeData(true);
	    return false;
	  }
	  function gdPracticeToggleEvidenceShot(input){
	    const id=String(input?.value||"").trim();
	    if(!id)return true;
	    if(input.checked)gdPracticeEvidenceSelectedShots[id]=true;
	    else delete gdPracticeEvidenceSelectedShots[id];
	    renderPracticeData(true);
	    return true;
	  }
	  function gdPracticeSetEvidenceUploadSelection(captureId,checked){
	    const rows=gdPracticeEvidenceRows(gdPracticeDisplayAnalysis());
	    rows.filter(row=>row.captureId===captureId&&row.shotId).forEach(row=>{
	      if(checked)gdPracticeEvidenceSelectedShots[row.shotId]=true;
	      else delete gdPracticeEvidenceSelectedShots[row.shotId];
	    });
	    renderPracticeData(true);
	    return false;
	  }
	  function gdPracticeSetEvidenceClubSelection(club,checked){
	    const rows=gdPracticeEvidenceRows(gdPracticeDisplayAnalysis());
	    rows.filter(row=>row.club===club&&row.shotId).forEach(row=>{
	      if(checked)gdPracticeEvidenceSelectedShots[row.shotId]=true;
	      else delete gdPracticeEvidenceSelectedShots[row.shotId];
	    });
	    renderPracticeData(true);
	    return false;
	  }
	  function gdPracticeClearEvidenceSelection(){
	    Object.keys(gdPracticeEvidenceSelectedShots).forEach(id=>delete gdPracticeEvidenceSelectedShots[id]);
	    renderPracticeData(true);
	    return false;
	  }
	  async function gdPracticeDeleteSelectedEvidenceShots(){
	    const ids=Object.keys(gdPracticeEvidenceSelectedShots).filter(Boolean);
	    if(!ids.length){
	      gdLmToast("No practice shots selected");
	      return false;
	    }
	    return gdConfirmAction({
      title:`Delete ${ids.length} practice shot${ids.length===1?"":"s"}?`,
      message:"The selected shots are removed from practice data.",
      confirmLabel:"Delete"
    },()=>gdPracticeDeleteSelectedEvidenceShotsConfirmed(ids));
  }
  function gdPracticeDeleteSelectedEvidenceShotsConfirmed(ids){
	    const api=window.GolfDaddyLaunchMonitorData;
	    if(!api||typeof api.deleteShots!=="function"){
	      gdLmToast("Practice delete is not ready");
	      return false;
	    }
	    const result=api.deleteShots(ids);
	    gdPracticeClearEvidenceSelection();
	    if(typeof window.gdRenderDataHubStatus==="function")window.gdRenderDataHubStatus();
	    gdLmToast(`Deleted ${Number(result?.deleted)||ids.length} practice shot${ids.length===1?"":"s"}`);
	    return false;
	  }
	  function gdPracticeClusterByClub(analysis){
	    const result=analysis?.methods?.resultScaledCluster?.clubClusters||[];
	    const display=analysis?.clusters||[];
	    const map={};
	    result.concat(display).forEach(cluster=>{
	      if(cluster?.club&&!map[cluster.club])map[cluster.club]=cluster;
	    });
	    return map;
	  }
	  function gdPracticeEvidenceStatus(cluster, counted, total){
	    if(cluster?.status)return String(cluster.status).replace(/_/g," ");
	    if(counted>=5)return "bubble ready";
	    if(total)return "collecting";
	    return "empty";
	  }
		  function gdPracticeSandboxMetric(rawLabel,candidateMetric,value,unit="m",confidence=.92){
    return{rawLabel,candidateMetric,value,unit,confidence};
  }
  function gdPracticeSandboxGroup(club,baseCarry,offsetDeg,index,opts={}){
    const jitter=Array.isArray(opts.jitter)?opts.jitter:[-.42,.18,.36,-.2,.08,-.12,.28,-.32,.05];
    const depth=Array.isArray(opts.depth)?opts.depth:[-2,1,3,-1,2,0,-3,1,4];
    const shotOffset=Number(offsetDeg)+(jitter[index%jitter.length]||0);
    const carry=Math.round(Number(baseCarry)+(depth[index%depth.length]||0));
    const offline=Number((Math.tan(shotOffset*Math.PI/180)*Math.max(1,Number(baseCarry))).toFixed(1));
    const faceToPath=Number((shotOffset*.42+((index%3)-1)*.12).toFixed(2));
    const clubPath=Number((((index%5)-2)*.18).toFixed(2));
    return{
      shotId:`sandbox-${String(club).replace(/[^a-z0-9]/gi,"").toLowerCase()}-${Date.now()}-${index}-${Math.random().toString(16).slice(2,7)}`,
      originClubLabel:club,
      candidateClub:club,
      expectedDistanceM:Number(baseCarry),
      analysisLane:"cluster_hunt",
      sourceMethod:"cluster_hunt",
      simulatedShot:true,
      metrics:[
        gdPracticeSandboxMetric("Carry","carryDistance",carry,"m",.94),
        gdPracticeSandboxMetric("Offline","offline",offline,"m",.93),
        gdPracticeSandboxMetric("Face to Path","faceToPath",faceToPath,"deg",.84),
        gdPracticeSandboxMetric("Club Path","clubPath",clubPath,"deg",.82)
      ],
      timestamp:opts.timestamp||new Date().toISOString()
    };
  }
  function gdPracticeSandboxPayload(label,timestamp,specs){
    const clubGroups=[];
    (Array.isArray(specs)?specs:[]).forEach(spec=>{
      const count=Math.max(1,Number(spec.count)||1);
      for(let i=0;i<count;i++){
        clubGroups.push(gdPracticeSandboxGroup(spec.club,spec.carry,spec.offsetDeg,i,{timestamp,jitter:spec.jitter,depth:spec.depth}));
      }
    });
    return{
      label,
      timestamp,
      startedAt:timestamp,
      inputType:"generated-demo",
      sourceIdentity:{providerGuess:"native_practice_sandbox",confidence:.98},
      clubGroups
    };
  }
  function gdPracticeSandboxScenarioSpecs(scenario){
    const mode=String(scenario||"ready");
    if(mode==="sparse")return[
      {label:"Sparse native trial",daysAgo:0,specs:[{club:"7i",carry:154,offsetDeg:2.4,count:3}]}
    ];
    if(mode==="distance")return[
      {label:"Native distance mismatch",daysAgo:2,specs:[{club:"7i",carry:170,offsetDeg:2.6,count:8},{club:"9i",carry:146,offsetDeg:2.3,count:7}]},
      {label:"Native long-club check",daysAgo:0,specs:[{club:"Driver",carry:268,offsetDeg:2.7,count:6}]}
    ];
    return[
      {label:"Native 7i / 9i upload",daysAgo:4,specs:[{club:"7i",carry:155,offsetDeg:2.4,count:8},{club:"9i",carry:133,offsetDeg:2.2,count:7}]},
      {label:"Native Driver upload",daysAgo:0,specs:[{club:"Driver",carry:246,offsetDeg:2.6,count:6}]}
    ];
  }
  function gdPracticeLoadSandboxNativeRows(scenario="ready"){
    const api=window.GolfDaddyLaunchMonitorData;
    if(!api||typeof api.importCapture!=="function"){
      gdLmToast("Native shot data store is not ready");
      return false;
    }
    if(typeof api.clearStore==="function")api.clearStore();
    const now=Date.now();
    gdPracticeSandboxScenarioSpecs(scenario).forEach(item=>{
      const timestamp=new Date(now-(Number(item.daysAgo)||0)*86400000).toISOString();
      api.importCapture(gdPracticeSandboxPayload(item.label,timestamp,item.specs));
    });
    gdSetPracticePhotoProcessing(true,{stageIndex:3,progress:96,preserveClubs:true});
    gdSetPracticePhotoProcessing(false);
    try{localStorage.setItem("gd_practice_plot_filter_mode","all");}catch(e){}
    gdPracticeProjectionUserTouched=false;
    renderPracticeData(true);
    renderDataHubStatus();
    gdLmToast("Sandbox native practice data loaded");
    return false;
  }
  function gdPracticeSimulateSandboxImport(scenario="ready"){
    gdPracticePhotoProcessingClubs=gdPracticeSandboxScenarioSpecs(scenario).flatMap(item=>item.specs||[]).map(spec=>spec.club);
    gdSetPracticePhotoProcessing(true,{preserveClubs:true,stageIndex:0,progress:12});
    setTimeout(()=>gdSetPracticePhotoProcessing(true,{preserveClubs:true,stageIndex:1,progress:42}),650);
    setTimeout(()=>gdSetPracticePhotoProcessing(true,{preserveClubs:true,stageIndex:2,progress:74}),1300);
    setTimeout(()=>gdPracticeLoadSandboxNativeRows(scenario),1900);
    return false;
  }
  function gdPracticeSetSandboxBag(mode){
    const value=String(mode||"matched");
    if(value==="empty"){
      const p=safe(()=>typeof gdShotActiveProfile==="function"?gdShotActiveProfile():ensureProfile(),null)||ensureProfile();
      p.bag=[];
      p.bagSlotsTouched=false;
      p.bagSeededDefault=false;
      p.updatedAt=new Date().toISOString();
      savePlayerProfiles();
      syncCoreProfileFromActive();
      gdPracticeBagSuggestionOpen=false;
      gdLmToast("Sandbox bag cleared");
    }else{
      const seven=value==="different"?142:155;
      gdBagPersistRows(gdGenerateQuickBag(seven),{silent:true,render:false});
      gdPracticeBagSuggestionOpen=false;
      gdLmToast(value==="different"?"Sandbox bag set different":"Sandbox bag matched");
    }
    safe(()=>typeof renderBagPanel==="function"&&renderBagPanel());
    safe(()=>typeof renderShot==="function"&&renderShot());
    return gdPracticeRefreshProjectionSurfaces();
  }
  function gdPracticeClearSandboxData(){
    const api=window.GolfDaddyLaunchMonitorData;
    if(api&&typeof api.clearStore==="function")api.clearStore();
    gdShotBubbleOverlayState.practice=false;
    window.gdShotBubbleOverlayState=gdShotBubbleOverlayState;
    document.documentElement.dataset.gdOverlayPractice="off";
    gdPracticeProjectionUserTouched=false;
    gdPracticeBagSuggestionOpen=false;
    renderPracticeData(true);
    renderDataHubStatus();
    gdLmToast("Practice sandbox data cleared");
    return false;
  }
  function gdPracticeSandboxControlsHTML(variant=""){
    if(!gdPracticeAdminIsOpen())return "";
    const compact=String(variant||"")==="compact";
    return `<div class="gdPracticeSandboxControls ${compact?"compact":""}"><div><strong>Local test inputs</strong><span>${compact?"Native-shaped sandbox rows.":"Temporary native-shaped rows for UI testing."}</span></div><div class="gdPracticeSandboxButtons"><button type="button" data-gd-practice-sandbox-action="simulate" data-gd-practice-sandbox-scenario="ready">Simulate import</button><button type="button" data-gd-practice-sandbox-action="load" data-gd-practice-sandbox-scenario="ready">Ready rows</button><button type="button" data-gd-practice-sandbox-action="load" data-gd-practice-sandbox-scenario="sparse">Sparse rows</button><button type="button" data-gd-practice-sandbox-action="load" data-gd-practice-sandbox-scenario="distance">Distance mismatch</button><button type="button" data-gd-practice-sandbox-action="clear">Clear</button><button type="button" data-gd-practice-sandbox-action="bag" data-gd-practice-sandbox-mode="empty">Bag empty</button><button type="button" data-gd-practice-sandbox-action="bag" data-gd-practice-sandbox-mode="matched">Bag matched</button><button type="button" data-gd-practice-sandbox-action="bag" data-gd-practice-sandbox-mode="different">Bag differs</button></div></div>`;
  }
  Object.assign(window,{gdPracticeLoadSandboxNativeRows,gdPracticeSimulateSandboxImport,gdPracticeSetSandboxBag,gdPracticeClearSandboxData,gdPracticeSetDistanceLinkClub,gdPracticeGenerateBubble,gdPracticeSaveBubbleFromAction,gdPracticeAdoptBubbleFromAction,gdPracticeUnadoptBubbleFromAction,gdPracticeApplyBagSuggestions,gdPracticeToggleBagSuggestions,gdPracticeToggleBagAdapt,gdPracticeBagAdaptRemember,gdPracticeBagAdaptChanged,gdPracticeUndoBagAdapt});

			  function gdRenderPracticeEvidenceList(analysis){
			    const root=byId("gdPracticeEvidenceList");
			    if(!root)return;
			    const rows=gdPracticeEvidenceRows(analysis);
			    const adminOpen=gdPracticeAdminIsOpen();
			    if(!rows.length){
			      const adminClear=adminOpen?`<button type="button" class="danger" onclick="return gdPracticeClearLibraryForPlayer()">Clear player imports</button>`:"";
			      root.innerHTML=gdPracticeLibraryShellHTML(analysis,0,`<div class="gdPracticeEvidenceHead"><div><strong>Clarity Shot Library</strong><span>Imported practice shots will appear here after a scan or upload.</span></div>${adminClear}</div>`);
			      return;
			    }
			    const importMeta=gdPracticeImportMetadataMap();
			    if(!adminOpen&&gdPracticeImportSelectMode){
			      gdPracticeImportSelectMode=false;
			      Object.keys(gdPracticeImportSelected).forEach(id=>delete gdPracticeImportSelected[id]);
			    }
			    const selectedCount=gdPracticeSelectedImportIds().length;
			    const adminClear=adminOpen?`<button type="button" class="danger" onclick="return gdPracticeClearLibraryForPlayer()">Clear player imports</button>`:"";
			    const tools=adminOpen?`<div class="gdPracticeEvidenceTools gdPracticeShotLibraryTools"><button type="button" onclick="return gdPracticeToggleImportSelectMode()">${gdPracticeImportSelectMode?"Cancel Select":"Select imports"}</button><button type="button" class="danger" ${selectedCount?"":"disabled"} onclick="return gdPracticeDeleteSelectedImports()">Delete Selected${selectedCount?` (${selectedCount})`:""}</button>${adminClear}</div>`:"";
			    const groupedByClub={};
			    rows.forEach(row=>{
			      const club=String(row.club||"").trim()||"Unknown / Unmatched";
			      const clubKey=gdPracticeClubKey(club);
			      groupedByClub[clubKey]=groupedByClub[clubKey]||{club,rows:[],imports:{}};
			      groupedByClub[clubKey].rows.push(row);
			      // Both stores match a delete on importBatchId/importId/captureId/sessionId
			      // and NOTHING else. Grouping may still fall back to timestamp/"unknown" so
			      // the rows stay visible, but such a group can never be deleted - the id
			      // matches no record. Track that so the UI can say so instead of firing a
			      // delete that silently does nothing.
			      const matchableId=String(row.importBatchId||row.captureId||row.sessionId||"").trim();
			      const importId=matchableId||String(row.timestamp||"unknown").trim()||"unknown";
			      groupedByClub[clubKey].imports[importId]=groupedByClub[clubKey].imports[importId]||{id:importId,deletable:!!matchableId,meta:importMeta[importId]||{},rows:[]};
			      groupedByClub[clubKey].imports[importId].rows.push(row);
			    });
			    const clubs=Object.values(groupedByClub).sort((a,b)=>{
			      if(gdPracticeClubKey(a.club)==="unknown")return 1;
			      if(gdPracticeClubKey(b.club)==="unknown")return -1;
			      return a.club.localeCompare(b.club,undefined,{numeric:true});
			    });
			    const clubSections=clubs.map((clubGroup,index)=>{
			      const club=clubGroup.club;
			      const clubRows=clubGroup.rows;
			      const imports=Object.values(clubGroup.imports).sort((a,b)=>{
			        const at=gdPracticeEvidenceTime(a.meta.timestamp||a.rows[0]?.timestamp);
			        const bt=gdPracticeEvidenceTime(b.meta.timestamp||b.rows[0]?.timestamp);
			        return bt-at;
			      });
			      const importCount=imports.length;
			      const latest=imports[0]?.meta?.timestamp||imports[0]?.rows?.[0]?.timestamp||"";
			      const bubbleStatus=gdPracticeBubbleStatusForClub(analysis,club);
			      const open=gdPracticeEvidenceOpenClubs[club]!==undefined?!!gdPracticeEvidenceOpenClubs[club]:index===0;
			      const uploadRows=imports.map(group=>{
			        const importId=group.id;
			        const importRows=group.rows.slice().sort((a,b)=>a.index-b.index);
			        const meta=group.meta||{};
			        const dateLabel=gdPracticeImportDate(meta.timestamp||importRows[0]?.timestamp||"");
			        const selected=!!gdPracticeImportSelected[importId];
			        const checkbox=adminOpen&&gdPracticeImportSelectMode?`<label class="gdPracticeEvidenceUploadSelect" onclick="event.stopPropagation()"><input type="checkbox" value="${gdEscapeHTML(importId)}" ${selected?"checked":""} onchange="gdPracticeToggleImportSelection(this)"><span>Select</span></label>`:"";
			        const importActions=group.deletable
			          ?`<button type="button" class="danger gdPracticeDeleteX" title="Delete this import" aria-label="Delete this import" onclick="return gdPracticeDeleteImports(${gdPracticeJsArg(importId)})">&times;</button>`
			          :`<button type="button" class="danger gdPracticeDeleteX" disabled title="These rows carry no import id, so they cannot be deleted as an import. Use Clear practice library." aria-label="Not deletable - no import id">&times;</button>`;
			        // Quiet row: just the upload date (club is the section header). Clicking
			        // the row expands the import's raw data table directly beneath it.
			        // (Buttons/inputs inside <summary> activate themselves, not the toggle.)
			        const providerKey=String(importRows[0]?.providerGuess||"").trim().toLowerCase();
		        const providerBadge=providerKey&&providerKey!=="unknown"?`<span class="gdPracticeUploadSource">${gdEscapeHTML(gdPracticeSourceLabel(providerKey))}</span>`:"";
		        return `<details class="gdPracticeUploadRow" data-import-id="${gdEscapeHTML(importId)}"><summary>${checkbox}<div class="gdPracticeUploadMeta"><strong>${gdEscapeHTML(dateLabel)}</strong>${providerBadge}</div><div class="gdPracticeUploadActions">${importActions}</div></summary><div class="gdPracticeUploadRaw">${gdPracticeRawShotTableHTML(importRows,meta,club,importId)}</div></details>`;
			      }).join("");
			      // Quiet header: club label + latest upload date only. Shot/upload counts
			      // and bubble status are admin/raw-data concerns, not library chrome.
			      return `<section class="gdPracticeShotClub ${open?"open":""}" data-club="${gdEscapeHTML(club)}"><button type="button" class="gdPracticeShotClubHead" data-gd-practice-club-toggle aria-expanded="${open?"true":"false"}"><div><span>${gdEscapeHTML(club)}</span></div><small>${gdEscapeHTML(gdPracticeImportDate(latest))}</small><b class="gdPracticeEvidenceChevron">${open?"-":"+"}</b></button><div class="gdPracticeShotClubBody">${uploadRows}</div></section>`;
			    }).join("");
			    root.innerHTML=gdPracticeLibraryShellHTML(analysis,rows.length,`${gdPracticePlotModeControls()}${tools}<div class="gdPracticeShotLibrary${rows.length>18?" gdPracticeEvidenceClubRowsScrollable":""}">${clubSections}</div>`);
			  }
  /* Normalised Practice is the PRIMARY view and this wrapper is why it stays
     that way: with the Projected Clubs module absent, or throwing, the exact
     normalised markup that was passed in is what gets rendered. The secondary
     view can never take the primary one down with it. */
  function gdPracticeVisualHTML(normalisedHTML,analysis){
    const view=window.GDPracticeProjectedClubs;
    if(!view||typeof view.practiceVisualHtml!=="function")return normalisedHTML;
    try{return view.practiceVisualHtml(normalisedHTML,analysis)}catch(e){return normalisedHTML}
  }
  function renderPracticeData(skipTolerances=false){
    gdPracticeReleaseInactiveProcessingSurface();
    const visual=byId("gdPracticeDataVisual");
			    const visualTitle=byId("gdPracticeVisualTitle");
			    const result=byId("gdPracticeDataResult");
			    const evidenceList=byId("gdPracticeEvidenceList");
			    const api=window.GolfDaddyLaunchMonitorData;
			    const manualApi=window.GolfDaddyManualPracticeData;
    const manualOverride=safe(()=>typeof manualApi?.isOverrideActive==="function"?manualApi.isOverrideActive():false,false);
		    if(visualTitle)visualTitle.textContent=`${gdShotDataPlayerLabel()} - ${manualOverride?"Practice Data (trusted override)":"Practice Data"}`;
		    if(result)gdRenderPracticeAutoFlow(null);
	    gdRenderPracticeMasterTolerance();
    gdRenderPracticeAdminChrome();
    gdRenderPracticeImportPanel();
    gdRenderNativePracticeImportLane();
    safe(()=>typeof manualApi?.renderLane==="function"&&manualApi.renderLane(byId("gdManualPracticeLane")));
    gdSyncPracticeSampleImportButton();
	    if(!api||typeof api.analyze!=="function"){
	      if(visual)visual.innerHTML=gdPracticeVisualHTML(practiceSvg({acceptedShots:[],recommendation:{status:"module loading",offsetDeg:0}}),null);
	      if(evidenceList)evidenceList.innerHTML="";
	      gdRenderPracticeProjectionControls(null);
	      gdRenderPracticeRecommendations(null);
	      gdRenderPracticeAutoFlow(null);
	      gdRenderPracticeImportPanel();
	      gdRenderNativePracticeImportLane();
              safe(()=>typeof manualApi?.renderLane==="function"&&manualApi.renderLane(byId("gdManualPracticeLane")));
		      if(!skipTolerances&&gdPracticeAdminIsOpen())gdRenderPracticeToleranceControls();
		      return;
		    }
		    let analysis=gdPracticeDisplayAnalysis();
	    // No real bag yet: generate one from these shots before anything is drawn.
	    // The bag is the chart's denominator, so this has to settle before the
	    // analysis is read - recompute if it fired.
	    if(gdPracticeAutoBagFromData(analysis))analysis=gdPracticeDisplayAnalysis();
    const totals=analysis?.totals||{};
	    const rec=analysis?.recommendation||{};
	    const bubbleMethod=gdPracticeBubbleMethod(analysis);
	    const offsetValue=Number(bubbleMethod?.anchorDeg);
	    const visualAnalysis=Number.isFinite(offsetValue)?Object.assign({},analysis,{__practiceBubbleOffsetDeg:offsetValue}):analysis;
	    gdPracticeMaybeAutoShowProjection(visualAnalysis);
	    gdRenderPracticeAutoFlow(visualAnalysis);
	    gdRenderPracticeProjectionControls(analysis);
	    if(visual){
	      const visualSource=totals.rawShots?visualAnalysis:{acceptedShots:[],recommendation:{status:"no practice data",offsetDeg:0}};
	      visual.innerHTML=gdPracticeVisualHTML(practiceSvg(visualSource),visualSource);
	    }
    // One evidence list. Manual observations are canonical Practice evidence now,
    // so they list beside every other import rather than replacing the list with
    // a Manual-Practice-only view.
    gdRenderPracticeEvidenceList(analysis);
    gdRenderPracticeRecommendations(analysis);
	    gdRenderPracticeMasterTolerance();
    gdRenderPracticeAdminChrome();
    gdRenderNativePracticeImportLane();
    safe(()=>typeof manualApi?.renderLane==="function"&&manualApi.renderLane(byId("gdManualPracticeLane")));
    gdRenderPracticeExtractionCheckpoint();
    if(!skipTolerances&&gdPracticeAdminIsOpen())gdRenderPracticeToleranceControls();
  }
  function openPracticeData(opts){
    if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("practiceData"))return false;
    openModulePanel("dataHubPanel","Practice Data","",opts);
    gdHubSetSection("practice",{force:true});
    gdSetPracticeDataTab(opts&&opts.adminTab?"admin":"data");
    gdRenderBubbleOffsetHub();
    return false;
  }
	  function openCompareData(opts){
	    openDataHub(opts);
	    gdHubSetSection("compare",{force:true});
	    safe(()=>window.GDShell?.openModule?.("shotData",{source:"route-audit-compare-data",moduleId:"dataHubPanel",label:"Shot Data",replace:true}));
	    gdRenderBubbleOffsetHub();
	    return false;
	  }
  async function loadPracticeDemo(){
    safe(()=>typeof toast==="function"&&toast("Demo data removed"));
    renderPracticeData();
    renderDataHubStatus();
    return false;
  }
	  function clearPracticeData(){
	    safe(()=>gdClearLaunchMonitorDemo());
	    setTimeout(renderPracticeData,80);
	    return false;
	  }
	  function deletePracticeImport(importId){
	    return gdPracticeDeleteImports([importId]);
	  }
	  function deleteSelectedPracticeImports(importIds){
	    return gdPracticeDeleteImports(importIds);
	  }
	  function clearPracticeLibraryForPlayer(playerId){
	    const launchApi=window.GolfDaddyLaunchMonitorData;
	    const nativeApi=gdNativePracticeApi&&gdNativePracticeApi();
	    const scopedPlayer=String(playerId||safe(()=>launchApi?.activePlayerScope?.().playerId||nativeApi?.activePlayerScope?.().playerId,"")||"").trim();
	    if(!scopedPlayer){gdLmToast("Player scope missing");return false;}
	    let deleted=0;
	    safe(()=>{if(launchApi&&typeof launchApi.clearPracticeLibraryForPlayer==="function")deleted+=Number(launchApi.clearPracticeLibraryForPlayer(scopedPlayer)?.deletedImports)||0;},null);
	    Object.keys(gdPracticeImportSelected).forEach(id=>delete gdPracticeImportSelected[id]);
	    gdPracticeImportSelectMode=false;
	    renderPracticeData(true);
	    if(typeof window.gdRenderDataHubStatus==="function")window.gdRenderDataHubStatus();
	    return {deletedImports:deleted,playerId:scopedPlayer};
	  }
	  function openDeveloper(opts){
    if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("admin"))return false;
    const priorBackTarget=window.__gdBackTarget||"";
    const explicitGps=!!(opts&&opts.fromGps);
    const explicitHome=!!(opts&&opts.fromHome);
    const returnToGps=explicitGps||(!explicitHome&&(priorBackTarget==="gps"||document.body.classList.contains("shell-gps")));
    const returnToHome=explicitHome||(!explicitGps&&(priorBackTarget==="home"||document.body.classList.contains("shell-home")));
    openLegacyPanel("developerPanel","Admin","admin",opts);
    window.__gdBackTarget=returnToGps?"gps":(returnToHome?"home":"");
    gdRememberBrowserRoute("developer",true);
    safe(()=>typeof gdRenderPermissionsAdmin==="function"&&gdRenderPermissionsAdmin());
    safe(()=>typeof renderDevPanel==="function"&&renderDevPanel());
    return false;
  }
	  function openBagStable(opts){
    rememberProfileReturn(opts);
    const explicitGps=!!(opts&&opts.fromGps);
    const explicitHome=!!(opts&&opts.fromHome);
    const explicitProfile=!!(opts&&opts.fromProfile);
    const returnToGps=explicitGps||(!explicitHome&&document.body.classList.contains("shell-gps"));
	    const returnToHome=!explicitProfile&&(explicitHome||(!explicitGps&&document.body.classList.contains("shell-home"))||!returnToGps);
	    openLegacyPanel("bagPanel","Bag","bag",opts);
	    safe(()=>typeof renderBagPanel==="function"&&renderBagPanel());
	    window.__gdBackTarget=explicitProfile?"profile":(returnToGps?"gps":(returnToHome?"home":""));
	    gdRememberBrowserRoute("bag",true);
	    setProfileReturnButton();
	    return false;
	  }
	  function openSettingsStable(opts){
	    const explicitGps=!!(opts&&opts.fromGps);
	    const explicitHome=!!(opts&&opts.fromHome);
	    const returnToGps=explicitGps||(!explicitHome&&document.body.classList.contains("shell-gps"));
	    const returnToHome=explicitHome||(!explicitGps&&document.body.classList.contains("shell-home"));
	    openLegacyPanel("settingsPanel","Settings","",opts);
	    const panel=byId("settingsPanel");
	    if(panel)panel.dataset.gdReturnTarget=returnToGps?"gps":(returnToHome?"home":"");
	    window.__gdBackTarget=returnToGps?"gps":(returnToHome?"home":"");
	    gdRememberBrowserRoute("settings",true);
	    return false;
	  }
	  function openGpsStable(opts){
    const preserve=!!(opts&&(opts.preserveState||opts.preserve||opts.fromBack||opts.fromWand||opts.keepGps));
    closeLegacyPanels();
    closeModules();
    hideOverlays();
    clearBody();
	    byId("shellHome")?.classList.add("hidden");
	    safe(()=>window.GDShell?.enterGps?.(Object.assign({source:"route-audit-open-gps"},opts||{})));
    setDock("gps");
    setRouteLabel("GPS");
    remember("gps",!!(opts&&opts.replace));
		    if(typeof oldEnterGps==="function")safe(()=>oldEnterGps.call(window,Object.assign({replace:true},opts||{})));
		    safe(()=>window.gdApplyGpsMapVisibilityOwner?.("open-gps-stable-before-map-reset"));
		    safe(()=>{
		      const mapEl=byId("map");
			      if(mapEl){
			        const liveAllowed=!!((window.gdGpsLiveMapExplicitlyAllowed&&window.gdGpsLiveMapExplicitlyAllowed("open-gps-stable"))||document.body.classList.contains("gdGpsLiveMapAllowed"));
			        mapEl.style.display="";
			        mapEl.style.visibility=liveAllowed?"":"hidden";
			        mapEl.style.opacity=liveAllowed?"":"0";
			        mapEl.style.pointerEvents=liveAllowed?"":"none";
			      }
			    });
		    safe(()=>window.gdApplyGpsMapVisibilityOwner?.("open-gps-stable"));
		    const selectedCourseForHole=opts?.fromCoursePicker||opts?.selectedCourse
	      ?(opts.selectedCourse||activeCourseForGpsStable()||visibleCourseForGpsStable())
	      :null;
	    const shouldShowPicker=!preserve&&!opts?.fromCoursePicker&&!opts?.selectedCourse;
	    const shouldOpenActiveHole=!preserve&&!shouldShowPicker&&selectedCourseForHole&&!gpsStableCourseIsManual(selectedCourseForHole);
	    if(shouldShowPicker)showCoursePicker();
	    else hideCoursePicker();
	    if(shouldOpenActiveHole)scheduleStableMappedHoleOne(selectedCourseForHole,"open-gps-stable");
		    setTimeout(()=>safe(()=>{
		      if(typeof map!=="undefined"&&map&&typeof map.invalidateSize==="function")map.invalidateSize();
		      else window.map?.invalidateSize?.();
		    }),80);
	    setTimeout(()=>safe(()=>shouldShowPicker?showCoursePicker():hideCoursePicker()),90);
	    const syncActiveHole=function(){
	      const screen=byId("courseScreen");
	      const pickerOpen=screen&&!screen.classList.contains("hidden")&&getComputedStyle(screen).display!=="none"&&getComputedStyle(screen).visibility!=="hidden";
		      if(preserve||pickerOpen)return;
		      const course=selectedCourseForHole||visibleCourseForGpsStable();
		      if(!course||gpsStableCourseIsManual(course))return;
		      scheduleStableMappedHoleOne(course,"open-gps-stable-sync");
		    };
	    if(shouldOpenActiveHole)setTimeout(()=>safe(syncActiveHole),140);
	    [360,900,1700].forEach(delay=>setTimeout(()=>safe(syncActiveHole),delay));
    setTimeout(()=>safe(()=>window.gdHydrateGpsBadge?.(true)),120);
    return false;
  }
  function openBubbleStable(opts){
    /* openDataHub carries the gate; stop here too rather than re-labelling the
       shell for a panel that never opened. */
    if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("shotData"))return false;
    openDataHub(opts);
    setDock("bubble");
    setRouteLabel("Shot Data");
    remember("dataHubPanel",!!(opts&&opts.replace));
    return false;
  }
  function openProfileStable(opts){
    let opened=false;
    const profileOpts=Object.assign({replace:true},opts||{});
	    const wasGps=!!profileOpts.fromGps||document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
	    const wasHome=!!profileOpts.fromHome||document.body.classList.contains("shell-home");
	    const backTarget=wasGps&&!wasHome?"gps":"home";
	    window.__gdBackTarget=backTarget;
	    clearGpsSurfaceLocks();
	    if(window.gdOpenProfileClean&&window.gdOpenProfileClean!==openProfileStable){
      safe(()=>{
        window.gdOpenProfileClean(profileOpts);
        opened=true;
      });
      if(opened){
        setDock("");
        setRouteLabel("Profile");
        remember("profilePanel",!!profileOpts.replace);
        window.__gdBackTarget=backTarget;
        return false;
      }
    }
    cleanForModule();
    if(typeof window.gdOpenProfileV67==="function"){
      safe(()=>{
        window.gdOpenProfileV67();
        opened=true;
      });
    }
    if(!opened&&typeof oldOpenProfilePanel==="function"){
      safe(()=>{
        oldOpenProfilePanel.call(window,profileOpts);
        opened=true;
      });
    }
    const currentProfile=byId("gdProfileV67");
    if(currentProfile){
      currentProfile.classList.remove("hidden");
	      document.body.classList.add("gdProfileOpen");
	      safe(()=>window.GDShell?.openModule?.("profile",{source:"route-audit-profile-stable",moduleId:"gdProfileV67",replace:!!profileOpts.replace}));
      opened=true;
    }
    if(!opened){
      const legacy=byId("profilePanel");
      if(legacy){
        legacy.classList.add("open");
        opened=true;
      }
    }
    setDock("");
    setRouteLabel("Profile");
    remember("profilePanel",!!profileOpts.replace);
    window.__gdBackTarget=backTarget;
    if(!opened)return forceHomeFallback();
    return false;
  }
		  function showCoursePickerStableBack(reason){
		    if(window.GDCoursePicker&&typeof window.GDCoursePicker.open==="function"){
		      return window.GDCoursePicker.open({source:reason||"stable-back",returnTarget:"gps"});
		    }
		    clearCoursePickerDatabaseState();
		    safe(()=>{window.GDShell?.openCoursePicker?.({source:reason||"stable-back",returnTarget:"gps"});document.body.classList.remove("gdToolRailOpen","gdCourseOpening","gdCoursePinPromptActive")});
	    safe(()=>{const h=byId("shellHome");if(h){h.classList.add("hidden");h.style.display="none";h.style.visibility="hidden";h.style.opacity="0"}});
	    safe(()=>{const c=byId("courseScreen");if(c){c.classList.remove("hidden");c.style.display="flex";c.style.visibility="";c.style.opacity="";c.style.pointerEvents="auto"}});
	    safe(()=>{const hint=byId("hint");if(hint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent=""}});
	    safe(()=>{if(typeof window.gdEnsureResumeRoundPicker==="function")window.gdEnsureResumeRoundPicker()});
	    safe(()=>{if(typeof gdRefreshAssumedCourseFromLocation==="function")gdRefreshAssumedCourseFromLocation()});
	    safe(()=>{if(typeof toast==="function")toast("Course picker")});
	    return false;
	  }
	  function gpsBackWithinSession(){
	    try{
	      if(document.body.classList.contains("gdManualStartPlacementActive")){
	        document.body.classList.remove("gdManualStartPlacementActive");
	        document.body.classList.add("gdMappedStartPromptActive");
	        const h=byId("hint");
	        if(h){
	          h.classList.add("visible","gdMappedStartPill");
	          if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(h);
	        }
	        if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame({source:"back-cancel-manual-start"});
	        return false;
	      }
	    }catch(e){}
	    try{
	      if(document.body.classList.contains("gdMappedStartPromptActive")&&!document.body.classList.contains("gdManualStartPlacementActive"))return showCoursePickerStableBack("stable-prelock-back");
	    }catch(e){}
	    try{
	      if(window.gdPendingManualShotVerification){
	        window.gdPendingManualShotVerification=false;
	        if(typeof gdSyncNewShotButtonState==="function")gdSyncNewShotButtonState();
	        if(typeof toast==="function")toast("Result logging cancelled");
	        return false;
	      }
	    }catch(e){}
	    try{
	      const hasUndo=Array.isArray(window.undoStack)?window.undoStack.length>0:(typeof undoStack!=="undefined"&&Array.isArray(undoStack)&&undoStack.length>0);
	      if(hasUndo&&typeof undoLast==="function"){
	        undoLast();
	        return false;
	      }
	    }catch(e){}
	    try{if(typeof toast==="function")toast("Course picker");}catch(e){}
	    return openGpsStable({replace:false});
	  }
	  function backStable(){
	    const routeRaw=safe(()=>window.ClarityRouter?.get?.().name,null)||window.lastShellModule||"home";
	    const route=String(routeRaw||"home").toLowerCase();
	    const moduleRoutes=["admin","bag","settings","playersettings","developer","bagpanel","settingspanel","playersettingspanel","developerpanel"];
	    const bodyGps=!!(document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active"))&&!document.body.classList.contains("shell-home");
	    if(window.__gdBackTarget==="profile")return returnToProfileWorkspace();
	    if(byId("dataHubPanel")?.classList.contains("open")&&gdDataHubCompareOpen)return gdCloseDataHubCompare();
    if(window.__gdBackTarget==="gps"&&moduleRoutes.includes(route)){
      window.__gdBackTarget="";
      return openGpsStable({replace:true,preserveState:true,fromBack:true});
    }
    if(window.__gdBackTarget==="home"&&moduleRoutes.includes(route)){
      window.__gdBackTarget="";
      return forceHomeFallback();
    }
    if(route==="coursedata"||route==="practicedata"||route==="practicedatapanel")return openDataHub({replace:true});
	    if(route==="gps")return gpsBackWithinSession();
	    if(bodyGps&&(route==="home"||route===""))return gpsBackWithinSession();
	    if(route==="shotdata"||route==="datahubpanel"||moduleRoutes.includes(route))return forceHomeFallback();
    return forceHomeFallback();
  }
  function shellBackClick(event){
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    return backStable();
  }
  function shellBackPointer(event){
    if(document.body.classList.contains("gdMappedStartPromptActive")&&!document.body.classList.contains("gdManualStartPlacementActive")){
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      return backStable();
    }
    return true;
  }
  function showModeDashboardStable(){
    return forceHomeFallback();
  }
  function expose(){
    const api={
      gdOpenDataHub:openDataHub,
      gdOpenCourseData:openCourseData,
      gdOpenPracticeData:openPracticeData,
      gdSetCourseDataTab:gdSetCourseDataTab,
      gdCourseDataSurfaceSvg:gdCourseDataSurfaceSvg,
      gdCourseRangeChanged:gdCourseRangeChanged,
      // Shared by every destructive action across the app - window.confirm is dead
      // in the embedded webview.
      gdConfirmAction:gdConfirmAction,
      gdConfirmDialog:gdConfirmDialog,
      // Inline onclick handlers in the admin panel need these on window.
      gdSandboxGenerateCourse:gdSandboxGenerateCourse,
      gdSandboxInjectCourse:gdSandboxInjectCourse,
      gdSandboxGeneratePractice:gdSandboxGeneratePractice,
      gdSandboxSendPractice:gdSandboxSendPractice,
      // gd-app-core's gdCourseBubbleValueLabel guards on `typeof
      // gdCourseBubbleSource === "function"`, which was always false while this
      // stayed inside the IIFE - so the Course Bubble value read "Bubble not
      // ready" no matter how good the fit was.
      gdCourseBubbleSource:gdCourseBubbleSource,
      gdSetPracticeDataTab:gdSetPracticeDataTab,
      gdTogglePracticeAdmin:gdTogglePracticeAdmin,
      gdOpenPracticeAdminTab:gdOpenPracticeAdminTab,
      gdPracticePreviewToleranceMaster:gdPracticePreviewToleranceMaster,
      gdPracticeSetToleranceMaster:gdPracticeSetToleranceMaster,
      gdDataHubCourseAction:gdDataHubCourseAction,
      gdDataHubPracticeAction:gdDataHubPracticeAction,
      gdHubSetSection:gdHubSetSection,
      gdInitDataHubAccordion:gdInitDataHubAccordion,
      gdCompareSetSource:gdCompareSetSource,
      gdPracticeAddCustomGate:gdPracticeAddCustomGate,
      gdPracticeRemoveCustomGate:gdPracticeRemoveCustomGate,
      gdPracticeToggleCustomGate:gdPracticeToggleCustomGate,
      gdPracticeGateOpChanged:gdPracticeGateOpChanged,
      gdPracticeAddSourceTrust:gdPracticeAddSourceTrust,
      gdPracticeRemoveSourceTrust:gdPracticeRemoveSourceTrust,
      gdPracticeToggleSourceTrust:gdPracticeToggleSourceTrust,
      gdPracticeRescanSources:gdPracticeRescanSources,
	      gdOpenCompareData:openCompareData,
	      gdRenderPracticeData:renderPracticeData,
	      gdRenderCompareData:renderCompareData,
	      gdOffsetHubOverlayButton:gdOffsetHubOverlayButton,
	      gdSetShotBubbleOverlay:gdSetShotBubbleOverlay,
	      gdSyncShotBubbleOverlayControls:gdSyncShotBubbleOverlayControls,
		      gdCompareSetSource:gdCompareSetSource,
	      gdCompareSetClub:gdCompareSetClub,
	      gdCompareCourseControl:gdCompareCourseControl,
	      gdCompareSetConsistency:gdCompareSetConsistency,
	      gdCompareTogglePracticeAdmin:gdCompareTogglePracticeAdmin,
	      gdCompareSetPracticeToleranceMaster:gdCompareSetPracticeToleranceMaster,
      gdCompareSetPracticeToleranceField:gdCompareSetPracticeToleranceField,
      gdOpenCompareSourcePage:gdOpenCompareSourcePage,
      gdRenderDataHubStatus:renderDataHubStatus,
      gdCloseDataHubCompare:gdCloseDataHubCompare,
      gdToggleShotDataLibrary:gdToggleShotDataLibrary,
      gdToggleCourseImport:gdToggleCourseImport,
      gdTogglePracticeImport:gdTogglePracticeImport,
      gdPracticeEmailImportPending:gdPracticeEmailImportPending,
      gdTogglePracticePlot:gdTogglePracticePlot,
      gdToggleCoachSetBubble:gdToggleCoachSetBubble,
      gdCoachSetClubChanged:gdCoachSetClubChanged,
      gdCoachSetTogglePreview:gdCoachSetTogglePreview,
      gdCoachSetAdoptBubble:gdCoachSetAdoptBubble,
      gdCoachSetOpenBag:gdCoachSetOpenBag,
      gdPracticeCopyEmailAddress:gdPracticeCopyEmailAddress,
      gdPracticeRefreshEmailLane:gdPracticeRefreshEmailLane,
      gdPracticeLoadEmailPhotoBatch:gdPracticeLoadEmailPhotoBatch,
      gdPracticeApproveEmailSender:gdPracticeApproveEmailSender,
      gdPracticeSetPlotMode:gdPracticeSetPlotMode,
      gdPracticeImportCanStart:gdPracticeImportCanStart,
      gdPracticeStartImportJob:gdPracticeStartImportJob,
      gdPracticeUpdateImportJob:gdPracticeUpdateImportJob,
      gdPracticeClearImportJob:gdPracticeClearImportJob,
      gdPracticeCancelImportJob:gdPracticeCancelImportJob,
      gdPracticeHardStopScan:gdPracticeHardStopScan,
      gdPracticeToggleRawDetail:gdPracticeToggleRawDetail,
      gdPracticeToggleImportSelectMode:gdPracticeToggleImportSelectMode,
      gdPracticeToggleImportSelection:gdPracticeToggleImportSelection,
      gdPracticeDeleteSelectedImports:gdPracticeDeleteSelectedImports,
      gdPracticeDeleteImports:gdPracticeDeleteImports,
      gdPracticeClearLibraryForPlayer:gdPracticeClearLibraryForPlayer,
      gdNativePracticeFeedbackPatch:gdNativePracticeFeedbackPatch,
      // Three modules outside this file (Manual Practice, Projected Clubs, the
      // Shot Library sync) repaint the Practice screen through
      // window.renderPracticeData. It was never exposed, so all three silently
      // did nothing - the Manual Practice lane took taps and never redrew.
      renderPracticeData:renderPracticeData,
      gdRenderNativePracticeImportLane:gdRenderNativePracticeImportLane,
      gdParseNativePracticeImport:gdParseNativePracticeImport,
      gdNativePracticePasteChanged:gdNativePracticePasteChanged,
      gdNativePracticeTextFilePickerClicked:gdNativePracticeTextFilePickerClicked,
      gdClearNativePracticePaste:gdClearNativePracticePaste,
      gdSaveNativePracticeImport:gdSaveNativePracticeImport,
      gdRenderPracticeLiveDebugPanel:gdRenderPracticeLiveDebugPanel,
      gdPracticeDebugStartRun:gdPracticeDebugStartRun,
      gdPracticeDebugEnsureRun:gdPracticeDebugEnsureRun,
      gdPracticeDebugCheckpoint:gdPracticeDebugCheckpoint,
      gdPracticeDebugFailed:gdPracticeDebugFailed,
      gdPracticeDebugFinish:gdPracticeDebugFinish,
      gdPracticeReleaseProcessingControls:gdPracticeReleaseProcessingControls,
      gdPracticeDebugRecordButtonState:gdPracticeDebugRecordButtonState,
      gdPracticeDebugButtonSnapshot:gdPracticeDebugButtonSnapshot,
	      gdCopyPracticePhotoDebugJson:gdCopyPracticePhotoDebugJson,
      gdPracticeToggleProjector:gdPracticeToggleProjector,
	      gdPracticeSetPlotMode:gdPracticeSetPlotMode,
	      gdPracticeSetProjectionMode:gdPracticeSetProjectionMode,
	      gdPracticeSetProjectionOverlay:gdPracticeSetProjectionOverlay,
	      gdPracticeToggleProjectionOverlay:gdPracticeToggleProjectionOverlay,
	      gdPracticeToggleBagWidget:gdPracticeToggleBagWidget,
	      gdPracticeToggleBagScaleAll:gdPracticeToggleBagScaleAll,
	      gdPracticeSetProjectionSelectedClub:gdPracticeSetProjectionSelectedClub,
	      gdPracticeSetBagCarry:gdPracticeSetBagCarry,
		      gdPracticeResetBagDraft:gdPracticeResetBagDraft,
		      gdPracticeCommitBagDraft:gdPracticeCommitBagDraft,
		      gdPracticeAdoptBubbleAsPlayingBubble:gdPracticeAdoptBubbleAsPlayingBubble,
		      gdPracticeProjectionContext:gdPracticeProjectionContext,
	      gdPracticeProjectionRows:gdPracticeProjectionRows,
	      gdPracticeDisplayAnalysis:gdPracticeDisplayAnalysis,
	      gdPracticeProjectionReadyAnalysis:gdPracticeProjectionReadyAnalysis,
	      gdPracticeBubbleOffsetDeg:gdPracticeBubbleOffsetDeg,
	      gdPracticeHasBubbleOffset:gdPracticeHasBubbleOffset,
	      gdTogglePracticePlotAll:gdTogglePracticePlotAll,
	      gdPracticeSetSelectedPlotExcluded:gdPracticeSetSelectedPlotExcluded,
	      gdPracticeToggleEvidenceClub:gdPracticeToggleEvidenceClub,
	      gdPracticeSetEvidenceClubTab:gdPracticeSetEvidenceClubTab,
	      gdPracticeToggleEvidenceShot:gdPracticeToggleEvidenceShot,
	      gdPracticeSetEvidenceUploadSelection:gdPracticeSetEvidenceUploadSelection,
		      gdPracticeSetEvidenceClubSelection:gdPracticeSetEvidenceClubSelection,
		      gdPracticeClearEvidenceSelection:gdPracticeClearEvidenceSelection,
		      gdPracticeDeleteSelectedEvidenceShots:gdPracticeDeleteSelectedEvidenceShots,
		      gdPracticeToggleImportSelectMode:gdPracticeToggleImportSelectMode,
		      gdPracticeToggleImportSelection:gdPracticeToggleImportSelection,
		      gdPracticeDeleteImports:gdPracticeDeleteImports,
		      gdPracticeDeleteSelectedImports:gdPracticeDeleteSelectedImports,
		      gdPracticeClearLibraryForPlayer:gdPracticeClearLibraryForPlayer,
		      deletePracticeImport:deletePracticeImport,
		      deleteSelectedPracticeImports:deleteSelectedPracticeImports,
		      clearPracticeLibraryForPlayer:clearPracticeLibraryForPlayer,
		      gdShotBubbleLandingX:gdShotBubbleLandingX,
	      gdShotBubbleFrame:gdShotBubbleFrame,
	      gdShotBubbleEndpoint:gdShotBubbleEndpoint,
	      gdShotBubblePointFromEvidence:gdShotBubblePointFromEvidence,
	      gdShotBubbleSizeSource:gdShotBubbleSizeSource,
	      gdShotBubbleMedian:gdShotBubbleMedian,
	      gdShotBubbleBaseSvg:gdShotBubbleBaseSvg,
	      gdShotBubbleAimSvg:gdShotBubbleAimSvg,
	      gdShotBubbleHubSvg:gdShotBubbleHubSvg,
	      gdRenderBubbleOffsetHub:gdRenderBubbleOffsetHub,
      gdBubbleOffsetEdit:gdBubbleOffsetEdit,
      gdBubbleOffsetSave:gdBubbleOffsetSave,
      gdClearMyBubble:gdClearMyBubble,
      gdLoadPracticeDemo:loadPracticeDemo,
      gdClearPracticeData:clearPracticeData,
	      gdCanonicalShellBack:function(){return window.GDShell?.back?.({source:"legacy-canonical-back"});},
	      gdCanonicalShellHome:function(){return window.GDShell?.home?.();},
	      gdShellBackClick:function(event){event?.preventDefault?.();event?.stopPropagation?.();event?.stopImmediatePropagation?.();return window.GDShell?.back?.({event,source:"shell-back-click"});},
	      gdShellBackPointer:function(event){return window.GDShell?.backPointer?.(event);},
      gdOpenAdminSettings:openDeveloper,
      openStats:openDataHub,
      openDeveloperPanel:openDeveloper,
      openProfilePanel:openProfileStable,
      openBag:openBagStable,
      openSettings:openSettingsStable,
	      showShellHome:function(){return window.GDShell?.showHome?.({source:"legacy-show-shell-home"});},
	      showModeDashboard:function(){return window.GDShell?.showHome?.({source:"legacy-show-mode-dashboard"});},
	      shellBack:function(event){return window.GDShell?.back?.({event,source:"legacy-shell-back"});},
	      enterGpsModule:function(opts){return window.GDShell?.enterGps?.(opts||{});}
	    };
	    Object.keys(api).forEach(name=>safe(()=>{window[name]=api[name];}));
	    safe(()=>{openStats=openDataHub;openDeveloperPanel=openDeveloper;openProfilePanel=openProfileStable;openBag=openBagStable;openSettings=openSettingsStable;showShellHome=window.showShellHome;showModeDashboard=window.showModeDashboard;shellBack=window.shellBack;enterGpsModule=window.enterGpsModule;});
  }
	  function forceHomeFallback(){
	    if(Date.now()<Number(window.__gdBackPrelockPickerUntil||0)){
	      window.__gdBackPrelockPickerUntil=0;
	      return showCoursePickerStableBack("force-home-prelock-back");
	    }
	    clearCoursePickerOwnerState();
		    safe(()=>{document.body.classList.remove("gps-open","manual-gps-active","gdCapturedHoleFrameCameraOn","gdHoleImageCameraOn","gdMappedStartPromptActive","gdMappedCourseMode","gdMappedSnapCameraActive","gdCourseOpening","gdToolRailOpen","gdGreenArrivalMode","gd-green-zoom-active","gdLockStateFrameActive","gd-frame-hard-locked")});
    safe(()=>{window.GDShell?.showHome?.({source:"route-audit-force-home",replace:true});document.body.classList.add("gdToolRailEmpty")});
    safe(()=>{const h=byId("shellHome");if(h){h.classList.remove("hidden");h.style.display="";h.style.visibility="";h.style.opacity=""}});
    safe(()=>{const c=byId("courseScreen");if(c){c.classList.add("hidden");c.style.display="none";c.style.visibility="hidden";c.style.opacity="0";c.style.pointerEvents="none"}});
    safe(()=>{const hint=byId("hint");if(hint){hint.classList.remove("visible","gdMappedStartPill");hint.textContent=""}});
    safe(()=>{const appEl=byId("app");if(appEl)appEl.classList.remove("framed","gdPreLockFrame")});
    return false;
  }
  function wireClicks(){
    function bindDirect(selector,handler){
	      document.querySelectorAll(selector).forEach(el=>{
	        if(el.dataset.gdDirectRouteBound==="1")return;
	        el.dataset.gdDirectRouteBound="1";
	        el.addEventListener("click",function(event){
	          if(event?.target?.closest?.("[data-gd-card-control]"))return;
	          event?.preventDefault?.();
          event?.stopPropagation?.();
          event?.stopImmediatePropagation?.();
          return handler(event);
        },true);
      });
    }
    bindDirect(".gdBubbleTile,#dockBubble",()=>openBubbleStable());
    bindDirect("#dockGps",event=>openGpsStable({replace:false,fromHome:!!event?.target?.closest?.("#gdV62Home")}));
    bindDirect(".gdBagTile,#dockBag,[onclick*='openBag']",event=>{
      const gpsContext=document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
      const homeContext=document.body.classList.contains("shell-home")||!!event?.target?.closest?.("#gdV62Home");
      return openBagStable({fromGps:gpsContext&&!homeContext,fromHome:homeContext||!gpsContext});
    });
    bindDirect(".gdProfileTile",event=>{
      const gpsContext=document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
      const homeContext=document.body.classList.contains("shell-home")||!!event?.target?.closest?.("#gdV62Home");
      return openProfileStable({fromGps:gpsContext&&!homeContext,fromHome:homeContext||!gpsContext,replace:homeContext});
    });
    bindDirect("#gdCourseDataOpenBtn",()=>gdHubSetSection("course"));
    bindDirect("#gdPracticeDataOpenBtn",()=>gdHubSetSection("practice"));
    bindDirect("#gdCompareDataOpenBtn",()=>gdHubSetSection("compare"));
    bindDirect("#gdPracticeAdminTabBtn",()=>gdTogglePracticeAdmin());
    bindDirect("[onclick*='gdBubbleOffsetEdit']",()=>gdBubbleOffsetEdit());
    bindDirect("[onclick*='gdBubbleOffsetSave']",()=>gdBubbleOffsetSave());
    const practiceMaster=byId("gdPracticeToleranceMaster");
    if(practiceMaster){
      practiceMaster.oninput=function(){gdPracticePreviewToleranceMaster(practiceMaster);};
      practiceMaster.onchange=function(){gdPracticeSetToleranceMaster(practiceMaster.value);};
    }
    document.querySelectorAll(".gdBubbleFaceOffsetInput").forEach(input=>{
      input.onclick=function(){if(input.readOnly)gdBubbleOffsetEdit();};
      input.onfocus=function(){if(input.readOnly)gdBubbleOffsetEdit();};
      input.oninput=function(){gdRenderBubbleOffsetHub(true);};
    });
	    const homeBtn=byId("shellHomeBtn");
	    const backBtn=byId("shellBackBtn");
	    const profileBtn=byId("shellProfileReturnBtn");
	    const settingsBtn=byId("shellSettingsBtn");
		    safe(()=>window.GDShell?.init?.());
	    document.addEventListener("click",event=>{
	      const target=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-club-toggle]");
	      if(!target)return;
	      event.preventDefault();
	      event.stopImmediatePropagation();
	      gdPracticeToggleEvidenceClub(target);
	    },true);
	    if(!window.__gdPracticeProjectionControlsBound){
	      window.__gdPracticeProjectionControlsBound=true;
	      document.addEventListener("click",event=>{
          const evidenceClubTab=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-evidence-tab]");
          if(evidenceClubTab){
            event.preventDefault();
            event.stopImmediatePropagation();
            return gdPracticeSetEvidenceClubTab(evidenceClubTab.dataset.gdPracticeEvidenceClubTab||"");
          }
          const sandboxAction=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-sandbox-action]");
          if(sandboxAction){
            event.preventDefault();
            event.stopImmediatePropagation();
            const action=sandboxAction.dataset.gdPracticeSandboxAction||"";
            if(action==="simulate")return gdPracticeSimulateSandboxImport(sandboxAction.dataset.gdPracticeSandboxScenario||"ready");
            if(action==="load")return gdPracticeLoadSandboxNativeRows(sandboxAction.dataset.gdPracticeSandboxScenario||"ready");
            if(action==="clear")return gdPracticeClearSandboxData();
            if(action==="bag")return gdPracticeSetSandboxBag(sandboxAction.dataset.gdPracticeSandboxMode||"matched");
            return false;
          }
	        const projectorToggle=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-projector-toggle]");
	        if(projectorToggle){
	          event.preventDefault();
	          event.stopImmediatePropagation();
	          return gdPracticeToggleProjector();
	        }
	        const bagToggle=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-bag-toggle]");
	        if(bagToggle){
	          event.preventDefault();
	          event.stopImmediatePropagation();
	          return gdPracticeToggleBagWidget();
	        }
	        const bagAction=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-bag-action]");
	        if(bagAction){
	          event.preventDefault();
	          event.stopImmediatePropagation();
	          const action=bagAction.dataset.gdPracticeBagAction||"";
	          if(action==="scale")return gdPracticeToggleBagScaleAll();
	          if(action==="reset")return gdPracticeResetBagDraft();
	          if(action==="back"){gdPracticeBagWidgetConfirm=false;return gdPracticeRefreshProjectionSurfaces();}
	          if(action==="save")return gdPracticeCommitBagDraft();
	          return false;
	        }
	        const bagClub=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-bag-club]");
	        if(bagClub){
	          event.preventDefault();
	          event.stopImmediatePropagation();
	          return gdPracticeSetProjectionSelectedClub(bagClub.dataset.gdPracticeBagClub||"");
	        }
	        const projection=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-projection-mode]");
	        if(projection){
	          event.preventDefault();
	          event.stopImmediatePropagation();
	          if(projection.disabled)return false;
	          return gdPracticeSetProjectionMode(projection.dataset.gdPracticeProjectionMode||"all");
	        }
	        const overlay=event.target&&event.target.closest&&event.target.closest("[data-gd-overlay-control='practice']");
	        if(!overlay)return;
	        event.preventDefault();
	        event.stopImmediatePropagation();
	        return gdPracticeToggleProjectionOverlay();
	      },true);
	      document.addEventListener("change",event=>{
	        const input=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-bag-carry]");
	        if(!input)return;
	        event.preventDefault();
	        event.stopImmediatePropagation();
	        return gdPracticeSetBagCarry(input.dataset.gdPracticeBagCarry||"",input.value);
	      },true);
	      document.addEventListener("keydown",event=>{
	        const input=event.target&&event.target.closest&&event.target.closest("[data-gd-practice-bag-carry]");
	        if(!input||event.key!=="Enter")return;
	        event.preventDefault();
	        event.stopImmediatePropagation();
	        gdPracticeSetBagCarry(input.dataset.gdPracticeBagCarry||"",input.value);
	        input.blur?.();
	        return false;
	      },true);
	    }
	    document.addEventListener("click",event=>{
	      if(event.target?.closest?.("[data-gd-card-control]"))return;
	      const target=event.target&&event.target.closest&&event.target.closest(
		        "#dockAdmin,#dockBag,#dockGps,#dockBubble,#gdCourseDataOpenBtn,#gdPracticeDataOpenBtn,#gdCompareDataOpenBtn,.gdPlayTile,.gdBubbleTile,.gdBagTile,.gdProfileTile,[onclick*='enterGpsModule'],[onclick*='openDeveloperPanel'],[onclick*='openBag'],[onclick*='openStats'],[onclick*='gdBubbleOffsetEdit'],[onclick*='gdBubbleOffsetSave']"
	      );
      if(!target)return;
      const on=(target.getAttribute("onclick")||"");
      if(target.classList.contains("gdPlayTile"))return;
	      const gpsContext=document.body.classList.contains("shell-gps")||document.body.classList.contains("gdGpsActive")||document.body.classList.contains("gps-active");
      const homeContext=document.body.classList.contains("shell-home")||!!target.closest("#gdV62Home");
      if(target.id==="dockAdmin"||on.includes("openDeveloperPanel")){event.preventDefault();event.stopImmediatePropagation();openDeveloper({fromGps:gpsContext&&!homeContext,fromHome:homeContext||!gpsContext});return;}
      if(target.id==="dockBag"||target.classList.contains("gdBagTile")||on.includes("openBag")){event.preventDefault();event.stopImmediatePropagation();openBagStable({fromGps:gpsContext&&!homeContext,fromHome:homeContext||!gpsContext});return;}
	      if(target.id==="dockGps"||target.classList.contains("gdPlayTile")||on.includes("enterGpsModule")){
	        event.preventDefault();
	        event.stopImmediatePropagation();
	        return openGpsStable({replace:false,fromHome:homeContext});
	      }
      if(target.id==="dockBubble"||target.classList.contains("gdBubbleTile")){event.preventDefault();event.stopImmediatePropagation();openBubbleStable();return;}
      if(target.id==="gdCourseDataOpenBtn"){event.preventDefault();event.stopImmediatePropagation();if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("courseData"))return;gdHubSetSection("course");return;}
      if(target.id==="gdPracticeDataOpenBtn"){event.preventDefault();event.stopImmediatePropagation();if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("practiceData"))return;gdHubSetSection("practice");return;}
      if(target.id==="gdCompareDataOpenBtn"){event.preventDefault();event.stopImmediatePropagation();if(window.gdAuthGateAllows&&!window.gdAuthGateAllows("shotData"))return;gdHubSetSection("compare");return;}
      if(on.includes("gdBubbleOffsetEdit")){event.preventDefault();event.stopImmediatePropagation();gdBubbleOffsetEdit();return;}
      if(on.includes("gdBubbleOffsetSave")){event.preventDefault();event.stopImmediatePropagation();gdBubbleOffsetSave();return;}
      if(target.classList.contains("gdProfileTile")){
        event.preventDefault();
        event.stopImmediatePropagation();
        openProfileStable({fromGps:gpsContext&&!homeContext,fromHome:homeContext||!gpsContext,replace:homeContext});
        return;
      }
      if(on.includes("openStats")){event.preventDefault();event.stopImmediatePropagation();openDataHub();return;}
    },true);
    document.addEventListener("input",event=>{
      const target=event.target&&event.target.closest&&event.target.closest(".gdBubbleFaceOffsetInput");
      if(!target)return;
      gdRenderBubbleOffsetHub(true);
    },true);
  }
  expose();
  wireClicks();
  gdInstallBrowserRouteBridge();
  document.documentElement.setAttribute("data-gd-route-wired","1");
  setTimeout(()=>{safe(()=>expose());safe(()=>wireClicks());safe(()=>typeof gdRefreshPermissionChrome==="function"&&gdRefreshPermissionChrome());safe(()=>renderDataHubStatus());safe(()=>renderPracticeData());},250);
  setTimeout(()=>{safe(()=>expose());safe(()=>wireClicks());safe(()=>typeof gdRefreshPermissionChrome==="function"&&gdRefreshPermissionChrome());},1200);
	  function gdOpenShotBubbleDemoPreview(){
	    return false;
	  }
})();
