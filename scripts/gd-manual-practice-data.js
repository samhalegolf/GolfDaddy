/* Manual Practice: the draft store, the session lifecycle and the lane UI.
 *
 * What lives here is only what has to: observations a player is still plotting,
 * which session is being worked on, and the coach's trusted override. The
 * moment a session is finished its evidence leaves this file for good - it goes
 * through the seam in gd-manual-practice-core.js into the Shot Library
 * (gd-launch-monitor-data.js), which is the durable, Supabase-synced store the
 * rest of Practice already uses. Nothing analyses anything here.
 *
 * localStorage (gd_manual_practice_v1) is a work-in-progress cache and nothing
 * more: a half-plotted session survives a reload, and finished evidence is not
 * in it.
 */
(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var core = window.GolfDaddyManualPracticeCore || window.ClarityCaddieManualPracticeCore;
  var STORAGE_KEY = 'gd_manual_practice_v1';
  var STORE_VERSION = 2;
  var CLUB_FALLBACKS = ['LW', 'SW', 'GW', 'PW', '9i', '8i', '7i', '6i', '5i', '4i', '3w', 'Driver'];

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (error) {
      return fallback;
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function cleanString(value, fallback) {
    var text = String(value == null ? '' : value).trim();
    return text || String(fallback == null ? '' : fallback).trim();
  }

  function asNumber(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function launchMonitorApi() {
    return window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData || null;
  }

  // === Ownership ============================================================
  //
  // Strict, and deliberately fails closed. An unscoped Manual Practice session
  // is how a coach looking at Player A ends up appending observations to
  // Player B, or to a local session that belongs to nobody. If there is no
  // player, there is no read and no write.

  function activePlayerScope() {
    var lm = launchMonitorApi();
    if (lm && typeof lm.activePlayerScope === 'function') {
      var scope = safe(function () { return lm.activePlayerScope(); }, null);
      if (scope) return scope;
    }
    var session = safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.get === 'function' ? window.ClaritySession.get() : null;
    }, null) || {};
    return {
      playerId: cleanString(session.viewedProfileId || session.profileId, ''),
      playerName: cleanString(session.accountName, 'Player'),
      accountId: cleanString(session.accountId, '')
    };
  }

  function activePlayerId() {
    return cleanString(activePlayerScope().playerId, '');
  }

  function hasPlayerScope() {
    return !!activePlayerId();
  }

  // === Admin gate ===========================================================
  //
  // Manual Practice is admin-only while it is being proven out. This is the one
  // choke point: every public entry point below goes through gated(), so the
  // rollout to coaches and then players is a change to isAdminUser() alone.

  function accountPermission() {
    return cleanString(safe(function () {
      return typeof window.gdGetAccountPermission === 'function' ? window.gdGetAccountPermission() : '';
    }, ''), '').toLowerCase();
  }

  function isStaff() {
    var permission = accountPermission();
    if (permission === 'admin' || permission === 'coach') return true;
    return !!safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.isStaff === 'function' ? window.ClaritySession.isStaff() : false;
    }, false);
  }

  function isAdminUser() {
    return accountPermission() === 'admin';
  }

  /* Wraps an entry point in the two rules that must never be skipped: the
     rollout gate, and a player to own the data. */
  function gated(fn, fallback) {
    return function () {
      if (!isAdminUser() || !hasPlayerScope()) return fallback;
      return fn.apply(null, arguments);
    };
  }

  // === Store ================================================================

  function defaultStore() {
    return {
      version: STORE_VERSION,
      sessions: [],
      activeSessionId: '',
      overrides: {},
      updatedAt: nowIso()
    };
  }

  /* v1 kept every session in one list with no status and a `preview` pointer at
     a generated analysis. There is no preview any more (manual evidence sits in
     the Practice Library beside every other import), so a v1 session that had
     produced a result is read as completed and everything else as a draft. */
  function migrateStore(parsed) {
    if (!parsed || typeof parsed !== 'object') return defaultStore();
    var store = {
      version: STORE_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      activeSessionId: cleanString(parsed.activeSessionId, ''),
      overrides: parsed.overrides && typeof parsed.overrides === 'object' ? parsed.overrides : {},
      updatedAt: parsed.updatedAt || nowIso()
    };
    store.sessions = store.sessions.map(function (session) {
      var next = Object.assign({}, session);
      next.observations = Array.isArray(next.observations) ? next.observations : [];
      if (!next.status) next.status = Array.isArray(next.results) && next.results.length ? 'completed' : 'draft';
      if (next.status === 'completed' && !next.completedAt) next.completedAt = next.generatedAt || next.updatedAt || next.createdAt || nowIso();
      /* v1 results were parallel analysis objects. They are not evidence and
         nothing reads them now, so they are dropped rather than migrated. */
      delete next.results;
      return next;
    });
    return store;
  }

  function readStore() {
    return safe(function () {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return migrateStore(raw ? JSON.parse(raw) : null);
    }, defaultStore());
  }

  function writeStore(store) {
    store = store || defaultStore();
    store.version = STORE_VERSION;
    store.sessions = Array.isArray(store.sessions) ? store.sessions : [];
    store.overrides = store.overrides && typeof store.overrides === 'object' ? store.overrides : {};
    store.updatedAt = nowIso();
    safe(function () {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    });
    return store;
  }

  /* Strict scope. An empty player id matches nothing - it never means "all". */
  function playerSessions(store, playerId) {
    var id = cleanString(playerId, activePlayerId());
    if (!id) return [];
    return (store.sessions || []).filter(function (session) {
      return cleanString(session && session.playerId, '') === id;
    });
  }

  // === Session lifecycle ====================================================

  function createSession(store) {
    var scope = activePlayerScope();
    var timestamp = nowIso();
    var session = {
      sessionId: createId('manual-practice-session'),
      playerId: cleanString(scope.playerId, ''),
      playerName: cleanString(scope.playerName, 'Player'),
      accountId: cleanString(scope.accountId, ''),
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: '',
      status: 'draft',
      selectedClubId: '7i',
      nextClassification: 'representative',
      geometryPresetId: null,
      reviewOpen: false,
      source: 'manual_practice',
      observations: []
    };
    store.sessions.push(session);
    store.activeSessionId = session.sessionId;
    writeStore(store);
    return session;
  }

  /* The session being worked on right now: the one the store points at, still a
     draft, still this player's. Finishing clears the pointer, which is what
     stops every future shot from landing in an already-generated session. */
  function findActiveSession(store) {
    var id = cleanString(store.activeSessionId, '');
    if (!id) return null;
    return playerSessions(store).find(function (session) {
      return cleanString(session.sessionId, '') === id && cleanString(session.status, 'draft') === 'draft';
    }) || null;
  }

  function activeSession() {
    return findActiveSession(readStore());
  }

  function ensureSession() {
    var store = readStore();
    return findActiveSession(store) || createSession(store);
  }

  function startNewSession() {
    var store = readStore();
    var current = findActiveSession(store);
    /* An untouched draft is reused rather than piling up empty sessions. */
    if (current && !(current.observations || []).length) return current;
    store.activeSessionId = '';
    writeStore(store);
    return createSession(readStore());
  }

  /* Every mutation goes through here, and every mutation targets the draft. A
     completed session is evidence in the Practice Library; it is not editable
     from this side any more. */
  function saveSession(mutator) {
    var store = readStore();
    /* createSession pushes into this same store and persists it, so the object
       it hands back is the one sitting in store.sessions. */
    var session = findActiveSession(store) || createSession(store);
    if (!session) return null;
    session.observations = Array.isArray(session.observations) ? session.observations : [];
    mutator(session, store);
    session.updatedAt = nowIso();
    writeStore(store);
    return session;
  }

  function listSessions() {
    return playerSessions(readStore()).slice().sort(function (a, b) {
      return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
    });
  }

  function getSessionById(sessionId) {
    var target = cleanString(sessionId, '');
    return playerSessions(readStore()).find(function (session) {
      return cleanString(session.sessionId, '') === target;
    }) || null;
  }

  // === Observations =========================================================

  function addClubObservation(point) {
    point = point || {};
    return saveSession(function (session) {
      var timestamp = nowIso();
      session.observations.push({
        observationId: createId('manual-observation'),
        clubId: cleanString(point.clubId || session.selectedClubId, session.selectedClubId || '7i'),
        x: Math.max(-1, Math.min(1, Number(point.x) || 0)),
        y: Math.max(-1, Math.min(1, Number(point.y) || 0)),
        classification: cleanString(point.classification || session.nextClassification, 'representative').toLowerCase() === 'disrupted'
          ? 'disrupted'
          : 'representative',
        sequence: (session.observations || []).length + 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        source: 'manual_practice'
      });
    });
  }

  function removeObservation(observationId) {
    return saveSession(function (session) {
      session.observations = (session.observations || []).filter(function (observation) {
        return cleanString(observation.observationId, '') !== cleanString(observationId, '');
      });
    });
  }

  function updateObservation(observationId, patch) {
    patch = patch || {};
    return saveSession(function (session) {
      session.observations = (session.observations || []).map(function (observation) {
        if (cleanString(observation.observationId, '') !== cleanString(observationId, '')) return observation;
        return Object.assign({}, observation, {
          classification: patch.classification
            ? (cleanString(patch.classification, 'representative').toLowerCase() === 'disrupted' ? 'disrupted' : 'representative')
            : observation.classification,
          updatedAt: nowIso()
        });
      });
    });
  }

  function clearClub(clubId) {
    var target = cleanString(clubId, '');
    return saveSession(function (session) {
      session.observations = (session.observations || []).filter(function (observation) {
        return cleanString(observation.clubId, '') !== target;
      });
    });
  }

  function undoLastShot() {
    return saveSession(function (session) {
      session.observations.pop();
    });
  }

  function setSelectedClub(clubId) {
    return saveSession(function (session) {
      session.selectedClubId = cleanString(clubId, session.selectedClubId || '7i');
    });
  }

  function setNextClassification(classification) {
    return saveSession(function (session) {
      session.nextClassification = cleanString(classification, 'representative').toLowerCase() === 'disrupted'
        ? 'disrupted'
        : 'representative';
    });
  }

  function setReviewOpen(open) {
    return saveSession(function (session) {
      session.reviewOpen = !!open;
    });
  }

  // === Calibration deps =====================================================
  //
  // The three app functions the plot -> metres conversion is allowed to read,
  // injected rather than reached for so the seam runs headlessly in tests.

  function calibrationDeps() {
    return {
      clubBaselineM: function (club) {
        return safe(function () {
          return typeof window.gdClarityClubBaselineM === 'function' ? window.gdClarityClubBaselineM(club) : NaN;
        }, NaN);
      },
      generatedBubbleForClub: function (club, carryM, offsetDeg) {
        return safe(function () {
          return typeof window.gdGeneratedShotBubbleForClub === 'function'
            ? window.gdGeneratedShotBubbleForClub(club, carryM, offsetDeg)
            : null;
        }, null);
      },
      metricForKey: function (key, value) {
        return safe(function () {
          return typeof window.gdLmMetricForKey === 'function' ? window.gdLmMetricForKey(key, value, { strict: false }) : null;
        }, null);
      }
    };
  }

  function plotCalibration(club) {
    if (!core) return null;
    return core.resolveManualPracticePlotCalibration(club, calibrationDeps());
  }

  // === Finishing a session ==================================================

  /* Converts the draft's observations into canonical Practice evidence and
     hands them to the Shot Library. After this the session is closed: the
     pointer is cleared, so the next plotted shot starts a new one. */
  function finishSession(options) {
    options = options || {};
    var lm = launchMonitorApi();
    if (!core || !lm || typeof lm.importCapture !== 'function') {
      return { ok: false, reason: 'practice_library_unavailable' };
    }
    var store = readStore();
    var session = findActiveSession(store);
    if (!session) return { ok: false, reason: 'no_active_session' };
    if (!(session.observations || []).length) return { ok: false, reason: 'no_observations' };

    var payload = core.manualSessionToLibraryPayload(session, Object.assign({
      label: cleanString(options.label, 'Manual Practice - ' + new Date().toLocaleDateString())
    }, calibrationDeps()));
    var importBatchId = createId('manual-practice-import');
    var imported = safe(function () {
      return lm.importCapture(Object.assign({}, payload, {
        importBatchId: importBatchId,
        playerId: session.playerId,
        playerName: session.playerName,
        accountId: session.accountId
      }));
    }, null);
    if (!imported) return { ok: false, reason: 'import_failed' };

    session.status = 'completed';
    session.completedAt = nowIso();
    session.updatedAt = session.completedAt;
    session.importBatchId = importBatchId;
    session.captureId = imported.capture && imported.capture.captureId || '';
    session.librarySessionId = imported.session && imported.session.sessionId || '';
    session.shotCount = (imported.shots || []).length;
    session.calibrations = payload.calibrations || {};
    store.activeSessionId = '';
    writeStore(store);
    return { ok: true, session: session, imported: imported, payload: payload };
  }

  // === Trusted coach override ===============================================
  //
  // Narrow on purpose: a club and an offset. It restates the anchor on the
  // canonical analysis and reaches My Bubble down the same path every other
  // Practice result does. It is not shot evidence, so it is not stored in the
  // Practice Library - it lives here, per player, stamped with who set it.

  function overrideKey(playerId) {
    return cleanString(playerId, activePlayerId());
  }

  function activeOverride() {
    var id = overrideKey();
    if (!id) return null;
    var stored = readStore().overrides[id];
    return stored && Number.isFinite(Number(stored.offsetDeg)) ? stored : null;
  }

  function setTrustedOverride(input) {
    input = input || {};
    var offsetDeg = asNumber(input.offsetDeg, NaN);
    if (!Number.isFinite(offsetDeg)) return null;
    if (!isStaff()) return null;
    var id = overrideKey();
    if (!id) return null;
    var scope = activePlayerScope();
    var store = readStore();
    store.overrides[id] = {
      source: 'coach_manual_override',
      playerId: id,
      club: cleanString(input.clubId || input.club, ''),
      offsetDeg: Math.round(offsetDeg * 100) / 100,
      geometryPresetId: input.geometryPresetId == null ? null : input.geometryPresetId,
      createdAt: nowIso(),
      createdBy: cleanString(scope.accountId, ''),
      createdByRole: accountPermission() || 'staff'
    };
    writeStore(store);
    return store.overrides[id];
  }

  function clearTrustedOverride() {
    var id = overrideKey();
    if (!id) return false;
    var store = readStore();
    if (!store.overrides[id]) return false;
    delete store.overrides[id];
    writeStore(store);
    return true;
  }

  /* The Practice screen's one call into this module. Everything else it draws
     comes from the canonical analysis. */
  function applyTrustedOverride(analysis) {
    if (!analysis || !core || !isAdminUser() || !hasPlayerScope()) return analysis;
    var override = activeOverride();
    if (!override) return analysis;
    return core.applyTrustedOverrideToAnalysis(analysis, override);
  }

  // === Lane UI ==============================================================

  function clubOptions() {
    var rows = safe(function () {
      return typeof window.gdBagSourceRows === 'function' ? window.gdBagSourceRows() : [];
    }, []) || [];
    var all = [];
    rows.map(function (row) { return cleanString(row && row.club, ''); })
      .filter(Boolean)
      .concat(CLUB_FALLBACKS)
      .forEach(function (club) {
        if (club && all.indexOf(club) === -1) all.push(club);
      });
    return all;
  }

  function sessionSummary(session) {
    session = session || activeSession();
    var groups = {};
    ((session && session.observations) || []).forEach(function (observation) {
      var club = cleanString(observation.clubId, 'Unknown');
      groups[club] = groups[club] || { club: club, total: 0, representative: 0, disrupted: 0 };
      groups[club].total += 1;
      if (cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted') groups[club].disrupted += 1;
      else groups[club].representative += 1;
    });
    return Object.keys(groups).sort(function (a, b) {
      return a.localeCompare(b, undefined, { numeric: true });
    }).map(function (key) { return groups[key]; });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }

  function plotScaleMarkup(calibration) {
    var lateralM = calibration ? Math.round(calibration.lateralHalfSpanM) : 0;
    var depthM = calibration ? Math.round(calibration.depthHalfSpanM) : 0;
    if (!(lateralM > 0) || !(depthM > 0)) return '';
    return [
      '<div class="gdManualPracticeGridline gdManualPracticeGridlineV" style="left:25%" aria-hidden="true"></div>',
      '<div class="gdManualPracticeGridline gdManualPracticeGridlineV" style="left:75%" aria-hidden="true"></div>',
      '<div class="gdManualPracticeGridline gdManualPracticeGridlineH" style="top:25%" aria-hidden="true"></div>',
      '<div class="gdManualPracticeGridline gdManualPracticeGridlineH" style="top:75%" aria-hidden="true"></div>',
      '<span class="gdManualPracticeScaleLabel gdManualPracticeScaleLabelLeft" aria-hidden="true">' + lateralM + 'm</span>',
      '<span class="gdManualPracticeScaleLabel gdManualPracticeScaleLabelRight" aria-hidden="true">' + lateralM + 'm</span>',
      '<span class="gdManualPracticeScaleLabel gdManualPracticeScaleLabelTop" aria-hidden="true">' + depthM + 'm long</span>',
      '<span class="gdManualPracticeScaleLabel gdManualPracticeScaleLabelBottom" aria-hidden="true">' + depthM + 'm short</span>'
    ].join('');
  }

  function plotMarkup(session) {
    return ((session && session.observations) || []).map(function (observation) {
      var left = (Number(observation.x) + 1) * 50;
      var top = (1 - Number(observation.y)) * 50;
      var disrupted = cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted';
      return '<button type="button" class="gdManualPracticeDot ' + (disrupted ? 'disrupted' : 'representative') + '" data-gd-manual-practice-action="remove-observation" data-observation-id="' + escapeAttr(observation.observationId) + '" style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) + '%" title="' + escapeAttr(observation.clubId + ' · ' + (disrupted ? 'Disrupted' : 'Representative')) + '"><span>' + escapeHtml(observation.clubId) + '</span></button>';
    }).join('');
  }

  function reviewMarkup(session) {
    var summary = sessionSummary(session);
    var rows = ((session && session.observations) || []).slice().sort(function (a, b) {
      return (Number(b.sequence) || 0) - (Number(a.sequence) || 0);
    }).slice(0, 18);
    return [
      '<div class="gdManualPracticeQuickReview">',
      summary.length
        ? summary.map(function (group) {
          return '<div class="gdManualPracticeQuickReviewRow"><strong>' + escapeHtml(group.club) + '</strong><span>' + group.representative + ' representative' + (group.disrupted ? ' · ' + group.disrupted + ' disrupted' : '') + '</span></div>';
        }).join('')
        : '<div class="gdManualPracticeReviewEmpty">No shots yet.</div>',
      '<div class="gdManualPracticeObservationList">',
      rows.map(function (observation) {
        var disrupted = cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted';
        return '<div class="gdManualPracticeObservationRow"><div><strong>' + escapeHtml(observation.clubId) + '</strong><span>' + escapeHtml(disrupted ? 'Disrupted' : 'Representative') + ' · x ' + Number(observation.x).toFixed(2) + ' · y ' + Number(observation.y).toFixed(2) + '</span></div><div class="gdManualPracticeObservationActions"><button type="button" data-gd-manual-practice-action="toggle-classification" data-observation-id="' + escapeAttr(observation.observationId) + '">' + (disrupted ? 'Mark rep' : 'Mark disrupted') + '</button><button type="button" class="danger" data-gd-manual-practice-action="remove-observation" data-observation-id="' + escapeAttr(observation.observationId) + '">Remove</button></div></div>';
      }).join(''),
      '</div>',
      '</div>'
    ].join('');
  }

  function historyMarkup() {
    var completed = listSessions().filter(function (session) { return cleanString(session.status, 'draft') === 'completed'; });
    if (!completed.length) return '';
    var last = completed[0];
    return '<div class="gdManualPracticeGeneratedNotice"><strong>Last saved session</strong><span>' +
      escapeHtml(new Date(last.completedAt || last.updatedAt).toLocaleString()) + ' · ' +
      Number(last.shotCount || 0) + ' shot' + (Number(last.shotCount) === 1 ? '' : 's') +
      ' in the Practice Library' + (completed.length > 1 ? ' · ' + completed.length + ' sessions saved' : '') +
      '</span></div>';
  }

  function overrideMarkup(clubs, selectedClub) {
    if (!isStaff()) return '';
    var override = activeOverride();
    var active = override
      ? '<div class="gdManualPracticeGeneratedNotice"><strong>Trusted override active</strong><span>' +
        escapeHtml((override.club ? override.club + ' · ' : '') + Number(override.offsetDeg).toFixed(2) + '° is currently anchoring the Practice Bubble.') +
        '</span></div><button type="button" data-gd-manual-practice-action="clear-override">Clear override</button>'
      : '';
    return '<details class="gdManualPracticeOverride"><summary><strong>Trusted override</strong><span>Coach/admin shortcut into the same Practice result boundary</span></summary><div class="gdManualPracticeOverrideBody">' +
      active +
      '<label><span>Override club</span><select data-gd-manual-practice-control="override-club">' +
      clubs.map(function (club) {
        return '<option value="' + escapeAttr(club) + '"' + (club === selectedClub ? ' selected' : '') + '>' + escapeHtml(club) + '</option>';
      }).join('') +
      '</select></label><label><span>Offset degrees</span><input type="number" step="0.1" inputmode="decimal" data-gd-manual-practice-control="override-offset" placeholder="e.g. 2.4"></label><button type="button" data-gd-manual-practice-action="generate-override">Use trusted override</button></div></details>';
  }

  function renderLane(rootNode) {
    if (!rootNode) return;
    if (!isAdminUser()) {
      // Not solid enough for the iOS bundle's general audience yet - leave the
      // host node empty so players and coaches see nothing here.
      rootNode.innerHTML = '';
      return;
    }
    if (!hasPlayerScope()) {
      // Fail closed rather than write observations nobody owns.
      rootNode.innerHTML = '<div class="gdManualPracticeBody"><div class="gdManualPracticeReviewEmpty">Manual Practice needs a player selected before shots can be plotted.</div></div>';
      return;
    }
    var session = ensureSession();
    var summary = sessionSummary(session);
    var clubs = clubOptions();
    var selectedClub = cleanString(session.selectedClubId, clubs[0] || '7i');
    var nextClassification = cleanString(session.nextClassification, 'representative');
    var calibration = plotCalibration(selectedClub);
    var observationCount = (session.observations || []).length;
    rootNode.innerHTML = [
      '<details class="gdManualPracticeDrawer" id="gdManualPracticeDrawer" open>',
      '<summary><span>Manual Practice</span><small>Plot approximate results without a launch monitor</small></summary>',
      '<div class="gdManualPracticeBody">',
      '<div class="gdManualPracticeHead"><div><strong>Manual Practice</strong><span>Choose a club, tap where shots finished, review the pattern, then save the session into the Practice Library.</span></div><div class="gdNativePracticeBadge">Manual</div></div>',
      '<div class="gdManualPracticeControls">',
      '<label><span>Club</span><select data-gd-manual-practice-control="club">' + clubs.map(function (club) {
        return '<option value="' + escapeAttr(club) + '"' + (club === selectedClub ? ' selected' : '') + '>' + escapeHtml(club) + '</option>';
      }).join('') + '</select></label>',
      '<div class="gdManualPracticeToggleGroup" role="group" aria-label="Next shot classification">',
      '<button type="button" class="' + (nextClassification === 'representative' ? 'active' : '') + '" data-gd-manual-practice-action="set-next-classification" data-value="representative">Representative</button>',
      '<button type="button" class="' + (nextClassification === 'disrupted' ? 'active' : '') + '" data-gd-manual-practice-action="set-next-classification" data-value="disrupted">Disrupted</button>',
      '</div>',
      '<div class="gdManualPracticeControlActions">',
      '<button type="button" data-gd-manual-practice-action="undo">Undo</button>',
      '<button type="button" data-gd-manual-practice-action="clear-club">Clear club</button>',
      '<button type="button" data-gd-manual-practice-action="toggle-review">' + (session.reviewOpen ? 'Hide review' : 'Review') + '</button>',
      '</div>',
      '</div>',
      '<div class="gdManualPracticeClubChips">',
      summary.length ? summary.map(function (group) {
        var active = group.club === selectedClub;
        return '<button type="button" class="gdManualPracticeClubChip ' + (active ? 'active' : '') + '" data-gd-manual-practice-action="select-club" data-value="' + escapeAttr(group.club) + '">' + escapeHtml(group.club) + '<span>' + group.total + '</span></button>';
      }).join('') : '<span class="gdManualPracticeReviewEmpty">One or many clubs can be tested. Start with whichever club is practical.</span>',
      '</div>',
      '<div class="gdManualPracticePlotShell">',
      '<div class="gdManualPracticePlotMeta"><strong>' + escapeHtml(selectedClub) + '</strong><span>Tap where the ball finished relative to the target. Top is long, bottom is short.' + (calibration ? ' Plot spans ' + escapeHtml(String(Math.round(calibration.lateralHalfSpanM * 2))) + 'm wide · ' + escapeHtml(String(Math.round(calibration.depthHalfSpanM * 2))) + 'm deep around ' + escapeHtml(String(Math.round(calibration.expectedCarryM))) + 'm.' : '') + '</span></div>',
      '<div class="gdManualPracticePlot" id="gdManualPracticePlot" data-selected-club="' + escapeAttr(selectedClub) + '">',
      '<div class="gdManualPracticeTarget" aria-hidden="true"></div>',
      '<div class="gdManualPracticeAxis gdManualPracticeAxisVertical" aria-hidden="true"></div>',
      '<div class="gdManualPracticeAxis gdManualPracticeAxisHorizontal" aria-hidden="true"></div>',
      plotScaleMarkup(calibration),
      plotMarkup(session),
      '</div>',
      '</div>',
      session.reviewOpen ? reviewMarkup(session) : '',
      historyMarkup(),
      '<div class="gdManualPracticeGenerateRow"><button type="button" class="primary" data-gd-manual-practice-action="generate"' + (observationCount ? '' : ' disabled') + '>Save session to Practice</button><button type="button" data-gd-manual-practice-action="start-session">Start new session</button></div>',
      overrideMarkup(clubs, selectedClub),
      '</div>',
      '</details>'
    ].join('');
  }

  function notify(message) {
    safe(function () {
      if (typeof window.gdLmToast === 'function') window.gdLmToast(message);
      else if (typeof window.toast === 'function') window.toast(message);
    });
  }

  function rerender() {
    safe(function () {
      if (typeof window.renderPracticeData === 'function') window.renderPracticeData(true);
    });
  }

  function finishAndReport() {
    var result = finishSession();
    if (result.ok) {
      notify('Manual Practice session saved to Practice (' + result.session.shotCount + ' shots)');
    } else if (result.reason === 'no_observations') {
      notify('Plot a few shots before saving the session');
    } else if (result.reason === 'no_active_session') {
      notify('Start a Manual Practice session first');
    } else {
      notify('Practice Library is not ready - session kept as a draft');
    }
    return result;
  }

  function bindDelegatedEvents() {
    if (window.__gdManualPracticeBound) return;
    window.__gdManualPracticeBound = true;
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || !isAdminUser() || !hasPlayerScope()) return;
      if (target.getAttribute('data-gd-manual-practice-control') === 'club') {
        setSelectedClub(target.value);
        rerender();
      }
    }, true);
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-gd-manual-practice-action]') : null;
      if (!target) return;
      if (!isAdminUser() || !hasPlayerScope()) return;
      var action = cleanString(target.getAttribute('data-gd-manual-practice-action'), '');
      if (!action) return;
      event.preventDefault();
      if (action === 'undo') undoLastShot();
      else if (action === 'clear-club') clearClub(ensureSession().selectedClubId);
      else if (action === 'toggle-review') setReviewOpen(!ensureSession().reviewOpen);
      else if (action === 'select-club') setSelectedClub(target.getAttribute('data-value'));
      else if (action === 'set-next-classification') setNextClassification(target.getAttribute('data-value'));
      else if (action === 'remove-observation') removeObservation(target.getAttribute('data-observation-id'));
      else if (action === 'toggle-classification') {
        var observation = (ensureSession().observations || []).find(function (item) {
          return cleanString(item.observationId, '') === cleanString(target.getAttribute('data-observation-id'), '');
        });
        if (observation) {
          updateObservation(observation.observationId, {
            classification: cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted' ? 'representative' : 'disrupted'
          });
        }
      } else if (action === 'generate') finishAndReport();
      else if (action === 'start-session') {
        startNewSession();
        notify('New Manual Practice session started');
      } else if (action === 'clear-override') {
        clearTrustedOverride();
        notify('Trusted override cleared');
      } else if (action === 'generate-override') {
        var host = document.getElementById('gdManualPracticeLane');
        var clubInput = host && host.querySelector('[data-gd-manual-practice-control="override-club"]');
        var offsetInput = host && host.querySelector('[data-gd-manual-practice-control="override-offset"]');
        var offsetDeg = asNumber(offsetInput && offsetInput.value, NaN);
        if (!Number.isFinite(offsetDeg)) {
          notify('Enter an override offset');
          return;
        }
        if (!setTrustedOverride({
          clubId: clubInput && clubInput.value || ensureSession().selectedClubId,
          offsetDeg: offsetDeg,
          geometryPresetId: null
        })) {
          notify('Trusted override needs coach or admin permission');
          return;
        }
        notify('Trusted override ready');
      }
      rerender();
    }, true);
    document.addEventListener('pointerdown', function (event) {
      if (!isAdminUser() || !hasPlayerScope()) return;
      var plot = event.target && event.target.closest ? event.target.closest('#gdManualPracticePlot') : null;
      if (!plot || event.target.closest('.gdManualPracticeDot')) return;
      var rect = plot.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var session = ensureSession();
      addClubObservation({
        clubId: session.selectedClubId || '7i',
        x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
        y: 1 - ((event.clientY - rect.top) / rect.height) * 2,
        classification: session.nextClassification || 'representative'
      });
      rerender();
    }, true);
  }

  bindDelegatedEvents();

  var api = {
    storageKey: STORAGE_KEY,
    getStore: readStore,
    saveStore: writeStore,
    activePlayerScope: activePlayerScope,
    hasPlayerScope: hasPlayerScope,
    // Session lifecycle
    activeSession: gated(activeSession, null),
    ensureSession: gated(ensureSession, null),
    startNewSession: gated(startNewSession, null),
    finishSession: gated(finishSession, { ok: false, reason: 'not_permitted' }),
    listSessions: gated(listSessions, []),
    getSessionById: gated(getSessionById, null),
    sessionSummary: sessionSummary,
    // Observations
    addObservation: gated(addClubObservation, null),
    removeObservation: gated(removeObservation, null),
    updateObservation: gated(updateObservation, null),
    clearClub: gated(clearClub, null),
    undoLastShot: gated(undoLastShot, null),
    setSelectedClub: gated(setSelectedClub, null),
    setNextClassification: gated(setNextClassification, null),
    setReviewOpen: gated(setReviewOpen, null),
    // Calibration
    plotCalibration: plotCalibration,
    calibrationDeps: calibrationDeps,
    // Trusted override
    setTrustedOverride: gated(setTrustedOverride, null),
    clearTrustedOverride: gated(clearTrustedOverride, false),
    activeOverride: gated(activeOverride, null),
    applyTrustedOverride: applyTrustedOverride,
    isOverrideActive: function () { return !!(isAdminUser() && hasPlayerScope() && activeOverride()); },
    // UI
    renderLane: renderLane,
    isStaff: isStaff,
    isAdminOnly: isAdminUser
  };

  root.modules.manualPracticeData = api;
  window.GolfDaddyManualPracticeData = api;
  window.ClarityCaddieManualPracticeData = api;
})();
