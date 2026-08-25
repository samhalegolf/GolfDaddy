# Future Work — Scorecard Trust, Course Identity and Native Resolver

## Goal

Use the improved shared scorecard acquisition system as both:

1. a post-scan course labelling/identity layer; and
2. a secondary evidence source for the Native Geometry Resolver.

Do not build separate scorecard crawlers for each consumer.

## Shared acquisition model

```text
Fetcher finds candidate pages
        -> Parser understands cards
        -> Normaliser/deduper finds distinct cards
        -> Database stores reusable evidence
        -> Consumers use it
            - post-scan course labeler
            - multi-course matcher
            - Native Resolver
            - late trust check
```

The database should store parsed evidence, not arbitrary webpage interpretation logic.

## Multi-course scorecard acquisition

For a facility with multiple courses, the fetcher must continue until it finds the requested number of **genuinely distinct** course cards or exhausts useful sources.

Multiple URLs for one North Course card must remain one distinct card.

Example:

```text
North URL
North URL#map
North URL#reviews
=> distinct = 1

North card
South card
=> distinct = 2
```

## Post-scan Update Scorecards

Existing published geometry should not need to be rescanned just to improve labels.

Admin/Studio should have a post-scan action:

```text
Update Scorecards
```

That action should:

```text
load existing facility + child courses
-> determine wanted distinct card count
-> acquire/update scorecards
-> compare cards against stored geometry
-> if confidence is sufficient, safely relabel
-> otherwise leave provisional labels unchanged
```

For Te Arai, the desired transition is:

```text
Te Arai Links - Course 1
Te Arai Links - Course 2

-> Update Scorecards

Te Arai South Course
Te Arai North Course
```

Preserve course identity, geometry, visuals and history. Names are labels, not identity.

## Native Resolver fallback

If the Native Resolver's normal targeted scorecard path cannot get enough evidence, it should be able to request the broader facility scorecard acquisition path.

Preferred order:

```text
existing stored scorecard evidence
-> normal targeted/native fetch
-> broader facility fetcher
-> parse/dedupe/store
-> resolver consumes evidence
```

This is especially useful when a site has multiple courses but OSM hole numbering is absent or unreliable.

## Late trust check for wrong-neighbour mapping

Geometry coherence alone is not always enough to prove course identity.

A search pin can be wrong yet sit close to a perfectly coherent neighbouring 18-hole course. The mapper may then happily resolve the wrong course.

Use scorecard identity evidence opportunistically as a late trust check:

```text
search pin
-> geometry resolves coherently
-> if scorecard evidence is cheaply available, compare geometry against intended course card
-> strong intended-course match = trust
-> poor intended match / strong neighbouring-course match = likely wrong ground
-> ask user to place/correct the course pin
```

Do not make scorecard fetching a mandatory blocking dependency for every course. Stored evidence or a fast successful fetch should improve trust; absence of evidence should not automatically fail a normal coherent course.

## Relationship to user-pin prompt

The pin prompt should increasingly mean:

> We found golf nearby, but the evidence says we may have the wrong ground or cannot tell which ground you meant.

It should not be used merely because a course is new or not yet mapped.

## Important distinction after multi-course work

Multiple courses on one legitimate facility should normally become a **course chooser**, not automatically a pin prompt.

A pin is for location/ground ambiguity. A chooser is for known sibling courses.
