/* Clarity Caddie Arcade Mode wiring.
   Structure first: mapped-course provider -> route adapter -> controller -> swing view -> shot renderer. */
(function(){
  "use strict";

  var VERSION="arcade-wiring-20260607";
  var STORE_KEYS=["gd_user_course_library_v1","gd_published_course_library_v1"];
  var ROOT_ID="gdArcadeOverlay";
  var MAX_PULL_PX=104;
  var IDEAL_PULL_SPEED=0.48;

  var state={
    active:false,
    playing:false,
    payload:null,
    ball:null,
    strokes:0,
    lastPlan:null,
    lastFeedback:"",
    drag:null,
    coursePlay:null
  };

  function safe(fn,fallback){
    try{return fn();}catch(e){return fallback;}
  }

  function byId(id){return document.getElementById(id);}

  function clamp(value,min,max){
    var n=Number(value);
    if(!Number.isFinite(n))n=0;
    return Math.max(min,Math.min(max,n));
  }

  function round(value,places){
    var p=Math.pow(10,places||0);
    return Math.round((Number(value)||0)*p)/p;
  }

  function slug(value){
    return String(value||"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"";
  }

  function cleanCourseIdentity(value){
    return slug(String(value||"").replace(/\b(golf club|golf course|country club|gc|course|club|cub)\b/gi," ").replace(/\s+/g," ").trim());
  }

  function readJson(key,fallback){
    try{return JSON.parse(localStorage.getItem(key)||"null")||fallback;}catch(e){return fallback;}
  }

  function objectValues(value){
    if(!value||typeof value!=="object")return [];
    if(Array.isArray(value))return value;
    return Object.values(value);
  }

  function latLng(value){
    if(!value)return null;
    var lat=Number(value.lat??value.latitude);
    var lng=Number(value.lng??value.lon??value.longitude);
    if(!Number.isFinite(lat)||!Number.isFinite(lng))return null;
    return safe(function(){return L.latLng(lat,lng);},{lat:lat,lng:lng});
  }

  function plain(value){
    var ll=latLng(value);
    return ll?{lat:Number(ll.lat),lng:Number(ll.lng)}:null;
  }

  function distanceM(a,b){
    var aa=latLng(a),bb=latLng(b);
    if(!aa||!bb)return Infinity;
    return safe(function(){
      if(typeof map!=="undefined"&&map&&typeof map.distance==="function")return map.distance(aa,bb);
      var R=6371000;
      var toRad=function(n){return Number(n)*Math.PI/180;};
      var dLat=toRad(bb.lat-aa.lat);
      var dLng=toRad(bb.lng-aa.lng);
      var s=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(toRad(aa.lat))*Math.cos(toRad(bb.lat))*Math.sin(dLng/2)*Math.sin(dLng/2);
      return 2*R*Math.atan2(Math.sqrt(s),Math.sqrt(1-s));
    },Infinity);
  }

  function bearingRad(a,b){
    var aa=latLng(a),bb=latLng(b);
    if(!aa||!bb)return 0;
    return safe(function(){
      if(typeof bearing==="function")return bearing(aa,bb);
      return Math.atan2(bb.lng-aa.lng,bb.lat-aa.lat);
    },0);
  }

  function projectPoint(origin,angle,metres){
    var o=latLng(origin);
    if(!o)return null;
    return safe(function(){
      if(typeof project==="function")return project(o,angle,metres);
      var earth=111320;
      return L.latLng(
        o.lat+(Math.cos(angle)*metres)/earth,
        o.lng+(Math.sin(angle)*metres)/(earth*Math.cos(o.lat*Math.PI/180))
      );
    },null);
  }

  function offsetPoint(origin,angle,forwardM,sideM){
    var o=latLng(origin);
    if(!o)return null;
    return safe(function(){
      if(typeof projectOffset==="function")return projectOffset(o,angle,forwardM,sideM);
      var base=projectPoint(o,angle,forwardM);
      return base?projectPoint(base,angle+Math.PI/2,sideM):null;
    },null);
  }

  function routeLength(route){
    var pts=(route||[]).map(latLng).filter(Boolean);
    var total=0;
    for(var i=1;i<pts.length;i++)total+=distanceM(pts[i-1],pts[i]);
    return total;
  }

  function currentCourseFromApp(){
    return safe(function(){
      if(typeof window.gdActiveCourseForMode==="function"){
        var modeCourse=window.gdActiveCourseForMode();
        if(modeCourse&&(modeCourse.name||modeCourse.courseName||modeCourse.courseId||modeCourse.id))return modeCourse;
      }
      var stored=readJson("gd_active_course_v1",null);
      if(stored&&(stored.name||stored.courseName||stored.courseId||stored.id))return stored;
      if(window.gdActiveCourse&&(window.gdActiveCourse.name||window.gdActiveCourse.courseName))return window.gdActiveCourse;
      if(window.currentCourse&&(window.currentCourse.name||window.currentCourse.courseName))return window.currentCourse;
      if(typeof currentCourse!=="undefined"&&currentCourse&&(currentCourse.name||currentCourse.courseName))return currentCourse;
      var label=String(byId("courseLine")?.textContent||"").trim();
      return label?{name:label,courseName:label}:null;
    },null);
  }

  function currentHoleFromApp(ctx){
    var raw=ctx&&ctx.hole;
    if(!raw)raw=safe(function(){return currentPlayingHole||selectedHole;},null);
    if(!raw)raw=safe(function(){return sessionStorage.getItem("gd_active_playing_hole")||sessionStorage.getItem("gd_mapper_active_hole");},null);
    var h=Number(raw||1);
    return Number.isFinite(h)&&h>=1&&h<=36?Math.round(h):1;
  }

  function courseName(course){
    return String(course?.name||course?.courseName||course?.clubName||"").trim();
  }

  function courseId(course){
    return String(course?.courseId||course?.id||slug(courseName(course))||"course").trim();
  }

  function courseMatches(source,probe){
    if(!source||!probe)return false;
    var sourceIds=[source.courseId,source.id,source.name,source.courseName].map(slug).filter(Boolean);
    var probeIds=[probe.courseId,probe.id,probe.name,probe.courseName].map(slug).filter(Boolean);
    if(sourceIds.some(function(id){return probeIds.includes(id);}))return true;
    var sourceNames=[source.name,source.courseName].map(cleanCourseIdentity).filter(Boolean);
    var probeNames=[probe.name,probe.courseName].map(cleanCourseIdentity).filter(Boolean);
    return sourceNames.some(function(name){return probeNames.includes(name);});
  }

  function mappedHolePlayData(course,hole){
    return safe(function(){
      var api=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
      var fn=api.mappedHolePlayData||window.gdMappedHolePlayData;
      return typeof fn==="function"?fn(course,hole):null;
    },null);
  }

  function storedCourseCandidates(course){
    var candidates=[];
    STORE_KEYS.forEach(function(key){
      var store=readJson(key,null);
      objectValues(store&&store.courses).forEach(function(item){
        if(item&&courseMatches(item,course))candidates.push(item);
      });
    });
    return candidates;
  }

  function loadMappedCourseData(course,hole){
    var api=window.GolfDaddyCourseLibrary||window.ClarityCaddieCourseLibrary||{};
    var candidates=[];
    var active=safe(function(){return api.loadUserCourseData&&api.loadUserCourseData();},null);
    if(active)candidates.push(active);
    if(course)candidates.push(course);
    candidates=candidates.concat(storedCourseCandidates(course));
    var first=null;
    for(var i=0;i<candidates.length;i++){
      var data=mappedHolePlayData(candidates[i],hole);
      if(data&&!first)first=candidates[i];
      if(data&&data.complete)return candidates[i];
    }
    return first||null;
  }

  function greenRadiusFromShape(center,green,tee){
    var shape=green&&(green.greenShape||green.shape||green.polygon);
    var points=Array.isArray(shape)?shape.map(latLng).filter(Boolean):[];
    if(!points.length)return {depthM:34,widthM:25};
    var c=latLng(center);
    var angle=bearingRad(tee,center);
    var maxForward=0,maxSide=0;
    points.forEach(function(pt){
      var d=distanceM(c,pt);
      var a=bearingRad(c,pt)-angle;
      maxForward=Math.max(maxForward,Math.abs(Math.cos(a)*d));
      maxSide=Math.max(maxSide,Math.abs(Math.sin(a)*d));
    });
    return {
      depthM:Math.max(12,round(maxForward*2,1)),
      widthM:Math.max(10,round(maxSide*2,1))
    };
  }

  function scorecardInfo(hole,course){
    return safe(function(){
      var row=typeof gdScorecardHoleAt==="function"?gdScorecardHoleAt(hole,course):null;
      var view=typeof gdScorecardHoleView==="function"?gdScorecardHoleView(row):row;
      var known=typeof gdScorecardKnownNumber==="function"?gdScorecardKnownNumber:Number;
      return {
        par:known(view&&view.par),
        metres:known(view&&(view.metres||view.meters||view.distanceM))
      };
    },{par:null,metres:null});
  }

  var CourseGameProvider={
    build:function(ctx){
      if(ctx&&ctx.coursePlay)return this.fromCoursePlay(ctx.coursePlay,ctx);
      var course=(ctx&&ctx.course)||currentCourseFromApp();
      var hole=currentHoleFromApp(ctx);
      var courseData=loadMappedCourseData(course,hole);
      var mapped=mappedHolePlayData(courseData,hole);
      if(!course||!courseName(course))return {error:"Pick a mapped course first"};
      if(!mapped||!mapped.complete||!mapped.route||mapped.route.length<2)return {error:"Arcade needs mapped green and fairway data for this hole"};
      var route=mapped.route.map(latLng).filter(Boolean);
      var tee=latLng(mapped.tee&&mapped.tee.position)||route[0];
      var green=route[route.length-1]||latLng(mapped.green&&mapped.green.position);
      if(!tee||!green)return {error:"Arcade could not resolve the tee and green for this hole"};
      var info=scorecardInfo(hole,course);
      var metres=Number(info.metres)||Math.round(routeLength(route));
      var payload={
        source:"main-app-mapped-course",
        version:VERSION,
        course:course,
        courseId:courseId(course),
        courseName:courseName(course),
        holes:[{
          hole:hole,
          par:Number(info.par)||null,
          metres:metres||null,
          tee:plain(tee),
          green:plain(green),
          pin:plain(green),
          greenRadius:greenRadiusFromShape(green,mapped.green,tee),
          route:route.map(plain).filter(Boolean),
          mapped:mapped
        }]
      };
      payload.hole=payload.holes[0];
      return {payload:payload};
    },
    fromCoursePlay:function(data,ctx){
      if(!data||typeof data!=="object")return {error:"Arcade course data was empty"};
      var hole=(Array.isArray(data.holes)?data.holes[0]:data.hole)||null;
      if(!hole||!latLng(hole.tee)||!latLng(hole.green))return {error:"Arcade course data needs tee and green"};
      var course=(ctx&&ctx.course)||data.course||currentCourseFromApp()||{name:data.courseName,courseId:data.courseId};
      var payload={
        source:data.source||"course-play-bridge",
        version:VERSION,
        course:course,
        courseId:data.courseId||courseId(course),
        courseName:data.courseName||courseName(course),
        holes:[{
          hole:Number(hole.hole)||currentHoleFromApp(ctx),
          par:Number(hole.par)||null,
          metres:Number(hole.metres||hole.meters)||null,
          tee:plain(hole.tee),
          green:plain(hole.green),
          pin:plain(hole.pin)||plain(hole.green),
          greenRadius:hole.greenRadius||{depthM:34,widthM:25},
          route:(hole.route||[hole.tee,hole.green]).map(plain).filter(Boolean),
          mapped:hole.mapped||null
        }]
      };
      payload.hole=payload.holes[0];
      return {payload:payload};
    }
  };

  function gpsScreenOpen(){
    return !!(
      document.body.classList.contains("shell-gps")||
      document.body.classList.contains("gdGpsActive")||
      document.body.classList.contains("gps-active")
    )&&!document.body.classList.contains("shell-home")&&!document.body.classList.contains("shell-module");
  }

  function activeAppShot(payload){
    return safe(function(){
      var shotHole=Number(currentPlayingHole||selectedHole||sessionStorage.getItem("gd_active_playing_hole")||0);
      var payloadHole=Number(payload&&payload.hole&&payload.hole.hole);
      if(payloadHole&&shotHole&&payloadHole!==shotHole)return null;
      var startLL=typeof start!=="undefined"?latLng(start):null;
      var targetLL=typeof target!=="undefined"?latLng(target):null;
      var greenLL=typeof greenCentre!=="undefined"?latLng(greenCentre):null;
      if(!startLL||!targetLL)return null;
      return {start:startLL,target:targetLL,green:greenLL,locked:!!safe(function(){return lockedFrame;},false)};
    },null);
  }

  var GameRouteAdapter={
    enter:function(payload,ball,opts){
      opts=opts||{};
      document.body.classList.add("gdArcadeMode","gdArcadeRouteLocked");
      document.body.dataset.gdArcadeMode="active";
      safe(function(){localStorage.setItem("gd_active_course_v1",JSON.stringify(payload.course||{name:payload.courseName,courseId:payload.courseId}));});
      safe(function(){if(typeof window.gdRememberPlayingHole==="function")window.gdRememberPlayingHole(payload.hole.hole);});
      safe(function(){currentPlayingHole=payload.hole.hole;selectedHole=payload.hole.hole;});
      safe(function(){
        if(typeof gdEnsureScorecardForCourse==="function")gdEnsureScorecardForCourse(payload.course||{name:payload.courseName});
      });
      safe(function(){if(!gpsScreenOpen()&&typeof enterGpsModule==="function")enterGpsModule({replace:true,fromArcade:true,preserveState:true});});
      safe(function(){
        if(typeof setHole==="function")setHole(payload.hole.par?{hole:payload.hole.hole,par:payload.hole.par}:{hole:payload.hole.hole});
      });
      if(opts.preserveActiveShot&&activeAppShot(payload)){
        safe(function(){if(typeof hideHint==="function")hideHint();});
        safe(function(){if(typeof setState==="function")setState("Arcade H"+payload.hole.hole);});
        safe(function(){if(typeof renderShot==="function")renderShot();});
      }else{
        this.lockShot(payload,ball||payload.hole.tee,"arcade-enter");
      }
      safe(function(){if(typeof toast==="function")toast("Arcade ready");});
      safe(function(){if(typeof window.gdSyncArcadeEntry==="function")setTimeout(window.gdSyncArcadeEntry,80);});
    },
    lockShot:function(payload,ball,reason){
      var startLL=latLng(ball);
      var greenLL=latLng(payload.hole.green);
      var pinLL=latLng(payload.hole.pin)||greenLL;
      if(!startLL||!greenLL)return false;
      safe(function(){if(typeof resetPlay==="function")resetPlay(false);});
      safe(function(){if(typeof setStart==="function")setStart(startLL,false);});
      var locked=false;
      safe(function(){
        if(reason!=="arcade-enter"&&typeof window.gdLockMappedGreenFromStart==="function"){
          locked=!!window.gdLockMappedGreenFromStart(startLL,"arcade-virtual-gps");
        }
      });
      if(!locked){
        safe(function(){if(typeof setGreenTarget==="function")setGreenTarget(greenLL,true);});
        safe(function(){if(pinLL&&typeof placePin==="function")placePin(pinLL);});
      }
      safe(function(){if(typeof hideHint==="function")hideHint();});
      safe(function(){if(typeof setState==="function")setState("Arcade H"+payload.hole.hole);});
      safe(function(){if(typeof renderShot==="function")renderShot();});
      safe(function(){if(typeof lockFrame==="function")lockFrame(false);});
      return true;
    },
    acceptVirtualGps:function(payload,landing,detail){
      var ll=latLng(landing);
      if(!ll)return false;
      safe(function(){if(typeof window.dispatchEvent==="function")window.dispatchEvent(new CustomEvent("clarity-game-virtual-gps",{detail:detail}));});
      safe(function(){if(window.parent&&window.parent!==window)window.parent.postMessage({type:"clarity-game-virtual-gps",payload:detail},"*");});
      var moved=false;
      safe(function(){
        if(typeof gdUseNextShotPosition==="function"){
          gdUseNextShotPosition(ll,"game_mode_virtual_gps",0.8);
          moved=true;
        }
      });
      if(!moved){
        safe(function(){if(typeof setStart==="function")setStart(ll,false);});
      }
      var locked=false;
      safe(function(){
        if(typeof window.gdLockMappedGreenFromStart==="function")locked=!!window.gdLockMappedGreenFromStart(ll,"arcade-virtual-gps");
      });
      if(!locked)this.lockShot(payload,ll,"arcade-fallback-lock");
      safe(function(){if(typeof setState==="function")setState("Arcade H"+payload.hole.hole);});
      return true;
    },
    exit:function(){
      document.body.classList.remove("gdArcadeMode","gdArcadeRouteLocked","gdArcadePlaying","gdArcadeDragging");
      delete document.body.dataset.gdArcadeMode;
      safe(function(){if(typeof window.gdSyncArcadeEntry==="function")setTimeout(window.gdSyncArcadeEntry,80);});
    }
  };

  function normalizeBubble(raw,distance){
    raw=raw||{};
    var visual=raw.visual||{};
    var width=Number(raw.widthM||raw.visualWidthM||raw.clusterWidthM||visual.visualWidthM||raw.lateralRadiusM*2);
    var depth=Number(raw.depthM||raw.visualDepthM||raw.clusterDepthM||visual.visualDepthM||raw.depthRadiusM*2);
    if(!(width>0))width=clamp(distance*.13,6,36);
    if(!(depth>0))depth=clamp(distance*.18,8,52);
    return {
      widthM:width,
      depthM:depth,
      radius:Number(raw.radius)||Math.max(width,depth)/2,
      offsetDeg:Number(raw.aimOffsetDeg||raw.offsetDeg||raw.faceOffsetDeg||0)
    };
  }

  function currentShotPlan(){
    var payload=state.payload;
    if(!payload)return null;
    var ball=latLng(state.ball)||latLng(payload.hole.tee);
    var appStart=safe(function(){return typeof start!=="undefined"&&start?latLng(start):null;},null);
    if(appStart)ball=appStart;
    var targetLL=safe(function(){
      if(typeof gdShotDisplayTarget==="function")return latLng(gdShotDisplayTarget());
      return null;
    },null);
    if(!targetLL)targetLL=safe(function(){return typeof target!=="undefined"&&target?latLng(target):null;},null);
    if(!targetLL)targetLL=latLng(payload.hole.green);
    var d=distanceM(ball,targetLL);
    var core=safe(function(){return typeof getGpsBubblePayload==="function"?getGpsBubblePayload(d):null;},null)||{};
    var center=safe(function(){return typeof gdBubbleRenderCenter==="function"?latLng(gdBubbleRenderCenter(core)):null;},null)||targetLL;
    var club=String(core.club||safe(function(){return calculateShot(d).club;},null)||"GPS");
    var carry=Number(core.baseCarry||core.carryM||core.carry||d)||d;
    var total=Number(core.totalM||core.total||core.distanceM||carry)||carry;
    var green=latLng(payload.hole.green);
    return {
      ball:ball,
      target:targetLL,
      bubbleCenter:center,
      green:green,
      pin:latLng(payload.hole.pin)||green,
      distanceM:d,
      bearing:bearingRad(ball,center),
      club:{name:club,carry:carry,total:total},
      bubble:normalizeBubble(core,d),
      rawBubble:core,
      greenMode:distanceM(ball,green)<58||d<58
    };
  }

  function estimateInput(input,plan){
    var target=plan.distanceM||1;
    var total=Math.max(1,Number(plan.club.total)||target);
    var ideal=clamp(target/total,.34,1);
    var powerQuality=clamp(1-(Math.abs(input.power-ideal)/Math.max(.18,ideal*.58)),0,1);
    var tempoQuality=clamp(Number(input.tempo)||0,0,1);
    var timingQuality=clamp(Number(input.timing)||0,0,1);
    var shapePenalty=Math.min(.16,Math.abs(input.shape)*.08);
    var score=powerQuality*.56+tempoQuality*.31+timingQuality*.13-shapePenalty;
    var tier=score>.82?"great":score>.54?"pretty":"miss";
    return {idealPower:ideal,powerQuality:powerQuality,tempoQuality:tempoQuality,timingQuality:timingQuality,score:clamp(score,0,1),tier:tier};
  }

  function randomRange(min,max){return min+Math.random()*(max-min);}

  function landingFromTarget(plan,longM,sideM){
    return offsetPoint(plan.bubbleCenter,plan.bearing,longM,sideM)||plan.bubbleCenter;
  }

  function bubbleLandingPoint(plan,minRadius,maxRadius,bias){
    var theta=Math.random()*Math.PI*2;
    var radius=Math.sqrt(minRadius*minRadius+Math.random()*(maxRadius*maxRadius-minRadius*minRadius));
    var longM=Math.cos(theta)*(plan.bubble.depthM/2)*radius+(bias?.longM||0);
    var sideM=Math.sin(theta)*(plan.bubble.widthM/2)*radius+(bias?.sideM||0);
    return landingFromTarget(plan,longM,sideM);
  }

  function shortLanding(plan,forwardPct,sideM){
    var forward=clamp(plan.distanceM*forwardPct,8,Math.max(12,plan.distanceM-8));
    return offsetPoint(plan.ball,plan.bearing,forward,sideM)||plan.ball;
  }

  function randomShotOutcome(input,plan){
    var scored=estimateInput(input,plan);
    var powerBias=(input.power-scored.idealPower)*Math.max(14,plan.distanceM*.22);
    var shapeBias=input.shape*plan.bubble.widthM*.36;
    var roll=Math.random();
    if(scored.tier==="great"){
      return {
        input:scored,
        landing:roll<.58?bubbleLandingPoint(plan,0,.28,{longM:powerBias*.35,sideM:shapeBias*.25}):bubbleLandingPoint(plan,0,.86,{longM:powerBias*.42,sideM:shapeBias*.35}),
        label:Math.abs(input.shape)>.62?"Great shape":"Great",
        className:"great"
      };
    }
    if(scored.tier==="pretty"){
      return {
        input:scored,
        landing:roll<.78?bubbleLandingPoint(plan,0,1,{longM:powerBias*.6,sideM:shapeBias*.55}):bubbleLandingPoint(plan,1.02,1.22,{longM:powerBias*.72,sideM:shapeBias*.68}),
        label:roll<.78?"Pretty good":"Pretty good, edge",
        className:roll<.78?"good":"warn"
      };
    }
    if(roll<.34){
      return {
        input:scored,
        landing:shortLanding(plan,randomRange(.12,.28),randomRange(-4,4)),
        label:"Heavy",
        className:"miss"
      };
    }
    if(roll<.67){
      var side=(input.shape>=0?1:-1)*randomRange(16,34);
      return {
        input:scored,
        landing:shortLanding(plan,randomRange(.18,.40),side),
        label:"Wide",
        className:"miss"
      };
    }
    return {
      input:scored,
      landing:shortLanding(plan,randomRange(.44,.66),randomRange(-26,26)),
      label:"Offline",
      className:"miss"
    };
  }

  function parseCssOriginPart(value,size){
    var raw=String(value||"").trim();
    if(raw.endsWith("%"))return (parseFloat(raw)||0)/100*Math.max(size,1);
    var n=parseFloat(raw);
    return Number.isFinite(n)?n:size/2;
  }

  function mapLayoutRect(container){
    var parent=container.offsetParent||container.parentElement;
    var parentRect=parent&&parent.getBoundingClientRect?parent.getBoundingClientRect():{left:0,top:0};
    return {
      left:parentRect.left+(container.offsetLeft||0),
      top:parentRect.top+(container.offsetTop||0),
      width:container.offsetWidth||container.clientWidth||0,
      height:container.offsetHeight||container.clientHeight||0
    };
  }

  function mapRotationRad(container){
    var direct=safe(function(){return Number(currentMapRotation);},NaN);
    if(Number.isFinite(direct))return direct*Math.PI/180;
    return safe(function(){
      var transform=getComputedStyle(container).transform;
      var match=String(transform||"").match(/^matrix\(([^,]+),\s*([^,]+)/);
      if(!match)return 0;
      return Math.atan2(Number(match[2])||0,Number(match[1])||1);
    },0);
  }

  function transformedContainerPoint(container,point){
    var rect=mapLayoutRect(container);
    var style=getComputedStyle(container);
    var parts=String(style.transformOrigin||"50% 50%").split(/\s+/);
    var ox=parseCssOriginPart(parts[0],rect.width);
    var oy=parseCssOriginPart(parts[1],rect.height);
    var originX=rect.left+ox;
    var originY=rect.top+oy;
    var rawX=rect.left+point.x;
    var rawY=rect.top+point.y;
    var angle=mapRotationRad(container);
    var cos=Math.cos(angle);
    var sin=Math.sin(angle);
    var dx=rawX-originX;
    var dy=rawY-originY;
    return {
      x:originX+dx*cos-dy*sin,
      y:originY+dx*sin+dy*cos
    };
  }

  function screenPoint(ll){
    return safe(function(){
      var container=map.getContainer();
      var p=map.latLngToContainerPoint(latLng(ll));
      return transformedContainerPoint(container,p);
    },null);
  }

  function cubicPoint(p0,p1,p2,p3,t){
    var mt=1-t;
    return {
      x:mt*mt*mt*p0.x+3*mt*mt*t*p1.x+3*mt*t*t*p2.x+t*t*t*p3.x,
      y:mt*mt*mt*p0.y+3*mt*mt*t*p1.y+3*mt*t*t*p2.y+t*t*t*p3.y
    };
  }

  function easeOutCubic(t){return 1-Math.pow(1-t,3);}

  function emitVirtualGps(landing,plan,outcome){
    var ll=plain(landing);
    if(!ll)return null;
    var payload=state.payload;
    return {
      type:"clarity-game-virtual-gps",
      source:"main-app-arcade-mode",
      reason:"game_mode_virtual_gps",
      simulated:true,
      lat:round(ll.lat,7),
      lng:round(ll.lng,7),
      accuracyM:.8,
      gpsAccuracyM:.8,
      courseId:payload.courseId,
      courseName:payload.courseName,
      hole:payload.hole.hole,
      par:payload.hole.par,
      stroke:state.strokes,
      remainingM:round(distanceM(landing,plan.pin),1),
      shot:{
        club:plan.club.name,
        clubCarryM:round(plan.club.carry,1),
        clubTotalM:round(plan.club.total,1),
        targetDistanceM:round(plan.distanceM,1),
        bubble:{widthM:round(plan.bubble.widthM,1),depthM:round(plan.bubble.depthM,1),offsetDeg:round(plan.bubble.offsetDeg,2)},
        feedback:outcome.className,
        outcome:outcome.label,
        inputTier:outcome.input.tier,
        inputScore:round(outcome.input.score,2)
      },
      timestamp:new Date().toISOString()
    };
  }

  var ShotRenderer={
    els:null,
    ensure:function(){
      var root=ensureOverlay();
      this.els={
        trace:root.querySelector("#gdArcadeTrace"),
        ball:root.querySelector("#gdArcadeFlightBall")
      };
      return this.els;
    },
    animate:function(plan,landing,input,outcome,done){
      var els=this.ensure();
      var startPt=screenPoint(plan.ball);
      var endPt=screenPoint(landing);
      if(!startPt||!endPt){done&&done();return;}
      var lineDx=endPt.x-startPt.x;
      var lineDy=endPt.y-startPt.y;
      var lineLen=Math.max(1,Math.hypot(lineDx,lineDy));
      var normalX=-lineDy/lineLen;
      var normalY=lineDx/lineLen;
      var curve=(clamp(input.shape,-1,1)*Math.min(140,Math.max(32,lineLen*.22)))+randomRange(-16,16);
      var apex=plan.greenMode?18:clamp(distanceM(plan.ball,landing)*.26,52,150);
      var c1={
        x:startPt.x+lineDx*.32+normalX*curve*.45,
        y:startPt.y+lineDy*.32+normalY*curve*.45-apex*.62
      };
      var c2={
        x:startPt.x+lineDx*.66-normalX*curve*.62,
        y:startPt.y+lineDy*.66-normalY*curve*.62-apex
      };
      var d="M "+startPt.x.toFixed(1)+" "+startPt.y.toFixed(1)+" C "+c1.x.toFixed(1)+" "+c1.y.toFixed(1)+" "+c2.x.toFixed(1)+" "+c2.y.toFixed(1)+" "+endPt.x.toFixed(1)+" "+endPt.y.toFixed(1);
      els.trace.setAttribute("d",d);
      els.trace.classList.add("isVisible");
      els.ball.classList.add("isVisible");
      document.body.classList.add("gdArcadePlaying");
      var duration=clamp(distanceM(plan.ball,landing)*(plan.greenMode?9.5:11.2),900,3200);
      var started=performance.now();
      function frame(now){
        var t=clamp((now-started)/duration,0,1);
        var eased=easeOutCubic(t);
        var p=cubicPoint(startPt,c1,c2,endPt,eased);
        var lift=Math.sin(eased*Math.PI)*(plan.greenMode?7:28);
        var scale=1+Math.sin(eased*Math.PI)*(plan.greenMode?.08:.32);
        els.ball.style.transform="translate("+p.x.toFixed(1)+"px,"+(p.y-lift).toFixed(1)+"px) scale("+scale.toFixed(3)+")";
        if(t<1)requestAnimationFrame(frame);
        else{
          animateBounce(endPt,plan.greenMode,function(){
            document.body.classList.remove("gdArcadePlaying");
            done&&done();
          });
        }
      }
      requestAnimationFrame(frame);
    },
    clear:function(){
      var els=this.ensure();
      els.trace.classList.remove("isVisible");
      els.trace.setAttribute("d","");
      els.ball.classList.remove("isVisible");
      els.ball.style.transform="translate(-200px,-200px)";
    }
  };

  function animateBounce(point,greenMode,done){
    var ball=byId("gdArcadeFlightBall");
    var started=performance.now();
    var duration=greenMode?420:680;
    function frame(now){
      var t=clamp((now-started)/duration,0,1);
      var bounce=Math.abs(Math.sin(t*Math.PI*3))*(1-t)*(greenMode?5:20);
      ball.style.transform="translate("+point.x.toFixed(1)+"px,"+(point.y-bounce).toFixed(1)+"px) scale(1.02)";
      if(t<1)requestAnimationFrame(frame);
      else setTimeout(function(){done&&done();},180);
    }
    requestAnimationFrame(frame);
  }

  var GameController={
    launch:function(ctx){
      var result=CourseGameProvider.build(ctx||{});
      if(result.error){
        safe(function(){if(typeof toast==="function")toast(result.error);});
        return false;
      }
      this.stop(false);
      state.active=true;
      state.payload=result.payload;
      state.coursePlay=result.payload;
      var activeShot=activeAppShot(result.payload);
      state.ball=activeShot?activeShot.start:latLng(result.payload.hole.tee);
      state.strokes=0;
      state.lastFeedback="";
      ensureOverlay();
      renderOverlayHud();
      GameRouteAdapter.enter(result.payload,state.ball,{preserveActiveShot:!!activeShot});
      document.dispatchEvent(new CustomEvent("clarity-arcade-mounted",{detail:bridgeState()}));
      return false;
    },
    play:function(input){
      if(!state.active||state.playing)return false;
      var plan=currentShotPlan();
      if(!plan)return false;
      state.playing=true;
      state.strokes+=1;
      state.lastPlan=plan;
      safe(function(){if(typeof gdCaptureCurrentPlannedShot==="function")gdCaptureCurrentPlannedShot("arcade-shot");});
      var outcome=randomShotOutcome(input,plan);
      state.lastFeedback=outcome.label;
      renderOverlayHud();
      ShotRenderer.animate(plan,outcome.landing,input,outcome,function(){
        var detail=emitVirtualGps(outcome.landing,plan,outcome);
        state.ball=latLng(outcome.landing);
        GameRouteAdapter.acceptVirtualGps(state.payload,state.ball,detail);
        state.playing=false;
        renderOverlayHud();
        setTimeout(function(){ShotRenderer.clear();},650);
        document.dispatchEvent(new CustomEvent("clarity-game-shot-committed",{detail:detail}));
      });
      return true;
    },
    resetHole:function(){
      if(!state.active||!state.payload)return false;
      state.ball=latLng(state.payload.hole.tee);
      state.strokes=0;
      state.lastFeedback="";
      ShotRenderer.clear();
      GameRouteAdapter.lockShot(state.payload,state.ball,"arcade-reset");
      renderOverlayHud();
      safe(function(){if(typeof toast==="function")toast("Arcade reset");});
      return false;
    },
    stop:function(announce){
      if(!state.active&&!byId(ROOT_ID))return false;
      state.active=false;
      state.playing=false;
      state.drag=null;
      state.payload=null;
      state.ball=null;
      state.strokes=0;
      state.lastFeedback="";
      ShotRenderer.clear();
      var root=byId(ROOT_ID);
      if(root)root.hidden=true;
      GameRouteAdapter.exit();
      if(announce!==false)safe(function(){if(typeof toast==="function")toast("Arcade closed");});
      return false;
    }
  };

  function bridgeState(){
    var payload=state.payload;
    return {
      ready:!!state.active,
      source:"main-app-arcade-mode",
      courseId:payload&&payload.courseId,
      courseName:payload&&payload.courseName,
      hole:payload&&payload.hole&&payload.hole.hole,
      par:payload&&payload.hole&&payload.hole.par,
      strokes:state.strokes,
      active:state.active,
      playing:state.playing,
      virtualGps:plain(state.ball),
      version:VERSION
    };
  }

  function ensureOverlay(){
    var root=byId(ROOT_ID);
    if(root){root.hidden=false;return root;}
    root=document.createElement("div");
    root.id=ROOT_ID;
    root.innerHTML=[
      '<div class="gdArcadeFlightLayer" aria-hidden="true">',
      '<svg class="gdArcadeFlightSvg"><path class="gdArcadeTrace" id="gdArcadeTrace"></path></svg>',
      '<div class="gdArcadeBall" id="gdArcadeFlightBall"></div>',
      '</div>',
      '<div class="gdArcadeHud">',
      '<div class="gdArcadeHudInner">',
      '<div><div class="gdArcadeHudTitle"><strong>Arcade</strong><span id="gdArcadeHudTitle">Course play</span></div><div class="gdArcadeHudMeta" id="gdArcadeHudMeta">Pull the ball to swing</div></div>',
      '<div class="gdArcadeHudActions"><button class="gdArcadeIconBtn" type="button" id="gdArcadeResetBtn" title="Reset hole">R</button><button class="gdArcadeIconBtn" type="button" id="gdArcadeExitBtn" title="Exit arcade">X</button></div>',
      '</div>',
      '</div>',
      '<div class="gdArcadeSwingStage">',
      '<div class="gdArcadePullPad">',
      '<div class="gdArcadePullGhost"></div>',
      '<svg class="gdArcadeTetherSvg"><path class="gdArcadeTetherPath" id="gdArcadeTetherPath"></path></svg>',
      '<button class="gdArcadeSwingBall" type="button" id="gdArcadeSwingBall" aria-label="Arcade swing ball">Swing</button>',
      '<div class="gdArcadeMeters"><span class="gdArcadeMeter" data-tone="power"><i id="gdArcadePowerMeter"></i></span><span class="gdArcadeMeter" data-tone="shape"><i id="gdArcadeShapeMeter"></i></span></div>',
      '</div>',
      '</div>'
    ].join("");
    document.body.appendChild(root);
    root.querySelector("#gdArcadeExitBtn").addEventListener("click",function(ev){ev.preventDefault();GameController.stop(true);});
    root.querySelector("#gdArcadeResetBtn").addEventListener("click",function(ev){ev.preventDefault();GameController.resetHole();});
    installSwingInput(root.querySelector("#gdArcadeSwingBall"));
    return root;
  }

  function renderOverlayHud(){
    var payload=state.payload;
    var title=byId("gdArcadeHudTitle");
    var meta=byId("gdArcadeHudMeta");
    if(!payload){
      if(title)title.textContent="Course play";
      if(meta)meta.textContent="Pull the ball to swing";
      return;
    }
    var plan=currentShotPlan();
    if(title)title.textContent=payload.courseName+" H"+payload.hole.hole;
    if(meta){
      var parts=[];
      parts.push("Shot "+Math.max(1,state.strokes+1));
      if(plan)parts.push((plan.club.name||"Club")+" "+Math.round(plan.distanceM)+"m");
      if(state.lastFeedback)parts.push(state.lastFeedback);
      meta.textContent=parts.join(" · ");
    }
  }

  function installSwingInput(ball){
    if(!ball||ball.__gdArcadeSwingInstalled)return;
    ball.__gdArcadeSwingInstalled=true;
    ball.addEventListener("pointerdown",function(ev){
      if(!state.active||state.playing)return;
      if(ev.button!=null&&ev.button!==0)return;
      ev.preventDefault();
      ev.stopPropagation();
      var rect=ball.getBoundingClientRect();
      state.drag={
        id:ev.pointerId,
        originX:rect.left+rect.width/2,
        originY:rect.top+rect.height/2,
        started:performance.now(),
        power:0,
        shape:0,
        samples:[]
      };
      document.body.classList.add("gdArcadeDragging");
      safe(function(){if(map&&map.dragging&&map.dragging.disable)map.dragging.disable();});
      safe(function(){ball.setPointerCapture(ev.pointerId);});
      updateSwingDrag(ev);
    },{passive:false});
    ball.addEventListener("pointermove",function(ev){
      if(!state.drag||state.drag.id!==ev.pointerId)return;
      ev.preventDefault();
      ev.stopPropagation();
      updateSwingDrag(ev);
    },{passive:false});
    function end(ev){
      if(!state.drag||state.drag.id!==ev.pointerId)return;
      ev.preventDefault();
      ev.stopPropagation();
      var input=finishSwingInput(ev);
      clearSwingDrag(ball);
      safe(function(){if(map&&map.dragging&&map.dragging.enable)map.dragging.enable();});
      safe(function(){ball.releasePointerCapture(ev.pointerId);});
      if(input.power>.08)GameController.play(input);
    }
    ball.addEventListener("pointerup",end,{passive:false});
    ball.addEventListener("pointercancel",function(ev){
      if(!state.drag||state.drag.id!==ev.pointerId)return;
      clearSwingDrag(ball);
      safe(function(){if(map&&map.dragging&&map.dragging.enable)map.dragging.enable();});
    },{passive:false});
  }

  function updateSwingDrag(ev){
    var drag=state.drag;
    if(!drag)return;
    var dx=clamp(ev.clientX-drag.originX,-118,118);
    var dy=clamp(ev.clientY-drag.originY,0,MAX_PULL_PX);
    var pull=Math.max(0,dy-Math.abs(dx)*.04);
    drag.power=clamp(pull/MAX_PULL_PX,0,1);
    drag.shape=clamp(dx/112,-1,1);
    drag.samples.push({t:performance.now(),x:ev.clientX,y:ev.clientY});
    if(drag.samples.length>8)drag.samples.shift();
    var ball=byId("gdArcadeSwingBall");
    var tether=byId("gdArcadeTetherPath");
    var power=byId("gdArcadePowerMeter");
    var shape=byId("gdArcadeShapeMeter");
    if(ball)ball.style.transform="translate("+dx.toFixed(1)+"px,"+dy.toFixed(1)+"px) scale("+(1-drag.power*.06).toFixed(3)+")";
    if(tether){
      var stage=ball&&ball.closest(".gdArcadeSwingStage");
      var sr=stage&&stage.getBoundingClientRect();
      if(sr){
        var ox=drag.originX-sr.left;
        var oy=drag.originY-sr.top;
        tether.setAttribute("d","M "+ox.toFixed(1)+" "+oy.toFixed(1)+" L "+(ox+dx).toFixed(1)+" "+(oy+dy).toFixed(1));
      }
    }
    if(power)power.style.width=(drag.power*100).toFixed(1)+"%";
    if(shape){
      var pct=Math.abs(drag.shape)*50;
      shape.style.width=pct.toFixed(1)+"%";
      shape.style.marginLeft=drag.shape<0?(50-pct).toFixed(1)+"%":"50%";
    }
  }

  function finishSwingInput(ev){
    updateSwingDrag(ev);
    var drag=state.drag||{};
    var samples=drag.samples||[];
    var speed=0;
    if(samples.length>=2){
      var first=samples[0];
      var last=samples[samples.length-1];
      var dt=Math.max(1,last.t-first.t);
      speed=Math.hypot(last.x-first.x,last.y-first.y)/dt;
    }
    var tempo=clamp(1-Math.abs(speed-IDEAL_PULL_SPEED)/IDEAL_PULL_SPEED,0,1);
    var elapsed=Math.max(1,performance.now()-(drag.started||performance.now()));
    var timing=clamp(1-Math.abs(elapsed-430)/520,0,1);
    return {
      power:clamp(drag.power||0,0,1),
      shape:clamp(drag.shape||0,-1,1),
      tempo:tempo,
      timing:timing
    };
  }

  function clearSwingDrag(ball){
    state.drag=null;
    document.body.classList.remove("gdArcadeDragging");
    ball=ball||byId("gdArcadeSwingBall");
    var tether=byId("gdArcadeTetherPath");
    var power=byId("gdArcadePowerMeter");
    var shape=byId("gdArcadeShapeMeter");
    if(ball)ball.style.transform="";
    if(tether)tether.setAttribute("d","");
    if(power)power.style.width="0%";
    if(shape){shape.style.width="0%";shape.style.marginLeft="50%";}
  }

  function launch(ctx){
    return GameController.launch(ctx||safe(function(){return window.gdArcadeEntryContext&&window.gdArcadeEntryContext();},{}));
  }

  window.gdLaunchArcadeMode=launch;
  window.gdExitArcadeMode=function(){return GameController.stop(true);};
  window.gdArcadeModeState=function(){return Object.assign({},bridgeState(),{lastPlan:state.lastPlan,lastFeedback:state.lastFeedback});};
  window.ClarityGameShot=Object.assign(window.ClarityGameShot||{},{
    mountFromCoursePlay:function(data){return GameController.launch({coursePlay:data});},
    onVirtualGps:function(){},
    state:window.gdArcadeModeState,
    exit:window.gdExitArcadeMode
  });
  document.addEventListener("clarity-arcade-entry",function(ev){launch(ev.detail||{});});
})();
