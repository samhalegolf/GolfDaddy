(function () {
  'use strict';

  // Clarity Captured Surface -> Supabase sync (push-only v1).
  //
  // The captured-surface model (index.html, gdCapturedSurfaceModelV1) keeps a
  // localStorage registry of hole surface scans and has always queued Supabase
  // payloads into an outbox that nothing ever sent. This script actually sends
  // them: on scan writes (debounced), on startup, when the connection returns,
  // and when the session changes.
  //
  // Registry stays the working copy. Cloud is a backup + diagnostics mirror;
  // nothing is pulled back into the registry in v1, so the locked Green Wand /
  // capture pipeline behaviour is untouched.

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

  function scanToPayload(scan) {
    if (!scan || !scan.id) return null;
    return {
      client_scan_id: scan.id,
      course_key: scan.courseKey,
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
    status: function () { return lastStatus; },
    pending: pendingPayloads
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
