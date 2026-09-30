import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { CloudFormationCustomResourceEvent } from "aws-lambda";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type Row = Record<string, unknown>;
type Key = Record<string, unknown>;

interface MigrationOptions {
  legacyTable: string;
  licenseTable: string;
  profileTable: string;
  profileIndex: string;
  remainingTime: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

const PAGE_SIZE = 25;
const PHYSICAL_ID = "producer-license-migration-v1";

const licenseKey = (row: Row) => JSON.stringify([
  row.userProfileId,
  String(row.state ?? "").trim().toUpperCase(),
  String(row.licenseNumber ?? "").trim().toUpperCase(),
]);

function requiredString(row: Row, field: string) {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Legacy producer license ${String(row.id ?? "(unknown)")} is missing ${field}`);
  }
  return value;
}

/** Preserve the source and any newer License; fail deployment on incomplete copying. */
export async function migrateProducerLicenseRows(
  db: Pick<DynamoDBDocumentClient, "send">,
  options: MigrationOptions,
) {
  let copied = 0;
  let skipped = 0;
  let cursor: Key | undefined;
  // Covers duplicate legacy rows, including duplicates across source pages,
  // without depending on immediate visibility of our writes through the GSI.
  const copiedKeys = new Set<string>();
  const expectedByProfile = new Map<string, Set<string>>();
  const requestOptions = () => {
    const remaining = options.remainingTime();
    if (remaining < 45_000) {
      throw new Error("Producer license migration reached its time budget; rerun deployment to resume safely.");
    }
    // Leave time for the custom-resource provider to report a failed deployment.
    return { abortSignal: AbortSignal.timeout(Math.min(30_000, remaining - 15_000)) };
  };

  do {
    const page = await db.send(new ScanCommand({
      TableName: options.legacyTable,
      Limit: PAGE_SIZE,
      ExclusiveStartKey: cursor,
      ConsistentRead: true,
    }), requestOptions());
    // Cache only this source page's profiles and indexed license reads.
    const profiles = new Map<string, Row | undefined>();
    const existingByProfile = new Map<string, Set<string>>();
    for (const row of page.Items ?? []) {
      requiredString(row, "id");
      const profileId = requiredString(row, "userProfileId");
      requiredString(row, "state");
      requiredString(row, "licenseNumber");
      const key = licenseKey(row);
      if (copiedKeys.has(key)) { skipped++; continue; }

      let existing = existingByProfile.get(profileId);
      if (!existing) {
        existing = new Set<string>();
        let licenseCursor: Key | undefined;
        do {
          const current = await db.send(new QueryCommand({
            TableName: options.licenseTable,
            IndexName: options.profileIndex,
            KeyConditionExpression: "#profile = :profile",
            ExpressionAttributeNames: { "#profile": "userProfileId" },
            ExpressionAttributeValues: { ":profile": profileId },
            Limit: PAGE_SIZE,
            ExclusiveStartKey: licenseCursor,
          }), requestOptions());
          for (const license of current.Items ?? []) {
            if (license.holderType === "PRODUCER") existing.add(licenseKey(license));
          }
          licenseCursor = current.LastEvaluatedKey;
        } while (licenseCursor);
        existingByProfile.set(profileId, existing);
      }
      if (existing.has(key)) { skipped++; continue; }

      if (!profiles.has(profileId)) {
        const profile = await db.send(new GetCommand({
          TableName: options.profileTable,
          Key: { id: profileId },
          ConsistentRead: true,
        }), requestOptions());
        profiles.set(profileId, profile.Item);
      }
      const profile = profiles.get(profileId);
      const now = new Date().toISOString();
      const item = {
        // Canonical identity survives source-row order changes on retry, even
        // when two legacy rows are duplicates and the GSI is still catching up.
        id: `legacy-producer-license:${createHash("sha256").update(key).digest("hex")}`,
        __typename: "License",
        holderType: "PRODUCER",
        userProfileId: profileId,
        holderName: profile ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") : undefined,
        state: row.state,
        licenseNumber: row.licenseNumber,
        npn: profile?.npn,
        licenseClass: "PRODUCER",
        // Legacy rows establish neither current status nor residency.
        expirationDate: row.expirationDate,
        linesOfAuthority: Array.isArray(row.linesOfAuthority)
          ? row.linesOfAuthority.filter((line): line is string => typeof line === "string" && !!line)
          : undefined,
        notes: "Migrated from the original onboarding license record.",
        createdAt: row.createdAt ?? now,
        updatedAt: row.updatedAt ?? row.createdAt ?? now,
      };
      try {
        await db.send(new PutCommand({
          TableName: options.licenseTable,
          Item: item,
          ConditionExpression: "attribute_not_exists(id)",
        }), requestOptions());
        copied++;
        const expected = expectedByProfile.get(profileId) ?? new Set<string>();
        expected.add(item.id);
        expectedByProfile.set(profileId, expected);
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
        // A prior successful attempt already copied this source row. Never
        // replace it: an administrator may have updated it since migration.
        skipped++;
        const saved = await db.send(new GetCommand({
          TableName: options.licenseTable, Key: { id: item.id }, ConsistentRead: true,
        }), requestOptions());
        if (!saved.Item) throw new Error("A previously migrated license disappeared during migration; retry deployment.");
        if (saved.Item.holderType === "PRODUCER" && saved.Item.userProfileId === profileId) {
          const expected = expectedByProfile.get(profileId) ?? new Set<string>();
          expected.add(item.id);
          expectedByProfile.set(profileId, expected);
        }
      }
      copiedKeys.add(key);
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  // The app now reads this index exclusively. Report success only after it can
  // observe the copied rows; a bounded failure leaves all copies safe to retry.
  for (let attempt = 0; expectedByProfile.size && attempt < 7; attempt++) {
    if (attempt) {
      requestOptions();
      await (options.sleep ?? delay)(100 * 2 ** (attempt - 1));
    }
    for (const [profileId, expected] of expectedByProfile) {
      let licenseCursor: Key | undefined;
      do {
        const visible = await db.send(new QueryCommand({
          TableName: options.licenseTable,
          IndexName: options.profileIndex,
          KeyConditionExpression: "#profile = :profile",
          ExpressionAttributeNames: { "#profile": "userProfileId" },
          ExpressionAttributeValues: { ":profile": profileId },
          Limit: PAGE_SIZE,
          ExclusiveStartKey: licenseCursor,
        }), requestOptions());
        for (const license of visible.Items ?? []) expected.delete(String(license.id));
        licenseCursor = visible.LastEvaluatedKey;
      } while (licenseCursor && expected.size);
      if (!expected.size) expectedByProfile.delete(profileId);
    }
  }
  if (expectedByProfile.size) {
    throw new Error("Copied producer licenses are not yet visible in the profile index; retry deployment.");
  }
  return { copied, skipped };
}

/** CDK Provider reports failures to CloudFormation; deletion never removes data. */
export async function handleMigrationEvent(
  event: Pick<CloudFormationCustomResourceEvent, "RequestType">,
  migrate: () => Promise<{ copied: number; skipped: number }>,
) {
  if (event.RequestType === "Delete") return { PhysicalResourceId: PHYSICAL_ID };
  return { PhysicalResourceId: PHYSICAL_ID, Data: await migrate() };
}
