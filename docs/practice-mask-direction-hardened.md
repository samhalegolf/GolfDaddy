# Practice Data Directional OCR — Hardened Mask Method

This bundle hardens the mask-number L/R method.

## Production method

For directional columns only:
- Side Angle
- Sidespin
- Offline

Flow:
1. Read the numeric value first.
2. Require a real number bounding box before scanning direction.
3. Erase the number back to the white value-box background.
4. Clear obvious cell-border/frame noise.
5. Scan a focused remainder region, not the whole masked cell.
6. Combine number + L/R or mark direction missing for review.

## Debug view

The Mask-number direction review now includes two toggle buttons:
- Show full masked cell
- Show remainder focus

The actual scan uses the remainder focus. Full masked cell is only for visual inspection.
