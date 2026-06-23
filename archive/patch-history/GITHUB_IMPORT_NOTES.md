# Clarity Caddie GitHub import notes

This package is source-only for GitHub/Netlify continuous deployment.

Included:
- index.html
- package.json / package-lock.json
- netlify.toml
- assets/
- scripts/
- styles/
- functions/
- supabase/support-schema.sql
- Phase 1 handover/support docs

Excluded from Git:
- dist/ because Netlify builds it using `npm run build:netlify`
- node_modules/
- .env / .env.*
- .netlify/
- supabase/.temp/

Target repository:
- https://github.com/samhalegolf/GolfDaddy

Netlify build settings:
- Build command: `npm run build:netlify`
- Publish directory: `dist`
- Functions directory: `functions`

Required Netlify env vars for debug email path:
- RESEND_API_KEY
- CLARITY_EMAIL_FROM
- CLARITY_DEBUG_REPORT_TO, optional but recommended
