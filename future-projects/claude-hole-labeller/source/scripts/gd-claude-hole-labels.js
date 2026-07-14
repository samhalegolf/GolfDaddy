/*
 * gd-claude-hole-labels.js
 * -------------------------
 * Drop-in for GolfDaddy. For courses whose OSM data has golf=hole geometry but
 * no ref tags, this script:
 *
 *   1. Intercepts the app's Overpass guide fetch (the one made by
 *      loadOsmGuideBundle in gd-course-library-pin-lock.js).
 *   2. If stored Claude labels exist for this course, injects them as tags.ref
 *      into the payload BEFORE parseOsmHoleGuides sees it — so the existing
 *      mapper works completely unchanged, numbers and all.
 *   3. If not, kicks off a background labeling job on the backend
 *      (caddy_osm_hole_labeler.py), polls it, stores the result, clears the
 *      app's guide cache, and fires a 'gd:hole-labels-ready' event.
 *   4. When labels arrive, shows a toast (via the app's window.toast, with a
 *      built-in fallback) and auto-refreshes by calling
 *      window.gdAutoMapOsmCourse({fresh:true}) — the same entry point
 *      scheduleOsmAutoMapForPlay uses — so the numbered guides load, hole
 *      objects save, and the map redraws without reopening the mapper.
 *
 * Install: load AFTER the app scripts in index.html:
 *   <script src="scripts/gd-claude-hole-labels.js"></script>
 * Configure: window.gdClaudeHoleLabels.backend = 'https://your-host';
 * Course name resolves automatically from window.gdAssumedCourseName /
 * sessionStorage 'gd_assumed_course_name' (the app already maintains these);
 * set window.gdClaudeHoleLabels.courseName to override, or leave everything
 * unset and the backend reverse-geocodes the course center as a last resort.
 * Optional:  window.gdClaudeHoleLabels.autoApply = false; // toast only,
 *            skip the automatic gdAutoMapOsmCourse refresh
 */
(function () {
  'use strict';

  var NS = (window.gdClaudeHoleLabels = window.gdClaudeHoleLabels || {});
  // Set window.gdClaudeHoleLabels.backend to the hole-labeler service URL
  // (server/hole-labeler) to enable label generation. Left unset, the feature
  // stays dormant: any labels already stored for a course are still injected,
  // but no network requests fire — so the app behaves exactly as it does today.
  NS.backend = NS.backend || null;
  NS.courseName = NS.courseName || null;
  NS.autoApply = NS.autoApply !== false; // default on
  NS.status = 'idle';
  NS.mode = NS.mode || null;
  NS.requestedHole = NS.requestedHole || null;

  var STORE_PREFIX = 'gd_claude_hole_labels_v1:';
  var GEN_STORE_PREFIX = 'gd_claude_gen_holes_v1:';
  var GUIDE_CACHE_PREFIX = 'gd_osm_hole_guides_v1:'; // matches pin-lock.js
  var POLL_MS = 5000;
  var POLL_MAX = 60; // 5 minutes (generation jobs run longer than labeling)
  var pendingKeys = {};
  var pendingResolutionKeys = {};
  var EMPTY_RESULT_TTL_MS = 30 * 60 * 1000;

  function isGuideQuery(url) {
    if (!/overpass-api\.de/i.test(url)) return false;
    try { return /golf/i.test(decodeURIComponent(url)); }
    catch (e) { return /golf/i.test(url); }
  }

  function centerFromUrl(url) {
    var decoded;
    try { decoded = decodeURIComponent(url); } catch (e) { decoded = url; }
    var m = decoded.match(/around:\d+\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  }

  function storeKey(center) {
    return STORE_PREFIX + center.lat.toFixed(4) + ',' + center.lng.toFixed(4);
  }

  function readLabelRecord(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function readLabels(key) {
    var record = readLabelRecord(key);
    return record ? (record.labels || null) : null;
  }

  function hasRecentEmptyLabelResult(key) {
    var record = readLabelRecord(key);
    var labels = record && record.labels;
    var savedAt = Number(record && record.savedAt);
    return !!(labels && !Object.keys(labels).length &&
      Number.isFinite(savedAt) && Date.now() - savedAt < EMPTY_RESULT_TTL_MS);
  }

  function refNumber(el) {
    var tags = (el && el.tags) || {};
    var m = String(tags.ref || tags.name || '').match(/\d+/);
    var n = m ? Number(m[0]) : NaN;
    return n >= 1 && n <= 36 ? n : null;
  }

  function unlabeledHoles(payload) {
    return ((payload && payload.elements) || []).filter(function (el) {
      return String((el.tags || {}).golf || '').toLowerCase() === 'hole' && !refNumber(el);
    });
  }

  function holeCount(payload) {
    return ((payload && payload.elements) || []).filter(function (el) {
      return String((el.tags || {}).golf || '').toLowerCase() === 'hole';
    }).length;
  }

  function readGeneratedRecord(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function readGenerated(key) {
    var record = readGeneratedRecord(key);
    return record ? (record.elements || null) : null;
  }

  function hasRecentEmptyGeneratedResult(key) {
    var record = readGeneratedRecord(key);
    var elements = record && record.elements;
    var savedAt = Number(record && record.savedAt);
    return !!(Array.isArray(elements) && !elements.length &&
      Number.isFinite(savedAt) && Date.now() - savedAt < EMPTY_RESULT_TTL_MS);
  }

  function injectLabels(payload, labels) {
    var hits = 0;
    unlabeledHoles(payload).forEach(function (el) {
      var n = labels[(el.type || 'osm') + '-' + el.id];
      if (n != null) {
        el.tags = el.tags || {};
        el.tags.ref = String(n);
        hits++;
      }
    });
    return hits;
  }

  function clearGuideCache() {
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf(GUIDE_CACHE_PREFIX) === 0) localStorage.removeItem(k);
      });
    } catch (e) { /* no-op */ }
  }

  // ---------------------------------------------------------------------
  // Toast + auto-apply
  // ---------------------------------------------------------------------
  function showToast(msg) {
    try {
      if (typeof window.toast === 'function') return window.toast(msg);
    } catch (e) { /* fall through to built-in */ }
    try {
      var el = document.createElement('div');
      el.textContent = msg;
      el.style.cssText =
        'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);' +
        'background:#101820;color:#fff;padding:10px 18px;border-radius:20px;' +
        'font:600 14px/1.3 system-ui,sans-serif;z-index:99999;opacity:0;' +
        'transition:opacity .25s;box-shadow:0 4px 14px rgba(0,0,0,.35);' +
        'max-width:82vw;text-align:center;pointer-events:none;';
      document.body.appendChild(el);
      requestAnimationFrame(function () { el.style.opacity = '1'; });
      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () { el.remove(); }, 300);
      }, 3200);
    } catch (e) { /* no-op */ }
  }

  function resolutionKeyFor(storeKey) {
    try {
      var active = window.__gdCoursePlayResolverActive;
      if (active && active.key) return String(active.key);
    } catch (e) { /* no-op */ }
    var status = String(NS.status || '');
    if ((status === 'labeling' || status === 'generating') && NS.resolutionKey) {
      return String(NS.resolutionKey);
    }
    return String(storeKey || 'course-hole');
  }

  function emitDebug(type, detail) {
    var payload = detail || {};
    payload[type] = true;
    payload.resolutionKey = payload.resolutionKey || resolutionKeyFor(payload.storeKey);
    try {
      var pipeline = window.GDCoursePlayPipeline;
      if (pipeline && typeof pipeline.recordDebugEvent === 'function') {
        pipeline.recordDebugEvent(type, payload);
      }
    } catch (e) { /* no-op */ }
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-debug', {
        detail: Object.assign({ type: type }, payload)
      }));
    } catch (e) { /* no-op */ }
  }

  function resolverOwnsCycle(resolutionKey) {
    try {
      var active = window.__gdCoursePlayResolverActive;
      return !!(active && active.key && resolutionKey && String(active.key) === String(resolutionKey));
    } catch (e) { return false; }
  }

  function deletePending(key, resolutionKey) {
    delete pendingKeys[key];
    if (resolutionKey) delete pendingResolutionKeys[resolutionKey];
  }

  function applyLabels(count, attempt) {
    attempt = attempt || 0;
    if (typeof window.gdAutoMapOsmCourse !== 'function') {
      // Script order race or mapper not loaded yet — retry briefly, then
      // leave it to the next natural guide load (labels are stored).
      if (attempt < 3) {
        setTimeout(function () { applyLabels(count, attempt + 1); }, 2000);
      } else {
        showToast('Hole numbers ready — reopen the course mapper to apply');
      }
      return;
    }
    // Same entry point scheduleOsmAutoMapForPlay uses. fresh:true forces the
    // guide bundle past the in-memory cache and back through Overpass, where
    // the interceptor injects the stored refs. quiet:true lets the app show
    // its own "OSM base map ready" toast only when something was saved.
    // Frame the camera only if the full mapper is open, to avoid yanking the
    // view mid-round.
    try {
      Promise.resolve(window.gdAutoMapOsmCourse({
        fresh: true,
        quiet: true,
        frame: !!window.gdFullMappingMode
      })).catch(function (err) {
        console.warn('[Claude hole labels] auto-map refresh failed', err);
      });
    } catch (err) {
      console.warn('[Claude hole labels] auto-map refresh failed', err);
    }
  }

  function resolveCourseName() {
    if (NS.courseName) return NS.courseName;
    try {
      return window.gdAssumedCourseName ||
        sessionStorage.getItem('gd_assumed_course_name') || null;
    } catch (e) {
      return window.gdAssumedCourseName || null;
    }
  }

  function labelingFailed(key, why, resolutionKey, jobId) {
    NS.status = 'failed';
    NS.mode = null;
    resolutionKey = resolutionKey || resolutionKeyFor(key);
    deletePending(key, resolutionKey);
    emitDebug('claude_result_failed', {
      storeKey: key,
      reason: why || null,
      claude_job_id: jobId || NS.jobId || null,
      jobId: jobId || NS.jobId || null,
      status: 'failed',
      mode: NS.mode || 'labeling',
      resolutionKey: resolutionKey
    });
    showToast('Couldn’t find hole numbers automatically for this course');
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-failed', {
        detail: { storeKey: key, reason: why || null, resolutionKey: resolutionKey, jobId: jobId || null }
      }));
    } catch (e) { /* no-op */ }
  }

  function requestLabels(key, center, elements) {
    if (!NS.backend) return; // dormant until a backend host is configured
    if (pendingKeys[key]) return;
    var resolutionKey = resolutionKeyFor(key);
    if (pendingResolutionKeys[resolutionKey]) return;
    pendingKeys[key] = true;
    pendingResolutionKeys[resolutionKey] = true;
    NS.status = 'labeling';
    NS.mode = 'labeling';
    NS.resolutionKey = resolutionKey;

    var body = { lat: center.lat, lng: center.lng };
    var courseName = resolveCourseName();
    if (courseName) body.course_name = courseName;
    // Ship the Overpass payload we just received: the backend's own Overpass
    // access is unreliable (cloud IPs are deprioritized), ours just worked.
    if (elements && elements.length) body.elements = elements;

    // Make the background job visible — without this the mapper just sits
    // on its empty state for the 1-3 minutes the labeling pipeline runs.
    showToast('Finding hole numbers' + (courseName ? ' for ' + courseName : '') +
      ' — this can take a couple of minutes');
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-started', {
        detail: { storeKey: key, courseName: courseName || null, resolutionKey: resolutionKey }
      }));
    } catch (e) { /* no-op */ }
    emitDebug('claude_post_started', {
      storeKey: key,
      courseName: courseName || null,
      holeNumber: Number(NS.requestedHole) || null,
      resolutionKey: resolutionKey,
      status: 'labeling'
    });

    fetch(NS.backend + '/v1/osm-hole-labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === 'done') return finish(key, data.result, resolutionKey, data.job_id || null);
        if (!data.job_id) throw new Error('labeling request rejected');
        NS.jobId = data.job_id;
        emitDebug('claude_job_id', {
          storeKey: key,
          claude_job_id: data.job_id,
          jobId: data.job_id,
          resolutionKey: resolutionKey,
          status: 'labeling'
        });
        return poll(key, data.job_id, 0, null, resolutionKey);
      })
      .catch(function (err) {
        console.warn('[Claude hole labels] request failed', err);
        labelingFailed(key, 'request failed', resolutionKey);
      });
  }

  function poll(key, jobId, attempt, onDone, resolutionKey) {
    onDone = onDone || finish;
    resolutionKey = resolutionKey || resolutionKeyFor(key);
    if (attempt >= POLL_MAX) {
      labelingFailed(key, 'timed out', resolutionKey, jobId);
      return;
    }
    setTimeout(function () {
      emitDebug('claude_poll', {
        storeKey: key,
        claude_job_id: jobId,
        jobId: jobId,
        attempt: attempt + 1,
        resolutionKey: resolutionKey,
        status: NS.status || 'labeling'
      });
      fetch(NS.backend + '/v1/osm-hole-labels/jobs/' + jobId)
        .then(function (r) { return r.json(); })
        .then(function (job) {
          if (job.status === 'done') return onDone(key, job.result, resolutionKey, jobId);
          if (job.status === 'failed') {
            console.warn('[Claude hole labels] job failed:', job.error, job.diagnostics);
            labelingFailed(key, job.error, resolutionKey, jobId);
            return;
          }
          poll(key, jobId, attempt + 1, onDone, resolutionKey);
        })
        .catch(function () { poll(key, jobId, attempt + 1, onDone, resolutionKey); });
    }, POLL_MS);
  }

  // -------------------------------------------------------------------------
  // Geometry generation: course has NO hole lines in OSM at all
  // -------------------------------------------------------------------------
  function requestGeneration(key, center) {
    if (!NS.backend || NS.generate === false) return;
    if (pendingKeys[key]) return;
    var resolutionKey = resolutionKeyFor(key);
    if (pendingResolutionKeys[resolutionKey]) return;
    var courseName = resolveCourseName();
    if (!courseName) return; // only generate when we know which course this is
    pendingKeys[key] = true;
    pendingResolutionKeys[resolutionKey] = true;
    NS.status = 'generating';
    NS.mode = 'generate';
    NS.resolutionKey = resolutionKey;
    showToast('Drawing ' + courseName + ' from satellite — this can take a few minutes');
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-started', {
        detail: { storeKey: key, courseName: courseName, mode: 'generate', resolutionKey: resolutionKey }
      }));
    } catch (e) { /* no-op */ }
    emitDebug('claude_post_started', {
      storeKey: key,
      courseName: courseName,
      mode: 'generate',
      resolutionKey: resolutionKey,
      status: 'generating'
    });

    fetch(NS.backend + '/v1/osm-hole-generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: center.lat, lng: center.lng, course_name: courseName })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.status === 'done') return finishGenerated(key, data.result, resolutionKey, data.job_id || null);
        if (!data.job_id) throw new Error('generation request rejected');
        NS.jobId = data.job_id;
        emitDebug('claude_job_id', {
          storeKey: key,
          claude_job_id: data.job_id,
          jobId: data.job_id,
          mode: 'generate',
          resolutionKey: resolutionKey,
          status: 'generating'
        });
        return poll(key, data.job_id, 0, finishGenerated, resolutionKey);
      })
      .catch(function (err) {
        console.warn('[Claude hole gen] request failed', err);
        labelingFailed(key, 'generation request failed', resolutionKey);
      });
  }

  function finishGenerated(key, result, resolutionKey, jobId) {
    resolutionKey = resolutionKey || resolutionKeyFor(key);
    var elements = (result && result.elements) || [];
    try {
      localStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        elements: elements,
        courseName: result && result.course_name,
        method: result && result.method
      }));
    } catch (e) { /* storage full — still injected on next fetch this session */ }
    deletePending(key, resolutionKey);
    NS.status = 'ready';
    NS.mode = null;
    clearGuideCache();
    emitDebug(elements.length ? 'claude_result_ready' : 'claude_result_empty', {
      storeKey: key,
      count: elements.length,
      mode: 'generate',
      claude_job_id: jobId || NS.jobId || null,
      jobId: jobId || NS.jobId || null,
      resolutionKey: resolutionKey,
      status: 'ready'
    });
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-ready', {
        detail: { storeKey: key, count: elements.length, mode: 'generate', resolutionKey: resolutionKey, jobId: jobId || null }
      }));
    } catch (e) { /* no-op */ }
    if (!elements.length) return;
    showToast('Course map drawn for ' +
      ((result && result.course_name) || 'this course') + ' — loading');
    if (NS.autoApply && !resolverOwnsCycle(resolutionKey)) applyLabels(elements.length);
  }

  function finish(key, result, resolutionKey, jobId) {
    resolutionKey = resolutionKey || resolutionKeyFor(key);
    try {
      localStorage.setItem(key, JSON.stringify({
        savedAt: Date.now(),
        labels: (result && result.labels) || {},
        courseName: result && result.course_name,
        sourceMapUrl: result && result.source_map_url
      }));
    } catch (e) { /* storage full — labels still applied next fetch */ }
    deletePending(key, resolutionKey);
    NS.status = 'ready';
    NS.mode = null;
    clearGuideCache(); // force the app to re-fetch guides with refs injected
    var count = Object.keys((result && result.labels) || {}).length;
    emitDebug(count ? 'claude_result_ready' : 'claude_result_empty', {
      storeKey: key,
      count: count,
      claude_job_id: jobId || NS.jobId || null,
      jobId: jobId || NS.jobId || null,
      resolutionKey: resolutionKey,
      status: 'ready'
    });
    try {
      window.dispatchEvent(new CustomEvent('gd:hole-labels-ready', {
        detail: { storeKey: key, count: count, resolutionKey: resolutionKey, jobId: jobId || null }
      }));
    } catch (e) { /* no-op */ }
    if (!count) return;
    showToast('Hole numbers found for ' +
      ((result && result.course_name) || 'this course') + ' — updating map');
    if (NS.autoApply && !resolverOwnsCycle(resolutionKey)) applyLabels(count);
  }

  // -------------------------------------------------------------------------
  // fetch interceptor
  // -------------------------------------------------------------------------
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isGuideQuery(url)) return origFetch.apply(this, arguments);

    var center = centerFromUrl(url);
    return origFetch.apply(this, arguments).then(function (res) {
      if (!res.ok || !center) return res;
      return res.clone().json().then(function (payload) {
        var missing = unlabeledHoles(payload);
        if (!missing.length) {
          if (holeCount(payload) > 0) return res; // labeled course — nothing to do
          // OSM has NO hole lines here at all: use AI-generated geometry.
          var genKey = GEN_STORE_PREFIX +
            center.lat.toFixed(4) + ',' + center.lng.toFixed(4);
          var gen = readGenerated(genKey);
          if (gen && gen.length) {
            payload.elements = (payload.elements || []).concat(gen);
            return new Response(JSON.stringify(payload), {
              status: res.status,
              statusText: res.statusText,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (hasRecentEmptyGeneratedResult(genKey)) return res;
          requestGeneration(genKey, center); // background; response passes through
          return res;
        }

        var key = storeKey(center);
        var labels = readLabels(key);
        if (labels && injectLabels(payload, labels) > 0) {
          return new Response(JSON.stringify(payload), {
            status: res.status,
            statusText: res.statusText,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (hasRecentEmptyLabelResult(key)) return res;

        // If the course already has a usable numbered set (e.g. Queenstown:
        // 18 refs plus stale unnumbered duplicates), the standard mapper
        // works — don't burn a labeling job that validation would reject.
        var labeledCount = ((payload && payload.elements) || []).filter(function (el) {
          return String((el.tags || {}).golf || '').toLowerCase() === 'hole' && refNumber(el);
        }).length;
        var requestedHole = Number(NS.requestedHole);
        var requestedHoleLabeled = Number.isFinite(requestedHole) && requestedHole > 0 &&
          ((payload && payload.elements) || []).some(function (el) {
            return String((el.tags || {}).golf || '').toLowerCase() === 'hole' &&
              refNumber(el) === Math.round(requestedHole);
          });
        if (labeledCount >= 9 && (!Number.isFinite(requestedHole) || requestedHole <= 0 || requestedHoleLabeled)) return res;

        requestLabels(key, center, payload.elements); // background; response passes through
        return res;
      }).catch(function () { return res; });
    });
  };
})();
