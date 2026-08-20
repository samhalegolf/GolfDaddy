# The Play Owner — concept

Design only. No code. The thing this describes is `app/js/marshal.js`; when it's
agreed, `play.js` keeps Leaflet, the DOM and the projection seam, and takes every
decision from it. Names for all the pieces are in §10.

Companion to `GPS_PLAY_OWNERSHIP_2026-08-08.md`, which is the audit of why the
current arrangement drifts.

*Rev 6 — Live is sticky, and the banners. (Rev 5: the Marshal and Trace. Rev 4:
open shots and deferred logging. Rev 3: the Logged screen. Rev 2: Play button,
Preview unlock, edge dot.)*

---

## 1. The one idea

**There are two flows, and the app is never in both.**

- **Preview** — looking at a hole. Placing yourself is planning a shot. Nothing
  is recorded.
- **Live** — playing the hole you are standing on. GPS drives the dot, and the
  shot you record is a real one.

Everything else hangs off that. The failures on course came from one screen
trying to be both at once, so the same tap meant "plan a shot" and "log a shot"
depending on eleven booleans.

---

## 2. What decides the flow

Two facts, and the flow is the answer to both:

```
liveHole   — the hole you pressed Play on. Null until you do.
viewHole   — the hole on screen.

flow = logging ? 'logging'
     : (liveHole !== null && viewHole === liveHole) ? 'live' : 'preview'
```

`logging` is the third flow, added later and described in §4.3. It is a
deliberate excursion with one job and one way in, and it sits **outside** the
other two rather than inside Preview — which is where it started, and where it
caused trouble.

`flow` is **derived, never stored**. There is no mode flag to fall out of sync,
and no toggle for you to leave set wrong.

Consequences that fall out for free:

- Never pressed Play → `liveHole` is null → everything is Preview. Off-course
  testing is a normal state, not a broken one.
- Flick ahead to hole 5 while playing 3 → `viewHole` 5, `liveHole` 3 → Preview.
  Hole 3 is untouched. Come back and Live resumes exactly as it was.

**The arrows browse. They do not move you on.** Next / Previous move `viewHole`
and nothing else, exactly like the picker, so stepping off the live hole is
Preview. They used to walk the round while Live, which meant the hole you were
"playing" kept up with your thumb rather than with your feet: skip ahead to read
the next hole and the app quietly decided you were on it, with the live dot and
the green numbers reporting a hole you were nowhere near. **`liveHole` moves
when you press Play, and at no other time.**

### Losing GPS does not end the round

**`liveHole` is set by Play and cleared by End Round. Nothing else touches it.**

Not a dropped fix, not a denied permission, not a walk into trees, not a phone
that slept for twenty minutes. You are on hole 7 because you said so, and the
app does not get to decide otherwise on the strength of a bad signal.

Two facts that were tangled together, now separate:

| | |
|---|---|
| **Am I in a round, on this hole?** | `liveHole`. Sticky. Play sets it, End Round clears it. |
| **Do I have a usable fix right now?** | Its own fact. Affects what Track can *show* — never which flow you are in. |

So GPS quality gates exactly one thing: **whether the Play button is offered.**
You cannot start a round the app cannot place you in. Once started, it holds.

With no fix, Track stays Track on the hole you are playing: the dot goes quiet,
the distances hold their last honest value, the camera does not move, and a
small "no fix" note says why. When one returns it simply carries on. Nothing
lurches, nothing switches, nothing is lost.

(A round left running is caught by the existing 3-hour resume expiry, not by
GPS. Forgetting to press End Round costs nothing.)

### The Play button

Live starts one way: a big **Play** button.

- It appears **only when a trusted fix says you are at the course** — the same
  course-radius check `maybeAdoptGpsFix` already does, now that the centre is
  derived properly. At home on the couch it simply is not there, so Preview is
  the only thing on offer and that is correct.
- It names the hole it will start: **"Play hole 7"**.

**Before the round** it starts **the hole you are standing on** — the nearest one
to your fix — and moves the view there. You have not chosen a hole yet, so the
app picks the obvious one, and naming it on the button makes that unsurprising
before you press. That is also what makes starting from the car park work.

**During the round** it is the answer to *"can I start the hole I am looking
at?"*. Scroll to a hole and Play appears on it **once your fix says you have
arrived** — within `HOLE_ARRIVAL_M` (100m) of its tee, falling back to its
green. Looking at hole 12 from the 4th fairway offers nothing, because you are
not there.

So the round moves on like this: finish a hole, arrow or picker your way to the
next one, walk to it, and Play comes up. Two facts have to agree — the hole you
chose and the ground you are standing on — and only then does `liveHole` move.

No prompt, no dialogue, no confirmation step. One button that is either there or
not.

### The banner

A single thin strip at the top, in the same slot either way, saying which flow
you are in:

```
   ●  LIVE · Hole 7                              ← green
   ◌  PREVIEW · Hole 5          Return to 7 ›    ← grey
   ●  LOGGING · Hole 4          Cancel ›         ← amber
```

Two things it is doing:

1. **It is a readout, not a decoration.** It renders from the same derived
   `flow` as everything else, so it cannot say Live while the app behaves as
   Preview. If it flickers, that is a real flow flicker and Trace has the
   Signal that caused it (§11) — which is the point of having it at all.
2. **Preview's version carries the way back.** "Return to 7" is one tap, so a
   look ahead can never become a place you are stuck. Logging's version is
   **Cancel**, because leaving that flow throws away the ball you placed rather
   than merely changing which hole is on screen.

Logging gets its own banner rather than borrowing Preview's for a reason: it is
the one state you can be in for a hole you are not standing on where the button
in front of you **writes to the card**. Reading "PREVIEW" there would be a lie
about what Shot End is about to do.

Flow changes are a first-class Trace row, so *"why did it switch?"* is always
one glance: `FLOW live→preview ← VIEW_HOLE_CHANGED`.

---

## 3. Preview

The purpose is to look at a hole and see what a shot from a spot looks like.

It has two modes and you cycle between them:

```
( SETUP ) ──── place yourself ────► ( AIM )
     ▲                                 │
     └────────── Unlock ───────────────┘
```

**SETUP** — the pill is up: *Head To the Tee* / *Tap where you're standing*.
The hole is framed tee to green. No bubble.

**AIM** — you placed yourself, so **the lock-in is automatic** and the bubble,
aim line and rings are there straight away. Seeing the shot is the entire point
of being here, so there is nothing to press. Drag to aim.

**Unlock** is the way back. It clears the placement and returns you to SETUP
with the pill up, so you can change your mind about the tee or tap somewhere
else. That is its whole job in this flow.

**Preview cannot open a shot.** There is no Lock here, and nothing you do
creates a record — no Course Data, no pin, no scorecard. That is load-bearing,
not a simplification: previewing hole 5 must never be able to invent a shot on
hole 5, and you should be able to hand someone the phone to look at a hole
without touching the round.

**Preview cannot log anything either.** It has exactly two modes and no way into
a third.

This is a correction. Preview used to grow a finish mode when a placement landed
within 40m of a green — you tapped near the putting surface and got the ball and
the Shot End button. It read as a convenience and behaved as a trapdoor: the
mode you ended up in depended on where your finger went rather than on anything
you chose, and it pulled `finish` state into a flow that is supposed to be inert.
That is what "some general preview state leaking into the system" meant.

Placing yourself now always means the shot view, wherever you place it. Closing
a shot Live opened is a real and necessary thing to be able to do, but it is its
own flow with its own entrance — §4.3.

---

## 4. Live

Four modes. One resting state, two excursions, and one screen you land on when
the hole's play is done.

```
                    Unlock, or moved off the lock
                  ┌──────────────────────────────┐
       Lock       ▼                              │
   ┌──────────► ( AIM ) ─────────────────────────┘
   │                │
( TRACK ) ◄─────────┤ Shot End
   │  ▲             │
   │  │ Back        ▼
   │  └────── ( LOGGED ) ────── [ Hole 4 ] ──────► next hole, TRACK
   │                ▲
   │                │ confirm
   └──────────► ( FINISH ) ◄──── also reachable from Preview, for any
      arrive at green, or             hole still holding an open shot
      the hole has an open shot
```

**TRACK is the resting state. Everything returns to it. Nothing else is
sticky.**

### 4.0 Why Shot End is always the last shot

**Lock closes the previous shot and opens the next one.** Lock on the tee starts
shot 1; walking to the ball and locking again ends shot 1 there and starts shot
2. So mid-hole boundaries need no separate action — the next Lock is the
boundary.

Which leaves **Shot End as the only thing that closes a shot without opening
another** — the last one of the hole. That is why it earns a screen of its own
rather than quietly returning you to Track.

### 4.1 Track — the default

This is what you see when you pull the phone out of your pocket. Every time.

- The dot follows GPS.
- Front / centre / back to the green, always on screen.
- The camera frames you and the green.
- **No bubble. No aim line. No rings.**

### 4.2 Aim — entered by Lock

Lock means *"I am standing over this shot."* In Live it is deliberate, which is
the difference from Preview: there, placing yourself was the plan; here, GPS
already knows where you are, so pressing Lock is the only thing that says you
are about to hit.

- The bubble, aim line and rings appear at your position.
- The camera locks to start → target and stops chasing you.

**Aim releases itself once you have clearly walked off the lock point** — two
consecutive fixes more than ~30m away, the same pattern as the tee-pin release.
You locked in, you hit, you walked. A bubble anchored where you stood three
minutes ago is precisely the thing that looked random on course.

Releasing the view does not end the shot. The shot stays in flight; the next
Lock closes it, or Finish does. You lose the picture, never the record.

Exits: **Shot End** (records where it finished, → Logged), **Unlock** (abandons
the view, → Track), or the auto-release above.

### 4.3 Finish — logging where the shot ended

Finish is the precise version of Shot End, for when a raw fix is not good enough
— which is any shot that ended on or near the green.

- The dot becomes a ball you drag to where the shot actually finished.
- The shot's **origin** is drawn where you locked in, so you can see the shot you
  are reconstructing rather than guessing from a bare green.
- Confirming records it and lands on Logged.

#### The open shot

Lock writes a start. Shot End writes an end. A shot with a start and no end is
**open**, and that single condition is the whole availability rule:

> **Finish exists for a hole exactly when that hole has an open shot.**

Nothing arms, nothing expires, nothing has to be remembered. It follows from the
data, so it cannot drift out of step with it:

- Everything logged → no open shot → Finish is not offered, and arriving at the
  green does not open it. Correct, because there is nothing to log.
- You locked in, hit, and walked off → open shot → Finish stays reachable for
  that hole for as long as it takes you to get round to it.

Proximity still decides when it **opens itself** — arriving at the green with an
open shot is the common case and should not need a tap. The open shot decides
whether it is **possible at all**.

#### Logging holes later — the Logging flow

Because the rule is data and not proximity, you can play several holes quickly
and log them afterwards:

1. Play 4, 5 and 6 on feel — lock in, hit, next hole, without ever pressing Shot
   End. Each hole is left with one open shot.
2. Those holes are **marked in the hole picker**, so the catch-up list is the
   thing you were already going to use to navigate.
3. Tap the **0** on hole 4. That is the only way in. The origin is drawn where
   you played from and there is a ball to place.
4. Drag it to where the shot finished. Shot End. **You are put straight back on
   hole 7, in the flow you were in**, with no Logged screen in the way.
5. Do 5 and 6.

**Logging is its own flow**, not Preview with a finish mode bolted on:

- **One entrance.** The picker's outstanding badge, and nothing else. There is
  no proximity rule, no control that appears in Preview, no signal that leaks in
  from somewhere adjacent.
- **One job.** Close a shot something else opened. It can never Lock, never
  place, never open a shot. There is deliberately no way to add a shot after the
  fact: the thing worth catching up on is the outcome of an approach you already
  locked, and a retro-add would be a second, unverifiable way for shots to exist.
- **It remembers where you came from.** Confirming or cancelling both put you
  back on the hole you were viewing, in the flow you were in. Going to the picker
  to close one thing out should not cost you your place. Cancel writes nothing
  and leaves the mark on the card.

#### The picker's marks

The hole picker already exists — tap the hole number and you get a grid of every
hole in play, tap one to jump there. Each tile now also carries what the record
says about that hole:

```
   ┌──────┬──────┬──────┬──────┬──────┬──────┐
   │  1   │  2   │  3   │  4   │  5   │  6   │
   │ 0-0  │0-0 x2│ 0-0  │  0   │  0   │      │
   ├──────┼──────┼──────┼──────┼──────┼──────┤
   │ [7]  │  8   │  9   │  10  │  11  │  12  │
   └──────┴──────┴──────┴──────┴──────┴──────┘

   0        an origin locked, outcome still missing — and a BUTTON
   0-0      a shot with both ends
   0-0 x2   more than one, which a par 5 legitimately is
   [ ]      the hole you are on
```

- **Where it comes from:** counted straight off `shots[hole]` — entries with an
  `end` are `done`, entries without are `open`. Nothing sets it and nothing
  clears it; it is a view of the record, so it cannot go stale or get left behind
  on a hole change.
- **What clears the 0:** logging that shot. Nothing else.
- **Two intents, one tile.** Tapping the **0** opens Logging for that hole.
  Tapping anywhere else on the tile just looks at the hole. The target you hit
  says which — no mode, no long-press, no second screen.
- **Why the picker:** it is already how you would navigate to hole 4 from hole 7,
  and it already lists every hole. The catch-up list and the navigation are the
  same list.

`x2` and `x3` exist because a par 5 is honestly two or three locks, and a card
that collapsed them into one would be lying about what you did.

This is also the cart case, just with a shorter gap: hit the approach, drive to
the next tee, park, open Finish for the hole you just played, drag the ball onto
the green, log it. Then walk back and putt.

Pressing Next Hole with a shot still open is **not** warned about. Leaving it
open is the feature, and the mark in the picker is the reminder.

### 4.4 Logged — the in-between screen

Where Shot End and Finish both land. It says the shot is recorded and offers the
next hole, and it **waits** — you press the button when you are actually at the
next tee, not when the app decides you have moved on.

```
   ┌──────────────────────────────┐
   │                              │
   │        Shot logged           │
   │        3rd · 148m · 7i       │
   │                              │
   │      Score      ─   4   +    │
   │                              │
   │      ┌────────────────┐      │
   │      │    Hole 4  →   │      │
   │      └────────────────┘      │
   │                              │
   │      Back to hole 3          │
   │                              │
   └──────────────────────────────┘
```

**The score stepper** starts at par for the hole and writes straight to the
scorecard. This is the one moment you have definitely finished a hole, so it is
the cheapest place in the round to record it — no trip to the tool rail. Leaving
it alone records par; the scorecard stays editable either way.

**Pressing Hole 4** is the one place an arrow-like control is allowed to commit,
and it checks: if the fix agrees you have arrived at the 4th, `liveHole` and
`viewHole` both move and you land in Track there. If it does not, it previews
hole 4 and leaves **Play** waiting for you.

The asymmetry with the arrows is deliberate. The arrows are browsing, so they
always land in Preview. This button names a hole and you pressed it having just
finished a shot, so it is a statement of intent — and the fix is what decides
whether that intent has caught up with your feet yet.

**Logged is about the hole you just played, and nothing else.** A catch-up
returns you where you were rather than routing through here, so this screen has
one button with one job: the next hole, or the end of the round. It used to
branch three more ways for finding the next outstanding hole and getting back
from it; that is the picker's job now.

**Back to hole 3** dismisses it and returns to Track on the hole you are on. This
one is not optional: after logging the approach you still have to putt, and a
screen that traps you at the next tee while you are standing on the green would
be worse than no screen at all. It is also the way out of a Shot End you did not
mean to press.

So the cart sequence reads straight through: hit the approach → drive to the
next tee → open Finish → drag the ball onto the green → **Shot logged** → walk
back and putt (Back to hole 3, or just leave it sitting there) → return to the
cart → **Hole 4**.

---

## 5. Unlock, in one line

**Unlock always returns you to the resting state of the flow you are in.**
Preview rests at SETUP, so Unlock brings the pill back. Live rests at TRACK, so
Unlock hands the dot back to GPS. Same button, same meaning — "stop aiming" —
and the flow decides where that lands you.

---

## 6. The camera never chases a distant fix

**The camera frames the hole. It never widens to fit a player who is not on it.**

Today the frame solver takes your position as one of the points it must fit, so
standing 600m away blows the frame out until the hole is a speck and the whole
thing lurches every time a fix lands. That is the jumping around.

Instead: if the live fix projects outside the viewport, it is **clamped to the
edge** — on the line from the centre of the framed view toward where it really
is — and labelled with how far that way it actually is.

```
   ┌──────────────────────────────┐
   │                              │
   │            ▲ green           │
   │            │                 │
   │            │                 │
 ◄─┤ ● 640m     │                 │      the dot, pinned to the edge,
   │            │                 │      pointing at the real location
   │            ▲ tee             │
   └──────────────────────────────┘
```

No threshold and no magic number: the question is simply *does it fit on
screen*, and the answer is already known once it has been projected. Two
behaviours, one rule.

Where it shows up:

- **Preview** — always, since you are by definition not on the hole you are
  viewing. Look ahead at hole 5 from the 3rd fairway and you get hole 5 framed
  properly with "you are 380m back that way".
- **Before Play** — sitting in the car park looking at hole 1, the hole is
  framed and you are on the edge with a number.
- **Live/Track** — should not normally happen, since you are on the hole. If it
  does, the same rule handles it rather than the frame exploding.

The distance is measured from the centre of what is on screen, so the arrow and
the number describe the same line. (Alternative worth a moment's thought:
measure from the tee instead, since that is where the hole begins. I have gone
with screen centre because it matches what the arrow is doing.)

---

## 7. What the Marshal holds

```
round:  { courseKey, pkg, centre, nines }
liveHole: number | null          // set by Play, cleared by End Round. Nothing else.
hasFix:   boolean                // affects what Track draws, never the flow
viewHole: number                 // what is on screen
mode:   'setup' | 'track' | 'aim' | 'finish' | 'logged'
player: { point, source }        // in Preview this is your placement
shots:  { [hole]: [ {start, target, end|null} ] }   // end null = OPEN
finish:  { ball, placed }        // the drag in progress, nothing more
logging: { hole, ball, placed, from } | null        // the catch-up, and where to return
logged:  { record }              // what the Logged screen is reporting
camera: { stage, frame, parked }
```

`shots` is the only record of what happened, and **an open shot is just one with
`end === null`**. Everything about availability reads off that — no arming flag,
no lifetime, nothing to reset at a hole change.

Preview uses `setup` and `aim`. Live uses `track`, `aim`, `finish` and `logged`.
Logging has exactly one mode, `finish`, and no way to set another — which is
enforced in `setMode`, so a future signal cannot write a live or preview mode
while a catch-up is open.
**Aim is the same mode in Preview and Live** — what differs is how you get in (a
placement vs a Lock) and whether anything is recorded on the way out.

Derived, never stored: `flow`, whether the bubble draws, whether the Play button
shows and what it says, which face the dock button wears, whether the pill is
up, **whether Finish is offered (open shot on this hole)**, **whether Play is
offered (arrived at the hole on screen)**, **what each picker tile is marked
with (counted off `shots`)**, what the Logged button says, and whether the dot
is edge-clamped.

Signals:

`ROUND_OPENED` · `FIX_RECEIVED` · `FIX_LOST` · `PLAY_PRESSED` · `END_ROUND` ·
`VIEW_HOLE_CHANGED` · `NEXT_HOLE` · `PREV_HOLE` · `ADVANCE_TO_HOLE` · `PLACED` ·
`LOCK` · `UNLOCK` · `AIM_DRAGGED` · `SHOT_END` · `FINISH_OPENED` · `LOG_OPENED` ·
`BALL_MOVED` · `FINISH_LOGGED` · `SCORE_SET` · `BACK` · `PACKAGE_UPDATED`

`PLAY_PRESSED` and `ADVANCE_TO_HOLE` are the only two signals that can write
`liveHole`. `NEXT_HOLE` and `PREV_HOLE` cannot, and `LOG_OPENED` cannot — which
is what makes "the round moves when you say so" a property of the table rather
than a habit.

`FIX_LOST` is worth calling out: it changes what Track can draw and **nothing
else**. It cannot touch `liveHole`, so it can never move you between flows.

Nothing else writes state. Every `(mode, signal)` pair either has a defined
result or is explicitly ignored — which is the part that does not exist today,
and the reason nobody can say what the app should do in a given combination. An
ignored signal is not silence: Trace shows it (§11).

---

## 8. Decisions

**a) Shot End → the Logged screen. SETTLED (§4.4).**
Not a return to Track and not an auto-advance: an in-between screen that reports
the shot and holds a **Hole 4** button until you press it. Nothing advances on
the app's initiative.

**b) Finish is offered whenever the hole has an open shot. SETTLED (§4.3).**
Better than the arming flag I proposed: derived from the record rather than from
proximity with a lifetime, so it is right retroactively and cannot drift. It
lives in a small control of its own — the dock is busy with
Lock / Shot End / Unlock.

**c) Every flow gets a banner. SETTLED (§2).**
Not just Preview: Live gets one too, in the same slot, so the strip is a
continuous readout rather than something that appears when things go odd. Wired
to the derived `flow`, so it cannot disagree with the app's actual behaviour,
and flow changes are a Trace row so a slip is one glance from an explanation.
Logging got the third when it became its own flow.

**d) Live is sticky. SETTLED (§2).**
Losing GPS does not end the round. `liveHole` survives every signal except End
Round.

**e) The arrows browse; only Play moves the round. SETTLED (§2). Revised.**
The first build let Next / Previous walk `liveHole` while Live, on the reasoning
that the arrow meant "I have moved on". On the course it meant the opposite: it
was also how you read ahead, so glancing at the next hole made the app believe
you were standing on it. Splitting the two — arrows for the view, Play for the
round, gated on having actually arrived — costs one press per hole and removes a
whole class of "why is it showing me that hole" from the round.

**f) Logging is its own flow, not a Preview mode. SETTLED (§4.3). Revised.**
Catching up on a hole started as Preview + `finish`, reachable both from a
control in Preview and from a placement that landed near a green. Both were
mistakes: the second meant your finger position chose the mode, and the first
meant a flow defined as "records nothing" carried the button that records. It is
now a third flow with one entrance (the picker's outstanding badge), one job
(close a shot something else opened), and a memory of where to put you back.

Nothing open.

---

## 9. What this buys

- The bubble cannot appear without you asking. In Live it needs a Lock; in
  Preview it needs a placement you made.
- A hole you preview cannot record anything, because Preview has no writes.
- Picking the phone up mid-round always shows the same thing, because Track is
  the resting state and both excursions release themselves.
- The camera cannot lurch, because it frames one thing and clamps everything
  else to the edge.
- The round never advances on its own, and never ends on its own. The only
  things that move you are pressing the next hole's number and pressing End
  Round. A bad signal cannot do either.
- No shot can be quietly lost. An unfinished one is visible in the picker until
  you close it, and closing it is available from anywhere.
- Scores get recorded, because the ask arrives at the one moment you have
  definitely finished the hole.

---

## 10. The systems, and what they are called

Six words. Everything in the build should be one of them.

| Name | What it is | Where it lives |
|---|---|---|
| **Marshal** | The controller. Owns every piece of state, is the only thing allowed to change it, and decides what should be on screen. Directs the other systems; is never directed by them. | `js/marshal.js` → `ClarityApp.marshal` |
| **Signal** | Something happened — a fix, a tap, a button, a resize. **The only way in.** | `marshal.signal("LOCK", …)` |
| **Scene** | What should be on screen right now, as plain data. Derived fresh from state on every signal. Holds no opinions of its own. | `marshal.scene()` |
| **Painter** | Makes the Scene real — Leaflet, the DOM, the overlays. Diffs the new Scene against the last and applies the difference. **Never decides anything.** | `js/play.js` |
| **Order** | One field of that diff being applied, tagged with the Signal that caused it. Not authored — it falls out of the diff. Exists so there is a word for the unit Trace records. | — |
| **Trace** | The provenance log, and the debug window that shows it. | `js/trace.js` → `ClarityApp.trace` |

A golf marshal keeps play moving and stops things happening out of order, which
is exactly the job. If the metaphor grates, `controller` reads fine and nothing
else in the design depends on the word.

The flow is one direction, always:

```
   Signal ──► Marshal ──► Scene ──► Painter ──► screen
                 │
                 └──► the other modules (gps, shot, pin, wind, bag,
                      scorecard, course-data, bubble engine)
```

Two rules that make it hold:

1. **The other modules never call each other, and never touch the DOM.** They
   answer questions and hold records. The Marshal is their only caller.
2. **Nothing reads state back off the screen.** No
   `classList.contains("map-framed")` deciding behaviour. That habit is what
   turned the DOM into a state store, and it is the thing being retired.

---

## 11. Trace — where did that come from?

The point of a controller that guarantees the visual state is being able to
*prove* it does. Trace is that proof.

**If something changes on screen it either came through the Marshal or it did
not, and Trace says which.**

### The Watch

Trace watches the elements the Marshal guarantees, and only those:

`#gpsDot` · `#aimBubble` · `#bubbleSvg` · `#greenRing` · `#pinMarker` ·
`#pinDistance` · `#greenFocusBall` · `#distanceBar` · `#shotActionBtn` ·
`#startPill` · `#map` (style) · `#surfaceImage` · `body` (class list)

That list is the contract, written down. Leaflet's own tiles and panes are
outside it, so its constant churn is not noise in the log.

### The two attributions

Every change to a watched element is one of:

- **`✓ via marshal`** — an Order, carrying the Signal that caused it.
- **`⚠ LEAK`** — the element changed and no Order was in flight.

A leak is not automatically a bug, and Trace does not throw. It is a system
acting on its own — which, as you say, looks fine right up until it does not.
The value is that it is *visible* the moment it appears, rather than three weeks
later as a symptom nobody can place.

### How a leak gets caught

Legitimate writes go through the Painter, which stamps them. For everything
else, in debug builds only, Trace wraps the write paths on watched elements —
`classList` add/remove/toggle, `setAttribute`, the `style` setters — and grabs
`new Error().stack`. The first frame that is not Trace's own is the culprit, so
the log names the file and line rather than just saying "something did this".

That is why the answer is a wrapper and not a `MutationObserver` on its own: the
observer tells you an element changed, but not who changed it, which is the only
part you actually need.

### The window

Newest at the top, and a leak count on the tab so you notice without opening it.

```
 ┌── TRACE ───────────────────────────── 1 leak ──┐
 │ 09:41:22.180 ✓ TRACK      gpsDot.pos           │
 │                           ← FIX_RECEIVED       │
 │ 09:41:22.180 ✓ TRACK      distances.front/back │
 │                           ← FIX_RECEIVED       │
 │ 09:41:19.902 ✓ AIM→TRACK  bubble.hide          │
 │                           ← UNLOCK             │
 │ 09:41:19.902 ✓ AIM→TRACK  svg.clear            │
 │                           ← UNLOCK             │
 │ 09:41:19.870 ⚠ LEAK       body.class -shot     │
 │                           ← tool-rail.js:88    │
 │ 09:41:19.410 ⇄ FLOW       live → preview       │
 │                           ← VIEW_HOLE_CHANGED  │
 │ 09:41:14.006 · TRACK      FIX_LOST             │
 │                           no flow change       │
 └────────────────────────────────────────────────┘
```

Four row types, because each answers a question you actually ask on course:

- **`✓`** — a change, its mode (with the transition when there was one), and the
  Signal behind it. *"Why did that move?"*
- **`⚠`** — a change with no Signal behind it, and the code that did it.
  *"Where the hell did that come from?"*
- **`⇄`** — a flow change, and what caused it. *"Why am I suddenly in preview?"*
  The banner tells you that you switched; this row tells you why.
- **`·`** — a Signal the Marshal accepted that changed nothing. *"I pressed it
  and nothing happened."* Invisible in every other kind of logging, and usually
  the confusing case. `FIX_LOST` logging as *no flow change* is the everyday
  version: proof the round held.

### The part worth building it for

Every visual state comes from a Scene, every Scene comes from a Signal, and the
Marshal holds no hidden state. So **the Signal list replays the round exactly.**

Trace records signals with timestamps; export it and feed it back in and you get
the identical sequence of Scenes at your desk. A weird thing on the 9th stops
being "I think the bubble did something" and becomes a file you can step
through. That is worth more than the leak detection on its own, and it is only
possible because there is one way in.

Debug-only: the wrapping costs something, so the window and the write hooks are
behind a flag (a query param and a stored setting). Trace's signal recording is
cheap enough to leave on always, which is what makes an on-course capture
possible without planning for it.
- "Which state am I in" has one answer, derived from two numbers, instead of
  eleven booleans and nine CSS classes.
- Anything that slips the leash announces itself, with a file and a line, the
  first time it happens rather than three weeks later.
- A round can be replayed from its signal log, so an on-course oddity becomes
  something you can step through at a desk.
