# CLARITY CADDY PATCH PROMPT TEMPLATE

Use this template for narrow patch chats.

```text
Use docs/architecture/CLARITY_CADDY_TRUTH_FILE.md as source of truth.

Patch only: [SYSTEM / BEHAVIOUR].

Do not edit files outside scope.
Do not add features.
Do not redesign UI.
Do not deploy.
Do not add hidden fallbacks.
Do not revive legacy systems.

Allowed files:
- [file 1]
- [file 2 only if required]

Protected systems not to touch:
- Practice Data Photo Scan
- Practice Shot Data Gate
- Cluster Finder / Practice Bubble Generator
- Bubble Engine internals
- Green Wand
- Auto Course Mapper
- GPS framed-box camera model unless explicitly scoped
- Ghost Bag / 0.0 default Bubble
- Degree offset architecture

Goal:
[one sentence]

Requirements:
1. [requirement]
2. [requirement]
3. [requirement]

Output:
Files Changed
Exact Behaviour Changes
What Was Not Changed
Build/Test Result
```
