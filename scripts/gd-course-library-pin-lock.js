/* Clarity Caddy Personal Course Library + Pin-Lock MVP v1 */
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
    {courseName:'Maungakiekie Golf Club',courseId:'maungakiekie-golf-club',courseLat:-36.9229754,courseLng:174.7254871,source:'built-in-course',aliases:['maungakeikei','maunga']}
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
  function finiteMappingPoint(point){
    const lat=Number(point?.lat??point?.latitude);
    const lng=Number(point?.lng??point?.lon??point?.longitude);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
  }
  function builtInCourseById(id){
    const key=slug(id||'');
    if(!key)return null;
    return BUILT_IN_COURSE_CANDIDATES.find(course=>slug(course.courseId||course.id||course.courseName)===key)||null;
  }
  function mappingCourseSnapshot(course,opts={}){
    const base=sessionCourse(course||courseObj())||course||{};
    let snap={...base};
    let cid=slug(snap.courseId||snap.id||snap.savedCourseId||snap.canonicalKey||'');
    const knownById=builtInCourseById(cid);
    if(knownById){
      snap={
        ...snap,
        name:knownById.courseName,
        courseName:knownById.courseName,
        courseId:knownById.courseId||cid,
        id:snap.id||knownById.courseId||cid,
        courseLat:knownById.courseLat??snap.courseLat,
        courseLng:knownById.courseLng??snap.courseLng,
        lat:knownById.courseLat??snap.lat,
        lng:knownById.courseLng??snap.lng,
        source:knownById.source||snap.source||'known-course-id'
      };
    }
    let centre=finiteMappingPoint(opts.courseCentre||opts.courseCenter)||finiteMappingPoint(snap.courseCentre||snap.courseCenter)||finiteMappingPoint(guideCoursePoint(snap));
    if(!knownById){
      const nearest=centre?nearestKnownCourse(centre,320):null;
      const name=String(snap.name||snap.courseName||'').trim();
      if(nearest&&(!cid||isManualGpsCourse(snap)||isAssumedCourseName(name))){
        snap={
          ...snap,
          name:nearest.name||nearest.courseName,
          courseName:nearest.courseName||nearest.name,
          courseId:nearest.courseId||slug(nearest.name||nearest.courseName),
          id:snap.id||nearest.courseId||slug(nearest.name||nearest.courseName),
          courseLat:nearest.lat,
          courseLng:nearest.lng,
          lat:nearest.lat,
          lng:nearest.lng,
          source:nearest.source||snap.source||'known-course-centre'
        };
        cid=slug(snap.courseId||snap.id||snap.savedCourseId||snap.canonicalKey||'');
        centre=finiteMappingPoint({lat:nearest.lat,lng:nearest.lng})||centre;
      }
    }
    if(!centre)centre=finiteMappingPoint(guideCoursePoint(snap));
    const finalId=slug(snap.courseId||snap.id||snap.savedCourseId||snap.canonicalKey||snap.name||snap.courseName||'course');
    const finalName=String(snap.courseName||snap.name||finalId||'Course').trim()||'Course';
    return {
      ...snap,
      name:finalName,
      courseName:finalName,
      courseId:finalId,
      courseCentre:centre||null,
      courseLat:centre?.lat??snap.courseLat??snap.lat??null,
      courseLng:centre?.lng??snap.courseLng??snap.lng??null,
      lat:centre?.lat??snap.lat??snap.courseLat??null,
      lng:centre?.lng??snap.lng??snap.courseLng??null
    };
  }
  function mappingDebugApi(){try{return window.GDCourseMappingDebug&&typeof window.GDCourseMappingDebug.recordEvent==='function'?window.GDCourseMappingDebug:null;}catch(e){return null;}}
  function mappingDebugRun(course,opts={}){
    const api=mappingDebugApi();
    if(!api)return '';
    if(opts.debugRunId)return opts.debugRunId;
    const snapshot=mappingCourseSnapshot(course,opts);
    const payload={
      course:snapshot,
      courseId:snapshot.courseId,
      courseName:snapshot.courseName,
      courseCentre:snapshot.courseCentre,
      selectedAt:opts.selectedAt||null,
      attemptToken:opts.attemptToken||'',
      invokedBy:opts.reason||opts.source||'course-loader'
    };
    try{return opts.newRun?api.startRun(payload):api.getOrStartRun(payload);}catch(e){return '';}
  }
  function activeMappingDebugAttempt(course,opts={}){
    let attempt=null;
    try{attempt=window.__gdCourseMappingDebugActiveAttempt||null;}catch(e){attempt=null;}
    if(!attempt||!attempt.debugRunId)return null;
    const at=Number(attempt.at||attempt.startedAtMs||0)||0;
    if(at&&Date.now()-at>90000)return null;
    const snapshot=mappingCourseSnapshot(course,opts);
    const activeId=slug(attempt.courseId||attempt.course?.courseId||attempt.course?.id||'');
    const snapshotId=slug(snapshot.courseId||snapshot.id||'');
    if(activeId&&snapshotId&&activeId!==snapshotId)return null;
    const requestedHole=validHoleNumber(opts.hole);
    const attemptHole=validHoleNumber(attempt.hole);
    if(requestedHole&&attemptHole&&requestedHole!==attemptHole)return null;
    const requestedRun=String(opts.debugRunId||opts.runId||'');
    const attemptRun=mappingAttemptRunId(attempt);
    if(requestedRun&&attemptRun&&requestedRun!==attemptRun)return null;
    const requestedToken=String(opts.attemptToken||'');
    if(requestedToken&&attempt.attemptToken&&requestedToken!==attempt.attemptToken)return null;
    return attempt;
  }
  function currentMappingDebugAttempt(){
    try{return window.__gdCourseMappingDebugActiveAttempt||null;}catch(e){return null;}
  }
  function mappingAttemptRunId(attempt){
    return String(attempt&&(attempt.runId||attempt.debugRunId)||'').trim();
  }
  function publishMappingAttempt(attempt){
    if(!attempt)return null;
    const row={
      ...attempt,
      runId:mappingAttemptRunId(attempt),
      debugRunId:mappingAttemptRunId(attempt),
      at:Number(attempt.at||Date.now())||Date.now()
    };
    const previous=currentMappingDebugAttempt();
    if(previous&&!sameMappingAttempt(previous,row)){
      try{if(mapperOsmGuideFetch&&mapperOsmGuideFetch.controller&&typeof mapperOsmGuideFetch.controller.abort==='function')mapperOsmGuideFetch.controller.abort();}catch(e){}
      try{if(previous.debugRunId||previous.runId)recordMappingDebug(previous.debugRunId||previous.runId,{source:'course-loader',phase:'superseded',event:'mapping-run-superseded',summary:'Mapping run superseded by new active mapping attempt',details:{runFinal:true,newRunId:row.runId,newCourseId:row.courseId,newResolutionKey:row.resolutionKey,newAttemptToken:row.attemptToken}});}catch(e){}
    }
    try{window.__gdCourseMappingDebugActiveAttempt=row;}catch(e){}
    return row;
  }
  function mappingAttemptContext(course,hole,opts={}){
    const selectedAt=opts.selectedAt||nowIso();
    const c=mappingCourseSnapshot(course||opts.course||courseObj(),Object.assign({},opts,{selectedAt}));
    const h=validHoleNumber(hole||opts.hole)||1;
    const resolutionKey=opts.activeResolutionKey||opts.resolutionKey||coursePlayResolverKey(c,h);
    const debugRunId=opts.debugRunId||opts.runId||'';
    return {
      runId:debugRunId,
      debugRunId,
      course:c,
      courseId:courseId(c),
      courseName:courseName(c),
      courseCentre:c.courseCentre||null,
      hole:h,
      resolutionKey,
      resolverResolutionKey:opts.resolutionKey||resolutionKey,
      attemptToken:opts.attemptToken||'',
      selectedAt,
      source:opts.source||opts.reason||'unknown',
      callerFunction:opts.callerFunction||'unknown',
      createdAt:opts.createdAt||nowIso(),
      at:Number(opts.at||Date.now())||Date.now()
    };
  }
  function sameMappingAttempt(a,b){
    if(!a||!b)return false;
    const aRun=mappingAttemptRunId(a),bRun=mappingAttemptRunId(b);
    if(aRun&&bRun&&aRun!==bRun)return false;
    const aToken=String(a.attemptToken||''),bToken=String(b.attemptToken||'');
    if(aToken&&bToken&&aToken!==bToken)return false;
    const aCourse=slug(a.courseId||a.course?.courseId||''),bCourse=slug(b.courseId||b.course?.courseId||'');
    if(aCourse&&bCourse&&aCourse!==bCourse)return false;
    const aHole=validHoleNumber(a.hole),bHole=validHoleNumber(b.hole);
    if(aHole&&bHole&&aHole!==bHole)return false;
    const aKey=String(a.resolutionKey||''),bKey=String(b.resolutionKey||'');
    if(!aRun&&!bRun&&!aToken&&!bToken&&aKey&&bKey&&aKey!==bKey)return false;
    return !!(aRun&&bRun||aToken&&bToken||aKey&&bKey||aCourse&&bCourse);
  }
  function isCurrentMappingAttempt(attempt){
    const active=currentMappingDebugAttempt();
    if(!active)return true;
    return sameMappingAttempt(attempt,active);
  }
  function staleMappingDetails(attempt,attemptedAction,extra={}){
    const active=currentMappingDebugAttempt()||{};
    return Object.assign({
      staleRunId:mappingAttemptRunId(attempt),
      staleCourseId:attempt&&attempt.courseId||'',
      staleCourseName:attempt&&attempt.courseName||'',
      staleResolutionKey:attempt&&attempt.resolutionKey||'',
      staleAttemptToken:attempt&&attempt.attemptToken||'',
      activeRunId:mappingAttemptRunId(active),
      activeCourseId:active.courseId||'',
      activeCourseName:active.courseName||'',
      activeResolutionKey:active.resolutionKey||'',
      activeAttemptToken:active.attemptToken||'',
      attemptedAction,
      rejectionReason:'active mapping attempt changed',
      callerFunction:attempt&&attempt.callerFunction||extra.callerFunction||'unknown',
      source:attempt&&attempt.source||extra.source||'unknown',
      lateByMs:attempt&&attempt.at?Math.max(0,Date.now()-Number(attempt.at)):undefined
    },extra||{});
  }
  function recordStaleMappingActivity(attempt,opts={}){
    const api=mappingDebugApi();
    const details=staleMappingDetails(attempt,opts.attemptedAction||'unknown',opts);
    if(api&&typeof api.recordStaleActivity==='function'){
      try{return api.recordStaleActivity({
        staleRunId:details.staleRunId,
        stale:{courseId:details.staleCourseId,courseName:details.staleCourseName,resolutionKey:details.staleResolutionKey,attemptToken:details.staleAttemptToken},
        active:{runId:details.activeRunId,courseId:details.activeCourseId,courseName:details.activeCourseName,resolutionKey:details.activeResolutionKey,attemptToken:details.activeAttemptToken},
        attemptedAction:details.attemptedAction,
        rejectionReason:details.rejectionReason,
        callerFunction:details.callerFunction,
        source:opts.eventSource||details.source||'native-resolver',
        event:opts.event||'stale-result-rejected',
        summary:opts.summary||'Late automatic result rejected',
        lateByMs:details.lateByMs
      });}catch(e){}
    }
    const runId=details.staleRunId;
    if(runId){
      recordMappingDebug(runId,{source:opts.eventSource||details.source||'native-resolver',phase:'superseded',event:opts.event||'stale-result-rejected',summary:opts.summary||'Late automatic result rejected',details:Object.assign({},details,{runFinal:true})});
    }
    return details;
  }
  function startMappingDebugRun(course,opts={}){
    const active=activeMappingDebugAttempt(course,opts);
    if(active&&active.debugRunId)return active.debugRunId;
    const runId=mappingDebugRun(course,Object.assign({},opts,{newRun:true}));
    if(runId){
      publishMappingAttempt(mappingAttemptContext(course,opts.hole||1,Object.assign({},opts,{debugRunId:runId,callerFunction:opts.callerFunction||'startMappingDebugRun',source:opts.source||opts.reason||'course-loader'})));
    }
    return runId;
  }
  function recordMappingDebug(runId,event){
    const api=mappingDebugApi();
    if(!api)return null;
    try{return api.recordEvent(runId,event);}catch(e){return null;}
  }
  function finishMappingDebug(runId,result){
    const api=mappingDebugApi();
    if(!api||!runId)return null;
    try{return api.finishRun(runId,result);}catch(e){return null;}
  }
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
  function finitePlainPoint(point){
    if(!point)return null;
    const rawLat=point.lat;
    const rawLng=point.lng??point.lon;
    return finiteCoordinatePair(rawLat,rawLng);
  }
  function finiteCoordinatePair(rawLat,rawLng){
    if(rawLat==null||rawLat===""||rawLng==null||rawLng==="")return null;
    const lat=Number(rawLat),lng=Number(rawLng);
    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
  }
  function firstPresent(values){
    return (values||[]).find(value=>value!=null&&value!=="");
  }
  function finitePointFromValues(latValues,lngValues){
    return finiteCoordinatePair(firstPresent(latValues),firstPresent(lngValues));
  }
  function recentGpsPoint(){
    try{
      const state=window.gdGpsState||{};
      const fix=state.lastFix||null;
      const at=Number(state.lastFixAt||0);
      if(!fix||!Number.isFinite(Number(fix.lat))||!Number.isFinite(Number(fix.lng)))return null;
      if(Number.isFinite(at)&&at>0&&Date.now()-at>10*60*1000)return null;
      return {lat:Number(fix.lat),lng:Number(fix.lng)};
    }catch(e){return null;}
  }
  function mapSessionCenter(course=courseObj()){
    const c=course||{};
    if(isManualGpsCourse(c)){
      try{const point=finitePlainPoint(start);if(point)return point;}catch(e){}
      const gps=recentGpsPoint();
      if(gps)return gps;
    }
    const coursePoint=finitePointFromValues([c.lat,c.latitude],[c.lng,c.longitude,c.lon]);
    if(coursePoint)return coursePoint;
    try{const point=finitePlainPoint(start);if(point)return point;}catch(e){}
    return recentGpsPoint();
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
    return finitePointFromValues(
      [course?.courseLat,course?.lat,course?.latitude,course?.finderLat,course?.courseFinderLat],
      [course?.courseLng,course?.lng,course?.longitude,course?.lon,course?.finderLng,course?.courseFinderLng]
    );
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
    const courses=nearbyKnownCourses(center,maxDistance);
    return Array.isArray(courses)?courses[0]||null:null;
  }
  function sessionCourse(course=courseObj()){
    const c=course||{};
    if(!isManualGpsCourse(c)&&!isAssumedCourseName(rawCourseName(c)))return c;
    const center=mapSessionCenter(c);
    let savedName='';
    try{savedName=window.gdAssumedCourseName||sessionStorage.getItem('gd_assumed_course_name')||'';}catch(e){savedName=window.gdAssumedCourseName||'';}
    if(isAssumedCourseName(savedName))savedName='';
    const nearest=center?nearestKnownCourse(center):null;
    const name=nearest?.name||savedName||assumedCourseLabel(center);
    return {...c,name,courseId:nearest?.courseId||assumedCourseId(center),lat:nearest?.lat??center?.lat??null,lng:nearest?.lng??center?.lng??null,assumed:true,source:nearest?.source||'assumed-live-gps',distanceM:nearest?.distanceM};
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
  function courseHasMappedGreenFairway(course=null,hole=null){
    try{
      const h=validHoleNumber(hole);
      const c=(course&&objectValues(course).length)?course:(course?loadUserCourseData(userId(),courseId(course)):loadUserCourseData());
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
      const row=document.getElementById('gdMappedPlayModeRow');
      const role=String((typeof gdGetAccountPermission==='function'&&gdGetAccountPermission())||document.body?.dataset?.gdPermission||document.body?.dataset?.clarityAccountRole||document.body?.dataset?.accountRole||window.GolfDaddyAccounts?.current?.()?.role||'player').toLowerCase();
      const canShow=role==='admin'||role==='coach';
      if(row)row.hidden=!canShow;
      const courseScreen=document.getElementById('courseScreen');
      const pickerOpen=!!(courseScreen&&!courseScreen.classList.contains('hidden')&&getComputedStyle(courseScreen).display!=='none'&&getComputedStyle(courseScreen).visibility!=='hidden');
      const mapped=mappedCourseAssistEnabled();
      document.body.classList.toggle('gdMappedCourseMode',mapped&&!pickerOpen);
      if(mapped){
        try{document.getElementById('gdWandPanel')?.classList.add('hidden');}catch(e){}
        try{if(typeof clearWandHandles==='function')clearWandHandles();}catch(e){}
        try{if(typeof window.gdClearWandLive==='function')window.gdClearWandLive();}catch(e){}
      }
      if(btn&&canShow){
        btn.textContent=mapped?'Mapped':'Unmapped';
        btn.classList.toggle('active',mapped);
        btn.setAttribute('aria-label',mapped?'Mapped course mode':'Unmapped course mode');
        btn.title=mapped?'Mapped course mode':'Unmapped course mode';
      }
      if(sub&&canShow)sub.textContent=mapped?`Use saved mapping for ${courseName(activeCourseForMode())}`:`Plain two-tap for ${courseName(activeCourseForMode())}`;
    }catch(e){}
  }
  function installMappedPlayModeSetting(){
    try{
      const role=String((typeof gdGetAccountPermission==='function'&&gdGetAccountPermission())||document.body?.dataset?.gdPermission||document.body?.dataset?.clarityAccountRole||document.body?.dataset?.accountRole||window.GolfDaddyAccounts?.current?.()?.role||'player').toLowerCase();
      const canShow=role==='admin'||role==='coach';
      const existing=document.getElementById('gdMappedPlayModeToggle');
      if(existing){
        const existingRow=document.getElementById('gdMappedPlayModeRow');
        if(existingRow)existingRow.hidden=!canShow;
        if(!canShow){updateMappedPlayModeUi();return;}
        if(!existing.__gdMappedPlayModeBound){
          existing.__gdMappedPlayModeBound=true;
          existing.addEventListener('click',toggleMappedPlayMode);
        }
        updateMappedPlayModeUi();
        return;
      }
      if(!canShow){updateMappedPlayModeUi();return;}
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
      resolverVersion:input.resolverVersion||existing?.resolverVersion,
      resolvedAt:input.resolvedAt||existing?.resolvedAt,
      resolverSource:input.resolverSource||existing?.resolverSource,
      resolverConfidence:Number.isFinite(Number(input.resolverConfidence))?Number(input.resolverConfidence):existing?.resolverConfidence,
      resolverMatchScore:Number.isFinite(Number(input.resolverMatchScore))?Number(input.resolverMatchScore):existing?.resolverMatchScore,
      resolverEvidence:Array.isArray(input.resolverEvidence)?input.resolverEvidence.slice(0,18):existing?.resolverEvidence,
      greenShapeRefinement:input.greenShapeRefinement||existing?.greenShapeRefinement,
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
  const AUTOMAPPER_GREEN_SHAPE_CROP_PX=240;
  const AUTOMAPPER_GREEN_SHAPE_MAX_DRIFT_M=22;
  const AUTOMAPPER_GREEN_SHAPE_MIN_RADIUS_M=4;
  const AUTOMAPPER_GREEN_SHAPE_MAX_RADIUS_M=42;
  function automapperGreenShapeEngine(){
    try{return window.GDGreenShapeEngine||window.GolfDaddyGreenWandEngine||window.ClarityCaddieGreenWandEngine||null;}catch(e){return null;}
  }
  function automapperCaptureKey(course,hole){
    const identity=course?.courseId||course?.id||course?.courseName||course?.name||courseId(course);
    return 'gd_captured_hole_frame_v19_'+slug(String(identity||'course')+':h'+(Number(hole)||1));
  }
  function automapperRenderableManifest(manifest,hole){
    if(!manifest||!manifest.originPx||!Array.isArray(manifest.tiles)||!manifest.tiles.length)return null;
    const width=Number(manifest.imageWidth||manifest.width)||0;
    const height=Number(manifest.imageHeight||manifest.height)||0;
    const zoom=Number(manifest.captureZoom??manifest.zoom??manifest.tiles?.[0]?.z);
    if(!width||!height||!Number.isFinite(zoom))return null;
    const manifestHole=validHoleNumber(manifest.holeNumber||manifest.hole);
    if(manifestHole&&hole&&manifestHole!==hole)return null;
    return Object.assign({},manifest,{imageWidth:width,imageHeight:height,captureZoom:zoom});
  }
  function automapperReadCapturedManifest(course,hole){
    const candidates=[];
    const push=m=>{const clean=automapperRenderableManifest(m,hole);if(clean)candidates.push(clean);};
    try{if(typeof window.gdCapturedSurfaceReadManifest==='function')push(window.gdCapturedSurfaceReadManifest(courseId(course),hole));}catch(e){}
    try{if(typeof window.gdCapturedSurfaceReadManifest==='function')push(window.gdCapturedSurfaceReadManifest(course?.courseName||course?.name||courseId(course),hole));}catch(e){}
    try{push(window.gdHoleImageCaptureManifest);}catch(e){}
    try{push(window.__gdLastHoleImageCaptureManifest);}catch(e){}
    try{push(window.__gdV19CapturedHoleFrameManifest);}catch(e){}
    try{
      const raw=localStorage.getItem(automapperCaptureKey(course,hole));
      if(raw)push(JSON.parse(raw));
    }catch(e){}
    return candidates[0]||null;
  }
  function automapperLatLngToManifestPx(manifest,point){
    try{
      if(typeof map==='undefined'||!map||!manifest?.originPx)return null;
      const ll=toLatLng(point);
      if(!ll)return null;
      const projected=map.project(ll,Number(manifest.captureZoom));
      return {x:Number(projected.x)-Number(manifest.originPx.x||0),y:Number(projected.y)-Number(manifest.originPx.y||0)};
    }catch(e){return null;}
  }
  function automapperManifestPxToLatLng(manifest,point){
    try{
      if(typeof map==='undefined'||!map||typeof L==='undefined'||!manifest?.originPx)return null;
      const px=Number(point?.x)+Number(manifest.originPx.x||0);
      const py=Number(point?.y)+Number(manifest.originPx.y||0);
      const ll=map.unproject(L.point(px,py),Number(manifest.captureZoom));
      return toPlain(ll);
    }catch(e){return null;}
  }
  function automapperConstrainedCropBounds(manifest,centerPx){
    const size=AUTOMAPPER_GREEN_SHAPE_CROP_PX;
    const width=Number(manifest.imageWidth||manifest.width)||0;
    const height=Number(manifest.imageHeight||manifest.height)||0;
    if(!width||!height||!centerPx)return null;
    const x=clamp(Number(centerPx.x)-size/2,0,Math.max(0,width-size));
    const y=clamp(Number(centerPx.y)-size/2,0,Math.max(0,height-size));
    return {x,y,width:Math.min(size,width),height:Math.min(size,height)};
  }
  function automapperLoadCropImage(src){
    return new Promise((resolve,reject)=>{
      if(!src)return reject(new Error('missing tile url'));
      const img=new Image();
      img.crossOrigin='anonymous';
      img.onload=()=>resolve(img);
      img.onerror=()=>reject(new Error('tile image load failed'));
      img.src=src;
    });
  }
  function automapperTileUrl(tile){
    return tile?.url||tile?.src||tile?.imageUrl||tile?.dataUrl||tile?.href||'';
  }
  function automapperTileIntersectsCrop(tile,crop){
    const x=Number(tile?.x)||0,y=Number(tile?.y)||0,w=Number(tile?.width)||256,h=Number(tile?.height)||256;
    return x+w>crop.x&&y+h>crop.y&&x<crop.x+crop.width&&y<crop.y+crop.height;
  }
  async function automapperBuildGreenShapeCrop(manifest,centerPx){
    const crop=automapperConstrainedCropBounds(manifest,centerPx);
    if(!crop||crop.width<80||crop.height<80)return null;
    const canvas=document.createElement('canvas');
    canvas.width=Math.round(crop.width);
    canvas.height=Math.round(crop.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    if(!ctx)return null;
    let drawn=0;
    const tiles=(manifest.tiles||[]).filter(tile=>automapperTileIntersectsCrop(tile,crop));
    for(const tile of tiles){
      try{
        const img=await automapperLoadCropImage(automapperTileUrl(tile));
        ctx.drawImage(img,(Number(tile.x)||0)-crop.x,(Number(tile.y)||0)-crop.y,Number(tile.width)||256,Number(tile.height)||256);
        drawn++;
      }catch(e){}
    }
    if(!drawn)return null;
    try{ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1);}catch(e){return null;}
    return {canvas,crop,seed:{x:Number(centerPx.x)-crop.x,y:Number(centerPx.y)-crop.y},tileCount:drawn};
  }
  function automapperGreenShapeVerdict(polygon,center,detected={}){
    const pts=(polygon||[]).map(toPlain).filter(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng));
    if(pts.length<8)return {ok:false,reason:'too-few-map-points'};
    const centroid=shapeCentroid(pts);
    if(!centroid)return {ok:false,reason:'missing-centroid'};
    const drift=distance(center,centroid);
    if(!Number.isFinite(drift)||drift>AUTOMAPPER_GREEN_SHAPE_MAX_DRIFT_M)return {ok:false,reason:'centroid-drift',driftM:drift};
    const radii=pts.map(p=>distance(centroid,p)).filter(Number.isFinite);
    const avg=radii.reduce((sum,v)=>sum+v,0)/Math.max(1,radii.length);
    const max=Math.max(...radii,0);
    const min=Math.min(...radii,Infinity);
    if(avg<AUTOMAPPER_GREEN_SHAPE_MIN_RADIUS_M)return {ok:false,reason:'too-small',avgRadiusM:avg};
    if(avg>AUTOMAPPER_GREEN_SHAPE_MAX_RADIUS_M||max>AUTOMAPPER_GREEN_SHAPE_MAX_RADIUS_M*1.55)return {ok:false,reason:'too-large',avgRadiusM:avg,maxRadiusM:max};
    if(min>0&&max/min>7)return {ok:false,reason:'distorted-outline',avgRadiusM:avg,maxRadiusM:max,minRadiusM:min};
    if((Number(detected.confidence)||0)<0.52)return {ok:false,reason:'low-confidence',confidence:Number(detected.confidence)||0};
    return {ok:true,reason:'accepted',centroid,driftM:drift,avgRadiusM:avg,maxRadiusM:max,minRadiusM:min,confidence:Number(detected.confidence)||0};
  }
  async function automapperRunGreenShapeRefinement({course,hole,greenCenter,greenShape,debugRunId,attempt,source}={}){
    const detail={hole,source:source||'automapper',attemptToken:attempt&&attempt.attemptToken||'',resolutionKey:attempt&&attempt.resolutionKey||''};
    const skip=reason=>{
      recordMappingDebug(debugRunId,{source:'automapper-green-shape-engine',phase:'skipped',event:'automapper-green-shape-refinement-skipped',summary:'Green Shape Engine refinement skipped',details:Object.assign({},detail,{skipReason:reason})});
      return {accepted:false,phase:'skipped',reason};
    };
    const reject=(reason,extra={})=>{
      recordMappingDebug(debugRunId,{source:'automapper-green-shape-engine',phase:'rejected',event:'automapper-green-shape-refinement-rejected',summary:'Green Shape Engine refinement rejected',details:Object.assign({},detail,extra,{rejectionReason:reason})});
      return {accepted:false,phase:'rejected',reason,diagnostics:extra};
    };
    try{
      if(!greenCenter||!Array.isArray(greenShape)||greenShape.length<3)return skip('missing-candidate-green');
      if(attempt&&!isCurrentMappingAttempt(attempt))return skip('stale-mapping-attempt');
      const engine=automapperGreenShapeEngine();
      if(!engine||typeof engine.detect!=='function')return skip('engine-unavailable');
      const manifest=automapperReadCapturedManifest(course,hole);
      if(!manifest)return skip('no-renderable-crop');
      const centerPx=automapperLatLngToManifestPx(manifest,greenCenter);
      if(!centerPx)return skip('projection-unavailable');
      const crop=await automapperBuildGreenShapeCrop(manifest,centerPx);
      if(!crop)return skip('no-renderable-crop');
      const detected=await engine.detect({
        image:crop.canvas,
        width:crop.canvas.width,
        height:crop.canvas.height,
        candidateCentrePx:crop.seed,
        constraints:{width:crop.canvas.width,height:crop.canvas.height,minPoints:16,minConfidence:.52,minAcceptedDots:8,minBestChain:8}
      });
      if(!detected||!detected.ok)return reject(detected?.rejectionReason||'engine-rejected',{confidence:Number(detected&&detected.confidence)||0,metrics:detected&&detected.metrics||null,tileCount:crop.tileCount});
      const polygon=(detected.polygonPixels||[]).map(p=>automapperManifestPxToLatLng(manifest,{x:Number(p.x)+crop.crop.x,y:Number(p.y)+crop.crop.y})).filter(Boolean);
      const simplified=simplifyShape(polygon,56);
      const verdict=automapperGreenShapeVerdict(simplified,greenCenter,detected);
      if(!verdict.ok)return reject(verdict.reason,Object.assign({},verdict,{confidence:Number(detected.confidence)||0,metrics:detected.metrics||null,tileCount:crop.tileCount}));
      recordMappingDebug(debugRunId,{source:'automapper-green-shape-engine',phase:'completed',event:'automapper-green-shape-refinement-accepted',summary:'Green Shape Engine refinement accepted',confidence:Number(detected.confidence)||0,details:Object.assign({},detail,{polygonPoints:simplified.length,tileCount:crop.tileCount,driftM:verdict.driftM,avgRadiusM:verdict.avgRadiusM,confidence:Number(detected.confidence)||0,metrics:detected.metrics||null})});
      return {accepted:true,greenShape:simplified,confidence:Number(detected.confidence)||0,diagnostics:Object.assign({},verdict,{metrics:detected.metrics||null,tileCount:crop.tileCount})};
    }catch(e){
      return reject('refinement-error',{error:{message:e&&e.message||String(e)}});
    }
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
    const point=finitePointFromValues([course?.courseLat,course?.lat,course?.latitude],[course?.courseLng,course?.lng,course?.longitude,course?.lon]);
    if(point)return point;
    const finder=courseFinderPoint(course);
    if(finder)return finder;
    return null;
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
  function automapperExpectedHoleCount(){
    try{
      if(typeof scorecard!=='undefined'&&scorecard&&Array.isArray(scorecard.holes)&&scorecard.holes.length)return scorecard.holes.length;
    }catch(e){}
    try{
      if(window.scorecard&&Array.isArray(window.scorecard.holes)&&window.scorecard.holes.length)return window.scorecard.holes.length;
    }catch(e){}
    return 18;
  }
  const OSM_AUTOMAPPER_RADIUS_M=1400;
  const OSM_NATIVE_RESOLVER_RADIUS_M=3200;
  const OSM_NATIVE_FRAME_PAD_M=180;
  const OSM_NATIVE_FRAME_MAX_SPAN_M=6200;
  function osmQueryRadius(opts={}){
    const raw=Number(opts.osmRadiusM??opts.radiusM);
    if(Number.isFinite(raw)&&raw>0)return Math.max(400,Math.min(5000,Math.round(raw)));
    return OSM_AUTOMAPPER_RADIUS_M;
  }
  function normalizedOsmFrame(frame){
    if(!frame)return null;
    const south=Number(frame.south??frame.minLat);
    const west=Number(frame.west??frame.minLng);
    const north=Number(frame.north??frame.maxLat);
    const east=Number(frame.east??frame.maxLng);
    if(![south,west,north,east].every(Number.isFinite))return null;
    const out={south:Math.min(south,north),west:Math.min(west,east),north:Math.max(south,north),east:Math.max(west,east)};
    if(out.north<=out.south||out.east<=out.west)return null;
    return out;
  }
  function osmQuerySignature(opts={}){
    const frame=normalizedOsmFrame(opts.osmFrame||opts.queryFrame);
    if(frame)return `bbox:${frame.south.toFixed(6)},${frame.west.toFixed(6)},${frame.north.toFixed(6)},${frame.east.toFixed(6)}`;
    return `around:${osmQueryRadius(opts)}`;
  }
  function osmQueryScope(opts={},center){
    const frame=normalizedOsmFrame(opts.osmFrame||opts.queryFrame);
    if(frame){
      const box=[frame.south,frame.west,frame.north,frame.east].map(value=>Number(value).toFixed(6)).join(',');
      return {mode:'bbox',selector:`(${box})`,frame};
    }
    const radiusM=osmQueryRadius(opts);
    return {mode:'around',selector:`(around:${radiusM},${center.lat},${center.lng})`,radiusM};
  }
  function osmGuideQuery(scope){
    const selector=scope?.selector||'';
    const selectors=[
      ['way','golf','course'],['relation','golf','course'],
      ['way','golf','hole'],['relation','golf','hole'],
      ['way','golf','green'],['relation','golf','green'],
      ['way','golf','fairway'],['relation','golf','fairway'],
      ['way','golf','tee'],['relation','golf','tee'],
      ['way','golf','bunker'],['relation','golf','bunker'],
      ['way','golf','water_hazard'],['relation','golf','water_hazard'],
      ['way','golf','lateral_water_hazard'],['relation','golf','lateral_water_hazard'],
      ['way','natural','water'],['relation','natural','water']
    ];
    return `[out:json][timeout:18];(${selectors.map(([type,key,value])=>`${type}${selector}["${key}"="${value}"];`).join('')});out geom tags;`;
  }
  function osmFeatureCount(payload,golfType){
    return (payload?.elements||[]).filter(element=>String(element?.tags?.golf||'').toLowerCase()===golfType).length;
  }
  function nativeResolverSourceCoverage(payload,bundle){
    const elements=osmPayloadElements(payload);
    if(!elements)return {reusable:false,elements:0,greens:0,holes:0,expected:automapperExpectedHoleCount(),reason:'missing payload'};
    const expected=automapperExpectedHoleCount();
    const greens=Math.max(osmFeatureCount(payload,'green'),Array.isArray(bundle?.greens)?bundle.greens.length:0);
    const holes=osmFeatureCount(payload,'hole');
    const threshold=Math.max(6,Math.min(12,Math.ceil((expected||18)*0.5)));
    return {
      reusable:greens>=threshold||holes>=threshold,
      elements:elements.length,
      greens,
      holes,
      expected,
      threshold,
      reason:greens>=threshold||holes>=threshold?'source covers enough whole-course geometry':'source appears too narrow for native resolver'
    };
  }
  function automapperDebugDetails(payload,bundle){
    const elements=Array.isArray(payload?.elements)?payload.elements:[];
    const holeElements=elements.filter(element=>String(element?.tags?.golf||'').toLowerCase()==='hole');
    const refs=holeElements.map(element=>osmGuideHoleRef(element?.tags?.ref||element?.tags?.name)).filter(Boolean);
    const seen=new Set();
    const duplicates=[];
    refs.forEach(ref=>{if(seen.has(ref))duplicates.push(ref);seen.add(ref);});
    const expected=automapperExpectedHoleCount();
    const exposedNumbers=[...seen].sort((a,b)=>a-b);
    const missing=[];
    for(let h=1;h<=Math.min(expected,36);h++){
      if(!seen.has(h))missing.push(h);
    }
    const acceptedHoles=(Array.isArray(bundle?.guides)?bundle.guides:[]).map(guide=>validHoleNumber(guide?.hole)).filter(Boolean);
    return {
      inputGeometryCount:elements.length,
      osmGolfFeatures:elements.filter(element=>element?.tags&&element.tags.golf).length,
      holeLikeWays:holeElements.length,
      osmHoleCount:holeElements.length,
      scorecardHoles:expected,
      exposedHoleNumbers:exposedNumbers,
      reliableNumbers:exposedNumbers.length,
      missingNumbers:missing,
      duplicateNumbers:duplicates,
      acceptedHoles,
      rejectedHoles:Math.max(0,holeElements.length-acceptedHoles.length),
      unlabelledHoles:Math.max(0,holeElements.length-refs.length),
      confidence:expected?acceptedHoles.length/expected:0,
      reason:acceptedHoles.length>=Math.min(expected,18)&&!duplicates.length?'AutoMapper exposed enough numbered guides':'AutoMapper numbering was missing, incomplete, or duplicated'
    };
  }
  function nativeResolverScorecardHoles(){
    const holes=(()=>{try{return Array.isArray(scorecard?.holes)?scorecard.holes:null;}catch(e){return null;}})()
      ||(()=>{try{return Array.isArray(window.scorecard?.holes)?window.scorecard.holes:null;}catch(e){return null;}})()
      ||(()=>{try{return Array.isArray(window.gdScorecard?.holes)?window.gdScorecard.holes:null;}catch(e){return null;}})()
      ||(()=>{try{return Array.isArray(window.currentScorecard?.holes)?window.currentScorecard.holes:null;}catch(e){return null;}})();
    if(!Array.isArray(holes))return [];
    return holes.map(hole=>{
      try{return typeof gdScorecardHoleView==='function'?gdScorecardHoleView(hole):hole;}catch(e){return hole;}
    }).filter(Boolean);
  }
  function nativeResolverScorecardDistanceM(hole){
    const metres=knownScorecardNumber(hole?.distanceM??hole?.meters??hole?.metres??hole?.distanceMeters??hole?.distanceMetres);
    if(metres!==null)return metres;
    const yards=knownScorecardNumber(hole?.distanceYd??hole?.yards??hole?.yds??hole?.yardage??hole?.distanceYards);
    return yards!==null?yards*.9144:null;
  }
  function nativeResolverScorecardDistanceCount(holes){
    return (holes||[]).filter(hole=>Number.isFinite(nativeResolverScorecardDistanceM(hole))).length;
  }
  function nativeResolverScorecardLengthOrder(holes){
    return (holes||[]).map((hole,index)=>({
      hole:validHoleNumber(hole?.holeNumber||hole?.hole||hole?.number||index+1),
      distanceM:nativeResolverScorecardDistanceM(hole),
      par:knownScorecardNumber(hole?.par)
    })).filter(row=>row.hole&&Number.isFinite(row.distanceM)).sort((a,b)=>b.distanceM-a.distanceM);
  }
  function nativeResolverScorecardSourceRows(fallbackHoles=[]){
    const rows=(()=>{try{return Array.isArray(scorecard?.scorecardSources)?scorecard.scorecardSources:null;}catch(e){return null;}})()
      ||(()=>{try{return Array.isArray(window.scorecard?.scorecardSources)?window.scorecard.scorecardSources:null;}catch(e){return null;}})();
    if(Array.isArray(rows)&&rows.length){
      return rows.map(row=>{
        const holes=Array.isArray(row?.holes)?row.holes:[];
        return {
          source:row?.provider||row?.source||'scorecard',
          sourceUrl:row?.sourceUrl||'',
          holes:holes.map(hole=>{
            try{return typeof gdScorecardHoleView==='function'?gdScorecardHoleView(hole):hole;}catch(e){return hole;}
          }).filter(Boolean),
          distanceCount:nativeResolverScorecardDistanceCount(holes),
          lengthOrder:nativeResolverScorecardLengthOrder(holes)
        };
      }).filter(row=>Array.isArray(row.holes)&&row.holes.length);
    }
    const source=(()=>{try{return scorecard?.provider||scorecard?.source||window.scorecard?.provider||window.scorecard?.source||'scorecard';}catch(e){return 'scorecard';}})();
    const sourceUrl=(()=>{try{return scorecard?.sourceUrl||window.scorecard?.sourceUrl||'';}catch(e){return '';}})();
    return fallbackHoles.length?[{source,sourceUrl,holes:fallbackHoles,distanceCount:nativeResolverScorecardDistanceCount(fallbackHoles),lengthOrder:nativeResolverScorecardLengthOrder(fallbackHoles)}]:[];
  }
  function nativeResolverScorecardEvidenceFromHoles(holes,source){
    const sources=nativeResolverScorecardSourceRows(holes);
    const best=sources.slice().sort((a,b)=>(b.distanceCount||0)-(a.distanceCount||0))[0]||null;
    return {
      holes:holes||[],
      source:source||best?.source||'scorecard',
      sourceUrl:best?.sourceUrl||'',
      distanceCount:nativeResolverScorecardDistanceCount(holes),
      lengthOrder:nativeResolverScorecardLengthOrder(holes),
      sources
    };
  }
  async function nativeResolverFetchScorecardEvidence(course,attempt,opts={}){
    const before=nativeResolverScorecardHoles();
    const expected=automapperExpectedHoleCount();
    const needed=Math.min(expected||18,18);
    if(nativeResolverScorecardDistanceCount(before)>=needed)return nativeResolverScorecardEvidenceFromHoles(before,'already-loaded');
    const loader=(()=>{try{return typeof gdEnsureScorecardForCourse==='function'?gdEnsureScorecardForCourse:window.gdEnsureScorecardForCourse;}catch(e){return null;}})();
    if(typeof loader!=='function')return nativeResolverScorecardEvidenceFromHoles(before,'scorecard-loader-unavailable');
    try{
      await loader(course);
    }catch(e){}
    const after=nativeResolverScorecardHoles();
    return nativeResolverScorecardEvidenceFromHoles(after,'website-scorecard');
  }
  async function nativeResolverScorecardEvidence(course,opts={}){
    if(opts.nativeResolverScorecardPromise){
      try{
        const evidence=await opts.nativeResolverScorecardPromise;
        if(evidence&&Array.isArray(evidence.holes))return evidence;
      }catch(e){}
    }
    return nativeResolverFetchScorecardEvidence(course,opts.debugAttemptContext||null,opts);
  }
  function nativeResolverMapViewport(){
    try{
      if(typeof map==='undefined'||!map)return null;
      const center=typeof map.getCenter==='function'?map.getCenter():null;
      const zoom=typeof map.getZoom==='function'?map.getZoom():null;
      const bounds=typeof map.getBounds==='function'?map.getBounds():null;
      const out={};
      const c=finiteMappingPoint(center);
      if(c)out.center=c;
      if(Number.isFinite(Number(zoom)))out.zoom=Number(zoom);
      if(bounds){
        const north=typeof bounds.getNorth==='function'?bounds.getNorth():bounds._northEast?.lat;
        const south=typeof bounds.getSouth==='function'?bounds.getSouth():bounds._southWest?.lat;
        const east=typeof bounds.getEast==='function'?bounds.getEast():bounds._northEast?.lng;
        const west=typeof bounds.getWest==='function'?bounds.getWest():bounds._southWest?.lng;
        if([north,south,east,west].every(value=>Number.isFinite(Number(value))))out.bounds={north:Number(north),south:Number(south),east:Number(east),west:Number(west)};
      }
      return Object.keys(out).length?out:null;
    }catch(e){return null;}
  }
  function osmPayloadElements(payload){
    return Array.isArray(payload?.elements)?payload.elements:null;
  }
  function osmBoundsForPoints(points){
    const clean=(points||[]).map(toPlain).filter(point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lng));
    if(!clean.length)return null;
    return clean.reduce((bounds,point)=>({
      south:Math.min(bounds.south,point.lat),
      west:Math.min(bounds.west,point.lng),
      north:Math.max(bounds.north,point.lat),
      east:Math.max(bounds.east,point.lng)
    }),{south:Infinity,west:Infinity,north:-Infinity,east:-Infinity});
  }
  function osmPadBounds(bounds,padM=OSM_NATIVE_FRAME_PAD_M){
    const frame=normalizedOsmFrame(bounds);
    if(!frame)return null;
    const centerLat=(frame.south+frame.north)/2;
    const latPad=padM/111320;
    const lngPad=padM/(111320*Math.max(.2,Math.cos(centerLat*Math.PI/180)));
    return {south:frame.south-latPad,west:frame.west-lngPad,north:frame.north+latPad,east:frame.east+lngPad};
  }
  function osmBoundsSpanM(bounds){
    const frame=normalizedOsmFrame(bounds);
    if(!frame)return Infinity;
    return distance({lat:frame.south,lng:frame.west},{lat:frame.north,lng:frame.east});
  }
  function nativeResolverFrameElement(element){
    const golf=String(element?.tags?.golf||'').toLowerCase();
    if(golf==='course'||golf==='hole'||golf==='green'||golf==='fairway'||golf==='tee'||golf==='bunker'||golf==='water_hazard'||golf==='lateral_water_hazard')return true;
    return String(element?.tags?.natural||'').toLowerCase()==='water';
  }
  function nativeResolverFrameFromPayload(payload,course,opts={}){
    const elements=osmPayloadElements(payload)||[];
    const center=guideCoursePoint(course);
    const points=[];
    let featureCount=0;
    let hasCoursePolygon=false;
    elements.forEach(element=>{
      if(!nativeResolverFrameElement(element))return;
      const pts=osmGuidePointsFromElement(element);
      if(!pts.length)return;
      const featureCenter=shapeCentroid(pts)||pts[0];
      if(center&&featureCenter&&distance(center,featureCenter)>OSM_NATIVE_FRAME_MAX_SPAN_M)return;
      featureCount+=1;
      if(String(element?.tags?.golf||'').toLowerCase()==='course'&&pts.length>=3)hasCoursePolygon=true;
      points.push(...pts);
    });
    if(points.length<3)return null;
    if(!hasCoursePolygon&&featureCount<Number(opts.minFeatures||3))return null;
    const frame=osmPadBounds(osmBoundsForPoints(points),Number(opts.padM)||OSM_NATIVE_FRAME_PAD_M);
    if(!frame||osmBoundsSpanM(frame)>OSM_NATIVE_FRAME_MAX_SPAN_M)return null;
    return frame;
  }
  function nativeResolverSourceLoadErrorFromBundle(bundle,error=null){
    const message=error&&error.message||bundle?.automapperError?.message||'Native resolver could not load OSM course geometry';
    const name=error&&error.name||bundle?.automapperError?.name||'';
    return {
      code:'osm-request-failed',
      reason:'OSM request failed',
      message:String(message||'OSM request failed'),
      name:String(name||'')
    };
  }
  async function acquireNativeResolverSourceBundle(request,attempt,baseBundle,opts={}){
    let bundle=baseBundle&&typeof baseBundle==='object'?baseBundle:null;
    let payload=bundle?.osmPayload||null;
    let elements=osmPayloadElements(payload);
    let coverage=nativeResolverSourceCoverage(payload,bundle);
    recordMappingDebug(request.debugRunId,{source:'native-resolver',phase:'progress',event:'native-resolver-source-load-started',summary:'Native resolver source load started',details:{
      invokedBy:opts.reason||opts.source||request.reason||'course-loader',
      resolutionKey:request.resolutionKey,
      attemptToken:request.attemptToken,
      courseCentre:request.courseCentre||null,
      reason:elements&&coverage.reusable?'Reusing AutoMapper OSM payload':elements?'AutoMapper OSM payload was too narrow for native geometry analysis':bundle?.automapperError?'AutoMapper did not return reusable source geometry':'Native resolver requires source geometry before analysis',
      sourceCoverage:coverage
    }});
    if(elements&&coverage.reusable){
      recordMappingDebug(request.debugRunId,{source:'native-resolver',phase:'progress',event:'native-resolver-source-load-succeeded',summary:'Native resolver source load succeeded',details:{
        source:'automapper-osm-payload',
        osmFeatures:elements.length,
        acceptedGreens:Array.isArray(bundle?.greens)?bundle.greens.length:0,
        guides:Array.isArray(bundle?.guides)?bundle.guides.length:0,
        resolutionKey:request.resolutionKey,
        attemptToken:request.attemptToken,
        sourceCoverage:coverage
      }});
      return {bundle,payload,sourceLoadError:null,source:'automapper-osm-payload'};
    }
    const loadNativeSource=async(queryOpts={})=>loadOsmGuideBundle(request.course,Object.assign({},queryOpts,{needsGreens:true,fresh:true,skipGeometryResolver:true,suppressAutomapperTelemetry:true,debugRunId:request.debugRunId,source:'native-resolver',reason:'native-resolver-source-load',debugAttemptContext:attempt,callerFunction:'runNativeResolverStage'}));
    let loaded=null;
    let thrown=null;
    try{
      let frame=elements?nativeResolverFrameFromPayload(payload,request.course):null;
      if(frame){
        loaded=await loadNativeSource({osmFrame:frame,osmFrameReason:'automapper-source-frame'});
      }else{
        loaded=await loadNativeSource({osmRadiusM:elements?OSM_NATIVE_RESOLVER_RADIUS_M:OSM_AUTOMAPPER_RADIUS_M});
        const seedPayload=loaded?.osmPayload||null;
        const seedCoverage=nativeResolverSourceCoverage(seedPayload,loaded);
        frame=!seedCoverage.reusable?nativeResolverFrameFromPayload(seedPayload,request.course):null;
        if(frame)loaded=await loadNativeSource({osmFrame:frame,osmFrameReason:'native-source-seed-frame'});
      }
    }catch(error){
      thrown=error;
    }
    if(loaded&&loaded.stale)return {bundle:loaded,payload:loaded.osmPayload||{elements:[]},sourceLoadError:null,source:'stale'};
    payload=loaded?.osmPayload||null;
    elements=osmPayloadElements(payload);
    coverage=nativeResolverSourceCoverage(payload,loaded);
    if(elements){
      recordMappingDebug(request.debugRunId,{source:'native-resolver',phase:'progress',event:'native-resolver-source-load-succeeded',summary:'Native resolver source load succeeded',details:{
        source:'native-osm-fetch',
        osmFeatures:elements.length,
        acceptedGreens:Array.isArray(loaded?.greens)?loaded.greens.length:0,
        guides:Array.isArray(loaded?.guides)?loaded.guides.length:0,
        queryMode:loaded?.queryMode||'',
        queryRadiusM:loaded?.queryRadiusM||null,
        queryFrame:loaded?.queryFrame||null,
        sourceCoverage:coverage,
        resolutionKey:request.resolutionKey,
        attemptToken:request.attemptToken
      }});
      return {bundle:loaded,payload,sourceLoadError:null,source:'native-osm-fetch'};
    }
    const sourceLoadError=nativeResolverSourceLoadErrorFromBundle(loaded||bundle,thrown);
    const next=Object.assign({guides:[],greens:[]},bundle||{},loaded||{});
    next.osmPayload=next.osmPayload||{elements:[]};
    next.nativeResolverSourceLoadError=sourceLoadError;
    return {bundle:next,payload:next.osmPayload,sourceLoadError,source:'native-osm-fetch-failed'};
  }
  function shouldRunCourseGeometryResolver(course,payload,bundle,opts={}){
    const debugRunId=mappingDebugRun(course,opts);
    if(opts.skipGeometryResolver){
      if(!opts.suppressSkipTelemetry)recordMappingDebug(debugRunId,{source:'native-resolver',phase:'skipped',event:'native-resolver-skipped',summary:'Native resolver skipped',details:{skipReason:'skipGeometryResolver option',invokedBy:opts.reason||opts.source||'automapper'}});
      return false;
    }
    const resolver=window.GDCourseGeometryResolver;
    if(!resolver||typeof resolver.shouldRunForAutoMapper!=='function'){
      if(!opts.suppressSkipTelemetry)recordMappingDebug(debugRunId,{source:'native-resolver',phase:'skipped',event:'native-resolver-unavailable',summary:'Native resolver unavailable',details:{skipReason:'resolver API missing',invokedBy:opts.reason||opts.source||'automapper'}});
      return false;
    }
    try{
      const shouldRun=!!resolver.shouldRunForAutoMapper({
        course,
        osmPayload:payload,
        guideBundle:bundle,
        expectedHoleCount:automapperExpectedHoleCount()
      });
      if(!shouldRun&&!opts.suppressSkipTelemetry){
        recordMappingDebug(debugRunId,{source:'native-resolver',phase:'skipped',event:'native-resolver-not-needed',summary:'Native resolver not needed',details:{
          invokedBy:opts.reason||opts.source||'automapper',
          skipReason:'AutoMapper did not expose a numbering issue',
          osmHoleCount:osmFeatureCount(payload,'hole'),
          osmGreenCount:osmFeatureCount(payload,'green'),
          automapperGuideCount:Array.isArray(bundle?.guides)?bundle.guides.length:0,
          expectedHoleCount:automapperExpectedHoleCount()
        }});
      }
      return shouldRun;
    }catch(e){
      console.warn('[Clarity Caddy] Course Geometry Resolver gate failed',e);
      recordMappingDebug(debugRunId,{source:'native-resolver',phase:'failed',event:'native-resolver-gate-failed',summary:'Native resolver gate failed',details:{invokedBy:opts.reason||opts.source||'automapper'},error:{message:e&&e.message||String(e)}});
      return false;
    }
  }
  function guideFromResolvedHole(resolved,result){
    const candidate=resolved?.candidate;
    const points=(candidate?.path||[]).map(toPlain).filter(point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lng));
    if(!points.length)return null;
    const h=validHoleNumber(resolved?.holeNumber);
    if(!h)return null;
    const resolver=window.GDCourseGeometryResolver||{};
    const high=Number(resolver.highConfidence)||.76;
    const acceptedResolvedRun=String(result?.status||'')==='resolved'&&Array.isArray(result?.holes)&&result.holes.length>0&&!((result?.unresolvedScorecardHoles||[]).length);
    return {
      id:`cgr-${h}-${candidate.candidateId}`,
      hole:h,
      par:knownScorecardNumber(resolved.par)||candidate.inferredPar,
      points,
      source:result.source||resolver.source||'automapper-course-geometry-resolver',
      resolverVersion:result.resolverVersion||resolver.resolverVersion||'course-geometry-resolver-v1',
      resolvedAt:result.resolvedAt||nowIso(),
      resolverConfidence:Number(resolved.confidence)||0,
      resolverMatchScore:Number(resolved.matchScore)||0,
      resolverEvidence:Array.isArray(resolved.evidence)?resolved.evidence.slice(0,18):[],
      resolverProvisional:!acceptedResolvedRun&&Number(resolved.confidence)<high,
      officialDistanceM:Number(resolved.officialDistanceM)||undefined,
      greenId:candidate.greenId||''
    };
  }
  function mergeResolvedGeometryGuides(existingGuides,resolvedGuides){
    const byHole=new Set((existingGuides||[]).map(guide=>validHoleNumber(guide?.hole)).filter(Boolean));
    const merged=[...(existingGuides||[])];
    (resolvedGuides||[]).forEach(guide=>{
      const h=validHoleNumber(guide?.hole);
      if(!h||byHole.has(h))return;
      byHole.add(h);
      merged.push(guide);
    });
    return merged.sort((a,b)=>Number(a.hole||0)-Number(b.hole||0));
  }
  async function resolveCourseGeometryGuideBundle(course,payload,bundle,opts={}){
    if(!opts.forceNativeResolver&&!shouldRunCourseGeometryResolver(course,payload,bundle,opts))return bundle;
    const resolver=window.GDCourseGeometryResolver;
    const debugRunId=mappingDebugRun(course,opts);
    const attempt=opts.debugAttemptContext||mappingAttemptContext(course,opts.hole||1,Object.assign({},opts,{debugRunId,source:'native-resolver',callerFunction:opts.callerFunction||'resolveCourseGeometryGuideBundle'}));
    const startedAt=Date.now();
    recordMappingDebug(debugRunId,{source:'native-resolver',phase:'started',event:'native-resolver-started',summary:'Native resolver started',details:{
      invokedBy:opts.reason||opts.source||'automapper',
      resolutionKey:attempt.resolutionKey,
      attemptToken:attempt.attemptToken,
      callerFunction:attempt.callerFunction,
      eligibilityReason:'AutoMapper numbering was missing, incomplete, or duplicated'
    }});
    if(!isCurrentMappingAttempt(attempt)){
      recordStaleMappingActivity(attempt,{eventSource:'native-resolver',event:'native-resolver-stale-result-rejected',summary:'Native resolver stale result rejected',attemptedAction:'enter-native-resolver',callerFunction:'resolveCourseGeometryGuideBundle'});
      return {...bundle,stale:true};
    }
    try{
      const scorecardEvidence=await nativeResolverScorecardEvidence(course,opts);
      const result=await resolver.resolveCourseGeometryForAutoMapper({
        course,
        courseId:courseId(course),
        courseName:courseName(course),
        courseCentre:course?.courseCentre||guideCoursePoint(course),
        mapViewport:nativeResolverMapViewport(),
        scorecardHoles:scorecardEvidence.holes||[],
        scorecardEvidence:{
          source:scorecardEvidence.source||'',
          sourceUrl:scorecardEvidence.sourceUrl||'',
          distanceCount:scorecardEvidence.distanceCount||0,
          lengthOrder:scorecardEvidence.lengthOrder||[],
          sources:scorecardEvidence.sources||[]
        },
        osmPayload:payload,
        guideBundle:bundle,
        expectedHoleCount:automapperExpectedHoleCount(),
        sourceLoadError:opts.nativeResolverSourceLoadError||bundle?.nativeResolverSourceLoadError||null,
        sourceLoadStatus:opts.nativeResolverSourceLoadStatus||'',
        debugRunId,
        debugAttemptContext:attempt,
        attemptToken:attempt.attemptToken,
        resolutionKey:attempt.resolutionKey,
        debugInvokedBy:opts.reason||opts.source||'automapper',
        debugSuppressLifecycle:true
      });
      if(!isCurrentMappingAttempt(attempt)){
        recordStaleMappingActivity(attempt,{eventSource:'native-resolver',event:'native-resolver-stale-result-rejected',summary:'Native resolver stale result rejected',attemptedAction:'return-native-resolver-output',callerFunction:'resolveCourseGeometryGuideBundle'});
        return {...bundle,resolver:result,stale:true};
      }
      const resolvedGuides=(result?.holes||[])
        .map(resolved=>guideFromResolvedHole(resolved,result))
        .filter(Boolean)
        .filter(guide=>Number(guide.resolverConfidence)>=(Number(resolver.mediumConfidence)||.58));
      const next={
        ...bundle,
        guides:mergeResolvedGeometryGuides(bundle.guides,resolvedGuides),
        resolver:result
      };
      try{
        window.__gdCourseGeometryResolverLastResult=result;
        window.dispatchEvent(new CustomEvent('gd:course-geometry-resolved',{detail:{
          status:result?.status||'failed',
          confidence:result?.confidence||0,
          holes:resolvedGuides.length,
          source:result?.source||resolver.source||'automapper-course-geometry-resolver'
        }}));
      }catch(e){}
      const sourceLoadFailed=result?.status==='source-load-failed'||result?.sourceLoadError;
      recordMappingDebug(debugRunId,{source:'native-resolver',phase:result?.status==='resolved'?'completed':'failed',event:result?.status==='resolved'?'native-resolver-succeeded':sourceLoadFailed?'native-resolver-source-load-failed':'native-resolver-failed',summary:result?.status==='resolved'?'Native resolver succeeded':sourceLoadFailed?'Native resolver source load failed':'Native resolver failed',durationMs:Date.now()-startedAt,confidence:Number(result?.confidence)||0,details:{
        invokedBy:opts.reason||opts.source||'automapper',
        status:result?.status||'failed',
        sourceLoadError:result?.sourceLoadError||opts.nativeResolverSourceLoadError||bundle?.nativeResolverSourceLoadError||null,
        resolverRunId:result?.resolverRunId||'',
        greenCandidates:(result?.feedback?.geometry?.greenCandidates)||0,
        acceptedGreens:(result?.feedback?.geometry?.acceptedGreens)||0,
        rejectedGreens:(result?.feedback?.geometry?.rejectedGreens)||0,
        fairwayGroups:(result?.feedback?.geometry?.fairwayCorridors)||0,
        pathCandidates:(result?.feedback?.geometry?.candidatePaths)||0,
        scorecardHoleCount:(result?.feedback?.assignment?.scorecardHoles)||0,
        measuredDistanceRange:result?.feedback?.distance?.measuredRange||null,
        scorecardDistanceRange:result?.feedback?.distance?.scorecardRange||null,
        globalDistanceScale:result?.feedback?.distance?.globalScale||1,
        rankAgreement:result?.feedback?.distance?.rankAgreement||'',
        resolvedHoles:(result?.feedback?.assignment?.resolvedHoles)||0,
        unresolvedHoles:(result?.feedback?.assignment?.unresolvedHoles)||[],
        tieBreakersUsed:result?.feedback?.tieBreakers||{},
        warnings:result?.warnings||[]
      }});
      try{window.GDCourseMappingDebug?.renderAdminPanel?.();}catch(e){}
      if(resolvedGuides.length){
        console.info('[Clarity Caddy] Course Geometry Resolver produced AutoMapper guides',{
          status:result?.status,
          confidence:result?.confidence,
          holes:resolvedGuides.length,
          greens:osmFeatureCount(payload,'green'),
          fairways:osmFeatureCount(payload,'fairway')
        });
      }
      return next;
    }catch(error){
      console.warn('[Clarity Caddy] Course Geometry Resolver failed',error);
      recordMappingDebug(debugRunId,{source:'native-resolver',phase:'failed',event:'native-resolver-failed',summary:'Native resolver failed',durationMs:Date.now()-startedAt,details:{
        invokedBy:opts.reason||opts.source||'automapper'
      },error:{message:error&&error.message||String(error),name:error&&error.name||''}});
      return {...bundle,resolver:{
        courseId:courseId(course),
        status:'failed',
        holes:[],
        unresolvedCandidates:[],
        unresolvedScorecardHoles:[],
        analysisBoundary:[],
        confidence:0,
        warnings:[error&&error.message||'Course Geometry Resolver failed'],
        source:'automapper-course-geometry-resolver'
      }};
    }
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
    const logAutomapperTelemetry=opts.suppressAutomapperTelemetry!==true;
    const debugRunId=mappingDebugRun(course,opts);
    const attempt=opts.debugAttemptContext||mappingAttemptContext(course,opts.hole||1,Object.assign({},opts,{debugRunId,callerFunction:opts.callerFunction||'loadOsmGuideBundle',source:'automapper'}));
    if(!opts.fresh&&mapperOsmGuideMemory?.cacheKey===cacheKey&&(!needsGreens||Array.isArray(mapperOsmGuideMemory.greens))){
      if(logAutomapperTelemetry)recordMappingDebug(debugRunId,{source:'automapper',phase:'completed',event:'automapper-memory-hit',summary:'AutoMapper reused in-memory guide bundle',details:{
        invokedBy:opts.reason||opts.source||'course-loader',
        acceptedHoles:Array.isArray(mapperOsmGuideMemory.guides)?mapperOsmGuideMemory.guides.length:0,
        greenShapes:Array.isArray(mapperOsmGuideMemory.greens)?mapperOsmGuideMemory.greens.length:0
      }});
      return mapperOsmGuideMemory;
    }
    const cached=cachedOsmGuideBundle(course);
    if(!opts.fresh&&cached&&cached.guides.length&&(!needsGreens||cached.hasGreenCache)){
      if(logAutomapperTelemetry)recordMappingDebug(debugRunId,{source:'automapper',phase:'completed',event:'automapper-cache-hit',summary:'AutoMapper reused cached guide bundle',details:{
        invokedBy:opts.reason||opts.source||'course-loader',
        acceptedHoles:cached.guides.length,
        greenShapes:Array.isArray(cached.greens)?cached.greens.length:0
      }});
      mapperOsmGuideMemory={cacheKey,guides:cached.guides,greens:cached.greens};
      return mapperOsmGuideMemory;
    }
    const querySignature=osmQuerySignature(opts);
    const fetchKey=`${cacheKey}::${querySignature}`;
    if(mapperOsmGuideFetch?.cacheKey===fetchKey){
      if(!mapperOsmGuideFetch.attempt||sameMappingAttempt(mapperOsmGuideFetch.attempt,attempt))return mapperOsmGuideFetch.promise;
      try{if(mapperOsmGuideFetch.controller&&typeof mapperOsmGuideFetch.controller.abort==='function')mapperOsmGuideFetch.controller.abort();}catch(e){}
      mapperOsmGuideFetch=null;
    }
    const center=guideCoursePoint(course);
    if(!Number.isFinite(center?.lat)||!Number.isFinite(center?.lng)){
      if(logAutomapperTelemetry)recordMappingDebug(debugRunId,{source:'automapper',phase:'skipped',event:'automapper-no-course-center',summary:'AutoMapper skipped: course center unavailable',details:{invokedBy:opts.reason||opts.source||'course-loader',skipReason:'missing course center'}});
      return {guides:[],greens:[]};
    }
    const queryScope=osmQueryScope(opts,center);
    const query=osmGuideQuery(queryScope);
    const url='https://overpass-api.de/api/interpreter?data='+encodeURIComponent(query);
    const automapperStartedAt=Date.now();
    if(logAutomapperTelemetry)recordMappingDebug(debugRunId,{source:'automapper',phase:'started',event:'automapper-started',summary:'AutoMapper started',details:{
      invokedBy:opts.reason||opts.source||'course-loader',
      needsGreens,
      fresh:!!opts.fresh,
      center:{lat:center.lat,lng:center.lng},
      queryMode:queryScope.mode,
      queryRadiusM:queryScope.radiusM||null,
      queryFrame:queryScope.frame||null,
      resolutionKey:attempt.resolutionKey,
      attemptToken:attempt.attemptToken,
      expectedHoleCount:automapperExpectedHoleCount()
    }});
    let controller=null;
    try{if(typeof AbortController!=='undefined')controller=new AbortController();}catch(e){}
    const fetchOpts={headers:{Accept:'application/json'}};
    if(opts.signal)fetchOpts.signal=opts.signal;
    else if(controller)fetchOpts.signal=controller.signal;
    const promise=fetch(url,fetchOpts)
      .then(res=>res.ok?res.json():Promise.reject(new Error(`OSM guide ${res.status}`)))
      .then(async data=>{
        if(!isCurrentMappingAttempt(attempt)){
          if(logAutomapperTelemetry)recordStaleMappingActivity(attempt,{eventSource:'automapper',event:'automapper-stale-result-rejected',summary:'AutoMapper stale result rejected',attemptedAction:'complete-automapper',callerFunction:'loadOsmGuideBundle'});
          return {guides:[],greens:[],stale:true};
        }
        let bundle=parseOsmGuideBundle(data);
        bundle.osmPayload=data;
        bundle.queryMode=queryScope.mode;
        bundle.queryRadiusM=queryScope.radiusM||null;
        bundle.queryFrame=queryScope.frame||null;
        const autoDetails=automapperDebugDetails(data,bundle);
        const nativeRequested=!opts.skipGeometryResolver&&opts.allowInlineNativeResolver===true&&shouldRunCourseGeometryResolver(course,data,bundle,Object.assign({},opts,{debugRunId,source:opts.source||'automapper-inspection'}));
        bundle.automapperDetails=autoDetails;
        bundle.automapperStatus='success';
        bundle=nativeRequested?await resolveCourseGeometryGuideBundle(course,data,bundle,Object.assign({},opts,{debugRunId,skipGeometryResolver:false,source:opts.source||'automapper',debugAttemptContext:attempt,callerFunction:'resolveCourseGeometryGuideBundle'})):bundle;
        if(!isCurrentMappingAttempt(attempt)){
          if(logAutomapperTelemetry)recordStaleMappingActivity(attempt,{eventSource:'native-resolver',event:'native-resolver-stale-result-rejected',summary:'Native resolver stale result rejected',attemptedAction:'return-resolver-output-to-automapper',callerFunction:'loadOsmGuideBundle'});
          return {guides:[],greens:[],stale:true};
        }
        mapperOsmGuideMemory={cacheKey,guides:bundle.guides,greens:bundle.greens,osmPayload:data};
        if(bundle.resolver)mapperOsmGuideMemory.resolver=bundle.resolver;
        if(!opts.fresh)try{localStorage.setItem(cacheKey,JSON.stringify({savedAt:Date.now(),guides:bundle.guides,greens:bundle.greens}));}catch(e){}
        return mapperOsmGuideMemory;
      })
      .catch(error=>{
        console.warn('[Clarity Caddy] OSM guide fetch failed',error);
        if(!isCurrentMappingAttempt(attempt)){
          if(logAutomapperTelemetry)recordStaleMappingActivity(attempt,{eventSource:'automapper',event:'automapper-stale-result-rejected',summary:'AutoMapper stale result rejected',attemptedAction:'complete-automapper-fetch',callerFunction:'loadOsmGuideBundle'});
          return cached||{guides:[],greens:[],stale:true};
        }
        if(logAutomapperTelemetry)recordMappingDebug(debugRunId,{source:'automapper',phase:'failed',event:'automapper-failed',summary:'AutoMapper failed',durationMs:Date.now()-automapperStartedAt,details:{
          invokedBy:opts.reason||opts.source||'course-loader'
        },error:{message:error&&error.message||String(error),name:error&&error.name||''}});
        return cached||{guides:[],greens:[],automapperStatus:'failed',automapperError:{message:error&&error.message||String(error),name:error&&error.name||''}};
      })
      .finally(()=>{if(mapperOsmGuideFetch?.cacheKey===fetchKey)mapperOsmGuideFetch=null;});
    mapperOsmGuideFetch={cacheKey:fetchKey,promise,controller,attempt};
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
    if(!drawSavedGreen(green,{quiet:true,applyTarget:true,frame:true,stablePreLock:true}))return false;
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
    try{console.warn('[Clarity Caddy] mapped data dropout',{course:mappedModeCourseIdentity(),hole:h,reason});}catch(e){}
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
    const lat=Number(session?.lat??session?.latitude??center?.lat);
    const lng=Number(session?.lng??session?.longitude??center?.lng);
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
    if(!center)return [];
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
        if(start&&target&&typeof lockFrame==='function')lockFrame(opts.stablePreLock?false:true);
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
	    publishedCourseMapAvailability,
	    loadPublishedStore,
		    assumedCourseCandidate,
		    mappingCourseSnapshot,
	    activeMappingDebugAttempt,
		    currentMappingDebugAttempt,
		    activateMappingAttempt:publishMappingAttempt,
		    isCurrentMappingAttempt,
		    recordStaleMappingActivity,
		    startMappingDebugRun,
		    runCourseMappingAttempt,
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
	  function resolverObjectPatchForGuide(guide,source){
	    if(!guide?.resolverVersion)return {};
	    return {
	      source:guide.source||source||'automapper-course-geometry-resolver',
	      resolverVersion:guide.resolverVersion,
	      resolvedAt:guide.resolvedAt||nowIso(),
	      resolverSource:guide.source||'automapper-course-geometry-resolver',
	      resolverConfidence:Number(guide.resolverConfidence)||0,
	      resolverMatchScore:Number(guide.resolverMatchScore)||0,
	      resolverEvidence:Array.isArray(guide.resolverEvidence)?guide.resolverEvidence.slice(0,18):[]
	    };
	  }
	  async function saveOsmAutoHole(guide,greens,course=loadUserCourseData(),opts={}){
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
	    const resolverPatch=resolverObjectPatchForGuide(guide,guide?.source);
	    const resolverConfirmed=!guide?.resolverProvisional;
	    const countCommittedSave=object=>{if(object&&(resolverConfirmed||!guide?.resolverVersion))saved++;};
	    const refinement=!state.green?await automapperRunGreenShapeRefinement({course:selectedCourse,hole:h,greenCenter,greenShape,debugRunId:opts.debugRunId||'',attempt:opts.debugAttemptContext||null,source:match?.green?'osm_auto_green_polygon':'osm_auto_green_estimate'}):{accepted:false,phase:'skipped',reason:'green-already-mapped'};
	    const acceptedRefinement=refinement&&refinement.accepted;
	    const saveGreenShape=acceptedRefinement?refinement.greenShape:greenShape;
	    const greenSource=acceptedRefinement?'osm_auto_green_refined':(resolverPatch.source||(match?.green?'osm_auto_green_polygon':'osm_auto_green_estimate'));
	    const greenResolverPatch=acceptedRefinement?Object.assign({},resolverPatch,{
	      resolverConfidence:Math.max(Number(resolverPatch.resolverConfidence)||0,Number(refinement.confidence)||0),
	      resolverEvidence:[...(Array.isArray(resolverPatch.resolverEvidence)?resolverPatch.resolverEvidence:[]),'green-shape-engine-refinement'].slice(0,18),
	      greenShapeRefinement:{engine:'GDGreenShapeEngine',status:'accepted',confidence:Number(refinement.confidence)||0,diagnostics:refinement.diagnostics||null}
	    }):resolverPatch;
	    if(!state.green&&greenCenter&&saveGreenShape.length>=3){
		      countCommittedSave(saveCourseObject({
		        ...greenResolverPatch,
		        userId:uid,
		        courseId:cid,
		        courseName:name,
		        course:selectedCourse,
		        type:'green',
	        position:greenCenter,
	        shape:saveGreenShape,
	        greenShape:saveGreenShape,
	        source:greenSource,
	        holeNumber:h,
	        confirmed:resolverConfirmed,
	        maxDedupeDistanceM:4
	      }));
		    }
		    if(!state.tee&&tee){
		      countCommittedSave(saveCourseObject({...resolverPatch,userId:uid,courseId:cid,courseName:name,course:selectedCourse,type:'tee',position:tee,source:resolverPatch.source||'osm_auto_tee',holeNumber:h,confirmed:resolverConfirmed,maxDedupeDistanceM:4}));
		    }
		    if(!state.fairway){
		      fairwaySamplesForGuide(ordered).forEach((point,index)=>{
		        countCommittedSave(saveCourseObject({...resolverPatch,userId:uid,courseId:cid,courseName:name,course:selectedCourse,type:'fairway',position:point,source:resolverPatch.source||(index?'osm_auto_fairway_bend':'osm_auto_fairway'),holeNumber:h,confirmed:resolverConfirmed,maxDedupeDistanceM:4}));
		      });
		    }
	    return {saved,greenPolygon:!!match?.green,fallback:!match?.green,refinement};
	  }
	  async function persistOsmGuideBundle(course,bundle,opts={},debugRunId='',attempt=null){
	    const coursePoint=guideCoursePoint(course);
	    const guides=opts.hole?[bestGuideForHole(bundle&&bundle.guides,opts.hole,coursePoint)].filter(Boolean):chooseAutoMapGuides(bundle&&bundle.guides,coursePoint);
	    if(!guides.length)return {saved:0,holes:0,polygons:0,fallbacks:0,refinedGreenShapes:0,refinementRejected:0,refinementSkipped:0,guides:[],guideBundle:bundle||null};
	    let saved=0,polygons=0,fallbacks=0,refinedGreenShapes=0,refinementRejected=0,refinementSkipped=0;
	    for(const guide of guides){
		      const result=await saveOsmAutoHole(guide,bundle&&bundle.greens,loadUserCourseData(userId(),courseId(course))||course,{replaceExisting:!!opts.replaceExisting,sessionCourse:course,debugRunId,debugAttemptContext:attempt});
	      saved+=result.saved;
	      if(result.greenPolygon)polygons++;
	      if(result.fallback)fallbacks++;
	      if(result.refinement&&result.refinement.accepted)refinedGreenShapes++;
	      else if(result.refinement&&result.refinement.phase==='rejected')refinementRejected++;
	      else if(result.refinement&&result.refinement.phase==='skipped')refinementSkipped++;
	    }
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
	    return {saved,holes:guides.length,polygons,fallbacks,refinedGreenShapes,refinementRejected,refinementSkipped,guides,guideBundle:bundle||null};
	  }
	  async function autoMapOsmCourse(opts={}){
	    cancelMapperCapture();
	    const selectedAt=opts.selectedAt||nowIso();
	    const course=mappingCourseSnapshot(opts.course||sessionCourse(courseObj()),Object.assign({},opts,{selectedAt}));
	    const activeAttempt=activeMappingDebugAttempt(course,{hole:opts.hole||1});
	    const directRun=!opts.debugRunId&&!activeAttempt&&!opts.__gdResolverOwned&&!opts.__gdMappingRunStarted;
	    const debugRunId=opts.debugRunId||(activeAttempt&&activeAttempt.debugRunId)||mappingDebugRun(course,Object.assign({},opts,{selectedAt,newRun:directRun}));
	    const attempt=opts.debugAttemptContext||mappingAttemptContext(course,opts.hole||1,Object.assign({},opts,{debugRunId,attemptToken:opts.attemptToken||activeAttempt&&activeAttempt.attemptToken||'',activeResolutionKey:activeAttempt&&activeAttempt.resolutionKey||opts.resolutionKey,selectedAt,source:opts.reason||opts.source||'automapper',callerFunction:opts.callerFunction||'autoMapOsmCourse'}));
	    if(directRun)publishMappingAttempt(attempt);
	    const quiet=!!opts.quiet;
	    if(directRun){
	      recordMappingDebug(debugRunId,{source:'course-loader',phase:'started',event:'mapping-attempt-started',summary:'Course mapping attempt started',details:{
	        courseId:course.courseId,
        courseName:course.courseName,
        courseCentre:course.courseCentre,
        selectedAt,
        invokedBy:opts.reason||opts.source||'automapper',
        attemptToken:opts.attemptToken||'',
        resolutionKey:opts.resolutionKey||'',
	      }});
	    }
	    else if(activeAttempt&&activeAttempt.debugRunId===debugRunId&&!opts.debugRunId){
	      recordMappingDebug(debugRunId,{source:'course-loader',phase:'progress',event:'automapper-adopted-active-run',summary:'AutoMapper adopted active mapping run',details:{
	        courseId:course.courseId,
	        courseName:course.courseName,
	        hole:opts.hole||1,
	        resolutionKey:activeAttempt.resolutionKey||opts.resolutionKey||'',
	        attemptToken:activeAttempt.attemptToken||opts.attemptToken||'',
	        adoptedFrom:activeAttempt.source||'course-play-pipeline'
	      }});
	    }
    if(!quiet)toastSafe('Auto mapping from OSM...');
	    const bundle=await loadOsmGuideBundle(course,{needsGreens:true,fresh:!!opts.fresh,skipGeometryResolver:opts.skipGeometryResolver!==false,debugRunId,source:opts.source||opts.reason||'automapper',reason:opts.reason||opts.source||'automapper',debugAttemptContext:attempt,callerFunction:'autoMapOsmCourse'});
	    if(bundle&&bundle.stale||!isCurrentMappingAttempt(attempt)){
	      recordStaleMappingActivity(attempt,{eventSource:'automapper',event:'automapper-stale-result-rejected',summary:'AutoMapper stale result rejected',attemptedAction:'persist-geometry',callerFunction:'autoMapOsmCourse'});
	      return false;
	    }
	    const persisted=await persistOsmGuideBundle(course,bundle,opts,debugRunId,attempt);
	    if(!persisted.guides.length){
	      if(!quiet)toastSafe('No OSM hole lines found');
	      return Object.assign({saved:0,holes:0,polygons:0,fallbacks:0,automapperStatus:'failed',automapperError:bundle.automapperError||null},persisted);
	    }
	    const active=opts.hole?validHoleNumber(opts.hole):mapperHole();
	    const saved=persisted.saved,polygons=persisted.polygons,fallbacks=persisted.fallbacks,guides=persisted.guides;
	    const label=opts.hole?`H${active}`:`${guides.length} holes`;
	    if(!quiet||saved){
	      toastSafe(saved?`OSM base map ready`:`${label} already mapped`);
	    }
	    if(!quiet){
	      hintSafe(saved?`${label}: OSM base layer saved (${polygons} shaped green${polygons===1?'':'s'})`:`${label}: OSM base layer already exists`);
	    }
	    recordMappingDebug(debugRunId,{source:'persistence',phase:saved?'completed':'skipped',event:saved?'automapper-persistence-completed':'automapper-persistence-skipped',summary:saved?'AutoMapper geometry saved':'AutoMapper geometry already existed',details:{
	      invokedBy:opts.reason||opts.source||'automapper',
	      acceptedGuides:guides.length,
	      savedObjects:saved,
	      shapedGreens:polygons,
	      fallbackGreenShapes:fallbacks,
	      refinedGreenShapes:persisted.refinedGreenShapes||0,
	      refinementRejected:persisted.refinementRejected||0,
	      refinementSkipped:persisted.refinementSkipped||0,
	      hole:opts.hole?active:'',
	      existingTrustedMap:!saved
	    }});
	    return Object.assign({saved,holes:guides.length,polygons,fallbacks,automapperStatus:'success',automapperError:bundle.automapperError||null},persisted);
	  }
	  function scheduleOsmAutoMapForPlay(course,opts={}){
	    try{
	      const c=sessionCourse(course||courseObj());
	      if(!c||isManualGpsCourse(c))return false;
	      if(window.__gdCoursePlayInteractiveFallbackActive||interactiveGreenFallbackState){
	        recordCoursePlayDebug('course-mapping-schedule-skipped-manual-fallback-active',c,validHoleNumber(opts.hole)||activePlayingHole()||holeNumber()||1,{source:opts.source||'scheduled-automap',reason:'manual-fallback-terminal'});
	        return false;
	      }
	      if(typeof fetch!=='function')return false;
	      const key=`${mappedModeCourseIdentity(c)}:${opts.hole||'course'}`;
	      if(mapperOsmAutoMapRunKey===key)return true;
	      mapperOsmAutoMapRunKey=key;
	      const playResolutionRequested=opts.resolvePlay===true||opts.promptStart||opts.showLoading||validHoleNumber(opts.hole);
	      if(opts.resolvePlay!==false&&playResolutionRequested&&typeof window.gdResolveCoursePlayHole==='function'){
	        setTimeout(()=>{
	          try{
	            const active=sessionCourse(courseObj());
	            if(mappedModeCourseIdentity(active)!==mappedModeCourseIdentity(c))return;
	            window.gdResolveCoursePlayHole(c,{
	              hole:validHoleNumber(opts.hole)||activePlayingHole()||holeNumber()||1,
	              wholeCourse:!opts.hole,
	              showLoading:!!opts.showLoading,
	              fresh:!!opts.fresh,
	              reason:opts.source||'scheduled-automap'
	            });
	          }catch(e){}
	        },opts.delayMs||900);
	        return true;
	      }
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
    if(!btn){console.warn('[Clarity Caddy] final rail button missing: gdMapperToolsBtn');return;}
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
  function focusScorecardHoleOnGps(){
    return false;
  }
  function ensureCourseLoadingOverlay(){
    let el=document.getElementById('gdCourseLoadingOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdCourseLoadingOverlay';
    el.className='gdCourseLoadingOverlay hidden';
    el.innerHTML=`<div class="gdCourseLoadingSheet"><div class="gdCourseLoadingEyebrow">Clarity Caddy</div><strong id="gdCourseLoadingTitle">Loading course</strong><span id="gdCourseLoadingSub">Preparing Hole 1</span><div class="gdCourseLoadingTrack"><i id="gdCourseLoadingBar"></i></div></div>`;
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
      return false;
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
      const hasTrustedPlayData=requestedHolePlayable(course,expected);
      if(!hasTrustedPlayData)return false;
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
  const coursePlayResolverInFlight={};
  let interactiveGreenFallbackState=null;
  function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
  function coursePlayResolverKey(course,hole){
    const c=sessionCourse(course||courseObj());
    const h=validHoleNumber(hole)||1;
    const revision=coursePlayMapRevisionHash(c||course);
    return `${courseId(c||course)||'course'}:h${h}:${revision}:resolver`;
  }
  function coursePlayMapRevisionHash(course){
    try{
      const c=sessionCourse(course||courseObj());
      const point=guideCoursePoint(c);
      if(point&&Number.isFinite(Number(point.lat))&&Number.isFinite(Number(point.lng))){
        return `center:${Number(point.lat).toFixed(4)},${Number(point.lng).toFixed(4)}`;
      }
      return `identity:${mappedModeCourseIdentity(c||course)}`;
    }catch(e){
      return `identity:${mappedModeCourseIdentity(course||courseObj())}`;
    }
  }
  function newCoursePlayAttemptToken(key){
    return `${key}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`;
  }
  function resolverAttemptCurrent(token,attempt){
    try{
      if(attempt&&!isCurrentMappingAttempt(attempt))return false;
      const active=window.__gdCoursePlayResolverActive;
      return !!(active&&active.attemptToken===token);
    }catch(e){return false;}
  }
  function rememberRequestedPlayHole(hole){
    const h=validHoleNumber(hole)||1;
    try{rememberPlayingHole(h);}catch(e){}
    try{selectedHole=h;currentPlayingHole=h;}catch(e){}
    try{sessionStorage.setItem('gd_active_playing_hole',String(h));sessionStorage.setItem('gd_mapper_active_hole',String(h));}catch(e){}
    try{window.gdMapperActiveHole=h;}catch(e){}
    try{
      const par=knownParForHole(h);
      if(typeof setHole==='function')setHole(par!==null?{hole:h,par}:{hole:h});
    }catch(e){}
    return h;
  }
  function requestedMappedPlayData(course,hole){
    const h=validHoleNumber(hole)||1;
    const c=loadUserCourseData(userId(),courseId(course))||course;
    const data=mappedHolePlayData(c,h);
    if(data&&data.complete&&data.green&&Array.isArray(data.route)&&data.route.length>=2)return {course:c,data};
    return null;
  }
  function requestedHolePlayable(course,hole){
    return !!requestedMappedPlayData(course,hole);
  }
  function mappedPlayableHoleCoverage(course){
    let c=course;
    try{c=loadUserCourseData(userId(),courseId(course))||course;}catch(e){}
    const expected=Math.max(1,Math.min(18,Number(automapperExpectedHoleCount())||18));
    const holes=[];
    for(let hole=1;hole<=expected;hole++){
      const data=mappedHolePlayData(c,hole);
      if(data&&data.complete&&data.green&&Array.isArray(data.route)&&data.route.length>=2)holes.push(hole);
    }
    const missing=[];
    for(let hole=1;hole<=expected;hole++)if(!holes.includes(hole))missing.push(hole);
    return {expected,holes,count:holes.length,missing,complete:holes.length>=expected&&missing.length===0};
  }
  function savedMapCanSatisfyRequest(course,hole,wholeCourse){
    const requestedPlayable=requestedHolePlayable(course,hole);
    const coverage=mappedPlayableHoleCoverage(course);
    return {
      requestedPlayable,
      coverage,
      ready: wholeCourse?coverage.complete:requestedPlayable
    };
  }
  function courseDataMapReadiness(course,hole,wholeCourse){
    const h=validHoleNumber(hole)||1;
    const expected=Math.max(1,Math.min(18,Number(automapperExpectedHoleCount())||18));
    const holes=[];
    for(let n=1;n<=expected;n++){
      const data=mappedHolePlayData(course,n);
      if(data&&data.complete&&data.green&&Array.isArray(data.route)&&data.route.length>=2)holes.push(n);
    }
    const missing=[];
    for(let n=1;n<=expected;n++)if(!holes.includes(n))missing.push(n);
    const requestedPlayable=holes.includes(h);
    const coverage={expected,holes,count:holes.length,missing,complete:holes.length>=expected&&missing.length===0};
    return {requestedPlayable,coverage,ready:wholeCourse?coverage.complete:requestedPlayable};
  }
  function coursePlayDebugDetail(course,hole,detail={}){
    const h=validHoleNumber(hole)||1;
    return Object.assign({
      courseId:courseId(course),
      courseName:courseName(course),
      holeNumber:h
    },detail||{});
  }
  function recordCoursePlayDebug(type,course,hole,detail={}){
    try{
      const pipeline=window.GDCoursePlayPipeline;
      if(pipeline&&typeof pipeline.recordDebugEvent==='function'){
        pipeline.recordDebugEvent(type,coursePlayDebugDetail(course,hole,detail));
      }
    }catch(e){}
  }
  function mappedCoursePlayRows(course){
    let c=course;
    try{c=loadUserCourseData(userId(),courseId(course))||course;}catch(e){}
    const expected=Math.max(1,Math.min(18,Number(automapperExpectedHoleCount())||18));
    const rows=[];
    for(let hole=1;hole<=expected;hole++){
      const data=mappedHolePlayData(c,hole);
      if(data&&data.complete&&data.green&&Array.isArray(data.route)&&data.route.length>=2)rows.push({hole,holeNumber:hole,data});
    }
    return {course:c,expected,rows};
  }
  function warmCoursePlayFrames(course,rows,source){
    let warmed=0;
    try{
      if(!rows||!rows.length||typeof window.gdRenderCoursePlayHoleFrame!=='function')return 0;
      rows.forEach(row=>{
        const ok=window.gdRenderCoursePlayHoleFrame(course,row.hole,row.data,{reason:source||'course-first-load-frame-warmup',cacheOnly:true});
        if(ok)warmed++;
      });
    }catch(e){}
    return warmed;
  }
	  function collectCoursePlayFrames(course,source,opts={}){
	    const collection=mappedCoursePlayRows(course);
    const rows=collection.rows;
    const c=collection.course||course;
    let ingested=0;
    try{
      const pipeline=window.GDCoursePlayPipeline;
      if(rows.length&&pipeline&&typeof pipeline.ingestMappedCourse==='function'){
        pipeline.ingestMappedCourse(c,rows.map(row=>Object.assign({holeNumber:row.hole},row.data)),source||'course-play-resolver');
        ingested=rows.length;
      }else if(rows.length&&pipeline&&typeof pipeline.ingestMappedHole==='function'){
        rows.forEach(row=>{pipeline.ingestMappedHole(c,row.hole,row.data,source||'course-play-resolver');ingested++;});
      }
    }catch(e){}
    const warmed=opts.warmFrames===false?0:warmCoursePlayFrames(c,rows,source||'course-first-load-frame-warmup');
	    recordCoursePlayDebug('course-play-frames-collected',c,opts.activeHole||1,{source:source||'course-play-resolver',holes:rows.length,expectedHoleCount:collection.expected,ingested,warmed});
	    return {course:c,rows,expected:collection.expected,ingested,warmed};
	  }
	  function cloudCourseMapSyncApi(){
	    try{
	      const api=window.GolfDaddyCapturedSurfaceSync;
	      return api&&typeof api.pullCourse==='function'?api:null;
	    }catch(e){return null;}
	  }
	  function resumeRoundAvailableForCloudMap(){
	    try{
	      if(typeof window.gdReadResumeRound==='function'&&window.gdReadResumeRound())return true;
	    }catch(e){}
	    try{
	      const panel=document.getElementById('gdCourseResumeRound');
	      if(panel&&!panel.hidden&&!(panel.classList&&panel.classList.contains('hidden')))return true;
	    }catch(e){}
	    return false;
	  }
	  function shouldLookupCloudCourseMap(request,opts={}){
	    if(opts.cloudCourseMapLookup===false)return false;
	    if(opts.fromResume||opts.preserveState||opts.keepGps)return false;
	    if(opts.__resumeRoundAvailableBeforeOpen)return false;
	    if(resumeRoundAvailableForCloudMap())return false;
	    return typeof fetch==='function';
	  }
	  function cloudCourseMapKeys(course){
	    const keys=[];
	    const add=value=>{
	      const key=slug(value||'');
	      if(key&&!keys.includes(key))keys.push(key);
	    };
	    add(courseId(course));
	    add(course?.courseId||course?.id);
	    add(courseName(course));
	    add(course?.name||course?.courseName);
	    return keys;
	  }
	  function cloudPoint(value){
	    const lat=Number(value?.lat);
	    const lng=Number(value?.lng);
	    return Number.isFinite(lat)&&Number.isFinite(lng)?{lat,lng}:null;
	  }
	  function cloudPoints(values){
	    return (Array.isArray(values)?values:[]).map(cloudPoint).filter(Boolean);
	  }
	  function cloudPins(scan){
	    const manifest=scan?.manifest||{};
	    const pins=scan?.pins||manifest.anchorPins||{};
	    return {
	      tee:cloudPoint(pins.tee),
	      green:cloudPoint(pins.green),
	      route:cloudPoints(pins.route),
	      greenShape:cloudPoints(pins.greenShape)
	    };
	  }
	  function pointAlongRoute(points,fraction=.5){
	    const pts=cloudPoints(points);
	    if(!pts.length)return null;
	    if(pts.length===1)return pts[0];
	    const total=routeLengthM(pts);
	    if(!Number.isFinite(total)||total<=0)return pts[Math.floor(pts.length/2)];
	    const target=total*Math.max(0,Math.min(1,fraction));
	    let travelled=0;
	    for(let i=1;i<pts.length;i++){
	      const a=pts[i-1],b=pts[i];
	      const segment=distance(a,b);
	      if(travelled+segment>=target){
	        const t=segment?((target-travelled)/segment):0;
	        return {lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
	      }
	      travelled+=segment;
	    }
	    return pts[pts.length-1];
	  }
	  function persistCloudCourseMapScans(course,scans,opts={}){
	    const rows=Array.isArray(scans)?scans:[];
	    const uid=userId();
	    const cid=courseId(course);
	    const name=courseName(course);
	    let saved=0;
	    const holes={};
	    rows.forEach(scan=>{
	      const h=validHoleNumber(scan?.hole_number||scan?.holeNumber);
	      if(!h)return;
	      const pins=cloudPins(scan);
	      const route=pins.route.length>=2?pins.route:[pins.tee,pins.green].filter(Boolean);
	      const greenShape=pins.greenShape.length>=3?simplifyShape(pins.greenShape,64):null;
	      const green=pins.green||shapeCentroid(greenShape)||route[route.length-1]||null;
	      const tee=pins.tee||route[0]||null;
	      const fairwayPoints=route.length>=3?route.slice(1,-1):route.length>=2?[pointAlongRoute(route,.5)].filter(Boolean):[];
	      const resolvedAt=scan.updated_at||scan.updatedAt||nowIso();
	      const base={userId:uid,courseId:cid,courseName:name,course,holeNumber:h,confirmed:true,resolverVersion:'captured-surface-sync-v1',resolvedAt,resolverSource:'supabase-captured-surface',resolverConfidence:.72,resolverMatchScore:.72,resolverEvidence:['supabase-captured-surface']};
	      let holeSaved=0;
	      if(green&&greenShape){
	        if(saveCourseObject({...base,type:'green',position:green,shape:greenShape,greenShape,source:'supabase_captured_surface_green',maxDedupeDistanceM:8}))holeSaved++;
	      }
	      if(tee){
	        if(saveCourseObject({...base,type:'tee',position:tee,source:'supabase_captured_surface_tee',maxDedupeDistanceM:8}))holeSaved++;
	      }
	      fairwayPoints.slice(0,3).forEach((point,index)=>{
	        if(saveCourseObject({...base,type:'fairway',position:point,source:index?'supabase_captured_surface_fairway_bend':'supabase_captured_surface_fairway',maxDedupeDistanceM:10}))holeSaved++;
	      });
	      if(holeSaved){
	        holes[h]=true;
	        saved+=holeSaved;
	      }
	    });
	    try{updateMapperToolCompletion();renderCourseLibraryPanel();gdCLRefreshProfileCard();}catch(e){}
	    return {saved,holes:Object.keys(holes).map(Number).sort((a,b)=>a-b),scans:rows.length};
	  }
	  async function tryHydrateCourseMapFromCloud(request,attempt,opts={}){
	    if(!shouldLookupCloudCourseMap(request,opts))return {attempted:false,reason:resumeRoundAvailableForCloudMap()?'resume-round-available':'cloud-pull-unavailable'};
	    const keys=cloudCourseMapKeys(request.course);
	    if(!keys.length)return {attempted:false,reason:'cloud-pull-unavailable'};
	    recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'started',event:'course-map-cloud-lookup-started',summary:'Course map loading',details:{courseId:request.courseId,courseName:request.courseName,hole:request.hole,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken,keys,lookup:'published-course-maps'}});
	    recordCoursePlayDebug('course-map-cloud-lookup-started',request.course,request.hole,{resolutionKey:request.resolutionKey,attemptToken:request.attemptToken,keys});
	    updateCourseLoading('Course map loading',32);
	    try{
	      const maps=await syncPublishedCourseMaps({quiet:true,throwOnError:true});
	      const published=publishedCourses().find(course=>keys.some(key=>courseMatchesIdentity(course,key,request.courseName,request.course)))||null;
	      const readiness=published?courseDataMapReadiness(published,request.hole,request.wholeCourse):null;
	      if(published){
	        recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:readiness&&readiness.ready?'completed':'partial',event:readiness&&readiness.ready?'course-map-cloud-loaded':'course-map-cloud-incomplete',summary:readiness&&readiness.ready?'Course map loaded from cloud':'Course map cloud data incomplete',details:{courseKey:published.courseId,lookup:'published-course-maps',publishedCourseId:published.id,pulled:Object.keys(maps&&maps.courses||{}).length,persistedObjects:Object.keys(published.objects||{}).length,holes:readiness&&readiness.coverage&&readiness.coverage.holes||[],playableHoleCount:readiness&&readiness.coverage&&readiness.coverage.count||0,expectedHoleCount:readiness&&readiness.coverage&&readiness.coverage.expected||0,missingHoles:readiness&&readiness.coverage&&readiness.coverage.missing||[],resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	        recordCoursePlayDebug(readiness&&readiness.ready?'course-map-cloud-loaded':'course-map-cloud-incomplete',request.course,request.hole,{courseKey:published.courseId,lookup:'published-course-maps',publishedCourseId:published.id,pulled:Object.keys(maps&&maps.courses||{}).length,persistedObjects:Object.keys(published.objects||{}).length,holes:readiness&&readiness.coverage&&readiness.coverage.holes||[],playable:!!(readiness&&readiness.ready),resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	        return {attempted:true,found:true,key:published.courseId,result:maps,persisted:{saved:0,holes:readiness&&readiness.coverage&&readiness.coverage.holes||[]},readiness,published};
	      }
	    }catch(error){
	      recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'failed',event:'course-map-cloud-lookup-failed',summary:'Course map cloud lookup failed',details:{keys,lookup:'published-course-maps',resolutionKey:request.resolutionKey,attemptToken:request.attemptToken},error:{message:error&&error.message||String(error),status:error&&error.status||null}});
	      recordCoursePlayDebug('course-map-cloud-lookup-failed',request.course,request.hole,{keys,lookup:'published-course-maps',reason:error&&error.message||String(error),resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	      return {attempted:true,failed:true,keys,error};
	    }
	    recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'skipped',event:'course-map-cloud-not-found',summary:'Course map not found in cloud',details:{keys,lookup:'published-course-maps',resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	    recordCoursePlayDebug('course-map-cloud-not-found',request.course,request.hole,{keys,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	    return {attempted:true,found:false,missing:true,keys};
	  }
	  async function publishedCourseMapAvailability(course,opts={}){
	    const selectedAt=opts.selectedAt||nowIso();
	    const c=mappingCourseSnapshot(course||courseObj(),Object.assign({},opts,{selectedAt,source:opts.source||'course-picker-db-map-check'}));
	    if(!c||isManualGpsCourse(c))return {attempted:false,available:false,reason:'manual-course'};
	    if(typeof fetch!=='function')return {attempted:false,available:false,reason:'fetch-unavailable'};
	    const h=validHoleNumber(opts.hole)||1;
	    const wholeCourse=opts.wholeCourse!==false;
	    const keys=cloudCourseMapKeys(c);
	    if(!keys.length)return {attempted:false,available:false,reason:'no-course-keys',course:c,keys};
	    try{
	      const maps=await syncPublishedCourseMaps({quiet:true,throwOnError:true});
	      const published=publishedCourses().find(row=>keys.some(key=>courseMatchesIdentity(row,key,courseName(c),c)))||null;
	      const readiness=published?courseDataMapReadiness(published,h,wholeCourse):null;
	      return {
	        attempted:true,
	        available:!!(published&&readiness&&readiness.ready),
	        found:!!published,
	        course:c,
	        published,
	        keys,
	        readiness,
	        pulled:Object.keys(maps&&maps.courses||{}).length
	      };
	    }catch(error){
	      return {attempted:true,available:false,failed:true,error,course:c,keys,reason:error&&error.message||String(error)};
	    }
	  }
	  function shouldSyncGeneratedCourseMapToCloud(request,opts={}){
	    if(opts.generatedCourseMapSync===false||opts.cloudCourseMapSync===false)return false;
	    if(opts.fromResume||opts.preserveState||opts.keepGps)return false;
	    if(opts.__resumeRoundAvailableBeforeOpen||resumeRoundAvailableForCloudMap())return false;
	    return typeof fetch==='function';
	  }
	  async function syncGeneratedCourseMapToCloud(request,source,opts={}){
	    if(!shouldSyncGeneratedCourseMapToCloud(request,opts))return {attempted:false,reason:'cloud-sync-disabled'};
	    const actor=currentAdminActor();
	    const actorAllowed=String(actor.role||'').toLowerCase()==='admin'&&isPublishedAdminEmail(actor.email);
	    const course=loadUserCourseData(userId(),request.courseId)||request.course;
	    const readiness=savedMapCanSatisfyRequest(course,request.hole,true);
	    const hasGeneratedObjects=!!(readiness.coverage&&readiness.coverage.count>0);
	    if(!readiness.ready&&!hasGeneratedObjects){
	      recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'skipped',event:'course-map-cloud-sync-skipped',summary:'Course map cloud sync skipped',details:{reason:'incomplete-map',source:source||'generated-map',courseId:request.courseId,courseName:request.courseName,hole:request.hole,playableHoleCount:readiness.coverage.count,expectedHoleCount:readiness.coverage.expected,missingHoles:readiness.coverage.missing,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	      return {attempted:false,reason:'incomplete-map',readiness};
	    }
	    const syncMode=actorAllowed?'admin-publish':'generated-create-or-append';
	    const syncActor=actorAllowed?actor:{name:'Community scan',email:'',accountId:actor.accountId||'',role:'player'};
	    const clean=normalizePublishedCourse(course,syncActor);
	    if(!clean)return {attempted:false,reason:'empty-map',readiness};
	    recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'started',event:'course-map-cloud-sync-started',summary:'Course map cloud sync started',details:{source:source||'generated-map',mode:syncMode,courseId:clean.courseId,courseName:clean.courseName,publishedCourseId:clean.id,playableHoleCount:readiness.coverage.count,expectedHoleCount:readiness.coverage.expected,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	    recordCoursePlayDebug('course-map-cloud-sync-started',request.course,request.hole,{source:source||'generated-map',mode:syncMode,courseId:clean.courseId,publishedCourseId:clean.id,holes:readiness.coverage.count,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	    try{
	      const res=await fetch(PUBLISHED_COURSE_API,{
	        method:'POST',
	        headers:{'Content-Type':'application/json','Accept':'application/json'},
	        body:JSON.stringify({course:clean,actor:syncActor,source:source||'generated-map',mode:syncMode,generated:true})
	      });
	      const data=await res.json().catch(()=>null);
	      if(!res.ok){
	        const error=new Error(data&&data.error||`Course map sync failed (${res.status})`);
	        error.status=res.status;
	        error.body=data;
	        throw error;
	      }
	      if(data)mergePublishedStore(data);
	      recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'completed',event:'course-map-cloud-synced',summary:'Course map synced to cloud',details:{source:source||'generated-map',mode:data&&data.mode||syncMode,courseId:clean.courseId,courseName:clean.courseName,publishedCourseId:clean.id,playableHoleCount:readiness.coverage.count,expectedHoleCount:readiness.coverage.expected,newObjects:data&&data.accepted&&data.accepted.objects||0,newHoles:data&&data.accepted&&data.accepted.holes||0,storage:data&&data.storage||'course-maps',resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	      recordCoursePlayDebug('course-map-cloud-synced',request.course,request.hole,{source:source||'generated-map',mode:data&&data.mode||syncMode,courseId:clean.courseId,publishedCourseId:clean.id,holes:readiness.coverage.count,newObjects:data&&data.accepted&&data.accepted.objects||0,newHoles:data&&data.accepted&&data.accepted.holes||0,storage:data&&data.storage||'course-maps',resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	      return {attempted:true,synced:true,course:clean,result:data,readiness};
	    }catch(error){
	      recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'failed',event:'course-map-cloud-sync-failed',summary:'Course map cloud sync failed',details:{source:source||'generated-map',courseId:clean.courseId,courseName:clean.courseName,publishedCourseId:clean.id,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken},error:{message:error&&error.message||String(error),status:error&&error.status||null}});
	      recordCoursePlayDebug('course-map-cloud-sync-failed',request.course,request.hole,{source:source||'generated-map',courseId:clean.courseId,publishedCourseId:clean.id,reason:error&&error.message||String(error),status:error&&error.status||null,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	      return {attempted:true,synced:false,failed:true,error,course:clean,readiness};
	    }
	  }
	  function ingestRequestedHoleToPipeline(course,hole,source){
    try{
      const resolved=requestedMappedPlayData(course,hole);
      const pipeline=window.GDCoursePlayPipeline;
      if(resolved&&pipeline&&typeof pipeline.ingestMappedHole==='function'){
        pipeline.ingestMappedHole(resolved.course,hole,resolved.data,source||'course-play-resolver');
      }
    }catch(e){}
  }
  function recentGpsFallbackPoint(){
    try{
      const point=recentGpsPoint();
      return point&&typeof L!=='undefined'&&L.latLng?L.latLng(point.lat,point.lng):point;
    }catch(e){return null;}
  }
  function pointDistance(a,b){
    try{return a&&b&&map&&map.distance?map.distance(a,b):distance(a,b);}catch(e){return Infinity;}
  }
  function fallbackReferencePoint(course,green){
    const candidates=[];
    try{if(start)candidates.push(toLatLng(start));}catch(e){}
    const gps=recentGpsFallbackPoint();
    if(gps)candidates.push(gps);
    try{candidates.push(toLatLng(guideCoursePoint(course)));}catch(e){}
    const found=candidates.filter(Boolean).find(point=>{
      const d=pointDistance(point,green);
      return Number.isFinite(d)&&d>35&&d<2200;
    });
    if(found)return found;
    try{return projectFramePoint(green,Math.PI,120);}catch(e){}
    return null;
  }
  function midpointPoint(a,b){
    const p=toLatLng(a),q=toLatLng(b);
    if(!p||!q)return null;
    try{return L.latLng((Number(p.lat)+Number(q.lat))/2,(Number(p.lng)+Number(q.lng))/2);}catch(e){return null;}
  }
  function eventLatLng(event){
    try{
      if(event&&Number.isFinite(Number(event.clientX))&&Number.isFinite(Number(event.clientY))){
        if(typeof window.gdLiveLatLngFromClient==='function'){
          const live=window.gdLiveLatLngFromClient(event.clientX,event.clientY);
          if(live)return live;
        }
        const el=map&&map.getContainer?map.getContainer():document.getElementById('map');
        const rect=el&&el.getBoundingClientRect?el.getBoundingClientRect():null;
        if(rect&&map&&map.containerPointToLatLng)return map.containerPointToLatLng(L.point(event.clientX-rect.left,event.clientY-rect.top));
      }
    }catch(e){}
    return null;
  }
  function interactiveGreenBlockedTarget(event){
    const target=event&&event.target;
    return !!(target&&target.closest&&target.closest('button,a,input,select,textarea,.leaflet-control,.rightRail,.shellBar,.dock,#gdV62UndoDock,#gdV62ModeSwitch,#shotTile,#gdV62GpsBadge,#hint,#toast,#gdWandPanel,#gdMapperToolFlyout,#gdMapperToolsDrawer,#gdMapperHoleStrip,.panel,.modulePanel,#courseScreen:not(.hidden)'));
  }
  function saveInteractiveFallbackGreen(course,hole,greenPoint,reason){
    const h=validHoleNumber(hole)||1;
    const c=sessionCourse(course||courseObj());
    const uid=userId();
    const cid=courseId(c);
    const name=courseName(c);
    const green=toLatLng(greenPoint);
    if(!green)return null;
    const reference=fallbackReferencePoint(c,green);
    const fairway=midpointPoint(reference,green)||reference;
    let saved=0;
    if(saveCourseObject({userId:uid,courseId:cid,courseName:name,course:c,type:'green',position:green,source:'interactive_green_fallback',holeNumber:h,confirmed:true,maxDedupeDistanceM:8}))saved++;
    if(reference&&pointDistance(reference,green)>45){
      if(saveCourseObject({userId:uid,courseId:cid,courseName:name,course:c,type:'tee',position:reference,source:'interactive_green_fallback_reference',holeNumber:h,confirmed:true,maxDedupeDistanceM:12}))saved++;
    }
    if(fairway){
      if(saveCourseObject({userId:uid,courseId:cid,courseName:name,course:c,type:'fairway',position:fairway,source:'interactive_green_fallback_fairway',holeNumber:h,confirmed:true,maxDedupeDistanceM:12}))saved++;
    }
    const nextCourse=loadUserCourseData(uid,cid)||c;
    try{drawHoleObjects(nextCourse,h);}catch(e){}
    try{updateMapperHoleUi();updateMapperToolCompletion();renderCourseLibraryPanel();gdCLRefreshProfileCard();}catch(e){}
    ingestRequestedHoleToPipeline(nextCourse,h,reason||'interactive-green-fallback');
    return {course:nextCourse,saved,reference,fairway,green};
  }
  function clearInteractiveGreenFallback(reason,details={}){
    const state=interactiveGreenFallbackState;
    interactiveGreenFallbackState=null;
    try{
      const el=state&&state.mapEl;
      const handler=state&&state.handler;
      if(el&&handler){
        el.removeEventListener('click',handler,true);
      }
    }catch(e){}
    try{
      document.body.classList.remove('gdGpsInteractiveGreenFallbackActive');
      document.body.dataset.gdInteractiveGreenFallbackClearedBy=String(reason||'clear');
      if(typeof window.gdApplyGpsMapVisibilityOwner==='function')window.gdApplyGpsMapVisibilityOwner(reason||'interactive-green-fallback-clear');
    }catch(e){}
    if(state&&state.debugRunId&&reason!=='green-selected'){
      const superseded=reason==='superseded';
      recordMappingDebug(state.debugRunId,{source:'manual-fallback',phase:superseded?'superseded':'cancelled',event:superseded?'manual-fallback-superseded':'manual-fallback-cancelled',summary:superseded?'Manual fallback superseded by new active mapping attempt':'Manual fallback cancelled',details:Object.assign({hole:state.hole,reason:reason||'clear',resolutionKey:state.resolutionKey,attemptToken:state.attemptToken},details||{})});
	    }
	    try{delete window.__gdCoursePlayInteractiveFallbackActive;}catch(e){}
	  }
	  window.gdClearInteractiveGreenFallback=clearInteractiveGreenFallback;
	  function finishInteractiveGreenFallback(point){
    const state=interactiveGreenFallbackState;
    if(!state||!point)return false;
    const h=validHoleNumber(state.hole)||1;
    if(!isCurrentMappingAttempt(state)){
      recordStaleMappingActivity(state,{eventSource:'manual-fallback',event:'manual-fallback-stale-result-rejected',summary:'Manual fallback stale result rejected',attemptedAction:'persist-manual-fallback-green',callerFunction:'finishInteractiveGreenFallback'});
      return false;
    }
    const saved=saveInteractiveFallbackGreen(state.course,h,point,'interactive-green-fallback');
    if(!saved)return false;
    recordMappingDebug(state.debugRunId,{source:'manual-fallback',phase:'completed',event:'manual-fallback-green-selected',summary:'Manual green fallback completed',details:{
      hole:h,
      savedObjects:saved.saved||0,
      resolutionKey:state.resolutionKey,
      attemptToken:state.attemptToken,
      persistence:'local course map objects'
    }});
    finishMappingDebug(state.debugRunId,{status:'fallback',outcome:'manual fallback completed'});
    try{if(typeof gdSuppressMapPlacementClick==='function')gdSuppressMapPlacementClick(900);}catch(e){}
    try{window.__gdManualStandingPlacementActiveUntil=0;}catch(e){}
    clearInteractiveGreenFallback('green-selected');
    try{toastSafe('Green selected');}catch(e){}
    try{setMappedPlayMode('mapped',{skipFrame:true,silent:true,preserveAssist:true});}catch(e){}
    try{mode='start';}catch(e){}
    const playable=requestedHolePlayable(saved.course,h);
    if(playable){
      try{focusMappedHoleOrSavedGreen(h,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,stablePreLock:true,course:saved.course});}catch(e){}
      setTimeout(()=>{try{if(typeof window.gdFocusMappedPreLockHole==='function')window.gdFocusMappedPreLockHole(h,{source:'interactive-green-fallback',preserveGpsSession:true,reenterGps:false,refreshGps:false});}catch(e){}},80);
      markCourseOpenReady(saved.course,h);
    }else{
      try{setState('Green selected');}catch(e){}
      try{showHint('Tap where you are standing');}catch(e){}
    }
    return true;
  }
  function beginInteractiveGreenFallback(course,hole,reason,opts={}){
    const h=validHoleNumber(hole||opts.hole)||1;
    const selectedAt=opts.selectedAt||nowIso();
    const c=mappingCourseSnapshot(sessionCourse(course||courseObj()),Object.assign({},opts,{selectedAt}));
    const key=opts.resolutionKey||coursePlayResolverKey(c,h);
    const attemptToken=opts.attemptToken||newCoursePlayAttemptToken(key);
    const debugRunId=mappingDebugRun(c,Object.assign({},opts,{reason:reason||'interactive-green-fallback',selectedAt,attemptToken}));
    const incomingAttempt=opts.debugAttemptContext||mappingAttemptContext(c,h,Object.assign({},opts,{debugRunId,attemptToken,resolutionKey:key,activeResolutionKey:opts.activeResolutionKey||key,selectedAt,source:opts.source||reason||'manual-fallback',callerFunction:opts.callerFunction||'beginInteractiveGreenFallback'}));
    if(!isCurrentMappingAttempt(incomingAttempt)){
      recordStaleMappingActivity(incomingAttempt,{eventSource:'manual-fallback',event:'manual-fallback-replacement-rejected',summary:'Manual fallback replacement rejected',attemptedAction:'open-manual-fallback',rejectionReason:'incoming request belongs to stale course attempt',callerFunction:incomingAttempt.callerFunction||'beginInteractiveGreenFallback'});
      return {playable:false,fallback:'interactive-green',armed:false,stale:true,rejected:true,debugRunId};
    }
    if(interactiveGreenFallbackState){
      const existing=interactiveGreenFallbackState;
      const sameFallback=sameMappingAttempt(existing,incomingAttempt)||existing.resolutionKey===key&&(!attemptToken||!existing.attemptToken||existing.attemptToken===attemptToken);
      if(sameFallback){
        recordMappingDebug(debugRunId,{source:'manual-fallback',phase:'skipped',event:'manual-fallback-duplicate-ignored',summary:'Manual fallback duplicate request ignored',details:{hole:h,resolutionKey:key,attemptToken,callerFunction:incomingAttempt.callerFunction||'beginInteractiveGreenFallback'}});
        return {playable:false,fallback:'interactive-green',armed:true,debugRunId:existing.debugRunId,reused:true};
      }
      clearInteractiveGreenFallback('superseded',{replacementRunId:debugRunId,replacementResolutionKey:key,replacementAttemptToken:attemptToken,replacementHole:h,replacementCourseId:courseId(c),replacementCourseName:courseName(c),replacementReason:reason||'automatic-resolution-failed'});
    }
    rememberRequestedPlayHole(h);
    recordCoursePlayDebug('gps-play-interactive-green-fallback',c,h,{reason:reason||'automatic-resolution-failed',resolutionKey:key,attemptToken});
    recordMappingDebug(debugRunId,{source:'manual-fallback',phase:'fallback',event:'manual-fallback-opened',summary:'Manual green fallback opened',details:{
      invokedBy:opts.reason||reason||'automatic-resolution-failed',
      source:opts.source||'unknown',
      callerFunction:incomingAttempt.callerFunction||'beginInteractiveGreenFallback',
      hole:h,
      reason:reason||'automatic-resolution-failed',
      resolutionKey:key,
      attemptToken,
      eligibilityReason:'Automatic mapping did not produce trusted playable geometry'
    }});
    hideCourseLoading(0);
    try{if(typeof window.gdClearHoleImageRuntime==='function')window.gdClearHoleImageRuntime('interactive-green-fallback');}catch(e){}
    try{
      document.body.classList.add('shell-gps','gdGpsActive','gps-active','gdMappedCourseMode','gdGpsInteractiveGreenFallbackActive','gdGpsLiveMapAllowed','gdGpsExplicitMapMode');
      document.body.classList.remove('gdCourseOpening','gdGpsFramePreparing','gdCoursePlayPipelinePreparing','gdHoleFrameLoading','gdCapturedFrameUnavailable','gdGpsLiveMapSuppressed','gdGpsHoleTransitioning','gdCapturedHoleFrameCameraOn','gdHoleImageCameraOn','gdMappedStartPromptActive','gdManualStartPlacementActive','gdHeadToTeeFrameActive','gdLockStateFrameActive','gd-frame-hard-locked');
      document.body.dataset.gdInteractiveGreenFallbackReason=String(reason||'automatic-resolution-failed');
      document.body.dataset.gdInteractiveGreenFallbackHole=String(h);
      document.body.dataset.gdInteractiveGreenFallbackKey=String(key);
    }catch(e){}
    try{setMappedPlayMode('mapped',{skipFrame:true,silent:true,preserveAssist:true});}catch(e){}
    try{mode='green';}catch(e){}
    try{setState('Select green');}catch(e){}
    try{showHint('Tap the green');}catch(e){}
    try{
      if(map&&map.invalidateSize)setTimeout(()=>{
        try{map.invalidateSize(false);}catch(e){}
        const focus=toLatLng(guideCoursePoint(c))||recentGpsFallbackPoint();
        if(focus&&map&&map.setView)try{map.setView(focus,Math.max(map.getZoom?map.getZoom():17,17),{animate:true});}catch(e){}
        else if(focus&&map&&map.panTo)try{map.panTo(focus,{animate:true});}catch(e){}
      },40);
    }catch(e){}
    try{if(typeof window.gdApplyGpsMapVisibilityOwner==='function')window.gdApplyGpsMapVisibilityOwner('interactive-green-fallback');}catch(e){}
    const mapEl=(map&&map.getContainer&&map.getContainer())||document.getElementById('map');
    if(!mapEl)return {playable:false,fallback:'interactive-green',armed:false};
    const handler=event=>{
      if(!interactiveGreenFallbackState||interactiveGreenFallbackState.mapEl!==mapEl)return;
      if(interactiveGreenBlockedTarget(event))return;
      const ll=eventLatLng(event);
      if(!ll)return;
      event.preventDefault&&event.preventDefault();
      event.stopPropagation&&event.stopPropagation();
      if(event.stopImmediatePropagation)event.stopImmediatePropagation();
      finishInteractiveGreenFallback(ll);
    };
    interactiveGreenFallbackState={course:c,hole:h,reason:reason||'automatic-resolution-failed',mapEl,handler,at:Date.now(),resolutionKey:key,attemptToken,debugRunId,runId:debugRunId,courseId:courseId(c),courseName:courseName(c),source:opts.source||'unknown',callerFunction:incomingAttempt.callerFunction||'beginInteractiveGreenFallback'};
    mapEl.addEventListener('click',handler,true);
    try{window.__gdInteractiveGreenFallback=interactiveGreenFallbackState;}catch(e){}
    try{window.__gdCoursePlayInteractiveFallbackActive={course:c,courseId:courseId(c),courseName:courseName(c),hole:h,reason:reason||'automatic-resolution-failed',key,resolutionKey:key,attemptToken,debugRunId,runId:debugRunId,source:opts.source||'unknown',callerFunction:incomingAttempt.callerFunction||'beginInteractiveGreenFallback',at:Date.now()};}catch(e){}
    return {playable:false,fallback:'interactive-green',armed:true};
  }
  async function showResolvedCoursePlayHole(course,hole,reason,opts={}){
    const h=rememberRequestedPlayHole(hole||1);
    const mappedCourse=loadUserCourseData(userId(),courseId(course))||course;
    ingestRequestedHoleToPipeline(mappedCourse,h,reason||'course-play-resolver');
    const frameCollection=collectCoursePlayFrames(mappedCourse,reason||'course-play-resolver',{activeHole:h,warmFrames:opts.collectCoursePlayFrames!==false});
    updateCourseLoading(`Framing Hole ${h}`,86);
    await sleep(80);
    let framed=false;
    try{framed=!!focusMappedHoleOrSavedGreen(h,{quiet:true,frame:true,promptStart:true,allowAnyStart:true,stablePreLock:true,course:mappedCourse});}catch(e){}
    if(!framed&&typeof window.gdFocusMappedPreLockHole==='function'){
      try{window.gdFocusMappedPreLockHole(h,{source:reason||'course-play-resolver',preserveGpsSession:true,reenterGps:false,refreshGps:false});framed=true;}catch(e){}
    }
    updateCourseLoading(`Hole ${h} ready`,100);
    markCourseOpenReady(mappedCourse,h);
    hideCourseLoading(220);
    setTimeout(()=>checkClosestMappedHolePrompt(loadUserCourseData()),900);
    return {playable:true,framed,course:mappedCourse,hole:h,framesCollected:frameCollection};
  }
  function mappingAttemptStillCurrent(request,attempt,stage){
    if(resolverAttemptCurrent(request.attemptToken,attempt))return true;
    recordStaleMappingActivity(attempt,{eventSource:stage||'course-loader',event:'mapping-run-superseded',summary:'Mapping run superseded',attemptedAction:`complete-${stage||'stage'}`,callerFunction:'runCourseMappingAttempt'});
    return false;
  }
  async function runNativeResolverStage(request,attempt,autoMapResult,opts){
    updateCourseLoading('Resolving native geometry',64);
    const scorecardPromise=nativeResolverFetchScorecardEvidence(request.course,attempt,opts);
    const acquisition=await acquireNativeResolverSourceBundle(request,attempt,autoMapResult&&autoMapResult.guideBundle||null,opts);
    if(acquisition&&acquisition.bundle&&acquisition.bundle.stale)return {ran:true,stale:true,bundle:acquisition.bundle};
    const baseBundle=acquisition.bundle||{guides:[],greens:[],osmPayload:{elements:[]}};
    const payload=acquisition.payload||baseBundle.osmPayload||{elements:[]};
    const resolvedBundle=await resolveCourseGeometryGuideBundle(request.course,payload,baseBundle,Object.assign({},opts,{debugRunId:request.debugRunId,skipGeometryResolver:false,forceNativeResolver:true,suppressSkipTelemetry:true,source:'native-resolver',reason:request.reason,debugAttemptContext:attempt,callerFunction:'runCourseMappingAttempt',nativeResolverSourceLoadError:acquisition.sourceLoadError||null,nativeResolverSourceLoadStatus:acquisition.source||'',nativeResolverScorecardPromise:scorecardPromise}));
    if(resolvedBundle&&resolvedBundle.stale)return {ran:true,stale:true,bundle:resolvedBundle};
	    const persisted=await persistOsmGuideBundle(request.course,resolvedBundle,Object.assign({},opts,{quiet:true,frame:false,promptStart:true,hole:opts.wholeCourse===false?request.hole:null}),request.debugRunId,attempt);
	    const frameCollection=collectCoursePlayFrames(loadUserCourseData(userId(),courseId(request.course))||request.course,'native-resolver',{activeHole:request.hole,warmFrames:request.wholeCourse});
	    const generatedState=savedMapCanSatisfyRequest(request.course,request.hole,request.wholeCourse);
	    const partialPlayable=!!(opts.acceptPartialGeneratedMap&&generatedState.requestedPlayable);
	    const playable=generatedState.ready||partialPlayable;
	    recordCoursePlayDebug('course-mapping-native-completed',request.course,request.hole,{playable,partial:playable&&!generatedState.ready,holes:persisted.holes||0,saved:persisted.saved||0,framesCollected:frameCollection.rows.length,framesWarmed:frameCollection.warmed,nativeStatus:resolvedBundle&&resolvedBundle.resolver&&resolvedBundle.resolver.status||'unknown',nativeConfidence:resolvedBundle&&resolvedBundle.resolver&&resolvedBundle.resolver.confidence||0,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	    return {ran:true,playable,partial:playable&&!generatedState.ready,readiness:generatedState,persisted,bundle:resolvedBundle,framesCollected:frameCollection};
	  }
	  async function runCourseMappingAttempt(input={}){
	    const opts=Object.assign({},input||{});
	    const selectedAt=opts.selectedAt||nowIso();
	    const c=mappingCourseSnapshot(sessionCourse(opts.course||courseObj()),Object.assign({},opts,{selectedAt}));
	    if(!c||isManualGpsCourse(c))return {playable:false,reason:'manual-course'};
	    if(opts.acceptPartialGeneratedMap)clearInteractiveGreenFallback('generated-scan-started',{courseId:courseId(c),courseName:courseName(c)});
    const h=validHoleNumber(opts.hole)||1;
    const key=opts.resolutionKey||coursePlayResolverKey(c,h);
    const activeFallback=window.__gdCoursePlayInteractiveFallbackActive||interactiveGreenFallbackState;
    if(activeFallback&&String(activeFallback.resolutionKey||activeFallback.key||'')===String(key)){
      recordMappingDebug(activeFallback.debugRunId||opts.debugRunId||'',{source:'manual-fallback',phase:'skipped',event:'manual-fallback-terminal-reentry-blocked',summary:'Manual fallback blocked automatic re-entry',details:{hole:h,resolutionKey:key,attemptToken:activeFallback.attemptToken||opts.attemptToken||'',requestedReason:opts.reason||'course-selected'}});
      return {playable:false,fallback:'interactive-green',armed:true,terminal:true,debugRunId:activeFallback.debugRunId||opts.debugRunId||'',reason:'manual-fallback-active'};
    }
    if(coursePlayResolverInFlight[key])return coursePlayResolverInFlight[key];
    const attemptToken=opts.attemptToken||newCoursePlayAttemptToken(key);
    const debugRunId=opts.debugRunId||mappingDebugRun(c,{newRun:true,reason:opts.reason||'course-selected',selectedAt,attemptToken,hole:h});
    const revision=coursePlayMapRevisionHash(c);
    const request=Object.freeze({
      course:c,
      courseId:courseId(c),
      courseName:courseName(c),
      courseCentre:c.courseCentre||null,
      hole:h,
      resolutionKey:key,
      attemptToken,
      debugRunId,
      selectedAt,
      revision,
      reason:opts.reason||'course-selected',
      showLoading:opts.showLoading!==false,
      wholeCourse:opts.wholeCourse!==false
    });
    const attempt=Object.freeze(mappingAttemptContext(c,h,Object.assign({},opts,{debugRunId,attemptToken,activeResolutionKey:key,resolutionKey:key,selectedAt,source:request.reason,callerFunction:'runCourseMappingAttempt'})));
    publishMappingAttempt(attempt);
    const promise=(async()=>{
      window.__gdCoursePlayResolverActive={course:c,courseId:request.courseId,courseName:request.courseName,courseCentre:request.courseCentre,hole:h,key,revision,attemptToken,debugRunId,selectedAt,reason:request.reason,at:Date.now(),owner:'runCourseMappingAttempt'};
      window.__gdCoursePlayResolverInFlight=coursePlayResolverInFlight;
      recordMappingDebug(debugRunId,{source:'course-loader',phase:'requested',event:'course-selected',summary:'Course selected',details:{courseId:request.courseId,courseName:request.courseName,hole:h,invokedBy:request.reason,resolutionKey:key,attemptToken}});
      recordMappingDebug(debugRunId,{source:'course-loader',phase:'started',event:'mapping-attempt-started',summary:'Course mapping attempt started',details:{courseId:request.courseId,courseName:request.courseName,courseCentre:request.courseCentre,hole:h,revision,attemptToken}});
      recordCoursePlayDebug('course-mapping-attempt-started',c,h,{reason:request.reason,resolutionKey:key,attemptToken,revision});
      if(request.showLoading)showCourseLoading(c.name||c.courseName||'Loading course');
      updateCourseLoading(`Opening Hole ${h}`,24);
	      try{
	        rememberRequestedPlayHole(h);
	        const resumeAvailableBeforeOpen=resumeRoundAvailableForCloudMap();
	        try{if(typeof resetPlay==='function')resetPlay(true);}catch(e){}
	        try{setMappedPlayMode('mapped',{skipFrame:true,silent:true,preserveAssist:true});}catch(e){}
	        const cloudMapResult=await tryHydrateCourseMapFromCloud(request,attempt,Object.assign({},opts,{__resumeRoundAvailableBeforeOpen:resumeAvailableBeforeOpen}));
	        if(cloudMapResult&&cloudMapResult.attempted&&!mappingAttemptStillCurrent(request,attempt,'cloud-map'))return {playable:false,stale:true,reason:'superseded-after-cloud-map'};
	        recordMappingDebug(debugRunId,{source:'saved-map',phase:'started',event:'saved-map-lookup-started',summary:'Saved-map lookup started',details:{hole:h,existingTrustedMap:false,resolutionKey:key,attemptToken}});
        const localSavedMapAllowed=opts.allowLocalSavedMap!==false;
        const savedState=savedMapCanSatisfyRequest(c,h,request.wholeCourse);
        const savedPlayable=!!savedState.requestedPlayable;
        const savedReady=!!savedState.ready;
        const savedIncomplete=savedPlayable&&request.wholeCourse&&!savedReady;
        recordMappingDebug(debugRunId,{source:'saved-map',phase:savedReady&&localSavedMapAllowed?'completed':'skipped',event:savedReady&&!localSavedMapAllowed?'saved-map-ignored-without-database-map':savedReady?'saved-map-found':savedIncomplete?'saved-map-incomplete':'saved-map-not-found',summary:savedReady&&!localSavedMapAllowed?'Saved map ignored without database map':savedReady?'Saved map found':savedIncomplete?'Saved map incomplete':'Saved map not found',details:{hole:h,existingTrustedMap:savedPlayable,localSavedMapAllowed,resolutionKey:key,attemptToken,wholeCourse:request.wholeCourse,playableHoleCount:savedState.coverage.count,expectedHoleCount:savedState.coverage.expected,playableHoles:savedState.coverage.holes,missingHoles:savedState.coverage.missing}});
        if(savedReady&&localSavedMapAllowed){
          finishMappingDebug(debugRunId,{status:'completed',outcome:'trusted saved map ready'});
          return showResolvedCoursePlayHole(c,h,'saved-map',opts);
        }
        if(!mappingAttemptStillCurrent(request,attempt,'saved-map'))return {playable:false,stale:true,reason:'superseded-before-automapper'};
        updateCourseLoading('Mapping from OSM',42);
        const mapOpts={quiet:true,frame:false,promptStart:true,fresh:opts.fresh!==false,course:c,__gdResolverOwned:true,skipGeometryResolver:true,resolutionKey:key,activeResolutionKey:key,attemptToken,debugRunId,selectedAt,reason:request.reason,debugAttemptContext:attempt,callerFunction:'runCourseMappingAttempt'};
        if(request.wholeCourse===false)mapOpts.hole=h;
        const autoMapResult=await autoMapOsmCourse(mapOpts);
        if(!mappingAttemptStillCurrent(request,attempt,'automapper'))return {playable:false,stale:true,reason:'superseded-after-automapper'};
        try{
          document.body.dataset.gdCourseAutoMappedHoles=String(autoMapResult&&autoMapResult.holes||0);
          document.body.dataset.gdCourseAutoMapSaved=String(autoMapResult&&autoMapResult.saved||0);
        }catch(e){}
        const autoState=savedMapCanSatisfyRequest(c,h,request.wholeCourse);
        const autoPlayable=!!autoState.requestedPlayable;
	        const autoReady=!!autoState.ready;
	        const autoAccepted=autoReady||!!(opts.acceptPartialGeneratedMap&&autoPlayable);
	        recordCoursePlayDebug('course-mapping-automapper-completed',c,h,{holes:autoMapResult&&autoMapResult.holes||0,saved:autoMapResult&&autoMapResult.saved||0,playable:autoAccepted,partial:autoAccepted&&!autoReady,requestedHolePlayable:autoPlayable,source:'automapper',resolutionKey:key,attemptToken});
	        if(autoAccepted){
	          recordMappingDebug(debugRunId,{source:'automapper',phase:'completed',event:'automapper-succeeded',summary:'AutoMapper succeeded',details:{hole:h,resolutionKey:key,attemptToken,guideCount:autoMapResult&&autoMapResult.holes||0,saved:autoMapResult&&autoMapResult.saved||0}});
	          recordMappingDebug(debugRunId,{source:'course-loader',phase:'completed',event:'mapping-attempt-completed',summary:'Course mapping completed',details:{hole:h,source:'automapper',resolutionKey:key,attemptToken}});
	          await syncGeneratedCourseMapToCloud(request,'automapper',opts);
	          finishMappingDebug(debugRunId,{status:'completed',outcome:'automapper map ready'});
	          const shown=await showResolvedCoursePlayHole(c,h,'automapper',opts);
	          return Object.assign(shown,{partial:autoAccepted&&!autoReady,readiness:autoState,persisted:autoMapResult,holes:autoMapResult&&autoMapResult.holes||0,saved:autoMapResult&&autoMapResult.saved||0});
	        }
        if(!(autoMapResult&&autoMapResult.automapperError)){
          recordMappingDebug(debugRunId,{source:'automapper',phase:'failed',event:'automapper-failed',summary:'AutoMapper failed',details:{hole:h,resolutionKey:key,attemptToken,guideCount:autoMapResult&&autoMapResult.holes||0,saved:autoMapResult&&autoMapResult.saved||0},error:autoMapResult&&autoMapResult.automapperError||null});
        }
        if(!mappingAttemptStillCurrent(request,attempt,'native-resolver'))return {playable:false,stale:true,reason:'superseded-before-native-resolver'};
        const nativeResult=await runNativeResolverStage(request,attempt,autoMapResult,opts);
        if(nativeResult&&nativeResult.stale)return {playable:false,stale:true,reason:'native-resolver-stale'};
        if(!mappingAttemptStillCurrent(request,attempt,'native-resolver'))return {playable:false,stale:true,reason:'superseded-after-native-resolver'};
	        if(nativeResult&&nativeResult.playable){
	          recordMappingDebug(debugRunId,{source:'course-loader',phase:'completed',event:'mapping-attempt-completed',summary:'Course mapping completed',details:{hole:h,source:'native-resolver',resolutionKey:key,attemptToken}});
	          await syncGeneratedCourseMapToCloud(request,'native-resolver',opts);
	          finishMappingDebug(debugRunId,{status:'completed',outcome:'native resolver map ready'});
	          const shown=await showResolvedCoursePlayHole(c,h,'native-resolver',Object.assign({},opts,{collectCoursePlayFrames:false}));
	          return Object.assign(shown,{partial:!!nativeResult.partial,readiness:nativeResult.readiness||null,persisted:nativeResult.persisted,holes:nativeResult.persisted&&nativeResult.persisted.holes||0,saved:nativeResult.persisted&&nativeResult.persisted.saved||0});
	        }
        recordCoursePlayDebug('course-mapping-automatic-unresolved',c,h,{reason:'automatic-resolution-failed',resolutionKey:key,attemptToken});
        return beginInteractiveGreenFallback(c,h,'automatic-resolution-failed',{resolutionKey:key,activeResolutionKey:key,attemptToken,debugRunId,selectedAt,debugAttemptContext:attempt,callerFunction:'runCourseMappingAttempt',source:'mapping-controller'});
      }catch(error){
        try{console.warn('[Clarity Caddy] course mapping attempt failed',error);}catch(e){}
        recordCoursePlayDebug('course-mapping-attempt-error',c,h,{reason:error&&error.message||'mapping-controller-error',resolutionKey:key,attemptToken});
        recordMappingDebug(debugRunId,{source:'course-loader',phase:'failed',event:'mapping-attempt-failed',summary:'Course mapping attempt failed',details:{resolutionKey:key,attemptToken},error:{message:error&&error.message||String(error),name:error&&error.name||''}});
        if(!mappingAttemptStillCurrent(request,attempt,'course-loader'))return {playable:false,stale:true,reason:'superseded-after-error'};
        return beginInteractiveGreenFallback(c,h,'mapping-controller-error',{resolutionKey:key,activeResolutionKey:key,attemptToken,debugRunId,selectedAt,debugAttemptContext:attempt,callerFunction:'runCourseMappingAttempt',source:'mapping-controller'});
      }finally{
        try{if(window.__gdCoursePlayResolverActive&&window.__gdCoursePlayResolverActive.attemptToken===attemptToken)delete window.__gdCoursePlayResolverActive;}catch(e){}
      }
    })();
    coursePlayResolverInFlight[key]=promise;
    promise.finally(()=>{delete coursePlayResolverInFlight[key];});
    return promise;
  }
  async function resolveCoursePlayHole(course,opts={}){
    return runCourseMappingAttempt(Object.assign({},opts,{course,reason:opts.reason||'course-play-resolver'}));
  }
  window.runCourseMappingAttempt=runCourseMappingAttempt;
  window.gdRunCourseMappingAttempt=runCourseMappingAttempt;
  window.gdResolveCoursePlayHole=resolveCoursePlayHole;
  window.gdBeginInteractiveGreenFallback=beginInteractiveGreenFallback;
  async function openCourseToFirstHole(course){
    const c=sessionCourse(course||courseObj());
    if(!c||isManualGpsCourse(c)){hideCourseLoading(0);return false;}
    const h=1;
    const openingKey=courseOpenKey(c,h);
    const activeFallback=window.__gdCoursePlayInteractiveFallbackActive||interactiveGreenFallbackState;
    if(activeFallback&&String(activeFallback.resolutionKey||activeFallback.key||'')===String(coursePlayResolverKey(c,h))){
      recordCoursePlayDebug('course-open-skipped-manual-fallback-active',c,h,{reason:'manual-fallback-terminal',resolutionKey:activeFallback.resolutionKey||activeFallback.key||'',attemptToken:activeFallback.attemptToken||''});
      hideCourseLoading(0);
      return true;
    }
    if(courseOpenAlreadySettled(c,h)){hideCourseLoading(0);return true;}
    if(courseOpenInFlight(c,h))return true;
    window.__gdOpeningCourseToFirstHoleKey=openingKey;
    try{
      const result=await resolveCoursePlayHole(c,{hole:h,wholeCourse:true,showLoading:true,fresh:true,reason:'open-course-to-first-hole'});
      if(result&&result.playable)setTimeout(()=>scheduleOsmAutoMapForPlay(c,{frame:false,delayMs:20,resolvePlay:false}),700);
      return !!(result&&(result.playable||result.fallback));
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
  window.gdFocusScorecardHoleOnGps=function(){return false;};
  window.gdLockMappedGreenFromStart=forceLockMappedGreenFromStart;
  window.gdOpenCourseToFirstHole=openCourseToFirstHole;

  function installScorecardOwnerHooks(){
    if(document.__gdCourseLibraryScorecardOwnerHooks)return true;
    if(!document.addEventListener)return false;
    document.__gdCourseLibraryScorecardOwnerHooks=true;
    document.addEventListener('gd:scorecard-play-selected',event=>{
      const detail=event&&event.detail||{};
      const requestedHole=validHoleNumber(detail.hole)||validHoleNumber(currentPlayingHole)||validHoleNumber(selectedHole)||1;
      let par=detail.par??null;
      try{
        const h=rememberPlayingHole(currentPlayingHole||selectedHole||requestedHole);
        if(h&&typeof setHole==='function'){
          par=knownParForHole(h);
          setHole(par!==null?{hole:h,par}:{hole:h});
        }
      }catch(e){}
      try{saveCourseFinderCoordinate(currentMapFinderPoint(),'play-hole');}catch(e){}
      const selectedCourse=sessionCourse(courseObj());
      try{scheduleOsmAutoMapForPlay(selectedCourse,{hole:currentPlayingHole||selectedHole||requestedHole,delayMs:80,frame:true,promptStart:true});}catch(e){}
      returnToGpsFromScorecard();
      setTimeout(ensureAssumedCourseBadge,60);
      setTimeout(returnToGpsFromScorecard,60);
      setTimeout(()=>{try{if(typeof window.gdFocusMappedPreLockHole==="function")window.gdFocusMappedPreLockHole(currentPlayingHole||selectedHole||requestedHole,{source:"scorecard-play-selected",par});}catch(e){}},160);
    });
    document.addEventListener('gd:scorecard-save',()=>{
      try{rememberPlayingHole(currentPlayingHole||selectedHole||1);}catch(e){}
      const shouldReturn=(()=>{try{return sessionStorage.getItem('gd_return_from_scorecard')==='gps'||document.body.classList.contains('gdGpsActive')||document.body.classList.contains('shell-gps');}catch(e){return true;}})();
      if(shouldReturn)setTimeout(returnToGpsFromScorecard,80);
    });
    return true;
  }

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
          if(!isManualGpsCourse(c))showCourseLoadingIfNeeded(c,1);
          const res=oldOpen.apply(this,arguments);
          try{
            if(c&&!/^manual gps$/i.test(String(c.name||''))){
              sessionStorage.removeItem('gd_assumed_course_name');
              window.gdAssumedCourseName='';
            }
          }catch(e){}
          setTimeout(ensureAssumedCourseBadge,80);
	          if(!isManualGpsCourse(c)&&!(Number(window.__gdCoursePickerOwnsOpenResolverUntil||0)>Date.now())){
	            openCourseToFirstHole(c);
	          }
          return res;
        };
        window.openCourse=wrapped; try{openCourse=wrapped;}catch(e){}
      }
      installScorecardOwnerHooks();
	      const oldSetStart=typeof setStart==='function'?setStart:window.setStart;
	      if(typeof oldSetStart==='function'){
	        const wrapped=function(ll,saveUndo){
	          const res=oldSetStart.apply(this,arguments);
	          try{saveCourseFinderCoordinate(ll,'set-start');}catch(e){}
	          try{
	            const manualStanding=!!(document.body?.classList?.contains('gdManualStartPlacementActive')||Number(window.__gdManualStandingPlacementActiveUntil||0)>Date.now());
	            const greenFocusActive=!!(document.body?.classList?.contains('gdGreenArrivalMode')||Number(window.__gdGreenFocusSettingBallUntil||0)>Date.now());
	            if(!greenFocusActive&&(manualStanding||saveUndo)) scheduleMappedOrSavedGreenAfterStart(ll,!!saveUndo,'manual-start');
	          }catch(e){}
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
    return `${count} saved object${count===1?'':'s'}`;
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
    el.innerHTML=`<div class="gdCourseLibrarySheet"><div class="gdCourseLibraryHead"><div><h2>Saved Courses</h2><p>Objects are grouped by saved GPS course, with duplicates merged by course label.</p></div><button class="gdSheetClose" type="button" onclick="closeCourseLibraryPanel()">×</button></div><div class="gdCourseLibrarySearch"><input id="gdCourseLibrarySearchInput" type="search" placeholder="Search saved courses"><button id="gdCourseLibraryFindCourseBtn" type="button">Find course</button></div><div id="gdCourseLibraryList"></div></div>`;
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
  function courseLibraryMappingAdmin(){
    const actor=currentAdminActor();
    const role=String((typeof gdGetAccountPermission==='function'&&gdGetAccountPermission())||actor.role||document.body?.dataset?.gdPermission||document.body?.dataset?.clarityAccountRole||document.body?.dataset?.accountRole||'player').toLowerCase();
    return role==='admin'||role==='coach';
  }
  function courseRecentRows(){
    const rows=(()=>{try{return JSON.parse(localStorage.getItem('gd_recent_course_picks_v1')||'[]');}catch(e){return [];}})();
    return (Array.isArray(rows)?rows:[]).map(item=>{
      const name=String(item?.name||item?.courseName||'').trim();
      if(!name||/^manual gps$/i.test(name))return null;
      return {
        name,
        courseName:name,
        courseId:item?.courseId||item?.canonicalKey||slug(name),
        canonicalKey:item?.canonicalKey||slug(name),
        lat:Number.isFinite(Number(item?.lat))?Number(item.lat):null,
        lng:Number.isFinite(Number(item?.lng))?Number(item.lng):null,
        pickedAt:item?.pickedAt||item?.updatedAt||item?.createdAt||''
      };
    }).filter(Boolean);
  }
  function syncCourseLibraryHeading(mappingView){
    const overlay=document.getElementById('gdCourseLibraryOverlay');
    const title=overlay?.querySelector('.gdCourseLibraryHead h2');
    const sub=overlay?.querySelector('.gdCourseLibraryHead p');
    const input=overlay?.querySelector('#gdCourseLibrarySearchInput');
    if(title)title.textContent=mappingView?'Saved Courses':'Recent Courses';
    if(sub)sub.textContent=mappingView?'Objects are grouped by saved GPS course, with duplicates merged by course label.':'Recently played or selected courses.';
    if(input)input.placeholder=mappingView?'Search saved courses':'Search recent courses';
  }
  function openRecentCourse(row){
    const course={
      name:row.name,
      courseName:row.name,
      courseId:row.courseId||row.canonicalKey,
      canonicalKey:row.canonicalKey||slug(row.name),
      lat:Number.isFinite(Number(row.lat))?Number(row.lat):null,
      lng:Number.isFinite(Number(row.lng))?Number(row.lng):null,
      source:'recent-course'
    };
    if(typeof window.closeCourseLibraryPanel==='function')window.closeCourseLibraryPanel();
    if(typeof window.gdOpenCoursePickerCourse==='function')return window.gdOpenCoursePickerCourse(course);
    try{localStorage.setItem('gd_active_course_v1',JSON.stringify(course));sessionStorage.setItem('gd_assumed_course_name',course.name);}catch(e){}
    if(typeof enterGpsModule==='function')return enterGpsModule({fromCoursePicker:true,selectedCourse:course});
    return false;
  }
  function renderCourseLibraryRecents(){
    const list=document.getElementById('gdCourseLibraryList');
    if(!list)return;
    syncCourseLibraryHeading(false);
    const search=document.getElementById('gdCourseLibrarySearchInput');
    if(search&&search.value!==courseLibraryFilter)search.value=courseLibraryFilter;
    const filter=normalizeCourseName(courseLibraryFilter);
    const rows=courseRecentRows().filter(row=>!filter||normalizeCourseName(row.name).includes(filter));
    list.innerHTML='';
    if(!rows.length){
      list.innerHTML=`<div class="gdCourseCard"><strong>${filter?'No matching recents':'No recent courses yet'}</strong><span>${filter?'Try another search.':'Play or select a course and it will appear here.'}</span></div>`;
      return;
    }
    rows.forEach(row=>{
      const card=document.createElement('button');
      card.className='gdCourseCard gdRecentCourseCard';
      card.type='button';
      const meta=row.pickedAt?`Recent · ${dateLabel(row.pickedAt)}`:'Recent';
      card.innerHTML=`<strong>${esc(row.name)}</strong><span>${esc(meta)}</span>`;
      card.onclick=()=>openRecentCourse(row);
      list.appendChild(card);
    });
  }
  function renderCourseLibraryPanel(detailKey=null){
    const list=document.getElementById('gdCourseLibraryList');
    if(!list)return;
    if(!courseLibraryMappingAdmin()){
      renderCourseLibraryRecents();
      return;
    }
    syncCourseLibraryHeading(true);
    const search=document.getElementById('gdCourseLibrarySearchInput');
    if(search&&search.value!==courseLibraryFilter)search.value=courseLibraryFilter;
    const uid=userId();
    const filter=normalizeCourseName(courseLibraryFilter);
    const courses=libraryCourses(uid)
      .filter(c=>!filter||normalizeCourseName(c.courseName).includes(filter))
      .sort((a,b)=>String(a.courseName).localeCompare(String(b.courseName))||(isPublishedCourse(a)?1:0)-(isPublishedCourse(b)?1:0));
    if(!courses.length){
      list.innerHTML=`<div class="gdCourseCard"><strong>${filter?'No matching courses':'No saved courses yet'}</strong><span>${filter?'Try another search or find/select a course from GPS.':'Scan a green or save a mapper pin in GPS and it will appear here.'}</span></div>`;
      return;
    }
    if(detailKey){
      const course=findLibraryCourse(detailKey,uid);
      if(!course){renderCourseLibraryPanel();return;}
	      const s=courseSummary(course);
	      const finderSuffix=courseFinderPoint(course)?' · locator pin':'';
	      const published=isPublishedCourse(course);
	      const hasPublished=hasPublishedCourseMap(course);
	      const publishBtn=isAdminUser()&&!hasPublished?`<button type="button" onclick="gdCLPublishCourse('${esc(course.id)}')">Publish</button>`:'';
	      const status=hasPublished?' · published':'';
		      list.innerHTML=`<div class="gdCourseCard ${published?'published':''}"><strong>${esc(course.courseName)}</strong><span>${courseSummaryLine(s)}${finderSuffix}${status}</span><div class="gdCourseActions"><button type="button" onclick="renderCourseLibraryPanel()">Back</button><button type="button" onclick="gdCLOpenCourseFromLibrary('${esc(course.id)}')">Open Map</button><button class="primary" type="button" onclick="gdCLOpenCourseFromLibrary('${esc(course.id)}',1,null,true)">${published?'View Map':'Mapping Mode'}</button>${publishBtn}</div></div>`;
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
      const published=isPublishedCourse(course);
      const card=document.createElement('button');
      card.className=`gdCourseCard${published?' published':''}`;
      card.type='button';
      card.innerHTML=`<strong>${esc(course.courseName)}</strong><span>${courseSummaryLine(s)}${finderSuffix}${hasPublishedCourseMap(course)?' · published':''}</span>`;
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
      if(!res.ok){
        const error=new Error(`Course map lookup failed (${res.status})`);
        error.status=res.status;
        if(opts.throwOnError)throw error;
        return loadPublishedStore();
      }
      const data=await res.json();
      const merged=mergePublishedStore(data);
      try{renderCourseLibraryPanel();}catch(e){}
      return merged;
    }catch(e){
      if(opts.throwOnError)throw e;
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
    const c={name:saved.courseName,courseId:saved.courseId,lat:finder?.lat??saved.courseLat??null,lng:finder?.lng??saved.courseLng??null,courseLat:saved.courseLat??null,courseLng:saved.courseLng??null};
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
  document.addEventListener('click',ev=>{
    if(ev.target?.closest?.('#gdMapperToolsBtn'))openMapperToolsDrawer(ev);
  },true);
})();

/* Clarity GPS visual/hole-rail/zoom hotfix — 2026-06-18 */
(function(){
  "use strict";
  if(window.__gdHoleFrameVisualZoomHotfixV1) return;
  window.__gdHoleFrameVisualZoomHotfixV1=true;

  function safe(fn,fallback){try{return fn();}catch(_){return fallback;}}

  function ensureBlackoutDefault(){
    safe(function(){document.body&&document.body.classList.remove("gdPreLockBlackoutFrame");});
  }

  function normaliseHoleRailLabel(){
    var rail=document.getElementById("gdHoleStepper");
    if(!rail) return;
    var label=rail.querySelector("strong");
    if(label){
      var txt=String(label.textContent||"").trim();
      var m=txt.match(/(\d+)/);
      if(m && txt!=="H"+m[1]) label.textContent="H"+m[1];
      label.classList.add("gdHoleRailNumber");
    }
  }

  function zoomFallback(){
    var btn=document.getElementById("gdGpsSnapZoomBtn");
    if(!btn || btn.__gdZoomFallbackBound) return;
    btn.__gdZoomFallbackBound=true;
    btn.addEventListener("click",function(event){
      safe(function(){event.preventDefault();event.stopPropagation();});
      setTimeout(function(){
        safe(function(){
          if(window.gdFrameMappedPreLockPreset){
            var n=Number(window.__gdZoomFallbackPreset||0);
            window.__gdZoomFallbackPreset=(n+1)%3;
            window.gdFrameMappedPreLockPreset(window.__gdZoomFallbackPreset,{animate:false,immediate:true});
          }else if(window.gdFocusMappedPreLockHole){
            var h=Number(sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole")||1)||1;
            window.gdFocusMappedPreLockHole(h,{source:"zoom-fallback",reenterGps:false,refreshGps:false});
          }else if(window.map && map.zoomIn){
            map.zoomIn(1,{animate:true});
          }
        });
      },0);
    },false);
  }

  function tick(){
    ensureBlackoutDefault();
    normaliseHoleRailLabel();
    zoomFallback();
  }

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",tick);
  else tick();
  setInterval(tick,650);
  document.addEventListener("click",function(){setTimeout(tick,50);},true);
})();
