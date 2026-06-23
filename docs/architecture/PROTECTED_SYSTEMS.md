# CLARITY CADDY PROTECTED SYSTEMS

Version: 1.0  
Purpose: Systems and principles that must not be casually refactored, renamed, merged, simplified, or replaced.

---

## Highest-Level Warning

Do not assume Clarity Caddy is a generic GPS app or golf statistics app.

Do not put anything in front of the user unless explicitly asked for.

If technical/detail information is practical to include in the UI, put it behind a tab, drawer, or intentional reveal.

---

## Protected Systems

The following systems require explicit scope before editing:

- Practice Data Photo Scan → Native Data
- Practice Shot Data Gate
- Cluster Finder / Practice Bubble Generator
- Course Data Collection
- Bubble Engine internals
- Green Wand
- Auto Course Mapper
- GPS framed-box camera model
- Ghost Bag / 0.0 default Bubble
- Degree offset architecture

---

## Degree Offset Architecture

Degree offset is the shared language between systems.

Do not replace it with:
- generic statistics
- moving averages
- live per-club dispersion models
- raw-shot-driven bubbles
- dashboard metrics

Complex analysis can exist inside processors. The cross-system output should remain the stable degree offset.

---

## My Bubble Guardrail

My Bubble is:
- active playing model
- stable degree offset + Bag scaling

My Bubble is not:
- fluid
- a moving average
- Course Bubble
- a generic literal dispersion bubble
- automatically updated by course data

Course Bubble must never update My Bubble.

---

## Course Data Guardrail

Course Data records where the actual result finished relative to the Bubble that existed at shot time.

Course Data is not a generic golf stats engine.

Rules:
- Missing data is acceptable.
- Corrupt data is not acceptable.
- No valid previous held Bubble/shot transaction means no save.
- Never pair across holes.
- Never use `bubble_rendered` as an outcome.
- Never allow one endpoint event to be consumed more than once.

---

## GPS Guardrails

GPS Play is brittle and still evolving.

Protected GPS principles:
- Framed-box camera model
- Green truth first
- Fairway-line anchoring when green is unreachable
- Pretend GPS Position separate from Legacy Two-Tap
- Green Zoom separate from Green Focus
- Visible failure over hidden fallback
- Captured hole frame as working surface
- No generic live-map auto-fit fallback in normal GPS Play

---

## Legacy Two-Tap Warning

Legacy Two-Tap Shot Builder:
- tap one = start/ball
- tap two = green
- may exist only as isolated manual tool

Pretend GPS Position:
- one tap = pretend I am standing here
- sets active player position
- must not request second green tap
- must not enter Two-Tap state

Avoid ambiguous names:
- manual mode
- tap mode
- manual GPS
- manual shot

---

## Green Wand Guardrail

Green Wand is a specialist protected tool for improving green shape.

It must not become:
- GPS Play owner
- Course Data owner
- My Bubble owner
- general mapping fallback
- cleanup/refactor target during unrelated work

---

## Auto Course Mapper Guardrail

Auto Course Mapper owns initial course map generation and hole frame capture.

It must not:
- continuously remap
- run on every refresh
- override GPS Play
- replace stored valid course data without explicit mapping workflow

---

## Anti-Fallback Rule

Prefer visible failure over silent fallback.

Do not add hidden fallbacks unless explicitly designed and approved.

Every fallback must answer:
1. What failed?
2. Why is this fallback safe?
3. What system is it falling back to?
4. Is fallback better than visible failure?

Do not revive old systems through hidden fallback paths.
