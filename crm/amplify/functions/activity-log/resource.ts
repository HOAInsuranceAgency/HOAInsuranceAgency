import { defineFunction } from "@aws-amplify/backend";

/**
 * DynamoDB Streams → Activity rows.
 *
 * The system of record for "what changed on this account". Streams rather
 * than call-site logging because capture is then complete by construction: a
 * write that reaches the table is a write this sees, including one made by a
 * Lambda, by the backfill script, or by somebody with the console open.
 *
 * What streams cannot do is say *who*. A stream record has no actor — AppSync
 * writes createdAt/updatedAt and Amplify only stamps an owner on models using
 * owner auth, which none of these do, and CloudTrail does not cover
 * data-plane DynamoDB writes at usable granularity. So every streamed model
 * carries `lastWriteBy`, set by the actor proxy in src/lib/client.ts, and
 * this handler resolves it to a name. That is the cost of the streams
 * decision: complete capture, attribution bolted on.
 *
 * Batches are not retried into a loop. `bisectBatchOnFunctionError` is off
 * and `retryAttempts` is finite in backend.ts, because a poison record on an
 * infinite retry replays until the stream's 24-hour retention drops it, and
 * an activity row is not worth stalling a table's stream for a day.
 */
export const activityLog = defineFunction({
  name: "activity-log",
  entry: "./handler.ts",
  timeoutSeconds: 60,
  memoryMB: 512,
  resourceGroupName: "data",
});
