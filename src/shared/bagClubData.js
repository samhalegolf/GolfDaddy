export const DEFAULT_CLUBS = [
  { id: 'driver', name: 'Driver', carryM: 210, totalM: 230 },
  { id: '3w', name: '3 Wood', carryM: 190, totalM: 205 },
  { id: '5w', name: '5 Wood', carryM: 175, totalM: 188 },
  { id: '4i', name: '4 Iron', carryM: 165, totalM: 174 },
  { id: '5i', name: '5 Iron', carryM: 155, totalM: 163 },
  { id: '6i', name: '6 Iron', carryM: 145, totalM: 152 },
  { id: '7i', name: '7 Iron', carryM: 135, totalM: 141 },
  { id: '8i', name: '8 Iron', carryM: 124, totalM: 129 },
  { id: '9i', name: '9 Iron', carryM: 112, totalM: 116 },
  { id: 'pw', name: 'PW', carryM: 100, totalM: 103 },
  { id: 'gw', name: 'GW', carryM: 88, totalM: 90 },
  { id: 'sw', name: 'SW', carryM: 74, totalM: 76 },
  { id: 'lw', name: 'LW', carryM: 58, totalM: 60 }
];

export function normaliseClub(raw = {}) {
  const name = String(raw.name || raw.club || raw.label || '').trim() || 'Club';
  const id = String(raw.id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'club';
  const carryM = Number(raw.carryM || raw.carry || raw.baseCarry || 0);
  const totalM = Number(raw.totalM || raw.total || raw.distanceM || carryM || 0);
  return {
    id,
    name,
    carryM,
    totalM,
    bubble: raw.bubble || raw.shotBubble || null,
    enabled: raw.enabled !== false
  };
}

export function normaliseBag(rawBag = DEFAULT_CLUBS) {
  const clubs = Array.isArray(rawBag) ? rawBag : Array.isArray(rawBag.clubs) ? rawBag.clubs : DEFAULT_CLUBS;
  return clubs.map(normaliseClub).filter(club => club.enabled);
}

export function selectClubForDistance(distanceM, bag = DEFAULT_CLUBS) {
  const clubs = normaliseBag(bag);
  const target = Number(distanceM || 0);
  if (!clubs.length) return normaliseClub(DEFAULT_CLUBS[0]);
  return clubs
    .slice()
    .sort((a, b) => Math.abs((a.carryM || a.totalM) - target) - Math.abs((b.carryM || b.totalM) - target))[0];
}

export function upsertClub(bag, club) {
  const next = normaliseBag(bag);
  const clean = normaliseClub(club);
  const index = next.findIndex(item => item.id === clean.id || item.name === clean.name);
  if (index >= 0) next[index] = clean;
  else next.push(clean);
  return next;
}
