// Two-browser simulation for the Shot Library Supabase sync.
// Run: node dev/shot-library-sync-harness.test.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- Mock "Supabase" (mimics functions/shot-library-sync.js semantics) ----
const cloud = new Map(); // importBatchId -> row

function serverHandle(payload) {
  if (payload.action === 'push_batches') {
    let upserted = 0;
    (payload.batches || []).forEach((row) => {
      const existing = cloud.get(row.importBatchId);
      const incomingTime = Date.parse(row.clientUpdatedAt) || 0;
      const knownTime = existing ? (Date.parse(existing.clientUpdatedAt) || 0) : 0;
      if (existing && incomingTime < knownTime) return;
      cloud.set(row.importBatchId, {
        importBatchId: row.importBatchId,
        playerId: payload.playerId,
        accountId: payload.accountId,
        playerName: payload.playerName || '',
        status: row.status,
        payload: row.payload,
        clientUpdatedAt: row.clientUpdatedAt,
        deletedAt: row.deletedAt || '',
        deletedBy: row.deletedBy || '',
        updatedAt: new Date().toISOString()
      });
      upserted += 1;
    });
    return { synced: true, upserted, serverTime: new Date().toISOString() };
  }
  if (payload.action === 'pull') {
    const since = Date.parse(payload.since || '') || 0;
    const batches = [...cloud.values()].filter((row) =>
      (row.playerId === payload.playerId || row.accountId === payload.accountId) &&
      (Date.parse(row.updatedAt) || 0) > since
    );
    return { synced: true, batches, serverTime: new Date().toISOString() };
  }
  return { synced: false, error: 'unsupported' };
}

// ---- Minimal browser environment ----
function makeBrowser(name) {
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  const win = {
    localStorage,
    addEventListener: () => {},
    dispatchEvent: () => {},
    fetch: async (url, opts) => {
      const body = serverHandle(JSON.parse(opts.body));
      return { ok: true, json: async () => body };
    }
  };
  win.window = win;
  win.document = {
    readyState: 'complete',
    visibilityState: 'visible',
    addEventListener: () => {},
    getElementById: () => null
  };
  win.console = console;
  win.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
  win.setTimeout = (fn) => { win.__pending = win.__pending || []; win.__pending.push(fn); return 1; };
  win.clearTimeout = () => {};
  win.setInterval = () => 1;
  win.clearInterval = () => {};
  win.Date = Date; win.Math = Math; win.JSON = JSON; win.Number = Number;
  win.Object = Object; win.Array = Array; win.String = String; win.Promise = Promise;

  const ctx = vm.createContext(win);
  const load = (file) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), ctx, { filename: file });
  load('scripts/gd-launch-monitor-data.js');
  load('scripts/gd-shot-library-sync.js');
  // Fake an active player profile so scope resolves.
  win.GolfDaddyProfiles = { active: () => ({ id: 'player-1', name: 'Sam', accountId: 'acct-1' }) };
  win.__name = name;
  return win;
}

function shotCount(win) {
  return win.GolfDaddyLaunchMonitorData.getScopedStore().shots.length;
}

async function sync(win) {
  await win.ClarityShotLibrarySync.syncNow('test');
}

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else { console.log('ok  -', msg); }
};

(async () => {
  const A = makeBrowser('A');
  const B = makeBrowser('B');

  // 1. Browser A imports a capture locally.
  const imported = A.GolfDaddyLaunchMonitorData.importCapture({
    label: 'Range session',
    inputType: 'clarity-table-ocr',
    clubGroups: [
      { candidateClub: '7i', metrics: [{ candidateMetric: 'carryDistance', value: 150, confidence: 0.9 }, { candidateMetric: 'offline', value: 3, confidence: 0.9 }] },
      { candidateClub: '7i', metrics: [{ candidateMetric: 'carryDistance', value: 152, confidence: 0.9 }, { candidateMetric: 'offline', value: -2, confidence: 0.9 }] }
    ]
  });
  assert(shotCount(A) === 2 && shotCount(B) === 0, 'A has 2 local shots, B empty before sync');

  // 2. A syncs (push), B syncs (pull) -> B gets the library.
  await sync(A);
  assert(cloud.size === 1, 'cloud holds 1 batch after A push');
  await sync(B);
  assert(shotCount(B) === 2, 'B pulled the 2 shots (union merge)');

  // 3. Steady state: nothing changes on repeat sync.
  const beforeB = B.localStorage.getItem('gd_launch_monitor_data_v1');
  await sync(B);
  assert(shotCount(B) === 2, 'repeat sync is stable (no duplicates)');

  // 4. B deletes the import (soft delete) -> tombstone -> A drops it.
  await new Promise((r) => setTimeout(r, 1100)); // ensure newer clientUpdatedAt
  B.GolfDaddyLaunchMonitorData.deletePracticeImport(imported.session.importBatchId);
  assert(shotCount(B) === 0, 'B soft-deleted the import locally');
  await sync(B);
  await sync(A);
  assert(shotCount(A) === 0, 'delete propagated to A via tombstone');

  // 5. Both browsers import independently -> union keeps both.
  A.GolfDaddyLaunchMonitorData.importCapture({
    label: 'A only', inputType: 'clarity-table-ocr',
    clubGroups: [{ candidateClub: 'Driver', metrics: [{ candidateMetric: 'carryDistance', value: 240, confidence: 0.9 }, { candidateMetric: 'offline', value: 10, confidence: 0.9 }] }]
  });
  B.GolfDaddyLaunchMonitorData.importCapture({
    label: 'B only', inputType: 'clarity-table-ocr',
    clubGroups: [{ candidateClub: 'PW', metrics: [{ candidateMetric: 'carryDistance', value: 110, confidence: 0.9 }, { candidateMetric: 'offline', value: 1, confidence: 0.9 }] }]
  });
  await sync(A); await sync(B); await sync(A);
  assert(shotCount(A) === 2 && shotCount(B) === 2, 'union merge: both browsers converge on both imports');

  console.log(process.exitCode ? '\nHARNESS FAILED' : '\nALL SYNC HARNESS CHECKS PASSED');
})();
