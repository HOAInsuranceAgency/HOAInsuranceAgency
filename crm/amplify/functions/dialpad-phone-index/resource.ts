import { defineFunction } from "@aws-amplify/backend";

/**
 * DynamoDB Streams → PhoneLink rows. The phone index, kept current.
 *
 * Streams for the same reason `activity-log` uses them: capture is complete
 * by construction. A contact written by the AI extraction path, by the
 * backfill script, or by somebody with the console open is a contact this
 * sees. Call-site indexing would have to be added to each of those and would
 * be missing from the next one.
 *
 * ── Why a second consumer rather than a branch in activity-log ─────────
 * Both functions read the same two streams, and merging them would save a
 * consumer slot. They are not merged because they fail differently: an
 * activity row that does not get written is a gap in a log nobody is blocked
 * on, while a phone link that does not get written sends every call from that
 * person to the triage queue. Sharing a Lambda means sharing a retry policy,
 * a timeout, and a poison record.
 *
 * ── The constraint that comes with that ────────────────────────────────
 * DynamoDB Streams allows two consumers per shard before reads begin to
 * throttle. `Contact` and `Account` now have exactly two: `activity-log` and
 * this. A third consumer on either table is a design change — fan out from
 * one of these two, or move to Kinesis — not something to add and find out
 * about in production.
 *
 * Idempotent by construction, which is what makes at-least-once delivery a
 * non-issue: every write is an upsert on a deterministic id derived from the
 * source row, so a redelivered batch rewrites identical rows. `activity-log`
 * needs `eventID` for this; here there is nothing to guard.
 */
export const dialpadPhoneIndex = defineFunction({
  name: "dialpad-phone-index",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
