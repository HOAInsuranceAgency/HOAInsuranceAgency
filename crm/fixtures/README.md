# Fictional records

Tests and local previews share data-only builders here. Model builders accept
typed persisted fields and copy nested overrides. Scenario factories return new
records, options and schedules on every call. They do not load an SDK, inspect
the URL, authorize a role or dispatch a write.

Keep failure cases, role choices, write spies and mutations in the individual
test or preview scenario. Ordinary tests use src/test/fixtures/commercialClient
and explicitly reset it in beforeEach; they do not import a preview entry point.
Its supported reads return copies, unsupported operations fail, and it cannot
invent successful writes. The existing global test setup remains unchanged.

The commercial presentation facade preserves that scenario's display policy.
Other previews retain their deliberate date, number and error-message choices.
Production browser source cannot import this directory, test helpers, or preview
tools; the repository boundary checker enforces that separation.
