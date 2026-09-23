# Arm 3 overlay (catalogs)

Landed with T-526 (formats from T-523 and T-524). Holds `.story/capabilities.json` (`cap-logging` with entryPoints `src/platform/logging/`, rulings [R1]; `cap-request-routing`, the lexical distractor, entryPoints `src/http/router.ts`) and `.story/glossary.json` ("request id", "redaction"). Every fact these files carry already exists in the core as a note or ruling (see `facts.json`); this overlay adds structure, never facts.

`checkedAt.sha` is forty zeros on purpose: the fixture has no stable commit to point at, so every entry reads `[review]` with an unverifiable-checkpoint finding. Tests that need a current entry stamp one in their own copy.
