import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * Custom mutation handler: setPremiumFinanceEnabled. See resource.ts.
 *
 * AppSync enforces the ADMIN group before this runs (the mutation's
 * authorization rule); the identity block still names the actor for the log.
 * Direct table writes, because the flip and its audit row must both come from
 * this one place — a data-client path would mean the settings field is also
 * writable by the ordinary ADMIN settings screen, which is exactly what the
 * design forbids.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/** The one AgencySettings row — the same fixed id the app addresses. */
const AGENCY_SETTINGS_ID = "AGENCY";

interface AppSyncIdentity {
  sub?: string;
  username?: string;
  claims?: Record<string, unknown>;
}

export const handler = async (event: {
  arguments?: { enabled?: boolean };
  identity?: AppSyncIdentity;
}): Promise<{ ok: boolean; enabled?: boolean; error?: string }> => {
  const enabled = event.arguments?.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false." };
  }
  const settingsTable = process.env.AGENCY_SETTINGS_TABLE;
  const logTable = process.env.PF_COMPLIANCE_LOG_TABLE;
  if (!settingsTable || !logTable) {
    console.error("[pf-admin] table env unset");
    return { ok: false, error: "Premium finance admin is not configured." };
  }

  const actor = event.identity?.sub ?? "unknown";
  const actorName =
    (typeof event.identity?.claims?.email === "string"
      ? event.identity.claims.email
      : null) ??
    event.identity?.username ??
    actor;
  const now = new Date().toISOString();

  /**
   * Log FIRST, then flip. If the log write fails, the flag does not move —
   * an unrecorded flip is the thing this Lambda exists to make impossible,
   * and a recorded intention that failed to apply is visible and harmless
   * (outcome rows are written only after the flip succeeds would invert
   * that, so instead: the row is written after the flip, and a flip whose
   * log failed is rolled back).
   *
   * Simpler and honest: flip, then log, and if the log write fails, flip
   * back and report failure. The end state either way: flag and log agree.
   */
  const write = (value: boolean, updatedBy: string) =>
    ddb.send(
      new UpdateCommand({
        TableName: settingsTable,
        Key: { id: AGENCY_SETTINGS_ID },
        UpdateExpression:
          "SET premiumFinanceEnabled = :v, updatedBy = :by, updatedAt = :now",
        ExpressionAttributeValues: { ":v": value, ":by": updatedBy, ":now": now },
      })
    );

  try {
    await write(enabled, actor);
    try {
      await ddb.send(
        new PutCommand({
          TableName: logTable,
          Item: {
            id: randomUUID(),
            // AppSync needs these to read raw-written rows back through the
            // model without nulling non-null fields.
            __typename: "PfComplianceLog",
            createdAt: now,
            updatedAt: now,
            jurisdiction: "ALL",
            rule: "module-flag",
            outcome: enabled ? "ENABLED" : "DISABLED",
            reason: `Premium finance module switched ${enabled ? "on" : "off"}`,
            inputs: JSON.stringify({ enabled }),
            actor,
            actorName,
            occurredAt: now,
          },
        })
      );
    } catch (logErr) {
      // The flip must not outlive a failed record of it.
      console.error("[pf-admin] log write failed; reverting the flip", logErr);
      await write(!enabled, actor);
      return { ok: false, error: "The change could not be logged, so it was not made." };
    }
    console.log(`pf-admin: premium finance ${enabled ? "ENABLED" : "DISABLED"} by ${actorName}`);
    return { ok: true, enabled };
  } catch (err) {
    console.error("pf-admin failed", err);
    return { ok: false, error: "Couldn't change the setting. Try again." };
  }
};
