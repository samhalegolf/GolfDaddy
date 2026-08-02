/* Clarity Caddy Personal Course Library + Pin-Lock MVP v1 */
(function(){
  'use strict';

  const STORE_KEY='gd_user_course_library_v1';
  const PUBLISHED_STORE_KEY='gd_published_course_library_v1';
  const PUBLISHED_COURSE_API='/api/course-maps';
  const COURSE_LIBRARY_API='/api/course-library';
  /* Last freshness result, so UI can say "new map update available" without
     re-asking, and so the check is observable for diagnostics. */
  let lastCourseLibraryFreshness={checked:false,stale:[],missing:[],current:[],serverTime:''};
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
  let courseLibraryDetailKey=null;
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
    try{
      const owner=window.GDCourseLocation;
      if(owner&&typeof owner.attachToCourse==='function')snap=owner.attachToCourse({...snap,courseCentre:opts.courseCentre||opts.courseCenter||snap.courseCentre||snap.courseCenter},{requireConfirmed:false});
    }catch(e){}
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
  /* Stored library records carry courseName, not name - ensureCourse builds them
     as {id,userId,courseId,courseName,...}. Reading only .name meant every stored
     record was classified as Manual GPS, so sessionCourse substituted the nearest
     built-in course. In Auckland that is Akarana, which is why picking any course
     with a stored record navigated to Akarana instead. */
  function rawCourseName(course=courseObj()){return String(course?.name||course?.courseName||'Manual GPS');}
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
    try{
      const owner=window.GDCourseLocation;
      const resolved=owner&&typeof owner.resolve==='function'&&!isManualGpsCourse(c)?owner.resolve(c,{requireConfirmed:false}):null;
      if(resolved&&resolved.centre)return resolved.centre;
    }catch(e){}
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
  /* localStorage is a hard ~10MB bucket. When it fills, setItem throws
     QuotaExceededError - and this file used to catch that and throw it away,
     so the automapper would map a course, silently persist nothing, read back
     nothing and report "automapper failed" (that is exactly what broke the
     Pupuke scan). Quota errors are handled, never swallowed: evict
     re-derivable caches, retry once, and if the write still fails, count it
     so the mapping flow reports a persist failure instead of a mapping one. */
  let storePersistFailures=0;
  let lastStorePersistFailure=null;
  function isStorageQuotaError(error){
    return !!(error&&(error.name==='QuotaExceededError'||error.name==='NS_ERROR_DOM_QUOTA_REACHED'||error.code===22||error.code===1014));
  }
  /* Safe to evict: OSM guide caches (refetchable) and captured hole frame
     tiles whose scan is already in Supabase - either pulled from it
     (cloudHydrated) or confirmed pushed (sync meta records the pushed
     updated_at). A tile whose scan has not reached the database yet is the
     only copy of that capture and is never evicted. */
  function evictableStorageKeys(){
    let registry=null,syncMeta=null;
    try{registry=JSON.parse(localStorage.getItem('gd_captured_surface_scans_v1')||'null');}catch(e){}
    try{syncMeta=JSON.parse(localStorage.getItem('gd_captured_surface_sync_v1')||'null');}catch(e){}
    const pushed=syncMeta&&syncMeta.pushed&&typeof syncMeta.pushed==='object'?syncMeta.pushed:{};
    const protectedTiles=new Set();
    (Array.isArray(registry&&registry.scans)?registry.scans:[]).forEach(scan=>{
      if(!scan)return;
      const tileKey=scan.storage&&scan.storage.legacyManifestKey;
      if(!tileKey)return;
      const inCloud=!!(scan.cloudHydrated||(scan.source&&scan.source.cloudHydrated))
        ||(!!pushed[scan.id]&&String(pushed[scan.id])>=String(scan.updatedAt||scan.createdAt||''));
      if(!inCloud)protectedTiles.add(tileKey);
    });
    const allKeys=[];
    try{
      if(typeof localStorage.length==='number'&&typeof localStorage.key==='function'){
        for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k!=null)allKeys.push(k);}
      }else{
        for(const k in localStorage){if(Object.prototype.hasOwnProperty.call(localStorage,k))allKeys.push(k);}
      }
    }catch(e){}
    return allKeys.filter(key=>key.startsWith(OSM_HOLE_GUIDE_CACHE_PREFIX)||(key.startsWith('gd_captured_hole_frame_')&&!protectedTiles.has(key)));
  }
  function storageSetEvicting(key,value,label){
    try{localStorage.setItem(key,value);return true;}
    catch(error){
      if(!isStorageQuotaError(error)){
        storePersistFailures++;
        lastStorePersistFailure={at:Date.now(),key,label:label||'',error:String(error&&error.message||error),name:error&&error.name||''};
        try{console.warn('[Clarity Caddy] storage write failed',key,error);}catch(e){}
        return false;
      }
      const evicted=evictableStorageKeys();
      evicted.forEach(k=>{try{localStorage.removeItem(k);}catch(e){}});
      try{
        localStorage.setItem(key,value);
        try{console.warn(`[Clarity Caddy] storage quota hit saving ${label||key} - evicted ${evicted.length} cloud-backed cache entries and retried OK`);}catch(e){}
        return true;
      }catch(retryError){
        storePersistFailures++;
        lastStorePersistFailure={at:Date.now(),key,label:label||'',error:String(retryError&&retryError.message||retryError),name:retryError&&retryError.name||'',quota:true,evicted:evicted.length};
        try{console.warn(`[Clarity Caddy] device storage full - ${label||key} could not be saved even after evicting ${evicted.length} cache entries`,retryError);}catch(e){}
        toastSafe('Device storage full - map save failed');
        return false;
      }
    }
  }
  function saveStore(store){return storageSetEvicting(STORE_KEY,JSON.stringify(store),'course-library');}
  function cloneData(value){try{return JSON.parse(JSON.stringify(value));}catch(e){return value;}}
  function loadPublishedStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(PUBLISHED_STORE_KEY)||'{}')||{};
      if(!parsed.courses)parsed.courses={};
      return parsed;
    }catch(e){return {version:1,courses:{}};}
  }
  function savePublishedStore(store){
    return storageSetEvicting(PUBLISHED_STORE_KEY,JSON.stringify(store),'published-course-library');
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
    try{
      const owner=window.GDCourseLocation;
      const resolved=owner&&typeof owner.get==='function'?owner.get(course):null;
      if(resolved&&resolved.centre)return resolved.centre;
    }catch(e){}
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
    try{
      const owner=window.GDCourseLocation;
      if(owner&&typeof owner.confirm==='function'){
        const saved=owner.confirm(c,{lat,lng},{source:source||'course-library-finder'});
        return saved&&saved.storedCourse||saved;
      }
    }catch(e){}
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
        gdSafeLocalSet('gd_active_course_v1',JSON.stringify(active));
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
    /* If the store did not persist, this object does not exist: callers count
       the return value as a committed save and the play path re-reads the
       store to judge success, so pretending here is what turned a full disk
       into "automapper failed". */
    if(!saveStore(store))return null;
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
    try{
      const owner=window.GDCourseLocation;
      const resolved=owner&&typeof owner.resolve==='function'?owner.resolve(course,{requireConfirmed:false}):null;
      if(resolved&&resolved.centre)return resolved.centre;
    }catch(e){}
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
  /* Hole counts are not always 18. Nine-hole courses, 27-hole courses played as
     three nines, and genuine oddities like Takapuna's 17 are all normal - a
     course with fewer than 18 mapped holes is not a failed scan.

     Assuming 18 had real consequences beyond a wrong label: courseDataMapReadiness
     marked those courses incomplete, which reported "saved-map-incomplete" on
     every entry and suppressed the cloud sync outright ("reason:incomplete-map"),
     so a 9 or 17 hole course could never publish.

     Resolution order, most authoritative first:
       1. the live scorecard, when a round is in progress
       2. a hole count declared on the course record
       3. the highest hole number the course actually has data for
       4. 18, only when nothing at all is known */
  const COURSE_HOLE_COUNT_MAX=36;
  function scorecardHoleCount(){
    try{
      if(typeof scorecard!=='undefined'&&scorecard&&Array.isArray(scorecard.holes)&&scorecard.holes.length)return scorecard.holes.length;
    }catch(e){}
    try{
      if(window.scorecard&&Array.isArray(window.scorecard.holes)&&window.scorecard.holes.length)return window.scorecard.holes.length;
    }catch(e){}
    return 0;
  }
  function declaredHoleCount(course){
    const c=course||{};
    const raw=Number(c.holeCount??c.holes_count??c.expectedHoleCount??(c.payload&&c.payload.holeCount));
    return Number.isFinite(raw)&&raw>0?raw:0;
  }
  /* Deliberately NOT inferred from how many holes happen to be mapped. That
     reading makes any partial scan look complete: a course with four holes
     mapped would "expect" four and be judged done, so the resolver would never
     finish it. The count has to be declared by something that knows - the
     scorecard, or a completed whole-course sweep recording what it found. */
  function courseExpectedHoleCount(course){
    const resolved=scorecardHoleCount()||declaredHoleCount(course)||18;
    return Math.max(1,Math.min(COURSE_HOLE_COUNT_MAX,resolved));
  }
  /* Persist what a completed whole-course sweep found, so the count becomes
     declared rather than guessed. Guarded to sane sizes: a sweep that returned
     one or two holes has clearly not mapped a course and must not convince
     later checks that the course is that small. */
  function recordDiscoveredHoleCount(course,count){
    const found=Number(count);
    if(!Number.isFinite(found)||found<9||found>COURSE_HOLE_COUNT_MAX)return false;
    try{
      const uid=userId();
      const cid=courseId(course);
      const store=loadStore();
      const key=findCourseKey(store,uid,cid);
      const row=key&&store.courses[key];
      if(!row)return false;
      if(Number(row.holeCount)===found)return false;
      row.holeCount=found;
      row.updatedAt=nowIso();
      saveStore(store);
      return true;
    }catch(e){return false;}
  }
  const OSM_AUTOMAPPER_RADIUS_M=1400;
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
        bundle.automapperDetails=autoDetails;
        bundle.automapperStatus='success';
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
    el.innerHTML=`<div class="gdCourseConfirmSheet"><div class="gdCourseConfirmHead"><div><h2>Playing at</h2><p>Confirm which course this round is saved under.</p></div><button class="gdSheetClose" type="button" onclick="gdCloseCourseConfirmation()">×</button></div><div id="gdCourseConfirmBody"></div></div>`;
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
      .map(course=>`<button class="gdCourseCandidate" type="button" data-course-name="${esc(course.courseName)}"><strong>${esc(course.courseName)}</strong><span>${esc(distanceLabel(course.distanceM))} · ${esc(savedDataLabel(course))}</span></button>`)
      .join('');
    body.innerHTML=`<div class="gdCourseCurrent"><span>Playing now</span><strong>${esc(label)}</strong><small>${isUsefulCourseName(label)?'You chose this':'Guessed from your location'}</small></div>${rows?`<div class="gdCourseCandidateList"><p>Saved courses nearby</p>${rows}</div>`:`<div class="gdCourseCandidateEmpty">No saved courses nearby. Search by name if this is wrong.</div>`}<div class="gdCourseConfirmActions"><button type="button" id="gdKeepCourseGuessBtn">Keep this</button><button type="button" id="gdSearchCourseGuessBtn">Change course</button></div>`;
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
	    lockMappedGreenFromStart:forceLockMappedGreenFromStart,
	    mappedHolePlayData,
	    mappedFairwayAxisForShot,
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
  window.gdScheduleOsmAutoMapForPlay=scheduleOsmAutoMapForPlay;

		  function ensureMapperToolsDrawer(){
    let el=document.getElementById('gdMapperToolsDrawer');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdMapperToolsDrawer';
    el.className='gdMapperToolsDrawer hidden';
    el.innerHTML=`<div class="gdMapperToolsSheet"><div class="gdMapperToolsHead"><div><h2>Map Tools</h2><p>Save course objects inside the current course group. Greens and bunkers stay usable from their own library tabs.</p></div><button class="gdSheetClose" type="button" onclick="gdCloseMapperTools()">×</button></div><div class="gdMapperCourseLine" id="gdMapperCourseLine"></div><div class="gdMapperToolGrid"><button class="gdMapperToolChoice primary" type="button" id="gdMapperGreenTool"><strong>Green</strong><span>Tap a green centre and save it as a reusable green target.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperBunkerTool"><strong>Bunker Pin</strong><span>Tap one bunker anchor and save it to the bunker map.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperTeeTool"><strong>Tee Pin</strong><span>Tap a tee reference point for the active hole.</span></button><button class="gdMapperToolChoice" type="button" id="gdMapperFairwayTool"><strong>Fairway Point</strong><span>Tap a fairway reference or landing zone for the active hole.</span></button></div></div>`;
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
	    el.innerHTML=`<div class="gdMapperHoleStepper" aria-label="Mapping hole"><button type="button" data-hole-step="-1">‹</button><strong id="gdMapperHoleValue">H1</strong><button type="button" data-hole-step="1">›</button></div><button class="gdMapperFlyoutAction primary" data-map-tool="green" type="button" aria-label="Green pin"><span class="ico">▰</span><span class="txt">Green</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="assignhole" type="button" aria-label="Assign hole"><span class="ico" id="gdMapperAssignHoleValue">H1</span><span class="txt">Hole</span></button><button class="gdMapperFlyoutAction" data-map-tool="bunker" type="button" aria-label="Bunker pin"><span class="ico">◒</span><span class="txt">Bunker</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="mapstyle" type="button" aria-label="OSM line guide"><span class="ico">▧</span><span class="txt">Guide</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly" data-map-tool="automap" type="button" aria-label="Auto map from OSM"><span class="ico">A</span><span class="txt">Auto</span></button><button class="gdMapperFlyoutAction" data-map-tool="tee" type="button" aria-label="Tee pin"><span class="ico">T</span><span class="txt">Tee</span></button><button class="gdMapperFlyoutAction" data-map-tool="fairway" type="button" aria-label="Fairway point"><span class="ico">•</span><span class="txt">Fairway</span></button><button class="gdMapperFlyoutAction gdFullMappingOnly gdMapperClearHoleTool" data-map-tool="clearhole" type="button" aria-label="Clear this hole"><span class="ico">×</span><span class="txt">Clear H1</span></button>`;
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
	      if(tool==='assignhole')assignActiveGreenFromToolbar();
	      if(tool==='automap')runServerAutoMapTool();
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
	  /* autoMapOsmCourse (the client-side "run AutoMapper now" orchestrator) was removed here.
	     Per the course-package architecture doc's acceptance criteria ("No AutoMapper logic
	     runs on the user's phone"), the app no longer runs its own top-level AutoMapper pass -
	     see resolveGeometryFromServerPackage/runServerAutoMapTool below, and
	     functions/course-mapper-jobs.mjs + functions/lib/gd-automapper-core.mjs server-side.
	     The Native Geometry Resolver fallback (numbering holes from scorecard-distance matching
	     when OSM has shapes but no hole numbers) is also fully server-side now -
	     functions/lib/gd-geometry-resolver-core.mjs, invoked from
	     functions/course-mapper-worker-background.mjs. The guide-assembly/save helpers that used
	     to turn a resolved guide into saved course objects (saveOsmAutoHole, persistOsmGuideBundle,
	     chooseAutoMapGuides, etc.) and the Green Shape Engine refinement pass that used to run
	     from within them were removed here along with it. loadOsmGuideBundle and the OSM
	     query/parse helpers above remain: they are still used by the live, unrelated manual
	     "Full Mapping Mode" guide-line overlay feature. */
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
	          /* Quiet background warm, same server-first/no-client-fetch rule as
	             runCourseMappingAttempt: check (and, as a side effect, trigger) the server
	             package; apply if it is already ready, otherwise this is a no-op for now and
	             the course is picked up again the next time it is actually opened. */
	          resolveGeometryFromServerPackage(c).catch(()=>{});
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
	    if(type==='mapstyle'||type==='assignhole'||type==='automap'||type==='save'||type==='next'||type==='clearhole')return false;
	    const h=mapperHole();
	    const objects=courseObjectsForMapper();
	    if(type==='sand')type='bunker';
	    if(type==='green')return objects.some(o=>Number(o.holeNumber)===Number(h)&&o.confirmed&&!!objectCenter(o));
	    return objects.some(o=>o.type===type&&Number(o.holeNumber)===Number(h)&&(type!=='green'||o.confirmed));
	  }
	  function mapperToolCaptureType(type){
	    if(type==='mapstyle'||type==='assignhole'||type==='automap'||type==='save'||type==='next'||type==='clearhole')return '';
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
	    startMapperGreenPinCapture(opts);
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
	    // window.confirm returns false instantly in the embedded webview without
	    // drawing anything, so this clear silently did nothing there.
	    if(typeof window.gdConfirmDialog==="function"){
	      window.gdConfirmDialog({
	        title:`Clear H${h} mapping?`,
	        message:"Removes green, tee and fairway for this hole only.",
	        confirmLabel:"Clear hole"
	      }).then(ok=>{if(ok)clearCurrentMapperHoleConfirmed(h);});
	      return;
	    }
	    if(!window.confirm||window.confirm(`Clear H${h} mapping? This removes green, tee and fairway for this hole only.`))clearCurrentMapperHoleConfirmed(h);
	  }
	  function clearCurrentMapperHoleConfirmed(h){
	    {
	      const uid=userId(),cid=courseId();
	      const green=resetUserGreen(uid,cid,h)?1:0;
	      const tees=deleteCourseObjectsForHole('tee',h,uid,cid);
	      const fairways=deleteCourseObjectsForHole('fairway',h,uid,cid);
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
    const expected=courseExpectedHoleCount(c);
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
    const expected=courseExpectedHoleCount(course);
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
    const expected=courseExpectedHoleCount(c);
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
	  /* Literal course identity: whatever the picker's search returned, slugged.
	     Deliberately never reads .id - on a stored library record that is the
	     composite `${userId}::${courseId}` storage key, not a course identity.
	     No fuzzy candidate list and no nearest-course fallback: two spellings of
	     the same course become two records, and merging them is a backend job. */
	  function literalCourseKey(course){
	    const c=course||{};
	    const key=slug(c.courseId||c.courseName||c.name||'');
	    return key&&key!=='item'?key:'';
	  }
	  /* Download previously captured scans for this course before anything decides
	     to capture.

	     pullCourse writes each row into the same local manifest keys the saved-map
	     check reads, so a hydrated course satisfies that check and never reaches
	     the automapper. That is why this runs before it rather than after.

	     Until now nothing called pullCourse at all - the only cloud lookup was for
	     published course_maps, so any course scanned but not published missed on
	     every device, every time, and was rescanned from scratch. That is how one
	     course accumulated 231 rows across 18 holes. */
	  async function tryHydrateCapturedScansFromCloud(request,opts={}){
	    if(opts.capturedScanHydrate===false)return {attempted:false,reason:'disabled'};
	    if(typeof fetch!=='function')return {attempted:false,reason:'fetch-unavailable'};
	    const api=cloudCourseMapSyncApi();
	    if(!api)return {attempted:false,reason:'sync-unavailable'};
	    const key=literalCourseKey(request&&request.course);
	    if(!key)return {attempted:false,reason:'no-course-key'};
	    try{
	      const result=await api.pullCourse(key,{reason:'course-play-scan-hydrate'});
	      const pulled=Number(result&&result.pulled)||0;
	      const holes=result&&result.imported&&result.imported.holes||[];
	      recordMappingDebug(request.debugRunId,{source:'cloud-scans',phase:pulled?'completed':'skipped',event:pulled?'captured-scans-hydrated':'captured-scans-not-found',summary:pulled?'Captured scans loaded':'No captured scans in database',details:{courseKey:key,pulled,holes,hole:request.hole,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
	      recordCoursePlayDebug(pulled?'captured-scans-hydrated':'captured-scans-not-found',request.course,request.hole,{courseKey:key,pulled,holes,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken});
	      return {attempted:true,key,pulled,holes};
	    }catch(error){
	      /* Never fatal: a failed hydrate just means we fall through to scanning,
	         which is the behaviour that existed before this ran at all. */
	      recordMappingDebug(request.debugRunId,{source:'cloud-scans',phase:'failed',event:'captured-scans-hydrate-failed',summary:'Captured scan lookup failed',details:{courseKey:key,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken},error:{message:error&&error.message||String(error),status:error&&error.status||null}});
	      return {attempted:true,failed:true,key,error};
	    }
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
    return !!(target&&target.closest&&target.closest('button,a,input,select,textarea,.leaflet-control,.rightRail,.shellBar,.dock,#gdV62UndoDock,#gdV62ModeSwitch,#shotTile,#gdV62GpsBadge,#hint,#toast,#gdMapperToolFlyout,#gdMapperToolsDrawer,#gdMapperHoleStrip,.panel,.modulePanel,#courseScreen:not(.hidden)'));
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
	      window.GDShell?.enterGps?.({source:'interactive-green-fallback',replace:true,preserveState:true});
	      document.body.classList.add('gdMappedCourseMode','gdGpsInteractiveGreenFallbackActive','gdGpsLiveMapAllowed','gdGpsExplicitMapMode');
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
  /* Stage 6 of the course-package migration plan: before running the client's own OSM
	     fetch, ask the server (functions/course-package.mjs) whether it has already resolved
	     this course - either as a durable Lite Geometry Pack or a full published package.
	     Fails open on anything short of a definite hit: no GDCoursePackageClient (script not
	     loaded on an older cached build), a network error, a timeout, or a "processing"/"none"
	     status all return null here, and the caller falls through to autoMapOsmCourse exactly
	     as before this stage existed. This function does not itself decide whether the OSM
	     leg runs - runCourseMappingAttempt does, by checking this return value - so it never
	     changes behavior for a course the server hasn't touched.

	     Persists via the same saveCourseObject() path autoMapOsmCourse uses, so everything
	     downstream (savedMapCanSatisfyRequest, recordDiscoveredHoleCount, cloud sync) sees an
	     identical shape regardless of which source produced the geometry. */
	  async function resolveGeometryFromServerPackage(course){
	    const client=window.GDCoursePackageClient;
	    if(!client||typeof client.fetchPackage!=='function')return null;
	    const centre=guideCoursePoint(course);
	    if(!Number.isFinite(centre?.lat)||!Number.isFinite(centre?.lng))return null;
	    let pkg=null;
	    try{
	      pkg=await client.fetchPackage({courseId:courseId(course),courseName:courseName(course),courseLat:centre.lat,courseLng:centre.lng,timeoutMs:3500});
	    }catch(e){return null;}
	    if(!pkg||(pkg.status!=='lite-geo-ready'&&pkg.status!=='full-map-ready'))return null;
	    const holes=Array.isArray(pkg.holes)?pkg.holes:[];
	    if(!holes.length)return null;
	    const cid=courseId(course);
	    const name=courseName(course);
	    let saved=0,polygons=0,fallbacks=0;
	    holes.forEach(hole=>{
	      const h=validHoleNumber(hole&&hole.holeNumber);
	      if(!h)return;
	      const geometry=pkg.status==='full-map-ready'?hole.geometry:hole;
	      if(!geometry)return;
	      const green=toPlain(geometry.green);
	      if(green){
	        const hasShape=Array.isArray(geometry.greenShape)&&geometry.greenShape.length>=3;
	        const shape=hasShape?geometry.greenShape:fallbackGreenShape(green,16,40);
	        const savedGreen=saveCourseObject({userId:userId(),courseId:cid,courseName:name,course,type:'green',position:green,shape,greenShape:shape,source:'server-course-package',holeNumber:h,confirmed:true,resolverConfidence:Number.isFinite(Number(hole.confidence))?Number(hole.confidence):undefined,maxDedupeDistanceM:4});
	        if(savedGreen)saved++;
	        if(hasShape)polygons++;else fallbacks++;
	      }
	      const tee=toPlain(geometry.tee);
	      if(tee){
	        if(saveCourseObject({userId:userId(),courseId:cid,courseName:name,course,type:'tee',position:tee,source:'server-course-package',holeNumber:h,confirmed:true,maxDedupeDistanceM:4}))saved++;
	      }
	      const route=Array.isArray(geometry.route)?geometry.route:[];
	      route.slice(1,-1).forEach(point=>{
	        const bend=toPlain(point);
	        if(bend&&saveCourseObject({userId:userId(),courseId:cid,courseName:name,course,type:'fairway',position:bend,source:'server-course-package',holeNumber:h,confirmed:true,maxDedupeDistanceM:4}))saved++;
	      });
	    });
	    return {saved,holes:holes.length,polygons,fallbacks,automapperStatus:'success',serverPackageStatus:pkg.status};
	  }
	  /* Manual "Auto" tool in the full-mapping flyout (data-map-tool="automap") - an
	     operator-triggered request for the server to map this course now. Replaces the old
	     direct autoMapOsmCourse() call: the server job is asynchronous, so this polls briefly
	     rather than blocking on one request, and owns its own toasts since (unlike
	     runCourseMappingAttempt's quiet background check) this IS the user-visible action. */
	  async function runServerAutoMapTool(){
	    const course=sessionCourse(courseObj());
	    if(!course||isManualGpsCourse(course)){toastSafe('Select a course first');return null;}
	    toastSafe('Requesting server mapping...');
	    const POLL_MS=4000;
	    const MAX_ATTEMPTS=15; // ~60s of polling before telling the operator to check back later
	    for(let attempt=0;attempt<MAX_ATTEMPTS;attempt++){
	      let result=null;
	      try{result=await resolveGeometryFromServerPackage(course);}catch(e){result=null;}
	      if(result&&(result.saved>0||result.holes>0)){
	        const nextCourse=loadUserCourseData(userId(),courseId(course));
	        if(nextCourse)drawHoleObjects(nextCourse,mapperHole());
	        updateMapperHoleUi();
	        updateMapperToolCompletion();
	        renderCourseLibraryPanel();
	        gdCLRefreshProfileCard();
	        toastSafe(`Server map ready (${result.holes} hole${result.holes===1?'':'s'})`);
	        return result;
	      }
	      if(attempt<MAX_ATTEMPTS-1)await sleep(POLL_MS);
	    }
	    toastSafe('Still mapping on the server - check back shortly');
	    return null;
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
	        /* Awaited, and before the saved-map check below: hydrating writes into
	           the local store that check reads, so an already-scanned course is
	           satisfied there and never reaches the automapper. Doing this after
	           would mean scanning first and only then discovering the data existed. */
	        const cloudScanResult=await tryHydrateCapturedScansFromCloud(request,opts);
	        if(cloudScanResult&&cloudScanResult.attempted&&!mappingAttemptStillCurrent(request,attempt,'cloud-scans'))return {playable:false,stale:true,reason:'superseded-after-cloud-scans'};
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
        updateCourseLoading('Checking server map',42);
        /* No client AutoMapper below this line - per the course-package architecture doc's
           acceptance criteria, "No AutoMapper logic runs on the user's phone". The server
           (functions/course-mapper-jobs.mjs / gd-automapper-core.mjs) owns OSM querying and
           hole resolution now. resolveGeometryFromServerPackage() both checks AND, as a side
           effect of the request it makes, triggers a server mapping run if none exists yet
           (functions/course-package.mjs's buildCoursePackageWithTrigger) - so a course with
           nothing to report here is already being mapped server-side in the background.
           A miss here is NOT a failure: it falls through exactly as a zero-guide AutoMapper
           result always has, to the native resolver and then manual fallback below. */
        let autoMapResult=null;
        try{autoMapResult=await resolveGeometryFromServerPackage(c);}catch(e){autoMapResult=null;}
        if(autoMapResult)recordMappingDebug(debugRunId,{source:'automapper',phase:'completed',event:'server-course-package-hit',summary:'Server already had this course mapped',details:{hole:h,resolutionKey:key,attemptToken,serverPackageStatus:autoMapResult.serverPackageStatus,holes:autoMapResult.holes,saved:autoMapResult.saved}});
        if(!mappingAttemptStillCurrent(request,attempt,'server-course-package'))return {playable:false,stale:true,reason:'superseded-after-server-course-package'};
        if(!autoMapResult){
          recordMappingDebug(debugRunId,{source:'automapper',phase:'skipped',event:'server-course-package-pending',summary:'Server has not mapped this course yet',details:{hole:h,resolutionKey:key,attemptToken}});
          autoMapResult={saved:0,holes:0,polygons:0,fallbacks:0,automapperStatus:'server-pending'};
        }
        if(!mappingAttemptStillCurrent(request,attempt,'automapper'))return {playable:false,stale:true,reason:'superseded-after-automapper'};
        try{
          document.body.dataset.gdCourseAutoMappedHoles=String(autoMapResult&&autoMapResult.holes||0);
          document.body.dataset.gdCourseAutoMapSaved=String(autoMapResult&&autoMapResult.saved||0);
        }catch(e){}
        /* A completed whole-course sweep is the only thing that actually knows
           how many holes a course has. Record it so a 9, 17 or 27 hole course
           stops being measured against an assumed 18 on every later entry.
           Only for wholeCourse - a single-hole map says nothing about the total. */
        if(request.wholeCourse!==false)recordDiscoveredHoleCount(c,autoMapResult&&autoMapResult.holes);
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
        /* The server worker tries both OSM-numbered geometry AND the Native Geometry
           Resolver fallback before giving up (functions/course-mapper-worker-background.mjs) -
           so a miss here means the server has nothing playable yet, not that the client has a
           second geometry source of its own left to try. Straight to manual fallback. */
        recordMappingDebug(debugRunId,{source:'automapper',phase:'failed',event:'automapper-failed',summary:'Server has no playable map for this course yet',details:{hole:h,resolutionKey:key,attemptToken,saved:autoMapResult&&autoMapResult.saved||0}});
        recordCoursePlayDebug('course-mapping-automatic-unresolved',c,h,{reason:'server-map-not-ready',resolutionKey:key,attemptToken});
        return beginInteractiveGreenFallback(c,h,'server-map-not-ready',{resolutionKey:key,activeResolutionKey:key,attemptToken,debugRunId,selectedAt,debugAttemptContext:attempt,callerFunction:'runCourseMappingAttempt',source:'mapping-controller'});
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
    }
  }

  function profileCardHtml(){
    const entries=downloadedCourseEntries();
    if(!entries.length)return 'No courses downloaded';
    const bytes=entries.reduce((sum,e)=>sum+(Number(e&&e.bytes)||0),0);
    return `${entries.length} course${entries.length===1?'':'s'} downloaded · ${sizeLabel(bytes)}`;
  }
  function isCoachProfileCardView(){
    const kicker=document.querySelector('#gdProfileV67 .kicker');
    const coachEditing=/Coach Editing/i.test(kicker?.textContent||'');
    return coachEditing&&!(typeof window.gdCoachCanSeeProfileFeature==='function'&&window.gdCoachCanSeeProfileFeature('courses'));
  }
  /* gd-auth-account-shell.js already renders this same card (same id) inline
     wherever canShowProfileCard('courses') allows it, with a static "Recent
     courses." placeholder - there is no download data at template-render
     time to put there instead. Rather than fight over who owns the node,
     this always brings whichever card is already in the DOM up to date with
     the live download store, and only builds one from scratch on a surface
     that never rendered it at all. */
  function gdCLInjectProfileCourseCard(){
    const existing=document.getElementById('gdProfileCoursesCard');
    if(isCoachProfileCardView()){
      if(existing)existing.remove();
      return;
    }
    if(existing){
      const span=existing.querySelector('span');
      if(span)span.textContent=profileCardHtml();
      return;
    }
    const grid=document.querySelector('#gdProfileV67 .cards');
    if(!grid)return;
    const btn=document.createElement('button');
    btn.id='gdProfileCoursesCard';
    btn.className='card';
    btn.type='button';
    btn.innerHTML=`<img class="gdCourseLibraryCardIcon" src="assets/home/clarity-caddy-course-library-icon.png?v=defd0c72" alt=""><div><strong>Courses</strong><span>${profileCardHtml()}</span></div>`;
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
    el.innerHTML=`<div class="gdCourseLibrarySheet"><div class="gdCourseLibraryHead"><div><h2>Course Library</h2><p>Courses downloaded to this device for offline play.</p></div><button class="gdSheetClose" type="button" onclick="closeCourseLibraryPanel()">×</button></div><div class="gdCourseLibrarySearch"><input id="gdCourseLibrarySearchInput" type="search" placeholder="Search downloaded courses"><button id="gdCourseLibraryFindCourseBtn" type="button">Find course</button></div><div id="gdCourseLibraryList"></div></div>`;
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
	  function objectsForHole(course,hole){
	    const h=validHoleNumber(hole);
	    if(!h)return [];
	    return objectValues(course).filter(object=>Number(object.holeNumber)===Number(h)&&object.confirmed&&(object.type!=='green'||hasConfirmedGreenShape(object)||!!objectCenter(object)));
	  }
	  function mappedHoleNumbers(course,s){
	    const set=new Set();
	    (s.holes||[]).forEach(h=>{const n=validHoleNumber(h.holeNumber);if(n)set.add(n);});
	    objectValues(course).forEach(object=>{const n=validHoleNumber(object.holeNumber);if(n&&object.confirmed)set.add(n);});
	    return Array.from(set).sort((a,b)=>a-b);
	  }
  /* The device's actual downloaded-map store - written by /app/'s
     course-store.js on the same origin, so what this panel shows is exactly
     what /app/ will use next time this course is opened, not a separate
     record of it. One record per course: {courseId, courseName, mapType:
     "object"|"published", objectsVersion, mapVersion, pkg, savedAt, bytes}. */
  const DOWNLOADED_COURSE_LIBRARY_KEY='clarity:course-library:v1';
  function downloadedCourseEntries(){
    try{
      const raw=JSON.parse(localStorage.getItem(DOWNLOADED_COURSE_LIBRARY_KEY)||'{}');
      return Object.keys(raw||{}).map(id=>raw[id]).filter(Boolean);
    }catch(e){return [];}
  }
  function removeDownloadedCourseEntry(courseId){
    try{
      const raw=JSON.parse(localStorage.getItem(DOWNLOADED_COURSE_LIBRARY_KEY)||'{}');
      if(!raw||!Object.prototype.hasOwnProperty.call(raw,courseId))return false;
      delete raw[courseId];
      localStorage.setItem(DOWNLOADED_COURSE_LIBRARY_KEY,JSON.stringify(raw));
      return true;
    }catch(e){return false;}
  }
  function mapTypeLabel(mapType){
    return mapType==='published'?'Published map':'Course map';
  }
  /* Background freshness check against the same lightweight manifest /app/
     uses (fetchCourseLibraryManifest, above) - the panel opens instantly from
     what is already on the device, then a badge appears if the server turns
     out to have moved on. Mirrors app.courseStore.updateAvailable() in
     app/js/course-store.js exactly, since it is answering the same question. */
  let courseLibraryManifestById=null;
  function downloadedEntryHasUpdate(entry){
    const remote=courseLibraryManifestById&&courseLibraryManifestById[entry.courseId];
    if(!remote)return false;
    const newerObjects=!!remote.objects_version&&(!entry.objectsVersion||String(remote.objects_version)>String(entry.objectsVersion));
    const newerMap=Number.isFinite(Number(remote.clarity_map_version))&&Number(remote.clarity_map_version)>Number(entry.mapVersion||0);
    return newerObjects||newerMap;
  }
  function refreshCourseLibraryManifest(){
    fetchCourseLibraryManifest().then(manifest=>{
      if(!manifest||!Array.isArray(manifest.courses))return;
      const byId={};
      manifest.courses.forEach(row=>{if(row&&row.course_id)byId[row.course_id]=row;});
      courseLibraryManifestById=byId;
      const overlay=document.getElementById('gdCourseLibraryOverlay');
      if(overlay&&!overlay.classList.contains('hidden'))renderCourseLibraryPanel(courseLibraryDetailKey);
    });
  }
  function courseStorageStats(course){
    const s=courseSummary(course);
    /* Measured on the record as stored, so the number answers "what is this
       costing me" rather than counting entries the user cannot see. */
    const bytes=(()=>{try{return JSON.stringify(course).length;}catch(e){return 0;}})();
    /* Timestamps come from the saved points, NOT course.updatedAt: normalising the
       store on load rewrites the record-level stamp, so it reads as "now" on every
       open and would report every course as updated today. The points carry the
       only stamp that tracks the data. Fall back to the record only when a course
       holds nothing, where there is no better answer. */
    const stamps=objectValues(course).map(o=>o&&o.updatedAt).filter(Boolean).sort();
    return {holes:mappedHoleNumbers(course,s).length,points:s.totalObjects,bytes,updated:stamps[stamps.length-1]||course.updatedAt||''};
  }
  /* The confirmation sheet asks "which course is this?", so the useful signal about
     each candidate is how much is already stored under it. A breakdown by object
     type ("3 green targets · 2 bunkers") answered a question nobody is asking at
     that moment, and named internals the reader cannot act on from there. */
  function savedDataLabel(course){
    const holes=mappedHoleNumbers(course,courseSummary(course)).length;
    return holes?holes+' hole'+(holes===1?'':'s')+' saved':'nothing saved yet';
  }
  /* Candidates come from a 1.4km radius, so the tail of that range reads better in
     kilometres than as a four-digit metre count. */
  function distanceLabel(metres){
    const m=Number(metres);
    if(!Number.isFinite(m))return 'nearby';
    /* Switch at a full kilometre, not before it: rounding 950m to one decimal
       prints "0.9km away", which reads as nearer than the "949m away" a metre
       earlier. */
    return m<1000?Math.round(m)+'m away':(m/1000).toFixed(1)+'km away';
  }
  function sizeLabel(bytes){
    if(!(bytes>0))return '0 KB';
    if(bytes<1024)return bytes+' B';
    if(bytes<1048576)return Math.round(bytes/1024)+' KB';
    return (bytes/1048576).toFixed(1)+' MB';
  }
  function storageSummaryLine(stats){
    const parts=[stats.holes+' hole'+(stats.holes===1?'':'s'),sizeLabel(stats.bytes)];
    if(stats.updated)parts.push('updated '+dateLabel(stats.updated));
    return parts.join(' · ');
  }
  /* Removing a whole course is the one write a storage window needs. Without it the
     only way to clear an entry was to forget its objects one at a time through the
     mapper UI that is now gone. Published-only entries have no local record to
     delete, so the caller is told nothing was removed rather than being left to
     assume it worked. */
  function removeLibraryCourse(storeId){
    const store=loadStore();
    const key=Object.keys(store.courses||{}).find(k=>store.courses[k]&&store.courses[k].id===storeId);
    if(!key)return false;
    const course=store.courses[key];
    /* Hand the location to its owner before dropping the record. GDCourseLocation
       keeps this course's picker pin in a SEPARATE store and caches the active
       centre in memory, so deleting the library record on its own strands both -
       the course keeps surfacing as a locator pin for data it no longer has. */
    try{
      const owner=window.GDCourseLocation;
      if(owner&&typeof owner.remove==='function')owner.remove(course,{source:'course-library-remove-course'});
    }catch(e){}
    /* Re-read before deleting: owner.remove writes this same store, so saving the
       copy loaded above would put the record straight back, location fields and all. */
    const fresh=loadStore();
    const freshKey=Object.keys(fresh.courses||{}).find(k=>fresh.courses[k]&&fresh.courses[k].id===storeId);
    if(freshKey)delete fresh.courses[freshKey];
    saveStore(fresh);
    return true;
  }
  /* Netflix-downloads model: what's on the device shows instantly from local
     storage, an "update available" badge only appears once the background
     manifest check (refreshCourseLibraryManifest, triggered on open) has
     actually heard back from the server - never guessed at, never blocking
     the initial render. */
  function renderCourseLibraryPanel(detailKey=null){
    const list=document.getElementById('gdCourseLibraryList');
    if(!list)return;
    courseLibraryDetailKey=detailKey;
    const overlay=document.getElementById('gdCourseLibraryOverlay');
    const title=overlay&&overlay.querySelector('.gdCourseLibraryHead h2');
    const sub=overlay&&overlay.querySelector('.gdCourseLibraryHead p');
    if(title)title.textContent='Course Library';
    if(sub)sub.textContent='Courses downloaded to this device for offline play.';
    const search=document.getElementById('gdCourseLibrarySearchInput');
    if(search&&search.value!==courseLibraryFilter)search.value=courseLibraryFilter;
    const filter=normalizeCourseName(courseLibraryFilter);
    const entries=downloadedCourseEntries()
      .filter(e=>!filter||normalizeCourseName(e.courseName).includes(filter))
      .sort((a,b)=>String(a.courseName).localeCompare(String(b.courseName)));
    if(!entries.length){
      list.innerHTML=`<div class="gdCourseCard"><strong>${filter?'No matching courses':'No courses downloaded yet'}</strong><span>${filter?'Try another search.':'Courses download automatically the first time you play them.'}</span></div>`;
      return;
    }
    if(detailKey){
      const entry=entries.find(e=>e.courseId===detailKey)||downloadedCourseEntries().find(e=>e.courseId===detailKey);
      if(!entry){renderCourseLibraryPanel();return;}
      const stale=downloadedEntryHasUpdate(entry);
      list.innerHTML=`<div class="gdCourseCard${entry.mapType==='published'?' published':''}"><strong>${esc(entry.courseName)}</strong><span>${esc(mapTypeLabel(entry.mapType))} · ${esc(sizeLabel(entry.bytes))}</span><div class="gdCourseActions"><button type="button" data-action="back">Back</button><button class="danger" type="button" data-action="remove">Remove from device</button></div></div>`;
      const facts=[
        ['Map type',mapTypeLabel(entry.mapType)],
        ['Storage used',sizeLabel(entry.bytes)],
        ['Downloaded',entry.savedAt?dateLabel(entry.savedAt):'—'],
        ['Status',stale?'Update available':'Up to date']
      ];
      list.insertAdjacentHTML('beforeend',`<div class="gdCourseCard gdCourseStorageFacts">${facts.map(([k,v])=>`<div class="gdCourseStorageRow"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`);
      list.querySelector('[data-action="back"]').onclick=()=>renderCourseLibraryPanel();
      const removeBtn=list.querySelector('[data-action="remove"]');
      /* Two taps rather than confirm(): this shell has already been seen to throw
         "prompt() is not supported", and a dialog that never appears would either
         block the delete or, worse, fall through to it. */
      let armed=false;
      removeBtn.onclick=()=>{
        if(!armed){
          armed=true;
          removeBtn.textContent='Tap again to remove';
          setTimeout(()=>{if(armed){armed=false;removeBtn.textContent='Remove from device';}},4000);
          return;
        }
        removeDownloadedCourseEntry(entry.courseId);
        gdCLRefreshProfileCard();
        renderCourseLibraryPanel();
      };
      return;
    }
    list.innerHTML='';
    entries.forEach(entry=>{
      const stale=downloadedEntryHasUpdate(entry);
      const card=document.createElement('button');
      card.className='gdCourseCard'+(entry.mapType==='published'?' published':'');
      card.type='button';
      const meta=[sizeLabel(entry.bytes),entry.savedAt?dateLabel(entry.savedAt):null].filter(Boolean).join(' · ');
      const typeBadge=`<span class="${entry.mapType==='published'?'gdSavedGreenBadge':'gdCourseObjectBadge'}">${esc(mapTypeLabel(entry.mapType))}</span>`;
      const updateBadge=stale?`<span class="gdCourseObjectBadge">Update available</span>`:'';
      card.innerHTML=`<strong>${esc(entry.courseName)}</strong><span>${esc(meta)}${typeBadge}${updateBadge}</span>`;
      card.onclick=()=>renderCourseLibraryPanel(entry.courseId);
      list.appendChild(card);
    });
  }
  window.renderCourseLibraryPanel=renderCourseLibraryPanel;
  window.openCourseLibraryPanel=function(){
    ensureCourseLibraryOverlay().classList.remove('hidden');
    renderCourseLibraryPanel();
    refreshCourseLibraryManifest();
  };
  window.closeCourseLibraryPanel=function(){
    document.getElementById('gdCourseLibraryOverlay')?.classList.add('hidden');
  };
  /* The local library is a cached mirror of the published courses. Checking
     whether it is stale must not cost what re-downloading costs, or the cache
     is pointless - /api/course-maps returns every course's full objects and
     holes, hundreds of kilobytes, and it was being fetched on every course
     entry purely to discover that nothing had changed.

     /api/course-library answers the same question in well under a kilobyte. */
  async function fetchCourseLibraryManifest(){
    if(typeof fetch!=='function')return null;
    try{
      const res=await fetch(COURSE_LIBRARY_API,{headers:{Accept:'application/json'},cache:'no-store'});
      if(!res.ok)return null;
      const data=await res.json();
      if(!data||data.configured===false||!Array.isArray(data.courses))return null;
      return data;
    }catch(e){return null;}
  }
  /* Must mirror objectsVersion() in functions/course-library.mjs: the newest of
     publishedAt and updatedAt. Comparing a different field than the server
     reports would make every course look permanently stale. */
  function localObjectsVersion(course){
    const published=String(course&&course.publishedAt||'');
    const updated=String(course&&course.updatedAt||'');
    if(published&&updated)return published>updated?published:updated;
    return published||updated||'';
  }
  function courseLibraryFreshness(manifest){
    const result={checked:false,stale:[],missing:[],current:[],serverTime:''};
    if(!manifest||!Array.isArray(manifest.courses))return result;
    result.checked=true;
    result.serverTime=manifest.serverTime||'';
    const local={};
    publishedCourses().forEach(function(course){
      const key=slug(course&&(course.courseId||course.id)||'');
      if(key)local[key]=course;
    });
    manifest.courses.forEach(function(entry){
      const key=slug(entry&&entry.course_id||'');
      if(!key)return;
      const held=local[key];
      if(!held){result.missing.push(key);return;}
      const remote=String(entry.objects_version||'');
      const mine=localObjectsVersion(held);
      /* Only a strictly newer server version counts. Equal is current, and an
         older server version means a local publish has not synced yet - not a
         reason to overwrite it. */
      if(remote&&(!mine||remote>mine))result.stale.push(key);
      else result.current.push(key);
    });
    return result;
  }
  /* Concurrent callers share one round trip. The resolver and the startup timer
     can both ask within the same window, and without this both see an empty
     local store, both decide it is stale, and both pull the full payload -
     hundreds of kilobytes fetched twice for one result. The shared promise
     resolves to {store,error} so each caller still applies its own
     throwOnError rather than inheriting another caller's error handling. */
  let publishedSyncInFlight=null;
  async function syncPublishedCourseMaps(opts={}){
    if(opts.force!==true&&publishedSyncInFlight){
      const shared=await publishedSyncInFlight;
      if(shared.error&&opts.throwOnError)throw shared.error;
      return shared.store;
    }
    const run=(async function(){
      try{return {store:await runPublishedCourseMapSync(opts),error:null};}
      catch(error){return {store:loadPublishedStore(),error:error};}
    })();
    publishedSyncInFlight=run;
    try{
      const result=await run;
      if(result.error&&opts.throwOnError)throw result.error;
      return result.store;
    }finally{
      if(publishedSyncInFlight===run)publishedSyncInFlight=null;
    }
  }
  /* Always throws on failure. Error policy belongs to the caller, not to
     whoever happened to start the shared run first - if this swallowed errors
     according to the owner's throwOnError, a sharer that asked for errors would
     silently receive a stale store instead. */
  async function runPublishedCourseMapSync(opts={}){
    {
      if(typeof fetch!=='function')return loadPublishedStore();
      /* Ask the cheap question first. Only pull full course payloads when the
         manifest says something actually changed, or when a caller explicitly
         forces it (a publish has to re-read what the server now holds). */
      if(opts.force!==true){
        const manifest=await fetchCourseLibraryManifest();
        const freshness=courseLibraryFreshness(manifest);
        lastCourseLibraryFreshness=freshness;
        if(freshness.checked&&!freshness.stale.length&&!freshness.missing.length){
          try{renderCourseLibraryPanel();}catch(e){}
          return loadPublishedStore();
        }
      }
      const res=await fetch(PUBLISHED_COURSE_API,{headers:{Accept:'application/json'},cache:'no-store'});
      if(!res.ok){
        const error=new Error(`Course map lookup failed (${res.status})`);
        error.status=res.status;
        throw error;
      }
      const data=await res.json();
      const merged=mergePublishedStore(data);
      try{renderCourseLibraryPanel();}catch(e){}
      return merged;
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
  /* Course library freshness, exposed so UI can offer "new map update
     available" without repeating the network check, and so the behaviour is
     observable on a device without a debug build. */
  window.GDCourseLibrary={
    freshness:function(){return JSON.parse(JSON.stringify(lastCourseLibraryFreshness));},
    check:async function(){
      const manifest=await fetchCourseLibraryManifest();
      lastCourseLibraryFreshness=courseLibraryFreshness(manifest);
      return window.GDCourseLibrary.freshness();
    },
    updateAvailable:function(){
      return !!(lastCourseLibraryFreshness.checked&&(lastCourseLibraryFreshness.stale.length||lastCourseLibraryFreshness.missing.length));
    },
    refresh:function(opts){return syncPublishedCourseMaps(Object.assign({quiet:true},opts||{}));}
  };
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
