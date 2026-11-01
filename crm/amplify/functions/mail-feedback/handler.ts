import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createFeedbackHandler } from "./feedback";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));
const secrets = new SecretsManagerClient({ region: "us-east-1" });
let cached: { arn: string; value: string; expiresAt: number } | undefined;

export const handler = createFeedbackHandler({
  now: Date.now,
  readSecret: async (arn) => {
    if (cached?.arn === arn && cached.expiresAt > Date.now()) return cached.value;
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    const parsed = JSON.parse(result.SecretString ?? "null");
    if (!parsed || typeof parsed.webhookSecret !== "string") throw new Error("Webhook secret unavailable");
    cached = { arn, value: parsed.webhookSecret, expiresAt: Date.now() + 60_000 };
    return parsed.webhookSecret;
  },
  transact: async (input) => { await db.send(new TransactWriteCommand(input)); },
  getEvent: async (table, pk) => (await db.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true }))).Item,
  alert: (eventType, environment) => {
    // Only after a new signed event commits. No addresses, links, or payloads.
    console.error(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "HOA/TransactionalMail", Dimensions: [["Environment"]], Metrics: [{ Name: "DeliveryNeedsReview", Unit: "Count" }] }] },
      Environment: environment, DeliveryNeedsReview: 1, eventType,
    }));
  },
}, process.env);
