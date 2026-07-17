/* Extracted verbatim from an inline <script> block in index.html (split-03). */
/* --- Clarity Caddy Play Button Rescue v1 ---
   Keeps Wand untouched. Fixes home/play route after a prior Wand edit left a script fragment broken.
   Any Play/Open GPS/GPS Module tile now reliably enters the GPS/course picker. */
(function(){
  function qs(id){ return document.getElementById(id); }
  function show(el,on){ if(el) el.classList.toggle('hidden', !on); }
  function closePanels(){
    try{ document.querySelectorAll('.modulePanel.open,.panel.open').forEach(function(p){ p.classList.remove('open'); }); }catch(e){}
    try{ qs('gdProfileV67')?.classList.add('hidden'); document.body.classList.remove('gdProfileOpen'); }catch(e){}
    try{ qs('gdWandPanel')?.classList.add('hidden'); }catch(e){}
  }
  function setGpsClasses(){
    try{ document.body.classList.add('gdGpsActive','gps-active'); }catch(e){}
    try{ document.body.classList.remove('shell-home','shell-module'); document.body.classList.add('shell-gps'); }catch(e){}
  }
  function showShellGpsChrome(){
    try{ qs('shellHome')?.classList.add('hidden'); }catch(e){}
    try{ qs('shellTop')?.classList.add('visible'); }catch(e){}
    try{ qs('shellDock')?.classList.add('visible'); }catch(e){}
    try{ if(typeof setDockActive==='function') setDockActive('gps'); }catch(e){}
    try{ if(typeof pushShellRoute==='function') pushShellRoute('gps'); }catch(e){}
  }
  function revealCoursePicker(){
    var cs=qs('courseScreen');
    if(cs){ cs.classList.remove('hidden'); cs.style.display='flex'; cs.style.pointerEvents='auto'; }
  }
  function refreshMapSoon(){
    try{ if(window.map && map.invalidateSize){ setTimeout(function(){map.invalidateSize();},80); setTimeout(function(){map.invalidateSize();},260); } }catch(e){}
  }
  function rescueActiveCourse(){
    try{if(typeof currentCourse!=="undefined"&&currentCourse&&currentCourse.name)return currentCourse;}catch(e){}
    try{var raw=JSON.parse(localStorage.getItem("gd_active_course_v1")||"null");if(raw&&raw.name)return raw;}catch(e){}
    try{var name=String(qs("courseLine")?.textContent||"").trim();if(name&&!/^manual gps$/i.test(name))return {name:name,courseName:name,courseId:name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")};}catch(e){}
    return null;
  }
  function rescueIsManualCourse(course){
    try{if(typeof gdCoursePayloadIsManual==="function")return gdCoursePayloadIsManual(course);}catch(e){}
    return /^manual gps$/i.test(String(course?.name||course?.courseName||""));
  }
  function rescueForceHoleOne(course){
    if(!course||rescueIsManualCourse(course))return false;
    try{if(typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset())return false;}catch(e){}
    try{selectedHole=1;currentPlayingHole=1;}catch(e){}
    try{sessionStorage.setItem("gd_active_playing_hole","1");sessionStorage.setItem("gd_mapper_active_hole","1");}catch(e){}
    try{document.body.classList.add("gdMappedCourseMode");document.body.classList.remove("manual-gps-active");}catch(e){}
    try{if(typeof setHole==="function")setHole({hole:1});}catch(e){}
    try{mode="start";}catch(e){}
    try{if(typeof setState==="function")setState("Mapped: set position");}catch(e){}
    try{
      var h=qs("hint");
      if(h){
        h.classList.add("gdMappedStartPill","visible");
        if(typeof gdRenderMappedStartHint==="function")gdRenderMappedStartHint(h);
        else h.innerHTML='<button class="gdMappedStartAction" type="button" data-gd-mapped-start-action="manual">Set Start Point</button><button class="gdMappedStartAction gdHeadToTee" type="button" data-gd-mapped-start-action="tee">Head To the Tee</button>';
        if(typeof gdQueueMappedPreLockHoleFrame==="function")gdQueueMappedPreLockHoleFrame();
      }
    }catch(e){}
    return true;
  }
  function rescueScheduleHoleOne(){
    [220,760,1500,2600].forEach(function(delay){
      setTimeout(function(){
        try{if(typeof gdShouldSkipMappedHoleOneReset==="function"&&gdShouldSkipMappedHoleOneReset())return;}catch(e){}
        var cs=qs("courseScreen");
        var pickerOpen=cs&&!cs.classList.contains("hidden")&&getComputedStyle(cs).display!=="none"&&getComputedStyle(cs).visibility!=="hidden";
        if(pickerOpen)return;
        var course=rescueActiveCourse();
        if(!course||rescueIsManualCourse(course))return;
        try{
          if(typeof window.gdScheduleCoursePickerFirstHoleOpen==="function")window.gdScheduleCoursePickerFirstHoleOpen(course);
          else if(typeof window.gdOpenCourseToFirstHole==="function")window.gdOpenCourseToFirstHole(course);
        }catch(e){}
      },delay);
    });
  }
  function enterGps(opts){
    opts=opts||{};
    closePanels();
    setGpsClasses();
    showShellGpsChrome();
    revealCoursePicker();
    refreshMapSoon();
    try{ localStorage.setItem('gd_last_module','gps'); }catch(e){}
    rescueScheduleHoleOne();
  }
  function runPlayRoute(opts){
    opts=opts||{};
    try{
      const current=window.enterGpsModule;
      if(typeof current==="function"&&current!==enterGps)return current.call(window,opts);
    }catch(e){}
    const result=enterGps(opts);
    rescueScheduleHoleOne();
    return result;
  }
  window.enterGpsModule = enterGps;
  window.gdEnterPlay = runPlayRoute;
  window.gdOpenGpsModule = runPlayRoute;
  window.startPlay = runPlayRoute;

  function labelOf(el){ return ((el.getAttribute('aria-label')||'')+' '+(el.title||'')+' '+(el.textContent||'')).toLowerCase().replace(/\s+/g,' ').trim(); }
  function isPlayButton(el){
    if(!el || el.__gdPlayRescueBound) return false;
    if(el.closest&&el.closest('#courseScreen')) return false;
    var t=labelOf(el);
    if(!t) return false;
	    return t==='play' || t.indexOf('clarity caddy')>=0 || t.indexOf('open gps')>=0 || t.indexOf('gps module')>=0 || t.indexOf('player mode')>=0 || t.indexOf('start manual')>=0 || t.indexOf('continue a round')>=0;
  }
  function bindPlayButtons(){
    try{
      document.querySelectorAll('button,.shellTile,[data-action],[role="button"]').forEach(function(el){
        if(!isPlayButton(el)) return;
        el.__gdPlayRescueBound=true;
        el.addEventListener('click',function(ev){
          ev.preventDefault(); ev.stopPropagation();
          runPlayRoute({fromPlay:true});
        },true);
      });
    }catch(e){}
  }
	  bindPlayButtons();
	  setTimeout(bindPlayButtons,120);
	  setTimeout(bindPlayButtons,600);
	  document.addEventListener('DOMContentLoaded',function(){ bindPlayButtons(); setTimeout(bindPlayButtons,120); setTimeout(bindPlayButtons,600); });
	  window.addEventListener('load',function(){ bindPlayButtons(); setTimeout(bindPlayButtons,500); });
  window.gdBindPlayButtons = bindPlayButtons;
})();


function gdGoToPlayManualRound(){
  try{
    if(typeof unlockShotFrame === "function") unlockShotFrame("manual-round");
  }catch(e){}
  try{
    if(typeof enterTwoTapMode === "function"){ enterTwoTapMode(); return; }
  }catch(e){}
  try{
    if(typeof setGpsMode === "function"){ setGpsMode("twoTap"); }
  }catch(e){}
  try{
    if(typeof showScreen === "function"){ showScreen("gps"); }
    else if(typeof showView === "function"){ showView("gps"); }
    else if(typeof navigateTo === "function"){ navigateTo("gps"); }
  }catch(e){}
  try{
    document.body.classList.remove("show-course-search","course-search-open","search-open");
    document.body.classList.add("gps-open");
  }catch(e){}
  try{
    const gps=document.getElementById("gpsScreen")||document.getElementById("gpsView")||document.getElementById("playScreen");
    if(gps) gps.style.display="";
    const home=document.getElementById("homeScreen")||document.getElementById("homeView");
    if(home) home.style.display="none";
  }catch(e){}
}



(function(){
  function wireManualRound(){
    const candidates=[...document.querySelectorAll("button,a,[role='button'],.tile,.home-tile")].filter(el=>{
      const t=(el.textContent||"").toLowerCase();
      const id=((el.id||"")+" "+(el.className||"")+" "+(el.getAttribute("data-action")||"")+" "+(el.getAttribute("data-route")||"")).toLowerCase();
      return t.includes("manual round") || id.includes("manualround") || id.includes("manual-round");
    });
    candidates.forEach(el=>{
      el.addEventListener("click", function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        gdGoToPlayManualRound();
      }, true);
    });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", wireManualRound);
  else wireManualRound();
})();



function gdStartManualGpsFromSearchOverlay(){
  try{
    // Close course/search overlay without resetting the map.
    document.body.classList.remove(
      "show-course-search",
      "course-search-open",
      "search-open",
      "course-picker-open",
      "finding-course"
    );
    document.body.classList.add("gps-open", "manual-gps-active");
  }catch(e){}

  try{
    const overlays=[...document.querySelectorAll(".course-search,.course-search-overlay,.course-picker,.find-course,.search-panel,.course-modal,[data-course-search],[data-course-picker]")];
    overlays.forEach(el=>{
      el.style.display="none";
      el.classList.remove("open","active","visible","show");
    });
  }catch(e){}

  try{
    if(typeof unlockShotFrame === "function") unlockShotFrame("manual-gps-play");
  }catch(e){}

  try{
    if(typeof clearLockedShotState === "function") clearLockedShotState("manual-gps-play");
  }catch(e){}

  try{
    if(typeof enterTwoTapMode === "function"){ enterTwoTapMode(); }
    else if(typeof setGpsMode === "function"){ setGpsMode("twoTap"); }
  }catch(e){}

  try{
    if(typeof showScreen === "function") showScreen("gps");
    else if(typeof showView === "function") showView("gps");
    else if(typeof navigateTo === "function") navigateTo("gps");
  }catch(e){}

  try{
    const manualButtons=[...document.querySelectorAll("button,a,[role='button']")].filter(el=>{
      const text=(el.textContent||"").trim().toLowerCase();
      const card=(el.closest(".manual-gps,.manualGPS,.manual-card,.course-result,.find-course,.course-search,.course-picker")||{}).textContent||"";
      return text==="play" && card.toLowerCase().includes("manual gps");
    });
    manualButtons.forEach(el=>el.classList.add("manual-gps-play-wired"));
  }catch(e){}
}

function gdWireManualGpsPlayButton(){
  const candidates=[...document.querySelectorAll("button,a,[role='button']")].filter(el=>{
    const label=(el.textContent||"").trim().toLowerCase();
    if(label!=="play") return false;
    const parentText=(el.closest("div,section,article,li")||{}).textContent || "";
    const widerText=(el.closest(".course-search,.course-picker,.find-course,.course-modal,.sheet,.panel")||{}).textContent || "";
    return parentText.toLowerCase().includes("manual gps") || widerText.toLowerCase().includes("manual gps");
  });

  candidates.forEach(el=>{
    if(el.dataset.gdManualGpsWired==="1") return;
    el.dataset.gdManualGpsWired="1";
    el.addEventListener("click", function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      gdStartManualGpsFromSearchOverlay();
    }, true);
  });
}

(function(){
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", gdWireManualGpsPlayButton);
  else gdWireManualGpsPlayButton();
  setTimeout(gdWireManualGpsPlayButton, 250);
  setTimeout(gdWireManualGpsPlayButton, 1000);
})();



(function(){
  function gdManualGpsButtonHardWire(){
    var btns=[].slice.call(document.querySelectorAll('#courseScreen .course .play'));
    btns.forEach(function(btn){
      var card=btn.closest('.course');
      if(!card || !/Manual GPS/i.test(card.textContent||'')) return;
      if(btn.dataset.gdHardManualPlay==='1') return;
      btn.dataset.gdHardManualPlay='1';
      btn.addEventListener('click', function(ev){
        ev.preventDefault();
        ev.stopPropagation();
        if(ev.stopImmediatePropagation) ev.stopImmediatePropagation();
        openCourse({name:'Manual GPS'});
        return false;
      }, true);
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', gdManualGpsButtonHardWire);
  else gdManualGpsButtonHardWire();
  setTimeout(gdManualGpsButtonHardWire,100);
  setTimeout(gdManualGpsButtonHardWire,600);
  setTimeout(gdManualGpsButtonHardWire,1600);
})();
