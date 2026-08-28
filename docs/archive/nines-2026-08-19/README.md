# Multi-nine courses — earlier attempt (2026-08-19)

**Archived reference. Not loaded, not built, not active.** Kept because it
answers a question the current work has only half-answered.

These two files were an earlier run at multi-nine facilities — Howeston's three
nines being the case that prompted both. They were parked in `_to_delete/` and
removed from the tree on 2026-08-29; this is that content restored somewhere it
can actually be found.

## What's here

`gd-multi-nine-courses.js` (236 lines)
: Client-side play-order picker. A 27-hole facility offers three nines; the
  player picks two, and they get loaded into `scorecard.holes` renumbered 1–18
  so everything downstream keeps working unchanged.

`nines.js` (83 lines)
: A later, smaller take on the same idea. Keeps holes on their **real physical
  numbers** and only decides which subset is in play and in what order, on the
  grounds that `/api/course-package` already keys geometry by `holeNumber`.
  Stores selections under `clarity:nines:v1`.

Note those two disagree with each other about renumbering. That disagreement is
the interesting part — see below.

## What replaced it, and what didn't

The **scan side** is superseded. `functions/lib/gd-facility-loops-core.mjs` now
separates a facility into nine-hole loops from scorecard evidence, detects
combined play-order cards by ground overlap, and publishes the nines as
courses sharing a `facility_key` — named where a card names them, `Course 1/2/3`
where nothing does.

The **play side** is not built. The picker still offers the nines individually
and nothing stitches two of them into a round.

## The question these files left open — now answered

Both archived files assumed the app had to know the club's own pairings. It
does not.

**Decided 2026-08-29:** a 27-hole facility publishes as three nines, and at
round start the player is asked which two they are playing and taps them. That
is their eighteen, in the order they tapped. The club's combinations are not
stored at all — three siblings sharing a `facility_key` is everything the
prompt needs, and free choice beats a stored list, because clubs rotate their
pairings and a printed "Red + White" cannot express White then Red.

A `facility_play_orders` column and the code writing to it were built and then
removed on the same day for that reason. It is a **GPS Play** concern; if the
published payload ever needs a trigger, that is where it goes.

The renumbering caveat below still applies to whatever builds the prompt.

## The caveat worth reading before building the play side

`gd-multi-nine-courses.js` documents a real constraint that has not gone away:

> Everywhere downstream reads `scorecard.holes` as a flat array and treats
> array index `(hole - 1)` as the lookup key, so a hole MUST be numbered 1..N
> contiguously.

Its consequence, in the file's own words: captured-surface scans and GPS hole
data get filed under the **renumbered** hole (1–18), not the course's physical
hole number. Play the same nine paired with a different other nine and the
renumbering shifts, so previous scans for that nine no longer line up.

`nines.js` takes the opposite bet — keep the physical numbers — which avoids
that problem and instead needs the flat-array assumption removed app-wide.

Today's server-side work sidesteps the question entirely by publishing each
nine as its own course with its own 1–9 numbering. Whether the play side should
stitch two published nines at runtime, or load a renumbered 1–18 composite, is
still open, and these two files are the two answers already considered.

## Recovering the rest

Everything else that was in `_to_delete/` — patches, diffs, an icon preview, and
25 stale git lock artefacts — is still in git history at
`_to_delete/` before the 2026-08-29 deletion.
