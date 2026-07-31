# Clarity Caddy Demo Video Harness

This folder records deterministic browser walkthroughs without using production data.

## First-time setup

```bash
npm install
npm run demo:install
```

## Record the local app

Terminal 1:

```bash
npm start
```

Terminal 2:

```bash
npm run demo:capture:local -- --scenario smoke-home
```

## Record a preview deployment

```bash
DEMO_BASE_URL=https://your-preview-url.netlify.app npm run demo:capture -- --scenario smoke-home
```

Each run creates a timestamped directory under `demo-output/` containing:

- the raw Playwright video;
- a final-frame screenshot;
- any explicit scenario screenshots;
- `run-report.json` with browser errors and run metadata.

## Add a promo story

Copy `demo/scenarios/smoke-home.json` and add ordered steps. Supported actions:

- `goto`
- `click`
- `fill`
- `press`
- `waitFor`
- `pause`
- `evaluate`
- `screenshot`

Use stable selectors such as `[data-testid="home-play"]`. Avoid CSS classes, coordinates and marketing text.

Example click:

```json
{
  "action": "click",
  "selector": "[data-testid=\"home-play\"]",
  "holdAfter": 900
}
```

## Demo data contract

Scenario-specific demo data should be loaded before the click sequence. For the current static app, the harness can inject deterministic local-storage values using `storageState.localStorage`.

As server-backed demo data is introduced, keep it isolated behind a dedicated demo tenant or preview-only seed endpoint. Never point reset or seed operations at production.

Recommended endpoint contract:

```text
POST /.netlify/functions/demo-seed
Authorization: Bearer <preview-only secret>
Content-Type: application/json

{ "scenario": "practice-to-course" }
```

The endpoint should reject production hosts, wipe only the demo tenant, load the named fixture and return a stable demo account/session.
