# Clarity Caddie Core - Codex Package

This is the Clarity Caddie app build. The app is part of the Clarity Golf Systems brand architecture.

Main entry:

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
- Non-Wand app cleanup

## Important note

Previous home-icons work caused routing conflicts by fighting the app shell. If rebuilding Home, prefer adapting the native shell/dashboard route instead of adding a second competing Home layer.
