# Shared business rules

This directory owns rules and structural contracts used by more than one runtime: CRM browser code, the public website, and Lambda handlers. Import the owning module directly. Do not add a browser or server wrapper that reexports it under an old path.

Keep shared modules independent of React, Amplify/AWS SDKs, application clients, environment variables, browser storage, and network calls. Pass data and configuration into the rule; keep authentication, reads, writes, and UI state in their runtime adapters.

The CRM's `schemaContracts.test.ts` checks shared enum types against the generated Amplify schema. The premium-finance jurisdiction module is generated from the existing signed YAML using `npm run pf:generate` in `crm`; its source hash and rules remain unchanged.

Deployment-time modules stay inside `crm/amplify`, including Honeycomb branch selection used by Amplify's loader. Public endpoint identities and runtime business contracts live here; credentials remain in runtime configuration.

Run `npm run verify:architecture` from the repository root. The central checker in `scripts/check-module-boundaries.mjs` rejects server imports from frontend source, browser runtime imports from server source, and app/platform dependencies in this directory. Generated schema type-only imports are allowed in browser adapters. The same checker runs in the full repository verifier and PR workflow.


`agencyTime.ts` converts instants to the agency's New York civil day. Keep date-only
calendar inputs and full wall-clock scheduling rules in their domain modules.
`money.ts` formats explicit dollar or cent values with exact-cent, whole-dollar, or
optional-cent presentation. It does not validate amounts, round ledger arithmetic,
or choose missing-value fallbacks. `usStates.ts` owns the 50-state/DC identities;
website editorial copy, map geometry, and signed jurisdiction rules stay separate.

`premiumFinance/initialPayment.ts` owns upfront-payment component composition.
Checkout rounds down payment and origination dollars separately to cents and accepts
broker fees already in cents. Agreement PDFs retain their combined-dollar rounding;
legacy public offers missing an explicit server total retain their raw dollar sum.
These policies intentionally differ for fractional-cent historical inputs. Existing
cent-valued quotes agree, and an explicit server total (including zero) stays
authoritative. Billing versions and actual-receipt compatibility remain server-owned.

`storageKeys.ts` owns the normalized five-segment document key used by staff and
public uploads. Browser file attachments use `uploadDocument` in `crm/src/lib/storage.ts`
for record/link/upload ordering and failed-record cleanup. External file creators
stamp `uploadedName` equal to their initial `name`; the OCR worker uses this immutable
provenance to respect later manual renames even when the object filename was normalized.
Front imports retain their existing provider-specific filename/key and deterministic
ID for retries. Public token, quota and presign guards and generated documents remain
owned by their handlers; this key helper does not change those lifecycles.
