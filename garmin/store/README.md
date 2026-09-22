# Connect IQ store listing

The text and images the portal asks for alongside `ClarityCaddy.iq`, kept here
because everything below was otherwise living only in a chat window. Upload
steps are in [../UPLOAD.md](../UPLOAD.md) §7.

The binary itself stays at `garmin/build/ClarityCaddy.iq`. `garmin/build/` is
git-ignored, but that one file is tracked by an explicit `git add -f`, so the
exact artifact that was uploaded is recoverable. Being tracked, it now shows
as modified after every `./build.sh package` — commit it when the version you
upload changes, and leave it alone otherwise.

| File | Portal field | Limit | Actual |
| --- | --- | --- | --- |
| `cover-500x500.png` | Cover Image (Web/Mobile), 500×500 | < 300 KB | 240 KB |
| `screen-1-numbers.png` | Screen Images | < 150 KB | 17 KB |
| `screen-2-map.png` | Screen Images | < 150 KB | 77 KB |
| `listing.md` | Title, Description, What's New | 50 / 4000 / 4000 chars | see file |

`Add Icons for App Store on Device` is answered **No** — that is a separate
128×128 set, optional, and nothing here needs it.

## How the images were made (2026-09-22)

**Cover.** `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png`
(1024×1024) cropped 70px in on each side to sit the rounded tile in the frame,
then drawn to 500×500. Not the launcher icon — that is a different thing at a
different size per device, in `../resources-icons/`.

**Screens.** Captured from the Connect IQ simulator running the muted build
(`CIQ_MUTE_TX=1 ./build.sh build`) with a round driven from the Android
emulator over the adb tether, so the numbers and the map are real output, not
mockups. The Approach S62 is `round-260x260`, and in the simulator's 433×687
window its display is exactly 260×260 at (83, 200); each shot is that square,
masked to the inscribed circle (the square's corners show the simulator's own
bezel artwork, which is not screen), scaled 2× nearest-neighbour.

To re-shoot without a wrist:

- `screencapture -l <windowID> -o -x out.png` grabs the simulator window even
  when it is buried or on another Space. Get the id from
  `CGWindowListCopyWindowInfo` — `osascript` has no assistive access on this
  Mac, so AppleScript cannot enumerate the windows.
- Buttons on the S62 skin, in that window: **SELECT (390, 212)**,
  **MENU (400, 320)**, **BACK (395, 400)**. The simulator's status bar prints
  the pointer position in device coordinates, which is how to check a mapping.
- Touch gestures on the glass do **not** arrive through synthetic background
  input — a drag produced no `onHold`/`onRelease`/`onTap` at all, and a quick
  press was read as a bare tap. Aiming therefore cannot be driven from the
  simulated wrist; move the target from the phone instead (UPLOAD.md §4's
  relay section).
- The muted build logs a `map frame:` line per render with the image, view,
  focus, scale, origin, player and target in image pixels. Read it before
  blaming the renderer: on the first attempt the target sat at x = −57 in a
  267px-wide image because the *phone's* aim was 54 m left of a straight hole,
  which no amount of redrawing would have fixed.

Note for the S62 specifically: it is Connect IQ 3.0 with no scaled bitmap draw,
so the camera is pinned to 1.0 and the map face can only ever show a 260px
window of the raster — roughly 96 m. A player and a target 236 m apart cannot
both be on screen, which is why `screen-2-map.png` shows the aim line leaving
the frame instead of a player dot. The S70 and fenix 6 get the scaled draw and
can frame both.
