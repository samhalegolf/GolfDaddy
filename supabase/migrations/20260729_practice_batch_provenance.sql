-- Practice import provenance: unit_system, session_date and provider on the
-- batch, plus hit_at on the shot.
--
-- Why these three, and why now. A staged practice row currently reads
-- "7 Iron,142,151" and nothing in the row, the batch, or the schema says
-- whether 142 is metres or yards. A 7-iron carrying 142 yards is a good
-- amateur; 142 metres is tour level. The observations engine cannot tell those
-- apart, and no amount of later processing can recover the answer - the
-- information was never written down. The OCR import path carried a per-metric
-- unit; the native path dropped it, which was a regression rather than a
-- simplification.
--
-- Same argument for the other two. Without session_date every period filter,
-- session trend and baseline delta is computed against import time, which is
-- when the email happened to arrive rather than when the balls were hit.
-- Without provider, rules cannot skip monitors that do not measure what they
-- test, so a spin rule silently never fires instead of visibly not applying.
--
-- practice_native_shots holds 2 smoke rows at the time of writing, so this is
-- greenfield. Every column is nullable and additive: nothing existing breaks,
-- and a batch that cannot state its unit is held at needs_review by the
-- application gate (see batchGateStatus in scripts/gd-practice-parser-core.js)
-- rather than being rejected or guessed at.

alter table public.practice_import_batches
add column if not exists unit_system text,
add column if not exists session_date date,
add column if not exists provider text;

-- Constrain rather than document: 'metric' or 'imperial' or unknown. Unknown
-- is a legitimate state - it means the source never declared one - so the
-- column stays nullable and the gate, not the database, decides what an
-- undeclared batch is allowed to do.
alter table public.practice_import_batches
drop constraint if exists practice_import_batches_unit_system_check;

alter table public.practice_import_batches
add constraint practice_import_batches_unit_system_check
check (unit_system is null or unit_system in ('metric', 'imperial'));

-- timestamp, NOT timestamptz. A launch monitor exports wall-clock local time
-- with no zone attached ("2026-07-28 14:03"), and timestamptz would silently
-- read that as UTC - shifting an evening range session onto the next day for
-- anyone west of Greenwich, and doing it invisibly. Storing the wall clock as
-- given records exactly what the provider said and nothing it did not. Day
-- granularity for period filters comes from batches.session_date.
alter table public.practice_native_shots
add column if not exists hit_at timestamp;

-- Period filtering is the engine's most common query shape: this player, these
-- clubs, this date window. Index the batch by player and session date so that
-- does not become a scan once real sessions land.
create index if not exists practice_import_batches_session_date_idx
on public.practice_import_batches (player_key, session_date desc);

create index if not exists practice_native_shots_hit_at_idx
on public.practice_native_shots (player_key, hit_at desc);
