export function normalisePlayerProfile(raw = {}) {
  const name = String(raw.name || raw.playerName || 'Player').trim() || 'Player';
  const id = String(raw.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'local-player';
  return {
    id,
    name,
    handicap: raw.handicap ?? raw.hcp ?? null,
    handedness: raw.handedness || 'right',
    units: raw.units || 'm',
    homeCourse: raw.homeCourse || null,
    bagId: raw.bagId || 'default-bag',
    role: raw.role || 'player'
  };
}

export function profileStorageKey(profile) {
  const p = normalisePlayerProfile(profile);
  return `clarity-caddy-profile:${p.id}`;
}

export function isCoachProfile(profile) {
  const p = normalisePlayerProfile(profile);
  return p.role === 'coach' || p.role === 'admin';
}

export function publicProfileLabel(profile) {
  const p = normalisePlayerProfile(profile);
  return p.handicap === null || p.handicap === undefined || p.handicap === '' ? p.name : `${p.name} · HCP ${p.handicap}`;
}
