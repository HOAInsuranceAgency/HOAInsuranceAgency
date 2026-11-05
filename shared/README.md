# Shared business rules

This directory owns rules and structural contracts used by more than one runtime: CRM browser code, the public website, and Lambda handlers. Import the owning module directly. Do not add a browser or server wrapper that reexports it under an old path.

Keep shared modules independent of React, Amplify/AWS SDKs, application clients, environment variables, browser storage, and network calls. Pass data and configuration into the rule; keep authentication, reads, writes, and UI state in their runtime adapters.

The CRM's `schemaContracts.test.ts` checks shared enum types against the generated Amplify schema. The premium-finance jurisdiction module is generated from the existing signed YAML using `npm run pf:generate` in `crm`; its source hash and rules remain unchanged.

Deployment-time modules stay inside `crm/amplify`, including Honeycomb branch selection used by Amplify's loader. Public endpoint identities and runtime business contracts live here; credentials remain in runtime configuration.

Run `npm run verify:architecture` from the repository root. The central checker in `scripts/check-module-boundaries.mjs` rejects server imports from frontend source, browser runtime imports from server source, and app/platform dependencies in this directory. Generated schema type-only imports are allowed in browser adapters. The same checker runs in the full repository verifier and PR workflow.
