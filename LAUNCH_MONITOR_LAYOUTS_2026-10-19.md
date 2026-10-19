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

- The scanner is not told which layout was chosen. The hint is on the file
  name and `window.__gdPracticeCameraLayout`; using it to pre-seed header
  allocation when the OCR cannot read a header is the obvious next step, and
  it would be the first change inside the scanner module.
- No tilt or level reading. Keeping the phone square to the screen is said
  in words, not measured.
- The layouts marked `typical` have not been checked against a live screen of
  that brand. Each is a dozen lines of data in one file; correcting one is a
  one-line edit and the test will say if a label stops resolving.
