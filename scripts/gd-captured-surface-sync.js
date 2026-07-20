(function () {
  'use strict';

  // Clarity Captured Surface <-> Supabase sync.
  //
  // The captured-surface model (index.html, gdCapturedSurfaceModelV1) keeps a
  // localStorage registry of hole surface scans and has always queued Supabase
  // payloads into an outbox that nothing ever sent. This script actually sends
  // them: on scan writes (debounced), on startup, when the connection returns,
  // and when the session changes.
  //
  // Registry stays the working copy. Cloud is a backup + diagnostics mirror,
  // and course-play can explicitly pull cloud scan rows before falling back to
  // a fresh map scan.

  var ENDPOINT = '/api/captured-surface-sync';
  var REGISTRY_KEY = 'gd_captured_surface_scans_v1';
  var OUTBOX_KEY = 'gd_captured_surface_supabase_outbox_v1';
  var META_KEY = 'gd_captured_surface_sync_v1';
  var PUSH_DEBOUNCE_MS = 1500;
  var MAX_SCANS_PER_PUSH = 20;

  var flushTimer = null;
  var flushing = false;
  var lastStatus = { state: 'idle', at: '', error: '', pushed: 0 };

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function readJson(key, fallback) {
    var parsed = safe(function () { return JSON.parse(window.localStorage.getItem(key) || 'null'); }, null);
    return parsed == null ? fallback : parsed;
  }

  function writeJson(key, value) {
    safe(function () { window.localStorage.setItem(key, JSON.stringify(value)); });
  }

  function slug(value) {
    return String(value || 'course').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'course';
  }

  function activeKey(courseKey, holeNumber) {
    return 'gd_captured_surface_active_v1_' + slug(courseKey) + ':h' + (Number(holeNumber) || 1);
  }

  function legacyManifestKey(courseKey, holeNumber) {
    return 'gd_captured_hole_frame_v19_' + slug(String(courseKey || 'course') + ':h' + (Number(holeNumber) || 1));
  }

  function point(value) {
    if (!value) return null;
    var lat = Number(value.lat);
    var lng = Number(value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function points(list) {
    return (Array.isArray(list) ? list : []).map(point).filter(Boolean);
  }

  function cleanPins(pins) {
    pins = pins && typeof pins === 'object' ? pins : {};
    return {
      tee: point(pins.tee),
      green: point(pins.green),
      route: points(pins.route),
      greenShape: points(pins.greenShape)
    };
  }

  function compactManifest(manifest) {
    var copy = Object.assign({}, manifest && typeof manifest === 'object' ? manifest : {});
    copy.tileCount = Array.isArray(copy.tiles) ? copy.tiles.length : Number(copy.tileCount) || 0;
    if (!Array.isArray(copy.tiles)) copy.tiles = [];
    return copy;
  }

  function renderableManifest(manifest) {
    return !!(manifest && Array.isArray(manifest.tiles) && manifest.tiles.length && manifest.originPx);
  }

  function storedRenderableManifest(scan) {
    var manifest = scan && scan.manifest;
    if (renderableManifest(manifest)) return true;
    var key = scan && scan.storage && scan.storage.legacyManifestKey;
    var stored = key ? readJson(key, null) : null;
    return renderableManifest(stored);
  }

  function readMeta() {
    var meta = readJson(META_KEY, {});
    meta.pushed = meta.pushed && typeof meta.pushed === 'object' ? meta.pushed : {};
    return meta;
  }

  function identity() {
    var account = safe(function () {
      var api = window.GolfDaddyAccounts || window.ClarityCaddieAccounts;
      return api && typeof api.current === 'function' ? api.current() : null;
    }, null);
    var profile = safe(function () {
      var api = window.GolfDaddyProfiles || window.ClarityCaddieProfiles;
      return api && typeof api.active === 'function' ? api.active() : null;
    }, null);
    return {
      accountId: account && account.accountId || '',
      playerId: profile && profile.id || (account && account.profileId) || ''
    };
  }

  /* A scan captured before any course was resolved has no identity. It still gets
     stored locally so the current render works, but it must never reach the
     database: every such scan slugs to the same "course" key, so they merge with
     each other and with unrelated captures. One reached the table as
     course_key "course" / name "Course". */
  function scanIsIdentified(scan) {
    var key = slug(scan && scan.courseKey);
    return !!key && key !== 'course';
  }

  /* A scan that came from the database has nothing to tell the database.
     pendingPayloads walks the whole registry, so without this every hydrated
     scan is pushed straight back on the next flush: 17 pulled, 17 re-uploaded,
     updated_at churned on every course entry. That is what made a course jump to
     the top of the admin list just for being opened, and why freshly pulled
     scans still showed as local.

     A local re-capture replaces the registry entry with a fresh scan that has no
     cloudHydrated flag, so genuine edits still upload. */
  function scanIsCloudHydrated(scan) {
    return !!(scan && scan.source && scan.source.cloudHydrated);
  }

  function scanToPayload(scan) {
    if (!scan || !scan.id) return null;
    if (!scanIsIdentified(scan)) return null;
    if (scanIsCloudHydrated(scan)) return null;
    return {
      client_scan_id: scan.id,
      /* Slug on write so it matches the read path. The server normalises too -
         it has to, because older installed builds keep sending raw keys - but
         normalising here keeps local and remote keys identical, so a scan is not
         stored locally under one key and remotely under another. */
      course_key: slug(scan.courseKey),
      course_name: scan.courseName,
      hole_number: scan.holeNumber,
      source_type: scan.source && scan.source.type || '',
      status: scan.status || {},
      interaction: scan.interaction || {},
      projection: scan.projection || {},
      pins: scan.pins || {},
      manifest: scan.manifest || {},
      created_at: scan.createdAt || '',
      updated_at: scan.updatedAt || scan.createdAt || new Date().toISOString()
    };
  }

  function pendingPayloads() {
    var byId = {};
    var registry = readJson(REGISTRY_KEY, {});
    (Array.isArray(registry.scans) ? registry.scans : []).forEach(function (scan) {
      var payload = scanToPayload(scan);
      if (payload) byId[payload.client_scan_id] = payload;
    });
    var outbox = readJson(OUTBOX_KEY, []);
    (Array.isArray(outbox) ? outbox : []).forEach(function (payload) {
      if (!payload || !payload.client_scan_id) return;
      var known = byId[payload.client_scan_id];
      if (!known || String(payload.updated_at || '') > String(known.updated_at || '')) {
        byId[payload.client_scan_id] = payload;
      }
    });
    var meta = readMeta();
    return Object.keys(byId).map(function (id) { return byId[id]; }).filter(function (payload) {
      var pushedAt = meta.pushed[payload.client_scan_id];
      return !pushedAt || String(payload.updated_at || '') > String(pushedAt);
    });
  }

  function setStatus(next) {
    lastStatus = Object.assign({}, lastStatus, next || {}, { at: new Date().toISOString() });
    safe(function () {
      window.dispatchEvent(new CustomEvent('clarity:captured-surface-sync-status', { detail: lastStatus }));
    });
  }

  async function post(body) {
    var response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var parsed = await response.json().catch(function () { return {}; });
    if (!response.ok || parsed.synced === false) {
      var error = new Error(parsed.error || 'Captured surface sync failed');
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return parsed;
  }

  function cloudScanToLocal(row) {
    if (!row || !row.client_scan_id) return null;
    var courseKey = slug(row.course_key || row.courseKey || 'course');
    var holeNumber = Math.max(1, Math.round(Number(row.hole_number || row.holeNumber) || 1));
    var manifest = compactManifest(row.manifest || {});
    if (!manifest.key) manifest.key = legacyManifestKey(courseKey, holeNumber);
    if (!manifest.courseKey) manifest.courseKey = courseKey;
    if (!manifest.courseName) manifest.courseName = row.course_name || row.courseName || courseKey;
    if (!manifest.holeNumber) manifest.holeNumber = holeNumber;
    var pins = cleanPins(row.pins || manifest.anchorPins || {});
    return {
      schema: 'gd.captured_surface.scan',
      version: 1,
      id: row.client_scan_id,
      courseKey: courseKey,
      courseName: row.course_name || row.courseName || manifest.courseName || courseKey,
      holeNumber: holeNumber,
      createdAt: row.created_at || row.createdAt || row.updated_at || row.updatedAt || new Date().toISOString(),
      updatedAt: row.updated_at || row.updatedAt || row.created_at || row.createdAt || new Date().toISOString(),
      reason: 'supabase-pull',
      status: Object.assign({ latest: true, confidence: 'cloud-scan', trusted: false }, row.status || {}),
      interaction: row.interaction || { owner: 'captured-surface', liveMapRole: 'capture-source-diagnostic-reference' },
      source: {
        type: row.source_type || row.sourceType || 'supabase-captured-surface',
        captureZoom: manifest.captureZoom || row.projection && row.projection.captureZoom || null,
        tileCount: Number(manifest.tileCount) || 0,
        cloudHydrated: true
      },
      projection: row.projection || {
        type: 'leaflet-pixel-origin',
        captureZoom: manifest.captureZoom || null,
        originPx: manifest.originPx || null,
        imageWidth: manifest.imageWidth || 0,
        imageHeight: manifest.imageHeight || 0
      },
      pins: pins,
      storage: {
        registryKey: REGISTRY_KEY,
        activeKey: activeKey(courseKey, holeNumber),
        legacyManifestKey: manifest.key || legacyManifestKey(courseKey, holeNumber)
      },
      manifest: manifest,
      cloudHydrated: true,
      cloudHydratedAt: new Date().toISOString(),
      cloudSource: 'supabase'
    };
  }

  function importPulledScans(rows, opts) {
    opts = opts || {};
    var incoming = (Array.isArray(rows) ? rows : []).map(cloudScanToLocal).filter(Boolean);
    if (!incoming.length) return { count: 0, holes: [], renderableHoles: [], scans: [] };
    var registry = readJson(REGISTRY_KEY, { version: 1, updatedAt: null, scans: [] });
    registry.version = registry.version || 1;
    registry.scans = Array.isArray(registry.scans) ? registry.scans : [];
    var imported = [];
    var holes = {};
    var renderableHoles = {};
    incoming.forEach(function (scan) {
      var existing = registry.scans.find(function (item) { return item && item.id === scan.id; });
      if (existing && !existing.cloudHydrated && String(existing.updatedAt || '') > String(scan.updatedAt || '')) return;
      registry.scans = registry.scans.filter(function (item) { return !(item && item.id === scan.id); });
      registry.scans.unshift(scan);
      holes[String(scan.holeNumber)] = true;
      if (storedRenderableManifest(scan)) renderableHoles[String(scan.holeNumber)] = true;
      var currentActive = safe(function () { return window.localStorage.getItem(scan.storage.activeKey); }, '');
      var currentScan = currentActive ? registry.scans.find(function (item) { return item && item.id === currentActive; }) : null;
      var preserveRenderableLocal = currentScan && storedRenderableManifest(currentScan) && !renderableManifest(scan.manifest);
      if (opts.forceActive || !currentActive || renderableManifest(scan.manifest) || !preserveRenderableLocal) {
        safe(function () { window.localStorage.setItem(scan.storage.activeKey, scan.id); });
      }
      if (renderableManifest(scan.manifest)) {
        safe(function () { window.localStorage.setItem(scan.storage.legacyManifestKey, JSON.stringify(scan.manifest)); });
      }
      imported.push(scan);
    });
    writeJson(REGISTRY_KEY, registry);
    return {
      count: imported.length,
      holes: Object.keys(holes).map(Number).sort(function (a, b) { return a - b; }),
      renderableHoles: Object.keys(renderableHoles).map(Number).sort(function (a, b) { return a - b; }),
      scans: imported
    };
  }

  async function pullCourse(courseKey, opts) {
    opts = opts || {};
    var key = slug(courseKey || opts.courseKey || '');
    if (!key) throw new Error('Course key is required for captured surface pull');
    setStatus({ state: 'loading', reason: opts.reason || 'course-map-pull', label: 'Course map loading', courseKey: key, error: '' });
    try {
      var body = { action: 'pull', courseKey: key, reason: opts.reason || 'course-map-pull' };
      if (Number.isFinite(Number(opts.holeNumber)) && Number(opts.holeNumber) > 0) body.holeNumber = Math.round(Number(opts.holeNumber));
      var result = await post(body);
      var rows = Array.isArray(result.scans) ? result.scans : [];
      var imported = importPulledScans(rows, opts);
      setStatus(rows.length
        ? { state: 'synced', reason: opts.reason || 'course-map-pull', label: 'Course map loaded', courseKey: key, pulled: rows.length, imported: imported.count, holes: imported.holes, error: '' }
        : { state: 'missing', reason: opts.reason || 'course-map-pull', label: 'Course map unavailable', courseKey: key, pulled: 0, imported: 0, holes: [], error: '' });
      return Object.assign({}, result, { pulled: rows.length, imported: imported, status: lastStatus });
    } catch (error) {
      setStatus({ state: 'error', reason: opts.reason || 'course-map-pull', label: 'Course map unavailable', courseKey: key, error: error && error.message || String(error || '') });
      throw error;
    }
  }

  async function flush(reason) {
    if (flushing) return lastStatus;
    var payloads = pendingPayloads();
    if (!payloads.length) {
      setStatus({ state: 'idle', error: '', pushed: 0 });
      return lastStatus;
    }
    flushing = true;
    setStatus({ state: 'syncing', reason: reason || 'manual', error: '' });
    var who = identity();
    var meta = readMeta();
    var pushedCount = 0;
    try {
      for (var i = 0; i < payloads.length; i += MAX_SCANS_PER_PUSH) {
        var chunk = payloads.slice(i, i + MAX_SCANS_PER_PUSH);
        await post({
          action: 'push_scans',
          accountId: who.accountId,
          playerId: who.playerId,
          reason: reason || 'manual',
          scans: chunk
        });
        chunk.forEach(function (payload) {
          meta.pushed[payload.client_scan_id] = String(payload.updated_at || new Date().toISOString());
        });
        pushedCount += chunk.length;
        meta.lastPushAt = new Date().toISOString();
        writeJson(META_KEY, meta);
      }
      writeJson(OUTBOX_KEY, []);
      setStatus({ state: 'synced', error: '', pushed: pushedCount });
    } catch (error) {
      meta.lastError = error && error.message || String(error || '');
      meta.lastErrorAt = new Date().toISOString();
      writeJson(META_KEY, meta);
      setStatus({ state: 'error', error: meta.lastError, pushed: pushedCount });
    } finally {
      flushing = false;
    }
    return lastStatus;
  }

  function scheduleFlush(reason) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () {
      flush(reason).catch(function () {});
    }, PUSH_DEBOUNCE_MS);
  }

  function hookWriteScan() {
    var original = window.gdCapturedSurfaceWriteScan;
    if (typeof original !== 'function' || original.__gdCapturedSurfaceSyncWrapped) return typeof original === 'function';
    function wrapped(manifest, opts) {
      var result = original(manifest, opts);
      safe(function () {
        if (typeof window.gdQueueCapturedSurfaceSupabasePayload === 'function' && window.gdCapturedSurfaceActiveScan) {
          window.gdQueueCapturedSurfaceSupabasePayload(window.gdCapturedSurfaceActiveScan);
        }
      });
      scheduleFlush('scan-write');
      return result;
    }
    wrapped.__gdCapturedSurfaceSyncWrapped = true;
    window.gdCapturedSurfaceWriteScan = wrapped;
    return true;
  }

  function install() {
    if (!hookWriteScan()) {
      // Model script not ready yet; retry briefly.
      [400, 1200, 3000].forEach(function (ms) { setTimeout(hookWriteScan, ms); });
    }
    setTimeout(function () { flush('startup').catch(function () {}); }, 2500);
    window.addEventListener('online', function () { flush('online').catch(function () {}); });
    window.addEventListener('clarity:session-changed', function () { scheduleFlush('session-changed'); });
  }

  window.GolfDaddyCapturedSurfaceSync = {
    flush: flush,
    pullCourse: pullCourse,
    importPulledScans: importPulledScans,
    status: function () { return lastStatus; },
    pending: pendingPayloads
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
