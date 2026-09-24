import type { DynamoDBStreamHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createPartial, type PartialResult } from "./submission-client";
import type { PartialInput, SubmissionRecord } from "./submission-contract";
const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
const table = () => process.env.HONEYCOMB_SUBMISSION_TABLE!;
async function finish(record: SubmissionRecord, result: PartialResult) {
  const fields = Object.fromEntries(Object.entries({ ...result, updatedAt: new Date().toISOString() }).filter(([, value]) => value !== undefined));
  await db.send(new UpdateCommand({ TableName: table(), Key: { id: record.id },
    ConditionExpression: "#status = :running AND attempt = :attempt", UpdateExpression: `SET ${Object.keys(fields).map(k => `#${k} = :${k}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(Object.keys(fields).map(k => [`#${k}`, k])),
    ExpressionAttributeValues: { ":running": "RUNNING", ":attempt": record.attempt, ...Object.fromEntries(Object.entries(fields).map(([k, value]) => [`:${k}`, value])) },
  }));
}
export async function processSubmission(id: string) {
  const record = (await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }))).Item as SubmissionRecord | undefined;
  if (!record || !["PENDING", "RUNNING"].includes(record.status)) return;
  if (record.status === "RUNNING") {
    if (Date.now() - Date.parse(record.updatedAt) <= 120000) throw new Error("Submission is still processing");
    await finish(record, { status: "UNKNOWN", issue: "INTERRUPTED" });
    return;
  }
  try {
    await db.send(new UpdateCommand({ TableName: table(), Key: { id }, ConditionExpression: "#status = :pending AND attempt = :attempt", UpdateExpression: "SET #status = :running, updatedAt = :at",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":pending": "PENDING", ":running": "RUNNING", ":attempt": record.attempt, ":at": new Date().toISOString() } }));
  } catch (error) { if (error instanceof Error && error.name === "ConditionalCheckFailedException") return; throw error; }
  let result: PartialResult;
  try { result = await createPartial(JSON.parse(record.input) as PartialInput); }
  catch { result = { status: "UNKNOWN", issue: "PROCESSING_FAILED" }; }
  await finish(record, result);
  console.info("Honeycomb partial submission finished", { status: result.status, issue: result.issue });
}
export const handler: DynamoDBStreamHandler = async event => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    // A rejected request only runs again after an agent explicitly queues a new attempt.
    if (!["INSERT", "MODIFY"].includes(record.eventName ?? "") || record.dynamodb?.NewImage?.status?.S !== "PENDING" || !record.dynamodb.Keys?.id?.S) continue;
    try { await processSubmission(record.dynamodb.Keys.id.S); }
    catch { batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber! }); }
  }
  return { batchItemFailures };
};
