# CLARITY CADDY TRUTH FILE

Version: 1.1
Purpose: Master source-of-truth for future agents, builders, audits, and stabilisation work.

This file sits above ordinary handover notes. Future work should read this before editing code.

---

# 1. Product Identity

Clarity Caddy is a coaching platform and GPS caddy app.

It is not a generic GPS app. It is not a generic golf statistics dashboard. It is not a raw-data viewing tool.

Its purpose is to create clarity: helping golfers understand their natural playing pattern, make better decisions, and gradually align what they do in practice with what they do on the course.

The core product is not “more data”. The core product is “better interpretation”.

---

# 2. Core Philosophy

## Clarity Over Statistics

Raw data exists to improve understanding, not to be displayed by default.

Clarity Caddy collects data, filters noise, finds stable truths, and presents a simple decision model.

Before adding any new metric, chart, variance display, confidence score, report, panel, or readout, ask:

> Does this increase clarity for the golfer making a decision?

If not, it should remain inside the processor or behind an intentional tab/reveal.

## Do Not Put Things In Front Of The User

Do not put anything in front of the user unless explicitly asked for.

If technical or detailed information is practical to include in the UI, place it behind a tab, drawer, or intentional reveal.

Technical depth may exist for coach/admin/debug/development, but the player-facing experience should stay simple.

## Trust Before Monetisation

The free GPS experience should be genuinely useful.

Do not artificially restrict basic GPS functionality merely to create payment pressure.

Premium value should come from deeper understanding, personalisation, coaching systems, Bubble/Clarity functionality, practice analysis, and advanced insight.

Monetise insight, not inconvenience.

## Invisible Complexity

The app should work before the user understands why it works.

A golfer should be able to open GPS, select/play a course, see useful distances, see a bubble, and play golf without needing practice capture, photo scanning, bubble calibration, or coaching knowledge.

---

# 3. Core Lifecycle

Image Scan → Practice Data Photo Scan → Practice Shot Data Gate → Native Club Data → Cluster Finder / Practice Bubble Generator → Practice Bubble → Adopt Practice Bubble as My Bubble → GPS Play → Course Data Collection → Course Bubble → Compare Practice Bubble, My Bubble, and Course Bubble → Update My Bubble from Practice Bubble when intentionally chosen.

Goal:

> Practice Bubble = My Bubble = Course Bubble

This means the player’s practice pattern, trusted playing model, and on-course behaviour begin to express the same underlying pattern.

---

# 4. The Secret Gate

The most important cross-system value is the stable degree offset.

Degree offset is the shared language between systems.

Complex logic may exist inside processors, but the systems should communicate through the stable offset degree.

Do not replace this architecture with generic statistics, moving averages, live per-club dispersion models, or raw-shot-driven bubbles.

The degree value is compressed understanding.

---

# 5. Bubble Definitions

## Practice Bubble

Practice Bubble represents the player’s pattern in practice.

It exists in the practice data graph and can be projected on the comparison graph.

It is produced by the Cluster Finder / Practice Bubble Generator.

It can be used as evidence for updating My Bubble.

Practice Bubble does not own Course Bubble or My Bubble.

## My Bubble

My Bubble is the active playing model.

It is not fluid. It is not a moving average. It is not automatically updated by course data. It is not a generic literal dispersion bubble.

My Bubble is built from:

Stable Degree Offset + Bag Scaling = GPS Playing Projection

My Bubble can be changed manually by coach/user controls, or intentionally by a button such as “Play With Practice Bubble”, which takes the Practice Bubble offset value and applies it to My Bubble while still scaling through the Bag.

Normal users should not need to see the degree value. Manual adjustment should be visual where possible, such as moving a simple bubble left/right on a fake golf hole or simple render and saving that as offset.

## Course Bubble

Course Bubble is diagnostic only.

It is never adopted into My Bubble. It never updates My Bubble. It does not act as a live player model.

Course Bubble exists to show where course results finished relative to the Bubble that existed at shot time.

A larger Course Bubble does not automatically mean worse execution. Environmental factors naturally increase variability. The meaningful comparison is whether the pattern character and offset behaviour are similar.

---

# 6. Core Systems And Ownership

## Practice Data Photo Scan

Owns:
- Photo processing

Must NOT own:
- Cluster logic
- Bubble generation
- My Bubble adoption

Inputs:
- Photo

Outputs:
- Raw Club/Ball Data

## Practice Shot Data Gate

Owns:
- Translation of scanned data into native formatting
- Storage of native data into the library

Must NOT own:
- Cluster logic
- Bubble generation
- My Bubble adoption
- Course data
- GPS play

Inputs:
- Raw photo process data

Outputs:
- Native Club Data

## Cluster Finder / Practice Bubble Generator

Owns:
- Cluster logic
- Practice pattern detection
- Filtering what matters vs what should be disregarded
- Finding the stable offset degree
- Generating Practice Bubble

Must NOT own:
- Photo processing
- Native data storage
- My Bubble adoption
- Course data
- GPS play

Inputs:
- Native Club Data

Outputs:
- Practice Bubble
- Stable Offset Candidate
- Practice bubble shape/scale values

## Practice Bubble

Owns:
- Practice model projection
- Practice graph representation
- Comparison graph projection

Must NOT own:
- Course Bubble
- My Bubble

Inputs:
- Cluster Finder / Practice Bubble Generator

Outputs:
- Practice Bubble

## My Bubble

Owns:
- GPS screen bubble projection
- Active playing model

Must NOT own:
- Practice Bubble
- Course Bubble
- Raw shot data
- Automatic learning
- Course statistics

Inputs:
- Manual adjustment
- Coach adjustment
- Intentional Practice Bubble offset adoption

Outputs:
- GPS projection
- Bubble scaled through Bag and normal club scaling logic

## Bag

Owns:
- Club distances

Must NOT own:
- Anything else
- Offset generation
- Bubble truth
- Course analysis
- My Bubble updates

Inputs:
- Club generator
- Manual input

Outputs:
- Carry and total numbers per club

Bag scales truth. It does not create truth.

Carry exists subtly underneath. Total distance is the main number used while playing. Soft/medium/hard conditions can affect total assumptions.

If no real Bag exists, Ghost Bag must exist so Bubble generation can always do something.

## GPS Play

Owns:
- Round flow
- Next-hole flow
- Behaviour relative to GPS pin
- Pretend GPS tap flow
- Bubble projection scaled to real size
- Wind/slope/environmental adaptations to projection
- Carry marker line from Bag/distance output
- Wind simulator + live wind interaction
- Scorecard generation
- Hole picker
- Display of slope data

Must NOT own:
- Course mapping
- Core My Bubble
- Practice processing
- Course library truth

Inputs:
- Course Map
- Wind data call
- Slope data call
- GPS location
- Pretend GPS tap location
- Shot end vs origin capture

Outputs:
- Course Shot Data

GPS Play is core, brittle, and still under active development. It is not frozen.

## Course Data Collection

Owns:
- Itself
- Deciding what to send to Course Data and what not to send

Must NOT own:
- GPS playing states
- GPS flow
- My Bubble updates
- Course statistics engine

Inputs:
- Green focus marker
- Shot end button hit
- Possible haptic feedback method

Outputs:
- Shot Data

Missing data is fine. Bad/corrupt data is worse. If there is no valid pairing between the shot end and the held previous bubble state, do not save it.

## Course Bubble

Owns:
- Its own projection
- Scaling within the Course Data workspace
- Course comparison view

Must NOT own:
- Anything else
- My Bubble updates
- GPS playing state

Inputs:
- Shot data from course

Outputs:
- Projection of course data on its own screen and comparison

## Green Wand

Owns:
- Itself
- Green shape improvement when called

Must NOT own:
- Anything else
- GPS Play
- My Bubble
- Course data
- Auto Mapper flow beyond its specific output

Inputs:
- Call from Auto Course Mapper

Outputs:
- More accurate green shape than may initially be available to the Auto Course Mapper

Green Wand is a specialist protected tool.

## Auto Course Mapper

Owns:
- Generating a course map by session
- Saving/generated course maps to database when appropriate
- Initial hole frame snapshot
- Geomarked objects

Must NOT own:
- Every refresh
- Continuous remapping
- GPS Play behaviour
- My Bubble
- Course Data interpretation

Inputs:
- Scanning a new course
- One-time scan/update of library course per user/session/open

Outputs:
- Course map for GPS round flow
- Initial hole frame snapshot
- Geomarked objects

Auto Course Mapper is not a continuous mapping service. Generate useful map data, store/cache it, and use it.

---

# 7. GPS App Entry Path

Clarity Caddy has two valid entry paths.

## GPS-first user

A user may arrive simply wanting a useful free GPS app.

They should be able to go straight to GPS and play.

They may see GPS distances, slope, front/middle/back style information, wind, a bubble, a bag icon/invite, and Ghost Bag fallback.

The first GPS experience should work even without an account, practice scan, or real bag where possible.

## Coaching/Clarity user

A user may arrive through the deeper coaching flow: practice scan, Practice Bubble, My Bubble, Course comparison, and coach involvement.

Both paths are valid.

---

# 8. Ghost Bag And 0.0 Bubble

Ghost Bag is not just a fallback. It is part of onboarding.

Ghost Bag + 0.0 degree offset = a working default Bubble.

This lets the GPS app work immediately and invites the user to later set their real Bag.

Do not break Ghost Bag.

---

# 9. Course Library Philosophy

Do not pretend Clarity Caddy has a giant curated course database.

The goal is not “we have every course.”

The goal is “this works surprisingly well on most courses.”

Course maps should become more centralised over time. The user/profile can hold recents, downloads, temporary captures, or local cache-style course access, but the long-term course truth should be centralised/backed up.

---

# 10. Course Mapping And Hole Frames

## Green Truth First

In mapping and geotagging, the green/hole is the priority truth.

Most exact correctness matters around the green.

Priority:
1. Green centre
2. Green shape
3. Green edge/boundary pins
4. Green scaling
5. Fairway line/direction
6. Tee location

Tee location is useful but not sacred. It is often variable/random. During live play the GPS dot and fairway line matter more than exact tee marker truth.

## Fairway Line Responsibilities

Fairway line has two key jobs:
1. Camera orientation
2. Bubble start logic when the green is unreachable by the max club in the Bag

If the green is outside the reachable max Bag distance, the Bubble should not stretch to the green. It should start/anchor along the fairway line.

This logic must not be accidentally removed.

## Captured Surface Over Constant Live Reinterpretation

The app should operate from clean captured hole images and trusted geotags rather than constantly realigning against live map.

The captured frame is the working surface.

Live map should not keep reinterpreting the hole unless explicitly designed for a narrow reason.

---

# 11. GPS Framed Box Camera Model

Do not replace the framed-box camera system with generic map auto-fit.

The boxes are intentional human-behaviour framing rules.

## Box 1: Pre-frame / Default Hole View

Purpose:
- Make every hole fill the screen consistently before lock-in

Behaviour:
- Green mostly fills the inner green box
- Tee sits near the small bottom tee box
- Hole feels predictable

## Box 2: Shot Lock-in Frame

Purpose:
- Show the target decision area

Behaviour:
- Fit either the green or the Bubble into the larger second box depending on shot context
- Origin/GPS dot does not need to be visible
- Target area matters more than showing where the player came from

## Box 3: Green Zoom Mode

Purpose:
- Temporary visual help for moving/aiming the Bubble around the green

Behaviour:
- Separate from green focus
- Button-triggered for now is acceptable
- Long-press/haptic can be explored later
- Should not change normal GPS behaviour
- Visual assistance only

---

# 12. GPS Camera Cleanup Principle

Stop building clever case-by-case camera movements.

Build one stable framing system.

Future GPS cleanup should remove old auto-fit commands, scattered special-case camera jumps, live-map realignment checks unless explicitly required, old framing systems that jump back in, and fallbacks that resurrect legacy camera logic.

All fitting tricks must serve the fixed box model.

Preferred model:

Captured hole image + trusted green geotags + fixed frame boxes = stable GPS view

For edge cases where the player goes outside the captured frame, explore a deliberate outer-frame/extension system rather than switching unpredictably to live map.

Smaller high-definition captures are preferred over one huge low-confidence full-hole capture.

---

# 13. Legacy Two-Tap Warning

The old Two-Tap Shot Builder is legacy.

It may remain as an isolated manual tool, but it must not mix with modern GPS Play.

Legacy Two-Tap Shot Builder:
- Tap 1 = where I am
- Tap 2 = where the green is
- Manually build a shot

Current Pretend GPS Tap:
- Tap map = pretend I am standing here
- Use that as active GPS/player location

These are different systems.

Avoid ambiguous names like manual mode, tap mode, or manual GPS.

Recommended names:
- Two-Tap Shot Builder
- Pretend GPS Position
- GPS Override Tap

---

# 14. Anti-Fallback Rule

Clarity Caddy should prefer visible failure over silent fallback.

Old system does not mean safe system.

Do not add hidden fallbacks unless explicitly designed and approved.

Every fallback must answer:
1. What failed?
2. Why is this fallback safe?
3. What system is it falling back to?
4. Is the fallback better than visible failure?

Do not revive old systems through hidden fallback paths.

Anti-Zombie Rule:

If a system is being replaced, either use the new system or explicitly invoke the old system. Never silently switch between them.

---

# 15. Score And Coaching Philosophy

Clarity Caddy does not judge whether a round was good or bad by score.

The app may have a scorecard, but score totals are not the primary truth. Other systems already handle scoring.

Score does not matter compared with whether the player is understanding and playing in line with their Bubble.

Clarity Caddy is not separate from swing improvement. Meaningful mechanical improvement should be built around what the individual already has.

The app may indicate where to look, but it must never presume to know the required technical intervention.

---

# 16. Coach / Client Architecture

Coach Dashboard and MyGolf are separate channels.

## Coach Dashboard

- List of players
- Client portal access
- View/adjust linked player setups
- Preload bag/data/practice setup before player activates
- Manage coach-client links

## MyGolf

- Coach’s own personal golf account
- Behaves like normal player/client experience
- Data labelled under coach’s own name

Do not blur these channels.

A coach should view a client through a portal context, not “play as” the client.

Coach can adjust client Bag, input data, adjust basic variables, and prepare account before authentication.

Coach should not enter live GPS Play as the client, merge their own MyGolf state with client state, or receive random extra insight panels just because they are a coach.

Linking flows:
- Coach creates/invites new player
- Player sets password/activates account
- Coach preloads setup before activation
- Existing coach + existing player link by QR/code
- Existing player can invite coach into a limited view/adjust account
- Client-side add-coach flow should support QR scan/code entry

---

# 17. Profile Architecture

Profile is not the master container for course maps.

Profile may contain identity/basic account, Bag, My Bubble access/settings, practice/shot data access, recent/downloaded course maps, and coach/client relationships.

Profile should not own master course library, permanent course truth, Auto Mapper logic, GPS Play flow, or Course mapping engine.

Course maps should be centralised, with profile acting more like recents/cache/download access for fast loading.

---

# 18. Admin vs Coach

Admin is effectively Sam only.

Do not overbuild admin as a product role.

Build the coach account around what coaches actually need. Anything extra can remain under Sam/admin tabs.

Admin-only areas may include experimental/arcade mode and other private tools.

If something currently admin-only becomes useful for coaches, move it deliberately into coach tools.

---

# 19. Protected Systems

The following are protected and should not be refactored, rewritten, merged, simplified, renamed, or reimplemented without explicit approval:

- Practice Data Photo Scan → Native Data
- Practice Shot Data Gate
- Cluster Finder / Practice Bubble Generator
- Course Data Collection
- Bubble Engine internals
- Green Wand
- Auto Course Mapper
- GPS framed-box camera model
- Ghost Bag / 0.0 default bubble
- Degree offset architecture

---

# 20. Biggest Future-Agent Warning

Do not assume Clarity Caddy is a generic GPS app or golf statistics app.

Do not put anything in front of the user unless explicitly asked for.

Do not make My Bubble fluid.

Do not let Course Data update My Bubble.

Do not revive old systems through hidden fallbacks.

Do not replace the degree-offset gate with generic stats.

Do not turn player-facing Clarity into a dashboard of numbers.

---

# 21. Stabilisation Guidance

Recommended next steps:

1. Save this file as `docs/architecture/CLARITY_CADDY_TRUTH_FILE.md`.
2. Create `SYSTEM_MAP.md`, `PROTECTED_SYSTEMS.md`, `GPS_PLAY_BEHAVIOUR.md`, `GPS_FRAMING_MODEL.md`, and `CLEAN_BUILD_RULES.md`.
3. Audit GPS Play before patching it.
4. Identify and remove old camera/framing systems that do not serve the framed-box model.
5. Isolate the legacy Two-Tap Shot Builder away from modern GPS Play.
6. Add a visible build/version label in the app corner.
7. Use consistent archive names such as `clarity-caddy-stable-v001.zip`, `clarity-caddy-stable-v002.zip`, `clarity-caddy-stable-v003.zip`.
8. Keep a separate file-custody chat/workflow whose only job is to receive latest archive, verify files are present, build/check, rename consistently, and return latest clean archive.
9. Do not let patch chats also become custody/archive chats unless explicitly required.

---

# 22. Final Rule

Whenever making a product decision, ask:

> Does this increase clarity?

If the answer is no, it probably does not belong in Clarity Caddy.
