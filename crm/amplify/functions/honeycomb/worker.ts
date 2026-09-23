import type { DynamoDBStreamHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { estimate, type CarrierResult } from "./client";
import { PROCESSING_WINDOW_MS, type EstimateInput, type EstimateRecord } from "./contract";
const db = DynamoDBDocumentClient.from(new DynamoDBClient(), { marshallOptions: { removeUndefinedValues: true } });
const table = () => process.env.HONEYCOMB_ESTIMATE_TABLE!;
const conditional = (e: unknown) => e instanceof Error && e.name === "ConditionalCheckFailedException";
async function finish(id: string, result: CarrierResult) {
  const fields = { ...result, updatedAt: new Date().toISOString() };
  await db.send(new UpdateCommand({ TableName: table(), Key: { id },
    ConditionExpression: "#status = :running", UpdateExpression: `SET ${Object.keys(fields).map(k => `#${k} = :${k}`).join(", ")}`,
    ExpressionAttributeNames: Object.fromEntries(Object.keys(fields).map(k => [`#${k}`, k])),
    ExpressionAttributeValues: { ":running": "RUNNING", ...Object.fromEntries(Object.entries(fields).map(([k,v]) => [`:${k}`, v])) },
  }));
}
export async function processEstimate(id: string) {
  const record = (await db.send(new GetCommand({ TableName: table(), Key: { id }, ConsistentRead: true }))).Item as EstimateRecord | undefined;
  if (!record || !["PENDING", "RUNNING"].includes(record.status)) return;
  if (record.status === "RUNNING") {
    // Never repeat a carrier call after a worker crash or ambiguous database write.
    if (Date.now() - Date.parse(record.updatedAt) > PROCESSING_WINDOW_MS) await finish(id, { status: "ERROR", issue: "INTERRUPTED" });
    else throw new Error("Estimate is still processing");
    return;
  }
  try {
    await db.send(new UpdateCommand({ TableName: table(), Key: { id }, ConditionExpression: "#status = :pending",
      UpdateExpression: "SET #status = :running, updatedAt = :at", ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":pending": "PENDING", ":running": "RUNNING", ":at": new Date().toISOString() },
    }));
  } catch (e) { if (conditional(e)) return; throw e; }
  let result: CarrierResult;
  try { result = await estimate(JSON.parse(record.input!) as EstimateInput); }
  catch { result = { status: "ERROR", issue: "INVALID_INPUT" }; }
  await finish(id, result);
  console.info("Honeycomb estimate completed", { status: result.status, issue: result.issue });
}
export const handler: DynamoDBStreamHandler = async event => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    if (record.eventName !== "INSERT" || !record.dynamodb?.Keys?.id?.S) continue;
    try { await processEstimate(record.dynamodb.Keys.id.S); }
    catch { batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber! }); }
  }
  return { batchItemFailures };
};
