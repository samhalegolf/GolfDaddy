export function createShotSession(overrides = {}) {
  return {
    id: overrides.id || `session-${Date.now()}`,
    courseId: overrides.courseId || null,
    courseName: overrides.courseName || null,
    playerId: overrides.playerId || 'local-player',
    startedAt: overrides.startedAt || new Date().toISOString(),
    endedAt: overrides.endedAt || null,
    shots: Array.isArray(overrides.shots) ? overrides.shots : []
  };
}

export function createShotRecord(overrides = {}) {
  return {
    id: overrides.id || `shot-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    hole: Number(overrides.hole || 1),
    clubId: overrides.clubId || null,
    clubName: overrides.clubName || null,
    start: overrides.start || null,
    target: overrides.target || null,
    greenCentre: overrides.greenCentre || null,
    pin: overrides.pin || null,
    distanceM: Number(overrides.distanceM || 0),
    bubble: overrides.bubble || null,
    outcome: overrides.outcome || null,
    createdAt: overrides.createdAt || new Date().toISOString()
  };
}

export function appendShot(session, shot) {
  const s = createShotSession(session);
  return {
    ...s,
    shots: [...s.shots, createShotRecord(shot)]
  };
}

export function sessionSummary(session) {
  const s = createShotSession(session);
  return {
    id: s.id,
    courseName: s.courseName,
    playerId: s.playerId,
    shotCount: s.shots.length,
    startedAt: s.startedAt,
    endedAt: s.endedAt
  };
}
