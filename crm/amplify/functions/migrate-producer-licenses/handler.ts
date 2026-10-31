import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
import { handleMigrationEvent, migrateProducerLicenseRows } from "./migration";

const db = DynamoDBDocumentClient.from(new DynamoDBClient(), {
  marshallOptions: { removeUndefinedValues: true },
});

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing migration setting: ${name}`);
  return value;
}

export async function handler(event: CloudFormationCustomResourceEvent, context: Context) {
  if ((process.env.HOA_MIGRATION_PREVIEW === "true" || process.env.HOA_MIGRATION_BUSINESS_HELD === "true")) return handleMigrationEvent({ RequestType: "Delete" }, async () => ({ copied: 0, skipped: 0 }));
  return handleMigrationEvent(event, () => migrateProducerLicenseRows(db, {
    legacyTable: requiredEnvironment("LEGACY_PRODUCER_LICENSE_TABLE"),
    licenseTable: requiredEnvironment("LICENSE_TABLE"),
    profileTable: requiredEnvironment("USER_PROFILE_TABLE"),
    profileIndex: requiredEnvironment("LICENSE_USER_PROFILE_INDEX"),
    remainingTime: () => context.getRemainingTimeInMillis(),
  }));
}
