# Future Work — Production Exposure Audit and Delivery Sanitisation

## Goal

Create a deliberate production boundary between rich internal diagnostics/provenance and the minimal data shipped to the player app.

This is not about pretending the client is secret or relying on obscurity. Anything shipped in JavaScript should be assumed discoverable. The aim is simply to stop unnecessarily exposing implementation details, internal terminology, diagnostic metadata and asset provenance that the player does not need.

## Separate development/admin from production player surfaces

Keep developer/admin diagnostics highly descriptive.

Production player surfaces should be deliberately boring.

```text
development/admin
-> resolver names
-> confidence values
-> fallback paths
-> worker stages
-> source/provider detail
-> rich errors

production player
-> course request
-> course response
-> minimal rendering data
-> simple user-facing errors
```

## Audit areas

Sweep at least:

- browser console output;
- production logging;
- network/API response payloads;
- public error messages;
- client-side globals and debug objects;
- source maps/build settings;
- debug/admin endpoints;
- environment/config exposure;
- algorithm names unnecessarily shipped to the client;
- asset manifests and native capture metadata;
- visual storage paths/naming where those reveal source machinery.

Do not perform risky mass renames just to make filenames mysterious. Prioritise actual public exposure.

## Native visual/capture delivery boundary

Once a visual asset becomes a native/player-facing course asset, it generally does not need to carry the story of how it was produced.

Internal provenance can retain:

- imagery/provider source;
- source URL or upstream reference;
- worker/version;
- recipe/preset;
- capture route;
- fallback path;
- confidence/diagnostic tags;
- generation timestamps;
- intermediate processing metadata.

The player package normally only needs:

- asset identifier;
- course identifier;
- hole number/key;
- generic asset/frame type;
- URL/path;
- geo bounds/anchors;
- dimensions where required;
- version/hash/checksum;
- legally required attribution.

Conceptually the shipped package should look like:

> photos + geometric placement + boring internal IDs

not a readable history of the source and processing pipeline.

## Generic internal filing system

At publish time, stamp final assets with Caddy-owned generic identifiers/type codes rather than carrying source-oriented names into delivery manifests.

The exact code format can remain simple and implementation-neutral. The phone only needs enough information to render/use the correct asset.

If origin detail is later needed for debugging, it should be recoverable from internal database provenance using the asset ID rather than shipped on every device.

## Use an allowlist, not a denylist

The sanitised delivery manifest should be built from an explicit allowlist of fields.

This is safer than maintaining a list of sensitive fields to strip because future diagnostic fields then remain server-side automatically.

Example delivery contract:

```text
asset_id
course_id
hole
asset_type
path/url
bounds
anchors
width/height
version
checksum
required_attribution
```

Only include fields that the player runtime actually consumes.

## Attribution/licensing exception

Do not remove attribution or provenance that is contractually/licensing-required to travel with or be displayed alongside an asset.

Required attribution should survive in the appropriate delivery field without carrying unrelated debug provenance with it.

## Server boundary

Anything that genuinely represents proprietary decision logic or important implementation know-how should increasingly live behind the server boundary where practical.

Minification can reduce casual readability but should not be treated as protection for important algorithms.

## Desired end state

```text
rich internal asset/course record
        -> publish/build boundary
        -> sanitised delivery manifest
        -> phone/player runtime
```

The database remains richly diagnosable. The shipped app receives only what it needs to render and operate.
