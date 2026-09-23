import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { publicEstimate, type EstimateRecord } from "./contract";
const db = DynamoDBDocumentClient.from(new DynamoDBClient());
export async function handler(event: { arguments: { estimateToken: string } }) {
  const token = event.arguments.estimateToken;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "unavailable" };
  const id = createHash("sha256").update(token).digest("hex");
  try {
    const record = (await db.send(new GetCommand({ TableName: process.env.HONEYCOMB_ESTIMATE_TABLE!, Key: { id }, ConsistentRead: true }))).Item;
    return publicEstimate(record as EstimateRecord | undefined);
  } catch { return { status: "unavailable" }; }
}
