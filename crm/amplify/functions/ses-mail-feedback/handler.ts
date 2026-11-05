import { sendCrmWrite } from '../live-write';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createSesFeedbackHandler } from "./feedback";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }), { marshallOptions: { removeUndefinedValues: true } });
export const handler = createSesFeedbackHandler({
  now: Date.now,
  getItem: async (table, pk) => (await db.send(new GetCommand({ TableName: table, Key: { pk }, ConsistentRead: true }))).Item,
  transact: async (input) => { await sendCrmWrite(db.send(new TransactWriteCommand(input))); },
  alert: (eventType, environment) => {
    // No recipients, subjects, message bodies, credentials or sign-in links.
    console.error(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "HOA/TransactionalMail", Dimensions: [["Environment"]], Metrics: [{ Name: "DeliveryNeedsReview", Unit: "Count" }] }] },
      Environment: environment, DeliveryNeedsReview: 1, provider: "ses", eventType,
    }));
  },
}, process.env);
