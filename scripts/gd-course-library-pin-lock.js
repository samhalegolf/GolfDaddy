/* Clarity Caddie Personal Course Library + Pin-Lock MVP v1 */
(function(){
  'use strict';

  const STORE_KEY='gd_user_course_library_v1';
  const PUBLISHED_STORE_KEY='gd_published_course_library_v1';
  const PUBLISHED_COURSE_API='/api/course-maps';
  const PUBLISHED_ADMIN_EMAILS=['samhalegolf@gmail.com','admin@clarity.local'];
  let applyingSavedGreen=false;
  let pinLockRegion={x:0,y:0};
  let profileObserver=null;
  let mapperRailObserver=null;
  let mapperCaptureCancel=null;
  let mapperCaptureTool=null;
	  let mapperOsmGuideFetch=null;
	  let mapperOsmGuideMemory=null;
	  let mapperOsmGuideUserChoice=false;
	  let mapperOsmAutoMapRunKey=null;
  let mapperPreviousMapSourceIndex=null;
  let courseLibraryFilter='';
  let courseLibraryDetailTab='greens';
  let courseFinderLayer=null;
  let mappedPlayAssist={armed:false,hole:null,courseKey:null,locked:false,lastFrameAt:0};
  let mappedFrameRunId=0;
  let mappedLockRunId=0;
  let mappedDropoutNotice={key:'',at:0};
  const mapperObjectLayers=[];
  const mapperGuideLayers=[];
  const ASSUMED_COURSE_MATCH_RADIUS_M=4000;
  const MAPPED_PLAY_TEE_LOCK_RADIUS_M=70;
  const MAPPED_PLAY_MODE_KEY='gd_mapped_play_mode_v1';
  const MAPPED_PLAY_MODE_PREFIX='gd_mapped_play_mode_course_v1:';
  const OSM_HOLE_GUIDE_CACHE_PREFIX='gd_osm_hole_guides_v1:';
  const OSM_HOLE_GUIDE_CACHE_MAX_AGE_MS=1000*60*60*24*30;
  const OBJECT_DEDUPE_RADIUS_M={green:26,bunker:14,tee:9,fairway:12,default:10};
  const OSM_AUTO_GREEN_MATCH_RADIUS_M=95;
  const OSM_AUTO_GREEN_MAX_SPAN_M=145;
  const BUILT_IN_COURSE_CANDIDATES=[
    {courseName:'Akarana Golf Club',courseId:'akarana-golf-club',courseLat:-36.9174953,courseLng:174.7400425,source:'built-in-course'},
    {courseName:'Maungakiekie Golf Club',courseId:'maungakiekie-golf-club',courseLat:-36.9229754,courseLng:174.7254871,source:'built-in-course',aliases:['maungakeikei','maunga']},
    {courseName:'Windross Farm Golf Course',courseId:'windross-farm-golf-course',source:'built-in-course',aliases:['windross','windross farm']}
  ];
  function stopMappedMapMotion(){
    try{if(typeof map!=='undefined'&&map&&typeof map.stop==='function')map.stop();}catch(e){}
  }
  function nextMappedFrameRun(){
    mappedFrameRunId++;
    return mappedFrameRunId;
  }
  function nextMappedLockRun(){
    mappedLockRunId++;
    return mappedLockRunId;
  }
  function mappedFrameRunActive(runId){
    return runId===mappedFrameRunId&&mappedCourseAssistEnabled()&&!window.gdFullMappingMode;
  }
  function mappedLockRunActive(runId){
    return runId===mappedLockRunId&&mappedCourseAssistEnabled()&&!window.gdFullMappingMode;
  }
  function cancelMappedPlayAsync(reason='cancel'){
    mappedFrameRunId++;
    mappedLockRunId++;
    try{window.gdMappedGreenAutoLockedUntil=0;}catch(e){}
    stopMappedMapMotion();
    return {reason,frameRunId:mappedFrameRunId,lockRunId:mappedLockRunId};
  }
  function scheduleMappedFrameTask(runId,delay,fn){
    setTimeout(()=>{if(mappedFrameRunActive(runId))fn();},delay);
  }
  function scheduleMappedLockTask(runId,delay,fn){
    setTimeout(()=>{if(mappedLockRunActive(runId))fn();},delay);
  }
  window.gdCancelMappedPlayAsync=cancelMappedPlayAsync;

  function toastSafe(msg){try{if(typeof toast==='function')toast(msg);}catch(e){}}
  function hintSafe(msg){try{if(typeof showHint==='function')showHint(msg);}catch(e){}}
  function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function slug(s){return String(s||'item').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'item';}
  function normalizeCourseName(s){
    const cleaned=String(s||'').replace(/\b(golf club|golf course|country club|gc|course|club|cub)\b/gi,' ').replace(/\s+/g,' ').trim();
    return cleaned?slug(cleaned):'';
  }
  function nowIso(){return new Date().toISOString();}
  function dateLabel(v){
    const d=new Date(v||Date.now());
    return Number.isNaN(d.getTime())?'today':d.toLocaleDateString();
  }
  function setMapperContext(value){
    window.gdMapperToolContext=value||'';
    try{
      if(value)sessionStorage.setItem('gd_mapper_tool_context',value);
      else sessionStorage.removeItem('gd_mapper_tool_context');
    }catch(e){}
  }
  function mapperContext(){
    try{return window.gdMapperToolContext||sessionStorage.getItem('gd_mapper_tool_context')||'';}catch(e){return window.gdMapperToolContext||'';}
  }
  function toPlain(ll){return ll?{lat:Number(ll.lat),lng:Number(ll.lng)}:null;}
  function toLatLng(v){try{return v?L.latLng(Number(v.lat),Number(v.lng)):null;}catch(e){return null;}}
  function holeNumber(){try{return Number(currentPlayingHole||selectedHole||1)||1;}catch(e){return 1;}}
  function validHoleNumber(value){
    const h=Number(value);
    return Number.isFinite(h)&&h>=1&&h<=36?h:null;
  }
  function activePlayingHole(){
    try{
      const live=validHoleNumber(currentPlayingHole);
      if(live)return live;
    }catch(e){}
    try{
      const mapper=validHoleNumber(sessionStorage.getItem('gd_mapper_active_hole'));
      if(mapper)return mapper;
    }catch(e){}
    try{
      const saved=validHoleNumber(sessionStorage.getItem('gd_active_playing_hole'));
      if(saved)return saved;
    }catch(e){}
    return null;
  }
  function rememberPlayingHole(hole){
    const h=validHoleNumber(hole);
    if(!h)return null;
    try{currentPlayingHole=h;}catch(e){}
    try{selectedHole=h;}catch(e){}
    try{window.gdMapperActiveHole=h;}catch(e){}
    try{sessionStorage.setItem('gd_active_playing_hole',String(h));}catch(e){}
    try{sessionStorage.setItem('gd_mapper_active_hole',String(h));}catch(e){}
    updateMapperHoleUi();
    updateMapperToolCompletion();
    return h;
  }
  function mapperHole(){
    try{return validHoleNumber(sessionStorage.getItem('gd_mapper_active_hole'))||activePlayingHole()||holeNumber()||1;}catch(e){return activePlayingHole()||holeNumber()||1;}
  }
  function setMapperHole(hole){
    return rememberPlayingHole(validHoleNumber(hole)||1);
  }
  function bumpMapperHole(delta){
    const current=mapperHole();
    const next=Math.max(1,Math.min(18,current+Number(delta||0)));
    if(window.gdFullMappingMode){
      selectMapperHoleFromStrip(next);
      return;
    }
    setMapperHole(next);
    toastSafe(`Mapping hole ${next}`);
  }
  function profile(){try{return typeof activePlayerProfile==='function'?activePlayerProfile():null;}catch(e){return null;}}
  function userId(){const p=profile();return 'user-'+slug(p?.id||p?.name||'local-player');}
  function courseObj(){try{return currentCourse||null;}catch(e){return null;}}
  function rawCourseName(course=courseObj()){return String(course?.name||'Manual GPS');}
  function isManualGpsCourse(course=courseObj()){return /^manual gps$/i.test(rawCourseName(course).trim());}
  function isAssumedCourseName(name){
    return /^assumed (golf )?course\b/i.test(String(name||'').trim());
  }
  function isUsefulCourseName(name){
    const clean=String(name||'').trim();
    return !!(clean&&!/^manual gps$/i.test(clean)&&!isAssumedCourseName(clean));
  }
  function mapSessionCenter(course=courseObj()){
    const c=course||{};
    if(isManualGpsCourse(c)){
      try{if(start)return toPlain(start);}catch(e){}
      try{if(typeof map!=='undefined'&&map&&typeof map.getCenter==='function')return toPlain(map.getCenter());}catch(e){}
    }
    const lat=Number(c.lat??c.latitude), lng=Number(c.lng??c.longitude);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return {lat,lng};
    try{if(start)return toPlain(start);}catch(e){}
    try{if(typeof map!=='undefined'&&map&&typeof map.getCenter==='function')return toPlain(map.getCenter());}catch(e){}
    return {lat:-36.9149,lng:174.7255};
  }
  function assumedCourseLabel(center=mapSessionCenter()){
    const lat=Number(center?.lat), lng=Number(center?.lng);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return `Assumed course ${lat.toFixed(2)}, ${lng.toFixed(2)}`;
    return 'Assumed golf course';
  }
  function assumedCourseId(center=mapSessionCenter()){
    const lat=Number(center?.lat), lng=Number(center?.lng);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return `assumed-course-${lat.toFixed(2)}-${lng.toFixed(2)}`;
    return 'assumed-golf-course';
  }
  function courseCandidateName(course){
    return String(course?.courseName||course?.name||'').trim();
  }
  function courseCandidatePoint(course){
    const lat=Number(course?.courseLat??course?.lat??course?.latitude??course?.finderLat??course?.courseFinderLat);
    const lng=Number(course?.courseLng??course?.lng??course?.longitude??course?.finderLng??course?.courseFinderLng);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
  }
  function savedCourseCandidates(){
    const store=loadStore();
    const uid=userId();
    return Object.values(store.courses||{})
      .filter(course=>course.userId===uid)
      .map(course=>{
        const name=courseCandidateName(course);
        const point=courseCandidatePoint(course);
        if(!isUsefulCourseName(name)||!point)return null;
        return {
          name,
          courseName:name,
          courseId:slug(course.courseId||course.id||name),
          courseLat:point.lat,
          courseLng:point.lng,
          finderLat:Number(course.finderLat??course.courseFinderLat)||null,
          finderLng:Number(course.finderLng??course.courseFinderLng)||null,
          source:'saved-course'
        };
      })
      .filter(Boolean);
  }
  function knownCourseCandidates(){
    return BUILT_IN_COURSE_CANDIDATES.map(course=>({
      name:course.courseName,
      courseName:course.courseName,
        courseId:course.courseId||slug(course.courseName),
        courseLat:course.courseLat,
        courseLng:course.courseLng,
        finderLat:course.finderLat||course.courseFinderLat||null,
        finderLng:course.finderLng||course.courseFinderLng||null,
        source:course.source||'known-course'
      }));
  }
  function nearbyKnownCourses(center=mapSessionCenter(),maxDistance=ASSUMED_COURSE_MATCH_RADIUS_M){
    if(!center)return null;
    const seen=new Set();
    return knownCourseCandidates()
      .map(course=>{
        const name=courseCandidateName(course);
        const point=courseCandidatePoint(course);
        const key=normalizeCourseName(name)||slug(course.courseId||name);
        if(!name||!point||seen.has(key))return null;
        seen.add(key);
        return {
          name,
          courseName:name,
          courseId:course.courseId||slug(name),
          lat:point.lat,
          lng:point.lng,
          finderLat:Number(course.finderLat??course.courseFinderLat)||null,
          finderLng:Number(course.finderLng??course.courseFinderLng)||null,
          distanceM:distance(center,point),
          source:course.source
        };
      })
      .filter(Boolean)
      .filter(course=>Number.isFinite(course.distanceM)&&course.distanceM<=maxDistance)
      .sort((a,b)=>a.distanceM-b.distanceM);
  }
  function nearestKnownCourse(center=mapSessionCenter(),maxDistance=ASSUMED_COURSE_MATCH_RADIUS_M){
    return nearbyKnownCourses(center,maxDistance)[0]||null;
  }
  function sessionCourse(course=courseObj()){
    const c=course||{};
    if(!isManualGpsCourse(c)&&!isAssumedCourseName(rawCourseName(c)))return c;
    const center=mapSessionCenter(c);
    let savedName='';
    try{savedName=window.gdAssumedCourseName||sessionStorage.getItem('gd_assumed_course_name')||'';}catch(e){savedName=window.gdAssumedCourseName||'';}
    if(isAssumedCourseName(savedName))savedName='';
    const nearest=nearestKnownCourse(center);
    const name=nearest?.name||savedName||assumedCourseLabel(center);
    return {...c,name,courseId:nearest?.courseId||assumedCourseId(center),lat:nearest?.lat??center.lat,lng:nearest?.lng??center.lng,assumed:true,source:nearest?.source||'assumed-live-gps',distanceM:nearest?.distanceM};
  }
  function courseName(course=courseObj()){return String(sessionCourse(course)?.name||'Assumed golf course');}
  function activeCourseForMode(){
    try{
      const label=document.body?.dataset?.gdActiveCourseName;
      if(isUsefulCourseName(label))return {name:label,source:'body-course-label'};
    }catch(e){}
    try{
      const active=JSON.parse(localStorage.getItem('gd_active_course_v1')||'null');
      if(active?.name||active?.courseName)return active;
    }catch(e){}
    try{
      if(typeof currentCourse!=='undefined'&&currentCourse?.name)return currentCourse;
    }catch(e){}
    return {name:'Manual GPS',source:'manual-default'};
  }
  function mappedModeCourseIdentity(course=activeCourseForMode()){
    const c=course||{};
    const name=String(c.name||c.courseName||courseName(c)||'manual-gps');
    const id=String(c.courseId||c.id||'');
    return slug(id||name||'manual-gps');
  }
  function mappedModeCourseKey(course=activeCourseForMode()){
    return `${MAPPED_PLAY_MODE_PREFIX}${mappedModeCourseIdentity(course)}`;
  }
  function isWindrossCourse(course=activeCourseForMode()){
    const raw=[course?.name,course?.courseName,course?.courseId,course?.id].filter(Boolean).join(' ');
    return /windross/i.test(raw);
  }
  function courseHasMappedGreenFairway(course=null,hole=null){
    try{
      const h=validHoleNumber(hole);
      const c=(course&&objectValues(course).length)?course:loadUserCourseData();
      if(!c)return false;
      const holes=new Map();
      objectValues(c).forEach(object=>{
        if(!object||!object.confirmed)return;
        const n=validHoleNumber(object.holeNumber);
        if(!n||h&&n!==h)return;
        const state=holes.get(n)||{green:false,fairway:false};
        if(object.type==='green'&&objectCenter(object))state.green=true;
        if(object.type==='fairway'&&object.position)state.fairway=true;
        holes.set(n,state);
      });
      return Array.from(holes.values()).some(state=>state.green&&state.fairway);
    }catch(e){return false;}
  }
  function defaultMappedPlayMode(course=activeCourseForMode()){
    if(isManualGpsCourse(course))return 'unmapped';
    return courseHasMappedGreenFairway(course)?'mapped':'unmapped';
  }
  function mappedPlayMode(){
    const course=activeCourseForMode();
    try{
      const courseValue=localStorage.getItem(mappedModeCourseKey(course));
      if(courseValue==='mapped')return 'mapped';
      if(courseValue==='unmapped')return 'unmapped';
      const legacy=localStorage.getItem(MAPPED_PLAY_MODE_KEY);
      if(isWindrossCourse(course)&&legacy==='mapped')return 'mapped';
      if(isWindrossCourse(course)&&legacy==='unmapped')return 'unmapped';
    }catch(e){}
    return defaultMappedPlayMode(course);
  }
  function mappedCourseAssistEnabled(){return mappedPlayMode()==='mapped';}
  function setMappedPlayMode(mode,opts={}){
    const next=mode==='unmapped'?'unmapped':'mapped';
    try{localStorage.setItem(mappedModeCourseKey(),next);}catch(e){}
    cancelMappedPlayAsync('mapped-mode-change');
    try{
      if(!opts.preserveAssist)mappedPlayAssist={armed:false,hole:null,courseKey:null,locked:false,lastFrameAt:0};
      window.gdMappedGreenAutoLockedUntil=0;
      if(next==='unmapped')clearMapperObjectLayers();
    }catch(e){}
    updateMappedPlayModeUi();
    if(!opts.silent)toastSafe(next==='mapped'?'Mapped course assist on':'Plain two-tap mode');
    if(next==='mapped'&&!opts.skipFrame){
      const frameRun=nextMappedFrameRun();
      scheduleMappedFrameTask(frameRun,80,()=>focusMappedHoleOrSavedGreen(activePlayingHole()||holeNumber()||1,{quiet:true,frame:true}));
    }
    return next;
  }
  function toggleMappedPlayMode(){
    return setMappedPlayMode(mappedCourseAssistEnabled()?'unmapped':'mapped');
  }
  function updateMappedPlayModeUi(){
    try{
      const btn=document.getElementById('gdMappedPlayModeToggle');
      const sub=document.getElementById('gdMappedPlayModeSub');
      const courseScreen=document.getElementById('courseScreen');
      const pickerOpen=!!(courseScreen&&!courseScreen.classList.contains('hidden')&&getComputedStyle(courseScreen).display!=='none'&&getComputedStyle(courseScreen).visibility!=='hidden');
      const mapped=mappedCourseAssistEnabled();
      document.body.classList.toggle('gdMappedCourseMode',mapped&&!pickerOpen);
      if(mapped){
        try{document.getElementById('gdWandPanel')?.classList.add('hidden');}catch(e){}
        try{if(typeof clearWandHandles==='function')clearWandHandles();}catch(e){}
        try{if(typeof window.gdClearWandLive==='function')window.gdClearWandLive();}catch(e){}
      }
      if(btn){
        btn.textContent=mapped?'Mapped':'Unmapped';
        btn.classList.toggle('active',mapped);
        btn.setAttribute('aria-label',mapped?'Mapped course mode':'Unmapped course mode');
        btn.title=mapped?'Mapped course mode':'Unmapped course mode';
      }
      if(sub)sub.textContent=mapped?`Use saved mapping for ${courseName(activeCourseForMode())}`:`Plain two-tap for ${courseName(activeCourseForMode())}`;
    }catch(e){}
  }
  function installMappedPlayModeSetting(){
    try{
      const existing=document.getElementById('gdMappedPlayModeToggle');
      if(existing){
        if(!existing.__gdMappedPlayModeBound){
          existing.__gdMappedPlayModeBound=true;
          existing.addEventListener('click',toggleMappedPlayMode);
        }
        updateMappedPlayModeUi();
        return;
      }
      const anchor=document.getElementById('mapSourceBtn')?.closest?.('.row')||document.getElementById('settingsPanel')?.querySelector?.('.gdSettingsGroup');
      if(!anchor)return;
      const row=document.createElement('div');
      row.className='row';
      row.id='gdMappedPlayModeRow';
      row.innerHTML='<div><strong>Course mapping</strong><span id="gdMappedPlayModeSub">Use saved hole mapping</span></div><button class="toggle active" id="gdMappedPlayModeToggle" type="button">Mapped</button>';
      row.querySelector('button').addEventListener('click',toggleMappedPlayMode);
      anchor.insertAdjacentElement('afterend',row);
      updateMappedPlayModeUi();
    }catch(e){}
  }
  function installIsolatedFlagPlacement(){
    if(window.__gdIsolatedFlagPlacement)return;
    window.__gdIsolatedFlagPlacement=true;
    let flagDown=null;
    const resetLegacyFlagState=flag=>{
      try{placingPin=false;}catch(e){}
      try{draggingFlag=false;}catch(e){}
      try{flagPointerStart=null;}catch(e){}
      try{document.getElementById('ghost').style.display='none';}catch(e){}
      try{flag?.classList.remove('softActive','grabbing');}catch(e){}
    };
    const block=ev=>{
      const flag=ev.target?.closest?.('#flagTool');
      if(!flag)return null;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      return flag;
    };
    document.addEventListener('pointerdown',ev=>{
      const flag=block(ev);
      if(!flag)return;
      flagDown={x:ev.clientX||0,y:ev.clientY||0,id:ev.pointerId,time:Date.now()};
      resetLegacyFlagState(flag);
    },true);
    document.addEventListener('pointermove',ev=>{
      const flag=ev.target?.closest?.('#flagTool');
      if(!flag||!flagDown)return;
      block(ev);
      resetLegacyFlagState(flag);
    },true);
    document.addEventListener('pointerup',ev=>{
      const flag=block(ev);
      if(!flag)return;
      const start=flagDown;
      flagDown=null;
      resetLegacyFlagState(flag);
      const moved=start?Math.hypot((ev.clientX||0)-start.x,(ev.clientY||0)-start.y):0;
      if(moved>12)return;
      openPinLockSheet();
    },true);
    document.addEventListener('pointercancel',ev=>{
      const flag=block(ev);
      if(!flag)return;
      flagDown=null;
      resetLegacyFlagState(flag);
    },true);
    document.addEventListener('click',ev=>{
      const flag=block(ev);
      if(!flag)return;
      resetLegacyFlagState(flag);
      openPinLockSheet();
    },true);
  }
  window.gdSetMappedPlayMode=setMappedPlayMode;
  window.gdToggleMappedPlayMode=toggleMappedPlayMode;
  window.gdMappedCourseAssistEnabled=mappedCourseAssistEnabled;
  window.gdCourseHasMappedGreenFairway=courseHasMappedGreenFairway;
  function pinLockBusy(){
    try{
      const pinLock=document.getElementById('gdPinLockOverlay');
      return !!(window.__gdPinLockOpen||window.__gdPinLockPlacing||(pinLock&&!pinLock.classList.contains('hidden')));
    }catch(e){return !!(window.__gdPinLockOpen||window.__gdPinLockPlacing);}
  }
  function shouldAutoRestoreSavedGreen(opts={}){
    if(pinLockBusy())return false;
    if(isManualGpsCourse())return false;
    if(opts.force)return true;
    return mappedCourseAssistEnabled();
  }
  function courseId(course=courseObj()){
    const c=sessionCourse(course)||{};
    if(c.courseId||c.id)return slug(c.courseId||c.id);
    if(c.name)return slug(c.name);
    const base=slug(c.name||'assumed-golf-course');
    const lat=Number(c.lat??c.latitude), lng=Number(c.lng??c.longitude);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return `${base}-${lat.toFixed(4)}-${lng.toFixed(4)}`;
    return base;
  }
  function courseKey(uid= userId(), cid=courseId()){return `${uid}::${cid}`;}
  function applyVisibleCourseLabel(label){
    const clean=String(label||'').trim();
    if(!clean)return;
    try{
      const line=document.getElementById('courseLine');
      if(line&&isManualGpsCourse())line.textContent=clean;
    }catch(e){}
  }
  function setAssumedCourseName(name){
    const clean=String(name||'').trim();
    window.gdAssumedCourseName=clean;
    try{
      if(clean)sessionStorage.setItem('gd_assumed_course_name',clean);
      else sessionStorage.removeItem('gd_assumed_course_name');
    }catch(e){}
    applyVisibleCourseLabel(clean||assumedCourseLabel());
    ensureAssumedCourseBadge();
    return clean;
  }
  function courseIdentity(course){
    const name=normalizeCourseName(course?.courseName||course?.name);
    if(name&&name!=='manual-gps')return `name:${name}`;
    const cid=slug(course?.courseId||course?.id||'assumed-golf-course');
    return `id:${cid}`;
  }
  function objectCenter(object){
    return object?.position||object?.greenCenter||object?.pinPosition||null;
  }
  function knownScorecardNumber(value){
    if(value===null||value===undefined||String(value).trim()==='')return null;
    try{
      if(typeof gdScorecardKnownNumber==='function')return gdScorecardKnownNumber(value);
    }catch(e){}
    const n=Number(value);
    return Number.isFinite(n)?n:null;
  }
  function knownParForHole(hole,explicit=null){
    const direct=knownScorecardNumber(explicit);
    if(direct!==null)return direct;
    try{return knownScorecardNumber(scorecard?.holes?.[Number(hole)-1]?.par);}catch(e){return null;}
  }
  function objectDedupeRadius(type){
    return OBJECT_DEDUPE_RADIUS_M[type]||OBJECT_DEDUPE_RADIUS_M.default;
  }
  function mergeObjectRecord(target,source){
    if(!target||!source)return target;
    const sourceNewer=String(source.updatedAt||'')>String(target.updatedAt||'');
    const sourceCenter=objectCenter(source);
    if(sourceCenter){
      target.position=toPlain(sourceCenter);
      if(target.type==='green')target.greenCenter=target.position;
    }
    if(source.holeNumber!=null&&target.holeNumber==null)target.holeNumber=source.holeNumber;
    if(source.confirmed)target.confirmed=true;
    target.lifecycle=objectLifecycle(target);
    target.targetEligible=target.type==='green'&&target.confirmed;
    if(source.shape&&(!target.shape||sourceNewer))target.shape=source.shape;
    if(source.greenShape&&(!target.greenShape||sourceNewer))target.greenShape=source.greenShape;
    if(source.greenCenter&&(!target.greenCenter||sourceNewer))target.greenCenter=source.greenCenter;
    if(source.source&&(!target.source||sourceNewer))target.source=source.source;
    if(source.greenSource&&(!target.greenSource||sourceNewer))target.greenSource=source.greenSource;
    if(!target.createdAt||String(source.createdAt||'')<String(target.createdAt||''))target.createdAt=source.createdAt||target.createdAt;
    target.updatedAt=sourceNewer?source.updatedAt:(target.updatedAt||source.updatedAt||nowIso());
    return target;
  }
  function dedupeCourseObjects(course){
    if(!course?.objects)return false;
    let changed=false;
    const objects=Object.values(course.objects).filter(Boolean).sort((a,b)=>String(a.createdAt||a.updatedAt||'').localeCompare(String(b.createdAt||b.updatedAt||'')));
    for(let i=0;i<objects.length;i++){
      const base=objects[i];
      if(!base||!course.objects[base.id])continue;
      const basePos=objectCenter(base);
      if(!basePos)continue;
      for(let j=i+1;j<objects.length;j++){
        const next=objects[j];
        if(!next||!course.objects[next.id]||next.type!==base.type)continue;
        const nextPos=objectCenter(next);
        if(!nextPos)continue;
        if(distance(basePos,nextPos)>objectDedupeRadius(base.type))continue;
        mergeObjectRecord(base,next);
        delete course.objects[next.id];
        changed=true;
      }
    }
    Object.values(course.objects).forEach(object=>{
      const beforeHole=object.holeNumber;
      const beforeConfirmed=object.confirmed;
      const h=validHoleNumber(object.holeNumber);
      object.holeNumber=h;
      if(!h)object.confirmed=false;
      object.lifecycle=objectLifecycle(object);
      object.targetEligible=object.type==='green'&&object.confirmed;
      if(object.type==='green'){
        object.greenCenter=object.greenCenter||object.position;
        object.greenShape=object.greenShape||object.shape||null;
        object.greenSource=object.greenSource||object.source||'saved';
        if(object.confirmed&&object.holeNumber!=null){
          course.holes=course.holes||{};
          course.holes[object.holeNumber]=asGreenRecord(object);
        }
      }
      if(beforeHole!==object.holeNumber||beforeConfirmed!==object.confirmed)changed=true;
    });
    Object.entries(course.holes||{}).forEach(([hole,record])=>{
      if(!validHoleNumber(hole)||!validHoleNumber(record?.holeNumber)||(record?.id&&course.objects&&!course.objects[record.id])){
        delete course.holes[hole];
        changed=true;
      }
    });
    if(changed){
      course.updatedAt=nowIso();
    }
    return changed;
  }
  function normalizeStoredCourse(course){
    if(!course)return course;
    let changed=false;
    if(/^manual gps$/i.test(String(course.courseName||''))){
      const center={lat:course.courseLat,lng:course.courseLng};
      course.courseName=assumedCourseLabel(center);
      course.courseId=assumedCourseId(center);
      changed=true;
    }
    if(course.finderLat!=null&&!Number.isFinite(Number(course.finderLat))){delete course.finderLat;changed=true;}
    if(course.finderLng!=null&&!Number.isFinite(Number(course.finderLng))){delete course.finderLng;changed=true;}
    if(course.finderLat!=null&&course.courseFinderLat==null){course.courseFinderLat=course.finderLat;changed=true;}
    if(course.finderLng!=null&&course.courseFinderLng==null){course.courseFinderLng=course.finderLng;changed=true;}
    if(!course.objects){course.objects={};changed=true;}
    if(!course.holes){course.holes={};changed=true;}
    if(dedupeCourseObjects(course))changed=true;
    return changed;
  }
  function mergeCourseObjects(target,source){
    Object.values(source.objects||{}).forEach(object=>{
      if(!object?.id)return;
      const pos=objectCenter(object);
      const duplicate=nearestMatchingObject(target,object.type,pos,objectDedupeRadius(object.type));
      if(duplicate){
        mergeObjectRecord(duplicate,object);
        return;
      }
      let id=object.id;
      while(target.objects[id])id=`${object.id}-${Math.random().toString(36).slice(2,5)}`;
      target.objects[id]={...object,id,courseId:target.courseId};
    });
    Object.entries(source.holes||{}).forEach(([hole,record])=>{
      if(!target.holes[hole]||String(record?.updatedAt||'')>String(target.holes[hole]?.updatedAt||'')){
        target.holes[hole]={...record,courseId:target.courseId};
      }
    });
    target.updatedAt=nowIso();
  }
  function dedupeStore(store){
    let changed=false;
    const byUserIdentity={};
    Object.entries(store.courses||{}).forEach(([key,course])=>{
      if(normalizeStoredCourse(course))changed=true;
      const identity=`${course.userId||''}::${courseIdentity(course)}`;
      const existingKey=byUserIdentity[identity];
      if(!existingKey){byUserIdentity[identity]=key;return;}
      const target=store.courses[existingKey];
      mergeCourseObjects(target,course);
      delete store.courses[key];
      changed=true;
    });
    return changed;
  }
  function findCourseKey(store,uid=userId(),cid=courseId(),name=courseName(),course=courseObj()){
    const exact=courseKey(uid,cid);
    if(store.courses?.[exact])return exact;
    const probe={userId:uid,courseId:cid,courseName:name,...sessionCourse(course)};
    const identity=courseIdentity(probe);
    return Object.entries(store.courses||{}).find(([,c])=>c.userId===uid&&courseIdentity(c)===identity)?.[0]||exact;
  }
  function loadStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(STORE_KEY)||'{}');
      if(!parsed.courses)parsed.courses={};
      if(dedupeStore(parsed))saveStore(parsed);
      return parsed;
    }catch(e){return {courses:{}};}
  }
  function saveStore(store){try{localStorage.setItem(STORE_KEY,JSON.stringify(store));}catch(e){}}
  function cloneData(value){try{return JSON.parse(JSON.stringify(value));}catch(e){return value;}}
  function loadPublishedStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(PUBLISHED_STORE_KEY)||'{}')||{};
      if(!parsed.courses)parsed.courses={};
      return parsed;
    }catch(e){return {version:1,courses:{}};}
  }
  function savePublishedStore(store){
    try{localStorage.setItem(PUBLISHED_STORE_KEY,JSON.stringify(store));}catch(e){}
  }
  function isPublishedCourse(course){
    return !!(course&&(course.published||course.userId==='published'||String(course.id||'').startsWith('published::')));
  }
  function hasPublishedCourseMap(course){
    return !!(isPublishedCourse(course)||course?.hasPublishedBase||course?.publishedSourceId);
  }
  function currentAdminActor(){
    let account=null;
    try{account=window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==='function'?window.GolfDaddyAccounts.current():null;}catch(e){}
    let profile=null;
    try{profile=typeof activePlayerProfile==='function'?activePlayerProfile():null;}catch(e){}
    let role='player';
    try{role=typeof gdGetAccountPermission==='function'?gdGetAccountPermission():(account?.role||profile?.permission||'player');}catch(e){}
    return {
      name:account?.name||profile?.name||'Admin',
      email:String(account?.email||profile?.email||'').trim().toLowerCase(),
      role:String(account?.role||role||'player').trim().toLowerCase(),
      accountId:account?.accountId||profile?.accountId||''
    };
  }
  function isPublishedAdminEmail(email){
    return PUBLISHED_ADMIN_EMAILS.includes(String(email||'').trim().toLowerCase());
  }
  function isAdminUser(){
    const actor=currentAdminActor();
    const roleOk=actor.role==='admin'||(()=>{try{return gdGetAccountPermission&&gdGetAccountPermission()==='admin';}catch(e){return false;}})();
    return roleOk&&isPublishedAdminEmail(actor.email);
  }
  function publishedCourseId(course){
    return `published::${slug(course?.courseId||course?.id||course?.courseName||course?.name||'course')}`;
  }
  function normalizePublishedCourse(input,actor=currentAdminActor()){
    const course=cloneData(input||{});
    if(!course||!course.courseName)return null;
    const cid=slug(course.courseId||course.id||course.courseName);
    const id=publishedCourseId({...course,courseId:cid});
    course.id=id;
    course.userId='published';
    course.courseId=cid;
    course.courseName=course.courseName||course.name||cid;
    course.published=true;
    course.publishedAt=nowIso();
    course.publishedBy={name:actor.name||'Admin',email:actor.email||'',accountId:actor.accountId||''};
    course.objects=course.objects||{};
    Object.values(course.objects).forEach(object=>{
      if(!object)return;
      object.userId='published';
      object.courseId=cid;
      object.published=true;
    });
    course.holes=course.holes||{};
    Object.values(course.holes).forEach(hole=>{
      if(!hole)return;
      hole.userId='published';
      hole.courseId=cid;
      hole.published=true;
    });
    return course;
  }
  function publishedCourses(){
    return Object.values(loadPublishedStore().courses||{}).filter(Boolean).map(course=>{normalizeStoredCourse(course);return course;});
  }
  function courseMatchesIdentity(course,cid=courseId(),name=courseName(),session=courseObj()){
    if(!course)return false;
    const cId=slug(cid||session?.courseId||session?.id||'');
    const courseCid=slug(course.courseId||course.id||'');
    if(cId&&courseCid&&cId===courseCid)return true;
    const probe=normalizeCourseName(name||session?.name||session?.courseName||'');
    const courseNameKey=normalizeCourseName(course.courseName||course.name||'');
    return !!(probe&&courseNameKey&&probe===courseNameKey);
  }
  function findPublishedCourse(cid=courseId(),name=courseName(),session=courseObj()){
    return publishedCourses().find(course=>courseMatchesIdentity(course,cid,name,session))||null;
  }
  function mergeCourseData(privateCourse,publishedCourse,uid=userId()){
    if(!publishedCourse)return privateCourse||null;
    const base=cloneData(publishedCourse);
    const own=privateCourse?cloneData(privateCourse):null;
    if(!own){
      base.readOnly=true;
      return base;
    }
    return {
      ...base,
      ...own,
      id:own.id,
      userId:uid,
      published:false,
      publishedSourceId:base.id,
      hasPublishedBase:true,
      objects:{...(base.objects||{}),...(own.objects||{})},
      holes:{...(base.holes||{}),...(own.holes||{})}
    };
  }
  function libraryCourses(uid=userId()){
    const privateCourses=Object.values(loadStore().courses||{}).filter(c=>c.userId===uid);
    const byId=new Map();
    publishedCourses().forEach(course=>byId.set(course.id,course));
    privateCourses.forEach(course=>{
      const published=findPublishedCourse(course.courseId,course.courseName,course);
      if(published)byId.delete(published.id);
      byId.set(course.id,mergeCourseData(course,published,uid));
    });
    return Array.from(byId.values());
  }
  function findLibraryCourse(courseStoreId,uid=userId()){
    const store=loadStore();
    const privateCourse=store.courses?.[courseStoreId];
    if(privateCourse)return mergeCourseData(privateCourse,findPublishedCourse(privateCourse.courseId,privateCourse.courseName,privateCourse),uid);
    return publishedCourses().find(course=>course.id===courseStoreId)||null;
  }
  function mergePublishedStore(incoming){
    const next=loadPublishedStore();
    next.version=1;
    next.courses=next.courses||{};
    Object.values(incoming?.courses||{}).forEach(course=>{
      const clean=normalizePublishedCourse(course,course.publishedBy||currentAdminActor());
      if(clean)next.courses[clean.id]=clean;
    });
    next.updatedAt=incoming?.updatedAt||nowIso();
    savePublishedStore(next);
    return next;
  }
  function clearGreenShapeVisual(){
    try{
      [greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(l=>l&&map.removeLayer(l));
      greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
      greenPolygon=null;
      if(typeof renderShot==='function')renderShot();
    }catch(e){}
  }
  function syncManualShapeVisual(prev,center,shape,source){
    if(source!=='manual')return;
    if(shape&&prev?.greenShape&&prev?.greenCenter&&distance(prev.greenCenter,center)<10){
      try{
        if(typeof drawGreenPolygon==='function')drawGreenPolygon(shape.map(toLatLng).filter(Boolean),'saved green',{settled:true});
      }catch(e){}
      return;
    }
    clearGreenShapeVisual();
  }
  function distance(a,b){
    try{if(typeof map!=='undefined'&&map&&a&&b)return map.distance(toLatLng(a)||a,toLatLng(b)||b);}catch(e){}
    if(!a||!b)return Infinity;
    const lat=(Number(a.lat)+Number(b.lat))*Math.PI/360;
    const dy=(Number(b.lat)-Number(a.lat))*111320;
    const dx=(Number(b.lng)-Number(a.lng))*111320*Math.cos(lat);
    return Math.hypot(dx,dy);
  }
  function courseFinderPoint(course){
    const lat=Number(course?.finderLat??course?.courseFinderLat);
    const lng=Number(course?.finderLng??course?.courseFinderLng);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
  }
  function coordLabel(point){
    if(!point)return '';
    return `${Number(point.lat).toFixed(5)}, ${Number(point.lng).toFixed(5)}`;
  }
  function clearCourseFinderLayer(){
    try{if(courseFinderLayer&&typeof map!=='undefined'&&map)map.removeLayer(courseFinderLayer);}catch(e){}
    courseFinderLayer=null;
  }
  function focusCourseFinder(course){
    const point=courseFinderPoint(course);
    if(!point)return false;
    const ll=toLatLng(point);
    if(!ll)return false;
    try{
      if(typeof map==='undefined'||!map||typeof L==='undefined')return false;
      clearCourseFinderLayer();
      courseFinderLayer=L.circleMarker(ll,{
        radius:10,
        color:'#ffffff',
        weight:2,
        opacity:.9,
        fillColor:'#1fd36d',
        fillOpacity:.28,
        interactive:false
      }).addTo(map);
      map.setView(ll,Math.max(map.getZoom(),17),{animate:true});
      return true;
    }catch(e){return false;}
  }
  function simplifyShape(points,max=56){
    if(!Array.isArray(points)||!points.length)return null;
    const clean=points.map(p=>toPlain(p)).filter(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng));
    if(clean.length<3)return null;
    const step=Math.max(1,Math.ceil(clean.length/max));
    const out=clean.filter((_,i)=>i%step===0);
    return out.length>=3?out:clean.slice(0,Math.min(clean.length,max));
  }
  function translateShape(shape,from,to){
    if(!Array.isArray(shape)||!from||!to)return null;
    const dLat=Number(to.lat)-Number(from.lat);
    const dLng=Number(to.lng)-Number(from.lng);
    return shape.map(p=>({lat:Number(p.lat)+dLat,lng:Number(p.lng)+dLng}));
  }
  function asGreenRecord(object){
    if(!object)return null;
    return {
      id:object.id,
      userId:object.userId,
      courseId:object.courseId,
      holeNumber:validHoleNumber(object.holeNumber),
      greenCenter:object.greenCenter||object.position||null,
      greenShape:object.greenShape||object.shape||null,
      greenSource:object.greenSource||object.source||'unknown',
      confirmed:!!object.confirmed&&!!validHoleNumber(object.holeNumber),
      createdAt:object.createdAt,
      updatedAt:object.updatedAt
    };
  }
  function objectValues(course,type=null){
    const objects=Object.values(course?.objects||{});
    return type?objects.filter(o=>o&&o.type===type):objects.filter(Boolean);
  }
  function confirmedGreenRecord(course,hole){
    const h=Number(hole)||1;
    const found=objectValues(course,'green')
      .filter(o=>Number(o.holeNumber)===h&&o.confirmed&&!!validHoleNumber(o.holeNumber))
      .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0];
    return asGreenRecord(found);
  }
  function legacyGreenRecord(course,hole){
    const rec=course?.holes?.[hole]||null;
    return rec?{...rec,confirmed:true,legacy:true}:null;
  }
  function activeGreenShape(){
    try{if(Array.isArray(greenPolygon)&&greenPolygon.length>=3)return simplifyShape(greenPolygon,64);}catch(e){}
    const rec=activeGreenRecord();
    return rec?.greenShape||null;
  }
  function activeGreenRecord(uid=userId(),cid=courseId(),hole=holeNumber(),opts={}){
    const course=loadUserCourseData(uid,cid);
    if(!course)return null;
    return confirmedGreenRecord(course,hole) || (opts.includeLegacy===false?null:legacyGreenRecord(course,hole));
  }
  function ensureCourse(store,uid,cid,name,course){
    const canonical=sessionCourse(course);
    const key=findCourseKey(store,uid,cid,name,canonical);
    if(!store.courses[key]){
      store.courses[key]={
        id:key,
        userId:uid,
        courseId:cid,
        courseName:name,
        courseLat:Number(course?.lat??course?.latitude)||null,
        courseLng:Number(course?.lng??course?.longitude)||null,
        createdAt:nowIso(),
        updatedAt:nowIso(),
        holes:{},
        objects:{}
      };
    }
    store.courses[key].courseName=name||canonical?.name||store.courses[key].courseName;
    store.courses[key].courseId=cid||store.courses[key].courseId;
    store.courses[key].updatedAt=nowIso();
    if(canonical){
      const lat=Number(canonical.lat??canonical.latitude), lng=Number(canonical.lng??canonical.longitude);
      if(Number.isFinite(lat))store.courses[key].courseLat=lat;
      if(Number.isFinite(lng))store.courses[key].courseLng=lng;
      const finderLat=Number(canonical.finderLat??canonical.courseFinderLat);
      const finderLng=Number(canonical.finderLng??canonical.courseFinderLng);
      if(Number.isFinite(finderLat))store.courses[key].finderLat=store.courses[key].courseFinderLat=finderLat;
      if(Number.isFinite(finderLng))store.courses[key].finderLng=store.courses[key].courseFinderLng=finderLng;
    }
    if(!store.courses[key].holes)store.courses[key].holes={};
    if(!store.courses[key].objects)store.courses[key].objects={};
    return store.courses[key];
  }
  function currentMapFinderPoint(){
    try{
      if(typeof map!=='undefined'&&map&&typeof map.getCenter==='function'){
        const center=map.getCenter();
        const lat=Number(center?.lat),lng=Number(center?.lng);
        if(Number.isFinite(lat)&&Number.isFinite(lng))return {lat,lng};
      }
    }catch(e){}
    try{
      if(start)return toPlain(start);
    }catch(e){}
    return null;
  }
  function saveCourseFinderCoordinate(point=currentMapFinderPoint(),source='play-hole'){
    const lat=Number(point?.lat),lng=Number(point?.lng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    const c=sessionCourse(courseObj());
    if(!c||isManualGpsCourse(c)||isAssumedCourseName(c.name))return null;
    const uid=userId();
    const cid=courseId(c);
    const store=loadStore();
    const course=ensureCourse(store,uid,cid,courseName(c),{...c,finderLat:lat,finderLng:lng});
    course.finderLat=course.courseFinderLat=lat;
    course.finderLng=course.courseFinderLng=lng;
    course.finderSource=source;
    course.finderUpdatedAt=nowIso();
    course.updatedAt=nowIso();
    saveStore(store);
    try{
      const active=JSON.parse(localStorage.getItem('gd_active_course_v1')||'null');
      if(active&&normalizeCourseName(active.name||active.courseName)===normalizeCourseName(course.courseName)){
        active.finderLat=active.courseFinderLat=lat;
        active.finderLng=active.courseFinderLng=lng;
        active.finderUpdatedAt=course.finderUpdatedAt;
        localStorage.setItem('gd_active_course_v1',JSON.stringify(active));
      }
    }catch(e){}
    return course;
  }
  function shapeForSave(source,center,prev){
    const sourceName=source||'unknown';
    const liveShape=(()=>{try{return Array.isArray(greenPolygon)&&greenPolygon.length>=3?simplifyShape(greenPolygon,64):null;}catch(e){return null;}})();
    if((sourceName==='wand_accepted'||sourceName==='imported'||sourceName==='manual_shape')&&liveShape)return liveShape;
    if(sourceName!=='manual'&&liveShape)return liveShape;
    if(prev?.greenShape&&prev?.greenCenter&&center){
      return distance(prev.greenCenter,center)<10?translateShape(prev.greenShape,prev.greenCenter,center):null;
    }
    return null;
  }
  function nearestMatchingObject(course,type,center,maxDistance=objectDedupeRadius(type)){
    if(!center)return null;
    let best=null;
    objectValues(course,type).forEach(object=>{
      const centerPoint=objectCenter(object);
      const d=distance(centerPoint,center);
      if(d<=maxDistance&&(!best||d<best.distance))best={object,distance:d};
    });
    return best?.object||null;
  }
	  function saveCourseObject(input={}){
	    const uid=input.userId||userId();
	    const c=sessionCourse(input.course||courseObj());
    const cid=input.courseId||courseId(c);
    const store=loadStore();
    const course=ensureCourse(store,uid,cid,input.courseName||courseName(c),c);
    const canonicalCid=course.courseId||cid;
    const type=input.type||'green';
    const position=input.position?toPlain(input.position):null;
    if(!Number.isFinite(position?.lat)||!Number.isFinite(position?.lng))return null;
    const rawSource=input.source||input.greenSource||'';
    const hasShapeInput=!!(input.shape||input.greenShape);
    const greenPinOnly=type==='green'&&rawSource==='mapping_green_pin'&&!hasShapeInput;
    const matchedExisting=input.id?course.objects[input.id]:nearestMatchingObject(course,type,position,input.maxDedupeDistanceM||objectDedupeRadius(type));
    const existing=greenPinOnly?null:matchedExisting;
    const id=existing?.id||`${type}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    const source=rawSource||existing?.source||'unknown';
    const shape=hasShapeInput
      ? (input.shape? simplifyShape(input.shape,64) : simplifyShape(input.greenShape,64))
      : (greenPinOnly?null:(existing?.shape||existing?.greenShape||null));
    const liveHole=activePlayingHole();
    const rawHole=input.holeNumber===undefined
      ? (type==='bunker'?null:(existing?.holeNumber??liveHole))
      : (input.holeNumber==null?null:Number(input.holeNumber));
    const hole=validHoleNumber(rawHole);
    const confirmed=type==='green'
      ? !!(input.confirmed||existing?.confirmed)&&!!hole&&(greenPinOnly||Array.isArray(shape)&&shape.length>=3)
      : !!(input.confirmed||existing?.confirmed);
    course.objects[id]={
      ...(existing||{}),
      id,
      userId:uid,
      courseId:canonicalCid,
      type,
      position,
      shape,
      holeNumber:hole,
      confirmed,
      lifecycle:objectLifecycle({type,holeNumber:hole,confirmed}),
      targetEligible:type==='green'&&!!hole&&confirmed,
      source,
      greenCenter:type==='green'?position:undefined,
      greenShape:type==='green'?shape:undefined,
      greenSource:type==='green'?source:undefined,
      createdAt:existing?.createdAt||nowIso(),
      updatedAt:nowIso()
    };
    course.updatedAt=nowIso();
    dedupeCourseObjects(course);
    saveStore(store);
    gdCLRefreshProfileCard();
    return course.objects[id];
  }
  function objectLifecycle(object){
    if(validHoleNumber(object?.holeNumber)&&object?.confirmed)return 'hole-linked';
    if(validHoleNumber(object?.holeNumber))return 'assigned-draft';
    return 'unassigned';
  }
  function assignObjectToHole(objectId,hole=holeNumber(),confirmed=true,uid=userId(),cid=courseId()){
    const store=loadStore();
    const course=store.courses[findCourseKey(store,uid,cid)];
    const object=course?.objects?.[objectId];
    if(!object)return null;
    const prevHole=validHoleNumber(object.holeNumber);
    const nextHole=validHoleNumber(hole)||1;
    object.holeNumber=nextHole;
    object.confirmed=!!confirmed;
    object.lifecycle=objectLifecycle(object);
    object.targetEligible=object.type==='green'&&object.confirmed;
    object.updatedAt=nowIso();
    if(object.type==='green'&&object.confirmed){
      course.holes=course.holes||{};
      if(prevHole&&prevHole!==nextHole&&course.holes[prevHole]?.id===object.id)delete course.holes[prevHole];
      course.holes[object.holeNumber]=asGreenRecord(object);
    }
    course.updatedAt=nowIso();
    saveStore(store);
    gdCLRefreshProfileCard();
    updateMapperToolCompletion();
    return object;
  }
  function unassignObjectFromHole(objectId,uid=userId(),cid=courseId()){
    const store=loadStore();
    const course=store.courses[findCourseKey(store,uid,cid)];
    const object=course?.objects?.[objectId];
    if(!object)return null;
    const prevHole=validHoleNumber(object.holeNumber);
    if(object.type==='green'&&prevHole&&course.holes?.[prevHole]?.id===object.id)delete course.holes[prevHole];
    object.holeNumber=null;
    object.confirmed=false;
    object.lifecycle=objectLifecycle(object);
    object.targetEligible=false;
    object.updatedAt=nowIso();
    course.updatedAt=nowIso();
    saveStore(store);
    gdCLRefreshProfileCard();
    updateMapperToolCompletion();
    return object;
  }
  function deleteCourseObject(objectId,uid=userId(),cid=courseId()){
    const store=loadStore();
    const course=store.courses[findCourseKey(store,uid,cid)];
    const object=course?.objects?.[objectId];
    if(!object)return false;
    if(object.type==='green'&&object.confirmed&&object.holeNumber!=null&&course.holes){
      delete course.holes[object.holeNumber];
    }
    delete course.objects[objectId];
    course.updatedAt=nowIso();
    saveStore(store);
    gdCLRefreshProfileCard();
    updateMapperToolCompletion();
    return true;
  }
  function deleteCourseObjectsForHole(type,hole,uid=userId(),cid=courseId()){
    const h=validHoleNumber(hole);
    if(!h)return 0;
    const store=loadStore();
    const course=store.courses[findCourseKey(store,uid,cid)];
    if(!course)return 0;
    let count=0;
    Object.values(course.objects||{}).forEach(object=>{
      if(object?.type===type&&Number(object.holeNumber)===h){
        delete course.objects[object.id];
        count++;
      }
    });
    if(count){
      course.updatedAt=nowIso();
      saveStore(store);
      gdCLRefreshProfileCard();
      updateMapperToolCompletion();
    }
    return count;
  }
  function getUnassignedObjects(type=null,uid=userId(),cid=courseId()){
    const store=loadStore();
    const course=store.courses[findCourseKey(store,uid,cid)];
    return objectValues(course,type).filter(object=>object.holeNumber==null||!object.confirmed);
  }
  function getConfirmedHoleGreen(hole=holeNumber(),uid=userId(),cid=courseId(),includeLegacy=true){
    return activeGreenRecord(uid,cid,hole,{includeLegacy});
  }
  function clearMapperObjectLayers(){
    mapperObjectLayers.splice(0).forEach(layer=>{
      try{map.removeLayer(layer);}catch(e){}
    });
  }
		  function clearMapperGuideLayers(){
		    mapperGuideLayers.splice(0).forEach(layer=>{
		      try{map.removeLayer(layer);}catch(e){}
		    });
		  }
		  function mapSourceIndex(){
		    try{if(typeof activeMapSourceIndex==='number')return activeMapSourceIndex;}catch(e){}
		    try{if(Number.isInteger(window.gdActiveMapSourceIndex))return window.gdActiveMapSourceIndex;}catch(e){}
		    try{
		      const label=document.getElementById('mapSourceBtn')?.textContent?.trim();
		      const sources=Array.isArray(window.mapSources)?window.mapSources:[];
		      const found=sources.findIndex(source=>String(source?.name||source?.key||'').trim()===label);
		      if(found>=0)return found;
		    }catch(e){}
		    return null;
		  }
		  function playMapSourceIndex(){
		    try{
		      const sources=Array.isArray(window.mapSources)?window.mapSources:[];
		      const found=sources.findIndex(source=>!/osm/i.test(String(source?.key||source?.name||'')));
		      if(found>=0)return found;
		    }catch(e){}
		    return 0;
		  }
		  function rememberMapperReturnMapSource(){
		    if(mapperPreviousMapSourceIndex!==null)return;
		    const idx=mapSourceIndex();
		    const sources=Array.isArray(window.mapSources)?window.mapSources:[];
		    const source=Number.isInteger(idx)?sources[idx]:null;
		    mapperPreviousMapSourceIndex=source&&!/osm/i.test(String(source?.key||source?.name||''))?idx:playMapSourceIndex();
		  }
		  function restoreMapperReturnMapSource(){
		    try{
		      const current=mapSourceIndex();
		      const sources=Array.isArray(window.mapSources)?window.mapSources:[];
		      const target=Number.isInteger(mapperPreviousMapSourceIndex)?mapperPreviousMapSourceIndex:playMapSourceIndex();
		      const currentSource=Number.isInteger(current)?sources[current]:null;
		      const shouldRestore=current!==target&&(!currentSource||/osm/i.test(String(currentSource?.key||currentSource?.name||'')));
		      if(shouldRestore&&typeof setMapSource==='function')setMapSource(target,'mapping-guide-restore');
		    }catch(e){}
		    mapperPreviousMapSourceIndex=null;
		    try{updateMapperMapSourceUi();}catch(e){}
		  }
		  function refreshPlayBadgeAfterMapping(){
		    try{if(typeof gdV62Refresh==='function')gdV62Refresh();}catch(e){}
		    try{if(typeof window.gdHydrateGpsBadge==='function')window.gdHydrateGpsBadge(true);}catch(e){}
		    try{
		      const status=document.querySelector('#gdV62GpsBadge .statusText');
		      if(status&&/^Mapping H/i.test(status.textContent||'')){
		        const h=validHoleNumber(activePlayingHole())||validHoleNumber(holeNumber())||validHoleNumber(window.gdMapperActiveHole);
		        status.textContent=h?`Hole ${h}`:'Ready';
		      }
		    }catch(e){}
		  }
		  function hideMapperHoleGuide(){
		    try{document.getElementById('gdMapperHoleGuide')?.classList.add('hidden');}catch(e){}
		  }
		  function clearMapperGuideUi(){
		    clearMapperGuideLayers();
		    hideMapperHoleGuide();
		    try{document.querySelectorAll('.gdOsmGuideLabel').forEach(el=>el.remove());}catch(e){}
		    if(!window.gdFullMappingMode){
		      restoreMapperReturnMapSource();
		      refreshPlayBadgeAfterMapping();
		    }
		  }
	  window.gdClearMapperGuideUi=clearMapperGuideUi;
  function drawCourseObjectPin(object){
    if(!object?.position)return null;
    try{
      if(typeof L==='undefined'||typeof map==='undefined'||!map)return null;
      const ll=toLatLng(object.position);
      if(!ll)return null;
      const colors={bunker:'#f59e0b',tee:'#38bdf8',fairway:'#22c55e',green:'#1fd36d'};
      const color=colors[object.type]||'#1fd36d';
      const layer=L.circleMarker(ll,{
        radius:object.type==='green'?5:6,
        color,
        weight:2,
        opacity:.78,
        fillColor:color,
        fillOpacity:.16,
        interactive:false
      }).addTo(map);
      mapperObjectLayers.push(layer);
      return layer;
    }catch(e){return null;}
  }
  function fallbackGreenShape(center,radiusM=16,count=40){
    const ll=toLatLng(center);
    if(!ll)return [];
    const pts=[];
    for(let i=0;i<count;i++)pts.push(project(ll,(Math.PI*2*i)/count,radiusM));
    return pts;
  }
  function hasConfirmedGreenShape(object){
    const shape=object?.greenShape||object?.shape;
    return object?.type==='green'&&!!object.confirmed&&Array.isArray(shape)&&shape.length>=3;
  }
  function saveCourseObjectGeometry(object,patch={}){
    if(!object?.id)return null;
    const store=loadStore();
    const course=store.courses[findCourseKey(store,object.userId||userId(),object.courseId||courseId())];
    const saved=course?.objects?.[object.id];
    if(!saved)return null;
    Object.assign(saved,patch,{updatedAt:nowIso()});
    if(patch.position)saved.position=toPlain(patch.position);
    if(saved.type==='green'){
      saved.greenCenter=saved.position;
      saved.greenShape=saved.shape;
      if(validHoleNumber(saved.holeNumber)&&saved.confirmed){
        course.holes=course.holes||{};
        course.holes[saved.holeNumber]=asGreenRecord(saved);
      }
    }
    course.updatedAt=nowIso();
    saveStore(store);
    gdCLRefreshProfileCard();
    return saved;
  }
  function shouldDrawMapperReferenceGeometry(opts={}){
    const editable=opts.editable!==undefined?!!opts.editable:!!window.gdFullMappingMode;
    return !!(editable||opts.greenFix===true||opts.showReferenceGeometry===true);
  }
  function drawMapperGreenObject(object,opts={}){
    const center=toLatLng(object?.greenCenter||object?.position);
    if(!center)return null;
    try{
      if(typeof L==='undefined'||typeof map==='undefined'||!map)return null;
      const rawShape=object.greenShape||object.shape;
      const pts=(Array.isArray(rawShape)&&rawShape.length>=3?rawShape.map(toLatLng).filter(Boolean):[]);
      const editable=opts.editable!==undefined?!!opts.editable:!!window.gdFullMappingMode;
      if(!shouldDrawMapperReferenceGeometry(opts))return null;
      const showCenterPin=editable||opts.playDetail!==false;
      const greenFix=opts.greenFix===true;
      const layers=[];
      let marker=null;
      if(showCenterPin){
        marker=L.marker(center,{
          draggable:editable,
          interactive:editable,
          autoPan:false,
          icon:L.divIcon({
            className:'',
            html:`<div class="gdMapperGreenPin${greenFix?' gdMapperGreenPinFix':''}"></div>`,
            iconSize:greenFix?[34,34]:[18,18],
            iconAnchor:greenFix?[17,17]:[9,9]
          })
        }).addTo(map);
        layers.push(marker);
      }
      let soft=null;
      let outline=null;
      if(pts.length>=3){
        soft=L.polygon(pts,{color:'#1f8f55',weight:greenFix?2:1,opacity:greenFix ? .38 : .18,fillColor:'#1fd36d',fillOpacity:greenFix ? .055 : .025,interactive:false}).addTo(map);
        outline=L.polygon(pts,{color:greenFix?'#9cffbc':'#28b96b',weight:greenFix?4:2,opacity:greenFix ? .92 : .58,fillColor:'#1fd36d',fillOpacity:greenFix ? .035 : .018,interactive:editable}).addTo(map);
        layers.unshift(soft,outline);
      }
      mapperObjectLayers.push(...layers);
      let dragStart=null;
      let shapeStart=null;
      const finishOutlineDrag=()=>{
        if(!dragStart)return;
        try{map.dragging.enable();}catch(e){}
        dragStart=null;
        const nextShape=(outline.getLatLngs()?.[0]||[]).map(toPlain).filter(Boolean);
        saveCourseObjectGeometry(object,{shape:nextShape,greenShape:nextShape,source:'mapping_outline_adjust'});
        toastSafe('Green outline moved');
      };
      if(editable&&outline&&soft){
        outline.on('mousedown touchstart',ev=>{
          try{if(ev?.originalEvent&&typeof L!=='undefined')L.DomEvent.stop(ev.originalEvent);}catch(e){}
          dragStart=ev.latlng;
          shapeStart=(outline.getLatLngs()?.[0]||[]).map(p=>L.latLng(p.lat,p.lng));
          try{map.dragging.disable();}catch(e){}
        });
        map.on('mousemove',ev=>{
          if(!dragStart||!shapeStart)return;
          const dLat=ev.latlng.lat-dragStart.lat;
          const dLng=ev.latlng.lng-dragStart.lng;
          const moved=shapeStart.map(p=>L.latLng(p.lat+dLat,p.lng+dLng));
          outline.setLatLngs(moved);
          soft.setLatLngs(moved);
        });
        map.on('mouseup',finishOutlineDrag);
      }
      if(editable&&marker){
        marker.on('dragend',()=>{
          const next=marker.getLatLng();
          greenCentre=next;
          saveCourseObjectGeometry(object,{position:toPlain(next),greenCenter:toPlain(next),source:'mapping_center_adjust'});
          toastSafe('Green pin moved');
        });
      }
      return layers;
    }catch(e){console.warn('mapper green draw failed',e);return null;}
  }
  function objectSortTime(object){
    return String(object?.createdAt||object?.updatedAt||object?.id||'');
  }
  function drawMapperPointObject(object,opts={}){
    if(!object?.position)return null;
    if(object.type==='fairway'){
      const ll=toLatLng(object.position);
      if(!ll)return null;
      const bend=/bend/i.test(String(object.source||''));
      const editable=opts.editable!==undefined?!!opts.editable:!!window.gdFullMappingMode;
      if(!shouldDrawMapperReferenceGeometry(opts))return null;
      const marker=L.marker(ll,{
        draggable:editable,
        interactive:editable,
        autoPan:false,
        icon:L.divIcon({className:'',html:`<div class="gdMapperFairwayPin${bend?' bend':''}"></div>`,iconSize:bend?[18,18]:[24,24],iconAnchor:bend?[9,9]:[12,12]})
      }).addTo(map);
      mapperObjectLayers.push(marker);
      if(editable){
        marker.on('dragend',()=>{
          saveCourseObjectGeometry(object,{position:toPlain(marker.getLatLng()),source:object.source||'mapping_fairway_adjust'});
          const course=loadUserCourseData(object.userId||userId(),object.courseId||courseId());
          if(course)drawHoleObjects(course,object.holeNumber||mapperHole());
        });
      }
      return marker;
    }
    return drawCourseObjectPin(object);
  }
  function drawFairwayRoute(course,hole,objects=objectsForHole(course,hole),opts={}){
    try{
      if(typeof L==='undefined'||typeof map==='undefined'||!map)return null;
      const editable=opts.editable!==undefined?!!opts.editable:!!window.gdFullMappingMode;
      const tee=objects.filter(o=>o.type==='tee'&&o.position).sort((a,b)=>objectSortTime(a).localeCompare(objectSortTime(b)))[0];
      const green=objects.filter(o=>o.type==='green'&&objectCenter(o)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0];
      const fairways=objects.filter(o=>o.type==='fairway'&&o.position).sort((a,b)=>objectSortTime(a).localeCompare(objectSortTime(b)));
      const pts=[tee?.position,...fairways.map(o=>o.position),objectCenter(green)].map(toLatLng).filter(Boolean);
      if(pts.length<2)return null;
      if(!shouldDrawMapperReferenceGeometry(opts))return null;
      const subtle=!editable&&opts.playDetail===false;
      const route=L.polyline(pts,{
        color:subtle?'#78d99b':'#57c987',
        weight:subtle?1.5:3,
        opacity:subtle ? .30 : .68,
        lineCap:'round',
        lineJoin:'round',
        interactive:false
      }).addTo(map);
      try{route.bringToBack();}catch(e){}
      if(editable){
        const hit=L.polyline(pts,{color:'#ffffff',weight:24,opacity:.001,lineCap:'round',lineJoin:'round',interactive:true}).addTo(map);
        try{hit.bringToBack();}catch(e){}
        hit.on('click',ev=>{
          try{if(ev?.originalEvent&&typeof L!=='undefined')L.DomEvent.stop(ev.originalEvent);}catch(e){}
          const h=validHoleNumber(hole)||mapperHole();
          const object=saveCourseObject({
            type:'fairway',
            position:ev.latlng,
            source:'mapping_bend_point',
            holeNumber:h,
            confirmed:true,
            maxDedupeDistanceM:1
          });
          if(object){
            toastSafe(`Bend point added to H${h}`);
            drawHoleObjects(loadUserCourseData()||course,h);
          }
        });
        mapperObjectLayers.push(hit);
      }
      mapperObjectLayers.push(route);
      return route;
    }catch(e){console.warn('fairway route draw failed',e);return null;}
  }
  function objectMapPoints(object){
    const pts=[];
    const center=objectCenter(object)||object?.position;
    const ll=toLatLng(center);
    if(ll)pts.push(ll);
    const shape=object?.greenShape||object?.shape;
    if(Array.isArray(shape))shape.forEach(p=>{const s=toLatLng(p);if(s)pts.push(s);});
    return pts;
  }
  function focusHoleOnMap(course,hole){
    try{
      if(typeof L==='undefined'||typeof map==='undefined'||!map)return;
      const objects=objectValues(course).filter(object=>Number(object.holeNumber)===Number(hole));
      const pts=objects.flatMap(objectMapPoints);
      if(!pts.length)return;
      if(pts.length===1)map.setView(pts[0],Math.max(map.getZoom(),18),{animate:true});
      else map.fitBounds(L.latLngBounds(pts).pad(.35),{animate:true,maxZoom:18});
    }catch(e){}
  }
  function guideCoursePoint(course){
    const lat=Number(course?.courseLat??course?.lat??course?.latitude);
    const lng=Number(course?.courseLng??course?.lng??course?.longitude);
    if(Number.isFinite(lat)&&Number.isFinite(lng))return {lat,lng};
    const finder=courseFinderPoint(course);
    if(finder)return finder;
    return mapSessionCenter(courseObj());
  }
  function guideCacheKey(course){
    const label=course?.courseId||course?.courseName||courseName(courseObj())||currentCourseStorageLabel();
    return OSM_HOLE_GUIDE_CACHE_PREFIX+slug(label||'course');
  }
  function osmGuideHoleRef(value){
    const direct=validHoleNumber(value);
    if(direct)return direct;
    const match=String(value||'').match(/\d+/);
    return match?validHoleNumber(match[0]):null;
  }
  function osmGuidePointsFromElement(element){
    const pts=[];
    const add=p=>{
      const lat=Number(p?.lat), lng=Number(p?.lng??p?.lon);
      if(Number.isFinite(lat)&&Number.isFinite(lng))pts.push({lat,lng});
    };
    if(Array.isArray(element?.geometry))element.geometry.forEach(add);
    if(Array.isArray(element?.members)){
      element.members.forEach(member=>{
        if(Array.isArray(member?.geometry))member.geometry.forEach(add);
      });
    }
    return pts;
  }
  function cleanOsmShape(points){
    const clean=(points||[]).map(toPlain).filter(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng));
    if(clean.length>3&&distance(clean[0],clean[clean.length-1])<1)clean.pop();
    return clean.length>=3?clean:null;
  }
  function shapeCentroid(shape){
    const pts=cleanOsmShape(shape);
    if(!pts)return null;
    let lat=0,lng=0;
    pts.forEach(p=>{lat+=Number(p.lat);lng+=Number(p.lng);});
    return {lat:lat/pts.length,lng:lng/pts.length};
  }
  function greenShapeSpan(shape,center=shapeCentroid(shape)){
    if(!center)return Infinity;
    return Math.max(...(shape||[]).map(p=>distance(center,p)).filter(Number.isFinite),0)*2;
  }
  function osmGreenShapeFromElement(element){
    if(String(element?.tags?.golf||'').toLowerCase()!=='green')return null;
    const direct=cleanOsmShape(osmGuidePointsFromElement(element));
    if(!direct)return null;
    const center=shapeCentroid(direct);
    if(!center)return null;
    const span=greenShapeSpan(direct,center);
    if(span<5||span>OSM_AUTO_GREEN_MAX_SPAN_M)return null;
    return {
      id:`${element.type||'osm'}-${element.id||'green'}`,
      ref:osmGuideHoleRef(element?.tags?.ref||element?.tags?.name),
      center,
      shape:direct,
      span
    };
  }
  function parseOsmHoleGuides(payload){
    const rows=[];
    (payload?.elements||[]).forEach(element=>{
      if(String(element?.tags?.golf||'').toLowerCase()!=='hole')return;
      const hole=osmGuideHoleRef(element?.tags?.ref||element?.tags?.name);
      if(!hole)return;
      const points=osmGuidePointsFromElement(element);
      if(points.length<2)return;
      rows.push({
        id:`${element.type||'osm'}-${element.id||rows.length}`,
        hole,
        par:knownScorecardNumber(element?.tags?.par),
        points
      });
    });
    return rows;
  }
  function parseOsmGreenShapes(payload){
    return (payload?.elements||[]).map(osmGreenShapeFromElement).filter(Boolean);
  }
  function parseOsmGuideBundle(payload){
    return {guides:parseOsmHoleGuides(payload),greens:parseOsmGreenShapes(payload)};
  }
  function cachedOsmGuideBundle(course){
    return null;
  }
  function cachedOsmHoleGuides(course){
    const cached=cachedOsmGuideBundle(course);
    return cached?cached.guides:null;
  }
  async function loadOsmGuideBundle(course=loadUserCourseData(),opts={}){
    const cacheKey=guideCacheKey(course);
    const needsGreens=!!opts.needsGreens;
    if(!opts.fresh&&mapperOsmGuideMemory?.cacheKey===cacheKey&&(!needsGreens||Array.isArray(mapperOsmGuideMemory.greens)))return mapperOsmGuideMemory;
    const cached=cachedOsmGuideBundle(course);
    if(cached&&cached.guides.length&&(!needsGreens||cached.hasGreenCache)){
      mapperOsmGuideMemory={cacheKey,guides:cached.guides,greens:cached.greens};
      return mapperOsmGuideMemory;
    }
    if(mapperOsmGuideFetch?.cacheKey===cacheKey)return mapperOsmGuideFetch.promise;
    const center=guideCoursePoint(course);
    if(!Number.isFinite(center?.lat)||!Number.isFinite(center?.lng))return {guides:[],greens:[]};
	    const query=`[out:json][timeout:18];(way(around:1400,${center.lat},${center.lng})["golf"="hole"];relation(around:1400,${center.lat},${center.lng})["golf"="hole"];way(around:1400,${center.lat},${center.lng})["golf"="green"];relation(around:1400,${center.lat},${center.lng})["golf"="green"];);out geom tags;`;
    const url='https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query);
    const promise=fetch(url,{headers:{Accept:'application/json'}})
      .then(res=>res.ok?res.json():Promise.reject(new Error(`OSM guide ${res.status}`)))
      .then(data=>{
        const bundle=parseOsmGuideBundle(data);
        mapperOsmGuideMemory={cacheKey,guides:bundle.guides,greens:bundle.greens};
        if(!opts.fresh)try{localStorage.setItem(cacheKey,JSON.stringify({savedAt:Date.now(),guides:bundle.guides,greens:bundle.greens}));}catch(e){}
        return mapperOsmGuideMemory;
      })
      .catch(error=>{
        console.warn('[Clarity Caddie] OSM guide fetch failed',error);
        return cached||{guides:[],greens:[]};
      })
      .finally(()=>{if(mapperOsmGuideFetch?.cacheKey===cacheKey)mapperOsmGuideFetch=null;});
    mapperOsmGuideFetch={cacheKey,promise};
    return promise;
  }
  async function loadOsmHoleGuides(course=loadUserCourseData()){
    const bundle=await loadOsmGuideBundle(course);
    return bundle.guides||[];
  }
  function mapperLineGuideName(){
    try{return document.getElementById('mapSourceBtn')?.textContent?.trim()||'OSM Guide';}catch(e){return 'OSM Guide';}
  }
  function setMapperLineGuideSource(){
    try{
      const sources=Array.isArray(window.mapSources)?window.mapSources:null;
      let index=1;
      if(sources){
        const found=sources.findIndex(source=>/osm/i.test(String(source?.key||source?.name||'')));
        if(found>=0)index=found;
      }
      if(typeof setMapSource==='function')setMapSource(index,'mapping-guide');
      updateMapperMapSourceUi();
      return true;
    }catch(e){return false;}
  }
  function guideLineMidpoint(points){
    if(!points?.length)return null;
    return points[Math.max(0,Math.floor(points.length/2))];
  }
	  function drawOsmHoleGuide(hole,guides,opts={}){
	    if(!window.gdFullMappingMode){
	      clearMapperGuideUi();
	      return false;
	    }
	    clearMapperGuideLayers();
	    const h=validHoleNumber(hole);
	    if(!h||typeof L==='undefined'||typeof map==='undefined'||!map)return false;
	    const matches=(guides||[]).filter(guide=>Number(guide.hole)===h&&Array.isArray(guide.points)&&guide.points.length>=2);
	    if(!matches.length)return false;
	    const all=[];
	    let labelPoint=null;
	    matches.forEach(guide=>{
	      const pts=guide.points.map(toLatLng).filter(Boolean);
	      if(pts.length<2)return;
	      all.push(...pts);
	      const glow=L.polyline(pts,{color:'#101820',weight:13,opacity:.44,lineCap:'round',lineJoin:'round',interactive:false}).addTo(map);
	      const line=L.polyline(pts,{color:'#79c7ff',weight:5,opacity:.95,lineCap:'round',lineJoin:'round',interactive:false}).addTo(map);
	      if(!labelPoint)labelPoint=guideLineMidpoint(pts);
	      mapperGuideLayers.push(glow,line);
	    });
	    if(labelPoint){
	      const label=L.marker(labelPoint,{interactive:false,icon:L.divIcon({className:'gdOsmGuideLabel',html:`<span>H${h}</span>`,iconSize:[34,22],iconAnchor:[17,11]})}).addTo(map);
	      mapperGuideLayers.push(label);
	    }
	    if(opts.frame!==false&&all.length){
	      try{
	        map.fitBounds(L.latLngBounds(all).pad(.42),{
          paddingTopLeft:[36,126],
          paddingBottomRight:[116,136],
          animate:true,
          duration:.42,
          maxZoom:17
        });
      }catch(e){}
    }
    return true;
  }
	  function focusOsmHoleGuide(hole,opts={}){
	    if(!window.gdFullMappingMode){
	      clearMapperGuideUi();
	      return false;
	    }
	    const h=validHoleNumber(hole)||mapperHole();
	    if(!mapperOsmGuideUserChoice)setMapperLineGuideSource();
	    const course=loadUserCourseData();
	    const cached=cachedOsmHoleGuides(course);
	    if(cached?.length&&mapperHole()===h)drawOsmHoleGuide(h,cached,opts);
	    loadOsmHoleGuides(course).then(guides=>{
	      if(!window.gdFullMappingMode){
	        clearMapperGuideUi();
	        return;
	      }
	      if(mapperHole()!==h)return;
	      const drawn=drawOsmHoleGuide(h,guides,opts);
	      updateMapperHoleGuide();
	      if(!drawn&&!cached?.length&&course)focusHoleOnMap(course,h);
    });
    return true;
  }
	  function focusMapperHoleReference(hole,opts={}){
	    const h=validHoleNumber(hole)||mapperHole();
	    const course=loadUserCourseData();
	    if(course&&opts.drawObjects!==false)drawHoleObjects(course,h);
	    if(window.gdFullMappingMode)focusOsmHoleGuide(h,{frame:opts.frame!==false});
	    else clearMapperGuideUi();
	    if(course)focusHoleOnMap(course,h);
	    updateMapperHoleGuide();
	    return true;
  }
  function mappedHolePlayData(course,hole){
    const h=validHoleNumber(hole);
    if(!course||!h)return null;
    const objects=objectValues(course).filter(object=>Number(object.holeNumber)===h&&object.confirmed);
    const tee=objects.filter(o=>o.type==='tee'&&o.position).sort((a,b)=>objectSortTime(a).localeCompare(objectSortTime(b)))[0]||null;
    const green=objects.filter(o=>o.type==='green'&&objectCenter(o)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')))[0]||null;
    const fairways=objects.filter(o=>o.type==='fairway'&&o.position).sort((a,b)=>objectSortTime(a).localeCompare(objectSortTime(b)));
    const route=[tee?.position,...fairways.map(o=>o.position),objectCenter(green)].map(toLatLng).filter(Boolean);
    return {hole:h,objects,tee,green,fairways,route,complete:!!(green&&fairways.length&&route.length>=2)};
  }
  function mappedHoleFramePoints(data){
    const pts=[...(data?.route||[])];
    const shape=data?.green&&(data.green.greenShape||data.green.shape);
    if(Array.isArray(shape))shape.forEach(p=>{const ll=toLatLng(p);if(ll)pts.push(ll);});
    return pts;
  }
  function routeLengthM(route=[]){
    const pts=route.map(toLatLng).filter(Boolean);
    let total=0;
    for(let i=1;i<pts.length;i++)total+=distance(pts[i-1],pts[i]);
    return total;
  }
  function projectFramePoint(origin,bearingRad,metres){
    const o=toLatLng(origin);
    if(!o||!Number.isFinite(Number(bearingRad))||!Number.isFinite(Number(metres)))return null;
    try{if(typeof project==='function')return project(o,bearingRad,metres);}catch(e){}
    const earth=111320;
    return L.latLng(
      o.lat+(Math.cos(bearingRad)*metres)/earth,
      o.lng+(Math.sin(bearingRad)*metres)/(earth*Math.cos(o.lat*Math.PI/180))
    );
  }
  function projectFrameOffset(origin,bearingRad,forwardM,sideM){
    const base=projectFramePoint(origin,bearingRad,forwardM);
    return base?projectFramePoint(base,bearingRad+Math.PI/2,sideM):null;
  }
  function mappedHoleFrameProfile(data){
    const length=routeLengthM(data?.route||[]);
    const par=typeof knownParForHole==='function'?knownParForHole(data?.hole):null;
    const effectiveLength=Math.max(length,par>=5?520:par===4?340:par===3?120:0);
    if(effectiveLength>=520)return {length,effectiveLength,maxZoom:17,settledMaxZoom:17,pad:.2,lateral:74,startBack:46,endBeyond:66};
    if(effectiveLength>=360)return {length,effectiveLength,maxZoom:18,settledMaxZoom:18,pad:.16,lateral:54,startBack:32,endBeyond:46};
    if(effectiveLength>=220)return {length,effectiveLength,maxZoom:18,settledMaxZoom:18,pad:.14,lateral:42,startBack:24,endBeyond:34};
    if(effectiveLength>=120)return {length,effectiveLength,maxZoom:18,settledMaxZoom:18,pad:.12,lateral:32,startBack:18,endBeyond:26};
    return {length,effectiveLength,maxZoom:18,settledMaxZoom:18,pad:.1,lateral:24,startBack:12,endBeyond:18};
  }
  function settleMappedHoleZoom(profile){
    try{
      if(!map||!profile||!Number.isFinite(Number(profile.settledMaxZoom))||!map.getZoom||!map.setZoom)return false;
      const current=Number(map.getZoom());
      if(!Number.isFinite(current)||current<=profile.settledMaxZoom)return false;
      map.setZoom(profile.settledMaxZoom,{animate:true});
      return true;
    }catch(e){return false;}
  }
  function mappedHoleViewPoints(data){
    const pts=mappedHoleFramePoints(data);
    const route=(data?.route||[]).map(toLatLng).filter(Boolean);
    if(route.length>=2){
      const profile=mappedHoleFrameProfile(data);
      const axis=mappedFairwayAxisFromData(data,null);
      const bearingRad=Number.isFinite(axis?.bearingRad)?axis.bearingRad:(typeof bearing==='function'?bearing(route[0],route[route.length-1]):null);
      if(Number.isFinite(Number(bearingRad))){
        const tee=route[0];
        const green=route[route.length-1];
        [
          projectFramePoint(tee,bearingRad+Math.PI,profile.startBack),
          projectFramePoint(green,bearingRad,profile.endBeyond),
          projectFrameOffset(tee,bearingRad,Math.max(20,profile.length*.24),-profile.lateral),
          projectFrameOffset(tee,bearingRad,Math.max(20,profile.length*.24),profile.lateral),
          projectFrameOffset(tee,bearingRad,Math.max(30,profile.length*.62),-profile.lateral),
          projectFrameOffset(tee,bearingRad,Math.max(30,profile.length*.62),profile.lateral),
          projectFrameOffset(tee,bearingRad,Math.max(40,profile.length*.9),-profile.lateral*.72),
          projectFrameOffset(tee,bearingRad,Math.max(40,profile.length*.9),profile.lateral*.72)
        ].forEach(p=>{const ll=toLatLng(p);if(ll)pts.push(ll);});
      }
    }
    return pts;
  }
  function mappedFairwayAxisFromData(data,pivotLike=null){
    try{
      const route=Array.isArray(data?.route)?data.route.map(toLatLng).filter(Boolean):[];
      if(route.length<2)return null;
      const fallback={a:route[0],b:route[route.length-1],index:0,source:'mapped-hole'};
      const pivot=toLatLng(pivotLike);
      if(!pivot||!data?.fairways?.length){
        const bearingRad=typeof bearing==='function'?bearing(fallback.a,fallback.b):Math.atan2(fallback.b.lng-fallback.a.lng,fallback.b.lat-fallback.a.lat);
        return Number.isFinite(bearingRad)?{source:fallback.source,bearingRad,hole:data.hole,segmentIndex:fallback.index,start:toPlain(fallback.a),end:toPlain(fallback.b)}:null;
      }
      let best=null;
      for(let i=0;i<route.length-1;i++){
        const a=route[i],b=route[i+1];
        const mid={lat:(a.lat+b.lat)/2,lng:(a.lng+b.lng)/2};
        const score=distance(pivot,mid);
        if(!best||score<best.score)best={a,b,score,index:i};
      }
      if(!best)best=fallback;
      const bearingRad=typeof bearing==='function'?bearing(best.a,best.b):Math.atan2(best.b.lng-best.a.lng,best.b.lat-best.a.lat);
      return Number.isFinite(bearingRad)?{source:'mapped-fairway',bearingRad,hole:data.hole,segmentIndex:best.index,start:toPlain(best.a),end:toPlain(best.b)}:null;
    }catch(e){return null;}
  }
  function pointAlongRoute(route=[],metres=0){
    const pts=route.map(toLatLng).filter(Boolean);
    if(!pts.length)return null;
    let remaining=Math.max(0,Number(metres)||0);
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      const seg=distance(a,b);
      if(!Number.isFinite(seg)||seg<=0)continue;
      if(remaining<=seg){
        const brg=typeof bearing==='function'?bearing(a,b):Math.atan2(b.lng-a.lng,b.lat-a.lat);
        return projectFramePoint(a,brg,remaining);
      }
      remaining-=seg;
    }
    return pts[pts.length-1];
  }
  function sampleRouteProgress(route=[],stepM=7){
    const pts=route.map(toLatLng).filter(Boolean);
    if(!pts.length)return [];
    const samples=[{point:pts[0],progress:0}];
    let progress=0;
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      const seg=distance(a,b);
      if(!Number.isFinite(seg)||seg<=0)continue;
      const brg=typeof bearing==='function'?bearing(a,b):Math.atan2(b.lng-a.lng,b.lat-a.lat);
      const steps=Math.max(1,Math.ceil(seg/Math.max(3,Number(stepM)||7)));
      for(let s=1;s<=steps;s++){
        const along=seg*(s/steps);
        const point=projectFramePoint(a,brg,along);
        if(point)samples.push({point,progress:progress+along});
      }
      progress+=seg;
    }
    return samples;
  }
  function fairwayLayupTargetByShotDistance(route=[],startLike,carryM){
    const startLL=toLatLng(startLike);
    const maxCarry=Number(carryM);
    const samples=sampleRouteProgress(route,7);
    if(!startLL||!(maxCarry>0)||samples.length<2)return null;
    let nearest=samples[0];
    samples.forEach(sample=>{
      const score=distance(startLL,sample.point);
      if(!nearest||score<nearest.score)nearest={...sample,score};
    });
    const minProgress=Math.max(0,Number(nearest?.progress)||0);
    let best=null;
    samples.forEach(sample=>{
      if(sample.progress<minProgress+6)return;
      const direct=distance(startLL,sample.point);
      if(!Number.isFinite(direct)||direct>maxCarry+3)return;
      const score=Math.abs(maxCarry-direct);
      if(!best||score<best.score-0.75||(Math.abs(score-best.score)<=0.75&&sample.progress>best.progress)){
        best={...sample,direct,score};
      }
    });
    if(!best||best.direct<Math.max(45,maxCarry*.58))return null;
    return best.point;
  }
  function mappedFairwayLayupTarget(startLike,greenLike,carryM){
    try{
      if(!mappedCourseAssistEnabled()||window.gdFullMappingMode)return null;
      const h=validHoleNumber(mappedPlayAssist?.hole)||activePlayingHole()||mapperHole()||holeNumber()||validHoleNumber(window.gdMapperActiveHole);
      const data=mappedHolePlayData(loadUserCourseData(),h);
      if(!data?.complete||!data.fairways.length)return null;
      const startLL=toLatLng(startLike);
      const greenLL=toLatLng(greenLike)||objectCenter(data.green);
      const maxCarry=Number(carryM);
      if(!startLL||!greenLL||!(maxCarry>0))return null;
      if(distance(startLL,greenLL)<=maxCarry+3)return greenLL;
      const route=data.route.map(toLatLng).filter(Boolean);
      return fairwayLayupTargetByShotDistance(route,startLL,maxCarry)||null;
    }catch(e){return null;}
  }
  function orientCameraToMappedHole(data,pivot=null,frameRun=mappedFrameRunId){
    try{
      const axis=mappedFairwayAxisFromData(data,pivot);
      if(axis&&typeof window.gdOrientGpsCameraToBearing==='function'){
        scheduleMappedFrameTask(frameRun,80,()=>window.gdOrientGpsCameraToBearing(axis.bearingRad,'mapped-hole-play-up'));
        return true;
      }
    }catch(e){}
    return false;
  }
  function frameMappedHoleForPlay(course,hole,opts={}){
    if(!mappedCourseAssistEnabled())return false;
    const data=mappedHolePlayData(course,hole);
    if(!data||!data.route.length)return false;
    const frameRun=nextMappedFrameRun();
    const lockRun=nextMappedLockRun();
    stopMappedMapMotion();
    try{drawHoleObjects(course,data.hole,{editable:false,playDetail:false});}catch(e){}
    try{
      const pts=mappedHoleViewPoints(data);
      const profile=mappedHoleFrameProfile(data);
      if(pts.length>1){
        map.fitBounds(L.latLngBounds(pts).pad(data.complete ? profile.pad : Math.max(.2,profile.pad)),{
          paddingTopLeft:[28,112],
          paddingBottomRight:[108,118],
          animate:true,
          duration:.42,
          maxZoom:data.complete?profile.maxZoom:Math.min(17,profile.maxZoom)
        });
      }else if(pts.length===1){
        map.setView(pts[0],Math.max(map.getZoom(),17),{animate:true});
      }
      orientCameraToMappedHole(data,start||null,frameRun);
      scheduleMappedFrameTask(frameRun,540,()=>settleMappedHoleZoom(profile));
      scheduleMappedFrameTask(frameRun,980,()=>settleMappedHoleZoom(profile));
      scheduleMappedFrameTask(frameRun,1600,()=>settleMappedHoleZoom(profile));
    }catch(e){}
    mappedPlayAssist={
      armed:!!data.complete,
      hole:data.hole,
      courseKey:course?.id||course?.courseId||courseId(),
      locked:false,
      lastFrameAt:Date.now()
    };
    if(data.complete){
      try{setState(`Hole ${data.hole}`);}catch(e){}
      if(opts.promptStart)hintSafe('Tap where you are standing');
      else if(!opts.quiet)hintSafe('Mapped hole ready');
      try{
        if(start&&!opts.promptStart&&!opts.skipAutoLock){
          scheduleMappedLockTask(lockRun,80,()=>maybeLockMappedHoleFromStart(start,'mapped-hole-frame',{allowAnyStart:!!opts.allowAnyStart,lockRun}));
        }
      }catch(e){}
    }
    return !!data.complete;
  }
  function mappedAssistData(){
    if(!mappedCourseAssistEnabled())return null;
    if(!mappedPlayAssist?.armed||mappedPlayAssist.locked||window.gdFullMappingMode)return null;
    const course=loadUserCourseData();
    const data=mappedHolePlayData(course,mappedPlayAssist.hole);
    return data?.complete?data:null;
  }
  function mappedFairwayAxisForShot(startLike,targetLike){
    try{
      if(!mappedCourseAssistEnabled()||window.gdFullMappingMode)return null;
      const h=validHoleNumber(mappedPlayAssist?.hole)||activePlayingHole()||mapperHole()||holeNumber()||validHoleNumber(window.gdMapperActiveHole);
      if(!h)return null;
      const data=mappedHolePlayData(loadUserCourseData(),h);
      return mappedFairwayAxisFromData(data,toLatLng(startLike)||toLatLng(targetLike));
    }catch(e){return null;}
  }
  function armMappedAssistForHole(hole,opts={}){
    if(!mappedCourseAssistEnabled()||window.gdFullMappingMode)return null;
    const h=validHoleNumber(hole)||activePlayingHole()||holeNumber()||1;
    const course=loadUserCourseData();
    const data=mappedHolePlayData(course,h);
    if(!data?.complete)return null;
    if(opts.draw!==false){
      try{drawHoleObjects(course,data.hole,{editable:false,playDetail:false});}catch(e){}
    }
    mappedPlayAssist={
      armed:true,
      hole:data.hole,
      courseKey:course?.id||course?.courseId||courseId(),
      locked:false,
      lastFrameAt:Date.now()
    };
    return data;
  }
  function mappedAssistReadyForLock(ll,data=mappedAssistData()){
    const here=toLatLng(ll);
    const anchor=toLatLng(data?.tee?.position)||toLatLng(data?.fairways?.[0]?.position)||toLatLng(data?.route?.[0]);
    if(!here||!anchor)return false;
    return distance(here,anchor)<=MAPPED_PLAY_TEE_LOCK_RADIUS_M;
  }
  function maybeLockMappedHoleFromStart(ll,reason='gps-start',opts={}){
    if(pinLockBusy())return false;
    if(opts.lockRun!=null&&!mappedLockRunActive(opts.lockRun))return false;
    const data=mappedAssistData();
    if(!data||target||lockedFrame)return false;
    if(!opts.allowAnyStart&&!mappedAssistReadyForLock(ll,data))return false;
    const green=asGreenRecord(data.green);
    if(!green?.greenCenter)return false;
    try{rememberPlayingHole(data.hole);}catch(e){}
    try{mode='green';}catch(e){}
    if(!drawSavedGreen(green,{quiet:true,applyTarget:true,frame:true}))return false;
    mappedPlayAssist.locked=true;
    try{window.gdMappedGreenAutoLockedUntil=Date.now()+1600;}catch(e){}
    try{setState(`Hole ${data.hole}`);}catch(e){}
    try{hideHint&&hideHint();}catch(e){}
    toastSafe('Mapped hole locked');
    return true;
  }
  function forceLockMappedGreenFromStart(ll,reason='gps-start',opts={}){
    if(pinLockBusy()||target||lockedFrame)return false;
    const h=activePlayingHole()||mapperHole()||holeNumber()||1;
    if(!armMappedAssistForHole(h,{draw:true}))return false;
    return maybeLockMappedHoleFromStart(ll,reason,{allowAnyStart:true,lockRun:opts.lockRun});
  }
  function reassertMappedHoleLockFromStart(ll,lockRun=null){
    try{
      if(pinLockBusy())return false;
      if(lockRun!=null&&!mappedLockRunActive(lockRun))return false;
      if(target&&lockedFrame)return true;
      if(mappedPlayAssist?.locked)mappedPlayAssist.locked=false;
      return maybeLockMappedHoleFromStart(ll,'mapped-two-tap-reassert',{allowAnyStart:true,lockRun});
    }catch(e){return false;}
  }
  function scheduleMappedTwoTapDefaultGreen(ll){
    if(!mappedCourseAssistEnabled())return false;
    if(pinLockBusy())return false;
    const data=mappedAssistData();
    if(!data?.complete||target||lockedFrame)return false;
    const lockRun=nextMappedLockRun();
    try{window.gdMappedGreenAutoLockedUntil=Date.now()+1600;}catch(e){}
    scheduleMappedLockTask(lockRun,40,()=>reassertMappedHoleLockFromStart(ll,lockRun));
    scheduleMappedLockTask(lockRun,220,()=>reassertMappedHoleLockFromStart(ll,lockRun));
    return true;
  }
  function shouldHoldMappedAssistUntilCloser(ll){
    if(!mappedCourseAssistEnabled())return false;
    const data=mappedAssistData();
    return !!(data&&!target&&!lockedFrame&&!mappedAssistReadyForLock(ll,data));
  }
  function reportMappedDropout(hole,reason='mapped-data',opts={}){
    const h=validHoleNumber(hole)||activePlayingHole()||mapperHole()||holeNumber()||1;
    const key=`${mappedModeCourseIdentity()}::${h}::${reason}`;
    const now=Date.now();
    const duplicate=mappedDropoutNotice.key===key&&now-mappedDropoutNotice.at<1800;
    mappedDropoutNotice={key,at:now};
    try{console.warn('[Clarity Caddie] mapped data dropout',{course:mappedModeCourseIdentity(),hole:h,reason});}catch(e){}
    if(opts.quiet)return false;
    if(!duplicate){
      try{setState('Mapped data needed');}catch(e){}
      hintSafe(`Mapped data missing for H${h}`);
      toastSafe(`Mapped data missing for H${h}`);
    }
    return false;
  }
	  function focusMappedHoleOrSavedGreen(hole,opts={}){
	    if(!mappedCourseAssistEnabled())return false;
	    const h=validHoleNumber(hole)||activePlayingHole()||holeNumber()||1;
	    try{
	      const selected=opts.course||null;
	      const course=selected?loadUserCourseData(userId(),courseId(selected)):loadUserCourseData();
	      if(course&&frameMappedHoleForPlay(course,h,opts))return true;
	    }catch(e){}
	    return reportMappedDropout(h,'focus',{quiet:!!opts.quiet});
  }
  window.gdFocusMappedHoleOrSavedGreen=focusMappedHoleOrSavedGreen;
  function applyMappedOrSavedGreenAfterStart(ll,saveUndo,reason='set-start',opts={}){
    try{
      if(pinLockBusy())return false;
      if(opts.lockRun!=null&&!mappedLockRunActive(opts.lockRun))return false;
      if(target&&lockedFrame)return true;
      if(mappedCourseAssistEnabled()){
        const mappedLocked=maybeLockMappedHoleFromStart(ll,`${reason}-mapped`,{allowAnyStart:true,lockRun:opts.lockRun})||forceLockMappedGreenFromStart(ll,`${reason}-mapped`,{lockRun:opts.lockRun});
        if(mappedLocked||target)return true;
        return reportMappedDropout(activePlayingHole()||mapperHole()||holeNumber()||1,`${reason}-lock`,{quiet:true});
      }
      if(window.gdPendingLibraryGreenRecord){
        const rec=window.gdPendingLibraryGreenRecord;
        window.gdPendingLibraryGreenRecord=null;
        return !!drawSavedGreen(rec,{quiet:true,applyTarget:true,frame:true});
      }
      if(shouldAutoRestoreSavedGreen({fromSetStart:true,force:true})){
        return !!loadSavedGreenForActiveHole({quiet:true,applyTarget:true,frame:true,force:true});
      }
    }catch(e){}
    return false;
  }
  function scheduleMappedOrSavedGreenAfterStart(ll,saveUndo,reason='set-start'){
    if(!ll)return false;
    const mapped=mappedCourseAssistEnabled();
    const lockRun=mapped?nextMappedLockRun():null;
    [0,90,260,720].forEach(delay=>{
      if(mapped) scheduleMappedLockTask(lockRun,delay,()=>applyMappedOrSavedGreenAfterStart(ll,saveUndo,reason,{lockRun}));
      else setTimeout(()=>applyMappedOrSavedGreenAfterStart(ll,saveUndo,reason),delay);
    });
    return true;
  }
  function redrawMappedPlayOverlay(playDetail=false){
    if(!mappedCourseAssistEnabled())return false;
    if(window.gdFullMappingMode)return false;
    try{
      const course=loadUserCourseData();
      const h=validHoleNumber(activePlayingHole())||validHoleNumber(holeNumber())||mapperHole();
      if(!course||!h)return false;
      const objects=objectsForHole(course,h);
      if(!objects.length)return false;
      drawHoleObjects(course,h,{editable:false,playDetail:!!playDetail});
      return true;
    }catch(e){return false;}
  }
  function focusCourseObject(object,opts={}){
    if(!object?.position)return false;
    const ll=toLatLng(object.position);
    if(!ll)return false;
    if(object.type==='green'&&window.gdFullMappingMode){
      drawMapperGreenObject(object);
    }else if(object.type==='green'){
      drawSavedGreen(asGreenRecord(object),opts);
    }else{
      drawCourseObjectPin(object);
    }
    try{map.setView(ll,Math.max(map.getZoom(),18),{animate:true});}catch(e){}
    return true;
  }
  function saveOrUpdateUserGreen(input={}){
    const uid=input.userId||userId();
    const cid=input.courseId||courseId();
    const h=Number(input.holeNumber||holeNumber())||1;
    const center=input.greenCenter?toPlain(input.greenCenter):(()=>{try{return greenCentre?toPlain(greenCentre):null;}catch(e){return null;}})();
    if(!center)return null;
    const c=courseObj();
    const store=loadStore();
    const course=ensureCourse(store,uid,cid,input.courseName||courseName(c),c);
    const prev=confirmedGreenRecord(course,h)||legacyGreenRecord(course,h)||null;
    const greenSource=input.greenSource||'unknown';
    const shape=input.greenShape? simplifyShape(input.greenShape,64) : shapeForSave(greenSource,center,prev);
    const activeHole=activePlayingHole();
    const shouldLinkHole=!!(input.confirmed||input.assignHole||activeHole);
    const holeForSave=shouldLinkHole?(activeHole||h):null;
    const object=saveCourseObject({
      userId:uid,
      courseId:cid,
      courseName:input.courseName||courseName(c),
      type:'green',
      position:center,
      shape,
      source:greenSource,
      holeNumber:holeForSave,
      confirmed:shouldLinkHole
    });
    const savedObject=object&&shouldLinkHole?(assignObjectToHole(object.id,holeForSave,true)||object):object;
    syncManualShapeVisual(prev,center,shape,greenSource);
    gdCLRefreshProfileCard();
    return savedObject;
  }
  function loadUserCourseData(uid=userId(),cid=courseId()){
    const store=loadStore();
    const privateCourse=store.courses[findCourseKey(store,uid,cid)]||null;
    const published=findPublishedCourse(cid,privateCourse?.courseName||courseName(),privateCourse||courseObj());
    return mergeCourseData(privateCourse,published,uid);
  }
  function resetUserGreen(uid=userId(),cid=courseId(),h=holeNumber()){
    const store=loadStore();
    const key=findCourseKey(store,uid,cid);
    const course=store.courses[key];
    if(!course)return false;
    let changed=false;
    Object.values(course.objects||{}).forEach(object=>{
      if(object?.type==='green'&&Number(object.holeNumber)===Number(h)){
        delete course.objects[object.id];
        changed=true;
      }
    });
    if(course?.holes?.[h]){
      delete course.holes[h];
      changed=true;
    }
    if(!changed)return false;
    course.updatedAt=nowIso();
    saveStore(store);
    gdCLRefreshProfileCard();
    updateMapperToolCompletion();
    return true;
  }
  function currentCourseStorageLabel(opts={}){
    const allowAssumed=!!opts.allowAssumed;
    const candidates=[];
    try{if(typeof currentCourse!=='undefined'&&currentCourse)candidates.push(currentCourse);}catch(e){}
    try{if(window.currentCourse)candidates.push(window.currentCourse);}catch(e){}
    try{if(window.gdActiveCourse)candidates.push(window.gdActiveCourse);}catch(e){}
    try{
      const active=JSON.parse(localStorage.getItem('gd_active_course_v1')||'null');
      if(active)candidates.push(active);
    }catch(e){}
    for(const c of candidates){
      const name=String(c?.name||c?.courseName||'').trim();
      if(isUsefulCourseName(name))return name;
    }
    if(allowAssumed)return courseName(sessionCourse(courseObj()));
    return '';
  }
  function assumedCourseCandidate(){
    const center=mapSessionCenter();
    const base=courseObj();
    const session=base?sessionCourse(base):null;
    const selected=currentCourseStorageLabel();
    const sessionName=session&&!session.assumed?session.name:'';
    const name=selected||sessionName||assumedCourseLabel(center);
    const lat=Number(session?.lat??session?.latitude??center.lat);
    const lng=Number(session?.lng??session?.longitude??center.lng);
    return {name,courseId:session?.courseId||assumedCourseId(center),lat,lng,distanceM:session?.distanceM,assumedCandidate:true,source:session?.source||'assumed-course-candidate'};
  }
  function syncCoursePickerAssumption(){
    try{
      const screen=document.getElementById('courseScreen');
      const list=document.getElementById('courseList');
      const input=document.getElementById('searchInput');
      if(!screen||screen.classList.contains('hidden')||!list)return;
      const candidate=assumedCourseCandidate();
      if(typeof window.gdRefreshCourseAssumedOption==='function')window.gdRefreshCourseAssumedOption(candidate);
      if(input&&!input.value.trim()&&!document.getElementById('gdCourseAssumedOption'))input.value=candidate.name;
      const hasManualOnly=/Manual GPS/i.test(list.textContent||'')&&!isUsefulCourseName(list.textContent||'');
      const shouldReplace=hasManualOnly||!list.children.length;
      if(shouldReplace&&typeof window.renderCourses==='function'){
        window.renderCourses([candidate]);
        const count=document.getElementById('countLine');
        if(count)count.textContent='Search';
      }
    }catch(e){}
  }
  function nearbySavedCourses(center=mapSessionCenter(),maxDistance=1400){
    return libraryCourses()
      .filter(course=>isUsefulCourseName(course.courseName))
      .map(course=>{
        const lat=Number(course.courseLat), lng=Number(course.courseLng);
        if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
        return {...course,distanceM:distance(center,{lat,lng})};
      })
      .filter(Boolean)
      .filter(course=>course.distanceM<=maxDistance)
      .sort((a,b)=>a.distanceM-b.distanceM);
  }
  function courseCandidateCount(){
    try{return nearbySavedCourses().length;}catch(e){return 0;}
  }
  function ensureAssumedCourseBadge(){
    const label=currentCourseStorageLabel();
    applyVisibleCourseLabel(label);
    const chip=document.getElementById('gdAssumedCourseBadge');
    if(chip)chip.remove();
    try{if(typeof gdHydrateGpsBadge==='function')gdHydrateGpsBadge(true);}catch(e){}
  }
  function ensureCourseConfirmationOverlay(){
    let el=document.getElementById('gdCourseConfirmOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdCourseConfirmOverlay';
    el.className='gdCourseConfirmOverlay hidden';
    el.innerHTML=`<div class="gdCourseConfirmSheet"><div class="gdCourseConfirmHead"><div><h2>Playing at</h2><p>Confirm the course label for this GPS session. Saved mapper data will live under this course.</p></div><button class="gdSheetClose" type="button" onclick="gdCloseCourseConfirmation()">×</button></div><div id="gdCourseConfirmBody"></div></div>`;
    el.addEventListener('click',ev=>{if(ev.target===el)gdCloseCourseConfirmation();});
    document.body.appendChild(el);
    return el;
  }
  function renderCourseConfirmation(){
    const body=document.getElementById('gdCourseConfirmBody');
    if(!body)return;
    const label=currentCourseStorageLabel();
    const center=mapSessionCenter();
    const candidates=nearbySavedCourses(center);
    const currentNorm=normalizeCourseName(label);
    const rows=candidates
      .filter(course=>normalizeCourseName(course.courseName)!==currentNorm)
      .slice(0,5)
      .map(course=>`<button class="gdCourseCandidate" type="button" data-course-name="${esc(course.courseName)}"><strong>${esc(course.courseName)}</strong><span>${Math.round(course.distanceM)}m away · ${courseSummaryLine(courseSummary(course))}</span></button>`)
      .join('');
    body.innerHTML=`<div class="gdCourseCurrent"><span>Current session</span><strong>${esc(label)}</strong><small>${isUsefulCourseName(label)?'Selected course label':'Assumed from current GPS/map position'}</small></div>${rows?`<div class="gdCourseCandidateList"><p>Nearby saved courses</p>${rows}</div>`:`<div class="gdCourseCandidateEmpty">No nearby saved courses yet. Search by name if this assumption is wrong.</div>`}<div class="gdCourseConfirmActions"><button type="button" id="gdKeepCourseGuessBtn">Keep this</button><button type="button" id="gdSearchCourseGuessBtn">Change course</button></div>`;
    body.querySelectorAll('[data-course-name]').forEach(btn=>{
      btn.onclick=function(ev){
        ev.preventDefault();
        setAssumedCourseName(btn.getAttribute('data-course-name')||'');
        gdCloseCourseConfirmation();
        toastSafe('Course label updated');
      };
    });
    const keep=body.querySelector('#gdKeepCourseGuessBtn');
    if(keep)keep.onclick=function(ev){ev.preventDefault();gdCloseCourseConfirmation();};
    const search=body.querySelector('#gdSearchCourseGuessBtn');
    if(search)search.onclick=function(ev){ev.preventDefault();window.gdSearchCourseForCurrentSession&&window.gdSearchCourseForCurrentSession();};
  }
  window.gdOpenCourseConfirmation=function(){
    ensureCourseConfirmationOverlay().classList.remove('hidden');
    renderCourseConfirmation();
    ensureAssumedCourseBadge();
  };
  window.gdCloseCourseConfirmation=function(){
    document.getElementById('gdCourseConfirmOverlay')?.classList.add('hidden');
  };
  window.gdUseCourseForCurrentSession=function(name){
    setAssumedCourseName(name);
    gdCloseCourseConfirmation();
    toastSafe('Course label updated');
  };
  window.gdSearchCourseForCurrentSession=function(){
    gdCloseCourseConfirmation();
    window.gdCourseChangeMode='assumed-label';
    try{closeCourseLibraryPanel();}catch(e){}
    try{gdCloseMapperTools();}catch(e){}
    try{if(typeof enterGpsModule==='function')enterGpsModule({preserveState:true});}catch(e){}
    setTimeout(()=>{
      try{
        const screen=document.getElementById('courseScreen');
        const input=document.getElementById('searchInput');
        if(screen)screen.classList.remove('hidden');
        if(input){input.value=isUsefulCourseName(currentCourseStorageLabel())?currentCourseStorageLabel():'';input.focus();}
        syncCoursePickerAssumption();
        toastSafe('Search or choose the course label');
      }catch(e){}
    },80);
  };
  window.gdChangeAssumedCourse=function(){
    window.gdOpenCourseConfirmation&&window.gdOpenCourseConfirmation();
  };
  function clearNativeGreenReferenceLayers(){
    try{
      [greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(layer=>layer&&map.removeLayer(layer));
      greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;
    }catch(e){}
  }
  function shouldHideSavedGreenReferenceGeometry(record,opts={}){
    if(opts.showReferenceGeometry===true||window.gdFullMappingMode)return false;
    if(opts.hideReferenceGeometry===true)return true;
    try{
      const h=validHoleNumber(record?.holeNumber)||activePlayingHole()||mapperHole()||holeNumber();
      const course=loadUserCourseData(record?.userId||userId(),record?.courseId||courseId());
      return !!courseHasMappedGreenFairway(course,h);
    }catch(e){return false;}
  }
  function drawSavedGreen(record,opts={}){
    if(!record?.greenCenter)return false;
    const center=toLatLng(record.greenCenter);
    if(!center)return false;
    applyingSavedGreen=true;
    try{
      greenCentre=center;
      if(!target&&opts.applyTarget&&typeof setGreenTarget==='function'){
        setGreenTarget(center,true);
      }else{
        if(!greenMarker)greenMarker=L.circleMarker(center,{radius:8,color:'#1fd36d',weight:2,opacity:.82,fillColor:'#1fd36d',fillOpacity:.08,interactive:false}).addTo(map);
        else greenMarker.setLatLng(center);
      }
      if(Array.isArray(record.greenShape)&&record.greenShape.length>=3&&typeof drawGreenPolygon==='function'){
        const pts=record.greenShape.map(toLatLng).filter(Boolean);
        if(pts.length>=3){
          if(shouldHideSavedGreenReferenceGeometry(record,opts)){
            try{greenPolygon=pts;}catch(e){}
            clearNativeGreenReferenceLayers();
            try{if(typeof renderShot==='function')renderShot();}catch(e){}
          }else{
            drawGreenPolygon(pts,'saved green',{settled:true});
          }
        }
      }else{
        try{greenPolygon=null;}catch(e){}
        clearNativeGreenReferenceLayers();
        try{if(typeof renderShot==='function')renderShot();}catch(e){}
      }
      if(opts.frame&&typeof map!=='undefined'&&map){
        if(start&&target&&typeof lockFrame==='function')lockFrame(true);
        else map.setView(center,Math.max(map.getZoom(),18),{animate:true});
      }
    }catch(e){
      console.warn('saved green draw failed',e);
    }finally{
      setTimeout(()=>{applyingSavedGreen=false;},0);
    }
    return true;
  }
  function loadSavedGreenForActiveHole(opts={}){
    if(!shouldAutoRestoreSavedGreen(opts))return null;
    const rec=activeGreenRecord();
    if(!rec)return null;
    drawSavedGreen(rec,opts);
    return rec;
  }
  function mapperGreenRecordForWand(){
    const h=mapperHole();
    const confirmed=activeGreenRecord(userId(),courseId(),h,{includeLegacy:true});
    if(confirmed?.greenCenter)return confirmed;
    const course=loadUserCourseData();
    if(!course||!h)return null;
    const object=objectValues(course,'green')
      .filter(o=>Number(o.holeNumber)===Number(h)&&(o.greenCenter||o.position))
      .sort((a,b)=>{
        const aShape=Array.isArray(a.greenShape||a.shape)&&(a.greenShape||a.shape).length>=3?1:0;
        const bShape=Array.isArray(b.greenShape||b.shape)&&(b.greenShape||b.shape).length>=3?1:0;
        const aConfirmed=a.confirmed?1:0;
        const bConfirmed=b.confirmed?1:0;
        return (bShape-aShape)||(bConfirmed-aConfirmed)||String(b.updatedAt||'').localeCompare(String(a.updatedAt||''));
      })[0];
    return object?asGreenRecord(object):null;
  }
  function hydrateMapperGreenForWand(){
    const rec=mapperGreenRecordForWand();
    if(!rec?.greenCenter)return false;
    if(rec.confirmed&&drawSavedGreen(rec,{quiet:true}))return true;
    const center=toLatLng(rec.greenCenter);
    if(!center)return false;
    try{greenCentre=center;}catch(e){}
    const pts=Array.isArray(rec.greenShape)&&rec.greenShape.length>=3?rec.greenShape.map(toLatLng).filter(Boolean):[];
    if(pts.length>=3&&typeof drawGreenPolygon==='function'){
      try{drawGreenPolygon(pts,'saved green',{settled:true});}catch(e){}
    }
    return true;
  }
	  function saveCurrentGreen(source='manual'){
	    if(applyingSavedGreen)return null;
	    try{if(!greenCentre)return null;}catch(e){return null;}
	    const ctx=mapperContext();
	    const record=saveOrUpdateUserGreen({greenSource:ctx==='green'?`${source}_tools`:source});
	    if(record&&ctx==='green')toastSafe('Green saved to Course Library');
	    if(record)updateMapperToolCompletion();
	    return record;
	  }
  function resetActiveGreen(){
    const h=mapperHole()||activePlayingHole()||holeNumber();
    const ok=resetUserGreen(userId(),courseId(),h);
    if(ok){
      try{greenPolygon=null;}catch(e){}
      try{greenCentre=null;}catch(e){}
      try{[greenMarker,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(l=>l&&map.removeLayer(l));greenMarker=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;}catch(e){}
      updateMapperToolCompletion();
      toastSafe(`Hole ${h} green forgotten`);
    }else toastSafe('No saved green for this hole');
    renderCourseLibraryPanel();
  }
  function moveActiveGreenToHole(nextHole=null){
    const fromHole=mapperHole()||activePlayingHole()||holeNumber();
    const prompted=nextHole==null?window.prompt('Move this green to hole, or leave blank to unassign',String(fromHole)):nextHole;
    if(String(prompted??'').trim()==='')return unassignActiveGreen();
    const toHole=validHoleNumber(prompted);
    if(!toHole){toastSafe('Enter a valid hole number');return null;}
    if(toHole===fromHole){toastSafe(`Green is already on H${toHole}`);return null;}
    const store=loadStore();
    const uid=userId(),cid=courseId();
    const key=findCourseKey(store,uid,cid);
    const course=store.courses[key];
    const rec=activeGreenRecord(uid,cid,fromHole);
    if(!course||!rec){toastSafe(`No saved green on H${fromHole}`);return null;}
    let object=rec.id?course.objects?.[rec.id]:null;
    if(!object){
      object=saveCourseObject({
        userId:uid,
        courseId:cid,
        courseName:course.courseName,
        type:'green',
        position:rec.greenCenter,
        shape:rec.greenShape,
        source:rec.greenSource||'moved_green',
        holeNumber:toHole,
        confirmed:true
      });
      resetUserGreen(uid,cid,fromHole);
    }
    const moved=object?assignObjectToHole(object.id,toHole,true,uid,cid):null;
    rememberPlayingHole(toHole);
    updateMapperHoleUi();
    updateMapperToolCompletion();
    renderCourseLibraryPanel(course.id);
    toastSafe(moved?`Green moved to H${toHole}`:'Could not move green');
    return moved;
  }
  function unassignActiveGreen(){
    const h=mapperHole()||activePlayingHole()||holeNumber();
    const rec=activeGreenRecord(userId(),courseId(),h);
    if(!rec){toastSafe(`No allocated green on H${h}`);return null;}
    let object=null;
    if(rec.id)object=unassignObjectFromHole(rec.id,userId(),courseId());
    if(!object&&rec.legacy){
      object=saveCourseObject({
        userId:userId(),
        courseId:courseId(),
        courseName:courseName(courseObj()),
        type:'green',
        position:rec.greenCenter,
        shape:rec.greenShape,
        source:rec.greenSource||'unassigned_green',
        holeNumber:null,
        confirmed:false
      });
      resetUserGreen(userId(),courseId(),h);
    }
    updateMapperToolCompletion();
    renderCourseLibraryPanel();
    toastSafe(object?`Green unassigned from H${h}`:`No allocated green on H${h}`);
    return object;
  }
  function savedHoleCount(){
    const store=loadStore();
    const uid=userId();
    return Object.values(store.courses||{})
      .filter(course=>course.userId===uid)
      .reduce((total,course)=>{
        const objects=objectValues(course);
        const legacy=Object.values(course.holes||{}).filter(h=>!objects.some(o=>o.confirmed&&Number(o.holeNumber)===Number(h.holeNumber)));
        return total+objects.length+legacy.length;
      },0);
  }

  window.GolfDaddyCourseLibrary={
    saveOrUpdateUserGreen,
    loadUserCourseData,
    resetUserGreen,
    saveCourseObject,
    assignObjectToHole,
    unassignObjectFromHole,
    deleteCourseObject,
    getUnassignedObjects,
    getConfirmedHoleGreen,
	    drawCourseObjectPin,
	    focusCourseObject,
	    loadSavedGreenForActiveHole,
	    saveCurrentGreen,
	    activeGreenRecord,
	    activeGreenShape,
	    hydrateMapperGreenForWand,
	    lockMappedGreenFromStart:forceLockMappedGreenFromStart,
	    mappedHolePlayData,
	    mappedFairwayAxisForShot,
	    autoMapOsmCourse,
	    publishCourseMap,
	    syncPublishedCourseMaps,
	    loadPublishedStore,
	    assumedCourseCandidate,
    saveCourseFinderCoordinate,
    nearbyKnownCourses,
    nearestKnownCourse,
    knownCourseCandidates,
    currentCourseStorageLabel,
    ensureAssumedCourseBadge,
    objectLifecycle,
    storeKey:STORE_KEY
	  };
  window.ClarityCaddieCourseLibrary=window.GolfDaddyCourseLibrary;
  window.gdMappedHolePlayData=mappedHolePlayData;
  window.gdMappedFairwayAxisForShot=mappedFairwayAxisForShot;
  window.gdMappedFairwayLayupTarget=mappedFairwayLayupTarget;
  window.gdAutoMapOsmCourse=autoMapOsmCourse;
  window.gdScheduleOsmAutoMapForPlay=scheduleOsmAutoMapForPlay;
  window.gdMapperHydrateGreenForWand=hydrateMapperGreenForWand;

		  function ensureMapperToolsDrawer(){
    let el=document.getElementById('gdMapperToolsDrawer');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdMapperToolsDrawer';
    el.className='gdMapperToolsDrawer hidden';
    el.innerHTML=`<div class="gdMapperToolsSheet"><div class="gdMapperToolsHead"><div><h2>Map Tools</h2><p>Save course objects inside the current course group. Greens and bunkers stay usable from their own library tabs.</p></div><button class="gdSheetClose" type="button" onclick="gdCloseMapperTools()">×</button></div><div class="gdMapperCourseLine" id="gdMapperCourseLine"></div><div class="gdMapperToolGrid"><button class="gdMapperToolChoice primary" type="button" id="gdMapperGreenTool"><strong>Green</strong><span>Use Green Wand, then save the shape as a reusable green target.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperBunkerTool"><strong>Bunker Pin</strong><span>Tap one bunker anchor and save it to the bunker map.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperTeeTool"><strong>Tee Pin</strong><span>Tap a tee reference point for the active hole.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperFairwayTool"><strong>Fairway Point</strong><span>Tap a fairway reference or landing zone for the active hole.</span></button></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click',ev=>{if(ev.target===el)gdCloseMapperTools();});
    el.querySelector('#gdMapperGreenTool').onclick=startMapperGreenCapture;
    el.querySelector('#gdMapperBunkerTool').onclick=()=>startMapperObjectPinCapture('bunker','bunker pin');
    el.querySelector('#gdMapperTeeTool').onclick=()=>startMapperObjectPinCapture('tee','tee pin');
    el.querySelector('#gdMapperFairwayTool').onclick=()=>startMapperObjectPinCapture('fairway','fairway point');
    return el;
  }
	  function ensureMapperToolFlyout(){
	    let el=document.getElementById('gdMapperToolFlyout');
	    if(el)return el;
	    el=document.createElement('div');
	    el.id='gdMapperToolFlyout';
	    el.className='gdMapperToolFlyout hidden';
	    el.innerHTML=`<div class="gdMapperHoleStepper" aria-label="Mapping hole"><button type="button" data-hole-step="-1">‹</button><strong id="gdMapperHoleValue">H1</strong><button type="button" data-hole-step="1">›</button></div><button class="gdMapperFlyoutAction primary" data-map-tool="green" type="button" aria-label="Green pin"><span class="ico">▰</span><span class="txt">Green</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="greenwand" type="button" aria-label="Green wand"><span class="ico">▦</span><span class="txt">Wand</span></button><button class="gdMapperFlyoutAction" data-map-tool="bunker" type="button" aria-label="Bunker pin"><span class="ico">◒</span><span class="txt">Bunker</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="mapstyle" type="button" aria-label="OSM line guide"><span class="ico">▧</span><span class="txt">Guide</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="automap" type="button" aria-label="Auto map from OSM"><span class="ico">A</span><span class="txt">Auto</span></button><button class="gdMapperFlyoutAction" data-map-tool="tee" type="button" aria-label="Tee pin"><span class="ico">T</span><span class="txt">Tee</span></button><button class="gdMapperFlyoutAction" data-map-tool="fairway" type="button" aria-label="Fairway point"><span class="ico">•</span><span class="txt">Fairway</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly gdMapperClearHoleTool" data-map-tool="clearhole" type="button" aria-label="Clear this hole"><span class="ico">×</span><span class="txt">Clear H1</span></button>`;
	    el.querySelector('[data-map-tool="greenwand"]')?.insertAdjacentHTML('afterend','<button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="assignhole" type="button" aria-label="Assign hole"><span class="ico" id="gdMapperAssignHoleValue">H1</span><span class="txt">Hole</span></button>');
	    el.insertAdjacentHTML('beforeend','<button class="gdMapperFlyoutAction gdFullMappingOnly gdMapperSaveTool" data-map-tool="save" type="button" aria-label="Save mapping"><span class="ico">✓</span><span class="txt">Save</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly gdMapperNextTool" data-map-tool="next" type="button" aria-label="Next hole"><span class="ico">›</span><span class="txt">Next</span></button>');
	    document.body.appendChild(el);
	    el.addEventListener('pointerdown',ev=>ev.stopPropagation());
	    el.addEventListener('click',ev=>{
	      const step=ev.target.closest('[data-hole-step]');
	      if(step){
	        ev.preventDefault();
	        ev.stopPropagation();
	        bumpMapperHole(Number(step.getAttribute('data-hole-step')));
	        return;
	      }
	      const btn=ev.target.closest('[data-map-tool]');
	      if(!btn)return;
	      ev.preventDefault();
	      ev.stopPropagation();
	      const tool=btn.getAttribute('data-map-tool');
	      const captureTool=mapperToolCaptureType(tool);
	      if(captureTool&&window.__gdMapperObjectCaptureActive&&mapperCaptureTool===captureTool){
	        cancelMapperCapture();
	        hintSafe('Choose a mapping tool');
	        toastSafe('Replacement cancelled');
	        updateMapperToolCompletion();
	        return;
	      }
	      const replace=!!(window.gdFullMappingMode&&mapperToolDone(tool));
	      if(tool==='green')startMapperGreenCapture(ev,{replaceExisting:replace});
	      if(tool==='greenwand')startMapperGreenWand(ev);
	      if(tool==='assignhole')assignActiveGreenFromToolbar();
	      if(tool==='automap')autoMapOsmCourse();
	      if(tool==='save')saveFullMappingMode();
	      if(tool==='next')saveFullMappingMode({advance:true});
	      if(tool==='clearhole')clearCurrentMapperHole();
	      if(tool==='bunker')startMapperObjectPinCapture('bunker',replace?'replacement bunker pin':'bunker pin','gps_tools_drawer',{replaceExisting:replace});
	      if(tool==='mapstyle')cycleMapperMapSource();
	      if(tool==='tee')startMapperObjectPinCapture('tee',replace?'replacement tee pin':'tee pin','gps_tools_drawer',{replaceExisting:replace});
	      if(tool==='fairway')startMapperObjectPinCapture('fairway',replace?'replacement fairway point':'fairway point','gps_tools_drawer',{replaceExisting:replace});
	    });
	    window.addEventListener('resize',positionMapperToolFlyout);
	    updateMapperHoleUi();
	    updateMapperToolCompletion();
	    return el;
	  }
	  function updateMapperHoleUi(){
	    const active=mapperHole();
	    try{window.gdMapperActiveHole=active;}catch(e){}
	    const label=document.getElementById('gdMapperHoleValue');
	    if(label)label.textContent=`H${active}`;
	    const assign=document.getElementById('gdMapperAssignHoleValue');
	    if(assign)assign.textContent=`H${active}`;
	    const clear=document.querySelector('[data-map-tool="clearhole"] .txt');
	    if(clear)clear.textContent=`Clear H${active}`;
	    const course=loadUserCourseData();
	    const hasData=course?mapperHoleCompletion(course,active).any:false;
	    const assignText=document.querySelector('[data-map-tool="assignhole"] .txt');
	    if(assignText)assignText.textContent=hasData?'Edit':'Hole';
	    updateMapperMapSourceUi();
	    try{updateMapperHoleStrip();}catch(e){}
	    try{
	      const badge=document.querySelector('.playerBadge .holeMeta');
	      if(badge)badge.textContent=window.gdFullMappingMode?`Mapping H${active}`:`Hole ${active}`;
	    }catch(e){}
	    try{if(window.gdFullMappingMode&&typeof setState==='function')setState(`Mapping H${active}`);}catch(e){}
	    try{if(window.gdFullMappingMode&&typeof window.gdV62Refresh==='function')window.gdV62Refresh();}catch(e){}
	    try{if(typeof window.gdHydrateGpsBadge==='function')window.gdHydrateGpsBadge(true);}catch(e){}
	    try{
	      if(window.gdFullMappingMode){
	        const status=document.querySelector('#gdV62GpsBadge .statusText');
	        if(status)status.textContent=`Mapping H${active}`;
	      }
	    }catch(e){}
	    updateMapperHoleGuide();
	  }
	  function positionMapperToolFlyout(){
	    const el=document.getElementById('gdMapperToolFlyout');
	    if(!el||el.classList.contains('hidden'))return;
		    const btn=document.getElementById('gdMapperToolsBtn');
	    if(!btn)return;
	    if(document.body.classList.contains('gdFullMappingMode')){
	      el.style.top='50%';
	      el.style.right='96px';
	      return;
	    }
	    const r=btn.getBoundingClientRect();
		    el.style.top=`${r.top+r.height/2}px`;
		    el.style.right=`${Math.max(8,window.innerWidth-r.left+10)}px`;
	  }
	  function updateMapperToolsButtonState(){
	    const btn=document.getElementById('gdMapperToolsBtn');
	    if(!btn)return;
	    const flyout=document.getElementById('gdMapperToolFlyout');
	    const open=!!flyout&&!flyout.classList.contains('hidden');
	    btn.textContent=open?'SAVE':'MAP';
	    btn.setAttribute('aria-label',open?'Save map tools':'Map tools');
	    btn.title=open?'Save map tools':'Map tools';
	    btn.classList.toggle('gdMapperToolsSaving',open);
	  }
	  function closeMapperToolFlyout(){
	    if(window.gdFullMappingMode)return;
	    document.getElementById('gdMapperToolFlyout')?.classList.add('hidden');
	    redrawMappedPlayOverlay(false);
	    updateMapperToolsButtonState();
	  }
	  function courseObjectsForMapper(){
	    try{
	      const course=loadUserCourseData();
	      return objectValues(course);
	    }catch(e){return [];}
	  }
	  function mapperHoleCompletion(course,hole){
	    const h=validHoleNumber(hole)||mapperHole();
	    const objects=objectValues(course).filter(object=>Number(object.holeNumber)===Number(h)&&object.confirmed);
	    const green=objects.some(object=>object.type==='green'&&!!objectCenter(object))||!!course?.holes?.[h]?.greenCenter;
	    const tee=objects.some(object=>object.type==='tee'&&!!object.position);
	    const fairway=objects.some(object=>object.type==='fairway'&&!!object.position);
	    return {green,tee,fairway,any:green||tee||fairway,complete:green&&tee&&fairway};
	  }
		  function guideLength(points){
		    const pts=(points||[]).map(toLatLng).filter(Boolean);
		    let total=0;
		    for(let i=1;i<pts.length;i++)total+=distance(pts[i-1],pts[i]);
		    return total;
		  }
		  function guideDistanceToPoint(guide,point){
		    const center=toLatLng(point);
		    if(!center)return Infinity;
		    const pts=(guide?.points||[]).map(toLatLng).filter(Boolean);
		    if(!pts.length)return Infinity;
		    return Math.min(...pts.map(pt=>distance(center,pt)).filter(Number.isFinite));
		  }
	  function pointAlongGuide(points,fraction=.5){
	    const pts=(points||[]).map(toLatLng).filter(Boolean);
	    if(!pts.length)return null;
	    if(pts.length===1)return toPlain(pts[0]);
	    const target=guideLength(pts)*Math.max(0,Math.min(1,fraction));
	    let travelled=0;
	    for(let i=1;i<pts.length;i++){
	      const a=pts[i-1],b=pts[i];
	      const seg=distance(a,b);
	      if(travelled+seg>=target){
	        const t=seg?((target-travelled)/seg):0;
	        return {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
	      }
	      travelled+=seg;
	    }
	    return toPlain(pts[pts.length-1]);
	  }
		  function bestGuideForHole(guides,hole,coursePoint=null){
		    const h=validHoleNumber(hole);
		    if(!h)return null;
		    return (guides||[])
		      .filter(guide=>Number(guide.hole)===h&&Array.isArray(guide.points)&&guide.points.length>=2)
		      .sort((a,b)=>{
		        const ad=guideDistanceToPoint(a,coursePoint);
		        const bd=guideDistanceToPoint(b,coursePoint);
		        if(Math.abs(ad-bd)>120)return ad-bd;
		        return guideLength(b.points)-guideLength(a.points);
		      })[0]||null;
		  }
	  function bestOsmGreenForGuide(guide,greens=[]){
	    const pts=(guide?.points||[]).map(toLatLng).filter(Boolean);
	    if(pts.length<2)return null;
	    const ends=[pts[0],pts[pts.length-1]];
	    let best=null;
	    greens.forEach(green=>{
	      if(green.ref&&guide.hole&&Number(green.ref)!==Number(guide.hole))return;
	      const center=toLatLng(green.center);
	      if(!center)return;
	      ends.forEach((end,index)=>{
	        const d=distance(center,end);
	        if(d<=OSM_AUTO_GREEN_MATCH_RADIUS_M&&(!best||d<best.distance))best={green,endpointIndex:index,distance:d};
	      });
	    });
	    return best;
	  }
	  function fairwaySamplesForGuide(points){
	    const len=guideLength(points);
	    if(len>360)return [pointAlongGuide(points,.36),pointAlongGuide(points,.64)].filter(Boolean);
	    return [pointAlongGuide(points,.5)].filter(Boolean);
	  }
	  function chooseAutoMapGuides(guides,coursePoint=null){
	    const byHole=new Map();
	    (guides||[]).forEach(guide=>{
	      const h=validHoleNumber(guide.hole);
	      if(!h)return;
	      const prev=byHole.get(h);
	      if(!prev){
	        byHole.set(h,guide);
	        return;
	      }
	      const guideDistance=guideDistanceToPoint(guide,coursePoint);
	      const prevDistance=guideDistanceToPoint(prev,coursePoint);
	      if(Math.abs(guideDistance-prevDistance)>120){
	        if(guideDistance<prevDistance)byHole.set(h,guide);
	        return;
	      }
	      if(guideLength(guide.points)>guideLength(prev.points))byHole.set(h,guide);
	    });
	    return Array.from(byHole.values()).sort((a,b)=>Number(a.hole)-Number(b.hole));
	  }
	  function saveOsmAutoHole(guide,greens,course=loadUserCourseData(),opts={}){
	    const h=validHoleNumber(guide?.hole);
	    const pts=(guide?.points||[]).map(toPlain).filter(Boolean);
	    if(!h||pts.length<2)return {saved:0,greenPolygon:false,fallback:false};
	    const uid=userId();
	    const cid=course?.courseId||course?.id||courseId(course);
	    const name=course?.courseName||course?.name||courseName(course);
	    const selectedCourse=opts.sessionCourse||course;
	    if(opts.replaceExisting){
	      try{resetUserGreen(uid,cid,h);}catch(e){}
	      try{deleteCourseObjectsForHole('fairway',h,uid,cid);}catch(e){}
	      try{deleteCourseObjectsForHole('tee',h,uid,cid);}catch(e){}
	      course=loadUserCourseData(uid,cid)||course;
	    }
	    const state=mapperHoleCompletion(course,h);
	    const match=bestOsmGreenForGuide(guide,greens);
	    const ordered=match?.endpointIndex===0?[...pts].reverse():pts;
	    const tee=ordered[0];
	    const greenEnd=ordered[ordered.length-1];
	    const greenCenter=match?.green?.center||greenEnd;
	    const greenShape=match?.green?.shape||fallbackGreenShape(greenCenter,16,40).map(toPlain).filter(Boolean);
	    let saved=0;
	    if(!state.green&&greenCenter&&greenShape.length>=3){
		      if(saveCourseObject({
		        userId:uid,
		        courseId:cid,
		        courseName:name,
		        course:selectedCourse,
		        type:'green',
	        position:greenCenter,
	        shape:greenShape,
	        greenShape,
	        source:match?.green?'osm_auto_green_polygon':'osm_auto_green_estimate',
	        holeNumber:h,
	        confirmed:true,
	        maxDedupeDistanceM:4
	      }))saved++;
		    }
		    if(!state.tee&&tee){
		      if(saveCourseObject({userId:uid,courseId:cid,courseName:name,course:selectedCourse,type:'tee',position:tee,source:'osm_auto_tee',holeNumber:h,confirmed:true,maxDedupeDistanceM:4}))saved++;
		    }
		    if(!state.fairway){
		      fairwaySamplesForGuide(ordered).forEach((point,index)=>{
		        if(saveCourseObject({userId:uid,courseId:cid,courseName:name,course:selectedCourse,type:'fairway',position:point,source:index?'osm_auto_fairway_bend':'osm_auto_fairway',holeNumber:h,confirmed:true,maxDedupeDistanceM:4}))saved++;
		      });
		    }
	    return {saved,greenPolygon:!!match?.green,fallback:!match?.green};
	  }
	  async function autoMapOsmCourse(opts={}){
	    cancelMapperCapture();
	    const course=opts.course||sessionCourse(courseObj());
	    const quiet=!!opts.quiet;
	    if(!quiet)toastSafe('Auto mapping from OSM...');
	    const coursePoint=guideCoursePoint(course);
	    const bundle=await loadOsmGuideBundle(course,{needsGreens:true,fresh:!!opts.fresh});
	    const guides=opts.hole?[bestGuideForHole(bundle.guides,opts.hole,coursePoint)].filter(Boolean):chooseAutoMapGuides(bundle.guides,coursePoint);
	    if(!guides.length){
	      if(!quiet)toastSafe('No OSM hole lines found');
	      return false;
	    }
	    let saved=0,polygons=0,fallbacks=0;
	    guides.forEach(guide=>{
		      const result=saveOsmAutoHole(guide,bundle.greens,loadUserCourseData(userId(),courseId(course))||course,{replaceExisting:!!opts.replaceExisting,sessionCourse:course});
	      saved+=result.saved;
	      if(result.greenPolygon)polygons++;
	      if(result.fallback)fallbacks++;
	    });
	    const active=opts.hole?validHoleNumber(opts.hole):mapperHole();
	    const nextCourse=loadUserCourseData(userId(),courseId(course));
	    if(nextCourse)drawHoleObjects(nextCourse,active);
	    updateMapperHoleUi();
	    updateMapperToolCompletion();
	    renderCourseLibraryPanel();
	    gdCLRefreshProfileCard();
	    if(opts.frame!==false){
	      if(window.gdFullMappingMode)focusMapperHoleReference(active,{drawObjects:false,frame:true});
	      else if(nextCourse)frameMappedHoleForPlay(nextCourse,active,{quiet:true,promptStart:!!opts.promptStart,allowAnyStart:true});
	    }
	    const label=opts.hole?`H${active}`:`${guides.length} holes`;
	    if(!quiet||saved){
	      toastSafe(saved?`OSM base map ready`:`${label} already mapped`);
	    }
	    if(!quiet){
	      hintSafe(saved?`${label}: OSM base layer saved (${polygons} shaped green${polygons===1?'':'s'})`:`${label}: OSM base layer already exists`);
	    }
	    return {saved,holes:guides.length,polygons,fallbacks};
	  }
	  function scheduleOsmAutoMapForPlay(course,opts={}){
	    try{
	      const c=sessionCourse(course||courseObj());
	      if(!c||isManualGpsCourse(c))return false;
	      if(typeof fetch!=='function')return false;
	      const key=`${mappedModeCourseIdentity(c)}:${opts.hole||'course'}`;
	      if(mapperOsmAutoMapRunKey===key)return true;
	      mapperOsmAutoMapRunKey=key;
	      setTimeout(()=>{
	        try{
	          const active=sessionCourse(courseObj());
	          if(mappedModeCourseIdentity(active)!==mappedModeCourseIdentity(c))return;
	          autoMapOsmCourse({quiet:true,frame:opts.frame!==false,hole:opts.hole,promptStart:!!opts.promptStart,course:c}).catch(()=>{});
	        }catch(e){}
	      },opts.delayMs||900);
	      return true;
	    }catch(e){return false;}
	  }
	  function mapperHoleStateMarkup(course,hole){
	    const state=mapperHoleCompletion(course,hole);
	    return [['green','G'],['tee','T'],['fairway','F']].map(([key,label])=>{
	      const done=!!state[key];
	      return `<i class="${done?'done':'missing'}">${label}${done?'✓':'-'}</i>`;
	    }).join('');
	  }
	  function mapperToolDone(type){
	    if(type==='mapstyle'||type==='greenwand'||type==='assignhole'||type==='automap'||type==='save'||type==='next'||type==='clearhole')return false;
	    const h=mapperHole();
	    const objects=courseObjectsForMapper();
	    if(type==='sand')type='bunker';
	    if(type==='green')return objects.some(o=>Number(o.holeNumber)===Number(h)&&o.confirmed&&!!objectCenter(o));
	    return objects.some(o=>o.type===type&&Number(o.holeNumber)===Number(h)&&(type!=='green'||o.confirmed));
	  }
	  function mapperToolCaptureType(type){
	    if(type==='mapstyle'||type==='greenwand'||type==='assignhole'||type==='automap'||type==='save'||type==='next'||type==='clearhole')return '';
	    if(type==='sand')return 'bunker';
	    return type||'';
	  }
	  function mapperToolFixLabel(type){
	    const labels={green:'Fix Green',bunker:'Fix Bunker',tee:'Fix Tee',fairway:'Fix Fairway'};
	    return labels[type]||'Fix';
	  }
	  function updateMapperToolCompletion(){
	    const flyout=document.getElementById('gdMapperToolFlyout');
	    if(!flyout)return;
	    updateMapperMapSourceUi();
	    updateMapperHoleStrip();
	    flyout.querySelectorAll('[data-map-tool]').forEach(btn=>{
	      const type=btn.getAttribute('data-map-tool');
	      const done=mapperToolDone(type);
	      btn.classList.toggle('done',done);
	      const txt=btn.querySelector('.txt');
	      if(txt&&!btn.dataset.defaultLabel)btn.dataset.defaultLabel=txt.textContent||'';
	      if(txt&&mapperToolCaptureType(type))txt.textContent=done?mapperToolFixLabel(type):(btn.dataset.defaultLabel||txt.textContent);
	      if(mapperToolCaptureType(type))btn.title=done?mapperToolFixLabel(type):(btn.dataset.defaultLabel||txt?.textContent||'Map tool');
	    });
	  }
	  function updateMapperMapSourceUi(){
	    const btn=document.querySelector('[data-map-tool="mapstyle"] .txt');
	    if(!btn)return;
	    try{
	      const label=document.getElementById('mapSourceBtn')?.textContent?.trim();
	      btn.textContent=/osm/i.test(label||'')?'Guide':(label||'Map');
	    }catch(e){btn.textContent='Guide';}
	  }
	  function cycleMapperMapSource(){
	    try{
	      mapperOsmGuideUserChoice=true;
	      if(typeof cycleMapSource==='function')cycleMapSource();
	      else document.getElementById('mapSourceBtn')?.click();
	      updateMapperMapSourceUi();
	      toastSafe(`Map: ${document.getElementById('mapSourceBtn')?.textContent?.trim()||'changed'}`);
	    }catch(e){toastSafe('Map type not ready');}
	  }
	  function ensureMapperHoleStrip(){
	    let el=document.getElementById('gdMapperHoleStrip');
	    if(el)return el;
	    el=document.createElement('div');
	    el.id='gdMapperHoleStrip';
	    el.className='gdMapperHoleStrip hidden';
	    document.body.appendChild(el);
	    el.addEventListener('pointerdown',ev=>ev.stopPropagation());
	    el.addEventListener('click',ev=>{
	      const btn=ev.target.closest('[data-map-hole]');
	      if(!btn)return;
	      ev.preventDefault();
	      ev.stopPropagation();
	      selectMapperHoleFromStrip(Number(btn.getAttribute('data-map-hole')));
	    });
	    return el;
	  }
	  function ensureMapperHoleGuide(){
	    let el=document.getElementById('gdMapperHoleGuide');
	    if(el)return el;
	    el=document.createElement('div');
	    el.id='gdMapperHoleGuide';
	    el.className='gdMapperHoleGuide hidden';
	    document.body.appendChild(el);
	    return el;
	  }
		  function updateMapperHoleGuide(){
		    if(!window.gdFullMappingMode){
		      clearMapperGuideUi();
		      return;
		    }
		    const el=ensureMapperHoleGuide();
	    const h=mapperHole();
	    const course=loadUserCourseData();
	    const state=mapperHoleCompletion(course,h);
	    if(state.any){
	      el.classList.add('hidden');
	      return;
	    }
	    el.textContent=`Map H${h}: find line ${h} > green end > tee end > fairway`;
	    el.classList.remove('hidden');
	  }
	  function mapperHoleSummaryMarkup(course,hole){
	    const objects=objectValues(course).filter(object=>Number(object.holeNumber)===Number(hole)&&(object.confirmed||object.type==='green'));
	    if(!objects.length)return '<span>No saved objects yet</span>';
	    const items=objects.reduce((acc,o)=>{const label=objectTypeLabel(o.type);acc[label]=(acc[label]||0)+1;return acc;},{});
	    return Object.entries(items).map(([label,count])=>`<span>${esc(count)} ${esc(label)}</span>`).join('');
	  }
	  function updateMapperHoleStrip(expandedHole=null){
	    const el=ensureMapperHoleStrip();
	    if(!window.gdFullMappingMode){el.classList.add('hidden');return;}
	    const course=loadUserCourseData();
	    const holes=Array.from({length:18},(_,i)=>i+1);
	    if(course)mappedHoleNumbers(course,courseSummary(course)).forEach(h=>{if(!holes.includes(h))holes.push(h);});
	    const active=mapperHole();
	    if(!holes.includes(active))holes.push(active);
	    holes.sort((a,b)=>a-b);
	    el.classList.remove('hidden');
	    el.innerHTML=holes.map(h=>{
	      const state=course?mapperHoleCompletion(course,h):{any:false,complete:false};
	      return `<button type="button" class="${h===active?'active':''} ${state.any?'hasData':''} ${state.complete?'complete':''}" data-map-hole="${h}" aria-label="${state.any?'Edit':'Map'} hole ${h}"><strong>${h}</strong><span>${state.any?'Edit':'Map'}</span><em class="gdMapperHoleStates">${course?mapperHoleStateMarkup(course,h):'G- T- F-'}</em></button>`;
	    }).join('')+
	      (expandedHole&&course?`<div class="gdMapperHoleStripDetail"><strong>Hole ${expandedHole}</strong>${mapperHoleSummaryMarkup(course,expandedHole)}</div>`:'');
	  }
	  function selectMapperHoleFromStrip(hole){
	    const h=validHoleNumber(hole);
	    if(!h)return;
	    setMapperHole(h);
	    const course=loadUserCourseData();
	    if(course){
	      drawHoleObjects(course,h);
	    }
	    focusMapperHoleReference(h,{drawObjects:false,frame:true});
	    updateMapperHoleUi();
	    updateMapperToolCompletion();
	    updateMapperHoleStrip(h);
	    toastSafe(`Hole ${h}`);
	  }
  function cancelMapperCapture(){
    if(mapperCaptureCancel){
      try{mapperCaptureCancel();}catch(e){}
      mapperCaptureCancel=null;
    }
    mapperCaptureTool=null;
  }
	  function openMapperToolsDrawer(ev){
	    if(ev){ev.preventDefault();ev.stopPropagation();}
		    cancelMapperCapture();
		    document.getElementById('gdMapperToolsDrawer')?.classList.add('hidden');
		    const flyout=ensureMapperToolFlyout();
		    if(window.gdFullMappingMode){
		      flyout.classList.remove('hidden');
		      positionMapperToolFlyout();
		      updateMapperHoleUi();
		      updateMapperToolCompletion();
		      updateMapperToolsButtonState();
		      focusMapperHoleReference(mapperHole(),{drawObjects:true,frame:true});
		      toastSafe('Mapping tools ready');
		      return false;
		    }
		    const closing=!flyout.classList.contains('hidden');
		    flyout.classList.toggle('hidden',closing);
		    if(closing){
		      updateMapperToolCompletion();
		      redrawMappedPlayOverlay(false);
		      updateMapperToolsButtonState();
		      toastSafe('Map saved');
		      return false;
		    }
		    positionMapperToolFlyout();
		    updateMapperHoleUi();
		    updateMapperToolCompletion();
		    redrawMappedPlayOverlay(true);
		    updateMapperToolsButtonState();
		    ensureAssumedCourseBadge();
		    return false;
		  }
  window.gdOpenMapperTools=openMapperToolsDrawer;
  window.gdCloseMapperTools=function(){
	    document.getElementById('gdMapperToolsDrawer')?.classList.add('hidden');
	    closeMapperToolFlyout();
	  };
	  function startMapperGreenCapture(ev,opts={}){
	    if(window.gdFullMappingMode){
	      startMapperGreenPinCapture(opts);
	      return;
	    }
	    startMapperGreenWand(ev);
		  }
	  function startMapperGreenWand(ev){
	    cancelMapperCapture();
	    try{mode='ready';}catch(e){}
	    try{if(typeof gdSuppressMapPlacementClick==='function')gdSuppressMapPlacementClick(700);}catch(e){}
	    try{hydrateMapperGreenForWand();}catch(e){}
	    updateMapperHoleUi();
	    setMapperContext('green');
	    hintSafe('Green tool ready');
	    toastSafe('Green tool ready');
    try{
      const wand=document.getElementById('greenToolBtn');
      if(typeof window.gdCompactWandOpen==='function')window.gdCompactWandOpen(ev||{preventDefault(){},stopPropagation(){}});
      else if(typeof window.gdToggleWandTool==='function')window.gdToggleWandTool(ev||{preventDefault(){},stopPropagation(){}});
      else if(typeof openGpsWand==='function')openGpsWand(ev||null);
      else if(wand)wand.click();
    }catch(e){}
		  }
	  function assignActiveGreenFromToolbar(){
	    cancelMapperCapture();
	    const h=mapperHole();
	    const moved=moveActiveGreenToHole(h);
	    if(moved){
	      toastSafe(`Green assigned to H${h}`);
	      hintSafe(`Green assigned · H${h}`);
	    }else{
	      toastSafe(`Hole assignment set to H${h}`);
	      hintSafe(`Next mapped object saves to H${h}`);
	    }
	    updateMapperHoleUi();
	    updateMapperToolCompletion();
	  }
	  function saveFullMappingMode(opts={}){
	    cancelMapperCapture();
	    const savedHole=mapperHole();
	    const advance=!!opts.advance;
	    const nextHole=Math.min(18,savedHole+1);
	    const targetHole=advance&&savedHole<18?nextHole:savedHole;
	    try{if(typeof closeWandPanel==='function')closeWandPanel();}catch(e){}
	    try{renderCourseLibraryPanel();}catch(e){}
	    try{gdCLRefreshProfileCard();}catch(e){}
	    setMapperHole(targetHole);
	    setFullMappingMode(true,targetHole);
	    document.getElementById('gdMapperToolFlyout')?.classList.remove('hidden');
	    positionMapperToolFlyout();
	    updateMapperHoleUi();
	    updateMapperToolCompletion();
	    try{
	      const course=loadUserCourseData();
	      if(course)drawHoleObjects(course,targetHole);
	    }catch(e){}
	    focusMapperHoleReference(targetHole,{drawObjects:false,frame:true});
	    updateMapperToolsButtonState();
	    hintSafe(advance&&savedHole<18?`Mapping saved · H${nextHole} ready`:`H${savedHole} saved`);
	    toastSafe(advance&&savedHole<18?`H${savedHole} saved · H${nextHole} ready`:`H${savedHole} saved`);
	  }
	  function clearCurrentMapperHole(){
	    cancelMapperCapture();
	    const h=mapperHole();
	    if(!window.confirm||window.confirm(`Clear H${h} mapping? This removes green, tee and fairway for this hole only.`)){
	      const uid=userId(),cid=courseId();
	      const green=resetUserGreen(uid,cid,h)?1:0;
	      const tees=deleteCourseObjectsForHole('tee',h,uid,cid);
	      const fairways=deleteCourseObjectsForHole('fairway',h,uid,cid);
	      try{if(typeof closeWandPanel==='function')closeWandPanel();}catch(e){}
	      try{greenPolygon=null;greenCentre=null;}catch(e){}
	      try{[greenMarker,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(l=>l&&map.removeLayer(l));greenMarker=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;}catch(e){}
	      const course=loadUserCourseData();
	      if(course)drawHoleObjects(course,h);
	      updateMapperHoleUi();
	      updateMapperToolCompletion();
	      renderCourseLibraryPanel();
	      focusMapperHoleReference(h,{drawObjects:false,frame:true});
	      const count=green+tees+fairways;
	      toastSafe(count?`H${h} cleared`:`H${h} already clear`);
	      hintSafe(`Map H${h}: find line ${h} > green end > tee end > fairway`);
	    }
	  }
	  function startMapperGreenPinCapture(opts={}){
	    try{if(typeof closeWandPanel==='function')closeWandPanel();}catch(e){}
	    try{mode='ready';}catch(e){}
	    setMapperContext('');
	    startMapperObjectPinCapture('green',opts.replaceExisting?'replacement green pin':'green pin','mapping_green_pin',opts);
	  }
		  function startMapperObjectPinCapture(type='bunker',label='course object',source='gps_tools_drawer',opts={}){
		    cancelMapperCapture();
		    if(typeof map==='undefined'||!map||typeof map.once!=='function'){
		      toastSafe('Map not ready');
      return;
    }
    hintSafe(`Tap ${label} to save`);
    toastSafe(`Tap ${label} to save`);
    window.__gdMapperObjectCaptureActive=true;
    mapperCaptureTool=type;
    if(type==='green'&&opts.replaceExisting){
      try{
        const course=loadUserCourseData();
        const h=mapperHole();
        if(course)drawHoleObjects(course,h,{editable:false,greenFix:true,onlyType:'green'});
        focusHoleOnMap(course,h);
      }catch(e){}
      hintSafe('Tap the new green centre');
      toastSafe('Fix green: tap the new centre');
    }
    const handler=function(ev){
      mapperCaptureCancel=null;
      mapperCaptureTool=null;
      window.__gdMapperObjectCaptureActive=false;
      try{if(ev?.originalEvent&&typeof L!=='undefined')L.DomEvent.stop(ev.originalEvent);}catch(e){}
	      const clickLatLng=mapperLatLngFromClickEvent(ev);
	      const savePosition=clickLatLng||ev.latlng;
	      if(type==='green'){
	        try{greenCentre=savePosition;}catch(e){}
	      }
		      const linkedHole=mapperHole();
		      if(opts.replaceExisting&&type!=='green')deleteCourseObjectsForHole(type,linkedHole);
		      if(opts.replaceExisting&&type==='green')resetUserGreen(userId(),courseId(),linkedHole);
		      const object=saveCourseObject({
		        type,
		        position:savePosition,
		        source,
		        holeNumber:linkedHole,
		        confirmed:!!linkedHole
		      });
			      if(object){
			        if(window.gdFullMappingMode)drawHoleObjects(loadUserCourseData()||null,linkedHole);
			        else drawCourseObjectPin(object);
			        if(window.gdFullMappingMode)focusMapperHoleReference(linkedHole,{drawObjects:false,frame:false});
			        renderCourseLibraryPanel();
		        gdCLRefreshProfileCard();
		        updateMapperToolCompletion();
		        updateMapperHoleUi();
		        hintSafe(`${label} saved · H${linkedHole}`);
		        toastSafe(`${label} saved to H${linkedHole}`);
		      }
	    };
    mapperCaptureCancel=function(){
      window.__gdMapperObjectCaptureActive=false;
      mapperCaptureTool=null;
      try{map.off('click',handler);}catch(e){}
    };
    map.once('click',handler);
  }
  function mapperLatLngFromClickEvent(ev){
    try{
      if(typeof gdLatLngFromClientEvent==='function'&&ev?.originalEvent){
        return gdLatLngFromClientEvent(ev.originalEvent);
      }
    }catch(e){}
    return ev?.latlng||null;
  }
  function installMapperToolsButton(){
    const rail=document.querySelector('.rightRail');
    if(!rail)return;
    const btn=document.getElementById('gdMapperToolsBtn');
    if(!btn){console.warn('[Clarity Caddie] final rail button missing: gdMapperToolsBtn');return;}
    btn.setAttribute('onclick','return window.gdOpenMapperTools&&window.gdOpenMapperTools(event)');
    btn.onclick=openMapperToolsDrawer;
    updateMapperToolsButtonState();
  }
  function observeMapperRail(){
    if(mapperRailObserver)return;
    mapperRailObserver=new MutationObserver(()=>setTimeout(installMapperToolsButton,0));
    mapperRailObserver.observe(document.body,{childList:true,subtree:true});
  }
  function returnToGpsFromScorecard(){
    try{sessionStorage.removeItem('gd_return_from_scorecard');}catch(e){}
    try{document.getElementById('scorePanel')?.classList.remove('open');}catch(e){}
    try{document.querySelectorAll('.panel.open,.modulePanel.open').forEach(p=>p.classList.remove('open'));}catch(e){}
    try{if(typeof enterGpsModule==='function')enterGpsModule({fromBack:true,preserve:true,replace:true});}catch(e){}
    try{if(typeof gdV62Refresh==='function')setTimeout(gdV62Refresh,80);}catch(e){}
  }
  function clearShotTargetForHoleChange(){
    try{if(typeof gdDiscardCurrentPlannedShot==='function')gdDiscardCurrentPlannedShot();}catch(e){}
    try{clearMapperObjectLayers();}catch(e){}
    try{clearMapperGuideUi();}catch(e){}
    try{if(typeof gdClearShotForNextStart==='function'){gdClearShotForNextStart(null);return;}}catch(e){}
    try{if(typeof clearPendingGreenTarget==='function')clearPendingGreenTarget();}catch(e){}
    try{if(typeof clearShot==='function')clearShot();}catch(e){}
    try{[startMarker,targetMarker,greenMarker,pinMarker,pinDirectionLine,greenOutline,greenSoft,greenLabel,frontLabel,backLabel].forEach(l=>l&&map.removeLayer(l));}catch(e){}
    try{startMarker=targetMarker=greenMarker=pinMarker=pinDirectionLine=greenOutline=greenSoft=greenLabel=frontLabel=backLabel=null;}catch(e){}
    try{start=target=greenCentre=pin=null;}catch(e){}
    try{greenPolygon=null;}catch(e){}
    try{gdWindLandingTarget=null;}catch(e){}
    try{lockedFrame=false;targetWasMoved=false;targetDragging=false;shotLineAligned=false;currentShotLogged=false;gdCurrentPlannedShotId=null;}catch(e){}
    try{undoStack=[];}catch(e){}
    try{mode='start';}catch(e){}
    try{document.getElementById('shotTile')?.classList.remove('visible');}catch(e){}
    try{app?.classList?.remove('framed');}catch(e){}
  }
  function focusScorecardHoleOnGps(hole,par=null){
    const h=validHoleNumber(hole)||activePlayingHole()||holeNumber()||1;
    try{document.getElementById('gdClosestHolePrompt')?.classList.add('hidden');}catch(e){}
    try{setFullMappingMode(false);}catch(e){}
    try{rememberPlayingHole(h);}catch(e){}
    clearShotTargetForHoleChange();
    try{
      const knownPar=knownParForHole(h,par);
      if(typeof setHole==='function')setHole(knownPar!==null?{hole:h,par:knownPar}:{hole:h});
    }catch(e){}
    const focus=()=>{
      let framed=false;
      try{
        const course=loadUserCourseData();
        if(course&&frameMappedHoleForPlay(course,h,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,skipAutoLock:true}))framed=true;
      }catch(e){}
      if(mappedCourseAssistEnabled()){
        if(!framed)reportMappedDropout(h,'scorecard-focus');
        return framed;
      }
      if(!framed)try{
        const course=loadUserCourseData();
        const objects=course?objectValues(course).filter(object=>Number(object.holeNumber)===Number(h)&&(object.confirmed||object.type==='green')):[];
        if(course&&objects.length){
          drawHoleObjects(course,h,{editable:false,playDetail:false});
          focusHoleOnMap(course,h);
          framed=true;
        }
      }catch(e){}
      if(!framed){
        try{framed=!!loadSavedGreenForActiveHole({quiet:true,frame:true});}catch(e){}
      }
      return framed;
	    };
	    focus();
	    const retryFrameRun=mappedCourseAssistEnabled()?mappedFrameRunId:null;
	    if(retryFrameRun!==null){
	      scheduleMappedFrameTask(retryFrameRun,180,focus);
	      scheduleMappedFrameTask(retryFrameRun,520,focus);
	    }else{
	      setTimeout(focus,180);
	      setTimeout(focus,520);
	    }
	  }
  function ensureCourseLoadingOverlay(){
    let el=document.getElementById('gdCourseLoadingOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdCourseLoadingOverlay';
    el.className='gdCourseLoadingOverlay hidden';
    el.innerHTML=`<div class="gdCourseLoadingSheet"><div class="gdCourseLoadingEyebrow">Clarity Caddie</div><strong id="gdCourseLoadingTitle">Loading course</strong><span id="gdCourseLoadingSub">Preparing Hole 1</span><div class="gdCourseLoadingTrack"><i id="gdCourseLoadingBar"></i></div></div>`;
    const style=document.createElement('style');
    style.id='gdCourseLoadingOverlayStyles';
    style.textContent=`
      .gdCourseLoadingOverlay{position:fixed;inset:0;z-index:9100;display:grid;place-items:center;background:#050806;color:#fff;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;transition:opacity .18s ease;opacity:1}
      .gdCourseLoadingOverlay.hidden{opacity:0;pointer-events:none}
      .gdCourseLoadingSheet{width:min(360px,calc(100vw - 48px));display:grid;gap:11px;text-align:left}
      .gdCourseLoadingEyebrow{font-size:11px;font-weight:950;letter-spacing:.08em;text-transform:uppercase;color:#9cff36}
      .gdCourseLoadingSheet strong{font-size:25px;line-height:1;font-weight:950;letter-spacing:0;text-transform:uppercase}
      .gdCourseLoadingSheet span{font-size:14px;font-weight:850;color:rgba(235,242,238,.72)}
      .gdCourseLoadingTrack{height:8px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.13);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
      .gdCourseLoadingTrack i{display:block;width:14%;height:100%;border-radius:inherit;background:#1fd36d;box-shadow:0 0 18px rgba(31,211,109,.38);transition:width .28s ease}
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);
    return el;
  }
  function showCourseLoading(courseName){
    const el=ensureCourseLoadingOverlay();
    const title=el.querySelector('#gdCourseLoadingTitle');
    const sub=el.querySelector('#gdCourseLoadingSub');
    const bar=el.querySelector('#gdCourseLoadingBar');
    if(title)title.textContent=courseName||'Loading course';
    if(sub)sub.textContent='Preparing Hole 1';
    if(bar)bar.style.width='18%';
    el.classList.remove('hidden');
    document.body.classList.add('gdCourseOpening');
    return el;
  }
  function updateCourseLoading(text,pct){
    const el=ensureCourseLoadingOverlay();
    const sub=el.querySelector('#gdCourseLoadingSub');
    const bar=el.querySelector('#gdCourseLoadingBar');
    if(sub&&text)sub.textContent=text;
    if(bar&&Number.isFinite(Number(pct)))bar.style.width=`${Math.max(8,Math.min(100,Number(pct)))}%`;
  }
  function hideCourseLoading(delay=180){
    setTimeout(()=>{
      try{document.getElementById('gdCourseLoadingOverlay')?.classList.add('hidden');}catch(e){}
      try{document.body.classList.remove('gdCourseOpening');}catch(e){}
    },delay);
  }
  function ensureClosestHolePrompt(){
    let el=document.getElementById('gdClosestHolePrompt');
    if(el)return el;
    el=document.createElement('button');
    el.type='button';
    el.id='gdClosestHolePrompt';
    el.className='gdClosestHolePrompt hidden';
    document.body.appendChild(el);
    if(!document.getElementById('gdClosestHolePromptStyle')){
      const style=document.createElement('style');
      style.id='gdClosestHolePromptStyle';
      style.textContent='.gdClosestHolePrompt{position:fixed;left:50%;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 94px);transform:translateX(-50%);z-index:1900;border:1px solid rgba(156,255,54,.42);border-radius:999px;background:rgba(3,18,9,.88);color:#f6fff7;padding:10px 15px;font-size:13px;font-weight:950;box-shadow:0 12px 28px rgba(0,0,0,.34),0 0 22px rgba(31,211,109,.16);backdrop-filter:blur(14px)}.gdClosestHolePrompt.hidden{display:none!important}';
      document.head.appendChild(style);
    }
    return el;
  }
  function routeDistanceToPointM(route,point){
    const p=toLatLng(point);
    const pts=(route||[]).map(toLatLng).filter(Boolean);
    if(!p||!pts.length)return Infinity;
    let best=Infinity;
    pts.forEach(pt=>{best=Math.min(best,distance(p,pt));});
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      const seg=distance(a,b);
      if(!Number.isFinite(seg)||seg<=0)continue;
      const steps=Math.max(2,Math.ceil(seg/24));
      for(let s=1;s<steps;s++){
        const brg=typeof bearing==='function'?bearing(a,b):Math.atan2(b.lng-a.lng,b.lat-a.lat);
        const sample=projectFramePoint(a,brg,seg*(s/steps));
        if(sample)best=Math.min(best,distance(p,sample));
      }
    }
    return best;
  }
  function closestMappedHoleForPoint(point,course=loadUserCourseData()){
    const p=toLatLng(point);
    if(!p||!course)return null;
    let best=null;
    for(let h=1;h<=36;h++){
      const data=mappedHolePlayData(course,h);
      if(!data?.complete)continue;
      const d=routeDistanceToPointM(data.route,p);
      if(Number.isFinite(d)&&(!best||d<best.distanceM))best={hole:h,distanceM:d};
    }
    return best;
  }
  function showClosestHolePrompt(match){
    const h=validHoleNumber(match?.hole);
    const current=activePlayingHole()||holeNumber()||1;
    const el=ensureClosestHolePrompt();
    if(!h||h===current||!Number.isFinite(Number(match.distanceM))||Number(match.distanceM)>140){
      el.classList.add('hidden');
      return false;
    }
    el.textContent=`Play H${h}?`;
    el.setAttribute('aria-label',`Play hole ${h}`);
    el.onclick=function(ev){
      ev.preventDefault();
      ev.stopPropagation();
      el.classList.add('hidden');
      if(typeof window.gdPlayHoleFromScorecard==='function')return window.gdPlayHoleFromScorecard(h,{source:'closest-hole-prompt'});
      return focusScorecardHoleOnGps(h);
    };
    el.classList.remove('hidden');
    return true;
  }
  function checkClosestMappedHolePrompt(course){
    try{
      const c=course||loadUserCourseData();
      const usePoint=point=>showClosestHolePrompt(closestMappedHoleForPoint(point,c));
      if(typeof start!=='undefined'&&start){usePoint(start);return;}
      if(!navigator.geolocation)return;
      navigator.geolocation.getCurrentPosition(pos=>{
        usePoint(L.latLng(pos.coords.latitude,pos.coords.longitude));
      },()=>{}, {enableHighAccuracy:true,maximumAge:60000,timeout:5000});
    }catch(e){}
  }
  function courseOpenKey(course,hole=1){
    const c=sessionCourse(course||courseObj());
    const name=String(c?.courseId||c?.id||c?.name||c?.courseName||'').trim().toLowerCase().replace(/\s+/g,' ');
    return `${name||'course'}:h${validHoleNumber(hole)||1}`;
  }
  function courseOpenUiReady(course,hole=1){
    try{
      const expected=validHoleNumber(hole)||1;
      const activeName=String(document.getElementById('courseLine')?.textContent||'').trim().toLowerCase();
      const payloadName=String(course?.name||course?.courseName||'').trim().toLowerCase();
      let activeHole=validHoleNumber(activePlayingHole?.())||validHoleNumber(currentPlayingHole)||validHoleNumber(selectedHole)||0;
      if(!activeHole){
        const match=String(document.getElementById('holeLine')?.textContent||'').match(/\d+/);
        activeHole=validHoleNumber(match&&match[0])||0;
      }
      const courseScreen=document.getElementById('courseScreen');
      const courseScreenHidden=!courseScreen||courseScreen.classList.contains('hidden')||getComputedStyle(courseScreen).display==='none';
      const gpsVisible=document.body.classList.contains('shell-gps')||document.body.classList.contains('gdGpsActive')||document.body.classList.contains('gps-active');
      return document.body.classList.contains('gdMappedCourseMode')&&
        gpsVisible&&
        courseScreenHidden&&
        activeHole===expected&&
        (!payloadName||!activeName||payloadName===activeName);
    }catch(e){return false;}
  }
  function courseOpenAlreadySettled(course,hole=1){
    const key=courseOpenKey(course,hole);
    return window.__gdCourseFirstHoleReadyKey===key&&courseOpenUiReady(course,hole);
  }
  function courseOpenInFlight(course,hole=1){
    return window.__gdOpeningCourseToFirstHoleKey===courseOpenKey(course,hole);
  }
  function markCourseOpenReady(course,hole=1){
    window.__gdCourseFirstHoleReadyKey=courseOpenKey(course,hole);
    window.__gdCourseFirstHoleReadyAt=Date.now();
  }
  function showCourseLoadingIfNeeded(course,hole=1){
    if(!course||isManualGpsCourse(course)||courseOpenAlreadySettled(course,hole)||courseOpenInFlight(course,hole))return null;
    return showCourseLoading(course.name||course.courseName||'Loading course');
  }
  async function openCourseToFirstHole(course){
    const c=sessionCourse(course||courseObj());
    if(!c||isManualGpsCourse(c)){hideCourseLoading(0);return false;}
    const h=1;
    const openingKey=courseOpenKey(c,h);
    if(courseOpenAlreadySettled(c,h)){hideCourseLoading(0);return true;}
    if(courseOpenInFlight(c,h))return true;
    window.__gdOpeningCourseToFirstHoleKey=openingKey;
    showCourseLoading(c.name||c.courseName||'Loading course');
    updateCourseLoading('Opening Hole 1',28);
    try{
      rememberPlayingHole(h);
      try{selectedHole=h;currentPlayingHole=h;}catch(e){}
      try{sessionStorage.setItem('gd_active_playing_hole',String(h));sessionStorage.setItem('gd_mapper_active_hole',String(h));}catch(e){}
      try{
        const par=knownParForHole(h);
        if(typeof setHole==='function')setHole(par!==null?{hole:h,par}:{hole:h});
      }catch(e){}
      try{if(typeof resetPlay==='function')resetPlay(true);}catch(e){}
      updateCourseLoading('Running auto mapping',38);
	      try{await syncPublishedCourseMaps({quiet:true});}catch(e){}
      try{saveCourseHistoryEntry(c,'course-open');}catch(e){}
	      try{setMappedPlayMode('mapped',{skipFrame:true,silent:true});}catch(e){}
      const savedCourse=loadUserCourseData(userId(),courseId(c));
      if(courseHasSavedMemoryForHole(savedCourse,h)){
        updateCourseLoading('Loading saved course memory',56);
        await new Promise(resolve=>setTimeout(resolve,60));
        let savedFramed=false;
        try{savedFramed=!!focusMappedHoleOrSavedGreen(h,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,course:c});}catch(e){}
        if(savedFramed){
          updateCourseLoading('Saved Hole 1 loaded',100);
          markCourseOpenReady(c,h);
          hideCourseLoading(220);
          setTimeout(()=>checkClosestMappedHolePrompt(loadUserCourseData()),700);
          return true;
        }
        updateCourseLoading('Saved course loaded · set position',78);
      }
	      const openFrameRun=nextMappedFrameRun();
	      updateCourseLoading('Building fairway line',48);
	      await new Promise(resolve=>setTimeout(resolve,80));
	      if(!mappedFrameRunActive(openFrameRun)){hideCourseLoading(0);return false;}
	      let framed=false;
	      const autoMapFrameRun=nextMappedFrameRun();
	      try{await autoMapOsmCourse({quiet:true,frame:false,hole:h,promptStart:true,replaceExisting:true,fresh:true,course:c});}catch(e){}
	      if(!mappedFrameRunActive(autoMapFrameRun)){hideCourseLoading(0);return false;}
	      updateCourseLoading('Framing Hole 1',86);
	      try{framed=!!focusMappedHoleOrSavedGreen(h,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,course:c});}catch(e){}
	      if(framed){
	        updateCourseLoading('Hole 1 ready',100);
	        markCourseOpenReady(c,h);
	        hideCourseLoading(220);
	        setTimeout(()=>scheduleOsmAutoMapForPlay(c,{frame:false,delayMs:20}),700);
	        setTimeout(()=>checkClosestMappedHolePrompt(loadUserCourseData()),900);
	      }else{
	        updateCourseLoading('Hole 1 loaded · set position',100);
	        markCourseOpenReady(c,h);
	        hideCourseLoading(220);
	        setTimeout(()=>{
	          try{selectedHole=h;currentPlayingHole=h;}catch(e){}
	          try{if(typeof setHole==='function')setHole({hole:h});}catch(e){}
	          try{mode='start';}catch(e){}
	          try{if(typeof setState==='function')setState('Mapped: set position');}catch(e){}
	          try{if(typeof showHint==='function')showHint('Tap where you are standing');}catch(e){}
	        },260);
	        setTimeout(()=>scheduleOsmAutoMapForPlay(c,{frame:false,delayMs:20}),700);
	        framed=true;
	      }
      return framed;
    }catch(e){
      hideCourseLoading(250);
      reportMappedDropout(h,'course-open-error');
      return false;
    }finally{
      if(window.__gdOpeningCourseToFirstHoleKey===openingKey)window.__gdOpeningCourseToFirstHoleKey='';
    }
  }
  window.gdRememberPlayingHole=rememberPlayingHole;
  window.gdActivePlayingHole=activePlayingHole;
  window.gdFocusScorecardHoleOnGps=focusScorecardHoleOnGps;
  window.gdLockMappedGreenFromStart=forceLockMappedGreenFromStart;
  window.gdOpenCourseToFirstHole=openCourseToFirstHole;

  function saveCourseHistoryEntry(course=courseObj(),source='course-open'){
    try{
      const c=sessionCourse(course);
      if(!c||isManualGpsCourse(c))return null;
      const uid=userId();
      const cid=courseId(c);
      const store=loadStore();
      const saved=ensureCourse(store,uid,cid,courseName(c),c);
      saved.historyKind='device-course-history';
      saved.historySource=source;
      saved.lastOpenedAt=nowIso();
      saved.historyUpdatedAt=saved.lastOpenedAt;
      saved.updatedAt=saved.lastOpenedAt;
      const finder=courseFinderPoint(saved)||currentMapFinderPoint();
      const lat=Number(finder?.lat),lng=Number(finder?.lng);
      if(Number.isFinite(lat)&&Number.isFinite(lng)){
        saved.finderLat=saved.courseFinderLat=lat;
        saved.finderLng=saved.courseFinderLng=lng;
      }
      saveStore(store);
      try{renderCourseHistoryPicker();}catch(e){}
      try{gdCLRefreshProfileCard();}catch(e){}
      return saved;
    }catch(e){return null;}
  }
  function courseHasSavedMemoryForHole(course,hole=1){
    try{
      const c=course&&course.objects?course:loadUserCourseData(userId(),courseId(sessionCourse(course||courseObj())));
      if(!c)return false;
      const h=validHoleNumber(hole)||1;
      if(confirmedGreenRecord(c,h)||legacyGreenRecord(c,h))return true;
      return objectValues(c).some(object=>Number(object.holeNumber)===h&&(object.confirmed||object.type==='green'));
    }catch(e){return false;}
  }
  function renderCourseHistoryPicker(){
    try{
      const screen=document.getElementById('courseScreen');
      const assumed=document.getElementById('gdCourseAssumedOption');
      if(!screen||!assumed)return;
      let panel=document.getElementById('gdCourseHistoryPicker');
      if(!panel){
        panel=document.createElement('div');
        panel.id='gdCourseHistoryPicker';
        panel.className='gdCourseHistoryPicker';
        assumed.insertAdjacentElement('afterend',panel);
      }
      const courses=libraryCourses(userId())
        .filter(course=>!isPublishedCourse(course)&&isUsefulCourseName(course.courseName||course.name))
        .sort((a,b)=>String(b.historyUpdatedAt||b.lastOpenedAt||b.updatedAt||'').localeCompare(String(a.historyUpdatedAt||a.lastOpenedAt||a.updatedAt||'')))
        .slice(0,4);
      if(!courses.length){panel.innerHTML='';panel.classList.add('hidden');return;}
      panel.classList.remove('hidden');
      const rows=courses.map(course=>{
        const summary=courseSummary(course);
        const meta=[courseSummaryLine(summary),course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt?`last used ${dateLabel(course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt)}`:'saved on this device'].filter(Boolean).join(' · ');
        return `<button type="button" class="gdCourseHistoryRow" data-course-history-open="${esc(course.id)}"><div><strong>${esc(course.courseName||'Saved course')}</strong><span>${esc(meta)}</span></div><em>Open</em></button>`;
      }).join('');
      panel.innerHTML=`<div class="gdCourseHistoryHead"><strong>Recent Courses</strong><span>Saved on this device</span></div>${rows}`;
      panel.querySelectorAll('[data-course-history-open]').forEach(btn=>{
        btn.onclick=ev=>{
          ev.preventDefault();ev.stopPropagation();
          const id=btn.getAttribute('data-course-history-open');
          if(typeof window.gdCLOpenCourseFromLibrary==='function')window.gdCLOpenCourseFromLibrary(id,1,null,false);
          else {
            const course=findLibraryCourse(id);
            if(course&&typeof openCourse==='function')openCourse({name:course.courseName,courseId:course.courseId,lat:course.finderLat||course.courseLat,lng:course.finderLng||course.courseLng});
          }
          return false;
        };
      });
    }catch(e){}
  }
  window.gdSaveCourseHistoryEntry=saveCourseHistoryEntry;
  window.gdRenderCourseHistoryPicker=renderCourseHistoryPicker;

  function wrapGpsFunctions(){
    if(!window.__gdCourseLibraryGpsWrapped){
      window.__gdCourseLibraryGpsWrapped=true;
      const oldOpen=typeof openCourse==='function'?openCourse:window.openCourse;
      if(typeof oldOpen==='function'){
        const wrapped=function(c){
          if(c?.assumedCandidate){
            if(isUsefulCourseName(c.name||c.courseName)){
              const course={...c,assumed:false,source:c.source||'assumed-known-course'};
              try{sessionStorage.removeItem('gd_assumed_course_name');window.gdAssumedCourseName='';}catch(e){}
              showCourseLoadingIfNeeded(course,1);
              const res=oldOpen.call(this,course);
              setTimeout(ensureAssumedCourseBadge,80);
              openCourseToFirstHole(course);
              return res;
            }
            setAssumedCourseName(c.name||assumedCourseLabel());
            const manual={name:'Manual GPS',lat:c.lat,lng:c.lng};
            const res=oldOpen.call(this,manual);
            setTimeout(()=>{setAssumedCourseName(c.name||assumedCourseLabel());ensureAssumedCourseBadge();},60);
            return res;
          }
          if(window.gdCourseChangeMode==='assumed-label'&&isManualGpsCourse(courseObj())&&c&&!isManualGpsCourse(c)){
            window.gdCourseChangeMode='';
            setAssumedCourseName(c.name||'');
            try{document.getElementById('courseScreen')?.classList.add('hidden');}catch(e){}
            toastSafe('Course label updated');
            return c;
          }
          if(window.gdCourseChangeMode==='assumed-label'&&c&&isManualGpsCourse(c)){
            window.gdCourseChangeMode='';
          }
          if(!isManualGpsCourse(c)){
            saveCourseHistoryEntry(c,'course-open');
            showCourseLoadingIfNeeded(c,1);
          }
          const res=oldOpen.apply(this,arguments);
          try{
            if(c&&!/^manual gps$/i.test(String(c.name||''))){
              sessionStorage.removeItem('gd_assumed_course_name');
              window.gdAssumedCourseName='';
            }
          }catch(e){}
          setTimeout(ensureAssumedCourseBadge,80);
          if(!isManualGpsCourse(c)){
            openCourseToFirstHole(c);
          }
          return res;
        };
        window.openCourse=wrapped; try{openCourse=wrapped;}catch(e){}
      }
      const oldPlay=typeof playSelectedHole==='function'?playSelectedHole:window.playSelectedHole;
      if(typeof oldPlay==='function'){
        const wrapped=function(){
          const requestedHole=validHoleNumber(selectedHole)||validHoleNumber(currentPlayingHole)||1;
          const res=oldPlay.apply(this,arguments);
          let par=null;
          try{
            const h=rememberPlayingHole(currentPlayingHole||selectedHole||1);
            if(h&&typeof setHole==='function'){
              par=knownParForHole(h);
              setHole(par!==null?{hole:h,par}:{hole:h});
            }
          }catch(e){}
          try{saveCourseFinderCoordinate(currentMapFinderPoint(),'play-hole');}catch(e){}
	          const selectedCourse=sessionCourse(courseObj());
	          try{scheduleOsmAutoMapForPlay(selectedCourse,{hole:currentPlayingHole||selectedHole||requestedHole,delayMs:80,frame:true,promptStart:true});}catch(e){}
	          returnToGpsFromScorecard();
	          focusScorecardHoleOnGps(currentPlayingHole||selectedHole||requestedHole,par);
	          setTimeout(ensureAssumedCourseBadge,60);
	          setTimeout(returnToGpsFromScorecard,60);
	          const playFrameRun=mappedCourseAssistEnabled()?mappedFrameRunId:null;
	          if(playFrameRun!==null) scheduleMappedFrameTask(playFrameRun,260,()=>focusMappedHoleOrSavedGreen(currentPlayingHole||selectedHole||requestedHole,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,skipAutoLock:true,course:selectedCourse}));
	          else setTimeout(()=>focusMappedHoleOrSavedGreen(currentPlayingHole||selectedHole||requestedHole,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,skipAutoLock:true,course:selectedCourse}),260);
	          return res;
	        };
        window.playSelectedHole=wrapped; try{playSelectedHole=wrapped;}catch(e){}
      }
      const oldSaveScore=typeof saveHoleScore==='function'?saveHoleScore:window.saveHoleScore;
      if(typeof oldSaveScore==='function'){
        const wrapped=function(){
          try{rememberPlayingHole(currentPlayingHole||selectedHole||1);}catch(e){}
          const shouldReturn=(()=>{try{return sessionStorage.getItem('gd_return_from_scorecard')==='gps'||document.body.classList.contains('gdGpsActive')||document.body.classList.contains('shell-gps');}catch(e){return true;}})();
          const res=oldSaveScore.apply(this,arguments);
          if(shouldReturn)setTimeout(returnToGpsFromScorecard,80);
          return res;
        };
        window.saveHoleScore=wrapped; try{saveHoleScore=wrapped;}catch(e){}
      }
      const oldSetStart=typeof setStart==='function'?setStart:window.setStart;
      if(typeof oldSetStart==='function'){
        const wrapped=function(ll,saveUndo){
          const res=oldSetStart.apply(this,arguments);
          try{saveCourseFinderCoordinate(ll,'set-start');}catch(e){}
          try{scheduleMappedOrSavedGreenAfterStart(ll,!!saveUndo,saveUndo?'manual-start':'gps-start');}catch(e){}
          return res;
        };
        window.setStart=wrapped; try{setStart=wrapped;}catch(e){}
      }
      const oldSetGreen=typeof setGreenTarget==='function'?setGreenTarget:window.setGreenTarget;
      if(typeof oldSetGreen==='function'){
        const wrapped=function(ll,lock){
          const res=oldSetGreen.apply(this,arguments);
          saveCurrentGreen('manual');
          return res;
        };
        window.setGreenTarget=wrapped; try{setGreenTarget=wrapped;}catch(e){}
      }
      const oldReplace=window.replaceGreenCentre;
      if(typeof oldReplace==='function'){
        window.replaceGreenCentre=function(ll,opts){
          const res=oldReplace.apply(this,arguments);
          saveCurrentGreen('manual');
          return res;
        };
      }
      const oldAccept=typeof acceptGreenWand==='function'?acceptGreenWand:window.acceptGreenWand;
      if(typeof oldAccept==='function'){
        const wrapped=function(){
          const res=oldAccept.apply(this,arguments);
          const ctx=mapperContext();
          saveCurrentGreen('wand_accepted');
          if(ctx==='green')setMapperContext('');
          setTimeout(addForgetGreenButton,60);
          return res;
        };
        window.acceptGreenWand=wrapped; try{acceptGreenWand=wrapped;}catch(e){}
      }
      const oldImport=typeof importGreenWandResult==='function'?importGreenWandResult:window.importGreenWandResult;
      if(typeof oldImport==='function'){
        const wrapped=function(result){
          const res=oldImport.apply(this,arguments);
          const ctx=mapperContext();
          if(res)saveCurrentGreen(result?.source==='pixel'?'wand_accepted':'imported');
          if(ctx==='green')setMapperContext('');
          return res;
        };
        window.importGreenWandResult=wrapped; try{importGreenWandResult=wrapped;}catch(e){}
      }
      const oldReject=typeof rejectGreenWand==='function'?rejectGreenWand:window.rejectGreenWand;
      if(typeof oldReject==='function'){
        const wrapped=function(){
          if(mapperContext()==='green')setMapperContext('');
          return oldReject.apply(this,arguments);
        };
        window.rejectGreenWand=wrapped; try{rejectGreenWand=wrapped;}catch(e){}
      }
      const oldClose=typeof closeWandPanel==='function'?closeWandPanel:window.closeWandPanel;
      if(typeof oldClose==='function'){
        const wrapped=function(){
          if(mapperContext()==='green')setMapperContext('');
          return oldClose.apply(this,arguments);
        };
        window.closeWandPanel=wrapped; try{closeWandPanel=wrapped;}catch(e){}
      }
    }
  }

  function addForgetGreenButton(){
    return;
    const actions=document.querySelector('#gdWandPanel .gdWandActions');
    if(!actions)return;
    if(!document.getElementById('gdMoveGreenHoleBtn')){
      const move=document.createElement('button');
      move.id='gdMoveGreenHoleBtn';
      move.type='button';
      move.textContent='Change Hole';
      move.onclick=function(ev){ev.preventDefault();ev.stopPropagation();moveActiveGreenToHole();return false;};
      actions.appendChild(move);
    }
    if(!document.getElementById('gdUnassignGreenHoleBtn')){
      const unassign=document.createElement('button');
      unassign.id='gdUnassignGreenHoleBtn';
      unassign.type='button';
      unassign.textContent='Unassign Hole';
      unassign.onclick=function(ev){ev.preventDefault();ev.stopPropagation();unassignActiveGreen();return false;};
      actions.appendChild(unassign);
    }
    if(!document.getElementById('gdForgetGreenBtn')){
      const btn=document.createElement('button');
      btn.id='gdForgetGreenBtn';
      btn.type='button';
      btn.textContent='Forget Green';
      btn.onclick=function(ev){ev.preventDefault();ev.stopPropagation();resetActiveGreen();return false;};
      actions.appendChild(btn);
    }
  }

  function profileCardHtml(){
    const count=savedHoleCount();
    return `${count} saved course object${count===1?'':'s'}`;
  }
  function isCoachProfileCardView(){
    const kicker=document.querySelector('#gdProfileV67 .kicker');
    const coachEditing=/Coach Editing/i.test(kicker?.textContent||'');
    return coachEditing&&!(typeof window.gdCoachCanSeeProfileFeature==='function'&&window.gdCoachCanSeeProfileFeature('courses'));
  }
  function gdCLInjectProfileCourseCard(){
    const grid=document.querySelector('#gdProfileV67 .cards');
    const existing=document.getElementById('gdProfileCoursesCard');
    if(isCoachProfileCardView()){
      if(existing)existing.remove();
      return;
    }
    if(!grid||document.getElementById('gdProfileCoursesCard'))return;
    const btn=document.createElement('button');
    btn.id='gdProfileCoursesCard';
    btn.className='card';
    btn.type='button';
    btn.innerHTML=`<div class="gdCourseGreenIcon" aria-hidden="true"></div><div><strong>Courses</strong><span>${profileCardHtml()}</span></div>`;
    btn.onclick=function(ev){ev.preventDefault();openCourseLibraryPanel();return false;};
    grid.appendChild(btn);
  }
  function gdCLRefreshProfileCard(){
    const card=document.getElementById('gdProfileCoursesCard');
    if(isCoachProfileCardView()){
      if(card)card.remove();
      return;
    }
    if(card){
      const old=card.querySelector('span');
      if(old)old.textContent=profileCardHtml();
    }
  }
  function observeProfile(){
    if(profileObserver)return;
    profileObserver=new MutationObserver(()=>setTimeout(gdCLInjectProfileCourseCard,0));
    profileObserver.observe(document.body,{childList:true,subtree:true});
    const oldOpen=window.openProfilePanel;
    if(typeof oldOpen==='function'&&!oldOpen.__gdCoursesWrapped){
      const wrapped=function(){
        const res=oldOpen.apply(this,arguments);
        setTimeout(gdCLInjectProfileCourseCard,40);
        return res;
      };
      wrapped.__gdCoursesWrapped=true;
      window.openProfilePanel=wrapped; try{openProfilePanel=wrapped;}catch(e){}
    }
    const oldRender=window.renderProfilePanel;
    if(typeof oldRender==='function'&&!oldRender.__gdCoursesWrapped){
      const wrapped=function(){
        const res=oldRender.apply(this,arguments);
        setTimeout(gdCLInjectProfileCourseCard,40);
        return res;
      };
      wrapped.__gdCoursesWrapped=true;
      window.renderProfilePanel=wrapped; try{renderProfilePanel=wrapped;}catch(e){}
    }
  }

  function ensureCourseLibraryOverlay(){
    let el=document.getElementById('gdCourseLibraryOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdCourseLibraryOverlay';
    el.className='gdCourseLibraryOverlay hidden';
    el.innerHTML=`<div class="gdCourseLibrarySheet"><div class="gdCourseLibraryHead"><div><h2>Course History</h2><p>Saved on this device. Recent course objects load here first, so GPS does not have to rescan every time.</p></div><button class="gdSheetClose" type="button" onclick="closeCourseLibraryPanel()">×</button></div><div class="gdCourseLibrarySearch"><input id="gdCourseLibrarySearchInput" type="search" placeholder="Search course history"><button id="gdCourseLibraryFindCourseBtn" type="button">Find course</button></div><div id="gdCourseLibraryList"></div></div>`;
    document.body.appendChild(el);
    el.addEventListener('click',ev=>{if(ev.target===el)closeCourseLibraryPanel();});
    el.querySelector('#gdCourseLibrarySearchInput').addEventListener('input',ev=>{
      courseLibraryFilter=ev.target.value||'';
      renderCourseLibraryPanel();
    });
    el.querySelector('#gdCourseLibraryFindCourseBtn').onclick=function(ev){
      ev.preventDefault();
      window.gdCLOpenCourseSearch&&window.gdCLOpenCourseSearch();
    };
    return el;
  }
  function objectTypeLabel(type){
    return ({green:'green',bunker:'bunker pin',tee:'tee pin',fairway:'fairway point'}[type]||String(type||'object'));
  }
  function courseSummary(course){
    const allObjects=objectValues(course);
    const greenObjects=objectValues(course,'green').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const bunkers=allObjects.filter(o=>o.type==='bunker').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const tees=allObjects.filter(o=>o.type==='tee').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const fairways=allObjects.filter(o=>o.type==='fairway').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const otherObjects=allObjects.filter(o=>o.type&&!['green','bunker','tee','fairway'].includes(o.type)).sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
    const confirmedObjects=greenObjects.filter(o=>validHoleNumber(o.holeNumber)&&hasConfirmedGreenShape(o)).map(asGreenRecord);
    const legacyHoles=Object.values(course.holes||{})
      .filter(h=>!confirmedObjects.some(o=>Number(o.holeNumber)===Number(h.holeNumber)))
      .filter(h=>validHoleNumber(h.holeNumber))
      .map(h=>({...h,confirmed:true,legacy:true}));
    const holes=[...confirmedObjects,...legacyHoles].sort((a,b)=>(a.holeNumber||0)-(b.holeNumber||0));
    const shaped=[...confirmedObjects,...legacyHoles].filter(item=>Array.isArray(item.shape||item.greenShape)&&(item.shape||item.greenShape).length>=3).length;
    const savedGreens=confirmedObjects.length+legacyHoles.length;
    const totalObjects=allObjects.length+legacyHoles.length;
    return {holes,greenObjects,bunkers,tees,fairways,otherObjects,savedGreens,shaped,totalObjects};
  }
  function courseSummaryLine(s){
    const parts=[];
    if(s.savedGreens)parts.push(`${s.savedGreens} green target${s.savedGreens===1?'':'s'}`);
    if(s.bunkers.length)parts.push(`${s.bunkers.length} bunker${s.bunkers.length===1?'':'s'}`);
    if(s.tees.length)parts.push(`${s.tees.length} tee${s.tees.length===1?'':'s'}`);
    if(s.fairways.length)parts.push(`${s.fairways.length} fairway${s.fairways.length===1?'':'s'}`);
    return parts.length?parts.join(' · '):'No saved objects yet';
  }
  function objectRowTitle(object,label){
    const h=validHoleNumber(object.holeNumber);
    if(object.type==='green')return h?`Hole ${h} green`:'Green target';
    if(object.type==='bunker')return h?`Hole ${h} bunker`:'Bunker';
    if(h)return `Hole ${h} ${label}`;
    return label.charAt(0).toUpperCase()+label.slice(1);
  }
  function renderObjectRow(list,course,object,opts={}){
	    const row=document.createElement('div');
	    row.className='gdCourseHoleRow';
    const h=validHoleNumber(object.holeNumber);
    const assigned=h?` · Hole ${h}`:'';
    const label=opts.label||objectTypeLabel(object.type);
    const badge=object.type==='green'&&object.greenShape?' <span class="gdSavedGreenBadge">shape</span>':` <span class="gdCourseObjectBadge">${esc(label)}</span>`;
    const activeHole=activePlayingHole()||holeNumber();
    const readOnly=isPublishedCourse(course);
    const assignButton=readOnly?'':(!h||!object.confirmed?`<button type="button" data-action="assign">Use H${esc(activeHole)}</button>`:`<button type="button" data-action="unassign">Unassign</button>`);
    const forgetButton=readOnly?'':`<button class="danger" type="button" data-action="forget">Forget</button>`;
    const meta=object.type==='bunker'&&!assigned?'course bunker':`${esc(object.source||object.greenSource||'saved')}${assigned}`;
	    row.innerHTML=`<strong>${esc(opts.title||objectRowTitle(object,label))}${badge}</strong><span>${meta} · updated ${esc(dateLabel(object.updatedAt))}</span><div class="gdCourseActions"><button type="button" data-action="open">${readOnly?'Open':'Mapping mode'}</button>${assignButton}${forgetButton}</div>`;
    row.querySelector('[data-action="open"]').onclick=()=>gdCLOpenCourseFromLibrary(course.id,h||activeHole||1,object.id,true);
    const assign=row.querySelector('[data-action="assign"]');
    if(assign)assign.onclick=()=>window.gdCLAssignObject(course.id,object.id,activeHole);
    const unassign=row.querySelector('[data-action="unassign"]');
    if(unassign)unassign.onclick=()=>window.gdCLUnassignObject(course.id,object.id);
	    const forget=row.querySelector('[data-action="forget"]');
	    if(forget)forget.onclick=()=>{deleteCourseObject(object.id,course.userId,course.courseId);renderCourseLibraryPanel(course.id);};
	    list.appendChild(row);
	  }
	  function objectsForHole(course,hole){
	    const h=validHoleNumber(hole);
	    if(!h)return [];
	    return objectValues(course).filter(object=>Number(object.holeNumber)===Number(h)&&object.confirmed&&(object.type!=='green'||hasConfirmedGreenShape(object)||!!objectCenter(object)));
	  }
	  function unassignedObjects(course){
	    return objectValues(course)
	      .filter(object=>!validHoleNumber(object.holeNumber)||!object.confirmed)
	      .sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
	  }
	  function mappedHoleNumbers(course,s){
	    const set=new Set();
	    (s.holes||[]).forEach(h=>{const n=validHoleNumber(h.holeNumber);if(n)set.add(n);});
	    objectValues(course).forEach(object=>{const n=validHoleNumber(object.holeNumber);if(n&&object.confirmed)set.add(n);});
	    return Array.from(set).sort((a,b)=>a-b);
	  }
	  function holeSummaryLine(course,hole){
	    const objects=objectsForHole(course,hole);
	    const counts=objects.reduce((acc,o)=>{acc[o.type]=(acc[o.type]||0)+1;return acc;},{});
	    const parts=[];
	    if(counts.green)parts.push(`${counts.green} green`);
	    if(counts.tee)parts.push(`${counts.tee} tee`);
	    if(counts.fairway)parts.push(`${counts.fairway} fairway`);
	    if(counts.bunker)parts.push(`${counts.bunker} bunker`);
	    return parts.length?parts.join(' · '):'No mapped objects yet';
	  }
	  function renderHoleDetail(list,course,hole){
	    const h=validHoleNumber(hole);
	    if(!h)return;
	    const objects=objectsForHole(course,h);
	    const readOnly=isPublishedCourse(course);
	    const card=document.createElement('details');
	    card.className='gdCourseHoleDetail';
	    card.innerHTML=`<summary class="gdCourseHoleDetailHead"><div><strong>Hole ${h}</strong><span>${esc(holeSummaryLine(course,h))}</span></div></summary>`;
	    const body=document.createElement('div');
	    body.className='gdCourseHoleObjects';
	    body.insertAdjacentHTML('beforeend',`<button type="button" data-action="open-hole">Open mapping mode</button>`);
	    if(objects.length){
	      objects.sort((a,b)=>String(a.type).localeCompare(String(b.type))).forEach(object=>{
	        const row=document.createElement('div');
	        row.className='gdCourseHoleObject';
	        const label=objectTypeLabel(object.type);
	        row.innerHTML=readOnly
	          ? `<div><strong>${esc(label)}</strong><span>${esc(object.source||object.greenSource||'saved')} · ${esc(dateLabel(object.updatedAt))}</span></div><button type="button" data-open-object="${esc(object.id)}">Open</button>`
	          : `<div><strong>${esc(label)}</strong><span>${esc(object.source||object.greenSource||'saved')} · ${esc(dateLabel(object.updatedAt))}</span></div><label>Hole <input inputmode="numeric" min="1" max="18" value="${h}" data-object-hole="${esc(object.id)}"></label><button type="button" data-open-object="${esc(object.id)}">Open</button><button type="button" data-unassign-object="${esc(object.id)}">Unassign</button><button class="danger" type="button" data-delete-object="${esc(object.id)}">Forget</button>`;
	        body.appendChild(row);
	      });
	    }else{
	      body.insertAdjacentHTML('beforeend','<div class="gdCourseLibraryEmpty">Nothing assigned to this hole yet. Open mapping mode to save green, tee, fairway or bunker points here.</div>');
	    }
	    card.appendChild(body);
	    card.querySelector('[data-action="open-hole"]').onclick=()=>gdCLOpenCourseFromLibrary(course.id,h,null,true);
	    card.querySelectorAll('[data-object-hole]').forEach(input=>{
	      input.onchange=()=>{
	        const next=validHoleNumber(input.value);
	        if(!next){input.value=h;toastSafe('Enter a valid hole number');return;}
	        window.gdCLAssignObject(course.id,input.getAttribute('data-object-hole'),next);
	      };
	    });
	    card.querySelectorAll('[data-open-object]').forEach(btn=>{
	      btn.onclick=()=>gdCLOpenCourseFromLibrary(course.id,h,btn.getAttribute('data-open-object'),true);
	    });
	    card.querySelectorAll('[data-delete-object]').forEach(btn=>{
	      btn.onclick=()=>{deleteCourseObject(btn.getAttribute('data-delete-object'),course.userId,course.courseId);renderCourseLibraryPanel(course.id);};
	    });
	    card.querySelectorAll('[data-unassign-object]').forEach(btn=>{
	      btn.onclick=()=>window.gdCLUnassignObject(course.id,btn.getAttribute('data-unassign-object'));
	    });
	    list.appendChild(card);
	  }
	  function renderUnassignedDetail(list,course,objects){
	    if(!objects.length)return;
	    const readOnly=isPublishedCourse(course);
	    const card=document.createElement('details');
	    card.className='gdCourseHoleDetail gdCourseUnassignedDetail';
	    card.innerHTML=`<summary class="gdCourseHoleDetailHead"><div><strong>Unassigned</strong><span>${objects.length} saved object${objects.length===1?'':'s'} without a hole</span></div></summary>`;
	    const body=document.createElement('div');
	    body.className='gdCourseHoleObjects';
	    const activeHole=activePlayingHole()||holeNumber()||1;
	    body.insertAdjacentHTML('beforeend',`<button type="button" data-action="open-unassigned">Open mapping mode</button>`);
	    objects.forEach(object=>{
	      const row=document.createElement('div');
	      row.className='gdCourseHoleObject gdCourseUnassignedObject';
	      const label=objectTypeLabel(object.type);
	      row.innerHTML=readOnly
	        ? `<div><strong>${esc(label)}</strong><span>${esc(object.source||object.greenSource||'saved')} · ${esc(dateLabel(object.updatedAt))}</span></div><button type="button" data-open-object="${esc(object.id)}">Open</button>`
	        : `<div><strong>${esc(label)}</strong><span>${esc(object.source||object.greenSource||'saved')} · ${esc(dateLabel(object.updatedAt))}</span></div><label>Hole <input inputmode="numeric" min="1" max="18" value="${esc(activeHole)}" data-assign-hole="${esc(object.id)}"></label><button type="button" data-assign-object="${esc(object.id)}">Assign</button><button type="button" data-open-object="${esc(object.id)}">Mapping mode</button><button class="danger" type="button" data-delete-object="${esc(object.id)}">Forget</button>`;
	      body.appendChild(row);
	    });
	    card.appendChild(body);
	    card.querySelector('[data-action="open-unassigned"]').onclick=()=>gdCLOpenCourseFromLibrary(course.id,activeHole,null,true);
	    card.querySelectorAll('[data-assign-object]').forEach(btn=>{
	      btn.onclick=()=>{
	        const input=btn.closest('.gdCourseHoleObject')?.querySelector('[data-assign-hole]');
	        const h=validHoleNumber(input?.value);
	        if(!h){toastSafe('Enter a valid hole number');return;}
	        window.gdCLAssignObject(course.id,btn.getAttribute('data-assign-object'),h);
	      };
	    });
	    card.querySelectorAll('[data-open-object]').forEach(btn=>{
	      btn.onclick=()=>{
	        const input=btn.closest('.gdCourseHoleObject')?.querySelector('[data-assign-hole]');
	        gdCLOpenCourseFromLibrary(course.id,validHoleNumber(input?.value)||activeHole,btn.getAttribute('data-open-object'),true);
	      };
	    });
	    card.querySelectorAll('[data-delete-object]').forEach(btn=>{
	      btn.onclick=()=>{deleteCourseObject(btn.getAttribute('data-delete-object'),course.userId,course.courseId);renderCourseLibraryPanel(course.id);};
	    });
	    list.appendChild(card);
	  }
  function renderDetailTabs(list,course,s){
    const tabs=[
      ['greens','Greens',s.savedGreens],
      ['bunkers','Bunkers',s.bunkers.length],
      ['holes','Holes',mappedHoleNumbers(course,s).length],
      ['points','Tee/Fairway',s.tees.length+s.fairways.length+s.otherObjects.length]
    ];
    if(!tabs.some(([id])=>id===courseLibraryDetailTab))courseLibraryDetailTab='greens';
    const wrap=document.createElement('div');
    wrap.className='gdCourseLibraryTabs';
    tabs.forEach(([id,label,count])=>{
      const btn=document.createElement('button');
      btn.type='button';
      btn.className=id===courseLibraryDetailTab?'active':'';
      btn.textContent=`${label} ${count}`;
      btn.onclick=()=>{courseLibraryDetailTab=id;renderCourseLibraryPanel(course.id);};
      wrap.appendChild(btn);
    });
    list.appendChild(wrap);
  }
  function renderCourseFinderCard(list,course){
    const point=courseFinderPoint(course);
    const card=document.createElement('div');
    card.className=`gdCourseFinderCard${point?'':' empty'}`;
    if(point){
      const home={lat:Number(course.courseLat),lng:Number(course.courseLng)};
      const moved=Number.isFinite(home.lat)&&Number.isFinite(home.lng)?distance(home,point):null;
      const details=[
        `Lat/Lng ${coordLabel(point)}`,
        Number.isFinite(moved)&&moved>2?`${Math.round(moved)}m from course centre`:null,
        course.finderUpdatedAt?`updated ${dateLabel(course.finderUpdatedAt)}`:null
      ].filter(Boolean).join(' · ');
	      card.innerHTML=`<details class="gdCourseFinderDetails"><summary><div><small>Course locator pin</small><strong>Saved finder point</strong></div><span>Open</span></summary><div class="gdCourseFinderTop"><span>${esc(details)}</span></div><div class="gdCourseFinderActions"><button type="button" data-action="open">Show on map</button><button class="danger" type="button" data-action="clear">Clear pin</button></div></details>`;
      card.querySelector('[data-action="open"]').onclick=()=>window.gdCLOpenCourseLocatorFromLibrary(course.id);
      card.querySelector('[data-action="clear"]').onclick=()=>window.gdCLClearCourseFinder(course.id);
    }else{
	      card.innerHTML=`<details class="gdCourseFinderDetails"><summary><div><small>Course locator pin</small><strong>Not saved yet</strong></div><span>Open</span></summary><div class="gdCourseFinderTop"><span>Playing a hole will quietly save a general course centre for future searches.</span></div></details>`;
    }
    list.appendChild(card);
  }
  function renderCourseLibraryPanel(detailKey=null){
    const list=document.getElementById('gdCourseLibraryList');
    if(!list)return;
    const search=document.getElementById('gdCourseLibrarySearchInput');
    if(search&&search.value!==courseLibraryFilter)search.value=courseLibraryFilter;
    const uid=userId();
    const filter=normalizeCourseName(courseLibraryFilter);
    const courses=libraryCourses(uid)
      .filter(c=>!filter||normalizeCourseName(c.courseName).includes(filter))
      .sort((a,b)=>String(b.historyUpdatedAt||b.lastOpenedAt||b.updatedAt||'').localeCompare(String(a.historyUpdatedAt||a.lastOpenedAt||a.updatedAt||''))||String(a.courseName).localeCompare(String(b.courseName))||(isPublishedCourse(a)?1:0)-(isPublishedCourse(b)?1:0));
    if(!courses.length){
      list.innerHTML=`<div class="gdCourseCard"><strong>${filter?'No matching courses':'No saved courses yet'}</strong><span>${filter?'Try another search or find/select a course from GPS.':'Scan a green or save a mapper pin in GPS and it will appear here.'}</span></div>`;
      return;
    }
    if(detailKey){
      const course=findLibraryCourse(detailKey,uid);
      if(!course){renderCourseLibraryPanel();return;}
	      const s=courseSummary(course);
	      const finderSuffix=courseFinderPoint(course)?' · locator pin':'';
	      const recentSuffix=course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt?` · last used ${dateLabel(course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt)}`:'';
	      const published=isPublishedCourse(course);
	      const hasPublished=hasPublishedCourseMap(course);
	      const publishBtn=isAdminUser()&&!hasPublished?`<button type="button" onclick="gdCLPublishCourse('${esc(course.id)}')">Publish</button>`:'';
	      const status=hasPublished?' · published':'';
		      list.innerHTML=`<div class="gdCourseCard ${published?'published':''}"><strong>${esc(course.courseName)}</strong><span>${courseSummaryLine(s)}${finderSuffix}${recentSuffix}${status}</span><div class="gdCourseActions"><button type="button" onclick="renderCourseLibraryPanel()">Back</button><button type="button" onclick="gdCLOpenCourseFromLibrary('${esc(course.id)}')">Open Map</button><button class="primary" type="button" onclick="gdCLOpenCourseFromLibrary('${esc(course.id)}',1,null,true)">${published?'View Map':'Mapping Mode'}</button>${publishBtn}</div></div>`;
	      renderCourseFinderCard(list,course);
	      const holes=mappedHoleNumbers(course,s);
	      const loose=unassignedObjects(course);
	      if(holes.length)holes.forEach(h=>renderHoleDetail(list,course,h));
	      renderUnassignedDetail(list,course,loose);
	      if(!holes.length&&!loose.length){
		        list.insertAdjacentHTML('beforeend',`<details class="gdCourseHoleDetail"><summary class="gdCourseHoleDetailHead"><div><strong>Hole 1</strong><span>No mapped objects yet</span></div></summary><div class="gdCourseHoleObjects"><button type="button" onclick="gdCLOpenCourseFromLibrary('${esc(course.id)}',1,null,true)">Open mapping mode</button><div class="gdCourseLibraryEmpty">Start here to map the first hole, then use the hole selector in mapping mode for the rest.</div></div></details>`);
	      }
	      return;
	    }
    list.innerHTML='';
    courses.forEach(course=>{
      const s=courseSummary(course);
      const finderSuffix=courseFinderPoint(course)?' · locator pin':'';
      const recentSuffix=course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt?` · last used ${dateLabel(course.historyUpdatedAt||course.lastOpenedAt||course.updatedAt)}`:'';
      const published=isPublishedCourse(course);
      const card=document.createElement('button');
      card.className=`gdCourseCard${published?' published':''}`;
      card.type='button';
      card.innerHTML=`<strong>${esc(course.courseName)}</strong><span>${courseSummaryLine(s)}${finderSuffix}${recentSuffix}${hasPublishedCourseMap(course)?' · published':''}</span>`;
      card.onclick=()=>renderCourseLibraryPanel(course.id);
      list.appendChild(card);
    });
  }
  window.renderCourseLibraryPanel=renderCourseLibraryPanel;
  window.openCourseLibraryPanel=function(){
    ensureCourseLibraryOverlay().classList.remove('hidden');
    renderCourseLibraryPanel();
  };
  window.closeCourseLibraryPanel=function(){
    document.getElementById('gdCourseLibraryOverlay')?.classList.add('hidden');
  };
  async function syncPublishedCourseMaps(opts={}){
    try{
      if(typeof fetch!=='function')return loadPublishedStore();
      const res=await fetch(PUBLISHED_COURSE_API,{headers:{Accept:'application/json'},cache:'no-store'});
      if(!res.ok)return loadPublishedStore();
      const data=await res.json();
      const merged=mergePublishedStore(data);
      try{renderCourseLibraryPanel();}catch(e){}
      return merged;
    }catch(e){
      return loadPublishedStore();
    }
  }
  async function publishCourseMap(courseStoreId){
    if(!isAdminUser()){toastSafe('Admin only');return false;}
    const store=loadStore();
    const privateCourse=store.courses?.[courseStoreId];
    if(!privateCourse||isPublishedCourse(privateCourse)){toastSafe('Open your own saved course before publishing');return false;}
    const actor=currentAdminActor();
    const clean=normalizePublishedCourse(privateCourse,actor);
    if(!clean){toastSafe('Nothing to publish');return false;}
    const local=loadPublishedStore();
    local.version=1;
    local.courses=local.courses||{};
    local.courses[clean.id]=clean;
    local.updatedAt=nowIso();
    savePublishedStore(local);
    renderCourseLibraryPanel(courseStoreId);
    try{
      if(typeof fetch==='function'){
        const res=await fetch(PUBLISHED_COURSE_API,{
          method:'POST',
          headers:{'Content-Type':'application/json','Accept':'application/json'},
          body:JSON.stringify({course:clean,actor})
        });
        const data=await res.json().catch(()=>null);
        if(res.ok&&data){
          mergePublishedStore(data);
          renderCourseLibraryPanel(courseStoreId);
          toastSafe('Course map published');
          return true;
        }
      }
      toastSafe('Published locally. Global sync will work on Netlify.');
      return true;
    }catch(e){
      toastSafe('Published locally. Global sync will retry later.');
      return true;
    }
  }
  window.gdCLSyncPublishedCourseMaps=syncPublishedCourseMaps;
  window.gdCLPublishCourse=publishCourseMap;
	  window.gdCLAssignObject=function(courseStoreId,objectId,holeOverride=null){
    const store=loadStore();
    const course=store.courses[courseStoreId];
    if(isPublishedCourse(findLibraryCourse(courseStoreId))){toastSafe('Published maps are read-only');return;}
    const object=course?.objects?.[objectId];
    if(!object)return;
    const hole=Number(holeOverride||activePlayingHole()||object.holeNumber||holeNumber()||1);
    if(!Number.isFinite(hole)||hole<1||hole>36){toastSafe('Enter a valid hole number');return;}
	    rememberPlayingHole(hole);
	    assignObjectToHole(objectId,hole,true,course.userId,course.courseId);
	    toastSafe(`${objectTypeLabel(object.type)} assigned to hole ${hole}`);
	    updateMapperToolCompletion();
	    renderCourseLibraryPanel(courseStoreId);
	  };
	  window.gdCLUnassignObject=function(courseStoreId,objectId){
    const store=loadStore();
    const course=store.courses[courseStoreId];
    if(isPublishedCourse(findLibraryCourse(courseStoreId))){toastSafe('Published maps are read-only');return;}
    const object=course?.objects?.[objectId];
	    if(!object)return;
	    const oldHole=validHoleNumber(object.holeNumber);
	    unassignObjectFromHole(objectId,course.userId,course.courseId);
	    toastSafe(oldHole?`${objectTypeLabel(object.type)} unassigned from hole ${oldHole}`:`${objectTypeLabel(object.type)} is unassigned`);
	    updateMapperToolCompletion();
	    renderCourseLibraryPanel(courseStoreId);
	  };
	  window.gdCLOpenCourseSearch=function(){
    closeCourseLibraryPanel();
    try{document.getElementById('gdProfileV67')?.classList.add('hidden');}catch(e){}
    try{if(typeof enterGpsModule==='function')enterGpsModule({preserveState:true});}catch(e){}
    setTimeout(()=>{
      try{
        const screen=document.getElementById('courseScreen');
        const input=document.getElementById('searchInput');
        if(screen)screen.classList.remove('hidden');
        if(input){input.value=courseLibraryFilter||'';input.focus();if(input.value&&typeof manualSearch==='function')manualSearch();}
        toastSafe('Find or change course');
      }catch(e){}
    },100);
  };
		  function setFullMappingMode(active,hole=null){
		    const wasActive=!!window.gdFullMappingMode||document.body.classList.contains('gdFullMappingMode');
		    window.gdFullMappingMode=!!active;
		    document.body.classList.toggle('gdFullMappingMode',!!active);
		    if(active){
		      if(!wasActive)rememberMapperReturnMapSource();
		      try{mode='ready';}catch(e){}
		      try{if(typeof gdSuppressMapPlacementClick==='function')gdSuppressMapPlacementClick(700);}catch(e){}
		      if(!mapperOsmGuideUserChoice)setMapperLineGuideSource();
	      hintSafe('Choose a mapping tool');
	    }
	    try{
	      if(active)sessionStorage.setItem('gd_full_mapping_mode',hole?String(hole):'1');
	      else sessionStorage.removeItem('gd_full_mapping_mode');
	    }catch(e){}
	    if(active){
	      if(hole)rememberPlayingHole(hole);
	      const flyout=ensureMapperToolFlyout();
	      flyout.classList.remove('hidden');
	      positionMapperToolFlyout();
	      updateMapperHoleUi();
	      updateMapperToolCompletion();
	      updateMapperToolsButtonState();
	      focusMapperHoleReference(mapperHole(),{drawObjects:true,frame:true});
	    }else{
	      mapperOsmGuideUserChoice=false;
	      document.getElementById('gdMapperHoleStrip')?.classList.add('hidden');
	      document.getElementById('gdMapperHoleGuide')?.classList.add('hidden');
	      document.getElementById('gdMapperToolFlyout')?.classList.add('hidden');
	      try{clearMapperObjectLayers();}catch(e){}
	      try{clearMapperGuideUi();}catch(e){}
	      try{restoreMapperReturnMapSource();}catch(e){}
	      try{refreshPlayBadgeAfterMapping();}catch(e){}
	      updateMapperToolsButtonState();
	    }
	  }
	  function drawHoleObjects(course,hole,opts={}){
	    clearMapperObjectLayers();
	    const h=validHoleNumber(hole);
	    let objects=objectValues(course).filter(object=>Number(object.holeNumber)===Number(h)&&(object.confirmed||object.type==='green'));
	    if(opts.onlyType)objects=objects.filter(object=>object.type===opts.onlyType);
	    if(!opts.onlyType)drawFairwayRoute(course,hole,objects,opts);
	    objects.forEach(object=>{
	      if(object.type==='green')drawMapperGreenObject(object,opts);
	      else drawMapperPointObject(object,opts);
	    });
	  }
	  window.gdCLOpenCourseFromLibrary=function(courseStoreId,hole,objectId,mappingMode=false){
	    const saved=findLibraryCourse(courseStoreId);
	    if(!saved)return;
	    closeCourseLibraryPanel();
	    try{document.getElementById('gdProfileV67')?.classList.add('hidden');}catch(e){}
    const finder=courseFinderPoint(saved);
    const c={name:saved.courseName,courseId:saved.courseId,lat:finder?.lat||saved.courseLat||-36.9149,lng:finder?.lng||saved.courseLng||174.7255,courseLat:saved.courseLat||null,courseLng:saved.courseLng||null};
    if(finder){
      c.finderLat=finder.lat;
      c.finderLng=finder.lng;
    }
	    if(typeof openCourse==='function')openCourse(c);
	    if(hole){
	      setTimeout(()=>{
	        try{
	          rememberPlayingHole(Number(hole));
	          const par=knownParForHole(Number(hole));
	          setHole(par!==null?{hole:Number(hole),par}:{hole:Number(hole)});
	        }catch(e){}
	      },80);
	    }
	    setFullMappingMode(!!mappingMode,hole||null);
	    setTimeout(()=>{
	      const object=objectId?saved.objects?.[objectId]:null;
	      if(mappingMode&&hole)drawHoleObjects(saved,Number(hole));
	      if(object){
	        if(object.type==='green'){
	          window.gdPendingLibraryGreenRecord=asGreenRecord(object);
	          focusCourseObject(object,{quiet:true,frame:true,applyTarget:false});
	          hintSafe(mappingMode?'Mapping mode ready. Pin and save course objects without a shot.':'Green loaded. Tap your ball/start to build the shot.');
	        }else{
	          focusCourseObject(object);
	        }
	      }
	      else if(hole)loadSavedGreenForActiveHole({quiet:true,frame:true});
	      if(mappingMode){
	        updateMapperHoleUi();
	        updateMapperToolCompletion();
	        const flyout=ensureMapperToolFlyout();
	        flyout.classList.remove('hidden');
	        positionMapperToolFlyout();
	        updateMapperToolsButtonState();
	        toastSafe(`Hole ${hole||mapperHole()} mapping mode`);
	      }
	    },220);
	  };
  window.gdCLOpenCourseLocatorFromLibrary=function(courseStoreId){
    const store=loadStore();
    const saved=store.courses[courseStoreId];
    if(!saved)return;
    const finder=courseFinderPoint(saved);
    if(!finder){
      toastSafe('No course locator pin saved');
      return;
    }
    closeCourseLibraryPanel();
    try{document.getElementById('gdProfileV67')?.classList.add('hidden');}catch(e){}
    const c={name:saved.courseName,courseId:saved.courseId,lat:finder.lat,lng:finder.lng,courseLat:saved.courseLat||null,courseLng:saved.courseLng||null,finderLat:finder.lat,finderLng:finder.lng};
    if(typeof openCourse==='function')openCourse(c);
    setTimeout(()=>{
      focusCourseFinder(saved);
      toastSafe('Course locator pin');
    },220);
  };
  window.gdCLClearCourseFinder=function(courseStoreId){
    const store=loadStore();
    const saved=store.courses[courseStoreId];
    if(!saved)return;
    delete saved.finderLat;
    delete saved.finderLng;
    delete saved.courseFinderLat;
    delete saved.courseFinderLng;
    delete saved.finderSource;
    delete saved.finderUpdatedAt;
    saved.updatedAt=nowIso();
    saveStore(store);
    try{
      const active=JSON.parse(localStorage.getItem('gd_active_course_v1')||'null');
      if(active&&normalizeCourseName(active.name||active.courseName)===normalizeCourseName(saved.courseName)){
        delete active.finderLat;
        delete active.finderLng;
        delete active.courseFinderLat;
        delete active.courseFinderLng;
        delete active.finderUpdatedAt;
        localStorage.setItem('gd_active_course_v1',JSON.stringify(active));
      }
    }catch(e){}
    clearCourseFinderLayer();
    gdCLRefreshProfileCard();
    toastSafe('Course locator pin cleared');
    renderCourseLibraryPanel(courseStoreId);
  };

  function circleAround(center,radius=15){
    const pts=[];
    const axis=0;
    for(let i=0;i<48;i++){
      const a=axis+(Math.PI*2*i/48);
      try{pts.push(project(center,a,radius));}catch(e){}
    }
    return pts;
  }
  function pinLockSelectedHole(){
    const input=document.getElementById('gdPinLockHole');
    return validHoleNumber(input?.value)||mapperHole();
  }
  function pinLockGreenRecord(hole=pinLockSelectedHole()){
    return activeGreenRecord(userId(),courseId(),hole,{includeLegacy:true});
  }
  function pinLockCenterForHole(hole=pinLockSelectedHole()){
    const h=validHoleNumber(hole)||mapperHole();
    const saved=toLatLng(pinLockGreenRecord(h)?.greenCenter);
    if(saved)return saved;
    const active=activePlayingHole()||holeNumber()||mapperHole();
    try{if(Number(h)===Number(active)&&greenCentre)return toLatLng(greenCentre);}catch(e){}
    return null;
  }
  function getPinGreenShape(hole=pinLockSelectedHole(),centerOverride=null){
    const h=validHoleNumber(hole)||mapperHole();
    const rec=pinLockGreenRecord(h);
    let shape=rec?.greenShape||null;
    if(!shape||shape.length<3){
      const active=activePlayingHole()||holeNumber()||mapperHole();
      if(Number(h)===Number(active))shape=activeGreenShape();
    }
    if(shape&&shape.length>=3)return {shape:shape.map(toLatLng).filter(Boolean),fallback:false};
    let center=toLatLng(centerOverride)||pinLockCenterForHole(h);
    if(!center)return {shape:null,fallback:false};
    return {shape:circleAround(center,15),fallback:true};
  }
  function updatePinLockGreenUi(){
    const hole=pinLockSelectedHole();
    const rec=pinLockGreenRecord(hole);
    const status=document.getElementById('gdPinLockGreenStatus');
    const distance=document.getElementById('gdPinLockDistance');
    const place=document.getElementById('gdPinLockPlaceBtn');
    const center=pinLockCenterForHole(hole);
    if(status)status.textContent=rec?.greenCenter?`H${hole} saved green ready`:`No saved green for H${hole}`;
    if(place)place.disabled=!center;
    try{
      if(center&&distance&&!distance.value&&start)distance.value=Math.round(map.distance(start,center));
    }catch(e){}
  }
  function localTools(origin,center){
    const axis=typeof bearing==='function'?bearing(origin,center):0;
    const cosLat=Math.cos(Number(origin.lat)*Math.PI/180);
    const earth=111320;
    function toLocal(ll){
      const north=(ll.lat-origin.lat)*earth;
      const east=(ll.lng-origin.lng)*earth*cosLat;
      return {x:east*Math.cos(axis)-north*Math.sin(axis),y:east*Math.sin(axis)+north*Math.cos(axis)};
    }
    function toLl(p){return projectOffset(origin,axis,p.y,p.x);}
    return {axis,toLocal,toLl};
  }
  function pointInLocalPoly(pt,poly){
    let inside=false;
    for(let i=0,j=poly.length-1;i<poly.length;j=i++){
      const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
      if(((yi>pt.y)!=(yj>pt.y))&&(pt.x<(xj-xi)*(pt.y-yi)/(yj-yi+1e-9)+xi))inside=!inside;
    }
    return inside;
  }
  function solvePinLock(input){
    const origin=toLatLng(input.origin);
    const center=toLatLng(input.greenCenter);
    const range=Number(input.rangefinderDistanceM);
    const tools=localTools(origin,center);
    const poly=input.greenShape.map(toLatLng).filter(Boolean).map(tools.toLocal);
    const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y);
    const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
    const preferred={x:(minX+maxX)/2+(input.regionBias.x||0)*(maxX-minX)/2,y:(minY+maxY)/2+(input.regionBias.y||0)*(maxY-minY)/2};
    let best=null;
    const step=Math.max(.75,Math.min(1.5,Math.max(maxX-minX,maxY-minY)/40));
    for(let x=minX;x<=maxX;x+=step){
      for(let y=minY;y<=maxY;y+=step){
        const p={x,y};
        if(!pointInLocalPoly(p,poly))continue;
        const dist=Math.hypot(x,y);
        const distanceError=Math.abs(dist-range);
        const regionError=Math.hypot(x-preferred.x,y-preferred.y);
        const score=distanceError*10+regionError;
        if(!best||score<best.score)best={p,score,distanceError,regionError};
      }
    }
    if(!best){
      const p=tools.toLocal(center);
      best={p,score:999,distanceError:Math.abs(Math.hypot(p.x,p.y)-range),regionError:0};
    }
    return {latLng:tools.toLl(best.p),distanceError:best.distanceError,regionError:best.regionError};
  }

  function ensurePinLockOverlay(){
    let el=document.getElementById('gdPinLockOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdPinLockOverlay';
    el.className='gdPinLockOverlay hidden';
    document.body.appendChild(el);
    el.addEventListener('click',ev=>{if(ev.target===el)gdClosePinLock();});
    return el;
  }
  function ensurePinToolFlyout(){
    let el=document.getElementById('gdPinToolFlyout');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdPinToolFlyout';
    el.className='gdPinToolFlyout hidden';
    el.innerHTML=`<button class="gdPinToolAction primary" data-pin-choice="drag" type="button" aria-label="Drag pin"><span class="ico">⚑</span><span class="txt">Drag<br>Pin</span></button><button class="gdPinToolAction" data-pin-choice="lock" type="button" aria-label="Pin-Lock"><span class="ico">⌖</span><span class="txt">Pin<br>Lock</span></button>`;
    document.body.appendChild(el);
    el.addEventListener('pointerdown',ev=>ev.stopPropagation());
    el.addEventListener('click',ev=>{
      const btn=ev.target.closest('[data-pin-choice]');
      if(!btn)return;
      ev.preventDefault();
      ev.stopPropagation();
      const choice=btn.getAttribute('data-pin-choice');
      closePinToolFlyout();
      if(choice==='lock'){openPinLockSheet();return;}
      if(window.__gdOriginalStartPinPlacement)window.__gdOriginalStartPinPlacement(ev);
    });
    document.addEventListener('pointerdown',ev=>{
      const flyout=document.getElementById('gdPinToolFlyout');
      if(!flyout||flyout.classList.contains('hidden'))return;
      const flag=document.getElementById('flagTool');
      if(flyout.contains(ev.target)||flag?.contains(ev.target))return;
      closePinToolFlyout();
    },true);
    window.addEventListener('resize',positionPinToolFlyout);
    return el;
  }
  function positionPinToolFlyout(){
    const el=document.getElementById('gdPinToolFlyout');
    if(!el||el.classList.contains('hidden'))return;
    const flag=document.getElementById('flagTool');
    if(!flag)return;
    const r=flag.getBoundingClientRect();
    el.style.top=`${r.top+r.height/2}px`;
    el.style.right=`${Math.max(8,window.innerWidth-r.left+10)}px`;
  }
  function closePinToolFlyout(){
    document.getElementById('gdPinToolFlyout')?.classList.add('hidden');
  }
  function showPinChoice(ev){
    if(ev){ev.preventDefault();ev.stopPropagation();}
    document.getElementById('gdPinLockOverlay')?.classList.add('hidden');
    const el=ensurePinToolFlyout();
    el.classList.toggle('hidden');
    positionPinToolFlyout();
  }
	  function openPinLockSheet(){
	    const selectedHole=mapperHole();
	    let origin=null, center=null;
	    try{origin=start||null;center=pinLockCenterForHole(selectedHole);}catch(e){}
	    const mappingMode=!!window.gdFullMappingMode;
	    if(!origin&&!mappingMode){toastSafe('Set ball/start first');return;}
	    const currentDistance=(()=>{try{return origin&&((pin||center))?Math.round(map.distance(origin,pin||center)):'';}catch(e){return ''}})();
	    const el=ensurePinLockOverlay();
	    el.innerHTML=`<div class="gdPinLockSheet"><div class="gdPinLockHead"><div><h2>Pin-Lock</h2><p>${mappingMode&&!origin?'Mapping mode: place a pin by green area without a ball/start.':'Laser distance is strongest. The pad only gives a rough green area.'}</p></div><button class="gdSheetClose" type="button" onclick="gdClosePinLock()">×</button></div><input id="gdPinLockHole" type="hidden" value="${esc(selectedHole)}"><b id="gdPinLockGreenStatus" hidden></b><label class="gdPinLockLabel" for="gdPinLockDistance">Rangefinder distance</label><input id="gdPinLockDistance" class="gdPinLockInput" inputmode="decimal" value="${esc(currentDistance)}" aria-label="Rangefinder distance in metres" ${mappingMode&&!origin?'placeholder="Optional in mapping mode"':''}><label class="gdPinLockLabel">Approximate pin area</label><div id="gdPinLockPad" class="gdPinLockPad"><span id="gdPinLockDot" class="gdPinLockDot"></span></div><div class="gdPinLockActions"><button type="button" onclick="gdClosePinLock()">Cancel</button><button id="gdPinLockPlaceBtn" class="primary" type="button" onclick="gdPlacePinLock()">Place Pin</button></div></div>`;
	    el.classList.remove('hidden');
    window.__gdPinLockOpen=true;
    pinLockRegion={x:0,y:0};
    const holeInput=document.getElementById('gdPinLockHole');
    if(holeInput){
      holeInput.addEventListener('input',updatePinLockGreenUi);
      holeInput.addEventListener('change',()=>{
        const h=validHoleNumber(holeInput.value);
        if(!h){holeInput.value=mapperHole();toastSafe('Enter a hole from 1 to 18');}
        updatePinLockGreenUi();
      });
    }
	    updatePinLockGreenUi();
	    const pad=document.getElementById('gdPinLockPad');
	    const dot=document.getElementById('gdPinLockDot');
	    let dragging=false;
	    const setRegion=ev=>{
	      const r=pad.getBoundingClientRect();
	      let px=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width));
	      let py=Math.max(0,Math.min(1,(ev.clientY-r.top)/r.height));
	      let x=px*2-1;
	      let y=1-py*2;
	      const radius=Math.hypot(x,y);
	      if(radius>1){
	        x/=radius;
	        y/=radius;
	        px=(x+1)/2;
	        py=(1-y)/2;
	      }
	      pinLockRegion={x,y};
	      dot.style.left=`calc(${px*100}% - 12px)`;
	      dot.style.top=`calc(${py*100}% - 12px)`;
	    };
	    const stopDrag=ev=>{
	      if(!dragging)return;
	      dragging=false;
	      pad.classList.remove('gdDragging');
	      try{pad.releasePointerCapture(ev.pointerId);}catch(e){}
	    };
	    pad.addEventListener('pointerdown',ev=>{
	      ev.preventDefault();
	      dragging=true;
	      pad.classList.add('gdDragging');
	      try{pad.setPointerCapture(ev.pointerId);}catch(e){}
	      setRegion(ev);
	    },{passive:false});
	    pad.addEventListener('pointermove',ev=>{
	      if(!dragging)return;
	      ev.preventDefault();
	      setRegion(ev);
	    },{passive:false});
	    pad.addEventListener('pointerup',stopDrag);
	    pad.addEventListener('pointercancel',stopDrag);
	    pad.addEventListener('lostpointercapture',()=>{dragging=false;pad.classList.remove('gdDragging');});
	  }
  window.gdOpenPinLockSheet=openPinLockSheet;
  window.gdClosePinLock=function(){window.__gdPinLockOpen=false;document.getElementById('gdPinLockOverlay')?.classList.add('hidden');closePinToolFlyout();};
  window.gdTogglePinToolFlyout=function(ev){showPinChoice(ev||null);};
	  window.gdPlacePinLock=function(){
	    let origin=null, center=null;
	    const selectedHole=pinLockSelectedHole();
	    try{origin=start||null;center=pinLockCenterForHole(selectedHole);}catch(e){}
	    if(!center){toastSafe('Set the green first');return;}
	    const green=getPinGreenShape(selectedHole,center);
	    if(!green.shape){toastSafe('Set the green first');return;}
	    const range=Number(document.getElementById('gdPinLockDistance')?.value);
	    const mappingMode=!!window.gdFullMappingMode;
	    if(!origin&&!mappingMode){toastSafe('Set ball/start first');return;}
	    if(origin&&(!Number.isFinite(range)||range<=0)){toastSafe('Enter a distance');return;}
	    const solved=origin
	      ? solvePinLock({origin,rangefinderDistanceM:range,greenCenter:center,greenShape:green.shape,regionBias:pinLockRegion})
	      : {latLng:project(center,Math.atan2(pinLockRegion.x||0,pinLockRegion.y||1),Math.min(12,Math.hypot(pinLockRegion.x||0,pinLockRegion.y||0)*10)),distanceError:0,regionError:0};
	    window.__gdPinLockPlacing=true;
	    try{if(typeof placePin==='function')placePin(solved.latLng);}finally{window.__gdPinLockPlacing=false;}
	    const uid=userId(),cid=courseId(),h=selectedHole;
	    window.gdActivePin={id:`pin-${Date.now()}`,userId:uid,courseId:cid,holeNumber:h,pinPosition:toPlain(solved.latLng),source:'rangefinder',rangefinderDistanceM:origin?range:null,wasAdjusted:false,createdAt:nowIso(),updatedAt:nowIso()};
	    gdClosePinLock();
	    toastSafe(!origin?'Pin placed for mapping':(solved.distanceError>5||green.fallback?'Pin placed · check it':'Pin-Lock placed'));
	  };

  function wrapPinFunctions(){
    if(window.__gdPinLockWrapped)return;
    window.__gdPinLockWrapped=true;
    const oldStart=typeof startPinPlacement==='function'?startPinPlacement:window.startPinPlacement;
    if(typeof oldStart==='function'){
      window.__gdOriginalStartPinPlacement=oldStart;
      const wrapped=function(ev){
        if(ev){ev.preventDefault();ev.stopPropagation();}
        try{placingPin=false;}catch(e){}
        try{draggingFlag=false;}catch(e){}
        try{flagPointerStart=null;}catch(e){}
        try{document.getElementById('ghost').style.display='none';}catch(e){}
        try{document.getElementById('flagTool')?.classList.remove('softActive','grabbing');}catch(e){}
        openPinLockSheet();
      };
      window.startPinPlacement=wrapped; try{startPinPlacement=wrapped;}catch(e){}
    }
    const oldPlace=typeof placePin==='function'?placePin:window.placePin;
    if(typeof oldPlace==='function'){
      const wrapped=function(ll){
        const res=oldPlace.apply(this,arguments);
        if(!window.__gdPinLockPlacing){
          window.gdActivePin={id:`pin-${Date.now()}`,userId:userId(),courseId:courseId(),holeNumber:holeNumber(),pinPosition:toPlain(ll),source:'manual',wasAdjusted:false,createdAt:nowIso(),updatedAt:nowIso()};
        }
        return res;
      };
      window.placePin=wrapped; try{placePin=wrapped;}catch(e){}
    }
    const oldUpdate=typeof updatePinLine==='function'?updatePinLine:window.updatePinLine;
    if(typeof oldUpdate==='function'){
      const wrapped=function(){
        const res=oldUpdate.apply(this,arguments);
        try{
          if(window.gdActivePin&&pin){
            const moved=distance(window.gdActivePin.pinPosition,pin)>1.5;
            if(moved&&window.gdActivePin.source==='rangefinder'){
              window.gdActivePin.source='manual_adjusted_from_rangefinder';
              window.gdActivePin.wasAdjusted=true;
            }
            window.gdActivePin.pinPosition=toPlain(pin);
            window.gdActivePin.updatedAt=nowIso();
          }
        }catch(e){}
        return res;
      };
      window.updatePinLine=wrapped; try{updatePinLine=wrapped;}catch(e){}
    }
  }

  function install(){
    wrapGpsFunctions();
    wrapPinFunctions();
    observeProfile();
    observeMapperRail();
    installMapperToolsButton();
    addForgetGreenButton();
    ensureAssumedCourseBadge();
    setTimeout(gdCLInjectProfileCourseCard,300);
    setTimeout(installMappedPlayModeSetting,320);
    setTimeout(()=>syncPublishedCourseMaps({quiet:true}),520);
    // The final tool-screen isolation script owns flag capture in this app.
    setTimeout(installMapperToolsButton,350);
    setTimeout(ensureAssumedCourseBadge,400);
    setTimeout(syncCoursePickerAssumption,450);
    setTimeout(renderCourseHistoryPicker,500);
    setTimeout(installMapperToolsButton,1200);
    setTimeout(installMapperToolsButton,2500);
    setTimeout(()=>loadSavedGreenForActiveHole({quiet:true}),600);
    setTimeout(()=>{if(!window.gdFullMappingMode)clearMapperGuideUi();},700);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
  document.addEventListener('click',()=>setTimeout(addForgetGreenButton,80),true);
  document.addEventListener('click',()=>setTimeout(installMapperToolsButton,120),true);
  document.addEventListener('click',()=>setTimeout(installMappedPlayModeSetting,120),true);
  document.addEventListener('click',()=>setTimeout(ensureAssumedCourseBadge,120),true);
  document.addEventListener('click',()=>setTimeout(syncCoursePickerAssumption,130),true);
  document.addEventListener('click',()=>setTimeout(renderCourseHistoryPicker,140),true);
  document.addEventListener('click',ev=>{
    if(ev.target?.closest?.('#gdMapperToolsBtn'))openMapperToolsDrawer(ev);
  },true);
})();
