const assert = require('assert');
const core = require('../scripts/gd-manual-practice-core.js');

function analyze(observations, opts = {}) {
  const session = {
    sessionId: 'session-1',
    playerId: 'player-1',
    playerName: 'Tester',
    observations
  };
  return core.analyzeSession(session, Object.assign({
    clubModelResolver(club) {
      const models = {
        PW: { club: 'PW', carryM: 120, bubbleWidthM: 18, bubbleDepthM: 16 },
        '7i': { club: '7i', carryM: 150, bubbleWidthM: 26, bubbleDepthM: 22 },
        '4i': { club: '4i', carryM: 190, bubbleWidthM: 34, bubbleDepthM: 28 }
      };
      return models[club] || models['7i'];
    }
  }, opts));
}

function obs(id, club, x, y, classification = 'representative') {
  return { observationId: id, clubId: club, x, y, classification, createdAt: '2026-08-21T00:00:00.000Z' };
}

{
  const analysis = analyze([
    obs('a', 'PW', 0.20, 0.05),
    obs('b', 'PW', 0.24, -0.02),
    obs('c', 'PW', 0.18, 0.03)
  ]);
  assert.equal(analysis.manualPractice, true);
  assert.equal(analysis.recommendation.showToUser, true);
  assert.equal(analysis.methods.resultScaledCluster.anchorClub, 'PW');
}

{
  const analysis = analyze([
    obs('a', 'PW', 0.18, 0.00),
    obs('b', 'PW', 0.22, 0.02),
    obs('c', 'PW', 0.20, -0.01),
    obs('d', '4i', 0.34, 0.04),
    obs('e', '4i', 0.31, 0.01),
    obs('f', '4i', 0.37, -0.03)
  ]);
  const pw = analysis.methods.resultScaledCluster.clubClusters.find(item => item.club === 'PW');
  const four = analysis.methods.resultScaledCluster.clubClusters.find(item => item.club === '4i');
  assert.ok(Math.abs(pw.centerDeg - four.centerDeg) < 1.0);
  assert.equal(analysis.methods.resultScaledCluster.status, 'cross_distance_verified');
}

{
  const analysis = analyze([
    obs('a', '7i', 0.10, 0.00),
    obs('b', '7i', 0.12, 0.01),
    obs('c', '7i', 0.11, -0.01),
    obs('d', '7i', 0.75, 0.45, 'disrupted')
  ]);
  assert.equal(analysis.totals.disrupted, 1);
  assert.equal(analysis.methods.resultScaledCluster.countedShots, 3);
}

{
  const session = {
    sessionId: 'session-2',
    playerId: 'player-1',
    playerName: 'Tester',
    observations: [
      obs('a', '7i', 0.10, 0.00),
      obs('b', '7i', 0.12, 0.01),
      obs('c', '7i', 0.11, -0.01)
    ]
  };
  const analysis = core.buildOverrideAnalysis(session, { clubId: '7i', offsetDeg: 2.6, geometryPresetId: null }, {
    clubModelResolver(club) {
      return { club, carryM: 150, bubbleWidthM: 26, bubbleDepthM: 22 };
    }
  });
  assert.equal(analysis.source, 'coach_manual_override');
  assert.equal(analysis.methods.resultScaledCluster.status, 'manual_override');
  assert.equal(analysis.recommendation.offsetDeg, 2.6);
}

console.log('manual-practice-core.test.js passed');
