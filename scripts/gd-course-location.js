/* Course Location owner: persistent course centre / locator pin only. */
(function(){
  "use strict";

  const PICKER_PIN_STORE_KEY="gd_course_picker_course_pins_v1";
  const COURSE_LIBRARY_STORE_KEY="gd_user_course_library_v1";
  const PUBLISHED_STORE_KEY="gd_published_course_library_v1";
  const BUILT_INS=[
    {courseName:"Akarana Golf Club",courseId:"akarana-golf-club",centre:{lat:-36.9174953,lng:174.7400425},source:"built-in-course"},
    {courseName:"Maungakiekie Golf Club",courseId:"maungakiekie-golf-club",centre:{lat:-36.9229754,lng:174.7254871},source:"built-in-course",aliases:["maungakeikei","maunga"]}
  ];
  const state={initialized:false,destroyed:false,current:null,proposal:null,lastEvent:null};

  function safe(fn,fallback){try{return fn();}catch(e){return fallback;}}
  function nowIso(){return new Date().toISOString();}
  function clone(value){return safe(()=>JSON.parse(JSON.stringify(value)),value);}
  function slug(value){
    return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"course";
  }
  function cleanName(value){
    return String(value||"").toLowerCase()
      .replace(/\b(golf club|golf course|country club|links|club|course|gc|cub)\b/g," ")
      .replace(/[^a-z0-9]+/g," ")
      .replace(/\s+/g," ")
      .trim();
  }
  function courseName(course){
    return String(course?.courseName||course?.name||"Course").trim()||"Course";
  }
  function courseId(course){
    return slug(course?.courseId||course?.id||course?.savedCourseId||course?.canonicalKey||courseName(course));
  }
  function courseKey(course){
    const id=courseId(course);
    return id&&id!=="manual-gps"?id:"";
  }
  function userId(){
    const profile=safe(()=>typeof activePlayerProfile==="function"?activePlayerProfile():null,null);
    return "user-"+slug(profile?.id||profile?.name||"local-player");
  }
  function accountId(){
    const account=safe(()=>window.GolfDaddyAccounts&&typeof window.GolfDaddyAccounts.current==="function"?window.GolfDaddyAccounts.current():null,null);
    const profile=safe(()=>typeof activePlayerProfile==="function"?activePlayerProfile():null,null);
    return account?.accountId||profile?.accountId||"";
  }
  /* Null and "" are rejected BEFORE Number() sees them, because Number(null) is 0
     and Number.isFinite(0) is true - so a record with no coordinates resolved to
     {lat:0,lng:0} and every guard downstream accepted it, 0 being a perfectly
     finite number. That is what sent the Te Arai map to Null Island: setView(0,0)
     asked ArcGIS for World_Imagery tiles 131070-131073 at zoom 18, the middle of
     the Gulf of Guinea, and every one of them 404'd. One /api/course-package call
     went out with courseLat=0&courseLng=0 for the same reason.

     The server already fixed this exact bug in selectNearestLoop; this copy never
     got the same treatment, and guideCoursePoint asks GDCourseLocation FIRST, so
     the hardened finiteCoordinatePair in gd-course-library-pin-lock.js never got
     a turn. 0,0 is rejected outright as well - it is in the ocean, no golf course
     is there, and it is the signature of exactly this class of mistake. */
  function finitePoint(point){
    if(!point)return null;
    const rawLat=point.lat??point.latitude;
    const rawLng=point.lng??point.lon??point.longitude;
    if(rawLat==null||rawLat===""||rawLng==null||rawLng==="")return null;
    const lat=Number(rawLat);
    const lng=Number(rawLng);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    if(lat===0&&lng===0)return null;
    return {lat,lng};
  }
  function pointFrom(input){
    if(!input||typeof input!=="object")return null;
    return finitePoint(input.centre)||
      finitePoint(input.center)||
      finitePoint(input.courseCentre)||
      finitePoint(input.courseCenter)||
      finitePoint({lat:input.courseLat,lng:input.courseLng})||
      finitePoint({lat:input.lat??input.latitude,lng:input.lng??input.lon??input.longitude})||
      finitePoint({lat:input.finderLat??input.courseFinderLat,lng:input.finderLng??input.courseFinderLng});
  }
  function isManualCourse(course){
    return /^manual gps$/i.test(String(course?.name||course?.courseName||"").trim());
  }
  function isAssumedCourse(course){
    return /^assumed (golf )?course\b/i.test(String(course?.name||course?.courseName||"").trim());
  }
  function isRealGpsProposal(input){
    if(!input)return false;
    if(input.simulated===true)return false;
    const source=String(input.source||"").toLowerCase();
    if(/manual|tap|click|map|green-focus|pin|pretend|simulated/.test(source))return false;
    return !!finitePoint(input);
  }
  function readJson(key,fallback){
    return safe(()=>{
      const parsed=JSON.parse(localStorage.getItem(key)||"null");
      return parsed&&typeof parsed==="object"?parsed:fallback;
    },fallback);
  }
  function writeJson(key,value){
    return safe(()=>{localStorage.setItem(key,JSON.stringify(value));return true;},false);
  }
  function pickerPinStore(){return readJson(PICKER_PIN_STORE_KEY,{});}
  function writePickerPinStore(store){return writeJson(PICKER_PIN_STORE_KEY,store||{});}
  function courseLibraryStore(){
    const store=readJson(COURSE_LIBRARY_STORE_KEY,{courses:{}});
    if(!store.courses)store.courses={};
    return store;
  }
  function writeCourseLibraryStore(store){return writeJson(COURSE_LIBRARY_STORE_KEY,store||{courses:{}});}
  function publishedStore(){
    const api=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
    const fromApi=safe(()=>typeof api.loadPublishedStore==="function"?api.loadPublishedStore():null,null);
    const store=fromApi||readJson(PUBLISHED_STORE_KEY,{courses:{}});
    if(!store.courses)store.courses={};
    return store;
  }
  function namesMatch(a,b){
    const aa=cleanName(a),bb=cleanName(b);
    return !!(aa&&bb&&aa===bb);
  }
  function sameCourse(a,b){
    const aid=courseId(a),bid=courseId(b);
    if(aid&&bid&&aid===bid)return true;
    return namesMatch(courseName(a),courseName(b));
  }
  function findCourseRecord(store,course,uid=userId()){
    const cid=courseId(course);
    const exact=`${uid}::${cid}`;
    if(store.courses?.[exact])return {key:exact,course:store.courses[exact]};
    const found=Object.entries(store.courses||{}).find(([,record])=>record&&record.userId===uid&&sameCourse(record,course));
    return found?{key:found[0],course:found[1]}:{key:exact,course:null};
  }
  function findPublishedCourse(course){
    return Object.values(publishedStore().courses||{}).find(record=>record&&sameCourse(record,course))||null;
  }
  function builtInCourse(course){
    const id=courseId(course);
    const name=cleanName(courseName(course));
    return BUILT_INS.find(row=>courseId(row)===id||cleanName(row.courseName)===name||(row.aliases||[]).some(alias=>cleanName(alias)===name))||null;
  }
  function canonicalRecord(course,point,opts={}){
    const centre=finitePoint(point);
    if(!centre)return null;
    const selectedAt=opts.selectedAt||course?.selectedAt||null;
    return {
      courseId:courseId(course),
      courseName:courseName(course),
      centre,
      source:String(opts.source||course?.courseLocationSource||course?.pinSource||course?.source||"unknown"),
      confidence:Number.isFinite(Number(opts.confidence))?Number(opts.confidence):null,
      confirmed:opts.confirmed===true,
      updatedAt:opts.updatedAt||course?.courseLocationUpdatedAt||course?.finderUpdatedAt||course?.updatedAt||nowIso(),
      selectedAt,
      userId:opts.userId||course?.userId||userId(),
      accountId:opts.accountId||course?.accountId||accountId()
    };
  }
  function legacyPickerPin(course){
    const key=courseKey(course);
    if(!key)return null;
    const saved=pickerPinStore()[key];
    const point=finitePoint(saved);
    return point?canonicalRecord(course,point,{source:saved.source||"course-picker-pin",confidence:1,confirmed:true,updatedAt:saved.updatedAt||saved.pinnedAt||saved.confirmedAt}):null;
  }
  function localCourseCentre(course){
    const store=courseLibraryStore();
    const found=findCourseRecord(store,course);
    const record=found.course;
    if(!record)return null;
    const location=record.courseLocation&&typeof record.courseLocation==="object"?record.courseLocation:null;
    const locationPoint=finitePoint(location?.centre)||finitePoint(location);
    if(locationPoint)return canonicalRecord(record,locationPoint,{
      source:location.source||record.courseLocationSource||"local-course-location",
      confidence:Number.isFinite(Number(location.confidence))?Number(location.confidence):1,
      confirmed:location.confirmed!==false&&record.courseLocationConfirmed!==false,
      updatedAt:location.updatedAt||record.courseLocationUpdatedAt||record.updatedAt
    });
    const finder=finitePoint({lat:record.finderLat??record.courseFinderLat,lng:record.finderLng??record.courseFinderLng});
    if(finder)return canonicalRecord(record,finder,{source:record.finderSource||"local-course-finder",confidence:1,confirmed:true,updatedAt:record.finderUpdatedAt||record.updatedAt});
    const centre=finitePoint({lat:record.courseLat,lng:record.courseLng});
    if(centre)return canonicalRecord(record,centre,{source:record.courseLocationSource||"local-course-centre",confidence:.9,confirmed:record.courseLocationConfirmed===true,updatedAt:record.courseLocationUpdatedAt||record.updatedAt});
    return null;
  }
  function publishedCourseCentre(course){
    const record=findPublishedCourse(course);
    if(!record)return null;
    const centre=finitePoint({lat:record.courseLat,lng:record.courseLng})||finitePoint({lat:record.finderLat??record.courseFinderLat,lng:record.finderLng??record.courseFinderLng})||pointFrom(record);
    return centre?canonicalRecord(record,centre,{source:"published-course-centre",confidence:.95,confirmed:true,updatedAt:record.updatedAt||record.publishedAt,userId:"published"}):null;
  }
  function builtInCentre(course){
    const row=builtInCourse(course);
    return row?canonicalRecord(row,row.centre,{source:row.source||"built-in-course",confidence:.8,confirmed:false,updatedAt:null}):null;
  }
  function selectedCourseCentre(course){
    const point=pointFrom(course);
    if(!point)return null;
    const confirmed=course?.courseLocationConfirmed===true;
    return canonicalRecord(course,point,{
      source:course?.courseLocationSource||course?.pinSource||course?.source||"selected-course-centre",
      confidence:confirmed?1:.65,
      confirmed,
      updatedAt:course?.courseLocationUpdatedAt||course?.finderUpdatedAt||course?.updatedAt||null
    });
  }
  function proposalRecord(course,point,source,confidence){
    return canonicalRecord(course,point,{source,confidence,confirmed:false,updatedAt:nowIso()});
  }
  function resolve(course,opts={}){
    const seed=course&&typeof course==="object"?clone(course):{};
    if(!seed||isManualCourse(seed)&&!opts.allowManual)return null;
    const candidates=[
      legacyPickerPin(seed),
      publishedCourseCentre(seed),
      localCourseCentre(seed),
      builtInCentre(seed),
      selectedCourseCentre(seed)
    ].filter(Boolean);
    if(opts.pickerGps&&isRealGpsProposal(opts.pickerGps))candidates.push(proposalRecord(seed,opts.pickerGps,"picker-gps-proposal",.45));
    if(opts.mapViewport&&finitePoint(opts.mapViewport))candidates.push(proposalRecord(seed,opts.mapViewport,"map-viewport-proposal",.25));
    const selected=candidates.find(candidate=>opts.requireConfirmed?candidate.confirmed:candidate)||null;
    state.current=selected?clone(selected):state.current;
    emit("resolved",selected||{courseId:courseId(seed),courseName:courseName(seed),confirmed:false});
    return selected;
  }
  function get(course,opts={}){
    return resolve(course,Object.assign({requireConfirmed:true},opts||{}));
  }
  function attachToCourse(course,opts={}){
    const base=course&&typeof course==="object"?clone(course):{};
    const resolved=resolve(base,opts);
    if(!resolved||!resolved.centre)return base;
    const point=resolved.centre;
    return Object.assign({},base,{
      courseId:resolved.courseId||base.courseId||courseId(base),
      courseName:resolved.courseName||base.courseName||courseName(base),
      name:resolved.courseName||base.name||courseName(base),
      centre:point,
      center:point,
      courseCentre:point,
      courseCenter:point,
      courseLat:point.lat,
      courseLng:point.lng,
      lat:point.lat,
      lng:point.lng,
      finderLat:resolved.confirmed?point.lat:base.finderLat??base.courseFinderLat??null,
      finderLng:resolved.confirmed?point.lng:base.finderLng??base.courseFinderLng??null,
      courseFinderLat:resolved.confirmed?point.lat:base.courseFinderLat??base.finderLat??null,
      courseFinderLng:resolved.confirmed?point.lng:base.courseFinderLng??base.finderLng??null,
      courseLocationSource:resolved.source,
      courseLocationConfidence:resolved.confidence,
      courseLocationConfirmed:!!resolved.confirmed,
      courseLocationUpdatedAt:resolved.updatedAt||null,
      gdTrustedCoursePin:!!resolved.confirmed,
      pinnedByUser:!!(resolved.confirmed&&/pin|manual|finder|location/i.test(resolved.source))
    });
  }
  function propose(course,point,opts={}){
    const base=course&&typeof course==="object"?course:{};
    const raw=point||opts.point||opts.pickerGps||opts.mapViewport;
    const p=finitePoint(raw);
    if(!p)return null;
    const source=String(opts.source||raw.source||"course-location-proposal");
    if(opts.realGpsOnly&& !isRealGpsProposal(Object.assign({},raw,{source})))return null;
    const proposal=proposalRecord(base,p,source,Number.isFinite(Number(opts.confidence))?Number(opts.confidence):.35);
    state.proposal=proposal;
    emit("proposed",proposal);
    return proposal;
  }
  function persistLegacyPin(course,record){
    const key=courseKey(course);
    if(!key||!record?.centre)return false;
    const store=pickerPinStore();
    store[key]={
      lat:record.centre.lat,
      lng:record.centre.lng,
      courseName:record.courseName,
      pinnedAt:record.updatedAt,
      updatedAt:record.updatedAt,
      confirmed:true,
      source:record.source||"course-location-owner"
    };
    return writePickerPinStore(store);
  }
  function persistLibraryCourse(course,record){
    const store=courseLibraryStore();
    const uid=record.userId||userId();
    const found=findCourseRecord(store,course,uid);
    const key=found.key;
    const existing=found.course||{};
    const centre=record.centre;
    store.courses[key]=Object.assign({},existing,{
      id:existing.id||key,
      userId:uid,
      accountId:record.accountId||existing.accountId||accountId(),
      courseId:record.courseId||existing.courseId||courseId(course),
      courseName:record.courseName||existing.courseName||courseName(course),
      courseLat:centre.lat,
      courseLng:centre.lng,
      finderLat:centre.lat,
      finderLng:centre.lng,
      courseFinderLat:centre.lat,
      courseFinderLng:centre.lng,
      finderSource:record.source||"course-location-owner",
      finderUpdatedAt:record.updatedAt,
      courseLocation:{centre,source:record.source||"course-location-owner",confidence:record.confidence,confirmed:true,updatedAt:record.updatedAt},
      courseLocationSource:record.source||"course-location-owner",
      courseLocationConfirmed:true,
      courseLocationUpdatedAt:record.updatedAt,
      createdAt:existing.createdAt||record.updatedAt,
      updatedAt:record.updatedAt,
      holes:existing.holes||{},
      objects:existing.objects||{}
    });
    writeCourseLibraryStore(store);
    return store.courses[key];
  }
  function syncActiveCourse(course,record,removed=false){
    const active=readJson("gd_active_course_v1",null);
    if(!active||!sameCourse(active,course))return false;
    if(removed){
      ["finderLat","finderLng","courseFinderLat","courseFinderLng","courseLocation","courseLocationSource","courseLocationConfirmed","courseLocationUpdatedAt","gdTrustedCoursePin","pinnedByUser"].forEach(key=>delete active[key]);
      writeJson("gd_active_course_v1",active);
      return true;
    }
    writeJson("gd_active_course_v1",attachToCourse(active,{requireConfirmed:true}));
    return true;
  }
  function confirm(course,point,opts={}){
    const base=course&&typeof course==="object"?clone(course):{};
    const p=finitePoint(point||opts.point||state.proposal?.centre||base);
    if(!p||isManualCourse(base)&&!opts.allowManual)return null;
    const record=canonicalRecord(base,p,{
      source:opts.source||"course-location-owner",
      confidence:1,
      confirmed:true,
      updatedAt:opts.updatedAt||nowIso(),
      selectedAt:opts.selectedAt||base.selectedAt||null,
      userId:opts.userId||userId(),
      accountId:opts.accountId||accountId()
    });
    persistLegacyPin(base,record);
    record.storedCourse=persistLibraryCourse(base,record);
    syncActiveCourse(base,record,false);
    state.current=clone(record);
    state.proposal=null;
    emit("confirmed",record);
    return record;
  }
  function update(course,point,opts={}){
    return confirm(course,point,Object.assign({source:"course-location-updated"},opts||{}));
  }
  function remove(course,opts={}){
    const base=course&&typeof course==="object"?clone(course):{};
    const key=courseKey(base);
    if(key){
      const pins=pickerPinStore();
      delete pins[key];
      writePickerPinStore(pins);
    }
    const store=courseLibraryStore();
    const found=findCourseRecord(store,base,opts.userId||userId());
    const saved=found.course;
    if(saved){
      ["finderLat","finderLng","courseFinderLat","courseFinderLng","finderSource","finderUpdatedAt","courseLocation","courseLocationSource","courseLocationConfirmed","courseLocationUpdatedAt"].forEach(name=>delete saved[name]);
      saved.updatedAt=nowIso();
      store.courses[found.key]=saved;
      writeCourseLibraryStore(store);
    }
    syncActiveCourse(base,null,true);
    state.current=null;
    state.proposal=null;
    emit("removed",{courseId:courseId(base),courseName:courseName(base)});
    return true;
  }
  function emit(type,detail){
    state.lastEvent={type,detail:clone(detail),at:Date.now()};
    safe(()=>{
      if(typeof document!=="undefined"&&document.body&&document.body.dataset){
        document.body.dataset.gdCourseLocationOwner="GDCourseLocation";
        document.body.dataset.gdCourseLocationEvent=type;
        if(detail?.source)document.body.dataset.gdCourseLocationSource=String(detail.source);
        if(detail&&detail.confirmed!==undefined)document.body.dataset.gdCourseLocationConfirmed=detail.confirmed?"yes":"no";
      }
      if(typeof window!=="undefined"&&typeof CustomEvent==="function")window.dispatchEvent(new CustomEvent("gd-course-location",{detail:state.lastEvent}));
    },null);
  }
  function init(){
    state.initialized=true;
    state.destroyed=false;
    emit("initialized",{owner:"GDCourseLocation"});
    return true;
  }
  function destroy(){
    state.destroyed=true;
    state.current=null;
    state.proposal=null;
    emit("destroyed",{owner:"GDCourseLocation"});
    return true;
  }
  function getState(){
    return clone(state);
  }

  const api={init,normalize:function(input,opts={}){return canonicalRecord(input,pointFrom(input),opts);},resolve,get,propose,confirm,update,remove,attachToCourse,getState,destroy};
  window.GDCourseLocation=api;
  init();
})();
