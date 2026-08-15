(function () {
  'use strict';

  // Clarity Shot Library <-> Supabase sync.
  //
  // localStorage (gd_launch_monitor_data_v1) stays as a cache so the practice
  // graph renders instantly and stays steady between sessions. Supabase is the
  // source of truth: on startup we push local changes, pull the cloud copy,
  // union-merge it into the cache, and refresh the UI only if data changed.
  //
  // Sync unit: one "import batch" (session + capture + shots + rejects that
  // share an importBatchId / sessionId). Per batch, last write wins based on
  // clientUpdatedAt. Whole-batch deletes propagate as tombstones.

  var ENDPOINT = '/api/shot-library-sync';
  var META_KEY = 'gd_shot_library_sync_v1';
  var UPDATE_EVENT = 'clarity:shot-library-updated';
  var PUSH_DEBOUNCE_MS = 1200;
  var PULL_INTERVAL_MS = 4 * 60 * 1000;
  var PULL_OVERLAP_MS = 60 * 1000;
  var COLLECTIONS = ['sessions', 'captures', 'shots', 'rejects'];

  var pushTimer = null;
  var pullTimer = null;
  var syncing = false;
  var lastStatus = { state: 'idle', at: '', error: '' };

  function safe(fn, fallback) {
    try { return fn(); } catch (error) { return fallback; }
  }

  function api() {
    return window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData || null;
  }

  function storageKey() {
    var lib = api();
    return lib && lib.storageKey || 'gd_launch_monitor_data_v1';
  }

  function readStore() {
    var store = safe(function () { return JSON.parse(window.localStorage.getItem(storageKey()) || 'null'); }, null) || {};
    COLLECTIONS.forEach(function (name) {
      store[name] = Array.isArray(store[name]) ? store[name] : [];
    });
    store.version = store.version || 1;
    return store;
  }

  function writeStore(store) {
    store.updatedAt = new Date().toISOString();
    safe(function () { window.localStorage.setItem(storageKey(), JSON.stringify(store)); });
  }

  function readMeta() {
    var meta = safe(function () { return JSON.parse(window.localStorage.getItem(META_KEY) || 'null'); }, null) || {};
    meta.players = meta.players && typeof meta.players === 'object' ? meta.players : {};
    return meta;
  }

  function writeMeta(meta) {
    safe(function () { window.localStorage.setItem(META_KEY, JSON.stringify(meta)); });
  }

  function activeScope() {
    var lib = api();
    var scope = lib && typeof lib.activePlayerScope === 'function' ? safe(function () { return lib.activePlayerScope(); }, null) : null;
    return scope || { playerId: '', playerName: 'Player', accountId: '' };
  }

  function scopeKey(scope) {
    return String(scope.playerId || scope.accountId || '').trim();
  }

  function playerMeta(meta, key) {
    meta.players[key] = meta.players[key] && typeof meta.players[key] === 'object' ? meta.players[key] : {};
    var entry = meta.players[key];
    entry.batches = entry.batches && typeof entry.batches === 'object' ? entry.batches : {};
    entry.lastPulledAt = entry.lastPulledAt || '';
    return entry;
  }

  function itemPlayerId(item) {
    return String(item && (item.playerId || item.profileId || item.playerProfileId) || '').trim();
  }

  function itemInScope(item, scope) {
    if (!scope.playerId) return true;
    return itemPlayerId(item) === scope.playerId;
  }

  function batchId(item) {
    return String(item && (item.importBatchId || item.importId || item.sessionId) || '').trim();
  }

  function hashString(value) {
    var hash = 5381;
    for (var i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) + hash + value.charCodeAt(i)) & 0xffffffff;
    }
    return String(hash >>> 0) + ':' + value.length;
  }

  function collectBatches(store, scope) {
    var batches = {};
    COLLECTIONS.forEach(function (name) {
      (store[name] || []).forEach(function (item) {
        if (!item || !itemInScope(item, scope)) return;
        var id = batchId(item);
        if (!id) return;
        batches[id] = batches[id] || { sessions: [], captures: [], shots: [], rejects: [] };
        batches[id][name].push(item);
      });
    });
    return batches;
  }

  function batchIsDeleted(batch) {
    var records = [];
    COLLECTIONS.forEach(function (name) { records = records.concat(batch[name] || []); });
    if (!records.length) return true;
    return records.every(function (item) {
      return String(item && item.status || 'active').toLowerCase() === 'deleted';
    });
  }

  function batchDeleteMeta(batch) {
    var deletedAt = '';
    var deletedBy = '';
    COLLECTIONS.forEach(function (name) {
      (batch[name] || []).forEach(function (item) {
        if (item && item.deletedAt && String(item.deletedAt) > deletedAt) {
          deletedAt = String(item.deletedAt);
          deletedBy = String(item.deletedBy || '');
        }
      });
    });
    return { deletedAt: deletedAt || new Date().toISOString(), deletedBy: deletedBy || 'sync' };
  }

  function batchHash(batch) {
    return hashString(JSON.stringify({
      sessions: batch.sessions,
      captures: batch.captures,
      shots: batch.shots,
      rejects: batch.rejects
    }));
  }

  function removeBatchFromStore(store, id, scope) {
    var removed = false;
    COLLECTIONS.forEach(function (name) {
      store[name] = (store[name] || []).filter(function (item) {
        var match = !!item && batchId(item) === id && itemInScope(item, scope);
        if (match) removed = true;
        return !match;
      });
    });
    return removed;
  }

  function insertBatchIntoStore(store, payload) {
    COLLECTIONS.forEach(function (name) {
      var rows = payload && Array.isArray(payload[name]) ? payload[name] : [];
      rows.forEach(function (item) {
        if (item && typeof item === 'object') store[name].push(item);
      });
    });
  }

  function setStatus(state, error) {
    lastStatus = { state: state, at: new Date().toISOString(), error: error ? String(error.message || error) : '' };
    safe(function () {
      window.dispatchEvent(new CustomEvent('clarity:shot-library-sync-status', { detail: lastStatus }));
    });
  }

  function notifyUpdated() {
    safe(function () {
      window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: { at: new Date().toISOString() } }));
    });
    /* The player's shots just changed, so the Bubble model built from them is
       now out of date. This is the ONLY trigger the Micro-Geometry engine
       wants: analysis follows the data, never a screen opening.
       onPracticeDataSaved() never throws, never blocks, and the phone carries
       on rendering its cached model while the rebuild happens. */
    safe(function () {
      var model = window.GDBubbleModelClient;
      if (model && typeof model.onPracticeDataSaved === 'function') model.onPracticeDataSaved();
    });
    // Mirror the app's own refresh pattern: only re-render when the practice
    // panel is open, so we never disturb an unrelated screen.
    safe(function () {
      var panel = document.getElementById('practiceDataPanel');
      if (panel && panel.classList.contains('open') && typeof window.renderPracticeData === 'function') {
        window.renderPracticeData(true);
      }
    });
  }

  async function post(payload) {
    var response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok || body.synced === false) {
      var error = new Error(body.error || 'Shot library sync failed');
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function pendingBatches(scope, meta) {
    var key = scopeKey(scope);
    var entry = playerMeta(meta, key);
    var store = readStore();
    var local = collectBatches(store, scope);
    var out = [];
    var now = new Date().toISOString();

    Object.keys(local).forEach(function (id) {
      var hash = batchHash(local[id]);
      var known = entry.batches[id];
      if (known && known.hash === hash) return;
      var changedAt = known && known.hash !== hash ? now : (known && known.changedAt) || now;
      var deleted = batchIsDeleted(local[id]);
      var del = deleted ? batchDeleteMeta(local[id]) : null;
      out.push({
        importBatchId: id,
        status: deleted ? 'deleted' : 'active',
        payload: local[id],
        clientUpdatedAt: changedAt,
        deletedAt: del ? del.deletedAt : '',
        deletedBy: del ? del.deletedBy : '',
        _hash: hash
      });
    });

    // Batches we synced before that vanished locally (hard shot/capture
    // deletes compact them away) become tombstones so other browsers drop
    // them too instead of resurrecting them on the next pull.
    Object.keys(entry.batches).forEach(function (id) {
      if (local[id]) return;
      if (entry.batches[id] && entry.batches[id].tombstoned) return;
      out.push({
        importBatchId: id,
        status: 'deleted',
        payload: {},
        clientUpdatedAt: now,
        deletedAt: now,
        deletedBy: key || 'local',
        _hash: 'tombstone'
      });
    });

    return out;
  }

  async function pushChanges(scope) {
    var meta = readMeta();
    var key = scopeKey(scope);
    if (!key) return { pushed: 0 };
    var entry = playerMeta(meta, key);
    var batches = pendingBatches(scope, meta);
    if (!batches.length) return { pushed: 0 };

    var body = batches.map(function (batch) {
      return {
        importBatchId: batch.importBatchId,
        status: batch.status,
        payload: batch.payload,
        clientUpdatedAt: batch.clientUpdatedAt,
        deletedAt: batch.deletedAt,
        deletedBy: batch.deletedBy
      };
    });

    await post({
      action: 'push_batches',
      playerId: scope.playerId,
      playerName: scope.playerName,
      accountId: scope.accountId,
      batches: body
    });

    batches.forEach(function (batch) {
      entry.batches[batch.importBatchId] = {
        hash: batch._hash,
        changedAt: batch.clientUpdatedAt,
        tombstoned: batch._hash === 'tombstone'
      };
    });
    writeMeta(meta);
    return { pushed: batches.length };
  }

  async function pullChanges(scope) {
    var meta = readMeta();
    var key = scopeKey(scope);
    if (!key) return { merged: 0 };
    var entry = playerMeta(meta, key);

    var result = await post({
      action: 'pull',
      playerId: scope.playerId,
      accountId: scope.accountId,
      since: entry.lastPulledAt || ''
    });

    var remote = Array.isArray(result.batches) ? result.batches : [];
    var changed = 0;

    if (remote.length) {
      var store = readStore();
      var local = collectBatches(store, scope);

      remote.forEach(function (row) {
        var id = String(row.importBatchId || '').trim();
        if (!id) return;
        var remoteTime = Date.parse(row.clientUpdatedAt || '') || 0;
        var known = entry.batches[id];
        var localTime = known ? (Date.parse(known.changedAt || '') || 0) : 0;
        var existsLocally = !!local[id];

        if (row.status === 'deleted') {
          if (existsLocally && remoteTime >= localTime) {
            if (removeBatchFromStore(store, id, scope)) changed += 1;
            entry.batches[id] = { hash: 'tombstone', changedAt: row.clientUpdatedAt || new Date().toISOString(), tombstoned: true };
          } else if (!existsLocally) {
            entry.batches[id] = { hash: 'tombstone', changedAt: row.clientUpdatedAt || new Date().toISOString(), tombstoned: true };
          }
          return;
        }

        if (!existsLocally) {
          // Never resurrect a batch this browser already tombstoned more recently.
          if (known && known.tombstoned && localTime > remoteTime) return;
          insertBatchIntoStore(store, row.payload);
          changed += 1;
        } else if (remoteTime > localTime) {
          removeBatchFromStore(store, id, scope);
          insertBatchIntoStore(store, row.payload);
          changed += 1;
        } else {
          return;
        }

        var merged = collectBatches(store, scope)[id];
        entry.batches[id] = {
          hash: merged ? batchHash(merged) : 'tombstone',
          changedAt: row.clientUpdatedAt || new Date().toISOString(),
          tombstoned: !merged
        };
      });

      if (changed) writeStore(store);
    }

    var serverTime = Date.parse(result.serverTime || '') || Date.now();
    entry.lastPulledAt = new Date(serverTime - PULL_OVERLAP_MS).toISOString();
    writeMeta(meta);

    if (changed) notifyUpdated();
    return { merged: changed };
  }

  async function syncNow(reason) {
    var scope = activeScope();
    if (!scopeKey(scope)) {
      setStatus('signed_out');
      return lastStatus;
    }
    if (syncing) return lastStatus;
    syncing = true;
    setStatus('checking');
    try {
      await pushChanges(scope);
      await pullChanges(scope);
      setStatus('synced');
    } catch (error) {
      setStatus('pending', error);
      if (reason !== 'startup' && reason !== 'interval') {
        console.warn('[Clarity] shot library sync failed', error);
      }
    } finally {
      syncing = false;
    }
    return lastStatus;
  }

  function schedulePush() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      syncNow('mutation').catch(function () {});
    }, PUSH_DEBOUNCE_MS);
  }

  function wrapMutations(lib) {
    if (!lib || lib.__claritySyncWrapped) return;
    ['importCapture', 'deleteShots', 'deleteCaptures', 'deletePracticeImport', 'deleteSelectedPracticeImports', 'clearPracticeLibraryForPlayer', 'clearStore'].forEach(function (name) {
      var original = lib[name];
      if (typeof original !== 'function') return;
      lib[name] = function () {
        var result = original.apply(this, arguments);
        schedulePush();
        return result;
      };
    });
    lib.__claritySyncWrapped = true;
  }

  function startPullTimer() {
    if (pullTimer) clearInterval(pullTimer);
    pullTimer = setInterval(function () {
      if (document.visibilityState === 'visible') syncNow('interval').catch(function () {});
    }, PULL_INTERVAL_MS);
  }

  function init() {
    var lib = api();
    if (!lib) {
      // Library script may be lazy-loaded; wait for it.
      setTimeout(init, 400);
      return;
    }
    wrapMutations(lib);
    startPullTimer();
    setTimeout(function () { syncNow('startup').catch(function () {}); }, 900);
  }

  window.addEventListener('online', function () { syncNow('online').catch(function () {}); });
  window.addEventListener('clarity:session-changed', function () {
    setTimeout(function () { syncNow('session-changed').catch(function () {}); }, 500);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') syncNow('visibility').catch(function () {});
  });

  window.ClarityShotLibrarySync = {
    syncNow: syncNow,
    status: function () { return lastStatus; },
    updateEvent: UPDATE_EVENT
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
