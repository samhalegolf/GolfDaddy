# Clarity Email Infrastructure

Local build scope:

- Account update emails are optional and controlled from `Settings > Notifications`.
- Service emails such as account creation and password recovery use the same base template, but are separate from optional update notifications.
- Coach/player activity is recorded in `gd_email_notification_events_v1` before any provider send is attempted.
- The app posts email payloads to `/api/email-notification`.
- The first live provider target is Resend through the Netlify function.

Provider setup later:

- `EMAIL_NOTIFICATIONS_ENABLED=1`
- `RESEND_API_KEY=...`
- `CLARITY_EMAIL_FROM=Clarity Golf Systems <notifications@your-domain>`
- `CLARITY_SITE_URL=https://clarity-caddie.netlify.app`

Current Netlify setup:

- Resend is connected through Netlify environment variables.
- `CLARITY_EMAIL_FROM` is temporarily `Clarity Golf Systems <onboarding@resend.dev>`.
- The live `/api/email-notification` route will exist after the next Netlify deploy includes `functions/email-notification.mjs`.
- A custom sending domain should replace `onboarding@resend.dev` before real player/coach rollout.

Template:

- Uses `assets/brand/cg-logo-white-g.png`.
- Automatically personalises recipient and actor names.
- Includes a CTA back to the app and a settings footer.
