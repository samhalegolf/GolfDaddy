# Play Store listing — Clarity Caddy

Draft copy and form answers for the Play Console listing. Positioning follows
`docs/architecture/CLARITY_CADDY_TRUTH_FILE.md`: a coaching platform and GPS
caddy, not a generic GPS app and not a statistics dashboard. Copy sells
interpretation, not data volume.

Only features present in the **app** surface are described. The studio admin
surface is pruned from the shipped bundle (`docs/APP_STUDIO_SPLIT.md`), so
nothing here promises course-database editing, visual-engine tuning or developer
settings.

---

## App name (max 30)

```
Clarity Caddy: Golf GPS
```

23 characters. Includes "Golf GPS" for search without keyword-stuffing, which
Play's metadata policy prohibits.

Alternative if you want the brand alone: `Clarity Caddy` (13).

---

## Short description (max 80)

```
Golf GPS distances built around your real shot pattern, not averages.
```

69 characters. This is the line shown in search results and it does more work
than any other field.

Alternatives:

```
Golf GPS that learns how you actually play, then simplifies the decision.
```

```
Know the number, trust the club. Golf GPS built for decisions, not data.
```

---

## Full description (max 4000)

```
Clarity Caddy is a golf GPS and coaching app built on a simple idea: better
decisions come from better interpretation, not from more numbers.

Most golf apps bury you in statistics. Clarity Caddy does the opposite. It
learns the pattern in how you actually hit the ball, then quietly uses that
pattern to give you distances you can commit to.

ON-COURSE GPS

Open the app, pick your course, and play. You get clear distances to the front,
middle and back of the green, with the shape of the hole in front of you. No
setup required, no calibration, no reading a manual first. The GPS is free and
genuinely useful on its own.

BUILT AROUND YOUR PATTERN

Every golfer misses in a direction. Clarity Caddy finds the stable pattern in
your shots and scales it through your own bag distances, so the number you see
reflects how you play rather than how a scratch golfer plays.

You do not need to understand the model for it to work. It runs underneath the
app and shows up as a clearer picture on the hole in front of you.

PRACTICE THAT CONNECTS TO PLAY

Point your camera at a launch monitor readout and Clarity Caddy reads the
numbers straight off the screen, so a practice session takes seconds to record
instead of being typed in by hand.

Practice data and course data are then compared, so you can see where your range
pattern and your on-course pattern agree, and where they do not. That gap is
usually the most useful thing in the app.

MAP ANY COURSE

If your course is not in the library, you can map it from your phone. Drop the
pins, scan the layout, and play it. You are not waiting for someone else to add
your home track.

YOUR BAG, YOUR NUMBERS

Set up your clubs with your own carry distances. Everything the app suggests is
scaled through that bag, so recommendations stay honest to your actual game.

TRACK YOUR ROUND

Keep score, record shots as you play, and build a picture of the round that
feeds back into your playing model.

FREE AND PAID

The GPS experience is free. Paid membership and short-term passes unlock the
deeper coaching layer: practice analysis, pattern comparison and the
personalisation that comes with it. Basic GPS is never restricted to create
pressure to upgrade.

Clarity Caddy is designed to support your decisions on the course. You remain
responsible for your own choices, for course rules and for playing safely.

Built in Auckland, New Zealand by Sam Hale Golf.
Questions or feedback: samhalegolf@gmail.com
```

Roughly 2,200 characters, well inside the limit.

Notes on why it reads this way:

- Leads with the decision benefit, not the feature list, matching "clarity over
  statistics".
- Never says "Bubble". It is the right internal name and the wrong shop-window
  word — a browsing golfer has no idea what it means. The concept is described in
  plain language instead.
- States plainly that GPS is free, which reflects "trust before monetisation" and
  heads off the most common one-star review for a paid-tier golf app.
- Carries the responsibility line from `terms.html`.
- No superlatives, no competitor names, no "#1", no unverifiable claims — all of
  which draw Play metadata rejections.

---

## Graphics

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG | `assets/brand/clarity-app-icon.png` — verified 512×512 and fully opaque (has an alpha channel, but zero non-opaque pixels, so Play's no-transparency rule is satisfied) |
| Feature graphic | 1024×500 PNG/JPG, no alpha | Draft at `assets/store/play-feature-graphic.png` — replace with a real design before launch |
| Phone screenshots | 2–8, 9:16, min 1080px on the short edge | **Missing — capture from a real round** |
| Tablet screenshots | Optional | Skip unless you want tablet placement |

The feature graphic is the banner at the top of the listing. It is required and
the listing cannot publish without it.

Suggested screenshot order — first two matter most, since they are what shows in
search results:

1. GPS play view on a real hole, distances visible
2. The hole with your pattern shown on it
3. Practice import — the launch-monitor scan
4. Practice vs course comparison
5. Bag setup
6. Scorecard mid-round

Capture these on a real course, not in a simulator. A screenshot of a real hole
with real numbers sells the app; a synthetic one looks like a mockup and reads as
one.

---

## Categorisation and contact

| Field | Value |
|---|---|
| App category | Sports |
| Tags | Golf, GPS, Sports training |
| Email | samhalegolf@gmail.com |
| Website | https://caddy.claritygolf.app |
| Privacy policy | https://caddy.claritygolf.app/privacy.html |
| Account deletion | https://caddy.claritygolf.app/delete-account.html |

**Both URLs only work once the site is redeployed.** Until 2026-07-27 the deploy
build shipped the legal pages only under `/assets/`, so `/privacy.html` returned
404 — verified against the live site. `privacy.html`, `terms.html`,
`support.html` and `delete-account.html` are now in `publicPaths` in
`scripts/clarity-deploy-build.js`, and the `/assets/` copies are redirect stubs
so older links keep working. Confirm both URLs return 200 on the live site before
submitting: Play fetches the privacy policy during review and a 404 fails it.

---

## Data safety form

This is the most rejection-prone part of a Play submission, because the answers
are cross-checked against what the app actually does. Draft answers below;
**items marked (CONFIRM) need your decision before submitting.**

Data collected and linked to the user:

| Type | Collected | Purpose | Optional? |
|---|---|---|---|
| Email address | Yes | Account management | Required |
| Name / profile info | Yes | Account management, app functionality | Optional |
| Photos | Yes | App functionality — profile photo, launch-monitor scans | Optional |
| Precise location | Yes | App functionality — on-course distances | Required for GPS play |
| Approximate location | Yes | App functionality — nearby course lookup | Required for GPS play |
| Purchase history | Yes | App functionality — paid access status | Required for purchases |
| App activity / other user-generated content | Yes | App functionality — rounds, shots, bag setup, practice data | Optional |

Answers to the standard questions:

- **Is data encrypted in transit?** Yes — all API traffic is HTTPS.
- **Can users request data deletion?** Yes. Give Play
  `https://caddy.claritygolf.app/delete-account.html`. That page documents an
  email-verified request route, what is deleted, what is retained and why, and
  how to cancel a store subscription first.

  There is also an **in-app** route as of 2026-07-27 — Settings → Delete account
  → type DELETE — backed by `functions/account-delete.js`. Play prefers seeing
  both, and reviewers do look for the in-app path. The email route remains for
  users who cannot sign in, and those requests are still actioned by hand within
  the 30-day commitment.
- **Is any data shared with third parties?** Processors are listed in
  `privacy.html`: Supabase (database and auth), Netlify (hosting, functions,
  blob storage), Stripe (web payments), RevenueCat (store purchase validation),
  Apple/Google (in-app purchases), Resend (transactional email). These act on
  your behalf, so they are declared as processing rather than sharing.

  Separately, the device itself contacts Esri/ArcGIS, OpenStreetMap, the Overpass
  API and Open-Meteo for tiles, course outlines and weather. Those see the
  device's IP and the area being requested, but no account data. This is
  disclosed in the policy.
- **Location collected in the background?** **No.** The app holds a single
  foreground `watchPosition` for the round and the manifest declares no
  `ACCESS_BACKGROUND_LOCATION`. Keep it that way — declaring background location
  triggers a separate Play review with a video demonstration requirement and is a
  common multi-week delay.

`privacy.html` was rewritten on 2026-07-27 to cover collection, location scope,
photos, named processors, retention periods, deletion rights, security, children
and change notification. The retention periods in it (30 days to live deletion,
12 months to backup overwrite) were chosen as reasonable defaults — **confirm
they match what you can actually deliver**, because they are now a public
commitment.

---

## Content rating

Run the questionnaire in Play Console. Expected outcome for this app: **Everyone
/ PEGI 3**. There is no violence, no gambling, no user-to-user messaging, no
mature content. Declare that the app contains in-app purchases and that it
collects location.

Do not skip the "does the app share user location with other users" question —
the answer is no, and getting it wrong is a rating misdeclaration.

---

## Target audience

Select **18+**, or 13+ at the youngest. Do not include under-13 age bands:
that opts the app into Play's Families policy, which brings extra requirements
around ads, data collection and content review that a location-collecting
subscription app does not want.

---

## Pre-submission checklist

- [ ] Upload keystore created and backed up off-machine
- [ ] Signed AAB built
- [ ] `.well-known/assetlinks.json` carries the Play App Signing fingerprint
- [x] Feature graphic made (draft at `assets/store/play-feature-graphic.png`)
- [ ] Screenshots captured on a real course
- [x] Privacy policy expanded with retention and deletion
- [x] Data deletion path documented at `/delete-account.html`
- [ ] Site redeployed so `/privacy.html` and `/delete-account.html` return 200
- [ ] Retention periods confirmed as deliverable
- [ ] Billing products created and RevenueCat connected
- [ ] Sandbox purchase completed end to end on a real device
- [ ] Real-course GPS verified on a physical phone
