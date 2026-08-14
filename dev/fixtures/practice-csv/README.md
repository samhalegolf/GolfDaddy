# Practice CSV fixtures

One folder per case. `input.csv` is the file as it would arrive; `expected.json`
is what it must turn into. `dev/practice-csv-regression.test.js` runs them all.

## Adding a case

1. `mkdir dev/fixtures/practice-csv/<name>` and drop in `input.csv`.
2. Write `expected.json` with just a `why` line (and `options` if the parse needs
   them, e.g. `{"sourceName": "trackman-export.csv"}`).
3. Run `node dev/practice-csv-regression.test.js --update` to fill in the result,
   then **read it**. If it is what the parser should do, commit it. If it is not,
   don't bless it — see below.

## When the parser gets it wrong

Add a `pending` key with a one-line reason, and write `parse` / `batch` / `rows`
by hand describing what *should* happen. The case is then reported as a known
gap and does not fail the suite. When someone fixes the parser and the case
starts passing, the suite fails on purpose so the `pending` line gets deleted —
that is the ratchet, and it's why gaps don't quietly rot.

`--update` never touches a pending case.

## What is asserted

- `parse` — delimiter, whether a header was found, the canonical field each
  column mapped to, warnings, unit system and where it came from, provider,
  session date.
- `batch` — row counts, gate status, and the provenance gaps the metric layer
  reads.
- `rows` — the Clarity-native shots. Ids and timestamps are stripped; any field
  that is null, blank or empty is left out rather than written as `null`.
