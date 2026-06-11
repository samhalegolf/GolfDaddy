# Clarity Icons And Fonts Handoff

Use this when refining brand assets in another chat.

## Current App Assets

Brand logos:

- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/brand/cg-logo-white-g.png`
  - 2048 x 2048
  - Current primary app logo. Used on home header, login, coach portal, and email template.
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/brand/cg-logo-black-g.png`
  - 2048 x 2048
  - Alternate logo version.
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/brand/cg-logo-white-g.svg`
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/brand/cg-logo-black-g.svg`
  - These SVG files currently embed/reference the PNG files. They are not clean editable vector logo builds yet.

Home tile images:

- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/home/play.png`
  - 1274 x 921
  - Home tile art for Clarity Caddie / Play.
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/home/bubble-data.png`
  - 460 x 415
  - Home tile art for Clarity Shot System / Enter.
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/home/bag.png`
  - 777 x 1004
  - Home tile art and small bag icon fallback.
- `/Users/samhalegolf/Documents/Codex/2026-05-21/files-mentioned-by-the-user-golf/golf-daddy-handoff-cleaned-current/assets/home/profile.png`
  - 822 x 1009
  - Default player profile icon and profile tile art.

## Current Font Setup

No font files are bundled in the repo right now. The app uses system font stacks.

Main app UI stack:

```css
Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif
```

Home tile / brand display stack:

```css
"SF Pro Rounded", "Avenir Next", ui-rounded, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Base fallback stack:

```css
-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Monospace/debug stack:

```css
ui-monospace, SFMono-Regular, Menlo, Consolas, monospace
```

Leaflet map default:

```css
"Helvetica Neue", Arial, Helvetica, sans-serif
```

## Current Visual Direction

- Dark golf UI with deep green/black backgrounds.
- Brand green, white, and black CG mark.
- Orange/gold is used for primary CTAs.
- Very heavy display weights are common: `900` and `950`.
- Body/UI text is compact and dense.
- Home title is currently `CLARITY GOLF` with the CG logo to the left.

## Useful Prompt For Another Chat

I am refining the visual identity for a golf app called Clarity Golf / Clarity Caddie. The current logo is a CG mark: green outer C, inner G, centre dot, and a white/black G variant. I need cleaner icon/font direction while preserving the current dark golf product feel. Please design/refine:

- A proper editable vector CG logo, white-G and black-G versions.
- App icon versions that work at small sizes.
- Home tile icon/art direction for Play, Shot Data, Bag, and Player Profile.
- A font pairing for a premium golf-performance app: strong display face for tile labels/headings, readable UI face for dense controls.
- Keep the style modern, sporty, premium, and not cartoonish.
