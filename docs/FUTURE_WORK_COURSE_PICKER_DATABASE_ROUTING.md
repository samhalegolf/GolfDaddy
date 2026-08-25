# Future Work — Course Picker Database Routing

## Goal

Make the course picker increasingly prefer Clarity Caddy's own known course/facility data without exposing whether a course is already mapped.

The external search should remain loose and forgiving. Its job is mainly to get the player to roughly the right place. Once a result is clicked, Caddy should ask its own database whether that location is already known before any new mapping work begins.

## Preferred picker behaviour

Blend two sources into one normal-looking result list:

- a subtle Caddy/database recommendation near the top when a strong internal match exists;
- normal external search results underneath.

Do **not** show `Mapped`, `Database`, `Caddy Course`, ticks, or anything else that exposes mapping coverage.

The principle is:

> Expose courses, not mapping state.

A database recommendation should simply look like the best search suggestion. Slightly stronger placement/shading is fine, but keep it subtle.

## Known facility behaviour

For a multi-course facility such as Te Arai:

```text
Te Arai Links
    -> North Course
    -> South Course
```

The parent recommendation is a routing item, not another playable course record.

North and South may also still appear independently in the normal search results. Duplication is acceptable if the clean parent route is promoted first.

## Geo-based database interception

Before any new mapper/course creation path runs:

```text
selected external/search coordinate
        -> query known course_maps/facilities nearby
```

Possible results:

```text
0 convincing matches
-> continue normal new-course flow

1 mapped course
-> offer/open that known course

2+ mapped siblings / same facility
-> ask which course the player is playing
```

This should be based primarily on location, not perfect name matching. It therefore covers odd search aliases, spelling variants, renamed clubs, duplicate provider entries, and poor provider naming.

## Relationship to user-pin flow

The user pin should remain a mapper repair/disambiguation tool, not a permanent personal record for an otherwise unmapped course.

Modern distinction:

```text
course chooser = choose between known courses
user pin       = choose/correct ambiguous ground when automatic location resolution genuinely failed
```

A known database/facility match should be resolved before asking the user to place a pin.

## Important production guard

A recognised database/facility match must be resolved **before any code is allowed to create a new course_maps row, queue a mapper job, or launch visual generation**.

The accidental third Te Arai row exposed a route that can still create a new record outside the facility-aware path. This guard should close that hole.

## Current relevant ownership

Course picker owner:

```text
scripts/inline/gd-course-picker-search-v2.js
```

Mapping/readiness boundary:

```text
scripts/gd-course-library-pin-lock.js
```

Existing picker behaviour already merges database courses, aliases, saved state and `hasDatabaseMap` into search results. Prefer extending that ownership rather than creating another independent course-matching system.

## Desired long-term effect

As the mapped database grows, Caddy's own recommendation naturally becomes the result people select most often, but external search remains a reliable fallback. No hard migration is required.
