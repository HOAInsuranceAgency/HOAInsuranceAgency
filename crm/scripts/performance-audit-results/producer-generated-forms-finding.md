# Producer generated-form lookup: pre-existing filter syntax defect

The live Producer access check showed one warning on each of two visits to an owned account's Documents tab. The second visit retained the exact generated-forms warning: `Invalid FilterExpression: The expression has redundant parentheses`; the first retained only the alert count. The three main document rows rendered, and other owned tabs worked. This finding prevents describing the Producer check as entirely clean. The matched Admin performance suite completed successfully.

The triggering source predates the latency release. Baseline staging `01980f07704b5730130b7e61021df5643df11341` and the current candidate have identical Git blobs for:

- `crm/src/components/FormsTab.tsx`: `f8efead38e8b7d1a9e923e414aedce9197c7e887`.
- `crm/amplify/functions/crm-access/filters.ts`: `9629ff9604d56813dbf237c3bfb7918517eb9e95`.

`FormsTab.tsx:54–58` requests `Document.list` with `{ entityId: { eq: ACCOUNT_ID }, category: { eq: "ACORD_FORM" } }`. On the Producer indexed path, `listing.ts` removes the partition-key predicate from pushdown. Executing the existing `queryFilter(filter, "entityId")` produces:

```text
FilterExpression: ((#f0 = :f1))
ExpressionAttributeNames: { "#f0": "category" }
ExpressionAttributeValues: { ":f1": "ACORD_FORM" }
```

The compiler's `join` helper (`filters.ts:45`) wraps both the singleton field expression and its singleton outer group. Both compiler code and the Producer indexed-query call existed in the baseline. This is a pre-existing compiler defect, not introduced by the three latency changes.

This particular generated-form filter has no `entityType`. Admin/Owner therefore retain the native list resolver in both versions; the new exact Document routing requires equality on both `entityId` and `entityType`. The main Documents panel also uses a different generated index query (`DocumentsPanel.tsx:172`). Those distinctions explain why the generated-form error can coexist with working main document rows and a clean Admin suite.

Proposed follow-up: return a singleton Boolean child's expression without adding another group, and avoid double-grouping already grouped expressions under `NOT`. Preserve necessary AND/OR precedence and null/size handling. Add a regression for this exact generated-form query plus nested AND/OR/NOT cases, validated against DynamoDB expression parsing. Keep current-record filtering, canonical parent checks, assignment checks, session revocation and pagination unchanged.

No application code or deployed resources were changed for this finding. It is intentionally excluded from the latency release fix scope.
