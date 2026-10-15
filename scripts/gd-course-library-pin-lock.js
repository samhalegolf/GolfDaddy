/* Clarity Caddy Personal Course Library + Pin-Lock MVP v1 */
(function(){
  'use strict';

  const STORE_KEY='gd_user_course_library_v1';
  const PUBLISHED_STORE_KEY='gd_published_course_library_v1';
  const PUBLISHED_COURSE_API='/api/course-maps';
  const COURSE_LIBRARY_API='/api/course-library';
  let profileObserver=null;
  let courseLibraryFilter='';
  let courseLibraryDetailKey=null;
  let mappedPlayAssist={armed:false,hole:null,courseKey:null,locked:false,lastFrameAt:0};
  const ASSUMED_COURSE_MATCH_RADIUS_M=4000;
  const MAPPED_PLAY_MODE_PREFIX='gd_mapped_play_mode_course_v1:';
  const OSM_HOLE_GUIDE_CACHE_PREFIX='gd_osm_hole_guides_v1:';
  const OBJECT_DEDUPE_RADIUS_M={green:26,bunker:14,tee:9,fairway:12,default:10};
  const BUILT_IN_COURSE_CANDIDATES=[
    {courseName:'Akarana Golf Club',courseId:'akarana-golf-club',courseLat:-36.9174953,courseLng:174.7400425,source:'built-in-course'},
    {courseName:'Maungakiekie Golf Club',courseId:'maungakiekie-golf-club',courseLat:-36.9229754,courseLng:174.7254871,source:'built-in-course',aliases:['maungakeikei','maunga']}
  ];

  function i18nT(key,vars){const i=window.GDI18n;return i?i.t(key,vars):key;}
  function i18nN(key,n,vars){const i=window.GDI18n;return i?i.tn(key,n,vars):key;}
  function i18nH(key,vars){return esc(i18nT(key,vars));}
  function i18nSet(el,key,vars){const i=window.GDI18n;if(!el)return;if(i)i.set(el,key,vars);else el.textContent=key;}
  function i18nPlain(el,text){const i=window.GDI18n;if(!el)return;if(i)i.plain(el,text);else el.textContent=text;}
  function toastSafe(msg){try{if(typeof toast==='function')toast(msg);}catch(e){}}
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
    return Number.isNaN(d.getTime())?i18nT('course.today'):d.toLocaleDateString(window.GDI18n?window.GDI18n.locale():undefined);
  }
  function toPlain(ll){return ll?{lat:Number(ll.lat),lng:Number(ll.lng)}:null;}
  function toLatLng(v){try{return v?L.latLng(Number(v.lat),Number(v.lng)):null;}catch(e){return null;}}
  function holeNumber(){try{return Number(currentPlayingHole||1)||1;}catch(e){return 1;}}
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
  function mapperHole(){
    try{return validHoleNumber(sessionStorage.getItem('gd_mapper_active_hole'))||activePlayingHole()||holeNumber()||1;}catch(e){return activePlayingHole()||holeNumber()||1;}
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
  window.gdCourseHasMappedGreenFairway=courseHasMappedGreenFairway;
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
  function courseIdentity(course){
    const name=normalizeCourseName(course?.courseName||course?.name);
    if(name&&name!=='manual-gps')return `name:${name}`;
    const cid=slug(course?.courseId||course?.id||'assumed-golf-course');
    return `id:${cid}`;
  }
  function objectCenter(object){
    return object?.position||object?.greenCenter||object?.pinPosition||null;
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
      /* Surfaces are never merged by proximity. Two greenside bunkers 12 m apart are two
         bunkers, and this radius pass (14 m for the bunker type) was quietly folding the
         second into the first - which is one bunker the bubble could never reveal. */
      if(isSurfaceObject(base))continue;
      const basePos=objectCenter(base);
      if(!basePos)continue;
      for(let j=i+1;j<objects.length;j++){
        const next=objects[j];
        if(!next||!course.objects[next.id]||next.type!==base.type||isSurfaceObject(next))continue;
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
  /* What the server's course package put into a course record - its greens, tees, route
     bends and surfaces - is held for the session and never written to disk.

     It is a copy of server data the player can always fetch again, and /app/ (where the
     round is actually played) fetches and keeps its own copy of the same package. Saving it
     here as well put the same course on the phone twice, surfaces included. This shell only
     needs it long enough to decide the course is playable and hand it over. What the
     player made themselves (taps, scans, edits, pins) is not package data and saves as
     before. */
  const sessionPackageData={};
  function isPackageObject(object){
    return !!object&&typeof object.source==='string'&&object.source.indexOf('server-course-package')===0;
  }
  function attachSessionPackageData(store){
    Object.keys(sessionPackageData).forEach(key=>{
      const held=sessionPackageData[key];
      /* A record the disk never took (it was full) still plays from memory this session. */
      if(!store.courses[key])store.courses[key]=cloneData(held.record);
      const course=store.courses[key];
      course.objects=Object.assign({},course.objects||{},held.objects);
      if(held.surfacesVersion!==undefined)course.surfacesVersion=held.surfacesVersion;
      if(held.surfacesSavedAt!==undefined)course.surfacesSavedAt=held.surfacesSavedAt;
    });
    return store;
  }
  /* The copy that goes to disk, with package data lifted into the session. */
  function detachSessionPackageData(store){
    const disk=Object.assign({},store,{courses:{}});
    Object.keys(sessionPackageData).forEach(key=>{if(!store.courses[key])delete sessionPackageData[key];});
    Object.keys(store.courses||{}).forEach(key=>{
      const course=store.courses[key];
      if(!course){disk.courses[key]=course;return;}
      const own={};
      const pkg={};
      Object.keys(course.objects||{}).forEach(id=>{(isPackageObject(course.objects[id])?pkg:own)[id]=course.objects[id];});
      const held={objects:pkg,record:Object.assign({},course,{objects:{}})};
      if('surfacesVersion' in course)held.surfacesVersion=course.surfacesVersion;
      if('surfacesSavedAt' in course)held.surfacesSavedAt=course.surfacesSavedAt;
      if(Object.keys(pkg).length||held.surfacesSavedAt)sessionPackageData[key]=held;
      else delete sessionPackageData[key];
      const kept=Object.assign({},course,{objects:own});
      delete kept.surfacesVersion;
      delete kept.surfacesSavedAt;
      disk.courses[key]=kept;
    });
    return disk;
  }
  function loadStore(){
    try{
      const parsed=JSON.parse(localStorage.getItem(STORE_KEY)||'{}');
      if(!parsed.courses)parsed.courses={};
      /* Earlier versions saved package data to disk. The next save drops it. */
      const hadPackageOnDisk=Object.values(parsed.courses).some(c=>c&&(c.surfacesSavedAt||Object.values(c.objects||{}).some(isPackageObject)));
      if(hadPackageOnDisk)Object.values(parsed.courses).forEach(c=>{
        if(!c)return;
        Object.keys(c.objects||{}).forEach(id=>{if(isPackageObject(c.objects[id]))delete c.objects[id];});
        delete c.surfacesVersion;
        delete c.surfacesSavedAt;
      });
      attachSessionPackageData(parsed);
      if(dedupeStore(parsed)||hadPackageOnDisk)saveStore(parsed);
      return parsed;
    }catch(e){return {courses:{}};}
  }
  /* localStorage is a hard ~10MB bucket. When it fills, setItem throws
     QuotaExceededError - and this file used to catch that and throw it away,
     so the automapper would map a course, silently persist nothing, read back
     nothing and report "automapper failed" (that is exactly what broke the
     Pupuke scan). Quota errors are handled, never swallowed: evict
     re-derivable caches, retry once, and if the write still fails, report it
     and tell the player. */
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
        try{console.warn(`[Clarity Caddy] device storage full - ${label||key} could not be saved even after evicting ${evicted.length} cache entries`,retryError);}catch(e){}
        try{window.ClarityErrorReporter?.report?.(retryError,{source:'storageSetEvicting',key,label:label||'',quotaExceeded:true,evicted:evicted.length});}catch(e){}
        toastSafe(i18nT('course.storageFull'));
        return false;
      }
    }
  }
  function saveStore(store){return storageSetEvicting(STORE_KEY,JSON.stringify(detachSessionPackageData(store)),'course-library');}
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
      /* Once the package has written this course's surfaces into the private record, any
         surfaces still sitting in the published mirror (a full copy cached before the sync
         went scope=play) would draw twice over the same ground. The package copy wins. */
      objects:{...(own.surfacesSavedAt?withoutSurfaceObjects(base.objects):(base.objects||{})),...(own.objects||{})},
      holes:{...(base.holes||{}),...(own.holes||{})}
    };
  }
  function withoutSurfaceObjects(objects){
    const out={};
    Object.keys(objects||{}).forEach(id=>{if(!isSurfaceObject(objects[id]))out[id]=objects[id];});
    return out;
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
  function simplifyShape(points,max=56){
    if(!Array.isArray(points)||!points.length)return null;
    const clean=points.map(p=>toPlain(p)).filter(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng));
    if(clean.length<3)return null;
    const step=Math.max(1,Math.ceil(clean.length/max));
    const out=clean.filter((_,i)=>i%step===0);
    return out.length>=3?out:clean.slice(0,Math.min(clean.length,max));
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
  function fallbackGreenShape(center,radiusM=16,count=40){
    const ll=toLatLng(center);
    if(!ll)return [];
    const pts=[];
    for(let i=0;i<count;i++)pts.push(project(ll,(Math.PI*2*i)/count,radiusM));
    return pts;
  }
  function objectSortTime(object){
    return String(object?.createdAt||object?.updatedAt||object?.id||'');
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
  function cleanOsmShape(points){
    const clean=(points||[]).map(toPlain).filter(p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng));
    if(clean.length>3&&distance(clean[0],clean[clean.length-1])<1)clean.pop();
    return clean.length>=3?clean:null;
  }
  /* Area centroid, not a vertex average (see shapeCentroid in functions/lib/gd-automapper-core.mjs). */
  function shapeCentroid(shape){
    const pts=cleanOsmShape(shape);
    if(!pts)return null;
    let lat=0,lng=0;
    pts.forEach(p=>{lat+=Number(p.lat);lng+=Number(p.lng);});
    const mean={lat:lat/pts.length,lng:lng/pts.length};
    const k=Math.cos(mean.lat*Math.PI/180);
    let area=0,cx=0,cy=0;
    for(let i=0;i<pts.length;i++){
      const a=pts[i],b=pts[(i+1)%pts.length];
      const x1=(Number(a.lng)-mean.lng)*k,y1=Number(a.lat)-mean.lat,x2=(Number(b.lng)-mean.lng)*k,y2=Number(b.lat)-mean.lat;
      const cross=x1*y2-x2*y1;
      area+=cross;cx+=(x1+x2)*cross;cy+=(y1+y2)*cross;
    }
    if(!(Math.abs(area)>1e-14))return mean;
    const centre={lat:mean.lat+cy/(3*area),lng:mean.lng+cx/(3*area)/k};
    return Number.isFinite(centre.lat)&&Number.isFinite(centre.lng)?centre:mean;
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
  function sampleRouteProgress(route=[],stepM=7){
    const pts=route.map(toLatLng).filter(Boolean);
    if(!pts.length)return [];
    const samples=[{point:pts[0],progress:0}];
    let progress=0;
    for(let i=1;i<pts.length;i++){
      const a=pts[i-1],b=pts[i];
      const seg=distance(a,b);
      if(!Number.isFinite(seg)||seg<=0)continue;
      const steps=Math.max(1,Math.ceil(seg/Math.max(3,Number(stepM)||7)));
      for(let s=1;s<=steps;s++){
        /* Interpolated along the segment itself, never projected along a
           bearing. `bearing()` is the engine's degree-space angle (atan2 of raw
           degree deltas) while project() moves in metres with the latitude
           scaled in, and the two disagree by ~9.5 degrees at 45 degrees south -
           every sample veered right of the fairway line and the layup landed
           42 m into the rough at 250 m (Millbrook hole 1, 2026-09-22). */
        const t=s/steps;
        const point={lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t};
        samples.push({point,progress:progress+seg*t});
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
  function loadUserCourseData(uid=userId(),cid=courseId()){
    const store=loadStore();
    const privateCourse=store.courses[findCourseKey(store,uid,cid)]||null;
    const published=findPublishedCourse(cid,privateCourse?.courseName||courseName(),privateCourse||courseObj());
    return mergeCourseData(privateCourse,published,uid);
  }

  window.GolfDaddyCourseLibrary={
    loadUserCourseData,
    saveCourseObject,
	    mappedHolePlayData,
	    syncPublishedCourseMaps,
	    publishedCourseMapAvailability,
	    loadPublishedStore,
		    mappingCourseSnapshot,
		    currentMappingDebugAttempt,
		    isCurrentMappingAttempt,
		    recordStaleMappingActivity,
		    runCourseMappingAttempt,
    nearbyKnownCourses,
    nearestKnownCourse,
    knownCourseCandidates,
    objectLifecycle,
    storeKey:STORE_KEY
	  };
  window.ClarityCaddieCourseLibrary=window.GolfDaddyCourseLibrary;
  window.gdMappedHolePlayData=mappedHolePlayData;
  window.gdMappedFairwayLayupTarget=mappedFairwayLayupTarget;

  function ensureCourseLoadingOverlay(){
    let el=document.getElementById('gdCourseLoadingOverlay');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdCourseLoadingOverlay';
    el.className='gdCourseLoadingOverlay hidden';
    el.innerHTML=`<div class="gdCourseLoadingSheet"><div class="gdCourseLoadingEyebrow">Clarity Caddy</div><strong id="gdCourseLoadingTitle">${i18nH('loading.course')}</strong><span id="gdCourseLoadingSub">${i18nH('course.preparingHole',{n:1})}</span><div class="gdCourseLoadingTrack"><i id="gdCourseLoadingBar"></i></div></div>`;
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
  /* One pending hide at a time, and a show cancels it. hideCourseLoading is
     deliberately delayed (the bar reads "ready" for a beat before it goes), so
     a show that lands inside that beat - the picker re-asserting the overlay
     while it hands off to /app/ - used to be undone by the timer a moment
     later, and the picker flashed through the gap. */
  let courseLoadingHideTimer=null;
  function showCourseLoading(courseName,subText,pct){
    const el=ensureCourseLoadingOverlay();
    if(courseLoadingHideTimer){clearTimeout(courseLoadingHideTimer);courseLoadingHideTimer=null;}
    const wasHidden=el.classList.contains('hidden');
    const title=el.querySelector('#gdCourseLoadingTitle');
    const sub=el.querySelector('#gdCourseLoadingSub');
    const bar=el.querySelector('#gdCourseLoadingBar');
    if(title){if(courseName)i18nPlain(title,courseName);else i18nSet(title,'loading.course');}
    if(sub){if(subText)i18nPlain(sub,subText);else i18nSet(sub,'course.preparingHole',{n:1});}
    /* A re-show over an overlay that is already up keeps its bar where it is;
       only a fresh show starts the bar over. */
    if(bar&&Number.isFinite(Number(pct)))bar.style.width=`${Math.max(8,Math.min(100,Number(pct)))}%`;
    else if(bar&&wasHidden)bar.style.width='18%';
    el.classList.remove('hidden');
    document.body.classList.add('gdCourseOpening');
    return el;
  }
  function updateCourseLoading(text,pct){
    const el=ensureCourseLoadingOverlay();
    const sub=el.querySelector('#gdCourseLoadingSub');
    const bar=el.querySelector('#gdCourseLoadingBar');
    if(sub&&text)i18nPlain(sub,text);
    if(bar&&Number.isFinite(Number(pct)))bar.style.width=`${Math.max(8,Math.min(100,Number(pct)))}%`;
  }
  function hideCourseLoading(delay=180){
    if(courseLoadingHideTimer)clearTimeout(courseLoadingHideTimer);
    courseLoadingHideTimer=setTimeout(()=>{
      courseLoadingHideTimer=null;
      try{document.getElementById('gdCourseLoadingOverlay')?.classList.add('hidden');}catch(e){}
      try{document.body.classList.remove('gdCourseOpening');}catch(e){}
    },delay);
  }
  /* The course picker (scripts/inline/gd-course-picker-search-v2.js) puts this
     overlay up the moment a course is tapped and keeps it up until /app/ takes
     over, so the tap, the mapping wait and the hand-off read as one loading
     screen rather than a button label, a screen, a flash of picker, and a
     second screen. */
  window.GDCourseLoading={show:showCourseLoading,update:updateCourseLoading,hide:hideCourseLoading};
  function courseOpenKey(course,hole=1){
    const c=sessionCourse(course||courseObj());
    const name=String(c?.courseId||c?.id||c?.name||c?.courseName||'').trim().toLowerCase().replace(/\s+/g,' ');
    return `${name||'course'}:h${validHoleNumber(hole)||1}`;
  }
  function markCourseOpenReady(course,hole=1){
    window.__gdCourseFirstHoleReadyKey=courseOpenKey(course,hole);
    window.__gdCourseFirstHoleReadyAt=Date.now();
  }
  const coursePlayResolverInFlight={};
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
    return validHoleNumber(hole)||1;
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
      /* Publication/course selection decides course viability. This function
         answers only whether the requested hole can render; partial coverage
         is metadata, never a reason to reject every mapped hole. */
      ready:requestedPlayable
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
    return {requestedPlayable,coverage,ready:requestedPlayable};
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
	    recordCoursePlayDebug('course-play-frames-collected',c,opts.activeHole||1,{source:source||'course-play-resolver',holes:rows.length,expectedHoleCount:collection.expected,ingested});
	    return {course:c,rows,expected:collection.expected,ingested};
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
	  async function tryHydrateCourseMapFromCloud(request,attempt,opts={}){
	    if(!shouldLookupCloudCourseMap(request,opts))return {attempted:false,reason:resumeRoundAvailableForCloudMap()?'resume-round-available':'cloud-pull-unavailable'};
	    const keys=cloudCourseMapKeys(request.course);
	    if(!keys.length)return {attempted:false,reason:'cloud-pull-unavailable'};
	    recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:'started',event:'course-map-cloud-lookup-started',summary:'Course map loading',details:{courseId:request.courseId,courseName:request.courseName,hole:request.hole,resolutionKey:request.resolutionKey,attemptToken:request.attemptToken,keys,lookup:'published-course-maps'}});
	    recordCoursePlayDebug('course-map-cloud-lookup-started',request.course,request.hole,{resolutionKey:request.resolutionKey,attemptToken:request.attemptToken,keys});
	    updateCourseLoading(i18nT('course.mapLoading'),32);
	    try{
	      const maps=await syncPublishedCourseMaps({quiet:true,throwOnError:true,courseIds:keys});
	      const published=publishedCourses().find(course=>keys.some(key=>courseMatchesIdentity(course,key,request.courseName,request.course)))||null;
	      const readiness=published?courseDataMapReadiness(published,request.hole,request.wholeCourse):null;
	      if(published){
	        recordMappingDebug(request.debugRunId,{source:'cloud-map',phase:readiness&&readiness.ready?'completed':'progress',event:readiness&&readiness.ready?'course-map-cloud-loaded':'course-map-cloud-incomplete',summary:readiness&&readiness.ready?'Course map loaded from cloud':'Course map cloud data incomplete',details:{courseKey:published.courseId,lookup:'published-course-maps',publishedCourseId:published.id,pulled:Object.keys(maps&&maps.courses||{}).length,persistedObjects:Object.keys(published.objects||{}).length,holes:readiness&&readiness.coverage&&readiness.coverage.holes||[],playableHoleCount:readiness&&readiness.coverage&&readiness.coverage.count||0,expectedHoleCount:readiness&&readiness.coverage&&readiness.coverage.expected||0,missingHoles:readiness&&readiness.coverage&&readiness.coverage.missing||[],resolutionKey:request.resolutionKey,attemptToken:request.attemptToken}});
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
	      const maps=await syncPublishedCourseMaps({quiet:true,throwOnError:true,courseIds:keys});
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
	  function ingestRequestedHoleToPipeline(course,hole,source){
    try{
      const resolved=requestedMappedPlayData(course,hole);
      const pipeline=window.GDCoursePlayPipeline;
      if(resolved&&pipeline&&typeof pipeline.ingestMappedHole==='function'){
        pipeline.ingestMappedHole(resolved.course,hole,resolved.data,source||'course-play-resolver');
      }
    }catch(e){}
  }
  /* The server package poll behind the "still preparing" wait below. Counted in polls so it
     always terminates (see startServerPackageWatch). */
  const PACKAGE_WATCH_POLL_MS=6000;
  const PACKAGE_WATCH_BUDGET_MS=600000;
  let serverPackageWatch=null;
  function stopServerPackageWatch(){
    serverPackageWatch=null;
  }
  /* Waiting is a state, not a failure.
   *
   * A first-time scan is enqueued as a side effect of the very first package request, so a
   * course nobody has opened answers "processing" and keeps answering it until the worker
   * lands. awaitServerCoursePackage waits ~4 minutes for that, and when its budget ran out it
   * used to hand the player to the manual green-tap fallback - which is TERMINAL: the
   * re-entry guard in runCourseMappingAttempt then blocked every later attempt on that course,
   * so a job that finished thirty seconds later could never be picked up by pressing Play
   * again. That is the Southport case: the scan completed, the geometry was in Supabase, and
   * the app kept insisting the course could not be mapped.
   *
   * So a wait that runs out while the server is STILL PROCESSING no longer ends anything. The
   * player is told the truth - this is taking longer than usual - the package keeps being
   * polled, and when it lands the round opens by itself. The player can leave the wait and go
   * back to the courses.
   */
  let serverMapWaitState=null;
  /* Set to the resolution key the player pressed "Back to Courses" on. Read by the poll
     loop rather than acted on directly, because the wait owns the attempt: tearing down the
     loading screen from a click handler while awaitServerCoursePackage was still polling meant
     the wait's own exhausted-branch could arrive afterwards and overwrite the choice. */
  let serverWaitOptOut='';
  /* Offered well before the wait's own budget runs out. Four minutes of a moving bar with no
     way out is not "waiting", it is being stuck. */
  const SERVER_WAIT_OFFER_MS=45000;
  function ensureServerMapWaitPrompt(){
    let el=document.getElementById('gdServerMapWaitPrompt');
    if(el)return el;
    el=document.createElement('div');
    el.id='gdServerMapWaitPrompt';
    el.className='gdServerMapWaitPrompt hidden';
    el.innerHTML='<strong data-gd-wait-title>'+i18nH('course.stillPreparingThisDots')+'</strong><span data-i18n="course.firstTimeSetup">'+i18nH('course.firstTimeSetup')+'</span><div class="gdServerMapWaitActions"><button type="button" data-gd-wait-keep data-i18n="course.keepWaiting">'+i18nH('course.keepWaiting')+'</button><button type="button" data-gd-wait-leave data-i18n="mapRecovery.backToCourses">'+i18nH('mapRecovery.backToCourses')+'</button></div>';
    document.body.appendChild(el);
    if(!document.getElementById('gdServerMapWaitPromptStyle')){
      const style=document.createElement('style');
      style.id='gdServerMapWaitPromptStyle';
      style.textContent='.gdServerMapWaitPrompt{position:fixed;left:50%;bottom:calc(max(12px,env(safe-area-inset-bottom)) + 148px);transform:translateX(-50%);z-index:1900;display:flex;flex-direction:column;gap:6px;align-items:center;max-width:min(92vw,360px);border:1px solid rgba(156,255,54,.28);border-radius:18px;background:rgba(3,18,9,.9);color:#f6fff7;padding:13px 16px;text-align:center;box-shadow:0 12px 28px rgba(0,0,0,.34);backdrop-filter:blur(14px)}.gdServerMapWaitPrompt strong{font-size:14px;font-weight:950}.gdServerMapWaitPrompt span{font-size:12px;opacity:.76}.gdServerMapWaitActions{display:flex;gap:8px;margin-top:4px}.gdServerMapWaitActions button{border:1px solid rgba(246,255,247,.22);border-radius:999px;background:rgba(246,255,247,.08);color:#f6fff7;padding:7px 13px;font-size:12px;font-weight:900}.gdServerMapWaitActions button[data-gd-wait-keep]{border-color:rgba(156,255,54,.42);background:rgba(31,211,109,.18)}.gdServerMapWaitPrompt.hidden{display:none!important}';
      document.head.appendChild(style);
    }
    return el;
  }
  /* Renders the panel and wires its two buttons. Split out from beginServerMapWait because it
     is shown at two different moments for two different reasons - once mid-wait, over a
     loading screen that is still polling, and once after the wait hands over to the background
     watch - and only the second of those owns any state. */
  function showServerMapWaitPrompt(course,hole,key,opts={}){
    const prompt=ensureServerMapWaitPrompt();
    try{
      const title=prompt.querySelector('[data-gd-wait-title]');
      if(title){const n=courseName(course);if(n)i18nSet(title,'course.stillPreparingNamedDots',{course:n});else i18nSet(title,'course.stillPreparingThisDots');}
      const keep=prompt.querySelector('[data-gd-wait-keep]');
      const leave=prompt.querySelector('[data-gd-wait-leave]');
      /* "Keep waiting" only dismisses the panel - nothing here was ever conditional on it. The
         player is agreeing to what is already happening. */
      if(keep)keep.onclick=()=>{try{prompt.classList.add('hidden');}catch(e){}};
      if(leave)leave.onclick=()=>{
        try{prompt.classList.add('hidden');}catch(e){}
        if(typeof opts.onLeave==='function')opts.onLeave();
      };
      prompt.classList.remove('hidden');
    }catch(e){}
    return prompt;
  }
  function stopServerMapWait(reason){
    const state=serverMapWaitState;
    serverMapWaitState=null;
    if(state&&state.debugRunId&&reason&&reason!=='server-map-ready'){
      recordMappingDebug(state.debugRunId,{source:'automapper',phase:'cancelled',event:'server-map-wait-ended',summary:'Extended server map wait ended',details:{reason:String(reason),hole:state.hole,resolutionKey:state.resolutionKey,attemptToken:state.attemptToken}});
    }
    try{document.getElementById('gdServerMapWaitPrompt')?.classList.add('hidden');}catch(e){}
    try{document.body.classList.remove('gdServerMapWaitActive');}catch(e){}
    try{delete window.__gdCoursePlayServerMapWaitActive;}catch(e){}
    stopServerPackageWatch();
    return state;
  }
  window.gdStopServerMapWait=stopServerMapWait;
  /* Non-terminal by construction: pressing Play again re-checks the server instead of being
     turned away. */
  function beginServerMapWait(course,hole,opts={}){
    const h=validHoleNumber(hole)||1;
    const c=sessionCourse(course||courseObj());
    const key=opts.resolutionKey||coursePlayResolverKey(c,h);
    if(serverMapWaitState&&String(serverMapWaitState.resolutionKey||'')===String(key))return {playable:false,waiting:true,reused:true,debugRunId:serverMapWaitState.debugRunId};
    if(serverMapWaitState)stopServerMapWait('superseded');
    serverMapWaitState={course:c,hole:h,resolutionKey:key,attemptToken:opts.attemptToken||'',debugRunId:opts.debugRunId||'',courseId:courseId(c),courseName:courseName(c),at:Date.now()};
    recordMappingDebug(opts.debugRunId||'',{source:'automapper',phase:'progress',event:'server-map-wait-extended',summary:'Server still mapping - play kept waiting instead of falling back',details:{hole:h,resolutionKey:key,attemptToken:opts.attemptToken||'',serverPackageStatus:opts.serverPackageStatus||'processing',polls:opts.polls||0}});
    recordCoursePlayDebug('course-mapping-wait-extended',c,h,{resolutionKey:key,attemptToken:opts.attemptToken||'',serverPackageStatus:opts.serverPackageStatus||'processing'});
    /* The loading screen stays up and keeps saying something true. The prompt sits over it
       with the escape hatch, so "I am stuck" and "I want to play now" have different answers. */
    try{updateCourseLoading(courseName(c)?i18nT('course.stillPreparingNamed',{course:courseName(c)}):i18nT('course.stillPreparingThis'),82);}catch(e){}
    try{window.__gdCoursePlayServerMapWaitActive={courseId:courseId(c),courseName:courseName(c),hole:h,resolutionKey:key,at:Date.now()};}catch(e){}
    try{document.body.classList.add('gdServerMapWaitActive');}catch(e){}
    showServerMapWaitPrompt(c,h,key,{onLeave:()=>{
      stopServerMapWait('player-left-wait');
      returnToCoursePicker('player-left-wait');
    }});
    startServerPackageWatch(c,h,key);
    return {playable:false,waiting:true,armed:true,debugRunId:opts.debugRunId||''};
  }
  /* Keeps polling while the player waits, and continues into the round on its own when the
     package lands - the "you should not have to press Play again" half of the wait. */
  function startServerPackageWatch(course,hole,resolutionKey){
    const token={startedAt:Date.now()};
    serverPackageWatch=token;
    (async()=>{
      /* Counted in polls, not wall-clock: PACKAGE_WATCH_BUDGET_MS/PACKAGE_WATCH_POLL_MS
         requests is the same 10-minute watch when timers are real, but it also guarantees the
         loop terminates when they are not (the controller test harness runs setTimeout
         callbacks immediately, which made a Date.now() budget an infinite spin). */
      const maxPolls=Math.ceil(PACKAGE_WATCH_BUDGET_MS/PACKAGE_WATCH_POLL_MS);
      let watchPolls=0;
      for(;;){
        await sleep(PACKAGE_WATCH_POLL_MS);
        if(serverPackageWatch!==token)return;
        const state=serverMapWaitState;
        if(!state||String(state.resolutionKey||'')!==String(resolutionKey))return stopServerPackageWatch();
        if(++watchPolls>maxPolls){
          /* The watch, not the course, is what ran out. The player is still looking at a
             loading screen, so ending silently would strand them. */
          const waited=stopServerMapWait('watch-budget-exhausted')||{};
          endFailedScan(course,hole,'server-map-timed-out',{resolutionKey,attemptToken:waited.attemptToken,debugRunId:waited.debugRunId,serverPackageStatus:'processing'});
          return;
        }
        let pkg=null;
        try{pkg=await fetchServerCoursePackage(course);}catch(e){pkg=null;}
        if(serverPackageWatch!==token)return;
        /* A terminal answer ends the wait honestly rather than polling out the clock: the
           server has said it stopped and why. */
        if(pkg&&pkg.status==='failed'){
          const waited=stopServerMapWait('server-failed')||{};
          endFailedScan(course,hole,'server-map-failed',{resolutionKey,attemptToken:waited.attemptToken,debugRunId:waited.debugRunId,serverPackageStatus:'failed'});
          return;
        }
        if(!serverPackageIsReady(pkg))continue;
        const persisted=persistServerCoursePackage(course,pkg);
        if(!(persisted&&persisted.holes)){
          stopServerMapWait('ready-but-empty');   // ready but empty: nothing will improve by waiting
          return;
        }
        recordCoursePlayDebug('server-map-arrived-during-extended-wait',course,hole,{resolutionKey,holes:persisted.holes,saved:persisted.saved,serverPackageStatus:pkg.status});
        stopServerMapWait('server-map-ready');
        const picker=window.GDCoursePicker;
        if(picker&&typeof picker.selectCourse==='function')picker.selectCourse(course,{source:'server-map-ready'});
        else runCourseMappingAttempt({course,hole,showLoading:true,wholeCourse:true,reason:'server-map-ready'});
        return;
      }
    })();
  }
  function returnToCoursePicker(reason){
    hideCourseLoading(0);
    try{
      const picker=window.GDCoursePicker;
      if(picker&&typeof picker.open==='function')picker.open({source:reason||'scan-ended',replace:true});
    }catch(e){}
  }
  /* What a failed scan does: the player goes back to a fresh course picker with the
     map-not-available banner over it, which offers to email them when the map is ready. */
  function endFailedScan(course,hole,reason,opts={}){
    const h=validHoleNumber(hole)||1;
    const c=sessionCourse(course||courseObj());
    const key=opts.resolutionKey||coursePlayResolverKey(c,h);
    recordCoursePlayDebug('course-scan-failed',c,h,{reason:reason||'scan-failed',resolutionKey:key,attemptToken:opts.attemptToken||'',serverPackageStatus:opts.serverPackageStatus||''});
    if(opts.debugRunId)recordMappingDebug(opts.debugRunId,{source:'course-loader',phase:'failed',event:'scan-failed-back-to-picker',summary:'Scan failed - player sent back to the course picker',details:{hole:h,reason:reason||'scan-failed',resolutionKey:key,attemptToken:opts.attemptToken||''}});
    returnToCoursePicker('scan-failed');
    const notify=window.GDCourseMapNotify;
    if(notify&&typeof notify.offer==='function')Promise.resolve(notify.offer({courseId:courseId(c),courseName:courseName(c)})).catch(()=>{});
    return {playable:false,failed:true,reason:reason||'scan-failed'};
  }
  /* A scan that published fewer holes than the course has. The course opens and plays - what
     was found is real - but the player is looking at a map with holes missing, and until now
     nothing told them. The server's verdict on it ("Found 17 holes numbered up to 18 - this
     course is not complete", Sugar Ridge 2026-10-12) only reaches a package with nothing to
     play, so the readiness fields are the signal here: readiness "partial" plus the missing
     hole numbers. The same card a failed scan shows, in its incomplete wording, with the same
     "email me when it's ready" offer; the server emails only once the map is complete. */
  function offerNotifyForIncompleteScan(course,hole,autoMapResult,opts={}){
    if(!autoMapResult||autoMapResult.readiness!=='partial')return false;
    const notify=window.GDCourseMapNotify;
    if(!notify||typeof notify.offer!=='function')return false;
    const c=sessionCourse(course||courseObj());
    const h=validHoleNumber(hole)||1;
    const source=opts.source||'scan';
    const missing=(Array.isArray(autoMapResult.missingHoles)?autoMapResult.missingHoles:[]).map(Number).filter(Number.isFinite);
    const incomplete={mapped:Number(autoMapResult.mappedHoleCount)||Number(autoMapResult.holes)||0,expected:Number(autoMapResult.expectedHoleCount)||0,missing};
    recordCoursePlayDebug('course-scan-incomplete-notify-offered',c,h,{source,resolutionKey:opts.resolutionKey||'',attemptToken:opts.attemptToken||'',mapped:incomplete.mapped,expected:incomplete.expected,missingHoles:missing});
    if(opts.debugRunId)recordMappingDebug(opts.debugRunId,{source:'course-loader',phase:'completed',event:'scan-incomplete-notify-offered',summary:'Map is incomplete - email-me-when-ready offered',details:{hole:h,source,mapped:incomplete.mapped,expected:incomplete.expected,missingHoles:missing,resolutionKey:opts.resolutionKey||'',attemptToken:opts.attemptToken||''}});
    try{Promise.resolve(notify.offer({courseId:courseId(c),courseName:courseName(c)},{incomplete})).catch(()=>{});}catch(e){}
    return true;
  }
  /* The same offer for a course that opened from the device's own copy of the map - hydrated
     from the cloud a moment ago, or kept from an earlier round - where no server package was
     read and so nothing said whether the map is complete. The device cannot judge that itself:
     its expected hole count comes from the published row's hole_count, which is the number of
     holes MAPPED, so a 17-hole map reads as a 17-hole course. The course package knows
     (readiness is judged against the mapper's card count), so ask it once, after the course is
     already open, and offer the card if it says partial. Nothing waits on this: a slow or
     missing answer just means no card. */
  async function offerNotifyIfServerMapIncomplete(course,hole,opts={}){
    const c=sessionCourse(course||courseObj());
    if(!c||isManualGpsCourse(c))return false;
    /* Only for a course the server publishes. Asking the package endpoint about a course it has
       never heard of makes it START a mapping run (buildCoursePackageWithTrigger), and a player
       opening the course they drew themselves on this device has asked for no such thing. */
    if(!findPublishedCourse(courseId(c),courseName(c),c))return false;
    let pkg=null;
    try{pkg=await fetchServerCoursePackage(c);}catch(e){pkg=null;}
    if(!serverPackageIsReady(pkg)||pkg.readiness!=='partial')return false;
    /* The player may have moved to another course while the package was in flight. */
    try{if(mappedModeCourseIdentity(sessionCourse(courseObj()))!==mappedModeCourseIdentity(c))return false;}catch(e){return false;}
    return offerNotifyForIncompleteScan(c,hole,{
      readiness:pkg.readiness,
      holes:Array.isArray(pkg.holes)?pkg.holes.length:0,
      mappedHoleCount:pkg.mappedHoleCount,
      expectedHoleCount:pkg.expectedHoleCount,
      missingHoles:pkg.missingHoles
    },opts);
  }
  async function showResolvedCoursePlayHole(course,hole,reason,opts={}){
    const h=rememberRequestedPlayHole(hole||1);
    /* A course that is opening is a course that is no longer waiting. Left standing, the
       "still preparing" panel would sit over a round that is already running. */
    try{if(serverMapWaitState)stopServerMapWait('map-resolved');}catch(e){}
    const mappedCourse=loadUserCourseData(userId(),courseId(course))||course;
    ingestRequestedHoleToPipeline(mappedCourse,h,reason||'course-play-resolver');
    const frameCollection=collectCoursePlayFrames(mappedCourse,reason||'course-play-resolver',{activeHole:h});
    updateCourseLoading(i18nT('course.holeReady',{n:h}),100);
    markCourseOpenReady(mappedCourse,h);
    hideCourseLoading(220);
    return {playable:true,course:mappedCourse,hole:h,framesCollected:frameCollection};
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
	  async function fetchServerCoursePackage(course,timeoutMs){
	    const client=window.GDCoursePackageClient;
	    if(!client||typeof client.fetchPackage!=='function')return null;
	    const centre=guideCoursePoint(course);
	    if(!Number.isFinite(centre?.lat)||!Number.isFinite(centre?.lng))return null;
	    try{
	      return await client.fetchPackage({courseId:courseId(course),courseName:courseName(course),courseLat:centre.lat,courseLng:centre.lng,timeoutMs:timeoutMs||3500});
	    }catch(e){return null;}
	  }
	  function serverPackageIsReady(pkg){return !!pkg&&(pkg.status==='lite-geo-ready'||pkg.status==='full-map-ready');}
	  function persistServerCoursePackage(course,pkg){
	    const holes=Array.isArray(pkg&&pkg.holes)?pkg.holes:[];
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
	    /* fit is the server's verdict on the coordinate this run was given. It rides
	       all the way to the picker, which is the only thing that may put a pin
	       screen in front of a player. Absent means the pin held up.
	       readiness is the server's word on whether this map covers the whole course
	       (gd-course-package-shape.mjs addReadinessMetadata): "partial" with the missing
	       hole numbers when a scan published fewer holes than the card says. The course
	       still opens; the caller uses it to offer the "email me when it's ready" card. */
	    let surfaces=null;
	    try{surfaces=persistServerSurfaces(course,pkg);}catch(e){surfaces=null;}
	    return {saved,holes:holes.length,polygons,fallbacks,surfaces,automapperStatus:'success',serverPackageStatus:pkg.status,fit:pkg&&pkg.fit||null,
	      readiness:pkg.readiness||null,mappedHoleCount:Number(pkg.mappedHoleCount)||holes.length,expectedHoleCount:Number(pkg.expectedHoleCount)||null,missingHoles:Array.isArray(pkg.missingHoles)?pkg.missingHoles.slice():[]};
	  }
	  /* ---- Surfaces from the course package ----------------------------------------------

	     The collected fairway/bunker/water surfaces reach a phone HERE and only here. The
	     library sync asks /api/course-maps for scope=play, which leaves them out for any course
	     whose map is ready (see stripSurfacesForPlay there for the localStorage arithmetic), and
	     both package shapes carry them per hole: lite as hole.surfaces, full as
	     hole.geometry.surfaces. Every path that applies a package runs through
	     persistServerCoursePackage above, so every path lands the surfaces too.

	     Stored as ordinary objects on the player's private course record - type fairway_area /
	     bunker / water with a shape - because that is what everything downstream already reads:
	     GPS Play's bubble reveal (gdMappedCourseObjects), the mapper tools, the library. Keyed by
	     OSM way id, so the same physical bunker the server stores once per hole it straddles is
	     kept once. Replaced wholesale per package objectsVersion, never merged: the package is
	     the authority for surfaces and a stale bunker must not outlive its collection.

	     Held for the session only, like the rest of the package (see sessionPackageData): each
	     course is ~100-280 KB of rings, and /app/ keeps its own copy of the package. */
	  const PACKAGE_SURFACE_SOURCE='server-course-package-surface';
	  const PACKAGE_SURFACE_BUCKETS={fairways:'fairway_area',bunkers:'bunker',water:'water',trees:'trees',hazards:'hazard',waste:'waste'};
	  function isSurfaceObject(object){
	    if(!object)return false;
	    if(object.type==='fairway_area'||object.type==='water'||object.type==='trees'||object.type==='hazard'||object.type==='waste')return true;
	    return object.type==='bunker'&&Array.isArray(object.shape)&&object.shape.length>=3;
	  }
	  function surfaceShapeKey(shape){
	    const text=(Array.isArray(shape)?shape:[]).map(p=>Number(p&&p.lat).toFixed(6)+','+Number(p&&p.lng).toFixed(6)).join(';');
	    let hash=5381;
	    for(let i=0;i<text.length;i++)hash=((hash<<5)+hash+text.charCodeAt(i))>>>0;
	    return hash.toString(36);
	  }
	  /* Pure: package -> flat list of surface object records (no user/course stamping yet). */
	  function packageSurfaceRecords(pkg){
	    const holes=Array.isArray(pkg&&pkg.holes)?pkg.holes:[];
	    const out=new Map();
	    holes.forEach(hole=>{
	      const h=Number(hole&&hole.holeNumber);
	      const geometry=pkg.status==='full-map-ready'?(hole&&hole.geometry):hole;
	      const surfaces=geometry&&geometry.surfaces;
	      if(!surfaces||typeof surfaces!=='object')return;
	      Object.keys(PACKAGE_SURFACE_BUCKETS).forEach(bucket=>{
	        const type=PACKAGE_SURFACE_BUCKETS[bucket];
	        (Array.isArray(surfaces[bucket])?surfaces[bucket]:[]).forEach(surface=>{
	          const shape=(Array.isArray(surface&&surface.shape)?surface.shape:[]).map(toPlain).filter(p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng));
	          if(shape.length<3)return;
	          const key=type+':'+(surface.osmId?String(surface.osmId):'shape-'+surfaceShapeKey(shape));
	          if(out.has(key))return;
	          const center=toPlain(surface.center);
	          out.set(key,{
	            id:'pkg-'+key.replace(/[^a-z0-9_:.-]+/gi,'-'),
	            type,
	            shape,
	            position:center&&Number.isFinite(center.lat)&&Number.isFinite(center.lng)?center:shapeCentroid(shape),
	            holeNumber:Number.isFinite(h)&&h>0?h:null,
	            osmId:surface.osmId?String(surface.osmId):null,
	            hazardClass:type==='water'?String(surface.hazardClass||'water'):undefined
	          });
	        });
	      });
	    });
	    return Array.from(out.values());
	  }
	  function persistServerSurfaces(course,pkg){
	    const records=packageSurfaceRecords(pkg);
	    const version=String(pkg&&pkg.objectsVersion||'');
	    const uid=userId();
	    const c=sessionCourse(course||courseObj());
	    const cid=courseId(c);
	    if(!cid)return null;
	    const store=loadStore();
	    const target=ensureCourse(store,uid,cid,courseName(c),c);
	    target.objects=target.objects||{};
	    const haveCurrent=Object.values(target.objects).some(o=>o&&o.source===PACKAGE_SURFACE_SOURCE);
	    if(version&&target.surfacesVersion===version&&(haveCurrent||!records.length))return {surfaces:records.length,written:0,skipped:true};
	    Object.keys(target.objects).forEach(id=>{const o=target.objects[id];if(o&&o.source===PACKAGE_SURFACE_SOURCE)delete target.objects[id];});
	    const now=nowIso();
	    records.forEach(record=>{
	      const confirmed=!!validHoleNumber(record.holeNumber);
	      target.objects[record.id]={
	        ...record,
	        userId:uid,
	        courseId:target.courseId||cid,
	        confirmed,
	        lifecycle:objectLifecycle({type:record.type,holeNumber:record.holeNumber,confirmed}),
	        targetEligible:false,
	        source:PACKAGE_SURFACE_SOURCE,
	        createdAt:now,
	        updatedAt:now
	      };
	    });
	    target.surfacesVersion=version||null;
	    target.surfacesSavedAt=records.length?now:null;
	    target.updatedAt=now;
		    if(!saveStore(store))return {surfaces:records.length,written:0,persistFailed:true};
	    return {surfaces:records.length,written:records.length};
	  }
	  /* Play holds on the course-loading screen while the server mapper job runs, rather than
	     giving up the instant the first request answers "processing". That first answer is nearly always "processing" for a course nobody has
	     opened before, because the job is enqueued as a SIDE EFFECT of this very request
	     (functions/course-package.mjs buildCoursePackageWithTrigger) - so treating "processing"
	     as "no map" meant a new course could never open mapped on its first visit.

	     "none" is terminal here, not pending. The server answers "none" only when it did NOT
	     enqueue anything (anonymous caller, no location supplied, or the per-user rate limit
	     tripped), so there is no job to wait on and waiting would just stall the player.
	     "failed" is terminal for the same reason - the server has
	     already tried and said why it stopped. "failed" carries the job's error in `reason`;
	     waiting longer cannot change it, and (since 2026-08-18) the server no longer
	     re-enqueues a failed course as a side effect of polling, so there is nothing coming.

	     Everything else that is not "processing" is a TRANSIENT miss, not a verdict: a fetch
	     timeout on flaky mobile data, a 5xx, a dropped connection. One of those used to abort
	     the whole wait instantly, which ended the wait while the mapper
	     job was mid-run - the exact "the data arrives but I had to back out and re-enter" bug.
	     Now only a RUN of consecutive misses gives up; a single "processing" answer resets it.

	     The budget is ~4 minutes because the enqueue's immediate worker kick is allowed to
	     fail (course-mapper-jobs.mjs swallows it - "queued job remains sweepable"), in which
	     case the job waits for course-mapper-sweeper.mjs, which runs every 3 minutes. A 45s
	     budget could never cover that path, so first visits fell through to manual even though
	     the map showed up a minute later. Polls back off from 3s to 6s after the first 30s so
	     the long tail does not hammer the endpoint. */
	  const SERVER_PACKAGE_WAIT_MS=240000;
	  const SERVER_PACKAGE_POLL_MS=3000;
	  const SERVER_PACKAGE_MAX_CONSECUTIVE_MISSES=4;
	  async function awaitServerCoursePackage(course,opts={}){
	    const budgetMs=Number.isFinite(Number(opts.budgetMs))&&Number(opts.budgetMs)>=0?Number(opts.budgetMs):SERVER_PACKAGE_WAIT_MS;
	    const pollMs=Number.isFinite(Number(opts.pollMs))&&Number(opts.pollMs)>0?Number(opts.pollMs):SERVER_PACKAGE_POLL_MS;
	    const deadline=Date.now()+budgetMs;
	    const onProgress=typeof opts.onProgress==='function'?opts.onProgress:null;
	    const stillCurrent=typeof opts.stillCurrent==='function'?opts.stillCurrent:null;
	    let polls=0;
	    let consecutiveMisses=0;
	    for(;;){
	      const pkg=await fetchServerCoursePackage(course);
	      polls++;
	      const status=pkg&&pkg.status?String(pkg.status):'unreachable';
	      if(serverPackageIsReady(pkg)){
	        const result=persistServerCoursePackage(course,pkg);
	        if(result&&result.holes)return {result,status,polls,timedOut:false};
	        return {result:null,status,polls,timedOut:false,reason:'ready-but-empty'};
	      }
	      /* fit rides off a terminal package too. A refusal is exactly when the
	         player should be offered a pin - "there are six courses here" - and
	         dropping it here is why the Balgove failure asked for nothing. */
	      if(status==='none'||status==='failed')return {result:null,status,polls,timedOut:false,serverReason:pkg&&pkg.reason||null,fit:pkg&&pkg.fit||null};
	      if(status==='processing')consecutiveMisses=0;
	      else{
	        consecutiveMisses++;
	        if(consecutiveMisses>=SERVER_PACKAGE_MAX_CONSECUTIVE_MISSES)return {result:null,status,polls,timedOut:false,unreachable:true};
	      }
	      if(stillCurrent&&!stillCurrent())return {result:null,status,polls,timedOut:false,superseded:true};
	      /* Checked here, in the loop, so the player's choice ends the wait cleanly instead of
	         racing it. Deliberately after the ready check above: a package that landed on this
	         very poll is better than what they asked for. */
	      if(typeof opts.optedOut==='function'&&opts.optedOut())return {result:null,status,polls,timedOut:false,optedOut:true};
	      const remaining=deadline-Date.now();
	      /* stillProcessing separates the two ways this wait can run out, which are not the same
	         event at all. "The budget expired while the server was still answering processing"
	         means the job is alive and this client simply stopped watching it; "the budget
	         expired on misses" means we do not know. Only the first may keep a player waiting,
	         and neither is a mapper verdict - so neither may ever reach the pin screen. */
	      if(remaining<=0)return {result:null,status,polls,timedOut:true,stillProcessing:status==='processing'};
	      const waitedMs=budgetMs-remaining;
	      if(onProgress)onProgress({polls,remainingMs:remaining,waitedMs,budgetMs,status});
	      await sleep(Math.min(waitedMs>30000?pollMs*2:pollMs,remaining));
	    }
	  }
	  async function runCourseMappingAttempt(input={}){
	    /* The course libraries live in IndexedDB (gd-course-storage.js). Deciding whether a
	       course is already mapped before they have loaded would read a saved course as missing. */
	    if(window.GDCourseStorage)await window.GDCourseStorage.ready;
	    const opts=Object.assign({},input||{});
	    const selectedAt=opts.selectedAt||nowIso();
	    const c=mappingCourseSnapshot(sessionCourse(opts.course||courseObj()),Object.assign({},opts,{selectedAt}));
	    if(!c||isManualGpsCourse(c)){
	      /* Silent until now. "I pressed Play and nothing scanned" is a real
	         report, and this is one of its two answers - no run was ever
	         started because there is no course to scan. No debugRunId exists
	         yet at this point, so it attaches to the active run if one is
	         open and stands alone if not. */
	      recordMappingDebug(opts.debugRunId||'',{source:'course-loader',phase:'skipped',event:'mapping-attempt-skipped-manual-course',summary:'No scan: manual GPS course',details:{reason:'manual-course',requestedReason:opts.reason||'course-selected',courseName:courseName(c)||'',hole:validHoleNumber(opts.hole)||1}});
	      return {playable:false,reason:'manual-course'};
	    }
    const h=validHoleNumber(opts.hole)||1;
    const key=opts.resolutionKey||coursePlayResolverKey(c,h);
    /* A wait for a DIFFERENT course is over the moment this one starts. Left running it would
       keep polling and could yank a player out of the round they just opened. */
    if(serverMapWaitState&&String(serverMapWaitState.resolutionKey||'')!==String(key))stopServerMapWait('new-mapping-attempt');
    /* A new scan replaces the last one's failure banner. */
    try{window.GDCourseMapNotify?.hide();}catch(e){}
    /* A choice made about a previous attempt is not a choice about this one - left standing it
       would abort a fresh scan the moment it started. */
    if(serverWaitOptOut&&String(serverWaitOptOut)!==String(key))serverWaitOptOut='';
    if(coursePlayResolverInFlight[key]){
      /* The other answer to "nothing scanned": a scan for this exact course
         and hole is already running and this call joined it. Silent de-dupe
         looked identical to a dropped request in the log. */
      recordMappingDebug(opts.debugRunId||'',{source:'course-loader',phase:'skipped',event:'mapping-attempt-joined-in-flight',summary:'Scan already running for this course',details:{reason:'already-in-flight',resolutionKey:key,hole:h,requestedReason:opts.reason||'course-selected'}});
      return coursePlayResolverInFlight[key];
    }
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
      if(request.showLoading)showCourseLoading(c.name||c.courseName||i18nT('loading.course'));
      updateCourseLoading(i18nT('course.openingHole',{n:h}),24);
	      try{
	        rememberRequestedPlayHole(h);
	        const resumeAvailableBeforeOpen=resumeRoundAvailableForCloudMap();
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
          const shownFromSaved=await showResolvedCoursePlayHole(c,h,'saved-map',opts);
          offerNotifyIfServerMapIncomplete(c,h,{resolutionKey:key,attemptToken,debugRunId,source:'saved-map'}).catch(()=>{});
          return shownFromSaved;
        }
        if(!mappingAttemptStillCurrent(request,attempt,'saved-map'))return {playable:false,stale:true,reason:'superseded-before-automapper'};
        updateCourseLoading(i18nT('course.checkingServerMap'),42);
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
        let serverWait=null;
        let serverWaitError=null;
        try{
          serverWait=await awaitServerCoursePackage(c,{
            budgetMs:opts.serverWaitBudgetMs,
            pollMs:opts.serverWaitPollMs,
            stillCurrent:()=>resolverAttemptCurrent(request.attemptToken,attempt),
            optedOut:()=>String(serverWaitOptOut||'')===String(key),
            onProgress:info=>{
              /* Ramps 45 -> 80 across the wait so the loading screen keeps moving while the
                 server job runs. Deliberately vague copy: the player does not need to know
                 whether this is the Overpass leg or the geometry resolver. After 30s the
                 copy admits this is a longer wait - honest feedback beats a stuck bar. */
              const pct=Math.min(80,45+35*((info.waitedMs||0)/(info.budgetMs||SERVER_PACKAGE_WAIT_MS)));
              updateCourseLoading((info.waitedMs||0)>30000?i18nT('loading.preparingSlow'):i18nT('loading.preparing'),pct);
              /* Once the wait is clearly a long one, say so and offer the way out. The wait
                 itself carries on regardless - this adds a choice, it does not take one. */
              if((info.waitedMs||0)>SERVER_WAIT_OFFER_MS)showServerMapWaitPrompt(c,h,key,{onLeave:()=>{serverWaitOptOut=key;}});
            }
          });
          autoMapResult=serverWait&&serverWait.result||null;
        }catch(e){
          /* The thrown error used to be discarded here, and the !autoMapResult
             branch below then reported it as 'server-course-package-pending' -
             a crash and a genuinely queued job looked identical in the log.
             Keep it so the failure branch can say which one happened. */
          serverWaitError=e||null;
          serverWait=null;
          autoMapResult=null;
        }
        if(autoMapResult)recordMappingDebug(debugRunId,{source:'automapper',phase:'completed',event:'server-course-package-hit',summary:serverWait&&serverWait.polls>1?'Server finished mapping while play waited':'Server already had this course mapped',details:{hole:h,resolutionKey:key,attemptToken,serverPackageStatus:autoMapResult.serverPackageStatus,holes:autoMapResult.holes,saved:autoMapResult.saved,polls:serverWait&&serverWait.polls||1}});
        if(!mappingAttemptStillCurrent(request,attempt,'server-course-package'))return {playable:false,stale:true,reason:'superseded-after-server-course-package'};
        /* The player left the wait for the course picker. Honoured before anything below can
           reinterpret it: it is a choice, not a mapping failure, so no failure banner. */
        if(serverWait&&serverWait.optedOut){
          serverWaitOptOut='';
          try{document.getElementById('gdServerMapWaitPrompt')?.classList.add('hidden');}catch(e){}
          recordMappingDebug(debugRunId,{source:'automapper',phase:'cancelled',event:'server-map-wait-left',summary:'Player went back to the courses while the server was still mapping',details:{hole:h,resolutionKey:key,attemptToken,polls:serverWait.polls||0}});
          returnToCoursePicker('player-left-wait');
          return {playable:false,cancelled:true,reason:'player-left-wait'};
        }
        if(!autoMapResult){
          const waitStatus=serverWait&&serverWait.status||'unreachable';
          const waitTimedOut=!!(serverWait&&serverWait.timedOut);
          /* A thrown wait is a failure, not a pending job. Without this the
             status stayed 'unreachable' and the summary said the server had
             not mapped the course yet, which was not what happened. */
          const waitFailed=waitStatus==='failed'||!!serverWaitError;
          const serverReason=serverWait&&serverWait.serverReason||null;
          recordMappingDebug(debugRunId,{source:'automapper',phase:'skipped',event:waitFailed?'server-course-package-failed':waitTimedOut?'server-course-package-wait-timed-out':'server-course-package-pending',summary:waitFailed?('Server mapping failed: '+(serverReason||serverWaitError&&serverWaitError.message||'no reason recorded')):waitTimedOut?'Server was still mapping when play stopped waiting':'Server has not mapped this course yet',details:{hole:h,resolutionKey:key,attemptToken,serverPackageStatus:waitStatus,serverReason,polls:serverWait&&serverWait.polls||0,timedOut:waitTimedOut,budgetMs:SERVER_PACKAGE_WAIT_MS,threw:!!serverWaitError},error:serverWaitError?{message:serverWaitError&&serverWaitError.message||String(serverWaitError),status:serverWaitError&&serverWaitError.status||null}:undefined});
          autoMapResult={saved:0,holes:0,polygons:0,fallbacks:0,automapperStatus:waitFailed?'server-failed':waitTimedOut?'server-timed-out':'server-pending',serverPackageStatus:waitStatus,serverReason,fit:serverWait&&serverWait.fit||null};
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
	          finishMappingDebug(debugRunId,{status:'completed',outcome:'automapper map ready'});
	          const shown=await showResolvedCoursePlayHole(c,h,'automapper',opts);
	          offerNotifyForIncompleteScan(c,h,autoMapResult,{resolutionKey:key,attemptToken,debugRunId});
	          return Object.assign(shown,{partial:autoAccepted&&!autoReady,readiness:autoState,persisted:autoMapResult,holes:autoMapResult&&autoMapResult.holes||0,saved:autoMapResult&&autoMapResult.saved||0,fit:autoMapResult&&autoMapResult.fit||null});
	        }
        /* The server worker tries both OSM-numbered geometry AND the Native Geometry
           Resolver fallback before giving up (functions/course-mapper-worker-background.mjs) -
           so a miss here means the server has nothing playable yet, not that the client has a
           second geometry source of its own left to try. Straight to manual fallback. */
        /* Reached only after awaitServerCoursePackage gave a terminal answer or burned its
           whole wait budget - so this is no longer "the job had not started yet", it is
           "the server has nothing playable and is not about to produce any". */
        const unresolvedReason=autoMapResult&&autoMapResult.automapperStatus==='server-timed-out'?'server-map-timed-out':'server-map-not-ready';
        /* The one branch that must NOT end in the terminal fallback. The wait ran out while the
           server was still answering "processing" - the job is alive, it is just slower than
           the budget, which is ordinary for a first-time scan whose worker kick was swallowed
           and which is waiting on the 3-minute sweeper. Falling back here is what made a course
           that mapped successfully a minute later permanently unopenable. */
        if(serverWait&&serverWait.timedOut&&serverWait.stillProcessing){
          recordCoursePlayDebug('course-mapping-still-processing',c,h,{reason:'server-still-processing',resolutionKey:key,attemptToken,polls:serverWait.polls||0});
          return beginServerMapWait(c,h,{resolutionKey:key,attemptToken,debugRunId,serverPackageStatus:autoMapResult&&autoMapResult.serverPackageStatus||'processing',polls:serverWait.polls||0});
        }
        recordMappingDebug(debugRunId,{source:'automapper',phase:'failed',event:'automapper-failed',summary:'Server has no playable map for this course yet',details:{hole:h,resolutionKey:key,attemptToken,saved:autoMapResult&&autoMapResult.saved||0,serverPackageStatus:autoMapResult&&autoMapResult.serverPackageStatus||'',reason:unresolvedReason}});
        recordCoursePlayDebug('course-mapping-automatic-unresolved',c,h,{reason:unresolvedReason,resolutionKey:key,attemptToken});
        /* When the server said WHY - and the why is "we could not tell which course this
           is" - the picker offers a pin instead of the failure banner: that is a repair the
           player can make, not a map that is missing. */
        const unresolvedFit=autoMapResult&&autoMapResult.fit||null;
        if(unresolvedFit&&unresolvedFit.trusted===false){
          hideCourseLoading(0);
          return {playable:false,failed:true,reason:unresolvedReason,fit:unresolvedFit};
        }
        const ended=endFailedScan(c,h,unresolvedReason,{resolutionKey:key,attemptToken,debugRunId,serverPackageStatus:autoMapResult&&autoMapResult.serverPackageStatus||''});
        return unresolvedFit?Object.assign({},ended,{fit:unresolvedFit}):ended;
      }catch(error){
        try{console.warn('[Clarity Caddy] course mapping attempt failed',error);}catch(e){}
        recordCoursePlayDebug('course-mapping-attempt-error',c,h,{reason:error&&error.message||'mapping-controller-error',resolutionKey:key,attemptToken});
        recordMappingDebug(debugRunId,{source:'course-loader',phase:'failed',event:'mapping-attempt-failed',summary:'Course mapping attempt failed',details:{resolutionKey:key,attemptToken},error:{message:error&&error.message||String(error),name:error&&error.name||''}});
        if(!mappingAttemptStillCurrent(request,attempt,'course-loader'))return {playable:false,stale:true,reason:'superseded-after-error'};
        return endFailedScan(c,h,'mapping-controller-error',{resolutionKey:key,attemptToken,debugRunId});
      }finally{
        try{if(window.__gdCoursePlayResolverActive&&window.__gdCoursePlayResolverActive.attemptToken===attemptToken)delete window.__gdCoursePlayResolverActive;}catch(e){}
      }
    })();
    coursePlayResolverInFlight[key]=promise;
    promise.finally(()=>{delete coursePlayResolverInFlight[key];});
    return promise;
  }
  window.runCourseMappingAttempt=runCourseMappingAttempt;
  window.gdRunCourseMappingAttempt=runCourseMappingAttempt;



  function profileCardHtml(){
    const entries=downloadedCourseEntries();
    if(!entries.length)return i18nT('course.noCoursesDownloaded');
    const bytes=entries.reduce((sum,e)=>sum+(Number(e&&e.bytes)||0),0);
    return i18nN('course.coursesDownloaded',entries.length,{size:sizeLabel(bytes)});
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
    btn.innerHTML=`<img class="gdCourseLibraryCardIcon" src="assets/home/clarity-caddy-course-library-icon.png?v=defd0c72" alt=""><div><strong>${i18nH('course.profileCardTitle')}</strong><span>${esc(profileCardHtml())}</span></div>`;
    btn.onclick=function(ev){ev.preventDefault();openCourseLibraryPanel();return false;};
    grid.appendChild(btn);
  }
  /* Anything drawn before the course libraries finished loading from IndexedDB drew an
     empty library; draw it again now that they are here. */
  window.addEventListener('clarity:course-storage-ready',()=>{
    try{gdCLRefreshProfileCard();}catch(e){}
    try{renderCourseLibraryPanel(courseLibraryDetailKey);}catch(e){}
  });
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
    el.innerHTML=`<div class="gdCourseLibrarySheet"><div class="gdCourseLibraryHead"><div><h2>${i18nH('course.libraryTitle')}</h2><p>${i18nH('course.librarySubtitle')}</p></div><button class="gdSheetClose" type="button" onclick="closeCourseLibraryPanel()">×</button></div><div class="gdCourseLibrarySearch"><input id="gdCourseLibrarySearchInput" type="search" placeholder="${i18nH('course.librarySearch')}" data-i18n-placeholder="course.librarySearch"><button id="gdCourseLibraryFindCourseBtn" type="button" data-i18n="course.findCourse">${i18nH('course.findCourse')}</button></div><div id="gdCourseLibraryList"></div></div>`;
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
  /* The device's actual downloaded-map store - written by /app/'s
     course-store.js on the same origin, so what this panel shows is exactly
     what /app/ will use next time this course is opened, not a separate
     record of it. One record per course: {courseId, courseName, mapType:
     "object"|"published", objectsVersion, mapVersion, pkg, savedAt, bytes}. */
  const DOWNLOADED_COURSE_LIBRARY_KEY='clarity:course-library:v1';
  function hasOfflineCourseAccess(){
    try{
      return !!(window.ClarityPayments&&typeof window.ClarityPayments.hasActiveAccess==='function'&&window.ClarityPayments.hasActiveAccess());
    }catch(e){return false;}
  }
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
    return mapType==='published'?i18nT('course.publishedMap'):i18nT('course.courseMap');
  }
  function mapTypeForPackage(pkg){
    if(pkg&&pkg.status==='full-map-ready')return 'published';
    if(pkg&&pkg.status==='lite-geo-ready')return 'object';
    return null;   // processing/failed/none - nothing worth keeping
  }
  /* Re-download a course whose stored copy the manifest says is stale.

     The record is written in EXACTLY the shape app/js/course-store.js writes,
     into the same key, because this panel is a view of /app/'s store rather
     than a second copy of it - anything else and the two would disagree about
     what is on the device.

     The panel could report "Update available" and offer no way to act on it,
     which is what it did: the badge is computed from the manifest but the
     detail card only ever rendered Back and Remove. A stale map is one the
     course has actually changed under, so the fix has to be reachable from
     where the problem is stated. */
  async function updateDownloadedCourseEntry(entry){
    if(!entry||!entry.courseId)return {ok:false,reason:'invalid'};
    if(!hasOfflineCourseAccess())return {ok:false,reason:'access'};
    var client=window.GDCoursePackageClient;
    if(!client||typeof client.fetchPackage!=='function')return {ok:false,reason:'offline'};
    var pkg=await client.fetchPackage({
      courseId:entry.courseId,
      courseName:entry.courseName,
      courseLat:entry.courseLat,
      courseLng:entry.courseLng
    });
    var mapType=mapTypeForPackage(pkg);
    if(!mapType)return {ok:false,reason:'not-ready'};
    try{
      var raw=JSON.parse(localStorage.getItem(DOWNLOADED_COURSE_LIBRARY_KEY)||'{}')||{};
      var body=JSON.stringify(pkg);
      raw[entry.courseId]={
        courseId:entry.courseId,
        courseName:entry.courseName||entry.courseId,
        mapType:mapType,
        /* pkg.objectsVersion, NOT pkg.geometryVersion - see
           downloadedEntryHasUpdate below for why those are not the same thing. */
        objectsVersion:pkg.objectsVersion||null,
        mapVersion:Number.isFinite(Number(pkg.packageVersion))?Number(pkg.packageVersion):null,
        /* Written in the same shape app/js/course-store.js writes, version fields
           included - this panel is a VIEW of that store, and a record saved here without
           a bakeNumber would read as legacy to the freshness rule and flag itself stale
           forever. */
        bakeNumber:Number.isFinite(Number(pkg.bakeNumber))?Number(pkg.bakeNumber):null,
        objectsRevision:Number.isFinite(Number(pkg.objectsRevision))?Number(pkg.objectsRevision):null,
        versionLabel:pkg.versionLabel||null,
        pkg:pkg,
        savedAt:Date.now(),
        bytes:body.length
      };
      localStorage.setItem(DOWNLOADED_COURSE_LIBRARY_KEY,JSON.stringify(raw));
      return {ok:true,mapType:mapType};
    }catch(e){return {ok:false,reason:'storage'};}
  }
  /* Background freshness check against the lightweight manifest
     (fetchCourseLibraryManifest, below) - the panel opens instantly from
     what is already on the device, then a badge appears if the server turns
     out to have moved on. Delegates to app.courseVersions.isStale(), the same
     rule /app/'s in-round update bar uses, since it is answering the same
     question and a second copy of it would drift. */
  let courseLibraryManifestById=null;
  function downloadedEntryHasUpdate(entry){
    const remote=courseLibraryManifestById&&courseLibraryManifestById[entry.courseId];
    if(!remote)return false;
    /* The rule itself lives in app/js/course-versions.js, loaded by both shells.
       If it is absent the honest answer is "we do not know", and an unproven
       badge is the exact bug this is fixing - so say nothing. */
    const shared=window.ClarityApp&&window.ClarityApp.courseVersions;
    if(!shared||typeof shared.isStale!=='function')return false;
    return shared.isStale(entry,{objectsVersion:remote.objects_version,mapVersion:remote.clarity_map_version,bakeNumber:remote.bake_number});
  }
  /* The version the SERVER is offering - what an "Update Available (v1.5)" badge names.
     Straight off the manifest row; the server owns the scheme
     (scripts/gd-course-version-label.js) and this panel must not re-derive it. */
  function downloadedEntryRemoteLabel(entry){
    const remote=courseLibraryManifestById&&courseLibraryManifestById[entry.courseId];
    return remote&&typeof remote.version_label==='string'?remote.version_label:'';
  }
  /* The version of the copy ON THIS DEVICE. Stored at download time rather than derived
     now, so the panel names what is actually held even with no network - which is the
     whole point of a downloads screen. */
  function downloadedEntryLabel(entry){
    return entry&&typeof entry.versionLabel==='string'?entry.versionLabel:'';
  }
  /* Punctuation comes from the shared core so this badge and the /app/ update bar cannot
     say the same thing two ways. Guarded like downloadedEntryHasUpdate above it: if the
     file did not load, the badge still appears - it just cannot name a version. */
  function updateBadgeText(entry){
    const label=downloadedEntryRemoteLabel(entry);
    const shared=window.ClarityApp&&window.ClarityApp.courseVersionLabel;
    if(!shared||typeof shared.updateAvailable!=='function')return i18nT('mapUpdate.updateAvailable');
    return shared.updateAvailable(label);
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
  function sizeLabel(bytes){
    if(!(bytes>0))return i18nT('course.sizeKb',{n:0});
    if(bytes<1024)return i18nT('course.sizeBytes',{n:bytes});
    if(bytes<1048576)return i18nT('course.sizeKb',{n:Math.round(bytes/1024)});
    return i18nT('course.sizeMb',{n:(bytes/1048576).toFixed(1)});
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
    if(title)title.textContent=i18nT('course.libraryTitle');
    if(sub)sub.textContent=i18nT('course.librarySubtitle');
    const search=document.getElementById('gdCourseLibrarySearchInput');
    if(search&&search.value!==courseLibraryFilter)search.value=courseLibraryFilter;
    const filter=normalizeCourseName(courseLibraryFilter);
    const entries=downloadedCourseEntries()
      .filter(e=>!filter||normalizeCourseName(e.courseName).includes(filter))
      .sort((a,b)=>String(a.courseName).localeCompare(String(b.courseName)));
    if(!entries.length){
      list.innerHTML=`<div class="gdCourseCard"><strong>${filter?i18nH('course.noMatching'):i18nH('course.noneDownloadedYet')}</strong><span>${filter?i18nH('course.tryAnotherSearch'):i18nH(hasOfflineCourseAccess()?'course.downloadAutomatically':'course.offlineMembership')}</span></div>`;
      return;
    }
    if(detailKey){
      const entry=entries.find(e=>e.courseId===detailKey)||downloadedCourseEntries().find(e=>e.courseId===detailKey);
      if(!entry){renderCourseLibraryPanel();return;}
      const stale=downloadedEntryHasUpdate(entry);
      const updateAction=stale?`<button type="button" data-action="update" class="gdCourseUpdateBtn">${i18nH('course.updateMap')}</button>`:'';
      const heldLabel=downloadedEntryLabel(entry);
      const offeredLabel=downloadedEntryRemoteLabel(entry);
      /* Version in the subtext beside map type and size. Omitted entirely when unknown -
         a course downloaded before versions existed shows the line it always showed
         rather than an empty pair of brackets. */
      const detailSub=[mapTypeLabel(entry.mapType),sizeLabel(entry.bytes)].concat(heldLabel?[heldLabel]:[]).join(' · ');
      list.innerHTML=`<div class="gdCourseCard${entry.mapType==='published'?' published':''}"><strong>${esc(entry.courseName)}</strong><span>${esc(detailSub)}</span><div class="gdCourseActions"><button type="button" data-action="back">${i18nH('common.back')}</button>${updateAction}<button class="danger" type="button" data-action="remove">${i18nH('course.removeFromDevice')}</button></div></div>`;
      const facts=[
        [i18nT('course.mapType'),mapTypeLabel(entry.mapType)],
        [i18nT('course.storageUsed'),sizeLabel(entry.bytes)],
        [i18nT('course.downloaded'),entry.savedAt?dateLabel(entry.savedAt):'—'],
        /* Two versions, not one: the copy you are holding, and - when they differ - the
           one the server has. "v1.4 → v1.5" says what an update would actually do. */
        [i18nT('course.version'),heldLabel?(stale&&offeredLabel&&offeredLabel!==heldLabel?heldLabel+' → '+offeredLabel:heldLabel):'—'],
        [i18nT('course.status'),stale?updateBadgeText(entry):i18nT('course.upToDate')]
      ];
      list.insertAdjacentHTML('beforeend',`<div class="gdCourseCard gdCourseStorageFacts">${facts.map(([k,v])=>`<div class="gdCourseStorageRow"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')}</div>`);
      list.querySelector('[data-action="back"]').onclick=()=>renderCourseLibraryPanel();
      const updateBtn=list.querySelector('[data-action="update"]');
      if(updateBtn)updateBtn.onclick=async()=>{
        if(updateBtn.disabled)return;
        updateBtn.disabled=true;
        updateBtn.textContent=i18nT('mapUpdate.updating');
        const result=await updateDownloadedCourseEntry(entry);
        if(result.ok){
          /* Re-check freshness against the server rather than assuming the
             download cleared it - if the manifest has moved on again the badge
             should stay, and saying "done" when it has not would be a lie. */
          courseLibraryManifestById=null;
          refreshCourseLibraryManifest();
          gdCLRefreshProfileCard();
          renderCourseLibraryPanel(entry.courseId);
          toastSafe(i18nT('course.mapUpdated'));
          return;
        }
        updateBtn.disabled=false;
        updateBtn.textContent=i18nT('course.updateMap');
        if(result.reason==='access'){
          if(window.ClarityPayments&&typeof window.ClarityPayments.requireAccess==='function')window.ClarityPayments.requireAccess('offlineCourse');
          else toastSafe(i18nT('course.offlineMembership'));
          return;
        }
        toastSafe(result.reason==='not-ready'?i18nT('course.noNewerMap')
          :result.reason==='storage'?i18nT('course.notEnoughSpace')
          :i18nT('course.couldNotReachServer'));
      };
      const removeBtn=list.querySelector('[data-action="remove"]');
      /* Two taps rather than confirm(): this shell has already been seen to throw
         "prompt() is not supported", and a dialog that never appears would either
         block the delete or, worse, fall through to it. */
      let armed=false;
      removeBtn.onclick=()=>{
        if(!armed){
          armed=true;
          removeBtn.textContent=i18nT('course.tapAgainToRemove');
          setTimeout(()=>{if(armed){armed=false;removeBtn.textContent=i18nT('course.removeFromDevice');}},4000);
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
      /* The version leads the subtext: on a list of downloaded courses it is the one
         fact that says WHICH copy this is, and size/date only say how big and how old. */
      const meta=[downloadedEntryLabel(entry),sizeLabel(entry.bytes),entry.savedAt?dateLabel(entry.savedAt):null].filter(Boolean).join(' · ');
      const typeBadge=`<span class="${entry.mapType==='published'?'gdSavedGreenBadge':'gdCourseObjectBadge'}">${esc(mapTypeLabel(entry.mapType))}</span>`;
      const updateBadge=stale?`<span class="gdCourseObjectBadge">${esc(updateBadgeText(entry))}</span>`:'';
      card.innerHTML=`<strong>${esc(entry.courseName)}</strong><span>${esc(meta)}${typeBadge}${updateBadge}</span>`;
      card.onclick=()=>renderCourseLibraryPanel(entry.courseId);
      list.appendChild(card);
    });
  }
  window.renderCourseLibraryPanel=renderCourseLibraryPanel;
  window.openCourseLibraryPanel=function(){
    try{if(window.GDI18n&&!window.__gdCourseLibraryI18n){window.__gdCourseLibraryI18n=true;window.GDI18n.onChange(()=>{const o=document.getElementById('gdCourseLibraryOverlay');if(o&&!o.classList.contains('hidden'))renderCourseLibraryPanel(courseLibraryDetailKey);gdCLRefreshProfileCard();});}}catch(e){}
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
     can both ask within the same window, and without this both would fetch the
     same courses twice for one result. The shared promise
     resolves to {store,error} so each caller still applies its own
     throwOnError rather than inheriting another caller's error handling. */
  /* Mirrors PLAY_SUBSET_MAX in functions/course-maps.mjs: longer lists go in
     batches of this size. */
  const PUBLISHED_SUBSET_SYNC_MAX=24;
  /* The named courses in play scope, or null when the server did not answer a
     subset - an older server answers the whole library to this URL, and that
     must not be merged as if it were the subset, so nothing merges.

     A request that FAILS is thrown, exactly as the full pull throws, and is
     never followed by a second pull: one failed request must not become two
     during an outage, the amplification that kept the database down on 18 Sep
     2026. Nothing merges and the store stands. */
  async function fetchPublishedCourseSubset(courseIds){
    const res=await fetch(PUBLISHED_COURSE_API+'?scope=play&courseIds='+encodeURIComponent(courseIds.join(',')),{headers:{Accept:'application/json'},cache:'no-store'});
    if(!res.ok){
      const error=new Error(`Course map lookup failed (${res.status})`);
      error.status=res.status;
      throw error;
    }
    const data=await res.json();
    if(!data||data.partial!==true||!data.courses)return null;
    /* A subset's updatedAt is the newest of ITS rows, which may be older than
       what the store already holds; the store's stamp must not go backwards. */
    const held=String(loadPublishedStore().updatedAt||'');
    if(held&&(!data.updatedAt||String(data.updatedAt)<held))data.updatedAt=held;
    return data;
  }
  let publishedSyncInFlight=null;
  async function syncPublishedCourseMaps(opts={}){
    if(opts.force!==true&&publishedSyncInFlight){
      const shared=await publishedSyncInFlight;
      /* A run already going only answers a caller with no course of its own -
         the startup refresh never fetches the course being opened. */
      if(!uniqueSlugs(opts.courseIds).length){
        if(shared.error&&opts.throwOnError)throw shared.error;
        return shared.store;
      }
    }
    const run=(async function(){
      if(window.GDCourseStorage)await window.GDCourseStorage.ready;
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
     silently receive a stale store instead.

     The device holds the courses the player has OPENED, not the whole published
     library. It used to treat every course in the database as "missing" and pull
     them all (~12 MB, and growing with every course mapped), which is most of what
     filled a phone's storage on 6 Oct 2026 - a golfer in New Zealand carrying every
     course in Wales. Now a sync refreshes only:
       - courses already held whose server version moved on (stale), and
       - the courses this caller is opening (opts.courseIds), when not held yet
         or when opts.force asks to re-read them anyway.
     Never the whole library. The picker's own search reads the server directly,
     so nothing here needs every course on the device. */
  async function runPublishedCourseMapSync(opts={}){
    if(typeof fetch!=='function')return loadPublishedStore();
    pruneUnopenedPublishedCourses(opts.courseIds);
    const requested=uniqueSlugs(opts.courseIds);
    const manifest=await fetchCourseLibraryManifest();
    const freshness=courseLibraryFreshness(manifest);
    let wanted;
    if(freshness.checked){
      /* Only ids the server actually publishes - a name-derived key that is not a
         course id would otherwise be asked for on every open. */
      wanted=freshness.stale.concat(requested.filter(id=>
        freshness.missing.includes(id)||(opts.force===true&&freshness.current.includes(id))));
    }else{
      /* Manifest unreachable: no conclusion about what is stale, but the course
         being opened is still worth asking for by name. */
      wanted=requested;
    }
    wanted=uniqueSlugs(wanted);
    let store=loadPublishedStore();
    for(let i=0;i<wanted.length;i+=PUBLISHED_SUBSET_SYNC_MAX){
      const subset=await fetchPublishedCourseSubset(wanted.slice(i,i+PUBLISHED_SUBSET_SYNC_MAX));
      if(subset)store=mergePublishedStore(subset);
    }
    try{renderCourseLibraryPanel();}catch(e){}
    return store;
  }
  function uniqueSlugs(values){
    const out=[];
    (Array.isArray(values)?values:[]).forEach(value=>{
      const key=slug(value||'');
      if(key&&!out.includes(key))out.push(key);
    });
    return out;
  }
  /* One-off for devices that already pulled the whole library: keep only courses
     the player has a record of opening (their own library, or a course downloaded
     for offline play) plus whatever is being opened right now. Anything dropped
     comes back by id the next time it is opened. Marked so it runs once. */
  function pruneUnopenedPublishedCourses(keepIds){
    const store=loadPublishedStore();
    if(store.scope==='opened')return;
    const keep=new Set(uniqueSlugs(keepIds));
    Object.values(loadStore().courses||{}).forEach(course=>{
      const key=slug(course&&course.courseId||'');
      if(key)keep.add(key);
    });
    downloadedCourseEntries().forEach(entry=>{
      const key=slug(entry&&entry.courseId||'');
      if(key)keep.add(key);
    });
    const courses={};
    Object.keys(store.courses||{}).forEach(id=>{
      const course=store.courses[id];
      if(keep.has(slug(course&&(course.courseId||course.id)||'')))courses[id]=course;
    });
    store.courses=courses;
    store.scope='opened';
    savePublishedStore(store);
  }
  window.gdCLSyncPublishedCourseMaps=syncPublishedCourseMaps;
  /* The course as this shell sees it right now - disk, session package data and the
     published copy merged - for tests and on-device diagnosis. */
  window.gdCLSessionCourse=function(cid){return loadUserCourseData(userId(),cid);};
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
        toastSafe(i18nT('course.findOrChange'));
      }catch(e){}
    },100);
  };



  function install(){
    observeProfile();
    setTimeout(gdCLInjectProfileCourseCard,300);
    setTimeout(()=>syncPublishedCourseMaps({quiet:true}),520);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();
