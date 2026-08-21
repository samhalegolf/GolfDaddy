(function () {
  'use strict';

  var root = window.GolfDaddy = window.GolfDaddy || {};
  root.modules = root.modules || {};

  var core = window.GolfDaddyManualPracticeCore || window.ClarityCaddieManualPracticeCore;
  var STORAGE_KEY = 'gd_manual_practice_v1';
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

  function defaultStore() {
    return {
      version: 1,
      sessions: [],
      preview: {
        sessionId: '',
        resultId: ''
      },
      updatedAt: nowIso()
    };
  }

  function activePlayerScope() {
    var launchApi = window.GolfDaddyLaunchMonitorData || window.ClarityCaddieLaunchMonitorData;
    if (launchApi && typeof launchApi.activePlayerScope === 'function') {
      return launchApi.activePlayerScope() || {};
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

  function accountPermission() {
    return cleanString(safe(function () {
      return typeof window.gdGetAccountPermission === 'function'
        ? window.gdGetAccountPermission()
        : '';
    }, ''), '').toLowerCase();
  }

  function isStaff() {
    var permission = accountPermission();
    if (permission === 'admin' || permission === 'coach') return true;
    return !!safe(function () {
      return window.ClaritySession && typeof window.ClaritySession.isStaff === 'function' ? window.ClaritySession.isStaff() : false;
    }, false);
  }

  // Manual Practice is admin-only while it is still being proven out, so it
  // never ships into the iOS bundle for regular players. This is the single
  // gate every rendering entry point below checks - tighten or remove it
  // here (not per call site) once the module is ready for coaches/players.
  function isAdminUser() {
    return accountPermission() === 'admin';
  }

  function readStore() {
    return safe(function () {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : defaultStore();
      parsed.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      parsed.preview = parsed.preview && typeof parsed.preview === 'object' ? parsed.preview : { sessionId: '', resultId: '' };
      parsed.updatedAt = parsed.updatedAt || nowIso();
      return parsed;
    }, defaultStore());
  }

  function writeStore(store) {
    store = store || defaultStore();
    store.sessions = Array.isArray(store.sessions) ? store.sessions : [];
    store.preview = store.preview && typeof store.preview === 'object' ? store.preview : { sessionId: '', resultId: '' };
    store.updatedAt = nowIso();
    safe(function () {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    });
    return store;
  }

  function currentPlayerSessions(store) {
    var scope = activePlayerScope();
    return (store.sessions || []).filter(function (session) {
      return !scope.playerId || cleanString(session.playerId, '') === scope.playerId;
    });
  }

  function clubOptions() {
    var rows = safe(function () {
      return typeof window.gdBagSourceRows === 'function' ? window.gdBagSourceRows() : [];
    }, []) || [];
    var fromBag = rows.map(function (row) { return cleanString(row && row.club, ''); }).filter(Boolean);
    var all = [];
    fromBag.concat(CLUB_FALLBACKS).forEach(function (club) {
      if (club && all.indexOf(club) === -1) all.push(club);
    });
    return all;
  }

  function clubModelResolver(club) {
    var label = cleanString(club, '7i');
    var bagRows = safe(function () {
      return typeof window.gdBagSourceRows === 'function' ? window.gdBagSourceRows() : [];
    }, []) || [];
    var bagRow = bagRows.find(function (row) {
      return cleanString(row && row.club, '').toLowerCase() === label.toLowerCase();
    }) || null;
    var carryM = bagRow ? asNumber(bagRow.baseCarry || bagRow.actualDistanceM || bagRow.carry || bagRow.distance, NaN) : NaN;
    if (!Number.isFinite(carryM) || carryM <= 0) {
      carryM = asNumber(safe(function () {
        return typeof window.gdDefaultCarryForClub === 'function' ? window.gdDefaultCarryForClub(label) : NaN;
      }, NaN), 155);
    }
    var generated = safe(function () {
      return typeof window.gdGeneratedShotBubbleForClub === 'function' ? window.gdGeneratedShotBubbleForClub(label, carryM, 0) : null;
    }, null) || {};
    var widthM = asNumber(generated.widthM || generated.bubbleWidthM || generated.clusterWidthM, Math.max(12, carryM * 0.16));
    var depthM = asNumber(generated.depthM || generated.bubbleDepthM || generated.clusterDepthM, Math.max(12, carryM * 0.14));
    return {
      club: label,
      carryM: Math.max(30, carryM),
      bubbleWidthM: Math.max(8, widthM),
      bubbleDepthM: Math.max(8, depthM)
    };
  }

  function createSession() {
    var scope = activePlayerScope();
    var timestamp = nowIso();
    return {
      sessionId: createId('manual-practice-session'),
      playerId: cleanString(scope.playerId, ''),
      playerName: cleanString(scope.playerName, 'Player'),
      accountId: cleanString(scope.accountId, ''),
      createdAt: timestamp,
      updatedAt: timestamp,
      selectedClubId: '7i',
      nextClassification: 'representative',
      geometryPresetId: null,
      observations: [],
      results: [],
      reviewOpen: false,
      source: 'manual_practice'
    };
  }

  function latestSession(store) {
    var sessions = currentPlayerSessions(store).slice().sort(function (a, b) {
      return Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0);
    });
    return sessions[0] || null;
  }

  function ensureSession() {
    var store = readStore();
    var session = latestSession(store);
    if (!session) {
      session = createSession();
      store.sessions.push(session);
      writeStore(store);
    }
    return session;
  }

  function saveSession(mutator) {
    var store = readStore();
    var session = latestSession(store);
    if (!session) {
      session = createSession();
      store.sessions.push(session);
    }
    mutator(session, store);
    session.updatedAt = nowIso();
    writeStore(store);
    return session;
  }

  function getSessionById(sessionId) {
    var store = readStore();
    var target = cleanString(sessionId, '');
    return currentPlayerSessions(store).find(function (session) {
      return cleanString(session.sessionId, '') === target;
    }) || null;
  }

  function addClubObservation(point) {
    return saveSession(function (session) {
      var observation = {
        observationId: createId('manual-observation'),
        clubId: cleanString(point.clubId || session.selectedClubId, session.selectedClubId || '7i'),
        x: Math.max(-1, Math.min(1, Number(point.x) || 0)),
        y: Math.max(-1, Math.min(1, Number(point.y) || 0)),
        classification: cleanString(point.classification || session.nextClassification, 'representative').toLowerCase() === 'disrupted'
          ? 'disrupted'
          : 'representative',
        sequence: (session.observations || []).length + 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: 'manual_practice'
      };
      session.observations = Array.isArray(session.observations) ? session.observations : [];
      session.observations.push(observation);
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
      session.observations = Array.isArray(session.observations) ? session.observations : [];
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

  function buildAnalysis(session, override) {
    if (!core) return null;
    if (override && Number.isFinite(Number(override.offsetDeg))) {
      return core.buildOverrideAnalysis(session, override, { clubModelResolver: clubModelResolver });
    }
    return core.analyzeSession(session, { clubModelResolver: clubModelResolver });
  }

  function generateResult(opts) {
    opts = opts || {};
    var store = readStore();
    var session = latestSession(store) || createSession();
    if (store.sessions.indexOf(session) === -1) store.sessions.push(session);
    var override = opts.override && isStaff() ? opts.override : null;
    var analysis = buildAnalysis(session, override);
    if (!analysis) return null;
    var result = {
      resultId: createId('manual-practice-result'),
      createdAt: nowIso(),
      source: override ? 'coach_manual_override' : 'manual_practice',
      geometryPresetId: override && override.geometryPresetId != null ? override.geometryPresetId : null,
      analysis: analysis
    };
    session.results = Array.isArray(session.results) ? session.results : [];
    session.results.push(result);
    session.generatedAt = result.createdAt;
    session.updatedAt = result.createdAt;
    store.preview = {
      sessionId: session.sessionId,
      resultId: result.resultId
    };
    writeStore(store);
    return result;
  }

  function activePreviewResult(store) {
    store = store || readStore();
    var preview = store.preview || {};
    if (!preview.sessionId || !preview.resultId) return null;
    var session = currentPlayerSessions(store).find(function (item) {
      return cleanString(item.sessionId, '') === cleanString(preview.sessionId, '');
    });
    if (!session) return null;
    return (session.results || []).find(function (result) {
      return cleanString(result.resultId, '') === cleanString(preview.resultId, '');
    }) || null;
  }

  function getDisplayAnalysis() {
    // Admin-only gate: even if a session already sits in localStorage (e.g. an
    // account's permission changed after generating a result), non-admins
    // never get it fed into the shared Practice Bubble path.
    if (!isAdminUser()) return null;
    var result = activePreviewResult(readStore());
    return result && result.analysis ? result.analysis : null;
  }

  function clearPreview() {
    var store = readStore();
    store.preview = { sessionId: '', resultId: '' };
    writeStore(store);
  }

  function sessionSummary(session) {
    session = session || ensureSession();
    var groups = {};
    (session.observations || []).forEach(function (observation) {
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

  function analysisStatusLabel(analysis) {
    var method = analysis && analysis.methods && analysis.methods.resultScaledCluster || {};
    if (!method.showToUser) return 'Needs more representative shots';
    if (method.status === 'manual_override') return 'Trusted override ready';
    if (method.status === 'cross_distance_verified') return 'Cross-club verified';
    return 'Manual Bubble ready';
  }

  function renderEvidenceList(rootNode, analysis) {
    if (!rootNode) return;
    if (!isAdminUser()) {
      rootNode.innerHTML = '';
      return;
    }
    var session = ensureSession();
    var summary = sessionSummary(session);
    var rows = (session.observations || []).slice().sort(function (a, b) {
      return (Number(b.sequence) || 0) - (Number(a.sequence) || 0);
    }).slice(0, 18);
    var clearPreviewButton = getDisplayAnalysis()
      ? '<button type="button" class="gdManualPracticeGhostBtn" data-gd-manual-practice-action="clear-preview">Return to imports</button>'
      : '';
    rootNode.innerHTML = [
      '<div class="gdPracticeLibraryShell gdManualPracticeEvidenceShell">',
      '<div class="gdPracticeEvidenceHead">',
      '<div><strong>Manual Practice review</strong><span>Review by club, reclassify obvious outliers, then generate the shared Practice Bubble result.</span></div>',
      clearPreviewButton,
      '</div>',
      '<div class="gdManualPracticeReviewSummary">',
      summary.length ? summary.map(function (group) {
        return '<div class="gdManualPracticeReviewCard"><strong>' + escapeHtml(group.club) + '</strong><span>' + group.representative + ' representative' + (group.disrupted ? ' · ' + group.disrupted + ' disrupted' : '') + '</span></div>';
      }).join('') : '<div class="gdManualPracticeReviewEmpty">Start a manual session to review clubs here.</div>',
      '</div>',
      analysis ? '<div class="gdManualPracticeEvidenceStatus"><strong>' + escapeHtml(analysisStatusLabel(analysis)) + '</strong><span>' + escapeHtml(analysis.source === 'coach_manual_override' ? 'Trusted shortcut into the Practice Bubble boundary.' : 'Shared Practice Bubble renderer and adoption path are now using this result.') + '</span></div>' : '',
      '<div class="gdManualPracticeObservationList">',
      rows.length ? rows.map(function (observation) {
        var disrupted = cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted';
        return '<div class="gdManualPracticeObservationRow"><div><strong>' + escapeHtml(observation.clubId) + '</strong><span>' + escapeHtml(disrupted ? 'Disrupted' : 'Representative') + ' · x ' + Number(observation.x).toFixed(2) + ' · y ' + Number(observation.y).toFixed(2) + '</span></div><div class="gdManualPracticeObservationActions"><button type="button" data-gd-manual-practice-action="toggle-classification" data-observation-id="' + escapeAttr(observation.observationId) + '">' + (disrupted ? 'Mark rep' : 'Mark disrupted') + '</button><button type="button" class="danger" data-gd-manual-practice-action="remove-observation" data-observation-id="' + escapeAttr(observation.observationId) + '">Remove</button></div></div>';
      }).join('') : '<div class="gdManualPracticeReviewEmpty">No manual observations yet.</div>',
      '</div>',
      '</div>'
    ].join('');
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

  function plotMarkup(session) {
    var observations = Array.isArray(session.observations) ? session.observations : [];
    return observations.map(function (observation) {
      var left = (Number(observation.x) + 1) * 50;
      var top = (1 - Number(observation.y)) * 50;
      var disrupted = cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted';
      return '<button type="button" class="gdManualPracticeDot ' + (disrupted ? 'disrupted' : 'representative') + '" data-gd-manual-practice-action="remove-observation" data-observation-id="' + escapeAttr(observation.observationId) + '" style="left:' + left.toFixed(2) + '%;top:' + top.toFixed(2) + '%" title="' + escapeAttr(observation.clubId + ' · ' + (disrupted ? 'Disrupted' : 'Representative')) + '"><span>' + escapeHtml(observation.clubId) + '</span></button>';
    }).join('');
  }

  function renderLane(rootNode) {
    if (!rootNode) return;
    if (!isAdminUser()) {
      // Not solid enough for the iOS bundle's general audience yet - leave
      // the host node empty so players and coaches see nothing here.
      rootNode.innerHTML = '';
      return;
    }
    var session = ensureSession();
    var summary = sessionSummary(session);
    var clubs = clubOptions();
    var selectedClub = cleanString(session.selectedClubId, clubs[0] || '7i');
    var nextClassification = cleanString(session.nextClassification, 'representative');
    var previewAnalysis = getDisplayAnalysis();
    rootNode.innerHTML = [
      '<details class="gdManualPracticeDrawer" id="gdManualPracticeDrawer" open>',
      '<summary><span>Manual Practice</span><small>Plot approximate results without a launch monitor</small></summary>',
      '<div class="gdManualPracticeBody">',
      '<div class="gdManualPracticeHead"><div><strong>Manual Practice</strong><span>Choose a club, tap where shots finished, review the pattern, then generate the shared Practice Bubble result.</span></div><div class="gdNativePracticeBadge">Manual</div></div>',
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
      '<div class="gdManualPracticePlotMeta"><strong>' + escapeHtml(selectedClub) + '</strong><span>Tap where the ball finished relative to the target. Top is long, bottom is short.</span></div>',
      '<div class="gdManualPracticePlot" id="gdManualPracticePlot" data-selected-club="' + escapeAttr(selectedClub) + '">',
      '<div class="gdManualPracticeTarget" aria-hidden="true"></div>',
      '<div class="gdManualPracticeAxis gdManualPracticeAxisVertical" aria-hidden="true"></div>',
      '<div class="gdManualPracticeAxis gdManualPracticeAxisHorizontal" aria-hidden="true"></div>',
      plotMarkup(session),
      '</div>',
      '</div>',
      session.reviewOpen ? '<div class="gdManualPracticeQuickReview">' + (summary.length ? summary.map(function (group) {
        return '<div class="gdManualPracticeQuickReviewRow"><strong>' + escapeHtml(group.club) + '</strong><span>' + group.representative + ' representative' + (group.disrupted ? ' · ' + group.disrupted + ' disrupted' : '') + '</span></div>';
      }).join('') : '<div class="gdManualPracticeReviewEmpty">No shots yet.</div>') + '</div>' : '',
      previewAnalysis ? '<div class="gdManualPracticeGeneratedNotice"><strong>' + escapeHtml(analysisStatusLabel(previewAnalysis)) + '</strong><span>' + escapeHtml(previewAnalysis.source === 'coach_manual_override' ? 'Trusted override is currently feeding the shared Practice Bubble path.' : 'Manual Practice is currently feeding the shared Practice Bubble path.') + '</span></div>' : '',
      '<div class="gdManualPracticeGenerateRow"><button type="button" class="primary" data-gd-manual-practice-action="generate">Generate Manual Bubble</button>' + (previewAnalysis ? '<button type="button" data-gd-manual-practice-action="clear-preview">Return to imports</button>' : '') + '</div>',
      isStaff() ? '<details class="gdManualPracticeOverride"><summary><strong>Trusted override</strong><span>Coach/admin shortcut into the same Practice result boundary</span></summary><div class="gdManualPracticeOverrideBody"><label><span>Override club</span><select data-gd-manual-practice-control="override-club">' + clubs.map(function (club) { return '<option value="' + escapeAttr(club) + '"' + (club === selectedClub ? ' selected' : '') + '>' + escapeHtml(club) + '</option>'; }).join('') + '</select></label><label><span>Offset degrees</span><input type="number" step="0.1" inputmode="decimal" data-gd-manual-practice-control="override-offset" placeholder="e.g. 2.4"></label><button type="button" data-gd-manual-practice-action="generate-override">Use trusted override</button></div></details>' : '',
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

  function bindDelegatedEvents() {
    if (window.__gdManualPracticeBound) return;
    window.__gdManualPracticeBound = true;
    document.addEventListener('change', function (event) {
      var target = event.target;
      if (!target) return;
      var control = target.getAttribute('data-gd-manual-practice-control');
      if (control === 'club') {
        setSelectedClub(target.value);
        rerender();
      }
    }, true);
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-gd-manual-practice-action]') : null;
      if (!target) return;
      if (!isAdminUser()) return;
      var action = cleanString(target.getAttribute('data-gd-manual-practice-action'), '');
      if (!action) return;
      event.preventDefault();
      if (action === 'undo') {
        undoLastShot();
        rerender();
        return;
      }
      if (action === 'clear-club') {
        clearClub(ensureSession().selectedClubId);
        rerender();
        return;
      }
      if (action === 'toggle-review') {
        setReviewOpen(!ensureSession().reviewOpen);
        rerender();
        return;
      }
      if (action === 'select-club') {
        setSelectedClub(target.getAttribute('data-value'));
        rerender();
        return;
      }
      if (action === 'set-next-classification') {
        setNextClassification(target.getAttribute('data-value'));
        rerender();
        return;
      }
      if (action === 'remove-observation') {
        removeObservation(target.getAttribute('data-observation-id'));
        rerender();
        return;
      }
      if (action === 'toggle-classification') {
        var observation = (ensureSession().observations || []).find(function (item) {
          return cleanString(item.observationId, '') === cleanString(target.getAttribute('data-observation-id'), '');
        });
        if (observation) updateObservation(observation.observationId, {
          classification: cleanString(observation.classification, 'representative').toLowerCase() === 'disrupted' ? 'representative' : 'disrupted'
        });
        rerender();
        return;
      }
      if (action === 'generate') {
        var result = generateResult();
        if (result && result.analysis && result.analysis.recommendation && result.analysis.recommendation.showToUser) {
          notify('Manual Practice Bubble ready');
        } else {
          notify('Manual Practice saved. Add a few more representative shots if the bubble is still waiting.');
        }
        rerender();
        return;
      }
      if (action === 'clear-preview') {
        clearPreview();
        rerender();
        return;
      }
      if (action === 'generate-override') {
        var host = document.getElementById('gdManualPracticeLane');
        var clubInput = host && host.querySelector('[data-gd-manual-practice-control="override-club"]');
        var offsetInput = host && host.querySelector('[data-gd-manual-practice-control="override-offset"]');
        var offsetDeg = asNumber(offsetInput && offsetInput.value, NaN);
        if (!Number.isFinite(offsetDeg)) {
          notify('Enter an override offset');
          return;
        }
        generateResult({
          override: {
            clubId: clubInput && clubInput.value || ensureSession().selectedClubId,
            offsetDeg: offsetDeg,
            geometryPresetId: null
          }
        });
        notify('Trusted override ready');
        rerender();
      }
    }, true);
    document.addEventListener('pointerdown', function (event) {
      if (!isAdminUser()) return;
      var plot = event.target && event.target.closest ? event.target.closest('#gdManualPracticePlot') : null;
      if (!plot || event.target.closest('.gdManualPracticeDot')) return;
      var rect = plot.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      var y = 1 - ((event.clientY - rect.top) / rect.height) * 2;
      var session = ensureSession();
      addClubObservation({
        clubId: session.selectedClubId || '7i',
        x: x,
        y: y,
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
    ensureSession: ensureSession,
    getSessionById: getSessionById,
    sessionSummary: sessionSummary,
    addObservation: addClubObservation,
    removeObservation: removeObservation,
    updateObservation: updateObservation,
    clearClub: clearClub,
    undoLastShot: undoLastShot,
    setSelectedClub: setSelectedClub,
    setNextClassification: setNextClassification,
    setReviewOpen: setReviewOpen,
    generateResult: generateResult,
    getDisplayAnalysis: getDisplayAnalysis,
    clearPreview: clearPreview,
    renderLane: renderLane,
    renderEvidenceList: renderEvidenceList,
    isPreviewActive: function () { return !!getDisplayAnalysis(); },
    isStaff: isStaff,
    isAdminOnly: isAdminUser
  };

  root.modules.manualPracticeData = api;
  window.GolfDaddyManualPracticeData = api;
  window.ClarityCaddieManualPracticeData = api;
})();
