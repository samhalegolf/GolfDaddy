# Admin Auth Door Report

Branch: `fix/password-change-persists`

## Purpose

Add a token-protected admin recovery endpoint for account setup/password recovery while the normal password persistence issue is investigated separately.

## Added

- `functions/admin-auth-door.js`
- `/api/admin-auth-door` redirect in `netlify.toml`

## Behaviour

`POST /api/admin-auth-door` requires an admin token via either:

- `Authorization: Bearer <token>`
- JSON body field `adminToken` or `token`

The token is read from:

- `CLARITY_ADMIN_AUTH_TOKEN`, or
- `CLARITY_ADMIN_DIAGNOSTICS_TOKEN` as fallback

Payload:

```json
{
  "email": "name@example.com",
  "name": "Optional Name",
  "role": "admin",
  "createIfMissing": true
}
```

Result:

- Finds or creates the Supabase Auth user.
- Upserts the matching Clarity account/profile records.
- Generates a Supabase recovery/setup link that redirects back to `/?claritySetPassword=1`.
- Returns the recovery link to the token-authenticated caller.

## Safety

- No password is exposed or returned.
- No hard-coded password is added.
- The endpoint is blocked unless the admin token environment variable is configured and supplied.
- This is a recovery/setup link generator, not a login bypass.

## Separate branch

The password persistence bug itself has a separate branch:

- `fix/password-change-persistence`
