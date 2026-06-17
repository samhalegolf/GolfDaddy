# Clarity Caddy Core - Codex Package

This is the Clarity Caddy app build. The app is part of the Clarity Golf Systems brand architecture.

Native app target:

```txt
App name: Clarity Caddy
iOS bundle ID: com.claritygolf.caddy
Android package: com.claritygolf.caddy
```

Main web entry:

```txt
index.html
```

## How to run locally

From this folder:

```bash
python3 -m http.server 5173
```

Then open:

```txt
http://localhost:5173
```

## Native shell planning

This branch prepares the first Capacitor path for internal iOS and Android testing only.

Expected setup flow after dependencies are installed:

```bash
npm install
npm run build:netlify
npx cap sync
npx cap add ios
npx cap add android
npx cap open ios
npx cap open android
```

Do not submit publicly until real-course GPS testing has been completed.

## Locked Green Wand baseline

This package includes the working Green Wand integration.

Working recipe:

```txt
Pinned green lat/lng
→ green-centred Leaflet tile crop
→ seed at crop centre
→ sandbox Wand brain
→ convert crop output back to lat/lng
```

Expected Sample Check pass condition:

```txt
coordinateFrame: green-centred-leaflet-tile-crop-v2
usefulPixels: true
```

## Do not touch during unrelated work

Do not modify:

- Green Wand sandbox engine
- Wand probe dots / accepted ridge dots / ridge mini-lines
- magnetic pull / outer shell / inset contour logic
- green-centred tile crop source
- crop seed placement
- crop output to lat/lng conversion

## Safe areas to work on

Unless specifically asked otherwise, Codex can work on:

- Home screen UI
- Button styling
- Profile UI
- Bag UI
- Shell navigation styling
- GPS Play mobile layout
- Capacitor native shell configuration
- Non-Wand app cleanup

## Important note

Previous home-icons work caused routing conflicts by fighting the app shell. If rebuilding Home, prefer adapting the native shell/dashboard route instead of adding a second competing Home layer.
