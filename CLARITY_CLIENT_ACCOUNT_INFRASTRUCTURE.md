# Clarity Client Account Infrastructure Review

## Current State

The app already has a useful local prototype account layer:

- `gd_accounts_v1`: local browser account records
- `gd_player_profiles_v27`: player/profile records
- local roles: `coach` and `player`
- permission layer: `admin`, `coach`, `player`, `subscribedPlayer`
- coach/player links through `linkedPlayerIds`, `linkedCoachIds`, and `profileId`
- coach directory view
- coach-created player accounts
- coach-created coach accounts
- per-coach visibility controls for bag, shot data, course mapping, and play/GPS

This is enough for prototype workflow testing and for shaping the product model.

## Not Enough For Real Client Accounts Yet

Before this becomes a real multi-client cloud account system, it needs server-owned identity and authorization.

Current gaps:

- Local account passwords are prototype-only hashes in browser storage.
- Roles are client-controlled and can be edited in browser storage.
- There is no Supabase Auth user yet.
- There is no organization/client table.
- There is no server-enforced coach-to-player access policy.
- There is no invitation flow for adding players or coaches.
- There is no audit trail for coach/admin actions.
- There is no account status lifecycle such as invited, active, suspended, archived.
- Subscription state is only a local permission concept.
- No row-level security policies connect cloud data to account ownership yet.

## Minimum Cloud Model Needed

Add these before syncing real client data:

```txt
organizations
organization_members
profiles
coach_player_links
rounds
shot_events
practice_captures
support_tickets
support_attachments
audit_events
```

Recommended ownership model:

- An organization represents a client workspace, academy, coach group, or solo player.
- A Supabase Auth user can belong to one or more organizations.
- A profile belongs to an organization and may be linked to an auth user.
- A coach-player link grants a coach access to a player profile inside an organization.
- RLS must check organization membership and role before allowing reads/writes.

## Recommended Next Account Phases

### Phase A: Keep Local Prototype Accounts

Keep the current local account layer while cloud support and backup/export settle.

Use it for:

- UX testing
- coach/player workflow design
- local-only demos
- deciding what profile fields matter

Do not treat it as secure auth.

### Phase B: Add Supabase Auth

Create real login with Supabase Auth.

Keep the current local account data as migration/import input, not as the source of truth.

### Phase C: Add Client Organization Tables

Add organization membership and coach-player links before syncing rounds, shots, or practice data.

### Phase D: Migrate Profiles First

Sync `profiles` before shot data.

Only after profile ownership is proven should the app sync:

- rounds
- shot events
- course mapping
- practice captures

## Recommendation

There is enough account infrastructure for the next local/product-design step, but not enough for real client accounts in production.

Next technical step after backup/export:

1. Add Supabase Auth.
2. Add `organizations`, `organization_members`, `profiles`, and `coach_player_links`.
3. Create RLS policies.
4. Migrate one local profile into the cloud as a test.

