/* Ground-first loop separation for a site with no hole numbers.
 *
 * A golf course is walked. Each hole's green sits beside the next hole's tee, and a loop of
 * nine (or eighteen) closes back at the clubhouse. So the holes of a multi-loop site fall
 * into routed loops on the ground alone, before any card is read: the split into loops that
 * makes every green-to-next-tee walk short.
 *
 * Reading cards first got this wrong at Sophia Green (three nines, three par-36 cards that
 * look almost alike). Each card in turn took the nine holes that fitted its lengths best from
 * wherever they were on the site, and whatever was left went to the last card - nines that
 * hopped 700-1500m between holes. Here the ground decides which holes go together, and the
 * cards only decide which loop is which and how it is numbered.
 *
 * Pure: a cost matrix in, groups of indices out. The worker builds the matrix from resolver
 * candidates (green of one to tee of the next) and resolves each card against each group. */

/* What a walk costs. Metres, with anything past a normal transfer counted twice over, so one
   long hop is worse than two moderate ones. */
export function walkCost(metres) {
  if (!Number.isFinite(metres)) return 1e7;
  return metres + Math.max(0, metres - 300) * 2;
}

/* Minimum-cost assignment (Hungarian, O(n^3)). Row i is matched to column result[i]. With
   the diagonal forbidden it pairs every hole with one successor and one predecessor at the
   least total walk - which is a set of disjoint cycles, the routed loops as the ground
   draws them. */
export function minCostAssignment(matrix) {
  const n = matrix.length;
  const INF = Infinity;
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(INF), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = matrix[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const result = new Array(n);
  for (let j = 1; j <= n; j++) if (p[j]) result[p[j] - 1] = j - 1;
  return result;
}

function cyclesOf(successor) {
  const seen = new Set(), cycles = [];
  successor.forEach((_, start) => {
    if (seen.has(start)) return;
    const cycle = [];
    for (let at = start; !seen.has(at); at = successor[at]) { seen.add(at); cycle.push(at); }
    cycles.push(cycle);
  });
  return cycles;
}

/* The cheapest walk that visits every member once and comes back: exact (Held-Karp) for a
   loop of up to twelve, nearest-neighbour plus segment moves beyond that. */
export function loopTour(members, matrix) {
  const n = members.length;
  if (n === 0) return { cost: 0, order: [] };
  if (n === 1) return { cost: 0, order: members.slice() };
  if (n <= 12) return heldKarp(members, matrix);
  return improvedTour(members, matrix);
}

function heldKarp(members, matrix) {
  const n = members.length, full = 1 << n;
  const dp = new Float64Array(full * n).fill(Infinity);
  const parent = new Int16Array(full * n).fill(-1);
  dp[1 * n + 0] = 0;
  for (let mask = 1; mask < full; mask += 2) {
    for (let last = 0; last < n; last++) {
      const here = dp[mask * n + last];
      if (!Number.isFinite(here) || !(mask & (1 << last))) continue;
      for (let next = 1; next < n; next++) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        const cost = here + matrix[members[last]][members[next]];
        if (cost < dp[nextMask * n + next]) { dp[nextMask * n + next] = cost; parent[nextMask * n + next] = last; }
      }
    }
  }
  let best = Infinity, bestLast = 0;
  for (let last = 1; last < n; last++) {
    const cost = dp[(full - 1) * n + last] + matrix[members[last]][members[0]];
    if (cost < best) { best = cost; bestLast = last; }
  }
  const order = [];
  for (let mask = full - 1, at = bestLast; at !== -1;) {
    order.push(members[at]);
    const prev = parent[mask * n + at];
    mask &= ~(1 << at);
    at = prev;
  }
  return { cost: best, order: order.reverse() };
}

function tourCost(order, matrix) {
  let cost = 0;
  for (let i = 0; i < order.length; i++) cost += matrix[order[i]][order[(i + 1) % order.length]];
  return cost;
}

function improvedTour(members, matrix) {
  const left = new Set(members.slice(1));
  const order = [members[0]];
  while (left.size) {
    const last = order[order.length - 1];
    let best = null;
    left.forEach(candidate => { if (best == null || matrix[last][candidate] < matrix[last][best]) best = candidate; });
    order.push(best); left.delete(best);
  }
  let cost = tourCost(order, matrix);
  /* Or-opt: lift a run of one to three holes and set it down elsewhere, keeping direction -
     the walk is one-way, green to next tee, so segments are never reversed. */
  for (let improved = true, guard = 0; improved && guard < 200; guard++) {
    improved = false;
    for (let len = 1; len <= 3 && !improved; len++) {
      for (let i = 0; i + len <= order.length && !improved; i++) {
        const segment = order.slice(i, i + len);
        const rest = order.slice(0, i).concat(order.slice(i + len));
        for (let j = 0; j <= rest.length && !improved; j++) {
          const trial = rest.slice(0, j).concat(segment, rest.slice(j));
          const trialCost = tourCost(trial, matrix);
          if (trialCost + 1e-6 < cost) { order.splice(0, order.length, ...trial); cost = trialCost; improved = true; }
        }
      }
    }
  }
  return { cost, order };
}

/* Split n holes into `loops` routed loops of `holesPerLoop`, plus up to `spare` holes that
 * belong to none (a practice green the resolver built a line to, say).
 *
 * Starts from the assignment's own cycles, cut and packed to size, then swaps holes between
 * loops (and the spare bin) while any swap shortens the total walk. Returns null when the
 * ground has fewer holes than the loops need, or more than the spare allows. */
export function partitionLoops(matrix, { loops, holesPerLoop, spare = 0 }) {
  const n = matrix.length;
  const need = loops * holesPerLoop;
  if (!(loops >= 1) || !(holesPerLoop >= 2) || n < need || n - need > spare) return null;
  const spareCount = n - need;

  const assignmentMatrix = matrix.map((row, i) => row.map((value, j) => (i === j ? 1e9 : value)));
  const cycles = cyclesOf(minCostAssignment(assignmentMatrix));

  /* Each cycle opened at its longest walk, then cut into runs no longer than a loop. */
  const pieces = [];
  cycles.forEach(cycle => {
    let cut = 0, worst = -Infinity;
    cycle.forEach((at, i) => {
      const walk = matrix[at][cycle[(i + 1) % cycle.length]];
      if (walk > worst) { worst = walk; cut = (i + 1) % cycle.length; }
    });
    const path = cycle.slice(cut).concat(cycle.slice(0, cut));
    for (let i = 0; i < path.length; i += holesPerLoop) pieces.push(path.slice(i, i + holesPerLoop));
  });
  pieces.sort((a, b) => b.length - a.length);

  const bins = Array.from({ length: loops }, () => []);
  const spareBin = [];
  const walkBetween = (a, b) => Math.min(...a.map(x => Math.min(...b.map(y => Math.min(matrix[x][y], matrix[y][x])))));
  pieces.forEach(piece => {
    let rest = piece.slice();
    while (rest.length) {
      const open = bins.filter(bin => bin.length < holesPerLoop);
      if (!open.length) { spareBin.push(...rest); break; }
      const scored = open.map(bin => ({ bin, room: holesPerLoop - bin.length, near: bin.length ? walkBetween(bin, rest) : 0 }));
      scored.sort((a, b) => (b.room >= rest.length) - (a.room >= rest.length) || a.near - b.near || b.room - a.room);
      const target = scored[0];
      const take = rest.slice(0, target.room);
      target.bin.push(...take);
      rest = rest.slice(take.length);
    }
  });
  if (spareBin.length !== spareCount) return null;

  const cache = new Map();
  const binCost = members => {
    const key = members.slice().sort((a, b) => a - b).join(",");
    if (!cache.has(key)) cache.set(key, loopTour(members, matrix).cost);
    return cache.get(key);
  };
  const all = bins.concat([spareBin]);
  const costOf = index => (index === loops ? 0 : binCost(all[index]));
  for (let improved = true, sweeps = 0; improved && sweeps < 50; sweeps++) {
    improved = false;
    for (let a = 0; a < all.length; a++) {
      for (let b = a + 1; b < all.length; b++) {
        for (let i = 0; i < all[a].length; i++) {
          for (let j = 0; j < all[b].length; j++) {
            const before = costOf(a) + costOf(b);
            const x = all[a][i], y = all[b][j];
            all[a][i] = y; all[b][j] = x;
            const after = costOf(a) + costOf(b);
            if (after + 1e-6 < before) improved = true;
            else { all[a][i] = x; all[b][j] = y; }
          }
        }
      }
    }
  }

  const groups = bins.map(members => loopTour(members, matrix));
  return {
    groups: groups.map(group => ({
      order: group.order,
      cost: group.cost,
      walks: group.order.map((at, i) => matrix[at][group.order[(i + 1) % group.order.length]])
    })),
    spare: spareBin.slice(),
    cost: groups.reduce((sum, group) => sum + group.cost, 0)
  };
}
