import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { PF_CONFIG_SHA256 } from "../../../src/lib/premiumFinance/jurisdictions";

/**
 * Custom mutation handler: setPremiumFinanceEnabled. See resource.ts.
 *
 * AppSync enforces the ADMIN group before this runs; the identity block still
 * names the actor for the log. Direct table writes, because the flip and its
 * audit row must both come from this one place.
 *
 * ── The directions are asymmetric, on purpose ───────────────────────────────
 * ENABLE is atomic with its log: if the log write fails after retries, the
 * flip is reverted and reported as not made — turning lending ON without a
 * record is the thing this Lambda exists to prevent, and the revert leaves
 * the module off, which is the safe state.
 *
 * DISABLE is unconditional: the flag goes off FIRST and stays off whatever
 * happens to the log. The disable path exists for the moment counsel says
 * stop, and a DynamoDB hiccup on the audit write must not turn lending back
 * on at exactly that moment. A failed log on disable is surfaced loudly and
 * left to be recorded by hand; it is never grounds to restore the flag.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient());

/** The one AgencySettings row — the same fixed id the app addresses. */
const AGENCY_SETTINGS_ID = "AGENCY";

const LOG_ATTEMPTS = 3;

interface AppSyncIdentity {
  sub?: string;
  username?: string;
  claims?: Record<string, unknown>;
}

export const handler = async (event: {
  arguments?: { enabled?: boolean };
  identity?: AppSyncIdentity;
}): Promise<{ ok: boolean; enabled?: boolean; error?: string; warning?: string }> => {
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

  const writeFlag = (value: boolean) =>
    ddb.send(
      new UpdateCommand({
        TableName: settingsTable,
        Key: { id: AGENCY_SETTINGS_ID },
        UpdateExpression:
          "SET premiumFinanceEnabled = :v, updatedBy = :by, updatedAt = :now",
        ExpressionAttributeValues: { ":v": value, ":by": actor, ":now": now },
      })
    );

  const writeLog = async (): Promise<boolean> => {
    const item = {
      id: randomUUID(),
      // AppSync needs these to read raw-written rows back through the model
      // without nulling non-null fields.
      __typename: "PfComplianceLog",
      createdAt: now,
      updatedAt: now,
      jurisdiction: "ALL",
      rule: "module-flag",
      outcome: enabled ? "ENABLED" : "DISABLED",
      reason: `Premium finance module switched ${enabled ? "on" : "off"}`,
      inputs: JSON.stringify({ enabled }),
      /**
       * The hash of the signed ruleset in force at the moment of the
       * decision. The admin screen's SHA answers "what is production running
       * today"; this answers the regulator's actual question — which signed
       * file governed a specific decision, months and re-signings later.
       * Every PfComplianceLog row carries it, from every writer.
       */
      configSha256: PF_CONFIG_SHA256,
      actor,
      actorName,
      occurredAt: now,
    };
    for (let attempt = 1; attempt <= LOG_ATTEMPTS; attempt++) {
      try {
        await ddb.send(new PutCommand({ TableName: logTable, Item: item }));
        return true;
      } catch (err) {
        console.error(`[pf-admin] log write attempt ${attempt} failed`, err);
        if (attempt < LOG_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 150 * attempt));
        }
      }
    }
    return false;
  };

  try {
    await writeFlag(enabled);
    const logged = await writeLog();

    if (!logged && enabled) {
      // Enabling without a record must not stand. Revert; off is safe.
      console.error("[pf-admin] log write failed; reverting the enable");
      await writeFlag(false);
      return {
        ok: false,
        error: "The change could not be logged, so lending was NOT enabled.",
      };
    }
    if (!logged && !enabled) {
      // The module is OFF and stays off. Never restore the flag over a log.
      console.error(
        "[pf-admin] LOG WRITE FAILED ON DISABLE — module is OFF; record this flip manually"
      );
      return {
        ok: true,
        enabled: false,
        warning:
          "The module is OFF, but the audit log write failed. Record this flip manually and tell engineering.",
      };
    }

    console.log(`pf-admin: premium finance ${enabled ? "ENABLED" : "DISABLED"} by ${actorName}`);
    return { ok: true, enabled };
  } catch (err) {
    console.error("pf-admin failed", err);
    return { ok: false, error: "Couldn't change the setting. Try again." };
  }
};
