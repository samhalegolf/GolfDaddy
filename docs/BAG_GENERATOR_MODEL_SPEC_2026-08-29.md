# Bag Generator — speed/loft model

Status: **spec, not built.** Sign-off wanted before code.

## What exists now

`generateQuickSet(sevenIronCarry)` in `app/js/bag.js` takes one number and scales
a fixed ladder:

```
scale = sevenIronCarry / GD_DEFAULT_CLUB_CARRY_M["7i"]
every club = round(default[club] * scale)
```

The ladder it scales is `GD_DEFAULT_CLUB_CARRY_M` (verbatim in `gd-app-core.js`,
re-exported through `GDBubbleEngine.defaultBagRows`):

| Club | m | Club | m | Club | m |
|---|---|---|---|---|---|
| Driver | 230 | 6i | 160 | GW | 98 |
| 3W | 205 | 7i | 155 | SW | 82 |
| 4H | 180 | 8i | 142 | LW | 66 |
| 4i | 178 | 9i | 130 | | |
| 5i | 170 | PW | 115 | | |

### Why it needs replacing

Proportional scaling holds every gap at a **fixed ratio** to the 7-iron. A
player at 130m off a 7-iron gets a Driver at 193m and a 3W at 172m — a 21m gap,
scaled straight off the 25m gap in the reference bag.

That is not what happens. Long clubs are the ones that need speed to separate.
As speed falls, Driver, 3W and hybrid distances **compress toward each other**,
because a slower player cannot generate the launch and spin to make loft pay.
The scaled model keeps handing them a spread they do not have, and the error is
worst exactly where the bubble matters most — the top of the bag, on the tee.

The same is true, less severely, at the other end: a very fast player's wedges
do not stretch proportionally, because wedge distance is governed by loft and a
partial swing far more than by speed.

So the current model is right in the middle and wrong at both edges. It is
right in the middle because that is where the reference bag was measured.

## Proposed model

```
7i carry  ->  infer club speed
              -> speed + loft + head type  ->  per-club carry
                 -> real adjacent loft gaps adjust the spacing
```

Four stages. Each is separately checkable, which matters more than any one of
them being clever.

### 1. 7i carry → club speed

One measured number in, one inferred number out. The relationship between
7-iron carry and 7-iron club speed is close to linear over the range the app
cares about (roughly 90–175m carry), so this stage is a fit, not a simulation.

Anchor points to fit through (7-iron carry → 7-iron club speed):

| 7i carry | ~club speed |
|---|---|
| 100 m | 24.5 m/s |
| 130 m | 29.5 m/s |
| 155 m | 33.5 m/s |
| 175 m | 37.0 m/s |

Fit a smooth monotonic curve, clamp outside the range rather than extrapolating.
The output is a **7-iron** speed; other clubs are derived from it in stage 2, not
measured.

Open question for sign-off: whether to expose the inferred speed to the player.
Recommendation is **no** — it is an internal quantity, it will be wrong by a few
percent for any individual, and showing it invites arguments with a launch
monitor the app is not.

### 2. Speed + loft + head type → carry

Per club:

- **Speed ratio.** Club speed is not flat across the bag: a player swings a
  driver faster than a 7-iron and a wedge slower, and the *spread* of those
  speeds narrows as the player gets slower. Model driver speed as a multiple of
  7-iron speed that itself falls with speed — a fast player might be 1.30×, a
  slow player 1.20×. This single term is what produces the long-club
  compression the current model misses, and it is the most important line in
  the spec.
- **Loft.** Nominal loft per club label (see stage 4). Carry falls as loft rises,
  but not linearly — the loss per degree grows as loft grows.
- **Head type.** Driver, fairway wood, hybrid, iron, wedge. Head type sets how
  efficiently speed becomes ball speed (smash) and how the launch/spin window
  sits. A 4-hybrid and a 4-iron carry the same nominal loft and do not go the
  same distance, especially at lower speeds — which is the whole reason players
  carry hybrids.

Head type is inferred from the label, per the decision to capture nothing new:

| Pattern | Head type |
|---|---|
| `driver`, `1w` | driver |
| `3w`, `5w`, `wood` | fairway |
| `h`, `hybrid`, `rescue` | hybrid |
| `i`, `iron` | iron |
| `pw`, `gw`, `aw`, `sw`, `lw`, `wedge` | wedge |

Unrecognised labels fall back to iron, which is the least wrong default in the
middle of the bag.

### 3. Calibrate back to the measured 7-iron

The model must return **exactly** the 7-iron carry the player typed. Whatever
the physical stage produces, scale the whole ladder so the 7-iron lands on the
entered number.

This is not a fudge, it is the point: the player gave us one true measurement
and it should survive the model intact. The physics decides the *shape* of the
ladder; the measurement decides where it sits.

### 4. Real loft gaps adjust the spacing

Nominal lofts by label:

| Club | ° | Club | ° | Club | ° |
|---|---|---|---|---|---|
| Driver | 10.5 | 6i | 28 | GW | 50 |
| 3W | 15 | 7i | 32 | SW | 55 |
| 5W | 18 | 8i | 36 | LW | 59 |
| 4H | 22 | 9i | 40 | | |
| 4i | 24 | PW | 45 | | |
| 5i | 26 | | | | |

Where a player's bag has an unusual adjacent pair — a 4i straight to a 6i, or a
PW then a 54° — the **actual loft gap** should widen or narrow the distance gap.

Explicitly **not** a fixed metres-per-degree constant. A degree is worth much
more distance at the top of the bag than the bottom: roughly 4–5 m/° between
driver and 3-wood, roughly 2 m/° between wedges. Use the local slope of the
stage-2 curve at that loft and speed, which the model already has, rather than
introducing a second constant that can disagree with it.

## Acceptance criteria

The point of building it behind the existing one is to be able to check these.

1. **Ordinary players barely move.** For 7i carry 140–165 m, every club within
   **±4 m** of what the current generator produces. If the model rewrites bags
   for the players it already served well, it is not ready.
2. **Slow speeds compress at the top.** At 7i = 110 m, the Driver→3W gap must be
   **materially smaller** than the proportional model's, and Driver→3W→4H should
   read as a tightening ladder rather than three evenly spaced numbers.
3. **Monotonic, always.** Carry strictly decreases from driver to LW for every
   input in 90–185 m. No crossovers, ever — a bag where the 5i outdrives the 4i
   is visibly broken and destroys trust in everything else.
4. **The measurement survives.** Generated 7i equals the entered 7i exactly, for
   every input.
5. **Loft gaps do something.** A bag with a 4i→6i jump shows a wider gap there
   than one with 4i→5i→6i, and the difference tracks the local slope rather than
   a constant.
6. **No new required data.** A club with an unparseable label still generates,
   falling back to iron.

## Build shape

New module `scripts/gd-bag-generator-core.js`, pure and testable, exported the
same way as the other `*-core` files. The existing `generateQuickSet` stays until
the comparison in criterion 1 has actually been run on real bags.

Note `app/js/bubble-engine.js` is **generated** — if any of this lands in
`gd-app-core.js`, re-run `dev/generate-bubble-engine-client.js` rather than
editing the copy.

## Wanted before building

1. Are the four speed anchor points in stage 1 about right, or do you have
   measured pairs to fit through instead?
2. Driver-to-7i speed ratio at the slow end — is 1.20× fair, or tighter?
3. Should the inferred speed be shown anywhere, or stay internal?
4. Is ±4 m the right agreement band for criterion 1, or tighter?
