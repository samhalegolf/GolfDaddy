# Clarity Caddie Shot Data Fixtures

This folder holds demo shot data and shape examples for checking how shot-intent results are filed before the app has a full Shot Data screen.

The runtime store used by the browser prototype is localStorage key `gd_shot_events_v1`. The JSON fixture mirrors that structure:

- `ballEvents`: every confirmed "I am at my ball" position.
- `plannedShots`: each intended shot bubble rendered from GPS/Bubble Studio data.
- `outcomes`: paired result records comparing the next ball position against the planned bubble.

Course library data remains separate under `gd_user_course_library_v1`.

Launch monitor / practice capture data is intentionally separate under `gd_launch_monitor_data_v1`.
That lane is for high-volume extracted data from screenshots, camera capture, CSV/text exports, or range apps. It can scrap noisy rows aggressively and should only surface a result when the cluster engine has something useful to show. See `demo-launch-monitor-capture.json` for the add-on payload shape.

## Cluster Analysis Rules

Runtime analysis lives in `scripts/gd-shot-cluster-analysis.js`.

The first pass has two modes:

- Bubble fit check: when a presumed Bubble exists, the 51-80% consistency setting asks how large the real-result Bubble needs to be to contain that share of counted shots.
- Cluster hunter: when the Bubble is not trusted or not set, shot results are filtered by club-distance viability, converted to a normalized degree value, and grouped into candidate tendencies.

Admin-tweakable defaults live under `statsCluster` in the developer tuning panel:

- consistency range: 51% to 80%, default 68%
- viable distance window: expected club distance +/- 18%, clamped between 10m and 35m
- viable Bubble-offset degree: +/- 8 degrees
- alignment-check degree: 10 degrees or more, when the cluster is otherwise strong
- strong cluster: at least 5 shots, no more than 2.2 degrees standard deviation, and no more than 6 degrees total range

Important rule: a tight cluster outside the viable degree range is not a Bubble/profile suggestion. It is treated as possible alignment feedback.

## Launch Monitor Intake

Runtime intake lives in `scripts/gd-launch-monitor-data.js`.

This is a behind-the-curtain workspace, not the main GPS Shot Data feed. The intended flow is:

- capture add-on sends loose `clubGroups` with raw labels and candidate metrics
- Clarity Caddie stores the raw capture and normalizes only enough for clustering
- exclusion gates scrap unusable rows, such as missing carry, impossible carry, low confidence, or wildly off-line rows
- result-scaled clustering looks for the strongest result pattern at the configured consistency percentage, then checks whether other clubs/distance bands scale back to the same degree value
- delivery clustering can use face/path style metrics when ball result data is sparse, then checks whether that delivery signal agrees with the result model
- cluster methods return quiet statuses such as `needs_more_data`, `cluster_candidate`, `cross_distance_verified`, `verified_by_result`, `delivery_only`, `alignment_signal`, or `scrap_cluster`
- the UI should only show this lane when `userSignals` contains something useful

Admin-tweakable defaults live under `launchMonitorCluster` in the developer tuning panel.
