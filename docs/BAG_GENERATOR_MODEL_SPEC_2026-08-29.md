# Bag Generator — product flow + speed/loft model

Status: **authoritative implementation spec; generator model not built yet.**

This document owns both the Bag product behaviour and the replacement model for generated club distances. The core principle is:

> **Manual = truth. Generator = convenience.**

A player's direct club edits are authoritative. Generation is an explicit action and must never silently reshape the bag because one club was edited.

## Product behaviour

### 1. Normal Bag editing is manual

The primary Bag route is deliberately simple:

```
Add club -> enter/change club label -> enter/change carry -> Save
```

For an existing club:

```
Open club -> change label and/or carry -> Save / Done
```

Rules:

- Editing one club **must not automatically change any other club**.
- Changing a club label must not invoke whole-bag generation.
- Changing a club carry must not invoke whole-bag generation.
- Player-entered values are authoritative and remain editable after any generated bag is created.
- Distance input in this editor is **carry**, not total.
- Total remains derived separately through the existing roll-out / firmness logic.

### 2. Distance stepper behaviour

The `+` and `-` controls change carry by **exactly 1 metre per press**.

The current shared editor already requests `baseCarry +/- 1`, but the write path immediately sorts and re-renders the entire bag. When a club crosses another club's distance, the edited row can move underneath the pointer/finger, making subsequent presses appear to jump between numbers or clubs.

Required behaviour:

- While a club editor is open, keep that edited row anchored in its current visual position.
- `+` = exactly +1 m carry.
- `-` = exactly -1 m carry.
- Recalculate that club's derived total as needed, but do not move the editor.
- Re-sort the full bag only when the edit is committed with **Done / Save**, or when the editor is otherwise closed.

### 3. Generate Bag — primary generator route

The full-bag generator remains deliberately anchored to the **7-iron**.

Flow:

```
Generate Bag
    -> How far do you carry your 7 iron?
    -> enter 7-iron carry
    -> generate estimated full bag
    -> player can manually edit any result
```

The UI must never ask merely for `7 iron distance` because that is ambiguous between carry and total.

Preferred wording:

**How far do you carry your 7 iron?**

**Carry distance · metres**

The entered 7-iron carry is a measured/player-supplied value and the generated bag must return that exact value for the 7i.

### 4. Generate Rest — explicit secondary action

Manual editing remains the normal route. If the player has entered or changed clubs and wants help filling the rest of the bag, provide a separate **Generate Rest** action.

Generation must never happen merely because a single club was edited.

The Generate Rest route should use the **7-iron carry as the generator anchor**. If there is no usable 7-iron carry in the bag, ask for it before generation rather than attempting to infer the whole bag from an arbitrary club.

Because this action can add or replace multiple estimated distances, show a confirmation step before applying it.

Suggested confirmation intent:

> **Generate the rest of your bag?**
>
> We'll use your 7-iron carry to estimate the other club distances. This will update multiple clubs. You can edit every distance afterwards.

Actions:

- **Generate**
- **Cancel**

Implementation should clearly distinguish player-entered/retained values from values the generator is allowed to replace. At minimum, the confirmation must accurately describe what will change before it happens. Do not silently overwrite manual values.

## What exists now

`generateQuickSet(sevenIronCarry)` in `app/js/bag.js` takes one number and scales a fixed ladder:

```
scale = sevenIronCarry / GD_DEFAULT_CLUB_CARRY_M["7i"]
every club = round(default[club] * scale)
```

The ladder it scales is `GD_DEFAULT_CLUB_CARRY_M` (verbatim in `gd-app-core.js`, re-exported through `GDBubbleEngine.defaultBagRows`):

| Club | m | Club | m | Club | m |
|---|---|---|---|---|---|
| Driver | 230 | 6i | 160 | GW | 98 |
| 3W | 205 | 7i | 155 | SW | 82 |
| 4H | 180 | 8i | 142 | LW | 66 |
| 4i | 178 | 9i | 130 | | |
| 5i | 170 | PW | 115 | | |

### Why it needs replacing

The current generator is still effectively **Ghost Bag proportional scaling**.

Proportional scaling holds every club at a fixed ratio to the reference 7-iron. That creates visibly implausible results at lower and higher speeds. For example, because the reference LW is 66 m against a 155 m 7i, a golfer entering a roughly 60 m 7i can receive an LW around 25-26 m simply because both numbers are multiplied by the same scale.

That is not a useful model of how a slower player's bag behaves.

Long clubs are particularly speed-sensitive. As speed falls, Driver, fairway wood and hybrid distances tend to **compress toward each other**, because the golfer has less speed available to make the lower-lofted clubs separate properly. The proportional model preserves the reference gaps as percentages instead.

The wedge end has the opposite problem: wedge carry should not simply collapse or stretch in direct proportion to the 7-iron. Loft, delivery and the different speed relationship of shorter clubs matter.

So the Ghost Bag remains useful as a default/fallback bag, but it must stop being the mathematical template for generating an individual player's entire bag.

## Replacement generator model

The generator should move from proportional Ghost Bag scaling to a speed/loft/head-type model:

```
7i carry
    -> infer 7i club speed
    -> infer useful ball-speed / delivery characteristics internally
    -> club-specific speed + loft + head type
    -> per-club carry
    -> calibrate exactly back to entered 7i carry
```

The speed quantities are internal modelling tools, not extra data the player has to supply.

### 1. 7i carry -> inferred speed

One measured number in, an internal speed estimate out.

The relationship between 7-iron carry and 7-iron club speed is close enough to monotonic over the range the app cares about that this can be a fitted curve rather than a full ball-flight simulation.

Initial anchor points to validate:

| 7i carry | ~7i club speed |
|---|---|
| 100 m | 24.5 m/s |
| 130 m | 29.5 m/s |
| 155 m | 33.5 m/s |
| 175 m | 37.0 m/s |

Fit a smooth monotonic curve and clamp outside the supported range rather than extrapolating aggressively.

The inferred speed should remain **internal**. It is an estimate used to shape the generated ladder, not a launch-monitor measurement to present as fact.

### 2. Speed / ball speed + loft + head type -> carry

Per club, estimate carry from the player's inferred speed profile plus the characteristics of that club.

#### Speed relationship across the bag

Club speed is not a fixed multiple across all golfers. A player swings a driver faster than a 7-iron and a wedge slower, but the spread of usable speeds and launch efficiency changes with player speed.

The model therefore needs club-specific speed ratios that vary with the inferred 7i speed rather than simply multiplying all reference carries by one percentage.

At slower speeds, the top of the bag should compress naturally. At faster speeds, long clubs can separate more without forcing wedges to stretch by the same proportion.

#### Ball speed / efficiency

Where useful, convert inferred club speed into an internal estimated ball-speed/efficiency term by head type. This gives the model a better physical basis than treating carry as a direct percentage of the Ghost Bag.

This estimate remains internal and should not be shown as measured player data.

#### Loft

Nominal loft contributes to launch, spin and carry. Carry does not fall linearly with loft, so do not use a single metres-per-degree constant across the whole bag.

#### Head type

Infer head type from the club label:

| Pattern | Head type |
|---|---|
| `driver`, `1w` | driver |
| `3w`, `5w`, `wood` | fairway |
| `h`, `hybrid`, `rescue` | hybrid |
| `i`, `iron` | iron |
| `pw`, `gw`, `aw`, `sw`, `lw`, `wedge` | wedge |

Unrecognised labels fall back to iron, which is the safest neutral default through the middle of the bag.

A hybrid and an iron at similar nominal loft should not necessarily generate the same carry, especially for slower players.

### 3. Calibrate exactly to the player's 7-iron

The generated 7i must equal the entered **7-iron carry exactly**.

Whatever the physical model produces initially, calibrate the resulting ladder so the 7i lands on the player's supplied measurement.

The physics/speed model decides the **shape** of the ladder. The player's measured 7i decides where that ladder is anchored.

### 4. Loft gaps adjust spacing

Initial nominal loft map:

| Club | ° | Club | ° | Club | ° |
|---|---|---|---|---|---|
| Driver | 10.5 | 6i | 28 | GW | 50 |
| 3W | 15 | 7i | 32 | SW | 55 |
| 5W | 18 | 8i | 36 | LW | 59 |
| 4H | 22 | 9i | 40 | | |
| 4i | 24 | PW | 45 | | |
| 5i | 26 | | | | |

Where the bag has unusual adjacent clubs, the distance spacing should reflect the relevant loft/head-type difference rather than a fixed reference-bag gap.

Explicitly **do not** introduce a universal metres-per-degree constant. A degree has a different distance effect at different lofts and speeds. Use the local slope of the generator's own speed/loft curve instead.

## Carry vs total

This distinction must be explicit throughout the Bag UI and model.

**Generator input = carry.**

**Manual club distance input = carry.**

The generated model produces **base carry** values. Existing roll-out / firmness logic can then derive total distance separately.

Do not feed total distance into the 7i generator while treating it as carry, and do not label a carry field merely `Distance` where the golfer could reasonably enter total.

## Acceptance criteria

### Product behaviour

1. **Manual edits are isolated.** Editing one club's label or carry changes no other club.
2. **Stepper is truly 1 m.** Repeated presses visibly produce consecutive 1 m changes without the editor moving to another row.
3. **Sort after edit, not during it.** The open editor remains anchored until Done/Save.
4. **Carry is explicit.** Every generator entry point says 7-iron **carry**; manual distance editing is also clearly carry.
5. **Generation is explicit.** Whole-bag or multi-club recalculation only occurs after the player chooses Generate Bag / Generate Rest.
6. **Generate Rest confirms first.** The player is told multiple clubs are about to change and can cancel.
7. **No silent manual overwrite.** The implementation must have a clear rule for preserving player-entered values and accurately communicate any replacement before it happens.

### Generator model

8. **Ordinary players barely move.** For 7i carry 140-165 m, target every club within **±4 m** of the current generator unless testing shows a clear reason to change the reference expectation.
9. **Slow speeds compress at the top.** At 7i = 110 m, Driver -> 3W -> hybrid spacing must be materially more compressed than proportional Ghost Bag scaling.
10. **Wedges remain plausible.** Low 7i inputs must not create obviously collapsed wedge carries merely because the Ghost Bag was scaled proportionally.
11. **Monotonic, always.** Generated carry should decrease sensibly through the standard generated ladder for every supported 7i input (initial test range 90-185 m). No accidental crossovers.
12. **The measurement survives.** Generated 7i equals the entered 7i carry exactly for every input.
13. **Loft/head type matter.** Hybrid/iron and unusual loft gaps should affect generated spacing rather than inheriting fixed Ghost Bag ratios.
14. **No new required player data.** 7i carry remains the only required generator measurement. Inferred speeds remain internal.
15. **Generated values remain editable.** After generation, the bag behaves like a normal manual bag.

## Build shape

Create `scripts/gd-bag-generator-core.js` as a pure, testable generator module, exported in the same style as the other `*-core` files.

Keep the current `generateQuickSet` available behind the comparison/testing work until the replacement model has been checked across the supported 7i range and representative bags.

The Bag UI should call the generator explicitly; the generator must not be coupled to ordinary `setCarry`, rename or add-club operations.

The shared Bag editor (`scripts/gd-bag-core.js`) should separately receive the edit-session anchoring fix so the 1 m stepper issue is solved independently of the generator maths.

Note: `app/js/bubble-engine.js` is **generated**. If generator-supporting source changes land in `gd-app-core.js`, re-run `dev/generate-bubble-engine-client.js` rather than hand-editing the generated client copy.

## Implementation decisions now settled

- **7-iron carry stays the generator anchor.**
- **Normal add/edit is manual and isolated.**
- **Editing one club never automatically changes the rest.**
- **Generate Rest is an explicit separate action with confirmation.**
- **Carry is the user input; total remains derived separately.**
- **The Ghost Bag remains a fallback/default bag, not the new player's scaling model.**
- **The replacement generator should be speed/ball-speed/loft/head-type based.**
- **Inferred speed stays internal.**
- **Generated results can always be manually edited afterwards.**

## Calibration questions to validate during implementation

These are implementation/calibration questions, not blockers to the settled product flow:

1. Validate/refine the initial 7i carry -> club-speed anchor points against useful measured datasets.
2. Tune the driver-to-7i speed relationship at the slow end so long-club compression is realistic.
3. Tune head-type efficiency / estimated ball-speed relationships without presenting them as measured player statistics.
4. Validate whether ±4 m remains the right agreement band around ordinary 140-165 m 7i players.
5. Run explicit slow-player cases that previously produced implausible wedge values and confirm the replacement model fixes the ladder as a whole rather than special-casing LW.
