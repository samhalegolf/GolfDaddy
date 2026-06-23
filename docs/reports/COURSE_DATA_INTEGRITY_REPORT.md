# COURSE DATA INTEGRITY REPORT

Version: 1.0  
Source: Course Data Integrity patch report from the Clarity Caddy stabilisation workflow.

---

## Files Changed

- `scripts/gd-shot-events.js`
- `index.html`

---

## Exact Course Data Rules Added

- Unique `shot-tx-*` ID for each held shot.
- Transaction ID stored on the planned shot, held Bubble, and Bubble-origin event.
- Outcomes require matching player scope, round, hole, transaction, and held-shot state.
- `bubble_rendered` is origin-only and cannot become an outcome.
- Endpoints must be explicit, unconsumed endpoint events.
- Maximum endpoint age: 45 minutes.
- Minimum endpoint confidence: medium.
- Maximum recorded GPS uncertainty: 50 metres.
- Minimum pairing confidence: 0.50.
- Invalid or missing coordinates are rejected rather than coerced to zero.

---

## Invalid Saves Now Rejected

- No previously held Bubble.
- Missing or mismatched transaction.
- Cross-player, cross-round, or cross-hole pairing.
- `bubble_rendered` outcome candidates.
- Reused or already-consumed endpoint events.
- Endpoints before the held shot.
- Stale, low-confidence, unsupported, weak-GPS, or invalid endpoints.
- Second Shot End presses after consumption.
- Shot End no longer creates a retrospective planned shot.

Rejected Shot End attempts create neither an outcome nor a new endpoint record.

---

## Shot End Closeout Behaviour

After one valid save:

- Transaction becomes consumed.
- Endpoint is marked with its consuming shot and outcome.
- Active planned-shot and transaction IDs are cleared immediately.
- Manual Shot End state is cleared.
- Shot End is disabled and disarmed immediately.
- Further presses cannot create orphan Course Data.
- Existing valid one-shot save behaviour remains intact.

---

## What Was Not Changed

- Camera or framing systems.
- Bubble mathematics or outcome calculations.
- Practice systems.
- Green Wand.
- Auto Course Mapper.
- Pretend GPS.
- Green Zoom or Green Focus, except invalid-save gate.
- Any files outside the two allowed files.

---

## Build/Test Result

- 20/20 targeted Course Data integrity tests passed.
- All 46 inline JavaScript blocks passed syntax checking.
- `scripts/gd-shot-events.js` passed `node --check`.
- `npm run build:netlify` passed.
- Archive extraction and file verification passed.
- Only the two allowed files differed from the supplied archive.
