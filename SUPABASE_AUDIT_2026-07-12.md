# Supabase Audit — Clarity Caddie (live app)

Date: 2026-07-12
Scope: live app (`index.html` + `scripts/` + `functions/`), verified against the production Supabase project (`zcevluithwoumvafhmct`) using the public anon key. Existing tables return a permission error (RLS deny-all, correct); missing tables return "table not found".

## 1. Is the schema in Supabase? Partially — 3 tables are missing

Verified live:

| Table | Live? | Schema file |
|---|---|---|
| app_accounts | Yes | payment-schema.sql |
| app_profiles | Yes | payment-schema.sql |
| app_sync_events | Yes | payment-schema.sql |
| user_entitlements | Yes | payment-schema.sql |
| payment_events | Yes | payment-schema.sql |
| **payment_products** | **MISSING** | payment-schema.sql |
| **payment_admin_events** | **MISSING** | payment-schema.sql |
| support_tickets | Yes | support-schema.sql |
| **shot_library_batches** | **MISSING** | shot-library-schema.sql |
| practice_email_intake_events | Yes | practice-email-schema.sql |
| practice_import_batches | Yes | practice-email-schema.sql |
| practice_native_shots | Yes | practice-email-schema.sql |

The payment schema was evidently run before `payment_products` / `payment_admin_events` were added to the file, and `shot-library-schema.sql` was never run.

### Impact of the missing tables

- **Shot Library sync is silently broken in production.** `scripts/gd-shot-library-sync.js` + `functions/shot-library-sync.js` treat Supabase as the source of truth for practice/launch-monitor data, but every push/pull 404s server-side. All shot library data is living only in each device's localStorage cache (`gd_launch_monitor_data_v1`). A cleared browser = lost data.
- **Payment admin product manager is broken.** `payment-admin.js` queries `payment_products` with no fallback → the products list/edit endpoints fail. Checkout itself still works because `create-checkout-session.js` catches the error and falls back to env price IDs (`STRIPE_PRICE_DAY_PASS`, etc.).
- **Admin audit trail is lost.** Writes to `payment_admin_events` fail.

### Fix (5 minutes)

All schema files use `create table if not exists`, so they're safe to re-run. In the Supabase SQL Editor run, in order:

1. `supabase/payment-schema.sql` (fills in payment_products + payment_admin_events)
2. `supabase/shot-library-schema.sql`

Then verify:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

And confirm shot library sync starts flowing: open the app, then
`select count(*) from public.shot_library_batches;`

## 2. Where Supabase is used today (working)

- **Accounts / profiles / auth** — Supabase Auth + `app_accounts`/`app_profiles` via `/api/account-sync` and the auth-* functions; client outbox retry in `clarity-cloud-sync.js`. Solid.
- **Payments / entitlements** — Stripe webhook + `user_entitlements`/`payment_events`; access stays locked unless Supabase confirms. Solid.
- **Permissions** — `/api/permission-resolver` reads Supabase; fails closed if misconfigured. Good.
- **Support tickets** — written to `support_tickets`.
- **Practice email intake** — parsed into `practice_import_batches`/`practice_native_shots`.
- **Admin tuning** — diff-from-defaults rides `app_profiles.profile_json`. Nice pattern.

## 3. Places that should use Supabase but don't

Ordered by how much I'd prioritise them:

1. **Captured surface scans — dead outbox.** `index.html` (~line 1512) queues per-hole scan payloads into localStorage key `gd_captured_surface_supabase_outbox_v1`, explicitly labelled `cloudTarget: "supabase"` — but nothing ever sends the queue. There is no endpoint and no table. It just accumulates up to 36 rows forever. Either add a `captured_surfaces` table + sync endpoint (mirror the shot-library pattern), or delete the queue code so it isn't mistaken for real sync.
2. **On-course shot events** (`gd_shot_events_v1`, `scripts/gd-shot-events.js`) — zero network code. Real round data is device-only and unrecoverable. This is the same class of data as the shot library, which you already decided belongs in Supabase.
3. **Course play pipeline / round state** (`gd_course_play_pipeline_v1`, `scripts/gd-course-play-pipeline.js`) — local only. At minimum, completed-round summaries should land in Supabase.
4. **Published course maps** — stored as one JSON blob in Netlify Blobs (`functions/course-maps.mjs`). Works, but it's a second source of truth with no history, no per-course rows, and a single-key size ceiling. When you next touch it, a `course_maps` table (one row per course, RLS service-role-only) would be more consistent with the rest of the app.
5. **Player stat preferences** (`gd_stats_consistency_pct`, `gd_practice_tolerance_master_pct`, plot filters, etc.) — device-local. Low stakes, but they could ride `profile_json` exactly like adminTuning already does, so settings follow the account.
6. **Backups** (`clarity-backup.js`) — manual JSON download only. Fine as an escape hatch; becomes much less critical once 1–3 sync.

## 4. Housekeeping

- `supabase/support-schema 2.sql` is byte-identical to `support-schema.sql` — delete the duplicate (same for the various `* 2.md` files).
- No migrations directory / Supabase CLI config — schema is applied by hand, which is exactly how the three tables got missed. Consider `supabase init` + numbered migrations, or at least a single `schema.sql` that concatenates all four files so one run applies everything.
- RLS check: all live tables reject anon reads (deny-all, service-role via Netlify functions only) — correct posture given the anon key is public.
