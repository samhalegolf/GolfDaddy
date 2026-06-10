# Practice Data Directional OCR — Mask Number Method

This bundle is a full app bundle, not a note-only patch.

## Scanner change

Old L/R experiment buttons are parked. Directional columns now use a single default method during `Digitise table`:

1. Scan the directional cell number first.
2. If the number is not readable, leave the cell for review.
3. If the number is readable, use the full detected white value box as the source crop.
4. Mask/remove the detected numeric glyph area from that full value box.
5. Scan the remaining image for the tiny `L` or `R` marker.
6. Combine number + direction.

Directional columns:
- Side Angle
- Sidespin
- Offline

## UI change

The old L/R experiment buttons are removed from the Practice Data panel and replaced by a method status note.

## Important

The original Find Cluster / table-area logic is untouched. OCR Fit Template still only fits the header/template. Digitise table remains the value-reading step.
