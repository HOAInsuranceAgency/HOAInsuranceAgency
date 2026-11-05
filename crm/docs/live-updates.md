# Live updates

Visible CRM reads subscribe to metadata-only invalidations over AppSync. Events
carry an opaque revision; the personal channel also carries the signed-in user's
own ID for server-side filtering. Business records are never broadcast. Readers
re-run their existing authorized APIs. Active user/role changes recreate the
transport and fence old responses. Service IAM may publish only the three change
fields; client user-pool and identity-pool IAM publishing is rejected.

The shared coordinator in `src/lib/liveUpdates.ts` batches notifications, limits
burst reads to once per second per resource, revalidates on focus/reconnection,
and polls visible, online readers every 60 seconds if an event is missed. Storage
and BroadcastChannel carry invalidation metadata within the same user/role scope.
Readers retain their last authorized snapshot during ordinary network failures.
Access-denied responses clear data immediately, including during an edit.

## Adding a reader

Opt pure reads into `useAsyncResource(fetcher, deps, { live: true })`. Background
reads do not set `loading`, replace dependency scopes, or remount editors. Use
`refreshError`/`refreshing` to withhold stale exports or financial confirmations.
`LiveStatus` presents delayed updates without replacing existing content.

A fetcher that generates a preview, creates/reconciles invoice lines, records a
payment, or runs another command must not be opted in. A legacy read exposed as
a GraphQL mutation must be explicitly classified in `client.ts` so it cannot
invalidate or fence itself.

Custom caches use `useLiveRefresh` with `liveUpdates.getSnapshot()` and
`canPublish(fence)` before applying results. Return `false` after a fenced read
to queue revalidation after unlocking. Preserve the loaded page depth and local
confirmed version merges. Register `onDenied` to clear caches and retire pending
reads/writes; do not let late callbacks restore denied data.

## Editing and financial operations

`useFormState` protects dirty forms and rebases clean object seeds by value.
Call `markSaved(submitted)` only after successful persistence; later typing stays
dirty. Reset hidden/cancelled editors to release their draft locks. Custom state
editors register `useLiveUpdateBlock(dirtyOrBusy)`. Parent list reads must not
unmount a protected editor.

The client holds write barriers through model/custom mutations. `useSaveStatus`
also protects the complete save lifecycle, including confirmation reads and local
patches. Explicit `refetch` remains forceable from these lifecycles.

Independent read-only payment/signature status may use
`live: { protectEdits: false }`; it still waits for writes. In-flight background
reads are fenced when an edit/write starts, even if that lock later releases.
Automatic refresh never submits a payment, retries an uncertain command, approves
changed terms, clears idempotency keys, or bypasses reconciliation requirements.
Those recovery/confirmation controls remain explicit.

## Backend writers

Native model mutation pipelines notify after a committed result. Existing stream
consumers cover asynchronous model changes without adding stream mappings.
Private/direct writers use `sendCrmWrite`, `sendOwnerWrite`, or
`sendCommissionWrite` in `amplify/functions/live-write.ts`. Wrap multi-write
handlers with `batchLiveChanges` to coalesce audiences per invocation. Publish
only after success, including committed changes preceding a later failure.
Notifications are best effort and bounded; delivery failure must never change a
financial commit's result or cause its retry. Private compensation changes notify
Owners and only the affected producer's personal channel.

The retained deployment uses the reviewed endpoint in migration targets to avoid
new cross-stack dependency cycles. No new tables, indexes, schedules, or stream
cursors are introduced. `synth:check` validates IAM, resolver wiring, dependency
bounds, template budgets, and the retained resource inventory.

## Verification

Core tests cover batching, offline/hidden tabs, reconnect, role isolation, draft
and write fencing, denied-data clearing, local-save ordering, and legacy read
classification. Consumer tests explicitly start live updates using
`src/test/liveUpdates.ts`; isolated tests do not poll by default. Financial
regressions continue to exercise uncertain payments and immutable confirmation
snapshots through their explicit recovery actions.
