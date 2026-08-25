# Future Work — Player-Facing Loading Language

## Goal

Remove implementation-revealing wording from player-facing loading/progress UI as the app approaches production.

The current wording such as:

```text
Mapping course
```

reveals too much about whether Caddy is retrieving existing data, resolving a course, generating something new, or waiting on background work.

Players do not need to know which internal path is running.

## Preferred wording

Use ambiguous but truthful language such as:

```text
Loading course...
Preparing course...
Almost ready...
```

`Preparing course...` is the strongest default because it truthfully covers:

- loading an existing database package;
- resolving course data;
- waiting for first-time preparation;
- downloading visual assets;
- background course work nearing completion.

Do not invent false explanations such as `Downloading from database` if that is not necessarily what is happening.

## Behaviour

A fast existing course may pass through the loading state almost instantly.

A first-time or more complex course may sit on the same state for longer. To the player this should simply look like a longer course load, not a fundamentally different product path.

The imminent live delivery of completed objects/assets can therefore appear as the same loading process rather than exposing mapper/worker terminology.

## Production principle

Player-facing UI should describe **outcomes and waiting states**, not architecture.

Good:

```text
Preparing course...
Course ready
Unable to prepare course
```

Avoid:

```text
Running AutoMapper
Native Resolver
Fetching OSM geometry
Building course map
Visual worker running
Scorecard matcher
```

Detailed stage names should remain available in developer/admin diagnostics only.

## Scope

Sweep all player-facing loading, toast, error and fallback copy for implementation terminology before production.

Do not remove developer diagnostics as part of this job; separate their visibility instead.
