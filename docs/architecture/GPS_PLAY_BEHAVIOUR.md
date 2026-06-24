# CLARITY CADDY GPS PLAY BEHAVIOUR

Version: 1.0  
Purpose: Behaviour expectations for GPS Play. Use with the Truth File before GPS audits or patches.

---

## GPS Play Mission

GPS Play combines:

- My Bubble
- Bag
- GPS
- Course map
- Environmental information
- Hole frame
- Wind/slope data

to support a simple playing decision.

GPS Play is also the surface where Course Data events are collected, but GPS Play does not decide what Course Data is valid to save.

---

## GPS First Entry Path

A user may use Clarity Caddy as a free GPS app before understanding the deeper Clarity systems.

The GPS app should work with:

- Ghost Bag
- 0.0 degree default Bubble
- basic GPS distances
- slope
- wind
- course mapping

The experience should be useful without forcing practice scan, coaching, or full onboarding.

---

## Pretend GPS Position

Pretend GPS Position means:

> Use this tapped point as the active player position.

Rules:
- one tap only
- sets simulated:true
- sets active player position
- sets shot origin
- selects mapped green if available
- must not request a second green tap
- must not enter Legacy Two-Tap
- must not enter Green Focus from the follow-on click/tap
- must not create Course Data

---

## Legacy Two-Tap Shot Builder

Legacy Two-Tap means:

1. tap where ball/start is
2. tap where green is
3. manually build shot

Rules:
- must be explicitly opened
- must not share state with Pretend GPS Position
- must not be a fallback for modern GPS Play
- must not silently publish into Course Data

---

## Green Zoom

Green Zoom is visual-only.

Purpose:
- temporary close view for moving/aiming Bubble around green

Rules:
- must not collect Course Data
- must not alter GPS state
- must not change shot origin
- must not change planned-shot ID
- must not become Green Focus
- should return to locked frame cleanly

---

## Green Focus

Green Focus is an arrival/outcome workflow, not a zoom feature.

Rules:
- may provide a result marker/point
- must not own Course Data save/no-save decision
- must not mutate GPS position
- must not borrow Green Zoom state
- must not save if no valid previous held Bubble/shot transaction exists

---

## Shot End

Shot End should only save when Course Data Collection confirms a valid previous held Bubble/shot transaction.

Rules:
- valid held shot saves once
- second Shot End press saves nothing
- no held shot saves nothing
- hole 1 cannot pair with hole 2
- `bubble_rendered` cannot be an outcome
- after success, transaction is consumed and cleared

---

## Framed-Box Camera Model

Do not replace this with generic map auto-fit.

### Box 1: Pre-frame / default hole view
- Green mostly fills inner green box.
- Tee sits near lower tee box.
- Used before shot lock-in.

### Box 2: Shot lock-in frame
- Fits green or Bubble into target-decision box.
- Origin/GPS dot does not need to be visible.
- Target area matters most.

### Box 3: Green Zoom
- Visual-only temporary zoom.
- Separate from Green Focus.

---

## Fairway Line

Fairway line has two key jobs:

1. Camera orientation.
2. Bubble start/anchor logic when green is unreachable by max club in Bag.

If green is unreachable:
- do not stretch Bubble to green
- anchor/start along fairway line
- if fairway truth unavailable, visible failure is better than silent straight-to-green projection

---

## Live Map

Live map can support:
- course capture
- mapping
- diagnostics
- deliberately approved extension workflow

Live map must not silently become:
- normal GPS camera
- hidden camera fallback
- old framing recovery
- replacement for captured hole frame
