# API contracts and errors

`shared/apiResponse.ts` owns AWSJSON decoding and the safe error envelope. It has no SDK, session state, authorization policy, or retry behavior. It accepts an object or up to two JSON string encodings, rejects non-object results, and retains every GraphQL error's message and classification fields without copying arbitrary payloads or extensions.

The private CRM adapter is `crm/src/lib/apiResponse.ts`. It applies the existing shared authorization classifier to returned GraphQL failures, rejected SDK envelopes, and explicit application failures. Access denial remains recognizable even when another error appears first. Native model responses use `assertNoErrors` for optional reads and deletes, or `unwrap` when a non-null entity is required. An already-absent delete and a missing optional singleton remain successful outcomes.

The public website adapter is `web/src/lib/publicApi.ts`. It uses the public API key and caller-provided request options, checks the selected GraphQL field, and hides GraphQL error details. Reviewed application refusal messages remain available to the public flow. Public and authenticated transports share the wire decoder, not session or error-disclosure policy.

## Operation contracts

`shared/apiOperations.ts` names the 28 client communication reads, 32 communication writes, and 13 commission actions. `communicationContracts.ts` and `commissionContracts.ts` associate those names with their actual input and result DTOs. The exported adapters infer results from the operation; callers cannot choose a replacement result type. Write operations require the write transport. Unknown operations and mismatched transports also fail before a network request at runtime. Backend-only legacy dispatch operations remain owned by their existing handlers.

Feature adapters cover invoice counters and sends, voids, financing service commands, binding, broker fee payment status, carrier submissions, scoped files, owner compensation/reporting, and marketing reports. They validate the fields needed to use critical receipts, URLs, signing terms, and monetary results. Existing domain validators still own financial rules and workflow eligibility; transport decoding does not authorize a payment, bind, or payroll action.

When adding a client operation, update its mode/name catalog, input/result contract, adapter, backend implementation, and tests together. Keep SDK model imports type-only in contract modules. Add runtime guards where a response controls a URL, financial receipt, or consent. Compile-time negative tests in `apiOperationContracts.test.ts` check that operation names, input shapes, transport modes, idempotency fields, and result variants stay connected.

## Failed writes and retry identity

`ApiResponseError.origin` distinguishes `graphql`, `transport`, `protocol`, and `application` failures. Only an explicit decoded `{ ok: false }` response can provide an application business code. SDK rejections, GraphQL errors, missing/invalid `ok` flags, and malformed responses cannot prove that a write was never dispatched. Their classification evidence is retained separately in `errors`.

The Front draft editor unlocks only for the application-origin `BUSINESS_DRAFT_NOT_DISPATCHED` result. An unknown outcome keeps the original request ID and existing reconciliation workflow. The adapters never retry a write automatically. Invoice `expectedSentAt`, draft request IDs, enquiry submission identity/proof, financing actions, upload content types, timeouts, and close-window keepalive options are passed through unchanged.

Scoped file and counter APIs intentionally lack an `ok` flag and opt into that contract explicitly. Explicit `ok: false` still fails. Public financing retains compatibility with older offers lacking an explicit initial-payment field. A combined broker disclosure can include a policy whose fee is zero, absent, or null; the canonical cent conversion must still equal the positive package total. Nullable coverage-list entries remain supported while visible coverage and signing terms are required.
