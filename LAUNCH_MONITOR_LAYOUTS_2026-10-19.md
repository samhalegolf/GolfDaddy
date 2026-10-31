# Launch monitor screen layouts and the guided camera
2026-10-19 · Clarity Caddy

The photo method reads one shape: metric names across the top, one shot per
row under them, sometimes AVERAGE / STD DEV at the bottom. Every brand prints
that shape a little differently. This note is the list, and what was built so
the camera helps a player frame it.

## What changed

**Take photo now opens a camera inside the app** with a template drawn over
the live picture. The phone's own camera app cannot show anything of ours, so
the old `capture="environment"` input could never carry a template. It is kept
as the fallback: no `getUserMedia`, permission refused, or an old webview, and
the button goes where it always went.

- `scripts/gd-launch-monitor-layouts.js` - the layouts (data) plus two pure
  functions: `guideGeometry` places the frame, header band, label column, row
  guides, summary band and column slots on a viewport; `coverCrop` maps the
  frame back to camera pixels under `object-fit: cover`.
- `scripts/gd-practice-camera-guide.js` - the viewfinder. Layout chips, the
  template, a ribbon with the column order to expect, the brand's own note,
  and a shutter. The shot is cut to the frame plus an 8% margin and handed to
  `gdHandleLaunchMonitorPhoto`, the same entry the file picker uses, so the
  4-corner stretch and the scanner are untouched. The file is named
  `clarity-camera-<layout>-<time>.jpg` and the choice is kept in
  `gd_practice_camera_layout_v1` and on `window.__gdPracticeCameraLayout`.
- `styles/inline/gd-practice-camera-guide.css`, ten `dataPage.cameraGuide*`
  strings in all 23 languages, `android.permission.CAMERA` in the manifest
  (the webview's camera request is refused outright without it; iOS already
  had `NSCameraUsageDescription`).
- Header aliases the brands print that the registry did not know:
  Efficiency (smash), Deviation Dist. / Side Distance / Lateral landing
  (offline), Push/Pull, H. Launch, Horizontal Angle (launch direction),
  V. Launch (launch angle), Loft (dynamic loft), Land. Ang. (descent),
  Shot Apex (peak), Club Face (face angle).
- Tests: `dev/launch-monitor-layouts.test.js` (every column label resolves
  through the alias registry to the key the layout claims; geometry and crop
  hold on five viewports) and `dev/practice-camera-guide.test.js` (wiring,
  fallback, a template per layout, the cropped capture). Both run in
  `npm run test:practice`, which CI already runs.

## 2026-10-31 - landscape viewfinder and the adjust stage

The first cut framed the table on a portrait phone, which left a short frame
(about 350 x 195 CSS px for a 1.8 table), and every camera photo then went to
the 4-corner stretch - a stage for photos taken at an angle, which a guided
shot is not. Both changed:

- **Landscape first.** The stage (template, chips, controls) is a CSS grid
  around an empty picture cell. On a landscape page the chips share the top
  strip with the title and the shutter sits in a rail on the right, so the
  frame gets the full height. On a portrait page framing a wide table
  (`wantsTurn`: table aspect >= 1) the stage is turned a quarter turn
  clockwise with `transform`, so the player holds the phone sideways. The
  camera picture is not turned: with the phone on its side the sensor already
  shows the table upright to the player. `turnedToPage` maps the frame back
  to page pixels for the crop, and the saved JPEG is rotated the other way so
  it is upright. A portrait-shaped table (the same-phone apps) keeps the
  upright stage. On a 390 x 844 phone the Foresight frame is now about
  560 x 310 CSS px, roughly 2.5x the area.
- **The adjust stage instead of the corner pins.** The shutter freezes the
  picture (a canvas with the full frame, the stream stops) and the same
  screen shows the template's lines on it: the frame edges, the bottom of the
  header, and the left edge of every column. Each one drags, kept in order
  with a 12 px minimum gap; Reset puts them back; Retake goes live again.
  Scan cuts the frame plus the 8% margin out of the still and puts the lines
  on the file as `__gdTemplateFrame` = `{x, y, w, h, layout, columns[],
  headerBottom}` (fractions of the saved picture, then of the frame). In
  `gdHandleLaunchMonitorPhoto` a tagged photo goes to
  `gdRunPracticeTemplateFrameScan`: the frame is flattened with the same warp
  the pins use (`gdPracticeFlattenQuadCheckpoint`, now shared) and the scan
  starts at once. `fitTemplate` takes `columnBounds` (used exactly) and
  `headerGuess` (the ink still settles the header's bottom). A template scan
  that finds no rows reopens the adjust stage on the same still
  (`reopenAdjust`), with the reason in its status line; an uploaded photo
  still gets the pins. Moving the pins drops the camera's lines.
- The generic "any other shot table" layout has no columns, so a photo framed
  with it now clears the Template select and goes down the discovery route
  from the flattened frame, instead of a template scan that could read
  nothing.
- Three strings in all 23 languages: `dataPage.cameraGuideAdjust`,
  `cameraGuideRetake`, `cameraGuideReset`. Scan reuses `dataPage.scan`.

Not done: the turn is always clockwise (top of the phone to the left). Held
the other way the stage is upside down and the player turns the phone round.
The adjust stage has no magnifier; on a 20-column Trackman table each slot is
about 36 px wide on a phone, which is workable but tight.

## Template mode (the second scan route)

The scanner now has two routes from the same flattened checkpoint, chosen by
the **Template** select next to the club on the scanner panel:

| | No template (the old route) | Template mode (new) |
|---|---|---|
| Entry | `gdClarityTableOcrScanFromCheckpoint` | `gdClarityTemplateScanFromCheckpoint` |
| What it has to work out | columns from ink corridors, metric names by reading headers through the alias registry, club from the offcut, rows by consensus across strips | nothing: the layout's column order is the map |
| Pure module | `scripts/clarity-table-ocr.js` | `scripts/clarity-template-ocr.js` |
| Steps | detect boxes, OCR every box, split columns, cut strips, name strips, offcut scan, read strips into rows, deep scan, payload | fit template to ink, OCR one crop per cell, OCR one label per row, assemble rows, deep scan, payload |
| Borrowed | - | the direction deep scan (`gdClarityDeepScanDirections`, blanking + glyph classifier) for the small L / R / + / - markers, the native-resolution cell crop, the three-step cell read, `parseCell`, `isSummaryLabel` |
| Lands through | `gdClarityScanResultToPayload` -> `gdImportLaunchMonitorPayload` | the same |

How the fit works (`fitTemplate`): the flattened image is the frame the player
put the pins on, so the header row is along the top. The template says roughly
how tall the header is; the ink says exactly (the lowest band of text starting
in that zone). Column boundaries start as equal slots across the width after
the label column and each one is nudged onto the nearest quiet corridor in the
ink below the header, within a third of a slot. Shot rows are the bands of ink
under the header. If the layout prints AVERAGE / STD DEV, bands in the bottom
zone are summary candidates; the label-column read decides (a summary word, or
a blank where a shot number should be, drops the band). A band with fewer than
40% readable values is not a shot.

Direction columns are the layout's own: each column carries a `direction`
flag (Side, Offline, Launch Dir., Club Path, Spin Axis and so on, per brand),
and the deep scan runs on exactly those. Left is negative on the way into the
library, as everywhere else.

The guided camera and template mode fit together: a photo from the camera
carries where the frame and the column lines sit in the saved picture, so the
frame is flattened and scanned without any pins, the lines are the column
boundaries, and the camera's layout is pre-selected as the template.

Tests: `dev/clarity-template-ocr.test.js` draws a synthetic table with uneven
columns, a rule, two header lines and two summary rows into an ink mask and
proves the header comes from the ink, every boundary lands in the real gap,
thirteen rows assemble from the ground-truth fixture with their L/R, and the
summary rows drop. `dev/practice-template-mode.test.js` pins the select, the
dispatcher, the borrowed deep scan and the camera hand-off.

## The layouts

Column order is `documented` where it comes from the brand's manual, export
or the in-repo fixture, and `typical` where it is the brand's published metric
set in the order its app normally shows. Several apps let the player re-order
columns, so the ribbon under the frame shows the order and the player checks
it against the screen. Direction: `suffix` means an L or R after the number
("3.2 L"), `signed` means left is a minus.

| Layout | Screen | Shape | Columns (left to right) | Summary rows | Direction | Confidence |
|---|---|---|---|---|---|---|
| Foresight FSX - ball data | FSX 2020 / FSX Play table view on the sim PC | landscape, dark, shots grouped by club | Ball Speed, Launch Angle, Side Angle, Backspin, Sidespin, Descent Angle, Offline, Peak, Carry, Total, To Pin | AVERAGE, STD DEV | suffix | documented (matches `dev/fixtures/launch-monitor-7i.groundtruth.json`) |
| Foresight FSX - club data | FSX club data tab | landscape, dark | Club Speed, Efficiency, Angle of Attack, Club Path, Face to Target, Lie, Loft, Face Impact, Closure Rate | AVERAGE, STD DEV | suffix | documented (Foresight club data set) |
| Trackman TPS / report | Performance Studio shot analysis and emailed reports | landscape, often white | Club Speed, Attack Ang., Club Path, Face Ang., Face to Path, Dyn. Loft, Spin Loft, Ball Speed, Smash Fac., Launch Ang., Launch Dir., Spin Rate, Spin Axis, Height, Carry, Side, Total, Side Tot., Land. Ang., Hang Time | AVERAGE, STD DEV | suffix | typical (standard Trackman parameter order) |
| Trackman Golf app | the app's shot table, sideways | landscape, dark | Carry, Total, Ball Speed, Club Speed, Smash, Launch Angle, Launch Dir., Spin Rate, Spin Axis, Height, Side, Land. Ang. | AVERAGE | suffix | typical (player-chosen data points) |
| Garmin Golf app (R10 / R50) | range session, shot table under Session Stats | portrait, dark, scrolls sideways, header scrolls away | Carry, Total, Ball Speed, Club Head Speed, Smash, Launch Angle, Launch Direction, Spin Rate, Spin Axis, Apex Height, Deviation Dist., Attack Angle, Club Path, Face Angle, Face to Path, Backspin, Sidespin | none | suffix | typical (Garmin's CSV set; columns re-orderable in the app) |
| Rapsodo MLM2PRO app | session shot list | portrait, dark | Total, Carry, Side Carry, Ball Speed, Launch Direction, Club Speed, Smash, Launch Angle, Descent Angle, Shot Apex, Shot Type, Spin Rate, Spin Axis, Club Path, Angle of Attack | none | suffix | typical (Rapsodo's published metric order) |
| FlightScope FS Golf table | FS Golf table view on tablet or PC | landscape, dark | Ball Speed, Club Speed, Smash, Carry, Total, Roll, Lateral, Apex, Flight Time, V. Launch, H. Launch, Spin Rate, Spin Axis, AOA | AVERAGE, STD DEV | signed | typical (Mevo+ standard set; Pro Package adds club columns) |
| SkyTrak / SkyTrak+ | shot history table, usually iPad | landscape, dark | Ball Speed, Launch Angle, Back Spin, Side Spin, Side Angle, Descent Angle, Max Height, Carry, Total, Offline, Smash, Club Speed, Club Path, Face to Target | AVERAGE | suffix | typical |
| Uneekor View / Refine | shot data table on the sim PC | landscape, dark | Ball Speed, Launch Angle, Side Angle, Back Spin, Side Spin, Carry, Total, Side Distance, Flight Time, Apex, Descent Angle, Club Speed, Smash, Club Path, Face Angle, Attack Angle, Dynamic Loft | AVERAGE | suffix | typical |
| Full Swing KIT app | session shot list | portrait, dark | Carry, Total, Club Speed, Ball Speed, Smash, Spin Rate, Spin Axis, Apex, Launch Angle, Attack Angle, Horizontal Angle, Club Path, Club Face, Face to Path, Side Carry, Side Total | none | suffix | typical (16 points, player-sorted) |
| Range bay screen | Toptracer / Trackman Range / Inrange bay monitor | landscape, often light | Carry, Total, Ball Speed, Launch Angle, Height, Side, Curve, Hang Time | none | suffix | typical (varies by range) |
| Any other shot table | - | landscape | none promised; the scanner reads the header itself | none | suffix | - |

Columns with no metric key (Lie, Face Impact, Closure Rate, Spin Loft, Side
Tot., Hang Time, Shot Type, Roll, Flight Time, Curve) are drawn so the frame
matches the screen, and the scanner leaves them out as it does today.

## Same-phone apps

Garmin, Rapsodo, Full Swing and the Trackman Golf app usually run on the
player's own phone, which cannot photograph itself. Those layouts say so in
the camera and point at Upload (screenshot). They stay in the list because the
same apps run on a tablet or a second phone.

## What this does not do yet

- Template mode has not been run on a real photo yet. The fit and the row
  assembly are proven on a synthetic table; the first live scan will say
  whether the snap tolerance (a third of a slot) and the summary zone (1.4x
  the template's summary band) are right.
- Template mode trusts the frame. A photo framed with the header cut off
  reads the first shot row as the header; the adjust stage's top edge is
  there to be dragged up before scanning.
- No tilt or level reading. Keeping the phone square to the screen is said
  in words, not measured.
- The layouts marked `typical` have not been checked against a live screen of
  that brand. Each is a dozen lines of data in one file; correcting one is a
  one-line edit and the test will say if a label stops resolving.
