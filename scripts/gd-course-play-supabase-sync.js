(function(){
  "use strict";
  // Clarity Caddie — course play Supabase sync transport.
  //
  // The GPS auto mapper (gd-course-library-pin-lock.js) maps every hole on
  // first course load. gd-course-play-pipeline.js already extracts that
  // mapped geometry into its local store and records debug events when the
  // extraction finishes. This module is ONLY the transport: it listens for
  // those "ingest finished" events, enqueues the pipeline's own sync
  // envelope, and flushes the pipeline sync queue to /api/course-play-sync
  // (Supabase). It never touches the mapping system or pipeline internals.
  if(window.GDCoursePlaySupabaseSync&&window.GDCoursePlaySupabaseSync.version)return;

  var VERSION=1;
  var ENDPOINT="/api/course-play-sync";
  var SIGNATURE_KEY="gd_course_play_supabase_sync_signatures_v1";
  var DEBOUNCE_MS=2000;
  var RETRY_BASE_MS=15000;
  var RETRY_MAX_MS=5*60*1000;
  var MAX_ATTEMPTS=8;
  var INGEST_EVENT_TYPES={
    "automapper-completed":true,
    "pipeline-course-ingested":true
  };

  var debounceTimers={};
  var flushing=false;
  var retryTimer=null;
  var retryDelay=RETRY_BASE_MS;
  var lastResult=null;

  function safe(fn,fb){try{return fn();}catch(e){return fb;}}
  function now(){return new Date().toISOString();}
  function pipeline(){return window.GDCoursePlayPipeline||null;}

  function actor(){
    var account=safe(function(){
      var api=window.GolfDaddyAccounts||window.ClarityCaddieAccounts;
      return api&&typeof api.current==="function"?api.current():null;
    },null);
    return {
      accountId:account&&(account.accountId||account.id)||"anonymous",
      email:account&&account.email||null,
      name:account&&account.name||null
    };
  }

  function loadSignatures(){
    return safe(function(){return JSON.parse(localStorage.getItem(SIGNATURE_KEY)||"{}");},null)||{};
  }
  function saveSignatures(map){
    safe(function(){localStorage.setItem(SIGNATURE_KEY,JSON.stringify(map||{}));});
  }
  function signatureFor(payload){
    // Cheap change detector over the geometry that matters.
    var holes=(payload&&payload.holes||[]).map(function(hole){
      return [
        hole.holeNumber,hole.status,
        JSON.stringify(hole.teePoint||null),
        JSON.stringify(hole.greenCentre||null),
        (hole.routePoints||[]).length,
        (hole.greenShape||[]).length,
        (hole.fairwayPoints||[]).length
      ].join(",");
    }).join("|");
    var raw=String(payload&&payload.courseId||"")+"::"+holes;
    var hash=0;
    for(var i=0;i<raw.length;i++){hash=((hash<<5)-hash+raw.charCodeAt(i))|0;}
    return String(hash)+":"+String((payload&&payload.holes||[]).length);
  }

  function courseHasGeometry(payload){
    return !!(payload&&Array.isArray(payload.holes)&&payload.holes.some(function(hole){
      return hole&&(hole.teePoint||hole.greenCentre||(hole.routePoints||[]).length>=2);
    }));
  }

  function debugEvent(type,detail){
    var api=pipeline();
    if(api&&typeof api.recordDebugEvent==="function")safe(function(){api.recordDebugEvent(type,detail);});
  }

  function scheduleCourseSync(courseId,reason){
    var api=pipeline();
    if(!api||!courseId)return;
    var key=String(courseId);
    if(debounceTimers[key])clearTimeout(debounceTimers[key]);
    debounceTimers[key]=setTimeout(function(){
      delete debounceTimers[key];
      enqueueCourse(key,reason);
    },DEBOUNCE_MS);
  }

  function enqueueCourse(courseId,reason){
    var api=pipeline();
    if(!api)return null;
    var payload=safe(function(){return api.buildCoursePlayDbPayload(courseId);},null);
    if(!payload||!courseHasGeometry(payload)){
      debugEvent("supabase-sync-skipped",{courseId:courseId,reason:"no-mapped-geometry",source:reason||"sync"});
      return null;
    }
    var signatures=loadSignatures();
    var signature=signatureFor(payload);
    if(signatures[payload.courseId]&&signatures[payload.courseId].signature===signature&&signatures[payload.courseId].synced){
      debugEvent("supabase-sync-skipped",{courseId:payload.courseId,reason:"unchanged-already-synced",source:reason||"sync"});
      return null;
    }
    var item=safe(function(){return api.enqueueCoursePlaySync(payload.courseId,{reason:reason||"mapped-geometry-ready"});},null);
    debugEvent("supabase-sync-enqueued",{courseId:payload.courseId,courseName:payload.courseName,holes:(payload.holes||[]).length,reason:reason||"mapped-geometry-ready"});
    flushSoon();
    return item;
  }

  function itemAttempts(item){
    return Math.max(Number(item&&item.attempts||0),Number(item&&item.detail&&item.detail.attempts||0));
  }
  function pendingItems(){
    var api=pipeline();
    var queue=safe(function(){return api.getCoursePlaySyncQueue();},null);
    return ((queue&&queue.items)||[]).filter(function(item){
      return item&&item.status!=="synced"&&itemAttempts(item)<MAX_ATTEMPTS;
    });
  }

  function flushSoon(){
    setTimeout(function(){flush("auto");},50);
  }

  function scheduleRetry(){
    if(retryTimer)return;
    retryTimer=setTimeout(function(){
      retryTimer=null;
      retryDelay=Math.min(retryDelay*2,RETRY_MAX_MS);
      flush("retry");
    },retryDelay);
  }

  async function postEnvelope(item){
    var response=await fetch(ENDPOINT,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        action:"upsert_course",
        actor:actor(),
        clientTime:now(),
        envelope:item.envelope
      })
    });
    var body=await response.json().catch(function(){return {};});
    if(!response.ok||body.synced===false){
      var error=new Error(body&&body.error||"Could not save course map to Supabase");
      error.status=response.status;
      error.body=body;
      throw error;
    }
    return body;
  }

  async function flush(reason){
    var api=pipeline();
    if(!api||flushing)return lastResult;
    if(typeof navigator!=="undefined"&&navigator&&navigator.onLine===false){scheduleRetry();return lastResult;}
    var items=pendingItems();
    if(!items.length)return lastResult;
    flushing=true;
    var synced=0,failed=0;
    try{
      for(var i=0;i<items.length;i++){
        var item=items[i];
        try{
          var result=await postEnvelope(item);
          api.markCoursePlaySyncQueueItem(item.queueId,"synced",{network:"supabase",savedAt:result.savedAt||now(),holes:result.holes,holesReady:result.holesReady});
          var signatures=loadSignatures();
          var payload=item.envelope&&item.envelope.payload;
          if(payload&&payload.courseId){
            signatures[payload.courseId]={signature:signatureFor(payload),synced:true,syncedAt:now(),dataVersion:payload.dataVersion};
            saveSignatures(signatures);
          }
          debugEvent("supabase-sync-saved",{courseId:item.courseId,holes:result.holes,holesReady:result.holesReady,dataVersion:result.dataVersion,reason:reason||"flush"});
          synced+=1;
        }catch(error){
          failed+=1;
          var attempts=itemAttempts(item)+1;
          safe(function(){
            api.markCoursePlaySyncQueueItem(item.queueId,"pending",{network:"supabase",lastError:error&&error.message||String(error),attempts:attempts,failedAt:now()});
          });
          debugEvent("supabase-sync-failed",{courseId:item.courseId,error:error&&error.message||String(error),status:error&&error.status||null,reason:reason||"flush"});
        }
      }
    }finally{
      flushing=false;
    }
    if(failed)scheduleRetry();
    else retryDelay=RETRY_BASE_MS;
    lastResult={at:now(),reason:reason||"flush",synced:synced,failed:failed,pending:pendingItems().length};
    return lastResult;
  }

  async function checkRemote(courseId){
    // Hook for the future "is it in the database already?" gate.
    var response=await fetch(ENDPOINT,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action:"get_course",actor:actor(),courseId:String(courseId||"")})
    });
    var body=await response.json().catch(function(){return {};});
    if(!response.ok)throw new Error(body&&body.error||"Could not check course map in Supabase");
    return body;
  }

  function onPipelineDebugEvent(event){
    var detail=event&&event.detail||{};
    var type=String(detail.type||"");
    if(!INGEST_EVENT_TYPES[type])return;
    var courseId=detail.courseId||safe(function(){
      var api=pipeline();
      var state=api&&api.getCoursePlayState&&api.getCoursePlayState(null);
      return state&&state.courseId;
    },null);
    if(courseId)scheduleCourseSync(courseId,type);
  }

  function syncActiveCourse(reason){
    var api=pipeline();
    var state=safe(function(){return api.getCoursePlayState(null);},null);
    if(state&&state.courseId&&state.courseId!=="course")scheduleCourseSync(state.courseId,reason||"manual");
  }

  window.GDCoursePlaySupabaseSync={
    version:VERSION,
    endpoint:ENDPOINT,
    enqueueCourse:enqueueCourse,
    syncActiveCourse:syncActiveCourse,
    flush:flush,
    checkRemote:checkRemote,
    pendingItems:pendingItems,
    lastResult:function(){return lastResult;}
  };

  window.addEventListener("gd-course-play-debug-event",onPipelineDebugEvent);
  window.addEventListener("online",function(){flush("online");});
  document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible")flush("visibility");
  });
  // Pick up anything queued from a previous session.
  setTimeout(function(){flush("startup");},2500);
})();
