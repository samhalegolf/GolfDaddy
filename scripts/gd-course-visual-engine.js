(function(root,factory){
  if(typeof module==="object"&&module.exports)module.exports=factory();
  else root.GDCourseVisualEngine=factory(root);
})(typeof window!=="undefined"?window:globalThis,function(root){
  "use strict";
  root=root||typeof window!=="undefined"&&window||typeof globalThis!=="undefined"&&globalThis||{};

  var VERSION=1;
  var RENDERER_VERSION="clarity-course-visual-renderer-v1";
  var STORE_KEY="gd_course_visual_engine_v1";
  var PRESET_KEY="gd_course_visual_presets_v1";
  var API_ENDPOINT="/api/course-visuals";
  var VALID_STATUSES={unavailable:1,"input-ready":1,stitching:1,"basic-ready":1,rendering:1,"preview-ready":1,published:1,failed:1};
  var inFlightBuilds={};

  function now(){return new Date().toISOString();}
  function safe(fn,fb){try{return fn();}catch(_error){return fb;}}
  function clone(value){return safe(function(){return JSON.parse(JSON.stringify(value));},value);}
  function slug(value){return String(value||"course").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,140)||"course";}
  function stableId(prefix){return String(prefix||"cv")+"_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8);}
  function text(value,limit){var out=String(value||"").trim();return limit&&out.length>limit?out.slice(0,limit):out;}
  function finite(value){var n=Number(value);return Number.isFinite(n)?n:null;}
  function point(value){
    if(!value)return null;
    var lat=finite(value.lat!==undefined?value.lat:value.latitude);
    var lng=finite(value.lng!==undefined?value.lng:(value.lon!==undefined?value.lon:value.longitude));
    return lat==null||lng==null?null:{lat:lat,lng:lng};
  }
  function points(list){return (Array.isArray(list)?list:[]).map(point).filter(Boolean);}
  function boundsFromPoints(list){
    var pts=points(list);
    if(!pts.length)return null;
    var lats=pts.map(function(p){return p.lat;});
    var lngs=pts.map(function(p){return p.lng;});
    return {south:Math.min.apply(null,lats),west:Math.min.apply(null,lngs),north:Math.max.apply(null,lats),east:Math.max.apply(null,lngs)};
  }
  function mergeBounds(list){
    var bounds=(Array.isArray(list)?list:[]).filter(validBounds);
    if(!bounds.length)return null;
    return {
      south:Math.min.apply(null,bounds.map(function(b){return b.south;})),
      west:Math.min.apply(null,bounds.map(function(b){return b.west;})),
      north:Math.max.apply(null,bounds.map(function(b){return b.north;})),
      east:Math.max.apply(null,bounds.map(function(b){return b.east;}))
    };
  }
  function validBounds(bounds){
    return !!(bounds&&Number.isFinite(Number(bounds.south))&&Number.isFinite(Number(bounds.west))&&Number.isFinite(Number(bounds.north))&&Number.isFinite(Number(bounds.east))&&Number(bounds.north)>=Number(bounds.south)&&Number(bounds.east)>=Number(bounds.west));
  }
  function escapeXml(value){
    return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function dataUrl(mime,body){return "data:"+mime+";charset=utf-8,"+encodeURIComponent(body);}
  function hashString(value){
    var str=typeof value==="string"?value:JSON.stringify(value||"");
    var hash=2166136261;
    for(var i=0;i<str.length;i++){hash^=str.charCodeAt(i);hash+=(hash<<1)+(hash<<4)+(hash<<7)+(hash<<8)+(hash<<24);}
    return ("00000000"+(hash>>>0).toString(16)).slice(-8);
  }
  function readJson(key,fb){
    if(!root||!root.localStorage)return clone(fb);
    return safe(function(){var raw=root.localStorage.getItem(key);return raw?JSON.parse(raw):clone(fb);},clone(fb));
  }
  function writeJson(key,value){
    if(root&&root.localStorage)safe(function(){root.localStorage.setItem(key,JSON.stringify(value));});
    return value;
  }
  function emptyStore(){
    return {schema:"gd.course_visual_engine.store",version:VERSION,rendererVersion:RENDERER_VERSION,updatedAt:null,records:{}};
  }
  function loadStore(){
    var store=readJson(STORE_KEY,emptyStore());
    store.schema="gd.course_visual_engine.store";
    store.version=VERSION;
    store.rendererVersion=RENDERER_VERSION;
    store.records=store.records&&typeof store.records==="object"?store.records:{};
    return store;
  }
  function saveStore(store){
    store=store&&typeof store==="object"?store:emptyStore();
    store.updatedAt=now();
    return writeJson(STORE_KEY,store);
  }
  function defaultPreset(){
    var stamp="2026-07-15T00:00:00.000Z";
    return {
      id:"clarity-course-natural-v1",
      name:"Natural",
      version:1,
      mode:"Natural",
      turf:{hueMin:86,hueMax:142,saturationMin:28,saturationMax:66,brightnessMin:30,brightnessMax:72,greenStrength:.35},
      lighting:{brightnessTarget:52,shadowFloor:14,highlightCeiling:92,contrastTarget:1.04},
      readability:{fairwaySeparation:.18,greenSeparation:.16,bunkerBrightness:.08,localContrast:.08,sharpness:.1},
      mowingVisibility:"Unknown",
      createdAt:stamp,
      updatedAt:stamp
    };
  }
  function presetForMode(mode){
    var preset=clone(defaultPreset());
    mode=String(mode||preset.mode||"Natural");
    preset.mode=mode;
    preset.name=mode;
    if(mode==="Fresh"){preset.turf.greenStrength=.48;preset.turf.saturationMin=34;preset.lighting.brightnessTarget=56;preset.readability.localContrast=.12;}
    if(mode==="Rich"){preset.turf.greenStrength=.62;preset.turf.saturationMin=40;preset.lighting.contrastTarget=1.08;preset.readability.greenSeparation=.22;}
    if(mode==="Strong"){preset.turf.greenStrength=.78;preset.turf.saturationMin=46;preset.lighting.contrastTarget=1.12;preset.readability.fairwaySeparation=.28;preset.readability.sharpness=.18;}
    preset.id="clarity-course-"+slug(mode)+"-v1";
    return preset;
  }
  function loadPresets(){
    var saved=readJson(PRESET_KEY,null);
    if(saved&&saved.presets&&saved.presets[defaultPreset().id])return saved;
    var presets={};
    ["Natural","Fresh","Rich","Strong"].forEach(function(mode){var p=presetForMode(mode);presets[p.id]=p;});
    return writeJson(PRESET_KEY,{schema:"gd.course_visual_engine.presets",version:1,defaultPresetId:defaultPreset().id,presets:presets,updatedAt:now()});
  }
  function getPreset(presetId){
    var presets=loadPresets();
    return clone(presets.presets[presetId]||presets.presets[presets.defaultPresetId]||defaultPreset());
  }
  function mergePreset(preset,overrides){
    var out=clone(preset||defaultPreset());
    function walk(target,patch){
      Object.keys(patch||{}).forEach(function(key){
        if(patch[key]&&typeof patch[key]==="object"&&!Array.isArray(patch[key])){target[key]=target[key]&&typeof target[key]==="object"?target[key]:{};walk(target[key],patch[key]);}
        else target[key]=patch[key];
      });
    }
    walk(out,overrides||{});
    return out;
  }
  function captureBounds(capture){
    if(validBounds(capture&&capture.bounds))return capture.bounds;
    var pins=capture&&capture.anchorPins||capture&&capture.pins||{};
    return boundsFromPoints([pins.tee,pins.green].concat(points(pins.route),points(pins.greenShape)));
  }
  function manifestToCapture(manifest,opts){
    if(!manifest||!Array.isArray(manifest.tiles)||!manifest.tiles.length)return null;
    var courseId=slug(manifest.courseKey||manifest.courseName||opts&&opts.courseId);
    var holeNumber=Math.max(1,Math.round(Number(manifest.holeNumber)||Number(opts&&opts.holeNumber)||1));
    var bounds=captureBounds(manifest);
    return {
      id:text(manifest.scanId||manifest.activeScanId||manifest.key||("capture-"+courseId+"-h"+holeNumber),180),
      imageUrl:null,
      imageData:null,
      storagePath:text(manifest.key||manifest.storageKey||"",220),
      bounds:bounds,
      width:Math.max(1,Math.round(Number(manifest.imageWidth)||0)),
      height:Math.max(1,Math.round(Number(manifest.imageHeight)||0)),
      devicePixelRatio:finite(manifest.devicePixelRatio)||1,
      zoom:finite(manifest.captureZoom),
      capturedAt:text(manifest.createdAt||manifest.updatedAt,80),
      holeNumber:holeNumber,
      sourceType:"leaflet-tile-manifest",
      originPx:manifest.originPx||null,
      tiles:manifest.tiles.map(function(tile){
        return {
          x:Math.round(Number(tile.x)||0),
          y:Math.round(Number(tile.y)||0),
          width:Math.round(Number(tile.width)||256)||256,
          height:Math.round(Number(tile.height)||256)||256,
          z:finite(tile.z),
          tileX:finite(tile.tileX),
          tileY:finite(tile.tileY),
          url:text(tile.url,900)
        };
      }).filter(function(tile){return !!tile.url;})
    };
  }
  function objectFromHole(hole,type,position,shape){
    if(!position&&!shape)return null;
    var holeNumber=Math.max(1,Math.round(Number(hole&&hole.holeNumber)||1));
    var id=[type,hole&&hole.courseId||hole&&hole.courseKey||"course","h"+holeNumber,hashString(position||shape)].join(":");
    return {id:id,type:type,holeNumber:holeNumber,geometry:shape&&shape.length?{type:"LineString",points:shape}:{type:"Point",point:position},bounds:boundsFromPoints(shape&&shape.length?shape:[position])};
  }
  function adaptCoursePlayPayloadToVisualInput(payload,opts){
    opts=opts||{};
    var source=payload&&payload.payload||payload||{};
    var courseId=slug(source.courseId||source.courseKey||opts.courseId);
    var holes=Array.isArray(source.holes)?source.holes:Object.keys(source.holes||{}).map(function(key){return source.holes[key];});
    var objects=[];
    holes.forEach(function(hole){
      var green=point(hole&&hole.greenCentre||hole&&hole.greenCenter);
      var tee=point(hole&&hole.teePoint);
      var route=points(hole&&hole.routePoints);
      var shape=points(hole&&hole.greenShape);
      [objectFromHole(hole,"green",green,shape),objectFromHole(hole,"tee",tee,null),objectFromHole(hole,"fairway",route.length?route[Math.floor(route.length/2)]:null,route)].forEach(function(object){if(object)objects.push(object);});
    });
    var manifests=[];
    if(Array.isArray(opts.captures))manifests=opts.captures;
    else if(Array.isArray(opts.frameRows)&&typeof opts.readManifest==="function"){
      opts.frameRows.forEach(function(frame){
        var key=frame&&(frame.manifestKey||frame.capturedManifestKey);
        var manifest=key?opts.readManifest(key):null;
        if(manifest)manifests.push(manifest);
      });
    }
    var captures=manifests.map(function(item){return item&&item.tiles?manifestToCapture(item,{courseId:courseId}):item;}).filter(function(capture){return capture&&capture.width&&capture.height&&captureBounds(capture)&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData);});
    return {
      courseId:courseId,
      courseName:text(source.courseName||source.name||opts.courseName,180),
      courseBounds:mergeBounds(captures.map(captureBounds).concat(objects.map(function(object){return object.bounds;}))),
      objects:objects,
      captures:captures,
      currentVisual:opts.currentVisual||null
    };
  }
  function normalizeInput(input){
    input=input&&typeof input==="object"?input:{};
    var courseId=slug(input.courseId||input.courseKey||input.courseName);
    return {
      courseId:courseId,
      courseName:text(input.courseName||input.name,180),
      courseBounds:validBounds(input.courseBounds)?input.courseBounds:mergeBounds((input.captures||[]).map(captureBounds).concat((input.objects||[]).map(function(o){return o&&o.bounds;}))),
      objects:(Array.isArray(input.objects)?input.objects:[]).map(function(object,index){
        return {id:text(object&&object.id,180)||"object-"+index,type:text(object&&object.type,40)||"other",holeNumber:finite(object&&object.holeNumber),geometry:object&&object.geometry,bounds:validBounds(object&&object.bounds)?object.bounds:null};
      }),
      captures:(Array.isArray(input.captures)?input.captures:[]).map(function(capture,index){
        var looksLikeManifest=capture&&capture.tiles&&(capture.imageWidth||capture.imageHeight||capture.originPx);
        var c=looksLikeManifest?manifestToCapture(capture,{courseId:courseId}):(capture&&capture.tiles?capture:manifestToCapture(capture,{courseId:courseId}));
        c=c&&typeof c==="object"?c:{};
        return Object.assign({},c,{id:text(c.id,180)||"capture-"+index,bounds:captureBounds(c),width:Math.max(0,Math.round(Number(c.width)||0)),height:Math.max(0,Math.round(Number(c.height)||0))});
      }).filter(function(capture){return capture.bounds&&capture.width&&capture.height&&(Array.isArray(capture.tiles)&&capture.tiles.length||capture.imageUrl||capture.imageData);}),
      currentVisual:input.currentVisual||null
    };
  }
  function recordEvent(record,type,detail){
    record.events=Array.isArray(record.events)?record.events:[];
    record.events.push(Object.assign({at:now(),type:type},clone(detail||{})));
    record.events=record.events.slice(-80);
    if(root&&typeof root.dispatchEvent==="function")safe(function(){root.dispatchEvent(new CustomEvent("gd-course-visual-event",{detail:Object.assign({courseId:record.courseId},clone(record.events[record.events.length-1]))}));});
    return record;
  }
  function emptyRecord(courseId){
    var stamp=now();
    return {
      schema:"gd.course_visual.record",
      version:VERSION,
      id:"visual::"+slug(courseId),
      courseId:slug(courseId),
      status:"unavailable",
      rawMaster:null,
      basicVisual:null,
      previewVisual:null,
      publishedVisual:null,
      versions:[],
      presetId:defaultPreset().id,
      presetVersion:1,
      courseOverrides:{},
      currentVersion:0,
      publishedVersion:0,
      lastError:null,
      diagnostics:{},
      events:[],
      createdAt:stamp,
      updatedAt:stamp
    };
  }
  function getRecord(courseId){
    var store=loadStore();
    return clone(store.records[slug(courseId)]||emptyRecord(courseId));
  }
  function putRecord(record){
    var store=loadStore();
    record.updatedAt=now();
    record.status=VALID_STATUSES[record.status]?record.status:"failed";
    store.records[record.courseId]=clone(record);
    saveStore(store);
    queueCloudSync(record,"metadata");
    return clone(record);
  }
  function ingestCourseVisualInput(input){
    var normalized=normalizeInput(input);
    var record=getRecord(normalized.courseId);
    record.courseName=normalized.courseName||record.courseName||normalized.courseId;
    record.input={courseId:normalized.courseId,courseName:normalized.courseName,courseBounds:normalized.courseBounds,objectCount:normalized.objects.length,captureCount:normalized.captures.length,sourceCaptureIds:normalized.captures.map(function(capture){return capture.id;})};
    record.objects=normalized.objects;
    record.captures=normalized.captures;
    record.status=normalized.captures.length?"input-ready":"unavailable";
    record.lastError=normalized.captures.length?null:{code:"missing-captures",message:"No captured frames are available for this course visual."};
    record.diagnostics=Object.assign({},record.diagnostics||{},{captureBounds:normalized.captures.map(captureBounds),sourceDimensions:normalized.captures.map(function(c){return {id:c.id,width:c.width,height:c.height,tiles:Array.isArray(c.tiles)?c.tiles.length:0};}),missingCaptures:normalized.captures.length?[]:["course-visual-captures"]});
    recordEvent(record,"course-visual-input-received",{captureCount:normalized.captures.length,objectCount:normalized.objects.length});
    return putRecord(record);
  }
  function captureSignature(captures){
    return hashString((captures||[]).map(function(capture){return [capture.id,capture.width,capture.height,JSON.stringify(capture.bounds),Array.isArray(capture.tiles)?capture.tiles.length:0].join("|");}).join("\n"));
  }
  function stitchSvg(captures,meta){
    var valid=(Array.isArray(captures)?captures:[]).filter(function(capture){return capture&&capture.width&&capture.height&&Array.isArray(capture.tiles)&&capture.tiles.length;});
    if(!valid.length)throw Object.assign(new Error("No renderable tile captures found"),{code:"missing-renderable-captures"});
    var gutter=24;
    var width=Math.max.apply(null,valid.map(function(capture){return Number(capture.width)||0;}));
    var height=valid.reduce(function(sum,capture){return sum+(Number(capture.height)||0)+gutter;},0)-gutter;
    width=Math.max(1,Math.round(width));
    height=Math.max(1,Math.round(height));
    var y=0;
    var missingAreas=[];
    var groups=valid.map(function(capture){
      var tiles=capture.tiles.map(function(tile){
        var tw=Number(tile.width)||256,th=Number(tile.height)||256;
        return '<image href="'+escapeXml(tile.url)+'" x="'+Math.round(Number(tile.x)||0)+'" y="'+Math.round((Number(tile.y)||0)+y)+'" width="'+tw+'" height="'+th+'" preserveAspectRatio="none"/>';
      }).join("");
      if(!capture.bounds)missingAreas.push({captureId:capture.id,reason:"missing-bounds"});
      var label='<text x="12" y="'+Math.max(18,y+18)+'" font-size="14" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">'+escapeXml("H"+(capture.holeNumber||"?")+" "+capture.id)+'</text>';
      var out='<g data-capture-id="'+escapeXml(capture.id)+'">'+tiles+label+'</g>';
      y+=Math.round(Number(capture.height)||0)+gutter;
      return out;
    }).join("");
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'"><rect width="100%" height="100%" fill="#111"/>'+groups+'</svg>';
    return {dataUrl:dataUrl("image/svg+xml",svg),width:width,height:height,missingAreas:missingAreas,bounds:mergeBounds(valid.map(captureBounds)),sourceCaptureIds:valid.map(function(c){return c.id;}),metadata:Object.assign({rendererVersion:RENDERER_VERSION,format:"image/svg+xml"},meta||{})};
  }
  function buildCourseVisualMaster(courseId){
    courseId=slug(courseId);
    if(inFlightBuilds[courseId])return inFlightBuilds[courseId];
    var promise=Promise.resolve().then(function(){
      var record=getRecord(courseId);
      record.status="stitching";
      recordEvent(record,"course-visual-stitch-started",{captureCount:(record.captures||[]).length});
      putRecord(record);
      var signature=captureSignature(record.captures||[]);
      if(record.rawMaster&&record.rawMaster.captureSignature===signature&&record.basicVisual){
        record.status=record.publishedVisual?"published":"basic-ready";
        recordEvent(record,"course-visual-basic-ready",{idempotent:true,version:record.currentVersion});
        return putRecord(record);
      }
      try{
        var stitched=stitchSvg(record.captures||[],{inputVisualId:record.id,courseId:courseId,captureSignature:signature});
        var version=(Number(record.currentVersion)||0)+1;
        var visualId=stableId("visual");
        record.rawMaster={path:"course-visuals/"+courseId+"/raw/"+visualId+".svg",dataUrl:stitched.dataUrl,bounds:stitched.bounds,width:stitched.width,height:stitched.height,captureSignature:signature,metadata:stitched.metadata};
        record.basicVisual={path:"course-visuals/"+courseId+"/basic/"+version+".svg",dataUrl:stitched.dataUrl,version:version};
        record.currentVersion=version;
        record.status="basic-ready";
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{stitchOutputDimensions:{width:stitched.width,height:stitched.height},missingCoverage:stitched.missingAreas,sourceCaptureIds:stitched.sourceCaptureIds});
        record.versions=(record.versions||[]).concat([{version:version,type:"basic",rawMasterPath:record.rawMaster.path,basicImagePath:record.basicVisual.path,sourceCaptureIds:stitched.sourceCaptureIds,createdAt:now(),metadata:stitched.metadata}]);
        recordEvent(record,"course-visual-basic-ready",{version:version,width:stitched.width,height:stitched.height,missingAreas:stitched.missingAreas.length});
      }catch(error){
        record.status="failed";
        record.lastError={code:error&&error.code||"stitch-failed",message:error&&error.message||String(error)};
        record.diagnostics=Object.assign({},record.diagnostics||{},{stitchFailure:record.lastError});
        recordEvent(record,"course-visual-build-failed",record.lastError);
      }
      return putRecord(record);
    });
    inFlightBuilds[courseId]=promise.finally(function(){delete inFlightBuilds[courseId];});
    return inFlightBuilds[courseId];
  }
  function filterForSettings(settings){
    var turf=settings&&settings.turf||{};
    var lighting=settings&&settings.lighting||{};
    var readability=settings&&settings.readability||{};
    var saturation=1+(Number(turf.greenStrength)||0)*.22;
    var brightness=1+((Number(lighting.brightnessTarget)||52)-52)/140;
    var contrast=Number(lighting.contrastTarget)||1;
    var sharp=Number(readability.sharpness)||0;
    return {saturation:+saturation.toFixed(3),brightness:+brightness.toFixed(3),contrast:+contrast.toFixed(3),sharpness:+sharp.toFixed(3)};
  }
  function previewSvg(record,settings,version){
    var base=record.rawMaster&&record.rawMaster.dataUrl||record.basicVisual&&record.basicVisual.dataUrl;
    if(!base)throw Object.assign(new Error("Raw master is not available"),{code:"raw-master-missing"});
    var width=record.rawMaster&&record.rawMaster.width||1200;
    var height=record.rawMaster&&record.rawMaster.height||800;
    var f=filterForSettings(settings);
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+" "+height+'" data-renderer="'+escapeXml(RENDERER_VERSION)+'" data-version="'+version+'"><filter id="cv"><feColorMatrix type="saturate" values="'+f.saturation+'"/><feComponentTransfer><feFuncR type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncG type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/><feFuncB type="linear" slope="'+f.contrast+'" intercept="'+((f.brightness-1)/2)+'"/></feComponentTransfer></filter><image href="'+escapeXml(base)+'" width="'+width+'" height="'+height+'" filter="url(#cv)" preserveAspectRatio="xMidYMid meet"/></svg>';
    return dataUrl("image/svg+xml",svg);
  }
  function saveCourseVisualSettings(courseId,overrides){
    var record=getRecord(courseId);
    record.courseOverrides=clone(overrides||{});
    record.settingsDirty=true;
    recordEvent(record,"course-visual-settings-saved",{published:false,overrideHash:hashString(record.courseOverrides)});
    return putRecord(record);
  }
  function buildCourseVisualPreview(courseId,presetOrId,overrides){
    return Promise.resolve().then(function(){
      var record=getRecord(courseId);
      var preset=typeof presetOrId==="string"?getPreset(presetOrId):(presetOrId||getPreset(record.presetId));
      var courseOverrides=overrides!==undefined?clone(overrides||{}):clone(record.courseOverrides||{});
      var settings=mergePreset(preset,courseOverrides);
      record.status="rendering";
      recordEvent(record,"course-visual-preview-started",{presetId:preset.id,presetVersion:preset.version});
      putRecord(record);
      try{
        var version=(Number(record.currentVersion)||0)+1;
        var overrideHash=hashString(courseOverrides);
        var previewData=previewSvg(record,settings,version);
        record.previewVisual={path:"course-visuals/"+record.courseId+"/preview/"+version+".svg",dataUrl:previewData,version:version,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash};
        record.presetId=preset.id;
        record.presetVersion=preset.version;
        record.courseOverrides=courseOverrides;
        record.currentVersion=version;
        record.status="preview-ready";
        record.settingsDirty=false;
        record.lastError=null;
        record.diagnostics=Object.assign({},record.diagnostics||{},{preview:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml",outputDimensions:{width:record.rawMaster&&record.rawMaster.width,height:record.rawMaster&&record.rawMaster.height},presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash}});
        record.versions=(record.versions||[]).concat([{version:version,type:"preview",previewImagePath:record.previewVisual.path,presetId:preset.id,presetVersion:preset.version,overrideHash:overrideHash,createdAt:now(),metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml"}}]);
        recordEvent(record,"course-visual-preview-ready",{version:version,presetId:preset.id,presetVersion:preset.version});
      }catch(error){
        record.status="failed";
        record.lastError={code:error&&error.code||"preview-failed",message:error&&error.message||String(error)};
        recordEvent(record,"course-visual-build-failed",record.lastError);
      }
      return putRecord(record);
    });
  }
  function publishCourseVisual(courseId,previewVersion){
    var record=getRecord(courseId);
    var preview=record.previewVisual;
    if(previewVersion&&preview&&Number(preview.version)!==Number(previewVersion)){
      var found=(record.versions||[]).filter(function(version){return version.type==="preview"&&Number(version.version)===Number(previewVersion);})[0];
      if(!found){record.status="failed";record.lastError={code:"preview-version-missing",message:"The requested preview version is not available."};recordEvent(record,"course-visual-publish-failed",record.lastError);return putRecord(record);}
    }
    if(!preview){record.status="failed";record.lastError={code:"preview-missing",message:"Build a preview before publishing a styled course visual."};recordEvent(record,"course-visual-publish-failed",record.lastError);return putRecord(record);}
    var version=Number(preview.version)||((Number(record.currentVersion)||0)+1);
    record.publishedVisual={path:"course-visuals/"+record.courseId+"/published/"+version+".svg",dataUrl:preview.dataUrl,version:version,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,publishedAt:now()};
    record.publishedVersion=version;
    record.status="published";
    record.lastError=null;
    record.versions=(record.versions||[]).concat([{version:version,type:"published",publishedImagePath:record.publishedVisual.path,presetId:preview.presetId,presetVersion:preview.presetVersion,overrideHash:preview.overrideHash,createdAt:record.publishedVisual.publishedAt,metadata:{rendererVersion:RENDERER_VERSION,outputFormat:"image/svg+xml"}}]);
    recordEvent(record,"course-visual-published",{version:version,presetId:preview.presetId,presetVersion:preview.presetVersion});
    return putRecord(record);
  }
  function revertToPublishedVersion(courseId,version){
    var record=getRecord(courseId);
    var found=(record.versions||[]).slice().reverse().filter(function(item){return item.type==="published"&&(!version||Number(item.version)===Number(version));})[0];
    if(!found||!record.publishedVisual){record.lastError={code:"published-version-missing",message:"No previous published visual is available."};return putRecord(record);}
    record.status="published";
    record.publishedVersion=found.version;
    recordEvent(record,"course-visual-published",{version:found.version,reverted:true});
    return putRecord(record);
  }
  function resetToPublished(courseId){
    var record=getRecord(courseId);
    record.previewVisual=null;
    record.settingsDirty=false;
    record.courseOverrides={};
    record.status=record.publishedVisual?"published":record.basicVisual?"basic-ready":"unavailable";
    recordEvent(record,"course-visual-settings-saved",{reset:"published"});
    return putRecord(record);
  }
  function resetToGlobalPreset(courseId,presetId){
    var record=getRecord(courseId);
    var preset=getPreset(presetId||defaultPreset().id);
    record.presetId=preset.id;
    record.presetVersion=preset.version;
    record.courseOverrides={};
    record.settingsDirty=true;
    recordEvent(record,"course-visual-settings-saved",{reset:"global-preset",presetId:preset.id,presetVersion:preset.version});
    return putRecord(record);
  }
  function resolveCourseVisual(courseId){
    var record=getRecord(courseId);
    var visual=record.publishedVisual||record.basicVisual||null;
    if(!visual)return null;
    return {
      courseId:record.courseId,
      status:record.publishedVisual?"published":"basic-ready",
      rawMaster:record.rawMaster?{path:record.rawMaster.path,bounds:record.rawMaster.bounds,width:record.rawMaster.width,height:record.rawMaster.height}:undefined,
      basicVisual:record.basicVisual?{path:record.basicVisual.path,dataUrl:record.basicVisual.dataUrl,version:record.basicVisual.version}:undefined,
      previewVisual:record.previewVisual?{path:record.previewVisual.path,dataUrl:record.previewVisual.dataUrl,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,dataUrl:record.publishedVisual.dataUrl,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      error:record.lastError||undefined
    };
  }
  function outputForRecord(record){
    record=record||{};
    return {
      courseId:record.courseId,
      status:record.status==="published"?"published":record.previewVisual?"preview-ready":record.basicVisual?"basic-ready":record.status==="failed"?"failed":"unavailable",
      rawMaster:record.rawMaster?{path:record.rawMaster.path,bounds:record.rawMaster.bounds,width:record.rawMaster.width,height:record.rawMaster.height}:undefined,
      basicVisual:record.basicVisual?{path:record.basicVisual.path,version:record.basicVisual.version}:undefined,
      previewVisual:record.previewVisual?{path:record.previewVisual.path,version:record.previewVisual.version,presetId:record.previewVisual.presetId,presetVersion:record.previewVisual.presetVersion}:undefined,
      publishedVisual:record.publishedVisual?{path:record.publishedVisual.path,version:record.publishedVisual.version,presetId:record.publishedVisual.presetId,presetVersion:record.publishedVisual.presetVersion}:undefined,
      error:record.lastError||undefined
    };
  }
  function queueCloudSync(record,reason){
    if(!root||typeof root.fetch!=="function"||!record||record.__syncing)return;
    var actor=safe(function(){
      var api=root.GolfDaddyAccounts||root.ClarityCaddieAccounts;
      var current=api&&typeof api.current==="function"?api.current():null;
      return {role:current&&current.role||"",email:current&&current.email||"",accountId:current&&current.accountId||""};
    },{});
    if(String(actor.role||"").toLowerCase()!=="admin")return;
    var body={action:"upsert",reason:reason||"local",actor:actor,visual:metadataForCloud(record)};
    setTimeout(function(){
      safe(function(){root.fetch(API_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body)}).catch(function(){});});
    },20);
  }
  function metadataForCloud(record){
    var assets=[
      record.rawMaster&&record.rawMaster.dataUrl?{path:record.rawMaster.path,dataUrl:record.rawMaster.dataUrl,contentType:"image/svg+xml",role:"raw-master"}:null,
      record.basicVisual&&record.basicVisual.dataUrl?{path:record.basicVisual.path,dataUrl:record.basicVisual.dataUrl,contentType:"image/svg+xml",role:"basic"}:null,
      record.previewVisual&&record.previewVisual.dataUrl?{path:record.previewVisual.path,dataUrl:record.previewVisual.dataUrl,contentType:"image/svg+xml",role:"preview"}:null,
      record.publishedVisual&&record.publishedVisual.dataUrl?{path:record.publishedVisual.path,dataUrl:record.publishedVisual.dataUrl,contentType:"image/svg+xml",role:"published"}:null
    ].filter(Boolean);
    return {
      id:record.id,
      course_id:record.courseId,
      status:record.status,
      raw_master_path:record.rawMaster&&record.rawMaster.path||null,
      basic_image_path:record.basicVisual&&record.basicVisual.path||null,
      preview_image_path:record.previewVisual&&record.previewVisual.path||null,
      published_image_path:record.publishedVisual&&record.publishedVisual.path||null,
      course_bounds:record.input&&record.input.courseBounds||record.rawMaster&&record.rawMaster.bounds||null,
      source_capture_ids:record.input&&record.input.sourceCaptureIds||[],
      preset_id:record.presetId,
      preset_version:record.presetVersion,
      course_overrides:record.courseOverrides||{},
      current_version:record.currentVersion||0,
      published_version:record.publishedVersion||0,
      last_error:record.lastError||null,
      diagnostics:record.diagnostics||{},
      versions:record.versions||[],
      assets:assets,
      updated_at:record.updatedAt||now()
    };
  }
  function restoreCloudMetadata(row){
    if(!row)return null;
    var record=getRecord(row.course_id||row.courseId);
    record.status=row.status||record.status;
    record.presetId=row.preset_id||record.presetId;
    record.presetVersion=Number(row.preset_version)||record.presetVersion;
    record.courseOverrides=row.course_overrides||record.courseOverrides||{};
    record.currentVersion=Number(row.current_version)||record.currentVersion||0;
    record.publishedVersion=Number(row.published_version)||record.publishedVersion||0;
    record.lastError=row.last_error||record.lastError||null;
    record.diagnostics=row.diagnostics||record.diagnostics||{};
    record.versions=Array.isArray(row.versions)?row.versions:record.versions||[];
    if(row.raw_master_path&&!record.rawMaster)record.rawMaster={path:row.raw_master_path,bounds:row.course_bounds||null,width:0,height:0};
    if(row.basic_image_path&&!record.basicVisual)record.basicVisual={path:row.basic_image_path,version:record.currentVersion||1};
    if(row.preview_image_path&&!record.previewVisual)record.previewVisual={path:row.preview_image_path,version:record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    if(row.published_image_path&&!record.publishedVisual)record.publishedVisual={path:row.published_image_path,version:record.publishedVersion||record.currentVersion||1,presetId:record.presetId,presetVersion:record.presetVersion};
    return putRecord(record);
  }
  function pullCourseVisual(courseId){
    if(!root||typeof root.fetch!=="function")return Promise.resolve(getRecord(courseId));
    return root.fetch(API_ENDPOINT+"?courseId="+encodeURIComponent(slug(courseId)),{headers:{Accept:"application/json"},cache:"no-store"}).then(function(res){return res.ok?res.json():null;}).then(function(data){
      var row=data&&data.visual||null;
      return row?restoreCloudMetadata(row):getRecord(courseId);
    }).catch(function(){return getRecord(courseId);});
  }
  function buildFromCourseDatabase(courseId){
    var api=root&&root.GDCoursePlayPipeline;
    var payload=api&&typeof api.buildCoursePlayDbPayload==="function"?api.buildCoursePlayDbPayload(courseId):null;
    var frameRows=api&&typeof api.getCoursePlayFrameIndex==="function"?api.getCoursePlayFrameIndex(courseId):[];
    var input=adaptCoursePlayPayloadToVisualInput(payload,{frameRows:frameRows,readManifest:function(key){return readJson(key,null);}});
    ingestCourseVisualInput(input);
    return buildCourseVisualMaster(input.courseId);
  }
  return {
    version:VERSION,
    rendererVersion:RENDERER_VERSION,
    storeKey:STORE_KEY,
    presetKey:PRESET_KEY,
    apiEndpoint:API_ENDPOINT,
    defaultPreset:defaultPreset,
    presetForMode:presetForMode,
    loadPresets:loadPresets,
    getPreset:getPreset,
    mergePreset:mergePreset,
    adaptCoursePlayPayloadToVisualInput:adaptCoursePlayPayloadToVisualInput,
    manifestToCapture:manifestToCapture,
    ingestCourseVisualInput:ingestCourseVisualInput,
    buildCourseVisualMaster:buildCourseVisualMaster,
    buildCourseVisualPreview:buildCourseVisualPreview,
    saveCourseVisualSettings:saveCourseVisualSettings,
    publishCourseVisual:publishCourseVisual,
    revertToPublishedVersion:revertToPublishedVersion,
    resetToPublished:resetToPublished,
    resetToGlobalPreset:resetToGlobalPreset,
    resolveCourseVisual:resolveCourseVisual,
    outputForRecord:outputForRecord,
    getRecord:getRecord,
    loadStore:loadStore,
    saveStore:saveStore,
    pullCourseVisual:pullCourseVisual,
    buildFromCourseDatabase:buildFromCourseDatabase,
    __test:{emptyStore:emptyStore,stitchSvg:stitchSvg,hashString:hashString,captureSignature:captureSignature,metadataForCloud:metadataForCloud}
  };
});
