# Practice Import Job State

Active Practice Data imports are now tracked in `localStorage` under `gd_practice_import_job_v1`.

The job record survives Practice Data navigation, component rerenders, tab switches, and app refreshes. It stores the import source, import date, current status, checkpoint text, progress, accepted/rejected counts, native row count, and the saved `sessionId` / `captureId` after the native shot store write completes.

The visible recovery surface is rendered inside `Clarity Shot Library`. Active jobs show as `Import running in background` or `Import saving`; completed jobs show `Import completed`; failed jobs show `Import failed - review` with a recoverable review/discard action and compact diagnostic detail.

Only one active or failed import is supported for now. Starting another import is blocked until the active job completes or the failed job is explicitly discarded. Once a save has started, the UI does not offer cancellation; the save either completes and records the saved capture/session, or the job is marked failed for review.
