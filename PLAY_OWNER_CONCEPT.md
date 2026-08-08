# The Play Owner — concept

Design only. No code. The thing this describes is `app/js/play-state.js`; when
it's agreed, `play.js` keeps Leaflet, the DOM and the projection seam, and reads
everything else from here.

Companion to `GPS_PLAY_OWNERSHIP_2026-08-08.md`, which is the audit of why the
current arrangement drifts.

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
liveHole   — the hole GPS says you are on, once you have affirmed it. Can be null.
viewHole   — the hole on screen.

flow = (liveHole !== null && viewHole === liveHole) ? 'live' : 'preview'
```

`flow` is **derived, never stored**. There is no mode flag to get out of sync,
and no toggle for you to leave set wrong.

Consequences that fall out for free:

- No fix, denied, or off course → `liveHole` is null → everything is Preview.
  That is the off-course-testing case, and it is a normal state rather than a
  broken one.
- Flick ahead to hole 5 while standing on 3 → `viewHole` 5, `liveHole` 3 →
  Preview. Hole 3 is untouched. Come back and Live resumes exactly as it was.
- Walk to the next tee → GPS proposes the new hole → affirm → `liveHole` moves.

### Affirming the hole

On entering the round, the first trusted fix proposes the nearest hole:
*"Looks like you're on hole 1 — playing it?"* Affirming sets `liveHole`.

Until you affirm, the round is in Preview. That is honest: the app genuinely
does not know where you are yet, and Preview is a perfectly good place to be
while it finds out.

---

## 3. Preview

The purpose is to look at a hole and see what a shot from a spot looks like.

| | |
|---|---|
| **How you get in** | Open a hole you are not standing on. Or open the round before GPS has confirmed anything. |
| **Camera** | The hole, tee to green. |
| **Placing yourself** | Head To the Tee, or tap where you'd stand. |
| **The bubble** | Appears the moment you place yourself. Seeing the shot is the entire point of being here. Drag to aim. |
| **What is recorded** | **Nothing.** No shots, no Course Data, no pin, no scorecard. |
| **Lock** | Does not exist in this flow. |
| **Green focus** | Does not exist in this flow. Nothing to log. |
| **How you get out** | Navigate to another hole, or back to the live one. |

Preview writing nothing is load-bearing, not a simplification. It means
previewing hole 5 can never record a shot on hole 5, and it means you can hand
someone the phone to look at a hole without touching the round.

---

## 4. Live

Three modes. One resting state and two deliberate excursions.

```
                        ┌──────────────────────────────┐
                        │                              │
       Lock             ▼          moved off the lock   │
   ┌──────────────►  ( AIM )  ──────────────────────────┘
   │                    │
   │                    │ Shot End / Unlock
   │                    ▼
( TRACK ) ◄────────────────────────────────┐
   │  ▲                                    │
   │  │                                    │ logged, or Back
   │  └────────────────────────────────────┤
   │                                       │
   └──────────────►  ( FINISH )  ──────────┘
      arrive at green, or the access point
```

**TRACK is the resting state. Everything returns to it. Nothing else is
sticky.**

### 4.1 Track — the default

This is what you see when you pull the phone out of your pocket. Every time.

- The dot follows GPS.
- Front / centre / back to the green, always on screen.
- The camera frames the hole so you and the green are both visible.
- **No bubble. No aim line. No rings.**

That last line is the rule you asked for: you do not see a bubble unless you
explicitly asked for one.

### 4.2 Aim — entered by Lock

Lock means *"I am standing over this shot."*

- The bubble, aim line and rings appear at your position.
- The camera locks to start → target and stops chasing you.
- Drag to aim.

**Aim releases itself once you have clearly walked off the lock point** — same
pattern as the tee-pin release: two consecutive fixes more than ~30m away. You
locked in, you hit, you walked. A bubble anchored where you stood three minutes
ago is precisely the thing that looked random on course.

Releasing the view does not end the shot. The shot stays in flight; the next
Lock closes it, or Finish does. You lose the picture, never the record.

Exits: **Shot End** (records where it finished, → Track), **Unlock** (abandons
the view, → Track), or the auto-release above.

### 4.3 Finish — logging where the shot ended

Finish is the precise version of Shot End, for when a raw fix is not good
enough — which is any shot that ended on or near the green.

- The dot becomes a ball you drag to where the shot actually finished.
- The camera holds the green being logged.
- Confirming records it and returns to Track.

**It arms per hole and stays available.** The first time you come within the
green radius on a hole, the access point appears — and it stays there until the
hole changes, however far you walk afterwards.

That is the cart case: hit the approach, drive to the next tee, park, open
Finish for the hole you just played, drag the ball onto the green where the
approach finished, log it. Then walk back and putt.

It still opens on its own when you arrive at the green, because that is the
common case. The access point is what makes it reachable again afterwards.

---

## 5. What the owner holds

The whole of it:

```
round:  { courseKey, pkg, centre, nines }
liveHole: number | null          // affirmed; null until GPS says so
viewHole: number                 // what is on screen
mode:   'track' | 'aim' | 'finish'      // live only; preview has no modes
player: { point, source }
shot:   { start, target }        // in flight, or null
finish: { armedForHole, ball, placed }
camera: { stage, frame, parked }
```

Derived, never stored: `flow`, whether the bubble draws, which face the dock
button wears, whether the start pill is up, whether the access point shows.

The events it accepts:

`ROUND_OPENED` · `FIX_RECEIVED` · `HOLE_AFFIRMED` · `VIEW_HOLE_CHANGED` ·
`PLACED` · `LOCK` · `UNLOCK` · `AIM_DRAGGED` · `SHOT_END` · `FINISH_OPENED` ·
`BALL_MOVED` · `FINISH_LOGGED` · `BACK` · `NEXT_HOLE`

Nothing else writes state. Every `(mode, event)` pair either has a defined
result or is explicitly ignored — which is the part that does not exist today,
and the reason nobody can say what the app should do in a given combination.

---

## 6. Three decisions still open

I have put my recommendation on each rather than leaving them blank. Push back
and I will change the model, not work around it.

**a) Shot End should not advance the hole.**
Your flow logs the approach from the next tee and then walks back to putt, so
auto-advancing would put the app a hole ahead of you. Recommendation: Shot End
records and returns to Track. **Next Hole is the only thing that advances**, and
the hole is over when you say so.

**b) The Finish access point needs its own control, not a dock face.**
Once it is armed, Track has two things you might do — Lock, and Finish — so one
button cannot carry both. Recommendation: the dock stays the shot control
(Lock / Shot End / Unlock) and Finish gets a small control of its own that
appears when armed and disappears at the hole change. It reads as what it is: a
thing that became available.

**c) Preview should not be reachable by accident.**
With flow derived from `viewHole`, tapping Next Hole while playing silently
drops you into Preview. Recommendation: say so on screen — a plain "Previewing
hole 5 · Return to hole 3" strip. One line, and the flow is never ambiguous.

---

## 7. What this buys

- The bubble cannot appear without you asking, in either flow, because in Live
  it needs `mode === 'aim'` and in Preview it needs a placement you made.
- A hole you preview cannot record anything, because Preview has no writes.
- Picking the phone up mid-round always shows the same thing, because Track is
  the resting state and both excursions release themselves.
- "Which state am I in" has one answer, derived from two numbers, instead of
  eleven booleans and nine CSS classes.
